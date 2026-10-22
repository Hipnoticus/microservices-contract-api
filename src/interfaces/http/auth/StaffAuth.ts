import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Type, mixin } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Staff authentication for the /admin endpoints.
 *
 * The token is the UserAPI staff JWT (HS256, the same secret CustomerAPI uses). It is verified HERE, not taken on the
 * gateway's word, so the admin API stays closed even when reached without the gateway. Authorisation follows
 * ControleWeb: a per-user allow-list of module IDs (tbUsersPermissions.Value), carried in the token as `perms`.
 */
export interface StaffUser {
  id: number;
  name: string;
  email: string;
  perms: number[];
}

/** ControleWeb module IDs (tbModules), plus the pseudo-module 9999 Configurações. */
export const MODULE = {
  USUARIOS: 1,
  CLIENTES: 3,
  FORMAS_PAGAMENTO: 4,
  SESSOES: 6,
  CALENDARIO: 7,
  QUESTIONARIOS: 11,
  MATERIAIS: 12,
  MANEIRAS: 14,
  NFSE: 15,
  TRATAMENTOS: 16,
  CONFIGURACOES: 9999,
} as const;

function secret(): string {
  return process.env.JWT_HS256_KEY || process.env.CUSTOMER_JWT_HS256_KEY || process.env.JWT_SIGNING_KEY || '';
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Returns the staff user or null for anything that is not a valid, unexpired UserAPI token. */
export function verifyStaffToken(authorization: string | undefined, key = secret()): StaffUser | null {
  if (!key || key.length < 32 || !authorization?.startsWith('Bearer ')) return null;
  const parts = authorization.slice(7).trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    if (header?.alg !== 'HS256') return null;
    const expected = createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest();
    const given = b64urlDecode(parts[2]);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const p = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
    if (p?.type !== 'user') return null;
    if (!p.exp || Date.now() / 1000 >= Number(p.exp)) return null;
    const id = parseInt(String(p.sub), 10);
    if (!Number.isFinite(id) || id <= 0) return null;
    const perms = Array.isArray(p.perms) ? p.perms.map((x: any) => Number(x)).filter((x: number) => Number.isFinite(x)) : [];
    return { id, name: String(p.name || ''), email: String(p.email || ''), perms };
  } catch {
    return null;
  }
}

/**
 * Guard factory: StaffGuard() needs any staff token; StaffGuard(6, 7) needs one of those modules.
 * The verified user is put on request.staff.
 */
export function StaffGuard(...modules: number[]): Type<CanActivate> {
  @Injectable()
  class Guard implements CanActivate {
    canActivate(ctx: ExecutionContext): boolean {
      const req = ctx.switchToHttp().getRequest();
      const user = verifyStaffToken(req.headers?.authorization);
      if (!user) throw new HttpException({ error: 'Autenticação necessária.' }, HttpStatus.UNAUTHORIZED);
      if (modules.length && !modules.some((m) => user.perms.includes(m))) {
        throw new HttpException({ error: 'Sem permissão para este módulo.' }, HttpStatus.FORBIDDEN);
      }
      req.staff = user;
      return true;
    }
  }
  return mixin(Guard);
}

/** The staff user a StaffGuard put on the request. */
export function staffOf(req: any): StaffUser {
  return req.staff as StaffUser;
}

/** Throws 403 unless the staff user holds one of the modules (for per-action checks inside a controller). */
export function requireModule(user: StaffUser, ...modules: number[]): void {
  if (!modules.some((m) => user.perms.includes(m))) {
    throw new HttpException({ error: 'Sem permissão para este módulo.' }, HttpStatus.FORBIDDEN);
  }
}
