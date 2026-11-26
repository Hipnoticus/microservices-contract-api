import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { ExternalPaymentController } from '../src/interfaces/http/controllers/ExternalPaymentController';
import { ORIGINS, originOf, seuNumeroFor } from '../src/application/payment/ExternalCharges';
import type { ExternalCharge, ExternalChargeStore } from '../src/application/payment/ExternalCharges';

// .plans/HIPNOONLINE_CONTRACTAPI_PAYMENTS_PLAN.md: origin from the authenticated caller, one boleto per order reference.

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
  }
}

function fakeInter(opts: { fail?: boolean; situacao?: string } = {}) {
  const calls: any[] = [];
  const g: any = {
    calls,
    async createBoleto(name: string, cpf: string, amount: number, due: string, seuNumero: string) {
      calls.push({ op: 'create', seuNumero, amount });
      return opts.fail
        ? { success: false, nossoNumero: null, error: 'Banco Inter 400: bad' }
        : { success: true, nossoNumero: 'cod-' + calls.length, bankNossoNumero: '123', linhaDigitavel: 'LD', codigoBarras: 'CB', pixCopiaECola: 'PIX', pixTxid: 't', error: null };
    },
    async getBoletoDetails(cod: string) { calls.push({ op: 'details', cod }); return { cobranca: { situacao: 'A_RECEBER' }, boleto: { linhaDigitavel: 'LD', nossoNumero: '123' }, pix: { pixCopiaECola: 'PIX' } }; },
    async checkBoletoStatus(cod: string) { calls.push({ op: 'status', cod }); const s = opts.situacao ?? 'A_RECEBER'; return { paid: s === 'RECEBIDO', situacao: s }; },
    async getBoletoPdf(cod: string) { calls.push({ op: 'pdf', cod }); return 'JVBERi0='; },
    async checkPixStatus() { return { paid: false, status: 'ATIVA' }; },
  };
  return g;
}

const hipno = { internalCaller: 'hipno-online', headers: {} };
const body = { method: 'boleto', amount: 10, externalRef: '7899464258', payerName: 'Teste', payerCpfCnpj: '10962509779' };

describe('originOf', () => {
  test('an allowed direct caller is its own origin', () => {
    expect(originOf(hipno, {})).toEqual(ORIGINS['hipno-online']);
  });
  test('a gateway-signed service call is Amode; a gateway call without service is refused', () => {
    expect(originOf({ internalCaller: 'gateway', headers: { 'x-user-type': 'service' } }, {})).toEqual(ORIGINS.amode);
    expect(originOf({ internalCaller: 'gateway', headers: { 'x-user-type': 'customer' } }, {})).toBeNull();
  });
  test('a caller not in EXTERNAL_PAYMENT_CALLERS and anonymous calls are refused', () => {
    expect(originOf({ internalCaller: 'session-api', headers: {} }, {})).toBeNull();
    expect(originOf({ internalCaller: 'hipno-online', headers: {} }, { EXTERNAL_PAYMENT_CALLERS: 'amode' })).toBeNull();
    expect(originOf({ headers: {} }, {})).toBeNull();
  });
  test('the body cannot choose the origin, and unsigned service headers count only outside enforce', () => {
    expect(originOf({ headers: { 'x-user-type': 'service' } }, { INTERNAL_AUTH_MODE: 'enforce' }, () => {})).toBeNull();
    expect(originOf({ headers: { 'x-user-type': 'service' } }, { INTERNAL_AUTH_MODE: 'report' }, () => {})).toEqual(ORIGINS.amode);
  });
});

describe('seuNumeroFor', () => {
  test('origin code + reference, at most 15 characters', () => {
    expect(seuNumeroFor(ORIGINS['hipno-online'], '7899464258')).toBe('HO7899464258');
    expect(seuNumeroFor(ORIGINS['hipno-online'], '78-99')).toBe('HO7899');
    expect(() => seuNumeroFor(ORIGINS['hipno-online'], '1234567890123456')).toThrow();
  });
});

