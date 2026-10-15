/** In-memory fakes for the Google Calendar sync tests (no DB, no network). */
import {
  ExchangeResult, GoogleAuthRevokedError, GoogleConflictError, GoogleEventPayload, GoogleNotFoundError, IGoogleCalendarClient,
} from '../src/infrastructure/google/GoogleCalendarClient';
import {
  DesiredSession, EventMapping, GCalAccount, GCalAccountStatus, GCalAccountSummary, IGoogleCalendarRepository,
} from '../src/infrastructure/persistence/repositories/GoogleCalendarRepository';

export interface FakeSession extends DesiredSession {
  therapist: number;
  status: string;
  blocked: boolean;
  deleted?: boolean;
}

export class FakeRepo implements IGoogleCalendarRepository {
  accounts = new Map<number, GCalAccount & { blocked?: boolean }>();
  mappings = new Map<number, Map<number, EventMapping>>();
  sessions = new Map<number, FakeSession>();
  tickets = new Map<string, { userId: number; used: boolean; expired: boolean }>();
  /** sessions with dateBegins before this are outside the sync window */
  windowStart = '2026-01-01T00:00:00';
  private nextId = 1;

  async consumeTicket(token: string) {
    const t = this.tickets.get(token);
    if (!t || t.used || t.expired) return null;
    t.used = true;
    return t.userId;
  }
  async listAccounts(userId: number): Promise<GCalAccountSummary[]> {
    return [...this.accounts.values()].filter((a) => a.userId === userId)
      .map(({ id, googleEmail, status, lastSyncAt, lastError }) => ({ id, googleEmail, status, lastSyncAt, lastError }));
  }
  async listSyncableAccounts() {
    return [...this.accounts.values()].filter((a) => a.status !== 'revoked');
  }
  async getAccount(id: number) {
    const a = this.accounts.get(id);
    return a ? { ...a } : null;
  }
  async upsertAccount(userId: number, googleEmail: string, refreshTokenEnc: string | null) {
    const existing = [...this.accounts.values()].find((a) => a.userId === userId && a.googleEmail === googleEmail);
    if (existing) {
      if (refreshTokenEnc) existing.refreshTokenEnc = refreshTokenEnc;
      existing.status = 'active';
      return existing.id;
    }
    const id = this.nextId++;
    this.accounts.set(id, { id, userId, googleEmail, refreshTokenEnc: refreshTokenEnc!, calendarId: null, status: 'active', lastSyncAt: null, lastError: null });
    return id;
  }
  async setCalendarId(accountId: number, calendarId: string) { this.accounts.get(accountId)!.calendarId = calendarId; }
  async markSyncResult(accountId: number, status: GCalAccountStatus, error: string | null) {
    const a = this.accounts.get(accountId)!;
    a.status = status;
    a.lastError = error;
    if (status === 'active') a.lastSyncAt = '2026-10-15T12:00:00';
  }
  async deleteAccount(accountId: number) { this.accounts.delete(accountId); this.mappings.delete(accountId); }
  async getDesiredSessions(userId: number): Promise<DesiredSession[]> {
    return [...this.sessions.values()]
      .filter((s) => !s.deleted && s.therapist === userId && s.dateBegins >= this.windowStart && !['5', '7'].includes(s.status) && !s.blocked)
      .map(({ therapist, status, blocked, deleted, ...d }) => d);
  }
  async getMappings(accountId: number) {
    return new Map([...(this.mappings.get(accountId) || new Map()).entries()].map(([k, v]) => [k, { ...v }]));
  }
  async getStaleMappings(accountId: number, userId: number) {
    return [...(this.mappings.get(accountId) || new Map()).values()].filter((m) => {
      const s = this.sessions.get(m.sessionId);
      return !s || s.deleted || ['5', '7'].includes(s.status) || s.blocked || s.therapist !== userId;
    });
  }
  async clearMappings(accountId: number) { this.mappings.delete(accountId); }
  async upsertMapping(accountId: number, sessionId: number, googleEventId: string, payloadHash: string) {
    if (!this.mappings.has(accountId)) this.mappings.set(accountId, new Map());
    this.mappings.get(accountId)!.set(sessionId, { sessionId, googleEventId, payloadHash });
  }
  async deleteMapping(accountId: number, sessionId: number) { this.mappings.get(accountId)?.delete(sessionId); }
  async purgeExpiredTickets() {}
}

export class FakeClient implements IGoogleCalendarClient {
  calls: string[] = [];
  calendars = new Map<string, Map<string, GoogleEventPayload & { cancelled?: boolean }>>();
  revoked = false;
  revokedTokens: string[] = [];
  exchange: ExchangeResult = { refreshToken: 'rt-new', email: 'someone@example.com', emailVerified: true };
  private nextCal = 1;

  /** number of calls that write events (insert/update/delete) */
  get eventWrites() { return this.calls.filter((c) => /^(insertEvent|updateEvent|deleteEvent)/.test(c)).length; }

  buildAuthUrl(state: string) { return `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`; }
  async exchangeCode() { this.calls.push('exchangeCode'); return this.exchange; }
  async getAccessToken() {
    this.calls.push('getAccessToken');
    if (this.revoked) throw new GoogleAuthRevokedError('invalid_grant', 400);
    return 'at';
  }
  async revoke(token: string) { this.calls.push('revoke'); this.revokedTokens.push(token); }
  async insertCalendar() {
    this.calls.push('insertCalendar');
    const id = `cal${this.nextCal++}@group.calendar.google.com`;
    this.calendars.set(id, new Map());
    return id;
  }
  async getCalendar(_at: string, id: string) {
    this.calls.push('getCalendar');
    if (!this.calendars.has(id)) throw new GoogleNotFoundError('nf', 404);
  }
  async deleteCalendar(_at: string, id: string) { this.calls.push('deleteCalendar'); this.calendars.delete(id); }
  async insertEvent(_at: string, cal: string, ev: GoogleEventPayload) {
    this.calls.push(`insertEvent:${ev.id}`);
    const events = this.cal(cal);
    if (events.has(ev.id!)) throw new GoogleConflictError('dup', 409);
    events.set(ev.id!, { ...ev });
    return ev.id!;
  }
  async updateEvent(_at: string, cal: string, id: string, ev: GoogleEventPayload) {
    this.calls.push(`updateEvent:${id}`);
    const events = this.cal(cal);
    if (!events.has(id)) throw new GoogleNotFoundError('nf', 404);
    events.set(id, { ...ev, id });
  }
  async deleteEvent(_at: string, cal: string, id: string) {
    this.calls.push(`deleteEvent:${id}`);
    const events = this.cal(cal);
    const e = events.get(id);
    if (!e || e.cancelled) throw new GoogleNotFoundError('gone', 410);
    e.cancelled = true; // Google keeps deleted events as cancelled: re-inserting the same id gives 409
  }
  private cal(id: string) {
    const c = this.calendars.get(id);
    if (!c) throw new GoogleNotFoundError('no calendar', 404);
    return c;
  }
}

export function session(id: number, overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    id, name: 'Sessão', clientName: `Cliente ${id}`, phone: '21999990000', statusName: 'Confirmada',
    firstSession: false, paid: true, dateBegins: '2026-10-20T10:00:00', dateEnds: '2026-10-20T11:00:00',
    therapist: 1, status: '1', blocked: false, ...overrides,
  };
}
