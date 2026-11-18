import { describe, expect, test } from 'bun:test';
import { chargeAmount, confirmVerifiedOrders, packagePrice, webhookOrderIds } from '../src/application/payment/PaymentPolicy';

// Incident 20261118: public checkout and the public Banco Inter callback must not trust their request bodies.

describe('packagePrice (tbProducts)', () => {
  test('promotional price, else normal price', () => {
    expect(packagePrice({ NormalPrice: '2400.0000', PromotionalPrice: '1990.0000', Blocked: 0 })).toBe(1990);
    expect(packagePrice({ NormalPrice: 2400, PromotionalPrice: null, Blocked: false })).toBe(2400);
  });
  test('missing, blocked or free packages cannot be sold', () => {
    expect(packagePrice(null)).toBeNull();
    expect(packagePrice(undefined)).toBeNull();
    expect(packagePrice({ NormalPrice: 2400, PromotionalPrice: 1990, Blocked: 1 })).toBeNull();
    expect(packagePrice({ NormalPrice: 2400, PromotionalPrice: 1990, Blocked: true })).toBeNull();
    expect(packagePrice({ NormalPrice: 0, PromotionalPrice: 0, Blocked: 0 })).toBeNull();
  });
});

describe('chargeAmount', () => {
  const base = { orderTotal: 19990, method: 'pix', testRequested: false, emailMatchesTestEmail: false, testAllowed: false, testValue: 0.01, testValueBoleto: 1 };
  test('charges the stored order total by default', () => {
    expect(chargeAmount(base)).toEqual({ amount: 19990, test: false });
  });
  test('an anonymous ?Teste=1 or the known test e-mail does not unlock the test price', () => {
    expect(chargeAmount({ ...base, testRequested: true })).toEqual({ amount: 19990, test: false });
    expect(chargeAmount({ ...base, emailMatchesTestEmail: true })).toEqual({ amount: 19990, test: false });
  });
  test('staff or TestUser customers keep the legacy test values', () => {
    expect(chargeAmount({ ...base, testAllowed: true, testRequested: true })).toEqual({ amount: 1, test: true });
    expect(chargeAmount({ ...base, method: 'cc-cielo', testAllowed: true, emailMatchesTestEmail: true })).toEqual({ amount: 0.01, test: true });
    expect(chargeAmount({ ...base, testAllowed: true })).toEqual({ amount: 19990, test: false });
  });
});

describe('webhookOrderIds', () => {
  test('reads boleto seuNumero and PIX txid digits, ignores junk', () => {
    expect(webhookOrderIds({ seuNumero: '5009' })).toEqual([5009]);
    expect(webhookOrderIds({ pix: [{ txid: 'PED5010' }, { txid: 'x' }] })).toEqual([5010]);
    expect(webhookOrderIds([{ seuNumero: '7' }, { txid: 'static-8' }])).toEqual([7, 8]);
    expect(webhookOrderIds(null)).toEqual([]);
    expect(webhookOrderIds({ seuNumero: '-3' })).toEqual([]);
  });
});

describe('confirmVerifiedOrders', () => {
  const orders: Record<number, any> = {
    5009: { id: 5009, statusId: 1, paymentMethodId: 2, paymentIdentifier: 'txid-5009' },
    6000: { id: 6000, statusId: 1, paymentMethodId: 3, paymentIdentifier: 'nn-6000' },
    7000: { id: 7000, statusId: 2, paymentMethodId: 2, paymentIdentifier: 'txid-7000' },
    8000: { id: 8000, statusId: 1, paymentMethodId: 2, paymentIdentifier: null },
  };
  function deps(paid: Set<string>) {
    const confirmed: number[] = [];
    const asked: string[] = [];
    return {
      confirmed, asked,
      findOrder: async (id: number) => orders[id] ?? null,
      checkPix: async (t: string) => { asked.push(`pix:${t}`); return { paid: paid.has(t) }; },
      checkBoleto: async (n: string) => { asked.push(`boleto:${n}`); return { paid: paid.has(n) }; },
      confirm: async (id: number) => { confirmed.push(id); return true; },
    };
  }

  test('a forged "paid" callback confirms nothing when Banco Inter says unpaid', async () => {
    const d = deps(new Set());
    const out = await confirmVerifiedOrders({ txid: '5009', endToEndId: 'E123', situacao: 'PAGO', valor: '19990.00' }, d);
    expect(out).toEqual([]);
    expect(d.confirmed).toEqual([]);
    expect(d.asked).toEqual(['pix:txid-5009']);
  });

  test('confirms when the order\'s own charge is paid (PIX via txid, boleto via nossoNumero)', async () => {
    const d = deps(new Set(['txid-5009', 'nn-6000']));
    expect(await confirmVerifiedOrders({ txid: 'PED5009' }, d)).toEqual([5009]);
    expect(await confirmVerifiedOrders({ seuNumero: '6000', situacao: 'PAGO' }, d)).toEqual([6000]);
    expect(d.asked).toEqual(['pix:txid-5009', 'boleto:nn-6000']);
  });

  test('skips unknown, already paid and charge-less orders without asking the bank', async () => {
    const d = deps(new Set(['txid-7000']));
    expect(await confirmVerifiedOrders([{ seuNumero: '1' }, { seuNumero: '7000' }, { seuNumero: '8000' }], d)).toEqual([]);
    expect(d.asked).toEqual([]);
  });
});
