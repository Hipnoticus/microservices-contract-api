import { Controller, Post, Get, Body, Param, Req, Inject, Optional, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CieloGateway, CieloCardData } from '../../../infrastructure/payment/CieloGateway';
import { BancoInterGateway, parseCobranca, isCobrancaPaid } from '../../../infrastructure/payment/BancoInterGateway';
import {
  EXTERNAL_REF, FINAL, RETRYABLE, merchantOrderIdFor, originOf, pixTxidFor, seuNumeroFor,
} from '../../../application/payment/ExternalCharges';
import type { ExternalCharge, ExternalChargeStore, Method, Origin } from '../../../application/payment/ExternalCharges';
import { PixAutomaticoOps } from '../../../application/payment/PixAutomaticoOps';
import { Logger } from '../../../shared/logger/Logger';

const logger = new Logger('ExternalPaymentController');

/** Card results that already took the customer's money (or reserved it): never charge the same reference again. */
const CARD_TAKEN = new Set(['AUTHORIZED', 'PAID']);

/**
 * Payments for other applications (Hipno Online, Amode, and any brand or app added to EXTERNAL_PAYMENT_ORIGINS).
 * ContractAPI holds every bank and acquirer credential; the applications hold only their caller token.
 *
 * Every request says who it is (originOf, from the authenticated caller) and every charge is recorded in
 * tbExternalCharges with that origin, whatever the method and the provider behind it. The origin's code starts
 * the boleto's seuNumero, the Pix txid and Cielo's MerchantOrderId. A charge is identified by the caller's own
 * reference (externalRef): asking again for the same reference returns the same charge instead of a second one.
 * No Hipnoticus order is created; the caller keeps its own business rules.
 */
@ApiTags('External Payments (B2B)')
@Controller('payments/external')
export class ExternalPaymentController {
  constructor(
    @Inject('CIELO_GATEWAY') private readonly cieloGateway: CieloGateway | null,
    @Inject('BANCO_INTER_GATEWAY') private readonly bancoInterGateway: BancoInterGateway | null,
    @Optional() @Inject('EXTERNAL_CHARGES') private readonly charges: ExternalChargeStore | null = null,
  ) {}

  private origin(req: any): Origin {
    const o = originOf(req);
    if (!o) {
      logger.warn(`External payment refused: no allowed caller (caller=${req?.internalCaller ?? '-'})`);
      throw new UnauthorizedException('external payments need an allowed caller');
    }
    return o;
  }

  private allowed(origin: Origin, method: string): method is Method {
    return (origin.methods as string[]).includes(method);
  }

  @Post('process')
  @ApiOperation({ summary: 'One charge for the calling application: boleto, pix or credit_card, by its own externalRef' })
  async processExternal(@Req() req: any, @Body() body: ExternalPaymentRequest): Promise<ExternalPaymentResponse> {
    const origin = this.origin(req);
    const r: ExternalPaymentRequest = body || ({} as ExternalPaymentRequest);
    if (!(Number(r.amount) > 0)) return { success: false, error: 'Invalid amount' };
    if (!this.allowed(origin, r.method) || r.method === 'pix_automatico') {
      return { success: false, error: `Method ${r.method} is not available for ${origin.name}` };
    }
    // Amode has always called without a reference; every other origin must send its own.
    const ref = r.externalRef ?? (origin.name === 'amode' ? `T${Date.now().toString(36).toUpperCase()}` : undefined);
    if (!ref || !EXTERNAL_REF.test(ref)) return { success: false, error: 'externalRef required (letters, digits, -)' };
    if (!this.charges) return { success: false, error: 'External charges registry not configured' };
    logger.info(`External payment: origin=${origin.name} method=${r.method} amount=${r.amount} ref=${ref}`);
    switch (r.method) {
      case 'boleto': return this.processBoleto(origin, ref, r);
      case 'pix': return this.processPix(origin, ref, r);
      case 'credit_card': return this.processCard(origin, ref, r);
      default: return { success: false, error: `Unknown payment method: ${r.method}` };
    }
  }

