/**
 * Charges ContractAPI creates for other applications (/payments/external/**): every one of them carries the
 * application it came from, whatever the method (boleto, Pix, card, Pix Automatico) and the provider behind it
 * (.plans/HIPNOONLINE_CONTRACTAPI_PAYMENTS_PLAN.md).
 *
 * The origin comes from the caller's authenticated identity, never from the request body:
 *   - a direct caller with a valid X-Caller token that has an entry in EXTERNAL_PAYMENT_ORIGINS;
 *   - a gateway-signed call with X-User-Type: service, which today is only Amode (the shared service credential).
 * Each origin has a code that starts the boleto's seuNumero, the Pix txid and Cielo's MerchantOrderId, so BIService
 * and the Cielo portal show the origin of every payment without asking anyone (HO = Hipno Online, AM = Amode;
 * Moses' own orders keep plain numbers).
 */
import { randomBytes } from 'crypto';
import { Sequelize, QueryTypes } from 'sequelize';
import { CALLER_PROP } from '../../interfaces/http/auth/InternalAuth';

/** The payment methods any origin may be given. The provider behind each one is ContractAPI's business. */
export const METHODS = ['boleto', 'pix', 'credit_card', 'pix_automatico'] as const;
export type Method = typeof METHODS[number];

/** An application that pays through ContractAPI: its caller name, its code in bank references, what it may use. */
export interface Origin { name: string; code: string; methods: Method[] }

/**
 * Origins are configuration, not code: a new brand or app (Sono Perfeito, Kura 5, ...) gets a caller token
 * (AGENTS.md "Add a caller") and one entry here, nothing else changes.
 *   EXTERNAL_PAYMENT_ORIGINS = caller=CODE:method|method,...   e.g. hipno-online=HO:boleto|pix|pix_automatico
 * CODE: 2 to 4 capital letters or digits, unique; it starts the boleto's seuNumero, the Pix txid and Cielo's
 * MerchantOrderId, so the bank statement and the acquirer's portal show where each payment came from.
 * "amode" is the origin of gateway-signed service calls (the shared service credential, used only by Amode).
 */
export const DEFAULT_ORIGINS = 'hipno-online=HO:boleto|pix|pix_automatico,amode=AM:boleto|pix|credit_card';

export function parseOrigins(spec: string | undefined): Map<string, Origin> {
  const out = new Map<string, Origin>();
  const codes = new Set<string>();
  for (const raw of (spec && spec.trim() ? spec : DEFAULT_ORIGINS).split(',')) {
    const m = /^\s*([a-z0-9][a-z0-9-]{1,39})\s*=\s*([A-Z0-9]{2,4})\s*:\s*([a-z_|]+)\s*$/.exec(raw);
    if (!m) throw new Error(`EXTERNAL_PAYMENT_ORIGINS: bad entry "${raw.trim()}" (caller=CODE:method|method)`);
    const methods = m[3].split('|').filter(Boolean) as Method[];
    for (const x of methods) if (!(METHODS as readonly string[]).includes(x)) throw new Error(`EXTERNAL_PAYMENT_ORIGINS: unknown method ${x}`);
    if (codes.has(m[2]) || /^\d+$/.test(m[2])) throw new Error(`EXTERNAL_PAYMENT_ORIGINS: code ${m[2]} repeated or only digits`);
    codes.add(m[2]);
    out.set(m[1], { name: m[1], code: m[2], methods });
  }
  return out;
}

let cached: { spec: string | undefined; origins: Map<string, Origin> } | null = null;
export function origins(env: Record<string, string | undefined> = process.env): Map<string, Origin> {
  if (!cached || cached.spec !== env.EXTERNAL_PAYMENT_ORIGINS) cached = { spec: env.EXTERNAL_PAYMENT_ORIGINS, origins: parseOrigins(env.EXTERNAL_PAYMENT_ORIGINS) };
  return cached.origins;
}

function one(v: unknown): string {
  return String(Array.isArray(v) ? v[0] ?? '' : v ?? '').trim();
}

/**
 * The origin of a request to /payments/external/**, or null (the controller answers 401).
 * Unsigned X-User-Type: service is accepted as Amode only while INTERNAL_AUTH_MODE is not enforce (production is
 * still "report"; Amode's calls must not break before every gateway call is verified), and is logged.
 */
export function originOf(req: any, env: Record<string, string | undefined> = process.env,
  log: (msg: string) => void = (m) => console.warn(m)): Origin | null {
  const all = origins(env);
  const caller = one(req?.[CALLER_PROP]).toLowerCase();
  const userType = one(req?.headers?.['x-user-type']).toLowerCase();
  if (caller === 'gateway') return userType === 'service' ? all.get('amode') ?? null : null;
  if (caller && caller !== 'amode' && all.has(caller)) return all.get(caller)!;
  const mode = (env.INTERNAL_AUTH_MODE ?? '').trim().toLowerCase();
  if (!caller && userType === 'service' && mode !== 'enforce') {
    log('external-payments would refuse an unsigned service call (accepted as amode while INTERNAL_AUTH_MODE is not enforce)');
    return all.get('amode') ?? null;
  }
  return null;
}

/** Inter's Pix txid (26 to 35 letters and digits): origin code + reference + random letters and digits. */
export function pixTxidFor(origin: Origin, externalRef: string, random: () => string = randomAlnum): string {
  let s = (origin.code + externalRef.replace(/[^A-Za-z0-9]/g, '')).substring(0, 25);
  while (s.length < 35) s += random();
  return s.substring(0, 35);
}

