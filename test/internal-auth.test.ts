import { describe, expect, test } from 'bun:test';
import { InternalAuth, internalAuthMiddleware, sign, callerHeaders } from '../src/interfaces/http/auth/InternalAuth';

// Shared vectors of AGENTS.md "Internal-call authentication" (same values in every service)
const KEY = '0123456789abcdef0123456789abcdef';
const TOKEN = 'test-caller-token-0123456789abcdef';
const TOKEN_HASH = '4e165f89851e66dc1038992da86c2a344ac9d83a3e1fabfc6129e59bc51246bc';
const V1 = '59f9df27b122faa8ef77303b68b04808e1fcee05bc9b6aef4fd5b62cc330d2da';

const auth = (mode = 'enforce', now = 1700000000) =>
  new InternalAuth({ mode, gatewayKey: KEY, callers: 'contract-api:' + TOKEN_HASH, publicRoutes: ['GET /public/**', '/open'], legacy: [{ header: 'X-Service-Token', list: 'schedule:legacy-token-0123456789' }], now: () => now });
const h = (o: Record<string, string>) => (n: string) => Object.entries(o).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1];
const signed = (sig: string, id = '43') => h({ 'X-User-Type': 'customer', 'X-User-Id': id, 'X-Gateway-Ts': '1700000000', 'X-Gateway-Auth': sig });

describe('internal auth', () => {
  test('shared vectors', () => {
    expect(sign(KEY, 'GET', '/customers/43?x=1', 'customer', '43', '', 1700000000)).toBe(V1);
    expect(sign(KEY, 'POST', '/admin/sessions', 'user', '7', '3,6', 1700000000)).toBe('cb00be15995a3652fa5d418c84f22a7f619b96250bca362e0d0a0768ba0486ba');
    expect(sign(KEY, 'GET', '/health', undefined, undefined, undefined, 1700000000)).toBe('4684b04ee295e4de31112e4f41cc5a30e4fdc1c9902d83a3002ac2f062701318');
  });
  test('valid, tampered, expired', () => {
    expect(auth().identify('GET', '/customers/43?x=1', signed(V1)).kind).toBe('gateway');
    expect(auth().identify('GET', '/customers/43?x=1', signed(V1, '44')).reason).toBe('bad-gateway-signature');
    expect(auth().identify('GET', '/customers/44?x=1', signed(V1)).reason).toBe('bad-gateway-signature');
    expect(auth('enforce', 1700000061).identify('GET', '/customers/43?x=1', signed(V1)).reason).toBe('expired-gateway-signature');
    expect(auth('enforce', 1700000060).identify('GET', '/customers/43?x=1', signed(V1)).kind).toBe('gateway');
  });
  test('missing credentials and public routes', () => {
    const a = auth();
    expect(a.identify('GET', '/customers/43', h({ 'X-User-Type': 'customer' }))).toEqual({ kind: 'anonymous', reason: 'no-credentials' });
    expect(a.isPublic('GET', '/public/x/y?z=1')).toBe(true);
    expect(a.isPublic('POST', '/public/x')).toBe(false);
    expect(a.isPublic('POST', '/open/')).toBe(true);
    expect(a.isPublic('GET', '/open/more')).toBe(false);
    expect(a.isPublic('GET', '/health')).toBe(true);
    expect(a.isPublic('GET', '/customers/43')).toBe(false);
  });
  test('caller tokens, unknown, revoked, legacy', () => {
    const a = auth();
    expect(a.identify('POST', '/x', h({ 'X-Caller': 'contract-api', 'X-Caller-Token': TOKEN })).kind).toBe('caller');
    expect(a.identify('POST', '/x', h({ 'X-Caller': 'pendulo', 'X-Caller-Token': TOKEN })).reason).toBe('unknown-caller');
    expect(a.identify('POST', '/x', h({ 'X-Caller': 'contract-api', 'X-Caller-Token': 'wrong' })).reason).toBe('bad-caller-token');
    const revoked = new InternalAuth({ mode: 'enforce', gatewayKey: KEY, callers: '' });
    expect(revoked.identify('POST', '/x', h({ 'X-Caller': 'contract-api', 'X-Caller-Token': TOKEN })).reason).toBe('unknown-caller');
    expect(a.identify('POST', '/internal/x', h({ 'X-Service-Token': 'legacy-token-0123456789' })).caller).toBe('legacy:schedule');
    expect(a.identify('POST', '/internal/x', h({ 'X-Service-Token': 'nope' })).reason).toBe('bad-legacy-token');
  });
  test('middleware: enforce refuses, strips on public routes, report serves', () => {
    const run = (mode: string, url: string, headers: Record<string, string>) => {
      const req: any = { method: 'GET', originalUrl: url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), socket: { remoteAddress: '172.18.0.9' } };
      const res: any = { statusCode: 200, body: '', setHeader() {}, end(b: string) { this.body = b; } };
      let called = false;
      internalAuthMiddleware(auth(mode), () => {})(req, res, () => { called = true; });
      return { req, res, called };
    };
    const forged = { 'X-User-Type': 'user', 'X-User-Id': '1' };
    const refused = run('enforce', '/customers/44', forged);
    expect(refused.called).toBe(false);
    expect(refused.res.statusCode).toBe(401);
    const open = run('enforce', '/public/a', forged);
    expect(open.called).toBe(true);
    expect(open.req.headers['x-user-type']).toBeUndefined();
    const report = run('report', '/customers/44', forged);
    expect(report.called).toBe(true);
    expect(report.req.headers['x-user-type']).toBe('user');
    const caller = run('enforce', '/internal/x', { 'X-Caller': 'contract-api', 'X-Caller-Token': TOKEN });
    expect(caller.req.internalCaller).toBe('contract-api');
  });
  test('caller headers', () => {
    expect(callerHeaders('contract-api', {})).toEqual({});
    expect(callerHeaders('contract-api', { INTERNAL_CALLER_TOKEN: 't' })).toEqual({ 'X-Caller': 'contract-api', 'X-Caller-Token': 't' });
  });
});
