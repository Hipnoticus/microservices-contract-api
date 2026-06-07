import { Controller, Post, Body, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CieloGateway, CieloCardData } from '../../../infrastructure/payment/CieloGateway';
import { BancoInterGateway } from '../../../infrastructure/payment/BancoInterGateway';
import { Logger } from '../../../shared/logger/Logger';

const logger = new Logger('ExternalPaymentController');

/**
 * External B2B payment endpoint for Amode platform.
 * Processes payment transactions loosely — just runs the charge through
 * Cielo/BancoInter and returns the raw result. The calling service (Amode)
 * handles its own business rules (subscription activation, etc.).
 *
 * No Hipnoticus orders are created — this is purely a payment gateway proxy.
 */
@ApiTags('External Payments (B2B)')
@Controller('payments/external')
export class ExternalPaymentController {
  constructor(
    @Inject('CIELO_GATEWAY') private readonly cieloGateway: CieloGateway | null,
    @Inject('BANCO_INTER_GATEWAY') private readonly bancoInterGateway: BancoInterGateway | null,
  ) {}

  @Post('process')
  @ApiOperation({ summary: 'Process external B2B payment (Amode → ContractAPI → Cielo/BancoInter)' })
  async processExternal(@Body() req: ExternalPaymentRequest): Promise<ExternalPaymentResponse> {
    logger.info(`External payment: method=${req.method} amount=${req.amount} tenant=${req.tenantId}`);

    // Validate minimum amount
    if (req.amount <= 0) {
      return { success: false, error: 'Invalid amount' };
    }

    switch (req.method) {
      case 'pix':
        return this.processPix(req);
      case 'credit_card':
        return this.processCreditCard(req);
      case 'boleto':
        return this.processBoleto(req);
      default:
        return { success: false, error: `Unknown payment method: ${req.method}` };
    }
  }

  @Post('status')
  @ApiOperation({ summary: 'Check PIX payment status by txid (Amode polls this)' })
  async checkStatus(@Body() body: { txid: string }): Promise<{ paid: boolean; status: string }> {
    if (!this.bancoInterGateway) {
      return { paid: false, status: 'gateway_not_configured' };
    }
    if (!body.txid) {
      return { paid: false, status: 'missing_txid' };
    }
    try {
      return await this.bancoInterGateway.checkPixStatus(body.txid);
    } catch (e) {
      logger.error(`External status check error: ${(e as Error).message}`);
      return { paid: false, status: 'error' };
    }
  }

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
      const orderId = `AMODE-${Date.now()}`;

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
  /** Amode tenant ID (for tracking) */
  tenantId: string;
  /** Payment method: 'pix', 'credit_card', 'boleto' */
  method: string;
  /** Amount in BRL (e.g., 99.00) */
  amount: number;
  /** Description shown to payer */
  description?: string;
  /** Payer info */
  payerName?: string;
  payerCpfCnpj?: string;
  payerEmail?: string;
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
  transactionId?: string | null;
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