function randomAlnum(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/** Cielo MerchantOrderId (up to 50): origin code + reference. */
export function merchantOrderIdFor(origin: Origin, externalRef: string): string {
  return (origin.code + '-' + externalRef.replace(/[^A-Za-z0-9-]/g, '')).substring(0, 50);
}

/** External references are the caller's own order ids: letters, digits and "-", short enough for seuNumero. */
export const EXTERNAL_REF = /^[A-Za-z0-9-]{1,40}$/;

/** Inter's seuNumero (15 characters at most): origin code + the reference's letters and digits. */
export function seuNumeroFor(origin: Origin, externalRef: string): string {
  const s = origin.code + externalRef.replace(/[^A-Za-z0-9]/g, '');
  if (s.length > 15) throw new Error(`externalRef too long for Inter's seuNumero (${s.length} > 15 characters)`);
  return s;
}

export interface ExternalCharge {
  ID: number;
  Origin: string;
  ExternalRef: string;
  Method: string;
  Provider: string;
  ProviderRef: string | null;
  SeuNumero: string | null;
  Amount: number;
  Status: string;
  PaidAt: Date | null;
}

/** Charges that never reached Inter (or that Inter refused) may be tried again with the same reference. */
export const RETRYABLE = new Set(['PENDING', 'FAILED']);
/** Inter situacao values after which a boleto's status never changes again. */
export const FINAL = new Set(['RECEBIDO', 'MARCADO_RECEBIDO', 'CANCELADO', 'EXPIRADO']);

export interface ExternalChargeStore {
  find(origin: string, externalRef: string, method: string): Promise<ExternalCharge | null>;
  findById(origin: string, id: number): Promise<ExternalCharge | null>;
  /** Claims (origin, ref, method): the new row's id, or null when another request already holds it. */
  claim(c: { origin: string; externalRef: string; method: string; provider: string; seuNumero: string | null; amount: number; by: string }): Promise<number | null>;
  update(id: number, f: { providerRef?: string | null; status?: string; amount?: number; paidAt?: Date | null; by: string }): Promise<void>;
}

/** tbExternalCharges (scripts/2026-11-26-tbExternalCharges.sql); svc_contract has SELECT, INSERT, UPDATE on it. */
export class SqlExternalChargeStore implements ExternalChargeStore {
  constructor(private readonly db: Sequelize) {}

  private async one(sql: string, replacements: Record<string, unknown>): Promise<ExternalCharge | null> {
    const rows = await this.db.query<ExternalCharge>(sql, { replacements, type: QueryTypes.SELECT });
    return rows[0] ?? null;
  }

  find(origin: string, externalRef: string, method: string): Promise<ExternalCharge | null> {
    return this.one(`SELECT ID, Origin, ExternalRef, Method, Provider, ProviderRef, SeuNumero, Amount, Status, PaidAt
      FROM dbo.tbExternalCharges WHERE Origin = :origin AND ExternalRef = :externalRef AND Method = :method AND Blocked = 0`,
    { origin, externalRef, method });
  }

  findById(origin: string, id: number): Promise<ExternalCharge | null> {
    return this.one(`SELECT ID, Origin, ExternalRef, Method, Provider, ProviderRef, SeuNumero, Amount, Status, PaidAt
      FROM dbo.tbExternalCharges WHERE ID = :id AND Origin = :origin AND Blocked = 0`, { origin, id });
  }

  async claim(c: { origin: string; externalRef: string; method: string; provider: string; seuNumero: string | null; amount: number; by: string }): Promise<number | null> {
    try {
      const rows = await this.db.query<{ ID: number }>(`INSERT INTO dbo.tbExternalCharges
          (Origin, ExternalRef, Method, Provider, SeuNumero, Amount, Status, DateCreated, DateModified, CreatedBy, ModifiedBy, Blocked)
        OUTPUT INSERTED.ID
        VALUES (:origin, :externalRef, :method, :provider, :seuNumero, :amount, 'PENDING', SYSDATETIME(), SYSDATETIME(), :by, :by, 0)`,
      { replacements: c, type: QueryTypes.SELECT });
      return rows[0]?.ID ?? null;
    } catch (e: any) {
      // 2627/2601: unique index UX_tbExternalCharges_Ref, the reference is already claimed
      const n = e?.original?.number ?? e?.parent?.number;
      if (e?.name === 'SequelizeUniqueConstraintError' || n === 2627 || n === 2601) return null;
      throw e;
    }
  }

  async update(id: number, f: { providerRef?: string | null; status?: string; amount?: number; paidAt?: Date | null; by: string }): Promise<void> {
    const sets = ['DateModified = SYSDATETIME()', 'ModifiedBy = :by'];
    const r: Record<string, unknown> = { id, by: f.by };
    if (f.providerRef !== undefined) { sets.push('ProviderRef = :providerRef'); r.providerRef = f.providerRef; }
    if (f.status !== undefined) { sets.push('Status = :status'); r.status = f.status; }
    if (f.amount !== undefined) { sets.push('Amount = :amount'); r.amount = f.amount; }
    if (f.paidAt !== undefined) { sets.push('PaidAt = :paidAt'); r.paidAt = f.paidAt; }
    await this.db.query(`UPDATE dbo.tbExternalCharges SET ${sets.join(', ')} WHERE ID = :id`, { replacements: r });
  }
}
