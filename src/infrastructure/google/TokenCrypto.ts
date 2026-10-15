/**
 * TokenCrypto — AES-256-GCM encryption of Google refresh tokens at rest and
 * HMAC-SHA256 signing of the OAuth `state` parameter.
 *
 * Key: GCAL_TOKEN_ENC_KEY (base64, 32 bytes). The HMAC key is derived from it so
 * only one secret has to be configured.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OAuthState {
  uid: number;
  exp: number;
  nonce: string;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export class TokenCrypto {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key || '', 'base64');
    if (key.length !== 32) {
      throw new Error('GCAL_TOKEN_ENC_KEY must be 32 bytes encoded as base64');
    }
    this.encKey = key;
    this.macKey = createHmac('sha256', key).update('hipnoticus-gcal-oauth-state').digest();
  }

  /** Returns `base64(iv).base64(tag).base64(ciphertext)`. */
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
  }

  /** Throws when the value was tampered with or encrypted under another key. */
  decrypt(packed: string): string {
    const parts = (packed || '').split('.');
    if (parts.length !== 3) throw new Error('Invalid encrypted token format');
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  signState(uid: number, ttlMs = 10 * 60 * 1000, now = Date.now()): string {
    const state: OAuthState = { uid, exp: now + ttlMs, nonce: randomBytes(12).toString('hex') };
    const body = b64url(Buffer.from(JSON.stringify(state), 'utf8'));
    const mac = b64url(createHmac('sha256', this.macKey).update(body).digest());
    return `${body}.${mac}`;
  }

  /** Returns the state when the signature is valid and not expired, otherwise null. */
  verifyState(value: string, now = Date.now()): OAuthState | null {
    if (typeof value !== 'string') return null;
    const parts = value.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const expected = createHmac('sha256', this.macKey).update(parts[0]).digest();
    const given = fromB64url(parts[1]);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const state = JSON.parse(fromB64url(parts[0]).toString('utf8')) as OAuthState;
      if (!Number.isInteger(state.uid) || typeof state.exp !== 'number' || state.exp < now) return null;
      return state;
    } catch {
      return null;
    }
  }
}
