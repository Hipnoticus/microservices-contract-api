/**
 * Server-side rules for public checkout (incident 20261118).
 *
 * POST /orders and POST /payments/process are public so visitors can buy, which means nothing in their bodies can
 * be trusted: the price comes from tbProducts, the amount charged comes from the stored order, and the legacy test
 * price (?Teste=1, orders.transaction.test.*) applies only to a staff caller or to a customer flagged
 * tbCustomers.TestUser = 1. The Banco Inter callback is public too, so it only ever confirms an order after asking
 * Banco Inter whether that order's own charge is paid.
 */

/** Price of a package row (tbProducts): promotional price, else normal price; null when not sellable. */
export function packagePrice(row: { NormalPrice?: any; PromotionalPrice?: any; Blocked?: any } | null | undefined): number | null {
  if (!row) return null;
  if (row.Blocked === true || Number(row.Blocked) === 1) return null;
  const normal = Number(row.NormalPrice) || 0;
  const promo = Number(row.PromotionalPrice) || normal;
  return promo > 0 ? Math.round(promo * 100) / 100 : null;
}

export interface ChargeInput {
  orderTotal: number;
  method: string;
  /** ?Teste=1 / ?BoletoTeste from the request body */
  testRequested: boolean;
  /** request e-mail equals tbConfig orders.transaction.test.email */
  emailMatchesTestEmail: boolean;
  /** verified staff token on the request, or the order's customer has TestUser = 1 */
  testAllowed: boolean;
  testValue: number;
  testValueBoleto: number;
}

/** Amount to charge: the stored order total, or the test value when (and only when) testing is allowed. */
export function chargeAmount(i: ChargeInput): { amount: number; test: boolean } {
  if (i.testAllowed && (i.testRequested || i.emailMatchesTestEmail)) {
    const boletoPix = ['inter-boleto', 'pix'].includes(i.method);
    return { amount: boletoPix ? i.testValueBoleto : i.testValue, test: true };
  }
  return { amount: i.orderTotal, test: false };
}

/** Order ids a Banco Inter callback refers to (boleto seuNumero, PIX txid digits). Only candidates: never trusted. */
export function webhookOrderIds(body: any): number[] {
  const ids = new Set<number>();
  const add = (v: any) => {
    const n = parseInt(String(v ?? ''), 10);
    if (Number.isFinite(n) && n > 0) ids.add(n);
  };
  const fromTxid = (txid: any) => {
    const m = typeof txid === 'string' ? txid.match(/(\d+)/) : null;
    if (m) add(m[1]);
  };
  const items = Array.isArray(body) ? body : [body];
  for (const b of items) {
    if (!b || typeof b !== 'object') continue;
    if (b.seuNumero != null) add(b.seuNumero);
    if (b.txid) fromTxid(b.txid);
    if (Array.isArray(b.pix)) for (const p of b.pix) fromTxid(p?.txid);
  }
  return [...ids].slice(0, 20);
}

export interface WebhookDeps {
  findOrder(id: number): Promise<{ id: number; statusId: number; paymentMethodId: number; paymentIdentifier: string | null } | null>;
  checkPix(txid: string): Promise<{ paid: boolean }>;
  checkBoleto(nossoNumero: string): Promise<{ paid: boolean }>;
  confirm(orderId: number, source: string): Promise<unknown>;
}

/** PIX orders carry FormaPagamento 2 (same rule as GET /payments/status). */
export const PIX_PAYMENT_METHOD_ID = 2;

/**
 * Confirms only the orders whose own charge Banco Inter reports as paid. The payload decides which orders to look
 * at, never whether they are paid. Returns the confirmed ids.
 */
export async function confirmVerifiedOrders(body: any, deps: WebhookDeps): Promise<number[]> {
  const confirmed: number[] = [];
  for (const id of webhookOrderIds(body)) {
    const order = await deps.findOrder(id);
    if (!order || !order.paymentIdentifier || order.statusId >= 2) continue;
    const status = order.paymentMethodId === PIX_PAYMENT_METHOD_ID
      ? await deps.checkPix(order.paymentIdentifier)
      : await deps.checkBoleto(order.paymentIdentifier);
    if (status?.paid) {
      await deps.confirm(order.id, 'webhook:banco-inter:verified');
      confirmed.push(order.id);
    }
  }
  return confirmed;
}
