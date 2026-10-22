import { describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { verifyStaffToken } from '../src/interfaces/http/auth/StaffAuth';
import { addDaysWallClock, renumberNotes, wallClock } from '../src/application/admin/SessionAdminService';

const KEY = 'test-secret-test-secret-test-secret-42';
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(payload: any, key = KEY, alg = 'HS256') {
  const h = b64({ alg, typ: 'JWT' });
  const p = b64(payload);
  const s = createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
  return `Bearer ${h}.${p}.${s}`;
}
const future = Math.floor(Date.now() / 1000) + 3600;

describe('verifyStaffToken', () => {
  test('accepts a UserAPI staff token and reads perms', () => {
    const u = verifyStaffToken(token({ sub: '7', type: 'user', name: 'Ana', perms: [6, 7], exp: future }), KEY);
    expect(u?.id).toBe(7);
    expect(u?.perms).toEqual([6, 7]);
  });
  test('rejects customer tokens, other keys, expired and alg tricks', () => {
    expect(verifyStaffToken(token({ sub: '43', type: 'customer', exp: future }), KEY)).toBeNull();
    expect(verifyStaffToken(token({ sub: '7', type: 'user', exp: future }, 'another-secret-another-secret-42xx'), KEY)).toBeNull();
    expect(verifyStaffToken(token({ sub: '7', type: 'user', exp: 1 }), KEY)).toBeNull();
    expect(verifyStaffToken(token({ sub: '7', type: 'user', exp: future }, KEY, 'none'), KEY)).toBeNull();
    expect(verifyStaffToken(undefined, KEY)).toBeNull();
    expect(verifyStaffToken('Basic YWRtaW46YWRtaW4=', KEY)).toBeNull();
  });
});

describe('agenda helpers', () => {
  test('wall clock dates never pass through a time zone', () => {
    expect(wallClock('2026-10-22T14:00', 'x')).toBe('2026-10-22T14:00:00');
    expect(addDaysWallClock('2026-10-29T14:00:00', 7)).toBe('2026-11-05T14:00:00');
    expect(addDaysWallClock('2026-12-31T09:30:00', 7)).toBe('2027-01-07T09:30:00');
    expect(() => wallClock('22/10/2026 14:00', 'x')).toThrow();
  });
  test('package notes are renumbered like ControleWeb, without touching other digits', () => {
    expect(renumberNotes('1ª Sessão do pacote de 10', 3)).toBe('3ª Sessão do pacote de 10');
    expect(renumberNotes('Sessão 1a - sala 12', 2)).toBe('Sessão 2a - sala 12');
    expect(renumberNotes('1ª Sessão', 1)).toBe('1ª Sessão');
  });
});
