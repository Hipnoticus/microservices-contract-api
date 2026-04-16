/**
 * ProcessPaymentUseCase — Orchestrates payment processing after order creation.
 *
 * Flow (mirrors legacy PedidoProcessa):
 *  1. Order is created with status "Pagamento Pendente" (9)
 *  2. Based on payment method, call the appropriate gateway
 *  3. Update order with payment identifier/registry
 *  4. If credit card is authorized, update status
 *  5. For boleto/PIX, return payment data to frontend
 */
import { CieloGateway, CieloCardData, CieloTransactionResult } from '../../infrastructure/payment/CieloGateway';
import { BancoInterGateway, BoletoResult, PixCobrancaResult } from '../../infrastructure/payment/BancoInterGateway';
import { IOrderRepository } from '../../domain/repositories/IOrderRepository';
import { SendConfirmationEmailUseCase, EmailContext } from './SendConfirmationEmailUseCase';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('ProcessPaymentUseCase');

export interface PaymentRequest {
  orderId: number;
  paymentMethodIdExt: string; // 'cc-cielo', 'inter-boleto', 'pix', 'pix-direto', 'deptransf'
  customerName: string;
  customerCpf: string;
  customerEmail: string;
  customerPhone?: string;
  customerBirthDate?: string;
  amount: number;
  installments: number;
  testMode?: boolean; // ?Teste=1 from legacy
  packageSize?: number;
  mainGoal?: string;
  firstAppointmentDay?: string;
  firstAppointmentHour?: string;
  sessionDay?: string;
  sessionHour?: string;
  // Address
  address?: {
    cep?: string;
    street?: string;
    number?: string;
    complement?: string;
    neighborhood?: string;
    city?: string;
    state?: string;
  };
  // Credit card fields (only for cc-cielo)
  card?: {
    number: string;
    holder: string;
    expirationDate: string; // MM/YYYY
    securityCode: string;
    brand: string;
  };
}

export interface PaymentResponse {
  success: boolean;
  method: string;
  orderId: number;
  // Credit card
  authorized?: boolean;
  tid?: string | null;
  authorizationCode?: string | null;
  // Boleto
  nossoNumero?: string | null;
  linhaDigitavel?: string | null;
  codigoBarras?: string | null;
  boletoUrl?: string | null;
  // PIX
  txid?: string | null;
  pixCopiaECola?: string | null;
  // Manual
  instructions?: string;
  // Error
  error?: string | null;
}

