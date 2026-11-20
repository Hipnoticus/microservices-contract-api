import { HttpException, HttpStatus } from '@nestjs/common';
import { Logger } from '../../shared/logger/Logger';

/**
 * Cloudflare Turnstile on the public sign-up/order (incident 20261118: a curl bot created orders through the API).
 *
 * Moses renders the widget "Moses" (managed, moses.hipnoticus.com.br) on the Pagamento step (POST /orders) and, as a
 * separate instance, on the lead form (POST /leads/register), and sends its token in the request body as `turnstileToken`. The token is checked here with siteverify, which also makes it single use.
 * Staff callers (a verified UserAPI token) are not checked; the controller decides that.
 *
 * TURNSTILE_SECRET holds the widget secret (zeus .env.prod). Dev uses Cloudflare's always-pass test secret.
 * Without a secret, production (HIPNOTICUS_ENV=prod or NODE_ENV=production) refuses every public order; other
 * environments let it through with a warning.
 */
export const TURNSTILE_BODY_FIELD = 'turnstileToken';
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const logger = new Logger('Turnstile');
const FAIL_MESSAGE = 'Não foi possível confirmar a verificação de segurança. Atualize a página e tente novamente.';

export interface SiteverifyResult {
  success: boolean;
  'error-codes'?: string[];
  hostname?: string;
  action?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface TurnstileOptions {
  secret?: string;
  production?: boolean;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HIPNOTICUS_ENV || '').trim().toLowerCase() === 'prod' || (env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

let warnedMissing = false;

/** Throws 403 (pt-BR) unless Cloudflare confirms the token. `what` names the action in the log. */
export async function requireTurnstile(token: unknown, remoteIp: string, what: string, opts: TurnstileOptions = {}): Promise<void> {
  const secret = (opts.secret ?? process.env.TURNSTILE_SECRET ?? '').trim();
  const production = opts.production ?? isProduction();
  if (!secret) {
    if (production) {
      logger.error(`TURNSTILE_SECRET is not set in production: refusing ${what} from ${remoteIp}. Set it in .env.prod.`);
      throw new HttpException({ error: FAIL_MESSAGE }, HttpStatus.FORBIDDEN);
    }
    if (!warnedMissing) {
      logger.warn('TURNSTILE_SECRET is not set: Turnstile is NOT checked (allowed only outside production)');
      warnedMissing = true;
    }
    return;
  }

  const response = typeof token === 'string' ? token.trim() : '';
  if (!response || response.length > 2048) {
    logger.warn(`Turnstile: ${what} from ${remoteIp} refused, no token`);
    throw new HttpException({ error: FAIL_MESSAGE }, HttpStatus.FORBIDDEN);
  }

  const body = new URLSearchParams({ secret, response });
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);
  const fetchFn: FetchLike = opts.fetchFn || ((url, init) => fetch(url, init as any) as any);
  let result: SiteverifyResult;
  try {
    const res = await fetchFn(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
    });
    result = (await res.json()) as SiteverifyResult;
  } catch (e) {
    logger.error(`Turnstile: siteverify unreachable for ${what} from ${remoteIp}: ${(e as Error).message}`);
    throw new HttpException({ error: FAIL_MESSAGE }, HttpStatus.FORBIDDEN);
  }
  if (!result?.success) {
    logger.warn(`Turnstile: ${what} from ${remoteIp} refused (${(result?.['error-codes'] || []).join(',') || 'no success'})`);
    throw new HttpException({ error: FAIL_MESSAGE }, HttpStatus.FORBIDDEN);
  }
}
