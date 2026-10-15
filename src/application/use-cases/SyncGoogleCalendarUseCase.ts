/**
 * SyncGoogleCalendarUseCase — ONE-WAY sync of the Hipnoticus agenda (tbSessions) into a
 * dedicated "Hipnoticus Agenda" secondary calendar on each connected Google account.
 *
 * Nothing is ever read back from Google into Hipnoticus. Idempotent: deterministic event ids
 * (`hipno<sessionId>`) plus a payload hash per mapping, so an unchanged agenda makes no event writes.
 */
import {
  GoogleAuthRevokedError, GoogleConflictError, GoogleEventPayload, GoogleNotFoundError, IGoogleCalendarClient,
} from '../../infrastructure/google/GoogleCalendarClient';
import { sha256Hex, TokenCrypto } from '../../infrastructure/google/TokenCrypto';
import {
  DesiredSession, GCalAccount, IGoogleCalendarRepository,
} from '../../infrastructure/persistence/repositories/GoogleCalendarRepository';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('SyncGoogleCalendarUseCase');

export const GCAL_CALENDAR_NAME = 'Hipnoticus Agenda';
export const GCAL_TIME_ZONE = 'America/Sao_Paulo';
export const GCAL_REVOKED_MESSAGE = 'Acesso revogado pelo Google. Reconecte a conta.';
const FOOTER = 'Sincronizado automaticamente pelo Hipnoticus. Alterações feitas aqui serão sobrescritas.';

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  failed: number;
}

export class AccountNotFoundError extends Error {}

/** Adds minutes to a naive `YYYY-MM-DDTHH:mm:ss` wall-clock string without any timezone shift. */
export function addMinutesNaive(naive: string, minutes: number): string {
  const d = new Date(`${naive.substring(0, 19)}Z`);
  return new Date(d.getTime() + minutes * 60000).toISOString().substring(0, 19);
}

export function buildEventPayload(s: DesiredSession): GoogleEventPayload {
  const start = s.dateBegins.substring(0, 19);
  let end = s.dateEnds ? s.dateEnds.substring(0, 19) : '';
  if (!end || end <= start) end = addMinutesNaive(start, 60);
  const name = (s.name || '').trim() || 'Sessão';
  const client = (s.clientName || '').trim();
  const lines = [`Status: ${(s.statusName || '').trim() || '-'}`];
  if (s.phone && s.phone.trim()) lines.push(`Telefone: ${s.phone.trim()}`);
  lines.push(`Primeira sessão: ${s.firstSession ? 'Sim' : 'Não'}`);
  lines.push(`Paga: ${s.paid ? 'Sim' : 'Não'}`);
  lines.push('', FOOTER);
  return {
    summary: client ? `${name} - ${client}` : name,
    description: lines.join('\n'),
    start: { dateTime: start, timeZone: GCAL_TIME_ZONE },
    end: { dateTime: end, timeZone: GCAL_TIME_ZONE },
    status: 'confirmed',
    transparency: 'opaque',
    reminders: { useDefault: false, overrides: [] },
  };
}

export function eventIdFor(sessionId: number): string {
  // Google event ids: base32hex chars (a-v, 0-9), 5..1024 long
  return `hipno${sessionId}`;
}

export class SyncGoogleCalendarUseCase {
  private readonly running = new Map<number, Promise<SyncResult>>();

  constructor(
    private readonly repo: IGoogleCalendarRepository,
    private readonly client: IGoogleCalendarClient,
    private readonly crypto: TokenCrypto,
    private readonly pastDays: number = 30,
  ) {}

  /** Per-account in-process lock: a second call while one is running shares its result. */
  syncAccount(accountId: number): Promise<SyncResult> {
    const inFlight = this.running.get(accountId);
    if (inFlight) return inFlight;
    const p = this.doSync(accountId).finally(() => this.running.delete(accountId));
    this.running.set(accountId, p);
    return p;
  }

  async syncAll(): Promise<void> {
    const accounts = await this.repo.listSyncableAccounts();
    for (const account of accounts) {
      try {
        const r = await this.syncAccount(account.id);
        if (r.created || r.updated || r.deleted || r.failed) {
          logger.info(`Account ${account.id}: created=${r.created} updated=${r.updated} deleted=${r.deleted} failed=${r.failed}`);
        }
      } catch (e) {
        logger.warn(`Account ${account.id} sync failed: ${(e as Error).message}`);
      }
    }
  }