  @Post('status')
  @ApiOperation({ summary: 'Status of a charge: { chargeId } or { externalRef, method }; Amode may still send a Pix { txid }' })
  async checkStatus(@Req() req: any, @Body() body: { txid?: string; chargeId?: number; externalRef?: string; method?: string }): Promise<ExternalStatusResponse> {
    const origin = this.origin(req);
    if (body?.chargeId !== undefined || body?.externalRef) return this.recordedStatus(origin, body);
    if (origin.name !== 'amode') return { paid: false, status: 'missing_charge' };
    if (!this.bancoInterGateway) return { paid: false, status: 'gateway_not_configured' };
    if (!body?.txid) return { paid: false, status: 'missing_txid' };
    try {
      return await this.bancoInterGateway.checkPixStatus(body.txid);
    } catch (e) {
      logger.error(`External status check error: ${(e as Error).message}`);
      return { paid: false, status: 'error' };
    }
  }

  @Get('charges/:id/pdf')
  @ApiOperation({ summary: "Boleto PDF (base64) of one of the caller's own charges" })
  async chargePdf(@Req() req: any, @Param('id') id: string): Promise<{ pdf: string | null; error?: string }> {
    const origin = this.origin(req);
    const charge = await this.ownCharge(origin, Number(id));
    if (!charge || charge.Method !== 'boleto' || !charge.ProviderRef) return { pdf: null, error: 'not_found' };
    if (!this.bancoInterGateway) return { pdf: null, error: 'gateway_not_configured' };
    return { pdf: await this.bancoInterGateway.getBoletoPdf(charge.ProviderRef) };
  }

  @Post('pix-automatico')
  @ApiOperation({ summary: "Pix Automatico operations for the caller's own mandates and charges (Inter's answer unchanged)" })
  async pixAutomatico(@Req() req: any, @Body() body: { op: string; txid?: string; idRec?: string; payload?: any }): Promise<{ http: number; body: any }> {
    const origin = this.origin(req);
    if (!this.allowed(origin, 'pix_automatico')) throw new ForbiddenException(`pix_automatico is not available for ${origin.name}`);
    if (!this.bancoInterGateway || !this.charges) return { http: 503, body: { title: 'Pix Automatico not configured' } };
    return new PixAutomaticoOps(this.bancoInterGateway, this.charges).run(origin, body || ({} as any));
  }

  // ---------------------------------------------------------------- recorded charges

  private async ownCharge(origin: Origin, id: number): Promise<ExternalCharge | null> {
    if (!this.charges || !Number.isInteger(id) || id <= 0) return null;
    return this.charges.findById(origin.name, id);
  }

  /**
   * Claims (origin, ref, method) for a new attempt. Returns the record id, or a response when the reference is
   * already settled (the existing charge) or in flight.
   */
  private async claim(origin: Origin, ref: string, method: string, provider: string, seuNumero: string | null, amount: number,
    done: (c: ExternalCharge) => Promise<ExternalPaymentResponse> | ExternalPaymentResponse, settled: (c: ExternalCharge) => boolean,
  ): Promise<number | ExternalPaymentResponse> {
    const store = this.charges!;
    const by = `external:${origin.name}`;
    let charge = await store.find(origin.name, ref, method);
    if (charge && settled(charge)) return done(charge);
    if (charge && charge.Status === 'PENDING') {
      return { success: false, error: 'A charge for this reference is in progress; ask for its status', chargeId: charge.ID };
    }
    if (charge) {
      await store.update(charge.ID, { status: 'PENDING', amount, by });
      return charge.ID;
    }
    const id = await store.claim({ origin: origin.name, externalRef: ref, method, provider, seuNumero, amount, by });
    if (id !== null) return id;
    charge = await store.find(origin.name, ref, method);
    return charge && settled(charge) ? done(charge)
      : { success: false, error: 'A charge for this reference is in progress; ask for its status', chargeId: charge?.ID };
  }

