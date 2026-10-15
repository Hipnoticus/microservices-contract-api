import { beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { TokenCrypto } from '../src/infrastructure/google/TokenCrypto';
import {
  buildEventPayload, GCAL_REVOKED_MESSAGE, SyncGoogleCalendarUseCase,
} from '../src/application/use-cases/SyncGoogleCalendarUseCase';
import { FakeClient, FakeRepo, session } from './gcal-fakes';

let repo: FakeRepo;
let client: FakeClient;
let crypto: TokenCrypto;
let useCase: SyncGoogleCalendarUseCase;
let accountId: number;

beforeEach(async () => {
  repo = new FakeRepo();
  client = new FakeClient();
  crypto = new TokenCrypto(randomBytes(32).toString('base64'));
  useCase = new SyncGoogleCalendarUseCase(repo, client, crypto, 30);
  accountId = await repo.upsertAccount(1, 'henrique@hipnoterapia.org', crypto.encrypt('rt-1'));
  for (const id of [101, 102, 103]) repo.sessions.set(id, session(id, { dateBegins: `2026-10-2${id - 100}T10:00:00`, dateEnds: `2026-10-2${id - 100}T11:00:00` }));
});

function events() {
  const calId = repo.accounts.get(accountId)!.calendarId!;
  return client.calendars.get(calId)!;
}

describe('SyncGoogleCalendarUseCase', () => {
  test('first sync creates the Hipnoticus Agenda calendar, N events and N mappings', async () => {
    const r = await useCase.syncAccount(accountId);
    expect(r).toEqual({ created: 3, updated: 0, deleted: 0, failed: 0 });
    expect(client.calls.filter((c) => c === 'insertCalendar').length).toBe(1);
    expect([...events().keys()].sort()).toEqual(['hipno101', 'hipno102', 'hipno103']);
    expect(repo.mappings.get(accountId)!.size).toBe(3);
    expect(repo.accounts.get(accountId)!.status).toBe('active');
    expect(repo.accounts.get(accountId)!.lastSyncAt).not.toBeNull();
  });

  test('second sync with no changes makes zero event writes', async () => {
    await useCase.syncAccount(accountId);
    client.calls = [];
    const r = await useCase.syncAccount(accountId);
    expect(r).toEqual({ created: 0, updated: 0, deleted: 0, failed: 0 });
    expect(client.eventWrites).toBe(0);
    expect(client.calls).not.toContain('insertCalendar');
  });

  test('changed time -> exactly one update', async () => {
    await useCase.syncAccount(accountId);
    client.calls = [];
    repo.sessions.get(102)!.dateBegins = '2026-10-22T15:00:00';
    repo.sessions.get(102)!.dateEnds = '2026-10-22T16:00:00';
    const r = await useCase.syncAccount(accountId);
    expect(r).toEqual({ created: 0, updated: 1, deleted: 0, failed: 0 });
    expect(client.calls.filter((c) => c.startsWith('updateEvent'))).toEqual(['updateEvent:hipno102']);
    expect(events().get('hipno102')!.start).toEqual({ dateTime: '2026-10-22T15:00:00', timeZone: 'America/Sao_Paulo' });
  });

  test('deleted, cancelled (5), rescheduled (7), blocked and re-assigned sessions are removed from Google', async () => {
    for (const id of [104, 105]) repo.sessions.set(id, session(id));
    await useCase.syncAccount(accountId);
    repo.sessions.get(101)!.deleted = true;
    repo.sessions.get(102)!.status = '5';
    repo.sessions.get(103)!.status = '7';
    repo.sessions.get(104)!.blocked = true;
    repo.sessions.get(105)!.therapist = 2;
    client.calls = [];
    const r = await useCase.syncAccount(accountId);
    expect(r).toEqual({ created: 0, updated: 0, deleted: 5, failed: 0 });
    expect([...events().values()].every((e) => e.cancelled)).toBe(true);
    expect(repo.mappings.get(accountId)!.size).toBe(0);
  });

  test('a session that only aged out of the window is left in Google', async () => {
    await useCase.syncAccount(accountId);
    repo.windowStart = '2026-10-22T00:00:00'; // 101 is now older than the window
    client.calls = [];
    const r = await useCase.syncAccount(accountId);
    expect(r).toEqual({ created: 0, updated: 0, deleted: 0, failed: 0 });
    expect(events().get('hipno101')!.cancelled).toBeUndefined();
    expect(repo.mappings.get(accountId)!.has(101)).toBe(true);
  });

  test('409 on insert (id already used) -> update instead', async () => {
    await useCase.syncAccount(accountId);
    repo.mappings.get(accountId)!.delete(101); // mapping lost, event still in Google
    client.calls = [];
    const r = await useCase.syncAccount(accountId);
    expect(r.created).toBe(1);
    expect(client.calls).toEqual(expect.arrayContaining(['insertEvent:hipno101', 'updateEvent:hipno101']));
    expect(repo.mappings.get(accountId)!.get(101)!.googleEventId).toBe('hipno101');
  });

  test('a session cancelled and later restored is revived (409 -> update with status confirmed)', async () => {
    await useCase.syncAccount(accountId);
    repo.sessions.get(101)!.status = '5';
    await useCase.syncAccount(accountId);
    repo.sessions.get(101)!.status = '1';
    const r = await useCase.syncAccount(accountId);
    expect(r.created).toBe(1);
    const ev = events().get('hipno101')!;
    expect(ev.status).toBe('confirmed');
    expect(ev.cancelled).toBeUndefined();
  });

  test('calendar deleted by the user in Google -> recreated and all events re-sent', async () => {
    await useCase.syncAccount(accountId);
    client.calendars.clear();
    const r = await useCase.syncAccount(accountId);
    expect(r.created).toBe(3);
    expect(events().size).toBe(3);
  });

  test('revoked grant -> account marked revoked with the pt-BR message', async () => {
    client.revoked = true;
    await expect(useCase.syncAccount(accountId)).rejects.toThrow();
    expect(repo.accounts.get(accountId)!.status).toBe('revoked');
    expect(repo.accounts.get(accountId)!.lastError).toBe(GCAL_REVOKED_MESSAGE);
  });

  test('syncAll skips revoked accounts and keeps going after a failing account', async () => {
    const other = await repo.upsertAccount(1, 'punkore8@gmail.com', 'not-decryptable');
    await useCase.syncAll();
    expect(repo.accounts.get(other)!.status).toBe('error');
    expect(repo.accounts.get(accountId)!.status).toBe('active');
    expect(events().size).toBe(3);
  });

  test('concurrent calls for one account share a single run', async () => {
    const [a, b] = await Promise.all([useCase.syncAccount(accountId), useCase.syncAccount(accountId)]);
    expect(a).toBe(b);
    expect(client.calls.filter((c) => c === 'insertCalendar').length).toBe(1);
  });
});

describe('buildEventPayload', () => {
  test('naive BRT times with the Sao Paulo zone, no offset, no therapy notes', () => {
    const p = buildEventPayload(session(7, { name: 'Sessão', clientName: 'Maria Silva', firstSession: true, paid: false }));
    expect(p.summary).toBe('Sessão - Maria Silva');
    expect(p.start).toEqual({ dateTime: '2026-10-20T10:00:00', timeZone: 'America/Sao_Paulo' });
    expect(p.end.dateTime).toBe('2026-10-20T11:00:00');
    expect(p.description).toContain('Primeira sessão: Sim');
    expect(p.description).toContain('Paga: Não');
    expect(p.description).toContain('Telefone: 21999990000');
    expect(p.description).toContain('Alterações feitas aqui serão sobrescritas.');
    expect(p.reminders).toEqual({ useDefault: false, overrides: [] });
    expect(p.transparency).toBe('opaque');
  });

  test('missing or inverted end -> start + 60 min, crossing midnight correctly', () => {
    expect(buildEventPayload(session(8, { dateBegins: '2026-10-20T23:30:00', dateEnds: null })).end.dateTime).toBe('2026-10-21T00:30:00');
    expect(buildEventPayload(session(9, { dateEnds: '2026-10-20T09:00:00' })).end.dateTime).toBe('2026-10-20T11:00:00');
  });
});
