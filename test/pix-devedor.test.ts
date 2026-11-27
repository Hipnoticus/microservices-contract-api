import { describe, expect, test } from 'bun:test';
import { pixDevedor, pixExpiresAt } from '../src/infrastructure/payment/BancoInterGateway';

// An immediate Pix names its payer by CPF or CNPJ, or goes without one; a made-up CPF is refused by Inter.
describe('pixDevedor', () => {
  test('CPF and CNPJ by length, digits only', () => {
    expect(pixDevedor('Gabriel Veloso', '109.625.097-79')).toEqual({ devedor: { cpf: '10962509779', nome: 'Gabriel Veloso' } });
    expect(pixDevedor('Hipnoticus', '12.344.385/0001-93')).toEqual({ devedor: { cnpj: '12344385000193', nome: 'Hipnoticus' } });
  });
  test('no devedor without a usable document or name', () => {
    expect(pixDevedor('Amode Client', '00000000000')).toEqual({});
    expect(pixDevedor('Someone', '')).toEqual({});
    expect(pixDevedor('Someone', '123')).toEqual({});
    expect(pixDevedor('', '10962509779')).toEqual({});
  });
});

describe('pixExpiresAt', () => {
  test('criacao + expiracao, null when Inter did not say', () => {
    expect(pixExpiresAt({ calendario: { criacao: '2026-11-27T12:00:00Z', expiracao: 3600 } })!.toISOString()).toBe('2026-11-27T13:00:00.000Z');
    expect(pixExpiresAt({})).toBeNull();
  });
});
