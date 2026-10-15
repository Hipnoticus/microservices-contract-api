import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { TokenCrypto } from '../src/infrastructure/google/TokenCrypto';
import { GoogleCalendarClient, GCAL_SCOPES } from '../src/infrastructure/google/GoogleCalendarClient';

const key = randomBytes(32).toString('base64');

describe('TokenCrypto', () => {
  test('encrypt/decrypt round trip, ciphertext differs per call', () => {
    const c = new TokenCrypto(key);
    const a = c.encrypt('1//refresh-token-value');
    const b = c.encrypt('1//refresh-token-value');
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh-token');
    expect(c.decrypt(a)).toBe('1//refresh-token-value');
  });

  test('tampered ciphertext or wrong key is rejected', () => {
    const c = new TokenCrypto(key);
    const packed = c.encrypt('secret');
    const [iv, tag, ct] = packed.split('.');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 0xff;
    expect(() => c.decrypt(`${iv}.${tag}.${flipped.toString('base64')}`)).toThrow();
    expect(() => new TokenCrypto(randomBytes(32).toString('base64')).decrypt(packed)).toThrow();
  });

  test('rejects keys that are not 32 bytes', () => {
    expect(() => new TokenCrypto(randomBytes(16).toString('base64'))).toThrow();
    expect(() => new TokenCrypto('')).toThrow();
  });

  test('state: valid, expired, tampered, foreign key', () => {
    const c = new TokenCrypto(key);
    const now = 1_700_000_000_000;
    const s = c.signState(42, 10 * 60 * 1000, now);
    expect(c.verifyState(s, now + 1000)?.uid).toBe(42);
    expect(c.verifyState(s, now + 10 * 60 * 1000 + 1)).toBeNull();
    const [body, mac] = s.split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 1, exp: now + 999999, nonce: 'x' })).toString('base64url');
    expect(c.verifyState(`${forged}.${mac}`, now)).toBeNull();
    expect(c.verifyState(`${body}.`, now)).toBeNull();
    expect(c.verifyState('garbage', now)).toBeNull();
    expect(new TokenCrypto(randomBytes(32).toString('base64')).verifyState(s, now)).toBeNull();
  });
});

describe('GoogleCalendarClient.buildAuthUrl', () => {
  test('requests exactly the three minimal scopes, offline access and a consent prompt', () => {
    const client = new GoogleCalendarClient({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb' });
    const url = new URL(client.buildAuthUrl('st'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual([...GCAL_SCOPES].sort());
    expect(GCAL_SCOPES).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created']);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent select_account');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://x/cb');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.has('client_secret')).toBe(false);
  });
});
