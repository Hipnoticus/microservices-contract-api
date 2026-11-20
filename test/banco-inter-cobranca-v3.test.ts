import { describe, expect, test } from 'bun:test';
import {
  BancoInterGateway, buildCobrancaBody, COBRANCA_PATH, interError, isCobrancaPaid, parseCobranca, type InterTransport,
} from '../src/infrastructure/payment/BancoInterGateway';

// 2026-11-20: Inter retired Cobranca v2 (/cobranca/v2/boletos answers a plain "404 page not found", shown in Moses as
// {"raw":"404 page not found"}). Boletos now go through Cobranca v3 (/cobranca/v3/cobrancas, keyed by codigoSolicitacao).

const BASE = 'https://cdpj.partners.bancointer.com.br';
const COD = '6f1c1e9a-1111-2222-3333-444455556666';
const config = {
  clientId: 'id', clientSecret: 'secret', certPath: '/x.crt', keyPath: '/x.key', accountNumber: '67343171',
  pixKey: '12344385000193', scope: 'boleto-cobranca.read boleto-cobranca.write', sandbox: false,
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };
function fakeInter(routes: (c: Call, n: number) => { status: number; data: any } | undefined) {
  const calls: Call[] = [];
  const transport: InterTransport = async (url, method, headers, body) => {
    const c: Call = { url, method, headers, body: body && headers['Content-Type'] === 'application/json' ? JSON.parse(body) : body };
    if (url.endsWith('/oauth/v2/token')) return { status: 200, data: { access_token: 'tok', expires_in: 3600 } };
    calls.push(c);
    return routes(c, calls.length) || { status: 404, data: { raw: '404 page not found' } };
  };
  return { calls, gateway: new BancoInterGateway(config, { transport, sleep: async () => {} }) };
}

const issued = {
  cobranca: { codigoSolicitacao: COD, seuNumero: '5012', situacao: 'A_RECEBER', valorNominal: '2.50' },
  boleto: { nossoNumero: '00987654321', linhaDigitavel: '07790001161234567890123456789012345678901234', codigoBarras: '07791000000002500001112345678901234567890123' },
  pix: { txid: 'abcTXID', pixCopiaECola: '00020101021226...6304ABCD' },
};

describe('Cobranca v3 helpers', () => {
  test('paid only for RECEBIDO / MARCADO_RECEBIDO', () => {
    expect(isCobrancaPaid('RECEBIDO')).toBe(true);
    expect(isCobrancaPaid('marcado_recebido')).toBe(true);
    for (const s of ['A_RECEBER', 'ATRASADO', 'CANCELADO', 'EXPIRADO', 'EM_PROCESSAMENTO', 'PAGO', '', null]) expect(isCobrancaPaid(s)).toBe(false);
  });
  test('parseCobranca flattens cobranca/boleto/pix', () => {
    expect(parseCobranca(issued)).toEqual({
      codigoSolicitacao: COD, situacao: 'A_RECEBER', bankNossoNumero: '00987654321',
      linhaDigitavel: issued.boleto.linhaDigitavel, codigoBarras: issued.boleto.codigoBarras,
      pixCopiaECola: issued.pix.pixCopiaECola, txid: 'abcTXID',
    });
    expect(parseCobranca(null).situacao).toBe('');
  });
  test('body: v3 shape, R$2.50 minimum, seuNumero max 15, CNPJ is JURIDICA, no empty e-mail', () => {
    const b = buildCobrancaBody({ customerName: 'Gabriel', customerCpf: '109.625.097-79', amount: 1, dueDate: '2026-11-25', seuNumero: 'AMODE-1763640000000', customerCep: '70.308-200' });
    expect(b.valorNominal).toBe(2.5);
    expect(b.seuNumero.length).toBeLessThanOrEqual(15);
    expect(b.pagador).toMatchObject({ cpfCnpj: '10962509779', tipoPessoa: 'FISICA', cep: '70308200' });
    expect('email' in b.pagador).toBe(false);
    expect(b.dataEmissao).toBeUndefined();
    expect(buildCobrancaBody({ customerName: 'X', customerCpf: '12344385000193', amount: 19990, dueDate: '2026-11-25', seuNumero: '5012', customerEmail: 'a@b.c' }).pagador)
      .toMatchObject({ tipoPessoa: 'JURIDICA', email: 'a@b.c' });
  });
  test('interError never leaks an empty message and shows plain-text bodies', () => {
    expect(interError(404, { raw: '404 page not found' })).toBe('Banco Inter 404: 404 page not found');
    expect(interError(400, { title: 'Requisição inválida', violacoes: [{ propriedade: 'pagador.cep', razao: 'inválido' }] }))
      .toBe('Banco Inter 400: Requisição inválida - pagador.cep: inválido');
    expect(interError(500, null)).toBe('Banco Inter 500');
  });
});

