/**
 * What the visitor actually sent, kept per order so the internal "Nova contratação" e-mail can list it
 * ("Dados enviados") with the client IP. The order is created by POST /orders and the e-mail goes out from
 * POST /payments/process, a second request, so the first one is remembered here. tbOrders has no IP column;
 * this lives in memory for SUBMISSION_TTL_MS (a restart in between loses only the order part of the list).
 */
export interface Submission {
  ip: string;
  userAgent: string;
  at: Date;
  body: unknown;
}

export interface OrderSubmission {
  order?: Submission;
  payment?: Submission;
}

const SUBMISSION_TTL_MS = 48 * 60 * 60 * 1000;
const MAX_ORDERS = 5000;

export class OrderSubmissionStore {
  private readonly items = new Map<number, OrderSubmission & { expires: number }>();

  recordOrder(orderId: number, s: Submission): void { this.put(orderId, { order: s }); }
  recordPayment(orderId: number, s: Submission): void { this.put(orderId, { payment: s }); }

  get(orderId: number, now = Date.now()): OrderSubmission {
    const v = this.items.get(orderId);
    if (!v || v.expires < now) return {};
    return { order: v.order, payment: v.payment };
  }

  private put(orderId: number, part: OrderSubmission, now = Date.now()): void {
    if (!(orderId > 0)) return;
    if (this.items.size >= MAX_ORDERS && !this.items.has(orderId)) {
      for (const [k, v] of this.items) if (v.expires < now) this.items.delete(k);
      while (this.items.size >= MAX_ORDERS) this.items.delete(this.items.keys().next().value as number);
    }
    const prev = this.items.get(orderId) || { expires: 0 };
    this.items.set(orderId, { ...prev, ...part, expires: now + SUBMISSION_TTL_MS });
  }
}

export const orderSubmissions = new OrderSubmissionStore();
