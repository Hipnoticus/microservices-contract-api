import { describe, expect, it } from 'bun:test';
import { createHmac } from 'crypto';
import { liveKitToken } from '../src/application/video/LiveKitToken';

const KEY = 'devkey';
const SECRET = 'a'.repeat(40);

function decode(part: string) {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

describe('liveKitToken', () => {
  it('signs a HS256 token with the room grant', () => {
    const t = liveKitToken(KEY, SECRET, { room: 'session-7', identity: 'customer-43', name: 'Gabriel', ttlSeconds: 60 }, 1000);
    const [h, p, s] = t.split('.');
    expect(decode(h).alg).toBe('HS256');
    const payload = decode(p);
    expect(payload.iss).toBe(KEY);
    expect(payload.sub).toBe('customer-43');
    expect(payload.exp).toBe(1060);
    expect(payload.video).toMatchObject({ room: 'session-7', roomJoin: true, canPublish: true, roomAdmin: false });
    const expected = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(s).toBe(expected);
  });

  it('refuses a missing or short secret', () => {
    expect(() => liveKitToken(KEY, 'short', { room: 'r', identity: 'i', name: 'n', ttlSeconds: 60 })).toThrow();
  });
});
