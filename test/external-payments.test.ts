import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { ExternalPaymentController } from '../src/interfaces/http/controllers/ExternalPaymentController';
import { merchantOrderIdFor, originOf, parseOrigins, pixTxidFor, seuNumeroFor } from '../src/application/payment/ExternalCharges';
import type { ExternalCharge, ExternalChargeStore } from '../src/application/payment/ExternalCharges';
import { PixAutomaticoOps } from '../src/application/payment/PixAutomaticoOps';

// .plans/HIPNOONLINE_CONTRACTAPI_PAYMENTS_PLAN.md: every charge carries the origin taken from the authenticated
// caller; origins are configuration; one charge per caller reference.

class MemoryStore implements ExternalChargeStore {
  rows: ExternalCharge[] = [];
  async find(origin: string, ref: string, method: string) { return this.rows.find(r => r.Origin === origin && r.ExternalRef === ref && r.Method === method) ?? null; }
  async findById(origin: string, id: number) { return this.rows.find(r => r.ID === id && r.Origin === origin) ?? null; }
  async claim(c: any) {
    if (await this.find(c.origin, c.externalRef, c.method)) return null;
    const ID = this.rows.length + 1;
    this.rows.push({ ID, Origin: c.origin, ExternalRef: c.externalRef, Method: c.method, Provider: c.provider, ProviderRef: null, SeuNumero: c.seuNumero, Amount: c.amount, Status: 'PENDING', PaidAt: null });
    return ID;
  }
  async update(id: number, f: any) {
    const r = this.rows.find(x => x.ID === id)!;
    if (f.providerRef !== undefined) r.ProviderRef = f.providerRef;
    if (f.status !== undefined) r.Status = f.status;
    if (f.paidAt !== undefined) r.PaidAt = f.paidAt;
    if (f.cardToken !== undefined) r.CardToken = f.cardToken;
  }
}

function fakeInter(opts: { fail?: boolean; situacao?: string } = {}) {
  const calls: any[] = [];
  const g: any = {
    calls,
    pixKey: '12344385000193',
    async createBoleto(name: string, cpf: string, amount: number, due: string, seuNumero: string) {
      calls.push({ op: 'create', seuNumero, amount });
      return opts.fail
        ? { success: false, nossoNumero: null, error: 'Banco Inter 400: bad' }
        : { success: true, nossoNumero: 'cod-' + calls.length, bankNossoNumero: '123', linhaDigitavel: 'LD', codigoBarras: 'CB', pixCopiaECola: 'PIX', pixTxid: 't', error: null };
    },
    async createPixCobranca(name: string, cpf: string, amount: number, orderId: string, desc: string, txid: string) {
      calls.push({ op: 'pix', txid }); return { success: true, txid, pixCopiaECola: 'PIXCC', qrCodeBase64: null, error: null };
    },
    async getBoletoDetails(cod: string) { calls.push({ op: 'details', cod }); return { cobranca: { situacao: opts.situacao ?? 'A_RECEBER', seuNumero: cod === 'legacy-cod-1' ? '7899464200' : 'X', valorNominal: 10 }, boleto: { linhaDigitavel: 'LD', nossoNumero: '123' }, pix: { pixCopiaECola: 'PIX' } }; },
    async checkBoletoStatus(cod: string) { calls.push({ op: 'status', cod }); const s = opts.situacao ?? 'A_RECEBER'; return { paid: s === 'RECEBIDO', situacao: s }; },
    async getBoletoPdf(cod: string) { calls.push({ op: 'pdf', cod }); return 'JVBERi0='; },
    async checkPixStatus() { return { paid: false, status: 'ATIVA' }; },
    async pixApi(method: string, path: string, body: any) {
      calls.push({ op: 'pixApi', method, path, body });
      if (path === '/pix/v2/rec' && method === 'POST') return { status: 201, data: { idRec: 'RR1234567820261126abcdefghij', status: 'CRIADA' } };
      return { status: 200, data: { status: 'ATIVA' } };
    },
  };
  return g;
}

function fakeCielo(status = 1) {
  const calls: any[] = [];
  return {
    calls,
    async createTransaction(orderId: string, n: string, a: number, i: number, card: any, saveCard: boolean) {
      calls.push(orderId);
      return { success: status === 1 || status === 2, paymentId: 'pay-1', tid: 'tid-1', authorizationCode: 'A1', status, statusMessage: '', returnCode: '00', returnMessage: 'ok', cardToken: saveCard ? 'cielo-token-1' : null };
    },
    async createTransactionWithToken(orderId: string, n: string, a: number, i: number, token: string) {
      calls.push(orderId + ':' + token);
      return { success: true, paymentId: 'pay-2', tid: 'tid-2', authorizationCode: 'A2', status: 2, statusMessage: '', returnCode: '00', returnMessage: 'ok' };
    },
  } as any;
}

