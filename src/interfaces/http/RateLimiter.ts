import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Fixed-window counter per key (client IP), in memory. ContractAPI runs as one container, so a shared store is not
 * needed; a restart only resets the windows.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50000,
  ) {}

  /** Counts one hit. Returns the seconds to wait when the key is over the limit, or 0 when allowed. */
  hit(key: string, now = Date.now()): number {
    let w = this.hits.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      w = { start: now, count: 0 };
      this.hits.set(key, w);
    }
    w.count++;
    if (w.count > this.limit) return Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000));
    return 0;
  }

  /** Throws 429 (pt-BR message) when the key is over the limit. */
  check(key: string, what: string): void {
    const wait = this.hit(key);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60);
      throw new HttpException(
        { error: `Muitas tentativas de ${what} a partir deste endereço. Tente novamente em ${minutes} minuto${minutes === 1 ? '' : 's'}.`, retryAfter: wait },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private prune(now: number): void {
    for (const [k, w] of this.hits) if (now - w.start >= this.windowMs) this.hits.delete(k);
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}

const HOUR = 60 * 60 * 1000;
const envInt = (name: string, fallback: number) => {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** POST /orders: new sign-ups/orders per IP per hour (ORDER_RATE_LIMIT_PER_HOUR, default 5). */
export const orderRateLimiter = new RateLimiter(envInt('ORDER_RATE_LIMIT_PER_HOUR', 5), HOUR);
/** POST /payments/process: retries of a declined card are normal, so a looser limit (PAYMENT_RATE_LIMIT_PER_HOUR, default 20). */
export const paymentRateLimiter = new RateLimiter(envInt('PAYMENT_RATE_LIMIT_PER_HOUR', 20), HOUR);
/** POST /leads/register: the first Contratar step, once per visitor (LEAD_RATE_LIMIT_PER_HOUR, default 10). */
export const leadRateLimiter = new RateLimiter(envInt('LEAD_RATE_LIMIT_PER_HOUR', 10), HOUR);
