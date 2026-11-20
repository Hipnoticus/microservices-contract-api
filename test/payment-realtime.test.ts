import { describe, expect, test } from 'bun:test';
import { confirmVerifiedOrders, webhookIdentifiers, webhookOrderIds } from '../src/application/payment/PaymentPolicy';
import { PaymentStatusChecker } from '../src/application/payment/PaymentStatus';
import { PaymentEvents } from '../src/application/payment/PaymentEvents';
import { ConfirmPaymentUseCase } from '../src/application/use-cases/ConfirmPaymentUseCase';
import { DEFAULT_WEBHOOK_URL } from '../src/infrastructure/payment/BancoInterGateway';

// Real Cobranca v3 callback for production order 5013 (bolepix paid through its PIX, 2026-11-20), read back from
// GET /cobranca/v3/cobrancas/webhook/callbacks. Inter sent it to moses.hipnoticus.com.br, which answered 405.
const RECEBIDO_5013 = [{
  codigoSolicitacao: '2499728f-1826-43a4-8b15-3320f935fdb9', seuNumero: '5013', situacao: 'RECEBIDO',
  dataHoraSituacao: '2026-11-20T13:57:51.301Z', valorTotalRecebido: '2.50', origemRecebimento: 'PIX',
  nossoNumero: '90932796629', codigoBarras: '07792163900000002500001112014426690932796629',
  linhaDigitavel: '07790001161201442669109327966298216390000000250', txid: '673431711795172150000brDexnjfkHzP79',
  pixCopiaECola: '00020101021226980014BR.GOV.BCB.PIX2576spi-qrcode.bancointer.com.br/spi/pj/v2/cobv/ecab052ca6e641348162b0f114ba041752040000530398654042.505802BR5901*6008BRASILIA61087067307962070503***630438DC',
}];
const A_RECEBER_5013 = [{ ...RECEBIDO_5013[0], situacao: 'A_RECEBER', valorTotalRecebido: undefined, origemRecebimento: undefined }];
// PIX callback (BCB API Pix shape, as Inter posts to {webhookUrl}/pix) for the same bolepix's PIX.
const PIX_5013 = { pix: [{ endToEndId: 'E18236120202611201357s0000000000', txid: '673431711795172150000brDexnjfkHzP79', valor: '2.50', horario: '2026-11-20T13:57:51.000Z', infoPagador: '' }] };

const CODIGO = '2499728f-1826-43a4-8b15-3320f935fdb9';

function world(paid: Set<string>) {
  const orders: Record<number, any> = {
    5013: { id: 5013, statusId: 1, paymentMethodId: 4, paymentIdentifier: CODIGO },
    5014: { id: 5014, statusId: 1, paymentMethodId: 2, paymentIdentifier: 'txidpix5014abc' },
  };
  const asked: string[] = [];
  const confirmed: number[] = [];
  return {
    orders, asked, confirmed,
    deps: {
      findOrder: async (id: number) => orders[id] ?? null,
      findOrderByIdentifier: async (ident: string) => Object.values(orders).find((o: any) => o.paymentIdentifier === ident) ?? null,
      recentPendingBoletoOrderIds: async () => Object.values(orders).filter((o: any) => o.statusId === 1 && o.paymentMethodId === 4).map((o: any) => o.id),
      checkPix: async (t: string) => { asked.push(`pix:${t}`); return { paid: paid.has(t) }; },
      checkBoleto: async (c: string) => { asked.push(`boleto:${c}`); return { paid: paid.has(c) }; },
      confirm: async (id: number) => { confirmed.push(id); orders[id].statusId = 2; return true; },
    },
  };
}