const hipno = { internalCaller: 'hipno-online', headers: {} };
const gatewayService = { internalCaller: 'gateway', headers: { 'x-user-type': 'service' } };
const body = { method: 'boleto', amount: 10, externalRef: '7899464258', payerName: 'Teste', payerCpfCnpj: '10962509779' };
const ORIGINS = parseOrigins(undefined);

describe('origins are configuration', () => {
  test('default: Hipno Online (HO) and Amode (AM)', () => {
    expect(ORIGINS.get('hipno-online')).toEqual({ name: 'hipno-online', code: 'HO', methods: ['boleto', 'pix', 'pix_automatico'] });
    expect(ORIGINS.get('amode')!.code).toBe('AM');
  });
  test('a new app is one entry, no code change', () => {
    const o = parseOrigins('sono-perfeito=SP:pix|credit_card,kura5=K5:pix');
    expect(o.get('kura5')).toEqual({ name: 'kura5', code: 'K5', methods: ['pix'] });
    expect(originOf({ internalCaller: 'sono-perfeito', headers: {} }, { EXTERNAL_PAYMENT_ORIGINS: 'sono-perfeito=SP:pix' })!.code).toBe('SP');
  });
  test('bad entries are refused: unknown method, repeated or numeric code', () => {
    expect(() => parseOrigins('a1=AA:boleto|cash')).toThrow();
    expect(() => parseOrigins('a1=AA:boleto,b1=AA:pix')).toThrow();
    expect(() => parseOrigins('a1=12:boleto')).toThrow();
  });
});

describe('originOf', () => {
  test('an allowed direct caller is its own origin; a gateway service call is Amode', () => {
    expect(originOf(hipno, {})!.name).toBe('hipno-online');
    expect(originOf(gatewayService, {})!.name).toBe('amode');
    expect(originOf({ internalCaller: 'gateway', headers: { 'x-user-type': 'customer' } }, {})).toBeNull();
  });
  test('callers without an entry, a direct "amode" caller and anonymous calls are refused', () => {
    expect(originOf({ internalCaller: 'session-api', headers: {} }, {})).toBeNull();
    expect(originOf({ internalCaller: 'amode', headers: {} }, {})).toBeNull();
    expect(originOf({ headers: {} }, {})).toBeNull();
  });
  test('unsigned service headers count as Amode only outside enforce', () => {
    expect(originOf({ headers: { 'x-user-type': 'service' } }, { INTERNAL_AUTH_MODE: 'enforce' }, () => {})).toBeNull();
    expect(originOf({ headers: { 'x-user-type': 'service' } }, { INTERNAL_AUTH_MODE: 'report' }, () => {})!.name).toBe('amode');
  });
});

describe('references carry the origin code', () => {
  const ho = ORIGINS.get('hipno-online')!;
  test('seuNumero, at most 15 characters', () => {
    expect(seuNumeroFor(ho, '7899464258')).toBe('HO7899464258');
    expect(() => seuNumeroFor(ho, '1234567890123456')).toThrow();
  });
  test('Pix txid 26-35 letters and digits, starting with the code', () => {
    const t = pixTxidFor(ho, '7899464258');
    expect(t.startsWith('HO7899464258')).toBe(true);
    expect(/^[A-Za-z0-9]{26,35}$/.test(t)).toBe(true);
  });
  test('Cielo MerchantOrderId', () => {
    expect(merchantOrderIdFor(ho, '7899464258')).toBe('HO-7899464258');
  });
});