  private async doSync(accountId: number): Promise<SyncResult> {
    const account = await this.repo.getAccount(accountId);
    if (!account) throw new AccountNotFoundError(`Conta ${accountId} não encontrada`);
    const result: SyncResult = { created: 0, updated: 0, deleted: 0, failed: 0 };
    let firstFailure = '';
    try {
      const refreshToken = this.crypto.decrypt(account.refreshTokenEnc);
      const at = await this.client.getAccessToken(refreshToken);
      const calendarId = await this.ensureCalendar(at, account);

      const desired = await this.repo.getDesiredSessions(account.userId, this.pastDays);
      const mappings = await this.repo.getMappings(account.id);

      for (const session of desired) {
        const payload = buildEventPayload(session);
        const hash = sha256Hex(JSON.stringify(payload));
        const mapping = mappings.get(session.id);
        if (mapping && mapping.payloadHash === hash) continue;
        try {
          if (!mapping) {
            const eventId = await this.insertOrRevive(at, calendarId, eventIdFor(session.id), payload);
            await this.repo.upsertMapping(account.id, session.id, eventId, hash);
            result.created++;
          } else {
            try {
              await this.client.updateEvent(at, calendarId, mapping.googleEventId, payload);
            } catch (e) {
              if (!(e instanceof GoogleNotFoundError)) throw e;
              mapping.googleEventId = await this.insertOrRevive(at, calendarId, mapping.googleEventId, payload);
            }
            await this.repo.upsertMapping(account.id, session.id, mapping.googleEventId, hash);
            result.updated++;
          }
        } catch (e) {
          if (e instanceof GoogleAuthRevokedError) throw e;
          result.failed++;
          if (!firstFailure) firstFailure = `sessão ${session.id}: ${(e as Error).message}`;
        }
      }

      for (const stale of await this.repo.getStaleMappings(account.id, account.userId)) {
        try {
          try {
            await this.client.deleteEvent(at, calendarId, stale.googleEventId);
          } catch (e) {
            if (!(e instanceof GoogleNotFoundError)) throw e; // 404/410: already gone
          }
          await this.repo.deleteMapping(account.id, stale.sessionId);
          result.deleted++;
        } catch (e) {
          if (e instanceof GoogleAuthRevokedError) throw e;
          result.failed++;
          if (!firstFailure) firstFailure = `sessão ${stale.sessionId}: ${(e as Error).message}`;
        }
      }

      if (result.failed) {
        await this.repo.markSyncResult(account.id, 'error', `${result.failed} compromisso(s) não sincronizado(s). Primeiro erro: ${firstFailure}`);
      } else {
        await this.repo.markSyncResult(account.id, 'active', null);
      }
      return result;
    } catch (e) {
      if (e instanceof GoogleAuthRevokedError) {
        await this.repo.markSyncResult(account.id, 'revoked', GCAL_REVOKED_MESSAGE);
      } else {
        await this.repo.markSyncResult(account.id, 'error', (e as Error).message || 'Erro desconhecido');
      }
      throw e;
    }
  }

  private async ensureCalendar(at: string, account: GCalAccount): Promise<string> {
    if (account.calendarId) {
      try {
        await this.client.getCalendar(at, account.calendarId);
        return account.calendarId;
      } catch (e) {
        if (!(e instanceof GoogleNotFoundError)) throw e;
        logger.warn(`Account ${account.id}: calendar no longer exists, recreating`);
      }
    }
    const id = await this.client.insertCalendar(at, GCAL_CALENDAR_NAME, GCAL_TIME_ZONE);
    await this.repo.setCalendarId(account.id, id);
    await this.repo.clearMappings(account.id); // old mappings pointed at the deleted calendar
    account.calendarId = id;
    return id;
  }

  /** Insert with a fixed id; 409 means the id already exists (e.g. previously deleted) -> overwrite it. */
  private async insertOrRevive(at: string, calendarId: string, eventId: string, payload: GoogleEventPayload): Promise<string> {
    try {
      return await this.client.insertEvent(at, calendarId, { ...payload, id: eventId });
    } catch (e) {
      if (!(e instanceof GoogleConflictError)) throw e;
      await this.client.updateEvent(at, calendarId, eventId, payload);
      return eventId;
    }
  }
}