  private async processBoleto(origin: Origin, ref: string, r: ExternalPaymentRequest): Promise<ExternalPaymentResponse> {
    if (!this.bancoInterGateway) return { success: false, error: 'Boleto gateway not configured' };
    let seuNumero: string;
    try { seuNumero = seuNumeroFor(origin, ref); } catch (e) { return { success: false, error: (e as Error).message }; }
    const by = `external:${origin.name}`;
    const c = await this.claim(origin, ref, 'boleto', 'inter', seuNumero, Number(r.amount),
      (x) => this.describeBoleto(x), (x) => !RETRYABLE.has(x.Status) && !!x.ProviderRef);
    if (typeof c !== 'number') return c;
    const dueDate = r.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate) ? r.dueDate
      : new Date(Date.now() + (origin.name === 'amode' ? 7 : 3) * 86400000).toISOString().split('T')[0];
    try {
      const res = await this.bancoInterGateway.createBoleto(r.payerName || '', r.payerCpfCnpj || '', Number(r.amount), dueDate,
        seuNumero, r.payerEmail || '', r.payerCep || undefined);
      if (!res.success || !res.nossoNumero) {
        await this.charges!.update(c, { status: 'FAILED', by });
        return { success: false, error: res.error || 'Boleto creation failed', chargeId: c };
      }
      await this.charges!.update(c, { providerRef: res.nossoNumero, status: 'A_RECEBER', by });
      return {
        success: true, chargeId: c, seuNumero, transactionId: res.nossoNumero, bankNossoNumero: res.bankNossoNumero ?? null,
        linhaDigitavel: res.linhaDigitavel, codigoBarras: res.codigoBarras, pixCopiaECola: res.pixCopiaECola, dueDate,
      };
    } catch (e) {
      await this.charges!.update(c, { status: 'FAILED', by }).catch(() => undefined);
      logger.error(`Boleto error (${origin.name} ${ref}): ${(e as Error).message}`);
      return { success: false, error: (e as Error).message, chargeId: c };
    }
  }

  /** The stored boleto with fresh details from Inter (the barcode may have appeared since it was issued). */
  private async describeBoleto(charge: ExternalCharge): Promise<ExternalPaymentResponse> {
    const raw = this.bancoInterGateway ? await this.bancoInterGateway.getBoletoDetails(charge.ProviderRef!) : null;
    const d = parseCobranca(raw);
    return {
      success: true, chargeId: charge.ID, seuNumero: charge.SeuNumero, transactionId: charge.ProviderRef,
      bankNossoNumero: d.bankNossoNumero, linhaDigitavel: d.linhaDigitavel, codigoBarras: d.codigoBarras,
      pixCopiaECola: d.pixCopiaECola, status: d.situacao || charge.Status,
    };
  }

  private async processPix(origin: Origin, ref: string, r: ExternalPaymentRequest): Promise<ExternalPaymentResponse> {
    if (!this.bancoInterGateway) return { success: false, error: 'PIX gateway not configured' };
    const by = `external:${origin.name}`;
    const c = await this.claim(origin, ref, 'pix', 'inter', null, Number(r.amount),
      (x) => ({ success: true, chargeId: x.ID, transactionId: x.ProviderRef, status: x.Status }),
      (x) => !RETRYABLE.has(x.Status) && !!x.ProviderRef);
    if (typeof c !== 'number') return c;
    const txid = pixTxidFor(origin, ref);
    try {
      const label = origin.name === 'amode' ? 'Amode' : origin.name;
      const res = await this.bancoInterGateway.createPixCobranca(r.payerName || `${label} Client`, r.payerCpfCnpj || '00000000000',
        Number(r.amount), `${origin.code}-${ref}`, `${label} - ${r.description || 'Pagamento'}`.substring(0, 140), txid);
      if (!res.success || !res.txid) {
        await this.charges!.update(c, { status: 'FAILED', by });
        return { success: false, error: res.error || 'PIX creation failed', chargeId: c };
      }
      await this.charges!.update(c, { providerRef: res.txid, status: 'ATIVA', by });
      return { success: true, chargeId: c, transactionId: res.txid, pixCopiaECola: res.pixCopiaECola, qrCodeBase64: res.qrCodeBase64 };
    } catch (e) {
      await this.charges!.update(c, { status: 'FAILED', by }).catch(() => undefined);
      logger.error(`PIX error (${origin.name} ${ref}): ${(e as Error).message}`);
      return { success: false, error: (e as Error).message, chargeId: c };
    }
  }

  /**
   * Card sales are always captured (owner, 2026-11-26). The card number and security code pass through and are
   * never stored or logged; Cielo's CardToken is stored as Cielo provides it when the caller asks to save the card
   * (card.saveCard) and comes back in the response, and a later charge may use it (card.token + securityCode +
   * brand). One reference is charged at most once.
   */
  private async processCard(origin: Origin, ref: string, r: ExternalPaymentRequest): Promise<ExternalPaymentResponse> {
    if (!this.cieloGateway) return { success: false, error: 'Credit card gateway not configured' };
    const card = r.card;
    if (!card || (!card.number && !card.token)) return { success: false, error: 'Card data required for credit_card method' };
    const by = `external:${origin.name}`;
    const c = await this.claim(origin, ref, 'credit_card', 'cielo', null, Number(r.amount),
      (x) => ({ success: true, chargeId: x.ID, transactionId: x.ProviderRef, status: x.Status, cardToken: x.CardToken ?? null }),
      (x) => CARD_TAKEN.has(x.Status));
    if (typeof c !== 'number') return c;
    try {
      const orderId = merchantOrderIdFor(origin, ref);
      const res = card.token
        ? await this.cieloGateway.createTransactionWithToken(orderId, r.payerName || origin.name, Number(r.amount),
          r.installments || 1, card.token, card.securityCode, card.brand)
        : await this.cieloGateway.createTransaction(orderId, r.payerName || origin.name, Number(r.amount), r.installments || 1, {
          cardNumber: card.number!.replace(/\s/g, ''), holder: card.holder!, expirationDate: card.expirationDate!,
          securityCode: card.securityCode, brand: card.brand,
        } as CieloCardData, !!card.saveCard);
      // 2 = PaymentConfirmed (captured). 1 = authorized but not captured: recorded as such so it is visible.
      const status = res.success ? (res.status === 2 ? 'PAID' : 'AUTHORIZED') : 'DENIED';
      const cardToken = res.cardToken ?? card.token ?? null;
      await this.charges!.update(c, {
        providerRef: res.paymentId || res.tid, status, ...(status === 'PAID' ? { paidAt: new Date() } : {}),
        ...(cardToken ? { cardToken } : {}), by,
      });
      if (status === 'AUTHORIZED') logger.warn(`Card ${orderId} authorized but not captured (Cielo status ${res.status})`);
      return {
        success: res.success, chargeId: c, transactionId: res.tid, authorizationCode: res.authorizationCode,
        returnCode: res.returnCode, status, cardToken, error: res.success ? undefined : (res.returnMessage || 'Transaction denied'),
      };
    } catch (e) {
      // Unknown outcome: keep it PENDING so a retry does not charge twice; the owner checks the Cielo portal.
      logger.error(`Card error (${origin.name} ${ref}): ${(e as Error).message}`);
      return { success: false, error: (e as Error).message, chargeId: c };
    }
  }

  private async recordedStatus(origin: Origin, body: { chargeId?: number; externalRef?: string; method?: string }): Promise<ExternalStatusResponse> {
    if (!this.charges) return { paid: false, status: 'registry_not_configured' };
    const charge = body.chargeId !== undefined
      ? await this.ownCharge(origin, Number(body.chargeId))
      : await this.charges.find(origin.name, String(body.externalRef), body.method || 'boleto');
    if (!charge) return { paid: false, status: 'not_found' };
    const base = { chargeId: charge.ID, method: charge.Method };
    if (!charge.ProviderRef || charge.Method === 'credit_card') {
      return { ...base, paid: charge.Status === 'PAID' || charge.Status === 'AUTHORIZED', status: charge.Status, paidAt: charge.PaidAt };
    }
    if (FINAL.has(charge.Status) || charge.Status === 'CONCLUIDA') {
      return { ...base, paid: isCobrancaPaid(charge.Status) || charge.Status === 'CONCLUIDA', status: charge.Status, paidAt: charge.PaidAt };
    }
    if (!this.bancoInterGateway) return { ...base, paid: false, status: 'gateway_not_configured' };
    let s: { paid: boolean; situacao: string };
    let details: ExternalStatusResponse['details'];
    if (charge.Method === 'pix') {
      s = await this.bancoInterGateway.checkPixStatus(charge.ProviderRef).then(x => ({ paid: x.paid, situacao: x.status }));
    } else {
      // One read gives the status and the boleto/Pix details (the barcode may appear after issuing).
      const raw = await this.bancoInterGateway.getBoletoDetails(charge.ProviderRef);
      const d = parseCobranca(raw);
      s = raw ? { paid: isCobrancaPaid(d.situacao), situacao: d.situacao } : { paid: false, situacao: 'UNKNOWN' };
      if (raw) {
        details = { codigoSolicitacao: charge.ProviderRef, seuNumero: charge.SeuNumero, bankNossoNumero: d.bankNossoNumero,
          linhaDigitavel: d.linhaDigitavel, codigoBarras: d.codigoBarras, pixCopiaECola: d.pixCopiaECola, txid: d.txid };
      }
    }
    if (s.situacao && !['UNKNOWN', 'ERROR', ''].includes(s.situacao) && s.situacao !== charge.Status) {
      const paidAt = s.paid ? new Date() : undefined;
      await this.charges.update(charge.ID, { status: s.situacao, ...(paidAt ? { paidAt } : {}), by: `external:${origin.name}` });
      return { ...base, paid: s.paid, status: s.situacao, paidAt: paidAt ?? null, details };
    }
    return { ...base, paid: s.paid, status: s.situacao, paidAt: charge.PaidAt, details };
  }
}

