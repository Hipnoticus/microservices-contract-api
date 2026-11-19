import { describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { assertNotCustomer, assertOwner, principalOf } from '../src/interfaces/http/auth/StaffAuth';
import { validateLead } from '../src/application/order/SignupValidation';
import { RateLimiter } from '../src/interfaces/http/RateLimiter';

// Audit 2026-11-18 H2: ContractAPI re-checks ownership itself instead of trusting only the gateway's path rules.
const KEY = 'test-secret-test-secret-test-secret-42';
process.env.JWT_HS256_KEY = KEY;
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(payload: any, key = KEY) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(payload);
  const s = createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
  return `Bearer ${h}.${p}.${s}`;
}
const future = Math.floor(Date.now() / 1000) + 3600;
const customer43 = { authorization: token({ sub: '43', type: 'customer', exp: future }) };
const staff = { authorization: token({ sub: '7', type: 'user', perms: [6], exp: future }) };

describe('principalOf / assertOwner', () => {
  test('a customer token may act only on its own rows', () => {
    expect(principalOf(customer43)).toEqual({ kind: 'customer', id: 43 });
    expect(() => assertOwner(customer43, 43)).not.toThrow();
    expect(() => assertOwner(customer43, 44)).toThrow();
    expect(() => assertOwner(customer43, NaN)).toThrow();
    expect(() => assertOwner(customer43, null)).toThrow();
  });
  test('the gateway marker counts as a customer even without a token', () => {
    const marked = { 'x-user-type': 'customer', 'x-user-id': '43' };
    expect(() => assertOwner(marked, 43)).not.toThrow();
    expect(() => assertOwner(marked, 44)).toThrow();
    expect(() => assertOwner({ 'x-user-type': 'customer', 'x-user-id': 'abc' }, 0)).toThrow();
    expect(() => assertNotCustomer(marked)).toThrow();
  });
  test('a forged customer token does not become a server-side caller', () => {
    const forged = { authorization: token({ sub: '43', type: 'customer', exp: future }, 'another-key-another-key-another-key'), 'x-user-type': 'customer', 'x-user-id': '43' };
    expect(() => assertOwner(forged, 44)).toThrow();
    const bare = { authorization: token({ sub: '43', type: 'customer', exp: future }, 'another-key-another-key-another-key') };
    expect(() => assertOwner(bare, 43)).toThrow();
  });
  test('staff and server-side callers are unchanged', () => {
    expect(() => assertOwner(staff, 44)).not.toThrow();
    expect(() => assertOwner({ 'x-user-type': 'user', 'x-user-id': '7' }, 44)).not.toThrow();
    expect(() => assertOwner({}, 44)).not.toThrow();
    expect(() => assertOwner({ 'x-user-type': 'service' }, 44)).not.toThrow();
    expect(() => assertNotCustomer(staff)).not.toThrow();
    expect(() => assertNotCustomer(undefined)).not.toThrow();
  });
});

describe('validateLead', () => {
  test('accepts a full name and a permanent e-mail, cleans phone and CPF', () => {
    const v = validateLead({ name: '  Maria  da Silva ', email: 'maria@gmail.com', phone: '(21) 99876-5432', cpf: '', packageName: 'Pacote' });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.lead).toEqual({ name: 'Maria da Silva', email: 'maria@gmail.com', phone: '21998765432', cpf: '', packageName: 'Pacote' });
  });
  test('refuses missing names, bad or disposable e-mails, bad phone or CPF, non-string fields', () => {
    expect(validateLead({ name: 'Maria', email: 'maria@gmail.com' }).ok).toBe(false);
    expect(validateLead({ name: 'Maria Silva', email: 'not-an-email' }).ok).toBe(false);
    expect(validateLead({ name: 'Maria Silva', email: 'x@mailinator.com' }).ok).toBe(false);
    expect(validateLead({ name: 'Maria Silva', email: 'maria@gmail.com', phone: '123' }).ok).toBe(false);
    expect(validateLead({ name: 'Maria Silva', email: 'maria@gmail.com', cpf: '11111111111' }).ok).toBe(false);
    expect(validateLead({ name: { $gt: '' }, email: ['a@b.com'] }).ok).toBe(false);
    expect(validateLead(null).ok).toBe(false);
  });
});

describe('lead rate limit', () => {
  test('the limiter refuses the hit after the limit within the window', () => {
    const rl = new RateLimiter(2, 60_000);
    expect(rl.hit('1.2.3.4', 0)).toBe(0);
    expect(rl.hit('1.2.3.4', 1)).toBe(0);
    expect(rl.hit('1.2.3.4', 2)).toBeGreaterThan(0);
    expect(rl.hit('5.6.7.8', 3)).toBe(0);
  });
});
