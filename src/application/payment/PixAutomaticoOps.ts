/**
 * Pix Automatico (Banco Central's recurring Pix) for the calling application, through ContractAPI's Inter
 * application. The application keeps its own subscription rules (Hipno Online: Forreste_BancoInterPixAutomatico,
 * Jornada 3); ContractAPI only lets it act on ITS OWN mandates and charges and records every one with its origin.
 *
 * Operations (body.op), each one Inter call whose status and body come back unchanged:
 *   locrec        POST  /pix/v2/locrec                 location for the recurrence QR
 *   cob.put       PUT   /pix/v2/cob/{txid}             immediate charge (Jornada 3's first period)
 *   cob.get       GET   /pix/v2/cob/{txid}
 *   rec.create    POST  /pix/v2/rec                    the mandate; payload.vinculo.contrato = the caller's reference
 *   rec.get       GET   /pix/v2/rec/{idRec}[?txid=]
 *   rec.cancel    PATCH /pix/v2/rec/{idRec}            { status: CANCELADA }
 *   cobr.put      PUT   /pix/v2/cobr/{txid}            a period's charge against payload.idRec
 *   cobr.get      GET   /pix/v2/cobr/{txid}
 *   cobr.cancel   PATCH /pix/v2/cobr/{txid}            { status: CANCELADA }
 * Rules: new txids start with the origin's code (so the statement shows the origin); a txid or idRec of another
 * origin is refused (403); the Pix key is always ContractAPI's. Mandates and charges an origin created before this
 * existed (txids with a prefix in EXTERNAL_PAYMENT_LEGACY_TXIDS, e.g. hipno-online:HIPNO) can still be read, and a
 * mandate first seen that way is recorded as the origin's.
 */
import type { ExternalChargeStore, Origin } from './ExternalCharges';
import { EXTERNAL_REF } from './ExternalCharges';

export interface PixApi {
  pixApi(method: string, path: string, body: any, scope: string): Promise<{ status: number; data: any }>;
  readonly pixKey: string;
}

const TXID = /^[A-Za-z0-9]{26,35}$/;
const IDREC = /^[A-Za-z0-9]{10,40}$/;

const SCOPES = {
  locrec: 'payloadlocationrec.write payloadlocationrec.read',
  cobWrite: 'cob.write cob.read',
  cobRead: 'cob.read',
  recWrite: 'rec.write rec.read',
  recRead: 'rec.read',
  cobrWrite: 'cobr.write cobr.read',
  cobrRead: 'cobr.read',
};

export function legacyPrefixes(origin: Origin, env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  for (const e of (env.EXTERNAL_PAYMENT_LEGACY_TXIDS ?? 'hipno-online:HIPNO').split(',')) {
    const [name, prefix] = e.split(':').map(s => (s ?? '').trim());
    if (name === origin.name && prefix) out.push(prefix);
  }
  return out;
}

export class PixAutomaticoOps {
  constructor(private readonly inter: PixApi, private readonly store: ExternalChargeStore,
    private readonly env: Record<string, string | undefined> = process.env) {}

  private refuse(why: string) { return { http: 403, body: { title: 'Forbidden', detail: why } }; }
  private bad(why: string) { return { http: 400, body: { title: 'Bad request', detail: why } }; }
  private by(o: Origin) { return `external:${o.name}`; }

  private ownTxid(o: Origin, txid: string | undefined, forWrite: boolean): string | null {
    if (!txid || !TXID.test(txid)) return null;
    if (txid.startsWith(o.code)) return txid;
    if (!forWrite && legacyPrefixes(o, this.env).some(p => txid.startsWith(p))) return txid;
    return null;
  }

  /** The caller's mandate, or null. A mandate first seen by an origin with legacy txids is adopted. */
  private async ownRec(o: Origin, idRec: string | undefined): Promise<boolean> {
    if (!idRec || !IDREC.test(idRec)) return false;
    const ref = 'rec-' + idRec;
    if (await this.store.find(o.name, ref, 'pix_automatico')) return true;
    if (!legacyPrefixes(o, this.env).length) return false;
    const id = await this.store.claim({ origin: o.name, externalRef: ref, method: 'pix_automatico', provider: 'inter', seuNumero: null, amount: 0, by: this.by(o) });
    if (id !== null) await this.store.update(id, { providerRef: idRec, status: 'LEGACY', by: this.by(o) });
    return true;
  }

  private async record(o: Origin, ref: string, method: string, providerRef: string, amount: number, status: string): Promise<void> {
    const existing = await this.store.find(o.name, ref, method);
    if (existing) { await this.store.update(existing.ID, { providerRef, status, by: this.by(o) }); return; }
    const id = await this.store.claim({ origin: o.name, externalRef: ref, method, provider: 'inter', seuNumero: null, amount, by: this.by(o) });
    if (id !== null) await this.store.update(id, { providerRef, status, by: this.by(o) });
  }

