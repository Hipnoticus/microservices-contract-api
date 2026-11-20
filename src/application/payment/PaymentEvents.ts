/**
 * In-process "order paid" events, so GET /payments/stream/:orderId can tell the Moses success page the moment an
 * order is confirmed (Banco Inter webhook, polling, the live check of /payments/status, staff or an approved card).
 * ContractAPI runs as a single instance; the stream also re-checks the order every few seconds, so a confirmation
 * made by another process still reaches the page.
 */
export interface PaidEvent {
  orderId: number;
  source: string;
}

type Listener = (e: PaidEvent) => void;

export class PaymentEvents {
  private listeners = new Map<number, Set<Listener>>();

  /** Subscribes to one order; returns the unsubscribe function. */
  onPaid(orderId: number, fn: Listener): () => void {
    let set = this.listeners.get(orderId);
    if (!set) {
      set = new Set();
      this.listeners.set(orderId, set);
    }
    set.add(fn);
    return () => {
      const s = this.listeners.get(orderId);
      if (!s) return;
      s.delete(fn);
      if (!s.size) this.listeners.delete(orderId);
    };
  }

  emitPaid(orderId: number, source: string): void {
    const set = this.listeners.get(orderId);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn({ orderId, source }); } catch { /* a broken listener never blocks the confirmation */ }
    }
  }

  listenerCount(orderId?: number): number {
    if (orderId != null) return this.listeners.get(orderId)?.size ?? 0;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

export const paymentEvents = new PaymentEvents();
