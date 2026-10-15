import { beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { TokenCrypto } from '../src/infrastructure/google/TokenCrypto';
import { SyncGoogleCalendarUseCase } from '../src/application/use-cases/SyncGoogleCalendarUseCase';
import {
  GCAL_NOT_CONFIGURED, GoogleCalendarContext, GoogleCalendarController,
} from '../src/interfaces/http/controllers/GoogleCalendarController';
import { FakeClient, FakeRepo, session } from './gcal-fakes';

class FakeRes {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  redirectedTo = '';
  status(code: number) { this.statusCode = code; return this; }
  setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; return this; }
  send(b: string) { this.body = b; return this; }
  redirect(code: number, url: string) { this.statusCode = code; this.redirectedTo = url; }
}

let repo: FakeRepo;
let client: FakeClient;
let crypto: TokenCrypto;
let ctx: GoogleCalendarContext;
let ctrl: GoogleCalendarController;
let n = 0;

function ticket(userId = 1, opts: { used?: boolean; expired?: boolean } = {}) {
  const t = (++n).toString(16).padStart(64, 'a');
  repo.tickets.set(t, { userId, used: !!opts.used, expired: !!opts.expired });
  return t;
}

async function status(p: Promise<unknown>): Promise<number> {
  try { await p; return 200; } catch (e) { return (e as HttpException).getStatus(); }
}

beforeEach(() => {
  repo = new FakeRepo();
  client = new FakeClient();
  crypto = new TokenCrypto(randomBytes(32).toString('base64'));
  ctx = { repo, client, crypto, sync: new SyncGoogleCalendarUseCase(repo, client, crypto, 30) };
  ctrl = new GoogleCalendarController(ctx);
  repo.sessions.set(1, session(1));
});

describe('GoogleCalendarController tickets', () => {
  test('missing, unknown, used or expired ticket -> 401; a ticket works exactly once', async () => {
    expect(await status(ctrl.listAccounts(undefined as any))).toBe(401);
    expect(await status(ctrl.listAccounts('f'.repeat(64)))).toBe(401);
    expect(await status(ctrl.listAccounts(ticket(1, { used: true })))).toBe(401);
    expect(await status(ctrl.listAccounts(ticket(1, { expired: true })))).toBe(401);
    const t = ticket(1);
    expect(await ctrl.listAccounts(t)).toEqual([]);
    expect(await status(ctrl.listAccounts(t))).toBe(401);
  });

  test('credentials missing -> 401 without ticket, 503 with a valid ticket', async () => {
    ctrl = new GoogleCalendarController({ repo, client: null, crypto: null, sync: null });
    expect(await status(ctrl.listAccounts(''))).toBe(401);
    try { await ctrl.listAccounts(ticket(1)); throw new Error('expected 503'); } catch (e) {
      expect((e as HttpException).getStatus()).toBe(503);
      expect((e as HttpException).getResponse()).toEqual({ error: GCAL_NOT_CONFIGURED });
    }
    const res = new FakeRes();
    await ctrl.oauthStart(ticket(1), res as any);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('Integração com Google Agenda não configurada');
    const res2 = new FakeRes();
    await ctrl.oauthStart('', res2 as any);
    expect(res2.statusCode).toBe(401);
  });
});

describe('GoogleCalendarController OAuth', () => {
  test('start redirects to Google with a state bound to the ticket user', async () => {
    const res = new FakeRes();
    await ctrl.oauthStart(ticket(1), res as any);
    expect(res.statusCode).toBe(302);
    const state = new URL(res.redirectedTo).searchParams.get('state')!;
    expect(crypto.verifyState(state)?.uid).toBe(1);
  });

  test('callback stores an encrypted token, starts the first sync and escapes output', async () => {
    client.exchange = { refreshToken: 'rt-secret', email: 'a<b>@example.com', emailVerified: true };
    const res = new FakeRes();
    await ctrl.oauthCallback({ code: 'c', state: crypto.signState(1) }, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('a&lt;b&gt;@example.com');
    expect(res.body).toContain('A primeira sincronização já começou');
    const acc = [...repo.accounts.values()][0];
    expect(acc.userId).toBe(1);
    expect(acc.refreshTokenEnc).not.toContain('rt-secret');
    expect(crypto.decrypt(acc.refreshTokenEnc)).toBe('rt-secret');
    await new Promise((r) => setTimeout(r, 10));
    expect(repo.mappings.get(acc.id)?.size).toBe(1);
  });

  test('callback rejects a forged/expired state, access_denied and unverified e-mail', async () => {
    for (const q of [
      { code: 'c', state: 'forged.state' },
      { code: 'c', state: crypto.signState(1, -1) },
      { error: 'access_denied', state: crypto.signState(1) },
    ]) {
      const res = new FakeRes();
      await ctrl.oauthCallback(q as any, res as any);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Não foi possível conectar a conta Google');
    }
    client.exchange = { refreshToken: 'x', email: 'u@example.com', emailVerified: false };
    const res = new FakeRes();
    await ctrl.oauthCallback({ code: 'c', state: crypto.signState(1) }, res as any);
    expect(res.statusCode).toBe(400);
    expect(repo.accounts.size).toBe(0);
  });
});

describe('GoogleCalendarController accounts', () => {
  test('list shows only the ticket user accounts; sync and delete enforce ownership (404)', async () => {
    const mine = await repo.upsertAccount(1, 'henrique@hipnoterapia.org', crypto.encrypt('rt-1'));
    const theirs = await repo.upsertAccount(2, 'other@example.com', crypto.encrypt('rt-2'));
    const list = await ctrl.listAccounts(ticket(1));
    expect(list.map((a) => a.id)).toEqual([mine]);
    expect(JSON.stringify(list)).not.toContain('refreshToken');
    expect(await status(ctrl.syncNow(ticket(1), String(theirs)))).toBe(404);
    expect(await status(ctrl.disconnect(ticket(1), String(theirs)))).toBe(404);
    expect(await status(ctrl.syncNow(ticket(1), 'abc'))).toBe(404);
    expect(repo.accounts.has(theirs)).toBe(true);
  });

  test('sync now returns counts; disconnect deletes the calendar, revokes and forgets the account', async () => {
    const id = await repo.upsertAccount(1, 'henrique@hipnoterapia.org', crypto.encrypt('rt-1'));
    expect(await ctrl.syncNow(ticket(1), String(id))).toEqual({ created: 1, updated: 0, deleted: 0, failed: 0 });
    const calId = repo.accounts.get(id)!.calendarId!;
    expect(await ctrl.disconnect(ticket(1), String(id))).toEqual({ removed: true });
    expect(client.calendars.has(calId)).toBe(false);
    expect(client.revokedTokens).toEqual(['rt-1']);
    expect(repo.accounts.has(id)).toBe(false);
  });
});