describe('BancoInterGateway boleto (v3)', () => {
  test('createBoleto posts to v3, waits for issuance and returns codigoSolicitacao as the identifier', async () => {
    const { calls, gateway } = fakeInter((c, n) => {
      if (c.method === 'POST' && c.url === `${BASE}${COBRANCA_PATH}`) return { status: 200, data: { codigoSolicitacao: COD } };
      if (c.method === 'GET' && c.url === `${BASE}${COBRANCA_PATH}/${COD}`) {
        return n < 4 ? { status: 200, data: { cobranca: { codigoSolicitacao: COD, situacao: 'EM_PROCESSAMENTO' } } } : { status: 200, data: issued };
      }
    });
    const r = await gateway.createBoleto('Gabriel Veloso', '10962509779', 1, '2026-11-25', '5012', 'punkore8@gmail.com', '70308200');
    expect(r).toMatchObject({
      success: true, nossoNumero: COD, bankNossoNumero: '00987654321', linhaDigitavel: issued.boleto.linhaDigitavel,
      codigoBarras: issued.boleto.codigoBarras, pixCopiaECola: issued.pix.pixCopiaECola, pixTxid: 'abcTXID', error: null,
    });
    expect(calls[0].body).toMatchObject({ seuNumero: '5012', valorNominal: 2.5, dataVencimento: '2026-11-25' });
    expect(calls[0].headers['x-conta-corrente']).toBe('67343171');
    expect(calls.some(c => c.url.includes('/cobranca/v2/'))).toBe(false);
    expect(calls.filter(c => c.method === 'GET').length).toBe(3);
  });

  test('createBoleto reports Inter errors readably', async () => {
    const { gateway } = fakeInter(() => ({ status: 400, data: { title: 'Requisição inválida', detail: 'cep inválido' } }));
    const r = await gateway.createBoleto('X', '10962509779', 10, '2026-11-25', '1');
    expect(r.success).toBe(false);
    expect(r.error).toBe('Banco Inter 400: Requisição inválida - cep inválido');
  });

  test('createBoleto fails on FALHA_EMISSAO, succeeds without barcode while still processing', async () => {
    const failing = fakeInter((c) => c.method === 'POST' ? { status: 200, data: { codigoSolicitacao: COD } } : { status: 200, data: { cobranca: { situacao: 'FALHA_EMISSAO' } } });
    expect((await failing.gateway.createBoleto('X', '10962509779', 10, '2026-11-25', '1')).success).toBe(false);
    const slow = fakeInter((c) => c.method === 'POST' ? { status: 200, data: { codigoSolicitacao: COD } } : { status: 200, data: { cobranca: { situacao: 'EM_PROCESSAMENTO' } } });
    const r = await slow.gateway.createBoleto('X', '10962509779', 10, '2026-11-25', '1');
    expect(r).toMatchObject({ success: true, nossoNumero: COD, linhaDigitavel: null });
  });

  test('status, PDF, cancel and webhook use the v3 routes', async () => {
    const { calls, gateway } = fakeInter((c) => {
      if (c.url === `${BASE}${COBRANCA_PATH}/${COD}`) return { status: 200, data: { ...issued, cobranca: { ...issued.cobranca, situacao: 'RECEBIDO' } } };
      if (c.url === `${BASE}${COBRANCA_PATH}/${COD}/pdf`) return { status: 200, data: { pdf: 'JVBERi0x' } };
      if (c.url === `${BASE}${COBRANCA_PATH}/${COD}/cancelar`) return { status: 202, data: { raw: '' } };
      if (c.url === `${BASE}${COBRANCA_PATH}/webhook`) return { status: 204, data: { raw: '' } };
    });
    expect(await gateway.checkBoletoStatus(COD)).toEqual({ paid: true, situacao: 'RECEBIDO' });
    expect(await gateway.getBoletoPdf(COD)).toBe('JVBERi0x');
    expect(await gateway.cancelBoleto(COD, 'teste')).toEqual({ success: true });
    expect(calls.find(c => c.url.endsWith('/cancelar'))?.body).toEqual({ motivoCancelamento: 'teste' });
    expect(await gateway.registerBoletoWebhook('https://x/hook')).toEqual({ success: true });
    expect(calls.find(c => c.url.endsWith('/webhook'))).toMatchObject({ method: 'PUT', body: { webhookUrl: 'https://x/hook' } });
  });

  test('unknown charge: not paid, no PDF, webhook 404 is an error', async () => {
    const { gateway } = fakeInter(() => undefined);
    expect(await gateway.checkBoletoStatus('nope')).toEqual({ paid: false, situacao: 'UNKNOWN' });
    expect(await gateway.getBoletoPdf('nope')).toBeNull();
    expect((await gateway.registerBoletoWebhook('https://x')).success).toBe(false);
  });
});
