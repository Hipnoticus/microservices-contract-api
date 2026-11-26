import { Controller, Post, Get, Body, Param, Req, Inject, Optional, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CieloGateway, CieloCardData } from '../../../infrastructure/payment/CieloGateway';
import { BancoInterGateway, parseCobranca, isCobrancaPaid } from '../../../infrastructure/payment/BancoInterGateway';
import { EXTERNAL_REF, FINAL, RETRYABLE, originOf, seuNumeroFor } from '../../../application/payment/ExternalCharges';
import type { ExternalCharge, ExternalChargeStore, Origin } from '../../../application/payment/ExternalCharges';
import { Logger } from '../../../shared/logger/Logger';

const logger = new Logger('ExternalPaymentController');

/**
 * External B2B payment endpoint for other applications: Amode (through the gateway, service credential) and Hipno
 * Online (direct caller "hipno-online"). The charge goes through Cielo/BancoInter and the raw result comes back; the
 * calling application keeps its own business rules (subscription activation, order states).
 *
 * No Hipnoticus orders are created. Every request must say who it is (originOf): the origin decides the seuNumero
 * prefix and which charges the caller may read. Hipno Online charges are recorded in tbExternalCharges by the
 * caller's own order reference, so a retry returns the same boleto instead of issuing a second one.
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

  @Post('process')
  @ApiOperation({ summary: 'Process external B2B payment (Amode or Hipno Online -> ContractAPI -> Cielo/BancoInter)' })
  async processExternal(@Req() req: any, @Body() body: ExternalPaymentRequest): Promise<ExternalPaymentResponse> {
    const origin = this.origin(req);
    const r: ExternalPaymentRequest = body || ({} as ExternalPaymentRequest);
    logger.info(`External payment: origin=${origin.name} method=${r.method} amount=${r.amount} ref=${r.externalRef ?? r.tenantId ?? '-'}`);
    if (!(Number(r.amount) > 0)) {
      return { success: false, error: 'Invalid amount' };
    }
    if (origin.name !== 'amode') {
      // Hipno Online: boleto (with its Pix) only, always by its own order reference.
      if (r.method !== 'boleto') return { success: false, error: `Method ${r.method} is not available for ${origin.name}` };
      if (!r.externalRef || !EXTERNAL_REF.test(r.externalRef)) return { success: false, error: 'externalRef required (letters, digits, -)' };
      return this.processRecordedBoleto(origin, r);
    }
    switch (r.method) {
      case 'pix':
        return this.processPix(r);
      case 'credit_card':
        return this.processCreditCard(r);
      case 'boleto':
        return this.processBoleto(r);
      default:
        return { success: false, error: `Unknown payment method: ${r.method}` };
    }
  }

  @Post('status')
  @ApiOperation({ summary: 'Status of an external charge: { chargeId } or { externalRef, method }, or a PIX { txid } (Amode)' })
  async checkStatus(@Req() req: any, @Body() body: { txid?: string; chargeId?: number; externalRef?: string; method?: string }): Promise<ExternalStatusResponse> {
    const origin = this.origin(req);
    if (!this.bancoInterGateway) {
      return { paid: false, status: 'gateway_not_configured' };
    }
    if (body?.chargeId !== undefined || body?.externalRef) {
      return this.recordedStatus(origin, body);
    }
    if (origin.name !== 'amode') return { paid: false, status: 'missing_charge' };
    if (!body?.txid) {
      return { paid: false, status: 'missing_txid' };
    }
    try {
      return await this.bancoInterGateway.checkPixStatus(body.txid);
    } catch (e) {
      logger.error(`External status check error: ${(e as Error).message}`);
      return { paid: false, status: 'error' };
    }
  }

  @Get('charges/:id/pdf')
  @ApiOperation({ summary: "Boleto PDF (base64) of one of the caller's own recorded charges" })
  async chargePdf(@Req() req: any, @Param('id') id: string): Promise<{ pdf: string | null; error?: string }> {
    const origin = this.origin(req);
    const charge = await this.ownCharge(origin, Number(id));
    if (!charge || charge.Method !== 'boleto' || !charge.ProviderRef) return { pdf: null, error: 'not_found' };
    if (!this.bancoInterGateway) return { pdf: null, error: 'gateway_not_configured' };
    return { pdf: await this.bancoInterGateway.getBoletoPdf(charge.ProviderRef) };
  }

  // ---------------------------------------------------------------- recorded charges (Hipno Online)

  private async ownCharge(origin: Origin, id: number): Promise<ExternalCharge | null> {
    if (!this.charges || !Number.isInteger(id) || id <= 0) return null;
    return this.charges.findById(origin.name, id);
  }

  private async processRecordedBoleto(origin: Origin, r: ExternalPaymentRequest): Promise<ExternalPaymentResponse> {
    if (!this.bancoInterGateway) return { success: false, error: 'Boleto gateway not configured' };
    if (!this.charges) return { success: false, error: 'External charges registry not configured' };
    const ref = r.externalRef!;
    let seuNumero: string;
    try { seuNumero = seuNumeroFor(origin, ref); } catch (e) { return { success: false, error: (e as Error).message }; }
    const by = `external:${origin.name}`;

    let charge = await this.charges.find(origin.name, ref, 'boleto');
    if (charge && !RETRYABLE.has(charge.Status) && charge.ProviderRef) {
      // Same order asked again: the boleto already issued, never a second one.
      return this.describeBoleto(charge);
    }
    if (charge && charge.Status === 'PENDING' && !charge.ProviderRef) {
      return { success: false, error: 'A boleto for this reference is being issued; ask for its status', chargeId: charge.ID };
    }
    let id: number;
    if (charge) {
      id = charge.ID; // FAILED earlier: try again under the same record
      await this.charges.update(id, { status: 'PENDING', amount: Number(r.amount), by });
    } else {
      const claimed = await this.charges.claim({ origin: origin.name, externalRef: ref, method: 'boleto', provider: 'inter', seuNumero, amount: Number(r.amount), by });
      if (claimed === null) {
        charge = await this.charges.find(origin.name, ref, 'boleto');
        return charge?.ProviderRef ? this.describeBoleto(charge) : { success: false, error: 'A boleto for this reference is being issued; ask for its status', chargeId: charge?.ID };
      }
      id = claimed;
    }

    const dueDate = r.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate) ? r.dueDate : new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
    try {
      const result = await this.bancoInterGateway.createBoleto(
        r.payerName || '', r.payerCpfCnpj || '', Number(r.amount), dueDate, seuNumero, r.payerEmail || '', r.payerCep || undefined,
      );
      if (!result.success || !result.nossoNumero) {
        await this.charges.update(id, { status: 'FAILED', by });
        return { success: false, error: result.error || 'Boleto creation failed', chargeId: id };
      }
      await this.charges.update(id, { providerRef: result.nossoNumero, status: 'A_RECEBER', by });
      return {
        success: true,
        chargeId: id,
        seuNumero,
        transactionId: result.nossoNumero,
        bankNossoNumero: result.bankNossoNumero ?? null,
        linhaDigitavel: result.linhaDigitavel,
        codigoBarras: result.codigoBarras,
        pixCopiaECola: result.pixCopiaECola,
        dueDate,
      };
    } catch (e) {
      await this.charges.update(id, { status: 'FAILED', by }).catch(() => undefined);
      logger.error(`Recorded boleto error (${origin.name} ${ref}): ${(e as Error).message}`);
      return { success: false, error: (e as Error).message, chargeId: id };
    }
  }

  /** The stored boleto with fresh details from Inter (the barcode may have appeared since it was issued). */
  private async describeBoleto(charge: ExternalCharge): Promise<ExternalPaymentResponse> {
    const raw = this.bancoInterGateway ? await this.bancoInterGateway.getBoletoDetails(charge.ProviderRef!) : null;
    const d = parseCobranca(raw);
    return {
      success: true,
      chargeId: charge.ID,
      seuNumero: charge.SeuNumero,
      transactionId: charge.ProviderRef,
      bankNossoNumero: d.bankNossoNumero,
      linhaDigitavel: d.linhaDigitavel,
      codigoBarras: d.codigoBarras,
      pixCopiaECola: d.pixCopiaECola,
      status: d.situacao || charge.Status,
    };
  }

  private async recordedStatus(origin: Origin, body: { chargeId?: number; externalRef?: string; method?: string }): Promise<ExternalStatusResponse> {
    if (!this.charges) return { paid: false, status: 'registry_not_configured' };
    const charge = body.chargeId !== undefined
      ? await this.ownCharge(origin, Number(body.chargeId))
      : await this.charges.find(origin.name, String(body.externalRef), body.method || 'boleto');
    if (!charge) return { paid: false, status: 'not_found' };
    if (!charge.ProviderRef) return { paid: false, status: charge.Status, chargeId: charge.ID };
    if (FINAL.has(charge.Status)) {
      return { paid: isCobrancaPaid(charge.Status), status: charge.Status, chargeId: charge.ID, paidAt: charge.PaidAt };
    }
    const s = await this.bancoInterGateway!.checkBoletoStatus(charge.ProviderRef);
    if (s.situacao && s.situacao !== 'UNKNOWN' && s.situacao !== 'ERROR' && s.situacao !== charge.Status) {
      const paidAt = s.paid ? new Date() : undefined;
      await this.charges.update(charge.ID, { status: s.situacao, ...(paidAt ? { paidAt } : {}), by: `external:${origin.name}` });
      return { paid: s.paid, status: s.situacao, chargeId: charge.ID, paidAt: paidAt ?? null };
    }
    return { paid: s.paid, status: s.situacao, chargeId: charge.ID, paidAt: charge.PaidAt };
  }

  // ---------------------------------------------------------------- Amode (unchanged behaviour)

  private async processPix(req: ExternalPaymentRequest): Promise<ExternalPaymentResponse> {
    if (!this.bancoInterGateway) {
      return { success: false, error: 'PIX gateway not configured' };
    }
    try {
      const orderId = `AMODE-${Date.now()}`;
      const result = await this.bancoInterGateway.createPixCobranca(
        req.payerName || 'Amode Client',
        req.payerCpfCnpj || '00000000000',
        req.amount,
        orderId,
        `Amode - ${req.description || 'Assinatura'}`,
      );
      if (result.success) {
        return {
          success: true,
          transactionId: result.txid,
          pixCopiaECola: result.pixCopiaECola,
          qrCodeBase64: result.qrCodeBase64,
        };
      }
      return { success: false, error: result.error || 'PIX creation failed' };
    } catch (e) {
      logger.error(`PIX external error: ${(e as Error).message}`);
      return { success: false, error: (e as Error).message };
    }
  }

  private async processCreditCard(req: ExternalPaymentRequest): Promise<ExternalPaymentResponse> {
    if (!this.cieloGateway) {
      return { success: false, error: 'Credit card gateway not configured' };
    }
    if (!req.card) {
      return { success: false, error: 'Card data required for credit_card method' };
    }
    try {
      const orderId = `AMODE-${Date.now()}`;
      const cardData: CieloCardData = {
        cardNumber: req.card.number.replace(/\s/g, ''),
        holder: req.card.holder,
        expirationDate: req.card.expirationDate,
        securityCode: req.card.securityCode,
        brand: req.card.brand,
      };
      const result = await this.cieloGateway.createTransaction(
        orderId,
        req.payerName || 'Amode Client',
        req.amount,
        req.installments || 1,
        cardData,
      );
      return {
        success: result.success,
        transactionId: result.tid,
        authorizationCode: result.authorizationCode,
        returnCode: result.returnCode,
        error: result.success ? undefined : (result.returnMessage || 'Transaction denied'),
      };
    } catch (e) {
      logger.error(`Credit card external error: ${(e as Error).message}`);
      return { success: false, error: (e as Error).message };
    }
  }

  private async processBoleto(req: ExternalPaymentRequest): Promise<ExternalPaymentResponse> {
    if (!this.bancoInterGateway) {
      return { success: false, error: 'Boleto gateway not configured' };
    }
    try {
      const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]; // 7 days
      const orderId = `AM${Date.now()}`; // Inter seuNumero: at most 15 characters
      const result = await this.bancoInterGateway.createBoleto(
        req.payerName || 'Amode Client',
        req.payerCpfCnpj || '',
        req.amount,
        dueDate,
        orderId,
        req.payerEmail || '',
      );
      if (result.success) {
        return {
          success: true,
          transactionId: result.nossoNumero,
          linhaDigitavel: result.linhaDigitavel,
          codigoBarras: result.codigoBarras,
          pixCopiaECola: result.pixCopiaECola, // Hybrid boleto+PIX
        };
      }
      return { success: false, error: result.error || 'Boleto creation failed' };
    } catch (e) {
      logger.error(`Boleto external error: ${(e as Error).message}`);
      return { success: false, error: (e as Error).message };
    }
  }
}

