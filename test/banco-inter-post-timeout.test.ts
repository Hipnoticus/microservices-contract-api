import { describe, expect, test } from 'bun:test';
import { BancoInterGateway } from '../src/infrastructure/payment/BancoInterGateway';

// 2026-11-27: Inter's issuing POST timed out at 15 s while the boleto WAS created. The gateway now looks it up by
// seuNumero before reporting a failure, so a retry never issues a second boleto for the same order.

const cfg = { clientId: 'c', clientSecret: 's', certPath: '/x.crt', keyPath: '/x.key', accountNumber: '1', pixKey: 'k', scope: 's', sandbox: true };

function transport(found: boolean) {
  const calls: string[] = [];
  const t = async (url: string, method: string) => {
    calls.push(method + ' ' + url.replace(/^https:\/\/[^/]+/, '').replace(/\?.*$/, '?…'));
    if (url.endsWith('/oauth/v2/token')) return { status: 200, data: { access_token: 't', expires_in: 3600 } };
    if (method === 'POST') throw new Error('Request timeout: POST');
    if (url.includes('/cobrancas?')) {
      return { status: 200, data: { cobrancas: found ? [{ cobranca: { seuNumero: 'HO123', codigoSolicitacao: 'cod-1', situacao: 'EM_PROCESSAMENTO' } }] : [] } };
    }
    return { status: 200, data: { cobranca: { situacao: 'A_RECEBER', codigoSolicitacao: 'cod-1' }, boleto: { linhaDigitavel: 'LD' }, pix: { pixCopiaECola: 'P' } } };
  };
  return { t, calls };
}

describe('boleto POST timeout', () => {
  test('the boleto Inter created anyway is found and returned', async () => {
    const { t } = transport(true);
    const g = new BancoInterGateway(cfg, { transport: t as any, sleep: async () => {} });
    const r = await g.createBoleto('A', '10962509779', 3, '2026-11-29', 'HO123');
    expect(r.success).toBe(true);
    expect(r.nossoNumero).toBe('cod-1');
    expect(r.linhaDigitavel).toBe('LD');
  });
  test('nothing at Inter: a clear failure, no second POST', async () => {
    const { t, calls } = transport(false);
    const g = new BancoInterGateway(cfg, { transport: t as any, sleep: async () => {} });
    const r = await g.createBoleto('A', '10962509779', 3, '2026-11-29', 'HO124');
    expect(r.success).toBe(false);
    expect(calls.filter(c => c.startsWith('POST /cobranca')).length).toBe(1);
  });
});