describe('ExternalPaymentController', () => {
  test('refuses a request without an allowed caller', async () => {
    const c = new ExternalPaymentController(null, fakeInter(), new MemoryStore());
    await expect(c.processExternal({ headers: {} }, body as any)).rejects.toThrow();
    await expect(c.checkStatus({ headers: {} }, { chargeId: 1 })).rejects.toThrow();
    await expect(c.pixAutomatico({ headers: {} }, { op: 'locrec' })).rejects.toThrow();
  });

  test('one boleto per reference, with the HO seuNumero; a failed one can be issued again', async () => {
    const inter = fakeInter(); const store = new MemoryStore();
    const c = new ExternalPaymentController(null, inter, store);
    const a = await c.processExternal(hipno, body as any);
    expect(a.success).toBe(true);
    expect(a.seuNumero).toBe('HO7899464258');
    const b = await c.processExternal(hipno, body as any);
    expect(b.transactionId).toBe(a.transactionId);
    expect(inter.calls.filter((x: any) => x.op === 'create').length).toBe(1);

    const s2 = new MemoryStore();
    expect((await new ExternalPaymentController(null, fakeInter({ fail: true }), s2).processExternal(hipno, body as any)).success).toBe(false);
    expect(s2.rows[0].Status).toBe('FAILED');
    expect((await new ExternalPaymentController(null, fakeInter(), s2).processExternal(hipno, body as any)).success).toBe(true);
    expect(s2.rows.length).toBe(1);
  });

  test('methods follow the origin: Hipno Online has no card here, Amode does', async () => {
    const c = new ExternalPaymentController(fakeCielo(), fakeInter(), new MemoryStore());
    expect((await c.processExternal(hipno, { ...body, method: 'credit_card' } as any)).success).toBe(false);
    expect((await c.processExternal(hipno, { ...body, externalRef: 'x y' } as any)).success).toBe(false);
    expect((await c.processExternal(hipno, { ...body, externalRef: undefined } as any)).success).toBe(false);
  });

  test('a card reference is charged once, with the origin in MerchantOrderId; a denied one may retry', async () => {
    const cielo = fakeCielo(1); const store = new MemoryStore();
    const c = new ExternalPaymentController(cielo, fakeInter(), store);
    const card = { number: '4111 1111 1111 1111', holder: 'T', expirationDate: '12/2030', securityCode: '123', brand: 'Visa' };
    const req = { method: 'credit_card', amount: 5, externalRef: 'SUB-1', card };
    expect((await c.processExternal(gatewayService, req as any)).status).toBe('AUTHORIZED');
    expect((await c.processExternal(gatewayService, req as any)).success).toBe(true);
    expect(cielo.calls).toEqual(['AM-SUB-1']);
    expect(store.rows[0].Origin).toBe('amode');
    const denied = new MemoryStore(); const ci2 = fakeCielo(3);
    await new ExternalPaymentController(ci2, fakeInter(), denied).processExternal(gatewayService, req as any);
    await new ExternalPaymentController(ci2, fakeInter(), denied).processExternal(gatewayService, req as any);
    expect(ci2.calls.length).toBe(2);
    expect(JSON.stringify(denied.rows)).not.toContain('4111');
  });

  test('a Pix gets our own txid with the origin code and is recorded', async () => {
    const inter = fakeInter(); const store = new MemoryStore();
    const r = await new ExternalPaymentController(null, inter, store).processExternal(hipno, { method: 'pix', amount: 3, externalRef: '7899464259' } as any);
    expect(r.transactionId!.startsWith('HO7899464259')).toBe(true);
    expect(store.rows[0].Method).toBe('pix');
  });

  test('Amode without a reference still works and is recorded as amode', async () => {
    const inter = fakeInter(); const store = new MemoryStore();
    const r = await new ExternalPaymentController(null, inter, store).processExternal(gatewayService, { method: 'boleto', amount: 5, tenantId: 't1' } as any);
    expect(r.success).toBe(true);
    expect(inter.calls[0].seuNumero.startsWith('AMT')).toBe(true);
    expect(store.rows[0].Origin).toBe('amode');
  });

  test('status updates the record and stops asking Inter once paid', async () => {
    const store = new MemoryStore();
    await new ExternalPaymentController(null, fakeInter(), store).processExternal(hipno, body as any);
    const paidInter = fakeInter({ situacao: 'RECEBIDO' });
    const c = new ExternalPaymentController(null, paidInter, store);
    expect((await c.checkStatus(hipno, { externalRef: '7899464258', method: 'boleto' })).paid).toBe(true);
    expect(store.rows[0].PaidAt).not.toBeNull();
    await c.checkStatus(hipno, { chargeId: 1 });
    expect(paidInter.calls.filter((x: any) => x.op === 'details').length).toBe(1);
  });

  test("a caller cannot read another origin's charge", async () => {
    const store = new MemoryStore();
    await new ExternalPaymentController(null, fakeInter(), store).processExternal(hipno, body as any);
    store.rows[0].Origin = 'amode';
    const c = new ExternalPaymentController(null, fakeInter(), store);
    expect((await c.checkStatus(hipno, { chargeId: 1 })).status).toBe('not_found');
    expect((await c.chargePdf(hipno, '1')).pdf).toBeNull();
  });
});

