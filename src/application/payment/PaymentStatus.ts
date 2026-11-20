/**
 * Payment status of one order for the public GET /payments/status/:orderId and GET /payments/stream/:orderId.
 *
 * Answers only paid / pending / not_found. A pending Banco Inter order (PIX or boleto with its PIX, "bolepix") is
 * checked live with Banco Inter at most once per `minIntervalMs` per order, so the page's polling alone confirms a
 * payment within seconds even when the webhook is late. The answer is always Banco Inter's, never the caller's.
 */

/** tbOrders.FormaPagamento for Banco Inter PIX. */
export const INTER_PIX_METHOD_ID = 2;
/** tbOrders.FormaPagamento for Banco Inter boleto (Cobrança v3 bolepix, Identifier = codigoSolicitacao). */
export const INTER_BOLETO_METHOD_ID = 4;

export interface StatusOrder {
  id: number;
  statusId: number;
  paymentMethodId: number;
  paymentIdentifier: string | null;
}

export interface StatusDeps {
  findOrder(id: number): Promise<StatusOrder | null>;
  /** Null when Banco Inter is not configured. */
  checkPix: ((txid: string) => Promise<{ paid: boolean; status?: string }>) | null;
  checkBoleto: ((codigoSolicitacao: string) => Promise<{ paid: boolean; situacao?: string }>) | null;
  confirm(orderId: number, source: string): Promise<unknown>;
}

export interface PaymentStatusAnswer {
  orderId: number;
  status: 'paid' | 'pending' | 'not_found';
  statusId?: number;
  paid: boolean;
}

export function isLiveCheckable(o: StatusOrder): boolean {
  const ident = o.paymentIdentifier || '';
  if (!ident || ident.startsWith('TEST-') || ident.startsWith('static-')) return false;
  return o.paymentMethodId === INTER_PIX_METHOD_ID || o.paymentMethodId === INTER_BOLETO_METHOD_ID;
}

export class PaymentStatusChecker {
  private lastCheck = new Map<number, number>();
  private inflight = new Map<number, Promise<boolean>>();

  constructor(
    private readonly deps: StatusDeps,
    private readonly minIntervalMs = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async status(orderId: number): Promise<PaymentStatusAnswer> {
    if (!Number.isInteger(orderId) || orderId <= 0 || orderId > 2_147_483_647) {
      return { orderId, status: 'not_found', paid: false };
    }
    const order = await this.deps.findOrder(orderId);
    if (!order) return { orderId, status: 'not_found', paid: false };
    if (order.statusId >= 2) return { orderId, status: 'paid', statusId: order.statusId, paid: true };

    if (isLiveCheckable(order) && (await this.liveCheck(order))) {
      return { orderId, status: 'paid', statusId: 2, paid: true };
    }
    return { orderId, status: 'pending', statusId: order.statusId, paid: false };
  }

  /** Throttled, de-duplicated Banco Inter check; confirms the order when the bank reports its own charge paid. */
  private liveCheck(order: StatusOrder): Promise<boolean> {
    const running = this.inflight.get(order.id);
    if (running) return running;
    const t = this.now();
    const last = this.lastCheck.get(order.id);
    if (last != null && t - last < this.minIntervalMs) return Promise.resolve(false);
    this.lastCheck.set(order.id, t);
    this.prune(t);

    const p = (async () => {
      try {
        const ident = order.paymentIdentifier!;
        if (order.paymentMethodId === INTER_PIX_METHOD_ID) {
          if (!this.deps.checkPix) return false;
          const s = await this.deps.checkPix(ident);
          if (!s?.paid) return false;
          await this.deps.confirm(order.id, `realtime:pix:${s.status || 'CONCLUIDA'}`);
          return true;
        }
        if (!this.deps.checkBoleto) return false;
        const s = await this.deps.checkBoleto(ident);
        if (!s?.paid) return false;
        await this.deps.confirm(order.id, `realtime:boleto:${s.situacao || 'RECEBIDO'}`);
        return true;
      } catch {
        return false;
      } finally {
        this.inflight.delete(order.id);
      }
    })();
    this.inflight.set(order.id, p);
    return p;
  }

  private prune(t: number): void {
    if (this.lastCheck.size < 1000) return;
    for (const [id, at] of this.lastCheck) if (t - at > 5 * this.minIntervalMs) this.lastCheck.delete(id);
  }
}
