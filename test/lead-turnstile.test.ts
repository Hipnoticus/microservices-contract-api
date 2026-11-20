import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { HttpException } from '@nestjs/common';
import { LeadController } from '../src/interfaces/http/controllers/LeadController';

// The lead form (Moses "Comece Seu Tratamento", Contratar step 1) needs its own Turnstile token, like POST /orders.
const SECRET = 'test-secret-0123456789';
const JWT_KEY = 'k'.repeat(40);

async function status(p: Promise<unknown>): Promise<number> {
  try { await p; return 200; } catch (e) { return e instanceof HttpException ? e.getStatus() : -1; }
}

describe('POST /leads/register and Turnstile', () => {
  const saved = {
    secret: process.env.TURNSTILE_SECRET, jwt: process.env.JWT_HS256_KEY, interspire: process.env.INTERSPIRE_TOKEN,
    env: process.env.HIPNOTICUS_ENV, fetch: globalThis.fetch,
  };
  let siteverify: URLSearchParams[] = [];
  let otherFetches: string[] = [];
  let siteverifyReply: any = { success: true };
  let inserts: any[] = [];
  const db = {
    query: async (sql: string, opts?: any) => { if (/INSERT INTO tbLeads/.test(sql)) inserts.push(opts.replacements); return []; },
  };
  const controller = () => new LeadController(db as any);
  let n = 0;
  const ip = () => `192.0.2.${(++n % 250) + 1}`;
  const req = (headers: Record<string, string> = {}, from = ip()) => ({ headers: { 'cf-connecting-ip': from, ...headers } });
  const lead = { name: 'Maria da Silva', email: 'maria.silva@gmail.com', phone: '(21) 99876-5432', cpf: '' };
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const staffToken = () => {
    const h = b64({ alg: 'HS256', typ: 'JWT' });
    const p = b64({ type: 'user', sub: '1', name: 'Staff', perms: [3], exp: Math.floor(Date.now() / 1000) + 600 });
    return `Bearer ${h}.${p}.${createHmac('sha256', JWT_KEY).update(`${h}.${p}`).digest('base64url')}`;
  };

  beforeEach(() => {
    process.env.TURNSTILE_SECRET = SECRET;
    process.env.JWT_HS256_KEY = JWT_KEY;
    delete process.env.INTERSPIRE_TOKEN;
    siteverify = []; otherFetches = []; inserts = []; siteverifyReply = { success: true };
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (String(url).includes('siteverify')) {
        siteverify.push(new URLSearchParams(init.body));
        return { ok: true, status: 200, json: async () => siteverifyReply };
      }
      otherFetches.push(String(url));
      return { ok: true, status: 200, text: async () => '<status>SUCCESS</status>', json: async () => ({}) };
    };
  });
  afterEach(() => {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('TURNSTILE_SECRET', saved.secret);
    restore('JWT_HS256_KEY', saved.jwt);
    restore('INTERSPIRE_TOKEN', saved.interspire);
    restore('HIPNOTICUS_ENV', saved.env);
    globalThis.fetch = saved.fetch;
  });

  test('no token is 403 before validation, so an invalid body is refused the same way and nothing is stored', async () => {
    expect(await status(controller().registerLead({ ...lead }, req()))).toBe(403);
    expect(await status(controller().registerLead({ name: 'x' }, req()))).toBe(403);
    expect(await status(controller().registerLead(null, req()))).toBe(403);
    expect(siteverify.length).toBe(0);
    expect(inserts.length).toBe(0);
  });

  test('a rejected or reused token is 403 and nothing is stored', async () => {
    siteverifyReply = { success: false, 'error-codes': ['timeout-or-duplicate'] };
    expect(await status(controller().registerLead({ ...lead, turnstileToken: 'used' }, req()))).toBe(403);
    expect(inserts.length).toBe(0);
  });

  test('a customer token does not skip Turnstile', async () => {
    expect(await status(controller().registerLead({ ...lead }, req({ authorization: 'Bearer a.b.c' })))).toBe(403);
    expect(inserts.length).toBe(0);
  });

  test('a valid token stores the lead; siteverify gets the client IP; the token is not stored', async () => {
    const res = await controller().registerLead({ ...lead, turnstileToken: 'good-token' }, req({}, '203.0.113.9'));
    expect(res).toEqual({ success: true });
    expect(siteverify.length).toBe(1);
    expect(siteverify[0].get('response')).toBe('good-token');
    expect(siteverify[0].get('remoteip')).toBe('203.0.113.9');
    expect(inserts.length).toBe(1);
    expect(inserts[0].email).toBe('maria.silva@gmail.com');
    expect(JSON.stringify(inserts[0])).not.toContain('good-token');
  });

  test('the token is not forwarded to Interspire', async () => {
    process.env.INTERSPIRE_TOKEN = 'interspire-test-token';
    let xml = '';
    const base = globalThis.fetch as any;
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (!String(url).includes('siteverify')) xml = String(init.body);
      return base(url, init);
    };
    await controller().registerLead({ ...lead, turnstileToken: 'secret-turnstile-token' }, req());
    expect(xml).toContain('maria.silva@gmail.com');
    expect(xml).not.toContain('secret-turnstile-token');
  });

  test('a valid token with an invalid body is still 400', async () => {
    expect(await status(controller().registerLead({ name: 'Maria', email: 'x', turnstileToken: 'good' }, req()))).toBe(400);
    expect(inserts.length).toBe(0);
  });

  test('a staff token skips Turnstile', async () => {
    await controller().registerLead({ ...lead }, req({ authorization: staffToken() }));
    expect(siteverify.length).toBe(0);
    expect(inserts.length).toBe(1);
  });

  test('production without a secret refuses every public lead (fail closed)', async () => {
    delete process.env.TURNSTILE_SECRET;
    process.env.HIPNOTICUS_ENV = 'prod';
    expect(await status(controller().registerLead({ ...lead, turnstileToken: 'good' }, req()))).toBe(403);
    expect(inserts.length).toBe(0);
  });
});
