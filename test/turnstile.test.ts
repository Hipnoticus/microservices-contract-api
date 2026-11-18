import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { HttpException } from '@nestjs/common';
import { isProduction, requireTurnstile, SITEVERIFY_URL } from '../src/interfaces/http/Turnstile';
import { OrderController } from '../src/interfaces/http/controllers/OrderController';
import { orderIp } from '../src/infrastructure/persistence/repositories/SequelizeOrderRepository';

// Incident 20261118: a curl bot created orders through POST /orders. Every public order now needs a Turnstile token.

const SECRET = 'test-secret-0123456789';

function fakeFetch(reply: any, calls: any[] = []) {
  return async (url: string, init: any) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return { ok: true, status: 200, json: async () => reply };
  };
}

async function status(p: Promise<unknown>): Promise<number> {
  try { await p; return 200; } catch (e) { return e instanceof HttpException ? e.getStatus() : -1; }
}

describe('requireTurnstile', () => {
  test('a valid token passes; secret, token and remote IP go to siteverify', async () => {
    const calls: any[] = [];
    await requireTurnstile('tok-1', '203.0.113.7', 'POST /orders', { secret: SECRET, production: true, fetchFn: fakeFetch({ success: true }, calls) });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(SITEVERIFY_URL);
    const form = new URLSearchParams(calls[0].init.body);
    expect(form.get('secret')).toBe(SECRET);
    expect(form.get('response')).toBe('tok-1');
    expect(form.get('remoteip')).toBe('203.0.113.7');
  });

  test('a rejected, reused or expired token is 403', async () => {
    const f = fakeFetch({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(await status(requireTurnstile('tok-1', '203.0.113.7', 'x', { secret: SECRET, fetchFn: f }))).toBe(403);
  });

  test('no token is 403 without calling Cloudflare', async () => {
    const calls: any[] = [];
    for (const t of [undefined, '', '   ', 42, 'x'.repeat(2049)]) {
      expect(await status(requireTurnstile(t, '1.2.3.4', 'x', { secret: SECRET, fetchFn: fakeFetch({ success: true }, calls) }))).toBe(403);
    }
    expect(calls.length).toBe(0);
  });

  test('siteverify unreachable fails closed (403)', async () => {
    const f = fakeFetch(new Error('ECONNRESET'));
    expect(await status(requireTurnstile('tok', '1.2.3.4', 'x', { secret: SECRET, fetchFn: f }))).toBe(403);
  });

  test('unknown IP is not sent as remoteip', async () => {
    const calls: any[] = [];
    await requireTurnstile('tok', 'unknown', 'x', { secret: SECRET, fetchFn: fakeFetch({ success: true }, calls) });
    expect(new URLSearchParams(calls[0].init.body).has('remoteip')).toBe(false);
  });

  test('no secret: production refuses, dev lets it through', async () => {
    const calls: any[] = [];
    expect(await status(requireTurnstile('tok', '1.2.3.4', 'x', { secret: '', production: true, fetchFn: fakeFetch({ success: true }, calls) }))).toBe(403);
    expect(await status(requireTurnstile(undefined, '1.2.3.4', 'x', { secret: '', production: false, fetchFn: fakeFetch({ success: true }, calls) }))).toBe(200);
    expect(calls.length).toBe(0);
  });

  test('production is HIPNOTICUS_ENV=prod or NODE_ENV=production', () => {
    expect(isProduction({ HIPNOTICUS_ENV: 'prod' } as any)).toBe(true);
    expect(isProduction({ NODE_ENV: 'production' } as any)).toBe(true);
    expect(isProduction({ HIPNOTICUS_ENV: 'dev' } as any)).toBe(false);
    expect(isProduction({} as any)).toBe(false);
  });
});

describe('POST /orders and Turnstile', () => {
  const JWT_KEY = 'k'.repeat(40);
  const saved = { secret: process.env.TURNSTILE_SECRET, jwt: process.env.JWT_HS256_KEY, fetch: globalThis.fetch };
  let siteverifyCalls: string[] = [];
  let siteverifyReply: any = { success: true };

  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const staffToken = () => {
    const h = b64({ alg: 'HS256', typ: 'JWT' });
    const p = b64({ type: 'user', sub: '1', name: 'Staff', perms: [3], exp: Math.floor(Date.now() / 1000) + 600 });
    const s = createHmac('sha256', JWT_KEY).update(`${h}.${p}`).digest('base64url');
    return `Bearer ${h}.${p}.${s}`;
  };

  let executed: any[] = [];
  const controller = () => new OrderController({ execute: async (dto: any, meta: any) => { executed.push({ dto, meta }); return { id: 1 }; } } as any, {} as any);
  let n = 0;
  const req = (headers: Record<string, string> = {}) => ({ headers: { 'cf-connecting-ip': `198.51.100.${++n % 250}`, ...headers } });

  beforeEach(() => {
    process.env.TURNSTILE_SECRET = SECRET;
    process.env.JWT_HS256_KEY = JWT_KEY;
    executed = []; siteverifyCalls = []; siteverifyReply = { success: true };
    (globalThis as any).fetch = async (_url: string, init: any) => {
      siteverifyCalls.push(init.body);
      return { ok: true, status: 200, json: async () => siteverifyReply };
    };
  });
  afterEach(() => {
    process.env.TURNSTILE_SECRET = saved.secret;
    process.env.JWT_HS256_KEY = saved.jwt;
    globalThis.fetch = saved.fetch;
  });

  test('anonymous order without a token is 403 and nothing is created', async () => {
    expect(await status(controller().create({ customer: {} } as any, req()))).toBe(403);
    expect(executed.length).toBe(0);
  });

  test('a customer token does not skip Turnstile', async () => {
    siteverifyReply = { success: false, 'error-codes': ['invalid-input-response'] };
    expect(await status(controller().create({ turnstileToken: 'bad' } as any, req({ authorization: 'Bearer a.b.c' })))).toBe(403);
    expect(executed.length).toBe(0);
  });

  test('a valid token creates the order; the token is not passed on as order data', async () => {
    await controller().create({ turnstileToken: 'good', mainGoal: 'Ansiedade' } as any, req());
    expect(siteverifyCalls.length).toBe(1);
    expect(executed.length).toBe(1);
    expect(executed[0].dto.mainGoal).toBe('Ansiedade');
    expect('turnstileToken' in executed[0].dto).toBe(false);
    expect(executed[0].meta.ip).toMatch(/^198\.51\.100\./);
  });

  test('a staff token skips Turnstile', async () => {
    await controller().create({ mainGoal: 'x' } as any, req({ authorization: staffToken() }));
    expect(siteverifyCalls.length).toBe(0);
    expect(executed.length).toBe(1);
  });
});

describe('tbOrders.IP', () => {
  test('stores real IPv4/IPv6 addresses, NULL otherwise', () => {
    expect(orderIp('203.0.113.7')).toBe('203.0.113.7');
    expect(orderIp('2804:14c:5b8a:4000:1d2e:3f4a:5b6c:7d8e')).toBe('2804:14c:5b8a:4000:1d2e:3f4a:5b6c:7d8e');
    expect(orderIp('unknown')).toBeNull();
    expect(orderIp('')).toBeNull();
    expect(orderIp(undefined)).toBeNull();
    expect(orderIp("1.2.3.4'; DROP TABLE tbOrders;--")).toBeNull();
  });
});