describe('ExternalPaymentController for Hipno Online', () => {
  test('refuses a request without an allowed caller', async () => {
    const c = new ExternalPaymentController(null, fakeInter(), new MemoryStore());
    await expect(c.processExternal({ headers: {} }, body as any)).rejects.toThrow();
    await expect(c.checkStatus({ headers: {} }, { chargeId: 1 })).rejects.toThrow();
  });

  test('issues one boleto per order reference, with the HO seuNumero', async () => {
    const inter = fakeInter(); const store = new MemoryStore();
    const c = new ExternalPaymentController(null, inter, store);
    const a = await c.processExternal(hipno, body as any);
    expect(a.success).toBe(true);
    expect(a.seuNumero).toBe('HO7899464258');
    expect(a.chargeId).toBe(1);
    const b = await c.processExternal(hipno, body as any);
    expect(b.success).toBe(true);
    expect(b.transactionId).toBe(a.transactionId);
    expect(inter.calls.filter((x: any) => x.op === 'create').length).toBe(1);
  });

  test('a failed boleto can be tried again under the same record', async () => {
    const store = new MemoryStore();
    const a = await new ExternalPaymentController(null, fakeInter({ fail: true }), store).processExternal(hipno, body as any);
    expect(a.success).toBe(false);
    expect(store.rows[0].Status).toBe('FAILED');
    const b = await new ExternalPaymentController(null, fakeInter(), store).processExternal(hipno, body as any);
    expect(b.success).toBe(true);
    expect(store.rows.length).toBe(1);
  });

  test('only boleto, and only with a valid reference', async () => {
    const c = new ExternalPaymentController(null, fakeInter(), new MemoryStore());
    expect((await c.processExternal(hipno, { ...body, method: 'credit_card' } as any)).success).toBe(false);
    expect((await c.processExternal(hipno, { ...body, externalRef: 'x y' } as any)).success).toBe(false);
    expect((await c.processExternal(hipno, { ...body, externalRef: undefined } as any)).success).toBe(false);
  });

  test('status updates the record and stops asking Inter once paid', async () => {
    const store = new MemoryStore();
    await new ExternalPaymentController(null, fakeInter(), store).processExternal(hipno, body as any);
    const paidInter = fakeInter({ situacao: 'RECEBIDO' });
    const c = new ExternalPaymentController(null, paidInter, store);
    const s = await c.checkStatus(hipno, { externalRef: '7899464258', method: 'boleto' });
    expect(s.paid).toBe(true);
    expect(store.rows[0].Status).toBe('RECEBIDO');
    expect(store.rows[0].PaidAt).not.toBeNull();
    await c.checkStatus(hipno, { chargeId: 1 });
    expect(paidInter.calls.filter((x: any) => x.op === 'status').length).toBe(1);
  });

  test("a caller cannot read another origin's charge", async () => {
    const store = new MemoryStore();
    await new ExternalPaymentController(null, fakeInter(), store).processExternal(hipno, body as any);
    store.rows[0].Origin = 'amode';
    const c = new ExternalPaymentController(null, fakeInter(), store);
    expect((await c.checkStatus(hipno, { chargeId: 1 })).status).toBe('not_found');
    expect((await c.chargePdf(hipno, '1')).pdf).toBeNull();
  });

  test('PDF of its own boleto', async () => {
    const store = new MemoryStore();
    const c = new ExternalPaymentController(null, fakeInter(), store);
    await c.processExternal(hipno, body as any);
    expect((await c.chargePdf(hipno, '1')).pdf).toBe('JVBERi0=');
  });
});

describe('ExternalPaymentController for Amode (unchanged)', () => {
  test('a gateway service call still issues an AM boleto without a reference', async () => {
    const inter = fakeInter();
    const c = new ExternalPaymentController(null, inter, new MemoryStore());
    const r = await c.processExternal({ internalCaller: 'gateway', headers: { 'x-user-type': 'service' } }, { method: 'boleto', amount: 5, tenantId: 't1' } as any);
    expect(r.success).toBe(true);
    expect(inter.calls[0].seuNumero.startsWith('AM')).toBe(true);
  });
});