describe('Pix Automatico operations', () => {
  const ho = ORIGINS.get('hipno-online')!;
  const am = ORIGINS.get('amode')!;
  const env = { EXTERNAL_PAYMENT_LEGACY_TXIDS: 'hipno-online:HIPNO' };
  const txid = 'HOASS' + 'a'.repeat(25);

  test('new txids must carry the origin code; the Pix key is always ContractAPI\'s', async () => {
    const inter = fakeInter(); const ops = new PixAutomaticoOps(inter, new MemoryStore(), env);
    expect((await ops.run(ho, { op: 'cob.put', txid: 'HIPNOASS' + 'a'.repeat(22), payload: {} })).http).toBe(403);
    expect((await ops.run(ho, { op: 'cob.put', txid, payload: { chave: 'someone-else' } })).http).toBe(200);
    expect(inter.calls.at(-1).body.chave).toBe('12344385000193');
  });

  test('one mandate per caller reference, and only its owner may use it', async () => {
    const inter = fakeInter(); const store = new MemoryStore(); const ops = new PixAutomaticoOps(inter, store, env);
    const payload = { vinculo: { contrato: '42' }, valor: { valorRec: '29.90' }, ativacao: { dadosJornada: { txid } } };
    const a = await ops.run(ho, { op: 'rec.create', payload });
    expect(a.body.idRec).toBe('RR1234567820261126abcdefghij');
    await ops.run(ho, { op: 'rec.create', payload });
    expect(inter.calls.filter((x: any) => x.path === '/pix/v2/rec' && x.method === 'POST').length).toBe(1);
    expect((await ops.run(ho, { op: 'rec.get', idRec: a.body.idRec })).http).toBe(200);
    const amodeOps = new PixAutomaticoOps(inter, store, env);
    expect((await amodeOps.run(am, { op: 'rec.get', idRec: a.body.idRec })).http).toBe(403);
    expect((await amodeOps.run(am, { op: 'cobr.put', txid: 'AM' + 'b'.repeat(28), payload: { idRec: a.body.idRec } })).http).toBe(403);
    expect((await ops.run(ho, { op: 'cobr.put', txid: 'HOCOB' + 'c'.repeat(25), payload: { idRec: a.body.idRec } })).http).toBe(200);
  });

  test('older Hipno Online mandates and HIPNO txids can still be read (and are recorded)', async () => {
    const store = new MemoryStore(); const ops = new PixAutomaticoOps(fakeInter(), store, env);
    expect((await ops.run(ho, { op: 'cobr.get', txid: 'HIPNOCOB' + 'd'.repeat(22) })).http).toBe(200);
    expect((await ops.run(ho, { op: 'rec.get', idRec: 'RR9999999920260101oldmandate' })).http).toBe(200);
    expect(store.rows.some(r => r.ProviderRef === 'RR9999999920260101oldmandate' && r.Origin === 'hipno-online')).toBe(true);
    expect((await new PixAutomaticoOps(fakeInter(), new MemoryStore(), env).run(am, { op: 'rec.get', idRec: 'RR9999999920260101oldmandate' })).http).toBe(403);
  });

  test('unknown operations are refused', async () => {
    expect((await new PixAutomaticoOps(fakeInter(), new MemoryStore(), env).run(ho, { op: 'webhook.put' })).http).toBe(400);
  });
});

describe('cards: always captured, Cielo token stored as provided', () => {
  test('saveCard stores the CardToken; a later charge by token works and is PAID', async () => {
    const cielo = fakeCielo(2); const store = new MemoryStore();
    const c = new ExternalPaymentController(cielo, fakeInter(), store);
    const a = await c.processExternal(gatewayService, { method: 'credit_card', amount: 9, externalRef: 'S1', card: { number: '4111111111111111', holder: 'T', expirationDate: '12/2030', securityCode: '123', brand: 'Visa', saveCard: true } } as any);
    expect(a.status).toBe('PAID');
    expect(a.cardToken).toBe('cielo-token-1');
    expect(store.rows[0].CardToken).toBe('cielo-token-1');
    expect(store.rows[0].PaidAt).not.toBeNull();
    const b = await c.processExternal(gatewayService, { method: 'credit_card', amount: 9, externalRef: 'S2', card: { token: 'cielo-token-1', securityCode: '123', brand: 'Visa' } } as any);
    expect(b.status).toBe('PAID');
    expect(cielo.calls).toEqual(['AM-S1', 'AM-S2:cielo-token-1']);
  });
});
describe('boletos issued before ContractAPI', () => {
  test('adopted only when Inter shows the caller reference as seuNumero', async () => {
    const store = new MemoryStore(); const c = new ExternalPaymentController(null, fakeInter(), store);
    const ok = await c.checkStatus(hipno, { externalRef: '7899464200', method: 'boleto', codigoSolicitacao: 'legacy-cod-1' });
    expect(ok.status).toBe('A_RECEBER');
    expect(store.rows[0].ProviderRef).toBe('legacy-cod-1');
    const other = await c.checkStatus(hipno, { externalRef: '7899464201', method: 'boleto', codigoSolicitacao: 'someone-elses' });
    expect(other.status).toBe('not_found');
  });
});