  async run(o: Origin, b: { op: string; txid?: string; idRec?: string; payload?: any }): Promise<{ http: number; body: any }> {
    const p = b.payload && typeof b.payload === 'object' ? b.payload : {};
    const call = async (method: string, path: string, body: any, scope: string) => {
      const r = await this.inter.pixApi(method, path, body, scope);
      return { http: r.status, body: r.data };
    };
    switch (b.op) {
      case 'locrec':
        return call('POST', '/pix/v2/locrec', { tipoCob: 'cobr' }, SCOPES.locrec);

      case 'cob.put': {
        const txid = this.ownTxid(o, b.txid, true);
        if (!txid) return this.refuse(`txid must start with ${o.code} (26-35 letters and digits)`);
        const r = await call('PUT', `/pix/v2/cob/${txid}`, { ...p, chave: this.inter.pixKey }, SCOPES.cobWrite);
        if (r.http < 300) await this.record(o, txid, 'pix', txid, Number(p?.valor?.original) || 0, String(r.body?.status || 'ATIVA'));
        return r;
      }
      case 'cob.get': {
        const txid = this.ownTxid(o, b.txid, false);
        if (!txid) return this.refuse('not your txid');
        return call('GET', `/pix/v2/cob/${txid}`, undefined, SCOPES.cobRead);
      }

      case 'rec.create': {
        const contrato = String(p?.vinculo?.contrato ?? '');
        if (!EXTERNAL_REF.test(contrato) || contrato.length > 36) return this.bad('payload.vinculo.contrato (the caller reference, up to 36 characters) required');
        const jTxid = p?.ativacao?.dadosJornada?.txid;
        if (jTxid !== undefined && !this.ownTxid(o, jTxid, true)) return this.refuse(`ativacao txid must start with ${o.code}`);
        const ref = 'sub-' + contrato;
        const existing = await this.store.find(o.name, ref, 'pix_automatico');
        if (existing?.ProviderRef && existing.Status !== 'FAILED') {
          // One mandate per caller reference: a retry reads the existing one instead of creating another.
          return call('GET', `/pix/v2/rec/${existing.ProviderRef}`, undefined, SCOPES.recRead);
        }
        const r = await call('POST', '/pix/v2/rec', p, SCOPES.recWrite);
        const idRec = r.body?.idRec;
        if (r.http < 300 && typeof idRec === 'string') {
          await this.record(o, ref, 'pix_automatico', idRec, Number(p?.valor?.valorRec) || 0, String(r.body?.status || 'CRIADA'));
          await this.record(o, 'rec-' + idRec, 'pix_automatico', idRec, Number(p?.valor?.valorRec) || 0, 'MANDATE');
        }
        return r;
      }
      case 'rec.get': {
        if (!(await this.ownRec(o, b.idRec))) return this.refuse('not your mandate');
        const q = b.txid && TXID.test(b.txid) ? `?txid=${b.txid}` : '';
        return call('GET', `/pix/v2/rec/${b.idRec}${q}`, undefined, SCOPES.recRead);
      }
      case 'rec.cancel': {
        if (!(await this.ownRec(o, b.idRec))) return this.refuse('not your mandate');
        return call('PATCH', `/pix/v2/rec/${b.idRec}`, { status: 'CANCELADA' }, SCOPES.recWrite);
      }

      case 'cobr.put': {
        const txid = this.ownTxid(o, b.txid, true);
        if (!txid) return this.refuse(`txid must start with ${o.code} (26-35 letters and digits)`);
        if (!(await this.ownRec(o, p?.idRec))) return this.refuse('payload.idRec is not your mandate');
        const r = await call('PUT', `/pix/v2/cobr/${txid}`, p, SCOPES.cobrWrite);
        if (r.http < 300) await this.record(o, txid, 'pix_automatico_cobr', txid, Number(p?.valor?.original) || 0, String(r.body?.status || 'CRIADA'));
        return r;
      }
      case 'cobr.get': {
        const txid = this.ownTxid(o, b.txid, false);
        if (!txid) return this.refuse('not your txid');
        return call('GET', `/pix/v2/cobr/${txid}`, undefined, SCOPES.cobrRead);
      }
      case 'cobr.cancel': {
        const txid = this.ownTxid(o, b.txid, false);
        if (!txid) return this.refuse('not your txid');
        return call('PATCH', `/pix/v2/cobr/${txid}`, { status: 'CANCELADA' }, SCOPES.cobrWrite);
      }
      default:
        return this.bad(`unknown op ${b.op}`);
    }
  }
}