describe('Banco Inter callbacks with real payload shapes', () => {
  test('the bolepix txid is not read as an order id (it used to become a 21-digit "order")', () => {
    expect(webhookOrderIds(RECEBIDO_5013)).toEqual([5013]);
    expect(webhookOrderIds(PIX_5013)).toEqual([]);
    expect(webhookIdentifiers(RECEBIDO_5013)).toEqual({ codigos: [CODIGO], pixTxids: [] });
    expect(webhookIdentifiers(PIX_5013)).toEqual({ codigos: [], pixTxids: ['673431711795172150000brDexnjfkHzP79'] });
  });

  test('Cobranca v3 RECEBIDO confirms order 5013 after Inter confirms its codigoSolicitacao', async () => {
    const w = world(new Set([CODIGO]));
    expect(await confirmVerifiedOrders(RECEBIDO_5013, w.deps)).toEqual([5013]);
    expect(w.asked).toEqual([`boleto:${CODIGO}`]);
  });

  test('the issuance callback (A_RECEBER) costs no bank call and confirms nothing', async () => {
    const w = world(new Set([CODIGO]));
    expect(await confirmVerifiedOrders(A_RECEBER_5013, w.deps)).toEqual([]);
    expect(w.asked).toEqual([]);
  });

  test('a forged RECEBIDO confirms nothing while Inter says the charge is open', async () => {
    const w = world(new Set());
    expect(await confirmVerifiedOrders(RECEBIDO_5013, w.deps)).toEqual([]);
    expect(w.confirmed).toEqual([]);
  });

  test('a PIX callback for a bolepix checks the recent pending boletos and confirms the paid one', async () => {
    const w = world(new Set([CODIGO]));
    expect(await confirmVerifiedOrders(PIX_5013, w.deps)).toEqual([5013]);
    expect(w.asked).toEqual([`boleto:${CODIGO}`]);
  });

  test('a PIX callback for a standalone PIX order finds it by txid (tbOrders.Identifier)', async () => {
    const w = world(new Set(['txidpix5014abc']));
    expect(await confirmVerifiedOrders({ pix: [{ txid: 'txidpix5014abc', endToEndId: 'E1', valor: '2.50' }] }, w.deps)).toEqual([5014]);
    expect(w.asked).toEqual(['pix:txidpix5014abc']);
  });

  test('a lookup that throws does not stop the other orders of the callback', async () => {
    const w = world(new Set([CODIGO]));
    const deps = { ...w.deps, findOrder: async (id: number) => { if (id === 13010) throw new Error('db'); return w.orders[id] ?? null; } };
    expect(await confirmVerifiedOrders([{ seuNumero: '13010', situacao: 'RECEBIDO' }, ...RECEBIDO_5013], deps)).toEqual([5013]);
  });

  test('the default callback URL is the API host, not the Moses host', () => {
    expect(DEFAULT_WEBHOOK_URL).toBe('https://api.hipnoticus.com.br/contract-service/payments/webhook/banco-inter');
  });
});

describe('PaymentStatusChecker (GET /payments/status and the stream)', () => {
  function checker(paid: Set<string>, method = 4) {
    let t = 1_000_000;
    const w = world(paid);
    w.orders[5013].paymentMethodId = method;
    if (method === 2) w.orders[5013].paymentIdentifier = 'txid-5013';
    const c = new PaymentStatusChecker({ ...w.deps }, 10_000, () => t);
    return { w, c, advance: (ms: number) => { t += ms; } };
  }

  test('a pending boleto (bolepix) is checked live with Inter and confirmed', async () => {
    const { w, c } = checker(new Set([CODIGO]));
    expect(await c.status(5013)).toEqual({ orderId: 5013, status: 'paid', statusId: 2, paid: true });
    expect(w.asked).toEqual([`boleto:${CODIGO}`]);
    expect(w.confirmed).toEqual([5013]);
  });

  test('pending PIX orders are checked by txid', async () => {
    const { w, c } = checker(new Set(['txid-5013']), 2);
    expect((await c.status(5013)).paid).toBe(true);
    expect(w.asked).toEqual(['pix:txid-5013']);
  });

  test('Inter is asked at most once per 10 s per order; the DB is read every time', async () => {
    const paid = new Set<string>();
    const { w, c, advance } = checker(paid);
    expect((await c.status(5013)).status).toBe('pending');
    advance(3000);
    expect((await c.status(5013)).status).toBe('pending');
    expect(w.asked.length).toBe(1);
    paid.add(CODIGO);
    advance(7001);
    expect((await c.status(5013)).status).toBe('paid');
    expect(w.asked.length).toBe(2);
  });

  test('card orders and unknown ids are not sent to Inter', async () => {
    const { w, c } = checker(new Set([CODIGO]), 1);
    expect((await c.status(5013)).status).toBe('pending');
    expect((await c.status(999)).status).toBe('not_found');
    expect((await c.status(NaN)).status).toBe('not_found');
    expect(w.asked).toEqual([]);
  });
});

describe('PaymentEvents and ConfirmPaymentUseCase', () => {
  test('listeners get the paid event of their own order only, and unsubscribe', () => {
    const ev = new PaymentEvents();
    const got: number[] = [];
    const off = ev.onPaid(5013, (e) => got.push(e.orderId));
    ev.emitPaid(5012, 'x');
    ev.emitPaid(5013, 'x');
    off();
    ev.emitPaid(5013, 'x');
    expect(got).toEqual([5013]);
    expect(ev.listenerCount()).toBe(0);
  });

  test('concurrent confirmations of one order run once (webhook + polling + live check)', async () => {
    let status = 1;
    let updates = 0;
    const repo: any = {
      findById: async (id: number) => ({ id, statusId: status }),
      updateStatus: async () => { updates++; await new Promise((r) => setTimeout(r, 20)); status = 2; },
    };
    const sessions: any = { confirmSessions: async () => true, execute: async () => true };
    const uc = new ConfirmPaymentUseCase(repo, null, null, sessions);
    const out = await Promise.all([uc.execute(5013, 'webhook'), uc.execute(5013, 'polling'), uc.execute(5013, 'realtime')]);
    expect(out).toEqual([true, true, true]);
    expect(updates).toBe(1);
  });
});