// ── Types ─────────────────────────────────────────────────────

export interface ExternalPaymentRequest {
  /** Amode tenant ID (for tracking only; never an identity) */
  tenantId?: string;
  /** The caller's own reference (Hipno Online: the Magento order number). Required except for Amode. */
  externalRef?: string;
  /** Payment method: 'boleto', 'pix', 'credit_card' (as allowed for the origin) */
  method: string;
  /** Amount in BRL (e.g., 99.00) */
  amount: number;
  /** Description shown to payer */
  description?: string;
  /** Boleto due date, YYYY-MM-DD (default today + 3 days; Amode + 7) */
  dueDate?: string;
  payerName?: string;
  payerCpfCnpj?: string;
  payerEmail?: string;
  payerCep?: string;
  /** A new card (number, holder, expirationDate; saveCard asks Cielo for a CardToken) or a saved one (token). */
  card?: { number?: string; holder?: string; expirationDate?: string; securityCode: string; brand: string; saveCard?: boolean; token?: string };
  installments?: number;
}

export interface ExternalPaymentResponse {
  success: boolean;
  /** tbExternalCharges.ID */
  chargeId?: number;
  seuNumero?: string | null;
  transactionId?: string | null;
  bankNossoNumero?: string | null;
  status?: string;
  dueDate?: string;
  pixCopiaECola?: string | null;
  qrCodeBase64?: string | null;
  authorizationCode?: string | null;
  returnCode?: string | null;
  /** Cielo CardToken of a saved card */
  cardToken?: string | null;
  linhaDigitavel?: string | null;
  codigoBarras?: string | null;
  error?: string;
}

export interface ExternalStatusResponse {
  paid: boolean;
  status: string;
  chargeId?: number;
  method?: string;
  paidAt?: Date | null;
  /** Boleto: what the payer needs, fresh from Inter */
  details?: {
    codigoSolicitacao: string | null; seuNumero: string | null; bankNossoNumero: string | null; linhaDigitavel: string | null;
    codigoBarras: string | null; pixCopiaECola: string | null; txid: string | null;
  };
}