// ── Types ─────────────────────────────────────────────────────

export interface ExternalPaymentRequest {
  /** Amode tenant ID (for tracking only; never an identity) */
  tenantId?: string;
  /** The caller's own order reference (Hipno Online: the Magento order number). Required for Hipno Online. */
  externalRef?: string;
  /** Payment method: 'pix', 'credit_card', 'boleto' */
  method: string;
  /** Amount in BRL (e.g., 99.00) */
  amount: number;
  /** Description shown to payer */
  description?: string;
  /** Boleto due date, YYYY-MM-DD (Hipno Online; default today + 3 days) */
  dueDate?: string;
  /** Payer info */
  payerName?: string;
  payerCpfCnpj?: string;
  payerEmail?: string;
  payerCep?: string;
  /** Credit card specific */
  card?: {
    number: string;
    holder: string;
    expirationDate: string; // MM/YYYY
    securityCode: string;
    brand: string; // Visa, Master, Elo
  };
  /** Installments (credit card only, default 1) */
  installments?: number;
}

export interface ExternalPaymentResponse {
  success: boolean;
  /** tbExternalCharges.ID of a recorded charge (Hipno Online) */
  chargeId?: number;
  seuNumero?: string | null;
  transactionId?: string | null;
  bankNossoNumero?: string | null;
  status?: string;
  dueDate?: string;
  /** PIX */
  pixCopiaECola?: string | null;
  qrCodeBase64?: string | null;
  /** Credit card */
  authorizationCode?: string | null;
  returnCode?: string | null;
  /** Boleto */
  linhaDigitavel?: string | null;
  codigoBarras?: string | null;
  /** Error */
  error?: string;
}

export interface ExternalStatusResponse {
  paid: boolean;
  status: string;
  chargeId?: number;
  paidAt?: Date | null;
}
