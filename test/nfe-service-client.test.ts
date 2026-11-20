import { afterEach, describe, expect, test } from 'bun:test';
import { NfeServiceClient, nfeServiceEnabled, queryOf } from '../src/infrastructure/nfse/NfeServiceClient';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function capture(text: string, status = 200) {
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return calls;
}

describe('NFeAPI client (NFE_SERVICE_ENABLED)', () => {
  test('the flag is opt-in', () => {
    expect(nfeServiceEnabled({ NFE_SERVICE_ENABLED: 'true' } as any)).toBe(true);
    expect(nfeServiceEnabled({ NFE_SERVICE_ENABLED: ' TRUE ' } as any)).toBe(true);
    expect(nfeServiceEnabled({ NFE_SERVICE_ENABLED: 'false' } as any)).toBe(false);
    expect(nfeServiceEnabled({} as any)).toBe(false);
  });

  test('the query string is passed on unchanged', () => {
    expect(queryOf({ originalUrl: '/nfse?status=2&customerId=43' })).toBe('?status=2&customerId=43');
    expect(queryOf({ originalUrl: '/nfse' })).toBe('');
    expect(queryOf({})).toBe('');
  });

  test('POST sends the body with the service token and returns NFeAPI status and JSON', async () => {
    const calls = capture('{"success":false,"error":"NFS-e não está em rascunho"}', 201);
    const c = new NfeServiceClient('http://nfe:2004/', 'tok-0123456789abcdef01234567');
    const r = await c.forward('POST', '/internal/nfse/7/issue', {});
    expect(calls[0].url).toBe('http://nfe:2004/internal/nfse/7/issue');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['X-Service-Token']).toBe('tok-0123456789abcdef01234567');
    expect(calls[0].init.body).toBe('{}');
    expect(r).toEqual({ status: 201, body: { success: false, error: 'NFS-e não está em rascunho' } });
  });

  test('GET and DELETE send no body; an empty answer stays empty (GET /nfse/:id of a missing one)', async () => {
    const calls = capture('', 200);
    const c = new NfeServiceClient('http://nfe:2004', 'tok-0123456789abcdef01234567');
    expect(await c.forward('GET', '/internal/nfse/999')).toEqual({ status: 200, body: undefined });
    await c.forward('DELETE', '/internal/admin/nfse/5?staffId=1');
    expect(calls.map(x => x.init.body)).toEqual([undefined, undefined]);
  });

  test('NFeAPI unreachable is a 503 with an error body', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    const c = new NfeServiceClient('http://nfe:2004', 'tok-0123456789abcdef01234567');
    try {
      await c.forward('GET', '/internal/nfse');
      throw new Error('expected a 503');
    } catch (e: any) {
      expect(e.getStatus()).toBe(503);
      expect(e.getResponse().error).toContain('NFS-e');
    }
  });
});