export class ProcessPaymentUseCase {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly cieloGateway: CieloGateway | null,
    private readonly bancoInterGateway: BancoInterGateway | null,
    private readonly sequelize?: any,
    private readonly sendEmailUseCase?: SendConfirmationEmailUseCase | null,
  ) {}

  async execute(req: PaymentRequest): Promise<PaymentResponse> {
    // Test mode: if customer email matches test email in tbConfig,
    // override amount to test value (legacy: orders.transaction.test.email / orders.transaction.test.value)
    let effectiveAmount = req.amount;
    if (req.testMode || req.customerEmail) {
      try {
        const testConfig = await this.loadTestConfig();
        if (req.testMode || (testConfig.testEmail && req.customerEmail === testConfig.testEmail)) {
          const isBoletoPix = ['inter-boleto', 'pix'].includes(req.paymentMethodIdExt);
          effectiveAmount = isBoletoPix ? testConfig.testValueBoleto : testConfig.testValue;
          logger.info(`TEST MODE: overriding amount from ${req.amount} to ${effectiveAmount} for ${req.customerEmail}`);
        }
      } catch (e) { logger.error(`Test config load failed: ${(e as Error).message}`); }
    }

    logger.info(`Processing payment: order=${req.orderId} method=${req.paymentMethodIdExt} amount=${effectiveAmount}`);

    const effectiveReq = { ...req, amount: effectiveAmount };

    switch (req.paymentMethodIdExt) {
      case 'cc-cielo':
      case 'cc-stone':
        return this.processCreditCard(effectiveReq);
      case 'inter-boleto':
        return this.processBoleto(effectiveReq);
      case 'pix':
        return this.processPix(effectiveReq);
      case 'pix-direto':
      case 'deptransf':
        return this.processManual(effectiveReq);
      default:
        return this.processManual(effectiveReq);
    }
  }

  private async loadTestConfig(): Promise<{ testEmail: string; testValue: number; testValueBoleto: number }> {
    if (!this.sequelize) return { testEmail: '', testValue: 0.01, testValueBoleto: 1.00 };

    const { QueryTypes } = require('sequelize');
    const rows = await this.sequelize.query(
      `SELECT Name, Value FROM tbConfig WHERE Name LIKE 'orders.transaction.test%'`,
      { type: QueryTypes.SELECT },
    ) as any[];

    const cfg: Record<string, string> = {};
    for (const r of rows) {
      if (r?.Name) cfg[r.Name] = (r.Value || '').replace(/<\/?p>/g, '').trim();
    }

    return {
      testEmail: cfg['orders.transaction.test.email'] || '',
      testValue: parseFloat((cfg['orders.transaction.test.value'] || '0,01').replace(',', '.')) || 0.01,
      testValueBoleto: parseFloat((cfg['orders.transaction.test.value_boleto'] || '1,00').replace(',', '.')) || 1.00,
    };
  }

  private async processCreditCard(req: PaymentRequest): Promise<PaymentResponse> {
    if (!this.cieloGateway) {
      return { success: false, method: 'cc-cielo', orderId: req.orderId, error: 'Cielo gateway not configured' };
    }
    if (!req.card) {
      return { success: false, method: 'cc-cielo', orderId: req.orderId, error: 'Card data required' };
    }

    const cardData: CieloCardData = {
      cardNumber: req.card.number,
      holder: req.card.holder,
      expirationDate: req.card.expirationDate,
      securityCode: req.card.securityCode,
      brand: req.card.brand,
    };

    const result: CieloTransactionResult = await this.cieloGateway.createTransaction(
      String(req.orderId), req.customerName, req.amount, req.installments, cardData,
    );

    // In test mode, treat any Cielo response with a TID as authorized
    // (the card may be declined due to insufficient funds, but the flow should complete)
    const isTestApproved = req.testMode && result.tid;
    if (isTestApproved && !result.success) {
      logger.info(`TEST MODE: auto-approving denied transaction tid=${result.tid} (original: ${result.statusMessage})`);
    }
    const effectiveSuccess = result.success || !!isTestApproved;

    // Update order with payment identifiers
    if (result.tid || result.authorizationCode) {
      try {
        await this.orderRepository.updatePayment(
          req.orderId,
          result.authorizationCode || result.tid || '',
          result.tid || '',
        );
      } catch (e) { logger.warn(`Could not update payment for order ${req.orderId}`); }
    }

    // If authorized (or test-approved), update order status
    if (effectiveSuccess) {
      try {
        await this.orderRepository.updateStatus(req.orderId, 2); // Em Análise (paid)
      } catch (e) { logger.warn(`Could not update status for order ${req.orderId}`); }
    }

    const ccResponse: PaymentResponse = {
      success: effectiveSuccess,
      method: 'cc-cielo',
      orderId: req.orderId,
      authorized: effectiveSuccess,
      tid: result.tid,
      authorizationCode: result.authorizationCode || (isTestApproved ? 'TEST-APPROVED' : null),
      error: effectiveSuccess ? null : `${result.statusMessage}: ${result.returnMessage || ''}`,
    };

    // Send confirmation emails (fire-and-forget)
    if (effectiveSuccess) {
      this.sendEmails(req, ccResponse).catch(e => logger.warn(`Email send failed: ${e.message}`));
    }

    return ccResponse;
  }

  private async processBoleto(req: PaymentRequest): Promise<PaymentResponse> {
    if (!this.bancoInterGateway) {
      return { success: false, method: 'inter-boleto', orderId: req.orderId, error: 'Banco Inter gateway not configured' };
    }

    // Due date: 3 business days from now
    const due = new Date();
    due.setDate(due.getDate() + 3);
    while (due.getDay() === 0 || due.getDay() === 6) due.setDate(due.getDate() + 1);
    const dueStr = due.toISOString().split('T')[0];

    const result: BoletoResult = await this.bancoInterGateway.createBoleto(
      req.customerName, req.customerCpf, req.amount, dueStr, String(req.orderId),
      req.customerEmail, req.address?.cep,
    );

    // Test mode fallback: if boleto creation failed but we're in test mode,
    // return mock data so the UI flow can be tested end-to-end
    if (!result.success && req.testMode) {
      logger.info(`TEST MODE: boleto creation failed (${result.error}), returning mock boleto data`);
      const mockNossoNumero = `TEST-${req.orderId}-${Date.now()}`;
      const mockLinhaDigitavel = '07099.63532 40000.000004 00000.000408 1 10000000000250';
      const mockPixCopiaECola = this.generatePixPayload(req.amount, String(req.orderId));

      try {
        await this.orderRepository.updatePayment(req.orderId, mockNossoNumero, mockLinhaDigitavel);
      } catch (e) { /* ignore in test mode */ }

      const response: PaymentResponse = {
        success: true,
        method: 'inter-boleto',
        orderId: req.orderId,
        nossoNumero: mockNossoNumero,
        linhaDigitavel: mockLinhaDigitavel,
        codigoBarras: '07091100000002500996353240000000000000000040810000',
        boletoUrl: `/contract-service/payments/boleto-pdf/${mockNossoNumero}`,
        pixCopiaECola: mockPixCopiaECola,
        txid: `TEST-PIX-${req.orderId}`,
        error: null,
      };

      this.sendEmails(req, response).catch(e => logger.warn(`Email send failed: ${e.message}`));
      return response;
    }

    // Try to get the boleto PDF URL
    let boletoPdfBase64: string | null = null;
    if (result.success && result.nossoNumero) {
      try {
        await this.orderRepository.updatePayment(req.orderId, result.nossoNumero, result.linhaDigitavel || '');
      } catch (e) { logger.warn(`Could not update payment for order ${req.orderId}`); }

      try {
        boletoPdfBase64 = await this.bancoInterGateway.getBoletoPdf(result.nossoNumero);
      } catch (e) { logger.warn(`Could not fetch boleto PDF for nossoNumero=${result.nossoNumero}`); }
    }

    // If the boleto response didn't include PIX data, create a standalone PIX cobrança
    let pixCopiaECola = result.pixCopiaECola;
    let pixTxid = result.pixTxid;
    if (result.success && !pixCopiaECola) {
      try {
        logger.info(`Boleto didn't include PIX — creating standalone PIX cobrança for order ${req.orderId}`);
        const pixResult = await this.bancoInterGateway.createPixCobranca(
          req.customerName, req.customerCpf, req.amount, String(req.orderId),
          `Hipnoticus - Pedido ${req.orderId}`,
        );
        logger.info(`PIX cobrança result for order ${req.orderId}: success=${pixResult.success} txid=${pixResult.txid} pixCopiaECola=${pixResult.pixCopiaECola ? 'present(' + pixResult.pixCopiaECola.length + ' chars)' : 'null'} error=${pixResult.error}`);
        if (pixResult.success) {
          pixCopiaECola = pixResult.pixCopiaECola;
          pixTxid = pixResult.txid;
        } else {
          logger.warn(`PIX creation failed for order ${req.orderId}: ${pixResult.error}`);
          // Fallback: generate a static PIX Copia e Cola using the CNPJ key
          pixCopiaECola = this.generatePixPayload(req.amount, String(req.orderId));
          pixTxid = `static-${req.orderId}`;
          logger.info(`Generated static PIX payload for order ${req.orderId}`);
        }
      } catch (e) {
        logger.error(`PIX creation exception for order ${req.orderId}: ${(e as Error).message}`);
        // Fallback: generate a static PIX Copia e Cola
        pixCopiaECola = this.generatePixPayload(req.amount, String(req.orderId));
        pixTxid = `static-${req.orderId}`;
      }
    }

    // Build boleto URL for the frontend/email
    const boletoUrl = result.nossoNumero
      ? `/contract-service/payments/boleto-pdf/${result.nossoNumero}`
      : null;

    logger.info(`Boleto response for order ${req.orderId}: nossoNumero=${result.nossoNumero} linhaDigitavel=${result.linhaDigitavel ? 'present' : 'null'} pixCopiaECola=${pixCopiaECola ? 'present(' + pixCopiaECola.length + ' chars)' : 'null'} boletoUrl=${boletoUrl}`);

    const response: PaymentResponse = {
      success: result.success,
      method: 'inter-boleto',
      orderId: req.orderId,
      nossoNumero: result.nossoNumero,
      linhaDigitavel: result.linhaDigitavel,
      codigoBarras: result.codigoBarras,
      boletoUrl,
      pixCopiaECola,
      txid: pixTxid,
      error: result.error,
    };

    // Send confirmation emails (fire-and-forget)
    if (result.success) {
      this.sendEmails(req, response).catch(e => logger.warn(`Email send failed: ${e.message}`));
    }

    return response;
  }

  private async processPix(req: PaymentRequest): Promise<PaymentResponse> {
    if (!this.bancoInterGateway) {
      return { success: false, method: 'pix', orderId: req.orderId, error: 'Banco Inter PIX gateway not configured' };
    }

    const result: PixCobrancaResult = await this.bancoInterGateway.createPixCobranca(
      req.customerName, req.customerCpf, req.amount, String(req.orderId),
    );

    if (result.success && result.txid) {
      try {
        await this.orderRepository.updatePayment(req.orderId, result.txid, result.pixCopiaECola || '');
      } catch (e) { logger.warn(`Could not update payment for order ${req.orderId}`); }
    }

    const pixResponse: PaymentResponse = {
      success: result.success,
      method: 'pix',
      orderId: req.orderId,
      txid: result.txid,
      pixCopiaECola: result.pixCopiaECola,
      error: result.error,
    };

    if (result.success) {
      this.sendEmails(req, pixResponse).catch(e => logger.warn(`Email send failed: ${e.message}`));
    }

    return pixResponse;
  }

  private async processManual(req: PaymentRequest): Promise<PaymentResponse> {
    const identifier = `${req.paymentMethodIdExt} À Vista`;
    try {
      await this.orderRepository.updatePayment(req.orderId, identifier, identifier);
    } catch (e) {
      logger.warn(`Could not update payment for order ${req.orderId}: ${(e as Error).message}`);
    }

    const instructions = req.paymentMethodIdExt === 'pix-direto'
      ? 'Realize o PIX para a chave informada e envie o comprovante para contato@hipnoterapia.org'
      : 'Realize o depósito/transferência e envie o comprovante para contato@hipnoterapia.org';

    const manualResponse: PaymentResponse = {
      success: true,
      method: req.paymentMethodIdExt,
      orderId: req.orderId,
      instructions,
    };

    this.sendEmails(req, manualResponse).catch(e => logger.warn(`Email send failed: ${e.message}`));

    return manualResponse;
  }

  /**
   * Generate a static PIX Copia e Cola payload (BR Code / EMV format).
   * Used as fallback when the Banco Inter PIX API is unavailable.
   * PIX key: CNPJ 12344385000193 (Hipnoticus)
   */
  private generatePixPayload(amount: number, orderId: string): string {
    const pixKey = '12344385000193'; // CNPJ
    const merchantName = 'HIPNOTICUS TERAPIA';
    const merchantCity = 'BRASILIA';
    const txid = `PED${orderId}`.substring(0, 25);
    const amountStr = amount.toFixed(2);

    const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

    // Merchant Account Information (ID 26) — PIX-specific
    const mai = tlv('00', 'br.gov.bcb.pix') + tlv('01', pixKey);

    let payload = '';
    payload += tlv('00', '01');                    // Payload Format Indicator
    payload += tlv('26', mai);                     // Merchant Account Information
    payload += tlv('52', '0000');                   // Merchant Category Code
    payload += tlv('53', '986');                    // Transaction Currency (BRL)
    payload += tlv('54', amountStr);               // Transaction Amount
    payload += tlv('58', 'BR');                    // Country Code
    payload += tlv('59', merchantName);            // Merchant Name
    payload += tlv('60', merchantCity);            // Merchant City
    payload += tlv('62', tlv('05', txid));         // Additional Data (txid)
    payload += '6304';                             // CRC placeholder

    // Calculate CRC16-CCITT
    const crc = this.crc16ccitt(payload);
    payload += crc;

    return payload;
  }

  private crc16ccitt(str: string): string {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
        else crc <<= 1;
      }
      crc &= 0xFFFF;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  private async sendEmails(req: PaymentRequest, response: PaymentResponse): Promise<void> {
    if (!this.sendEmailUseCase) return;

    // Load bank data for deposit emails
    let bankData = '';
    if (['deptransf', 'pix-direto'].includes(req.paymentMethodIdExt)) {
      try {
        const { QueryTypes } = require('sequelize');
        const rows = await this.sequelize?.query(
          `SELECT Value FROM tbConfig WHERE Name = 'orders.transaction.bank.data'`,
          { type: QueryTypes.SELECT },
        ) as any[];
        bankData = rows?.[0]?.Value || '';
      } catch { /* ignore */ }
    }

    const ctx: EmailContext = {
      customerName: req.customerName,
      customerCpf: req.customerCpf,
      customerEmail: req.customerEmail,
      customerPhone: req.customerPhone || '',
      customerBirthDate: req.customerBirthDate || '',
      addressCountry: 'Brasil',
      addressCep: req.address?.cep || '',
      addressStreet: req.address?.street || '',
      addressNumber: req.address?.number || '',
      addressComplement: req.address?.complement || '',
      addressNeighborhood: req.address?.neighborhood || '',
      addressCity: req.address?.city || '',
      addressState: req.address?.state || '',
      mainGoal: req.mainGoal || '',
      packageSize: req.packageSize || 0,
      orderItems: '',
      firstAppointmentDay: req.firstAppointmentDay || '',
      firstAppointmentHour: req.firstAppointmentHour || '',
      sessionDay: req.sessionDay || '',
      sessionHour: req.sessionHour || '',
      paymentMethod: req.paymentMethodIdExt,
      amount: req.amount,
      installments: req.installments,
      cardBrand: req.card?.brand,
      cardNumber: req.card?.number,
      cardSecurityCode: req.card?.securityCode,
      cardExpiration: req.card?.expirationDate,
      cardHolder: req.card?.holder,
      transactionStatus: response.authorized
        ? '<strong style="color: green;">AUTORIZADA</strong>'
        : '<strong style="color: orange;">EFETUADA</strong>',
      boletoUrl: response.boletoUrl || '',
      boletoCodigoBarras: response.linhaDigitavel || response.codigoBarras || '',
      pixCopiaECola: response.pixCopiaECola || '',
      depositValue: '',
      bankData,
    };

    await this.sendEmailUseCase.execute(ctx);
  }
}
