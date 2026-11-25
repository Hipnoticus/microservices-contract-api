import { callerHeaders } from '../../interfaces/http/auth/InternalAuth';
/**
 * NFS-e now lives in NFeAPI (.NET, nfe-service; SRP refactor phase 3). With NFE_SERVICE_ENABLED=true ContractAPI's
 * NFS-e endpoints (NFSeController and DELETE /admin/nfse/:id) forward to NFeAPI's /internal/** over the Docker network
 * with X-Service-Token, and answer with NFeAPI's status code and body. Off (default): the old code below runs as before.
 * The gateway normally sends /contract-service/nfse/** straight to NFeAPI; this covers callers that still reach
 * ContractAPI (HIPNOTICUS_NFE_ROUTE_URI=lb://contract-service in production until the owner approves issuing there).
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('NfeServiceClient');

export function nfeServiceEnabled(env = process.env): boolean {
  return String(env.NFE_SERVICE_ENABLED || '').trim().toLowerCase() === 'true';
}

export interface NfeReply { status: number; body: unknown }

export class NfeServiceClient {
  constructor(
    private readonly baseUrl = process.env.NFE_SERVICE_URL || 'http://hipnoticus-nfe-api:2004',
    private readonly token = process.env.NFE_SERVICE_TOKEN || '',
    private readonly timeoutMs = 60000,
  ) {}

  /** method + path (with query string) on NFeAPI; the JSON body is sent as Express parsed it. */
  async forward(method: string, path: string, body?: unknown): Promise<NfeReply> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Service-Token': this.token, ...callerHeaders('contract-api') },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      logger.error(`NFeAPI ${method} ${path.split('?')[0]} unreachable: ${(e as Error).message}`);
      throw new HttpException({ error: 'Serviço de NFS-e indisponível no momento. Tente novamente em instantes.' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text.length) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (res.status === 401) logger.error(`NFeAPI refused the service token (${method} ${path.split('?')[0]})`);
    return { status: res.status, body: parsed };
  }
}

/** The query string of an Express request ('' or '?a=b'), passed on unchanged. */
export function queryOf(req: { originalUrl?: string; url?: string }): string {
  const u = req.originalUrl || req.url || '';
  const i = u.indexOf('?');
  return i < 0 ? '' : u.slice(i);
}
