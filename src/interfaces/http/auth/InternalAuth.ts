/**
 * Internal-call authentication (AGENTS.md "Internal-call authentication"; same rules in every service).
 *
 * gateway:   valid X-Gateway-Auth = hex HMAC-SHA256(GATEWAY_SIGNING_KEY, METHOD\nTARGET\nX-User-Type\nX-User-Id\n
 *            X-User-Perms\nX-Gateway-Ts), at most 60 s old. Only then are the X-User-* headers the gateway's.
 * caller:    X-Caller + X-Caller-Token whose SHA-256 (hex) is that name's entry in INTERNAL_CALLERS (name:sha256,...).
 *            Older per-service tokens count as caller "legacy:<name>" during the transition.
 * anonymous: anything else; allowed only on the service's public routes.
 * INTERNAL_AUTH_MODE: off | report (log "internal-auth would refuse ...", serve) | enforce (401).
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';

export type Mode = 'off' | 'report' | 'enforce';
export type Kind = 'gateway' | 'caller' | 'anonymous';
export interface AuthResult { kind: Kind; caller?: string; reason?: string }
export interface LegacyTokens { header: string; list?: string }
export interface InternalAuthOptions {
  mode?: string;
  gatewayKey?: string;
  callers?: string;
  publicRoutes?: string[];
  legacy?: LegacyTokens[];
  now?: () => number;
  log?: (level: 'info' | 'warn', msg: string) => void;
}

export const CALLER_PROP = 'internalCaller';
const MAX_SKEW = 60;

function eq(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sign(key: string, method: string, target: string, type?: string, id?: string, perms?: string, ts = 0): string {
  const c = [method.toUpperCase(), target, type ?? '', id ?? '', perms ?? '', String(ts)].join('\n');
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(c, 'utf8').digest('hex');
}

export function matches(pattern: string, path: string): boolean {
  const p = pattern.split('/');
  const s = path.split('/');
  let i = 0;
  for (; i < p.length; i++) {
    if (p[i] === '**') return true;
    if (i >= s.length) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return i === s.length;
}

export class InternalAuth {
  readonly mode: Mode;
  private readonly key: string;
  private readonly callers = new Map<string, Buffer>();
  private readonly legacy: { header: string; tokens: Map<string, Buffer> }[] = [];
  private readonly publicRoutes: { method: string; pattern: string }[] = [];
  private readonly now: () => number;

  constructor(o: InternalAuthOptions = {}) {
    const m = (o.mode ?? '').trim().toLowerCase();
    this.mode = m === 'report' || m === 'enforce' ? m : 'off';
    this.key = o.gatewayKey ?? '';
    for (const e of (o.callers ?? '').split(',')) {
      const i = e.indexOf(':');
      if (i <= 0) continue;
      const hex = e.slice(i + 1).trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(hex)) this.callers.set(e.slice(0, i).trim().toLowerCase(), Buffer.from(hex, 'hex'));
    }
    for (const r of o.publicRoutes ?? []) {
      const p = r.trim().split(/\s+/, 2);
      this.publicRoutes.push(p.length === 2 ? { method: p[0].toUpperCase(), pattern: p[1].toLowerCase() } : { method: '*', pattern: p[0].toLowerCase() });
    }
    for (const l of o.legacy ?? []) {
      const tokens = new Map<string, Buffer>();
      for (const e of (l.list ?? '').split(',')) {
        const t = e.trim();
        const i = t.indexOf(':');
        const name = i > 0 ? t.slice(0, i) : 'service';
        const tok = i > 0 ? t.slice(i + 1).trim() : t;
        if (tok.length >= 16) tokens.set(name, Buffer.from(tok, 'utf8'));
      }
      if (tokens.size) this.legacy.push({ header: l.header.toLowerCase(), tokens });
    }
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get gatewayKeyConfigured(): boolean { return Buffer.byteLength(this.key, 'utf8') >= 32; }
  get callerCount(): number { return this.callers.size; }

  identify(method: string, target: string, header: (name: string) => string | undefined): AuthResult {
    let reason = 'no-credentials';
    const sig = header('x-gateway-auth');
    if (sig && sig.trim()) {
      const r = this.checkGateway(method, target, header, sig.trim());
      if (!r) return { kind: 'gateway', caller: 'gateway' };
      reason = r;
    }
    const name = header('x-caller');
    const token = header('x-caller-token');
    if ((name && name.trim()) || (token && token.trim())) {
      const n = (name ?? '').trim().toLowerCase();
      const want = this.callers.get(n);
      if (!want) return { kind: 'anonymous', caller: n, reason: 'unknown-caller' };
      const got = createHash('sha256').update((token ?? '').trim(), 'utf8').digest();
      return eq(want, got) ? { kind: 'caller', caller: n } : { kind: 'anonymous', caller: n, reason: 'bad-caller-token' };
    }
    for (const l of this.legacy) {
      const v = header(l.header);
      if (!v || !v.trim()) continue;
      const given = Buffer.from(v.trim(), 'utf8');
      let match: string | undefined;
      for (const [n, t] of l.tokens) if (eq(t, given)) match = n;
      if (match) return { kind: 'caller', caller: 'legacy:' + match };
      reason = 'bad-legacy-token';
    }
    return { kind: 'anonymous', reason };
  }

  private checkGateway(method: string, target: string, header: (n: string) => string | undefined, sig: string): string | undefined {
    if (!this.gatewayKeyConfigured) return 'gateway-key-not-configured';
    const raw = (header('x-gateway-ts') ?? '').trim();
    if (!/^-?\d+$/.test(raw)) return 'bad-gateway-ts';
    const ts = parseInt(raw, 10);
    if (Math.abs(this.now() - ts) > MAX_SKEW) return 'expired-gateway-signature';
    const expected = sign(this.key, method, target, header('x-user-type'), header('x-user-id'), header('x-user-perms'), ts);
    return eq(Buffer.from(expected, 'ascii'), Buffer.from(sig.toLowerCase(), 'ascii')) ? undefined : 'bad-gateway-signature';
  }

  isPublic(method: string, target: string): boolean {
    let path = target.split('?')[0].toLowerCase();
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    if (path === '/health' || path === '/actuator/health' || path.startsWith('/actuator/health/')) return true;
    return this.publicRoutes.some(r => (r.method === '*' || r.method === method.toUpperCase()) && matches(r.pattern, path));
  }
}

function headerOf(req: any): (n: string) => string | undefined {
  return (n: string) => {
    const v = req.headers?.[n.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
}

/** Express middleware; register before every route. req.internalCaller = gateway | caller name | undefined. */
export function internalAuthMiddleware(auth: InternalAuth, log: (level: 'info' | 'warn', msg: string) => void = (l, m) => (l === 'warn' ? console.warn(m) : console.log(m))) {
  log('info', `internal-auth mode=${auth.mode} gatewayKey=${auth.gatewayKeyConfigured ? 'set' : 'missing'} callers=${auth.callerCount}`);
  return (req: any, res: any, next: () => void) => {
    if (auth.mode === 'off') return next();
    const target: string = req.originalUrl || req.url || '/';
    const method: string = req.method || 'GET';
    const path = target.split('?')[0];
    const r = auth.identify(method, target, headerOf(req));
    if (r.kind !== 'anonymous') {
      req[CALLER_PROP] = r.caller;
      if (r.kind === 'caller') log('info', `internal-auth caller=${r.caller} ${method} ${path}`);
      return next();
    }
    const open = auth.isPublic(method, target);
    const ip = (req.socket?.remoteAddress ?? '?').replace(/^::ffff:/, '');
    const who = r.caller ? `${r.caller}@${ip}` : ip;
    if (auth.mode === 'report') {
      if (!open) log('warn', `internal-auth would refuse caller=${who} path=${method} ${path} reason=${r.reason}`);
      return next();
    }
    if (!open) {
      log('warn', `internal-auth refused caller=${who} path=${method} ${path} reason=${r.reason}`);
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'internal_auth', reason: r.reason }));
    }
    for (const h of Object.keys(req.headers ?? {})) {
      if (h.startsWith('x-user-') || h.startsWith('x-staff-')) delete req.headers[h];
    }
    return next();
  };
}

/** From env: INTERNAL_AUTH_MODE, GATEWAY_SIGNING_KEY, INTERNAL_CALLERS. */
export function internalAuthFromEnv(publicRoutes: string[], legacy: LegacyTokens[] = [], env: Record<string, string | undefined> = process.env): InternalAuth {
  return new InternalAuth({ mode: env.INTERNAL_AUTH_MODE, gatewayKey: env.GATEWAY_SIGNING_KEY, callers: env.INTERNAL_CALLERS, publicRoutes, legacy });
}

/** Outgoing calls: this service's own caller token (INTERNAL_CALLER_NAME, INTERNAL_CALLER_TOKEN), or {} when unset. */
export function callerHeaders(defaultName: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const token = (env.INTERNAL_CALLER_TOKEN ?? '').trim();
  if (!token) return {};
  return { 'X-Caller': (env.INTERNAL_CALLER_NAME ?? '').trim() || defaultName, 'X-Caller-Token': token };
}
