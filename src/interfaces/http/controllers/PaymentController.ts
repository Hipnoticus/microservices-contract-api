import { Controller, Post, Get, Param, Body, Inject, Res, Req, UseGuards } from '@nestjs/common';
import { MODULE, StaffGuard, verifyStaffToken } from '../auth/StaffAuth';
import { confirmVerifiedOrders } from '../../../application/payment/PaymentPolicy';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { ProcessPaymentUseCase, PaymentRequest, PaymentResponse } from '../../../application/use-cases/ProcessPaymentUseCase';
import type { ConfirmPaymentUseCase } from '../../../application/use-cases/ConfirmPaymentUseCase';
import type { BancoInterGateway } from '../../../infrastructure/payment/BancoInterGateway';
import type { IOrderRepository } from '../../../domain/repositories/IOrderRepository';
import { Logger } from '../../../shared/logger/Logger';

const logger = new Logger('PaymentController');

@ApiTags('Payments')
@Controller('payments')
export class PaymentController {
  constructor(
    @Inject('PROCESS_PAYMENT') private readonly processPayment: ProcessPaymentUseCase,
    @Inject('CONFIRM_PAYMENT') private readonly confirmPayment: ConfirmPaymentUseCase,
    @Inject('BANCO_INTER_GATEWAY') private readonly bancoInterGateway: BancoInterGateway | null,
    @Inject('ORDER_REPOSITORY') private readonly orderRepository: IOrderRepository,
  ) {}

  @Post('process')
  @ApiOperation({ summary: 'Process payment for an existing order' })
  async process(@Body() body: PaymentRequest, @Req() req: any): Promise<PaymentResponse> {
    // Public (visitor checkout). Only a verified staff token may unlock the legacy test price.
    const staffCaller = !!verifyStaffToken(req?.headers?.authorization);
    return this.processPayment.execute({ ...(body || ({} as PaymentRequest)), staffCaller });
  }

  @Get('status/:orderId')
  @ApiOperation({ summary: 'Check payment status for an order (used by frontend polling)' })
  async getPaymentStatus(@Param('orderId') orderId: string) {
    const id = parseInt(orderId, 10);
    const order = await this.orderRepository.findById(id);
    if (!order) return { orderId: id, status: 'not_found' };

    // Already paid — return immediately
    if (order.statusId >= 2) {
      return { orderId: id, status: 'paid', statusId: order.statusId, paid: true };
    }

    // For pending PIX orders, check Banco Inter in real-time (throttled to once per 10s per order)
    if (this.bancoInterGateway && order.paymentIdentifier && order.paymentMethodId === 2) {
      const cacheKey = `pix-check-${id}`;
      const now = Date.now();
      if (!this.pixCheckCache[cacheKey] || now - this.pixCheckCache[cacheKey] > 10000) {
        this.pixCheckCache[cacheKey] = now;
        try {
          const status = await this.bancoInterGateway.checkPixStatus(order.paymentIdentifier!);
          if (status.paid) {
            await this.confirmPayment.execute(id, `realtime:pix:${status.status}`);
            return { orderId: id, status: 'paid', statusId: 2, paid: true };
          }
        } catch (e) { /* non-blocking */ }
      }
    }

    return { orderId: id, status: 'pending', statusId: order.statusId, paid: false };
  }
  private pixCheckCache: Record<string, number> = {};

  @Post('confirm/:orderId')
  @UseGuards(StaffGuard(MODULE.CLIENTES))
  @ApiOperation({ summary: 'Manually confirm payment for an order (staff with Clientes)' })
  async confirmOrder(@Param('orderId') orderId: string) {
    const id = parseInt(orderId, 10);
    const result = await this.confirmPayment.execute(id, 'manual');
    return { orderId: id, confirmed: result };
  }

  /**
   * Banco Inter webhook callback for boleto and PIX payments.
   * Banco Inter sends POST to this endpoint when a payment is received.
   * The webhook URL must be registered in the Banco Inter portal.
   */
  @Post('webhook/banco-inter')
  @ApiOperation({ summary: 'Banco Inter webhook callback for payment notifications' })
  async bancoInterWebhook(@Body() body: any) {
    logger.info(`Banco Inter webhook received: ${JSON.stringify(body ?? null).substring(0, 500)}`);

    // Public URL, so the payload is never believed: it only names candidate orders (boleto seuNumero, PIX txid),
    // and each one is confirmed only if Banco Inter reports that order's own charge as paid.
    const gateway = this.bancoInterGateway;
    if (gateway) {
      try {
        const confirmed = await confirmVerifiedOrders(body, {
          findOrder: (id) => this.orderRepository.findById(id),
          checkPix: (txid) => gateway.checkPixStatus(txid),
          checkBoleto: (nossoNumero) => gateway.checkBoletoStatus(nossoNumero),
          confirm: (id, source) => this.confirmPayment.execute(id, source),
        });
        logger.info(`Banco Inter webhook: confirmed orders [${confirmed.join(',')}] after checking with Banco Inter`);
      } catch (e) {
        logger.error(`Webhook processing error: ${(e as Error).message}`);
      }
    }

    // Always return 200 to acknowledge the webhook
    return { received: true };
  }

  @Post('webhook/register')
  @UseGuards(StaffGuard(MODULE.CONFIGURACOES))
  @ApiOperation({ summary: 'Register Banco Inter webhooks for payment notifications (staff with Configurações)' })
  async registerWebhooks() {
    if (!this.bancoInterGateway) {
      return { success: false, error: 'Banco Inter gateway not configured' };
    }
    const webhookUrl = process.env.BANCO_INTER_WEBHOOK_URL
      || 'https://moses.hipnoticus.com.br/contract-service/payments/webhook/banco-inter';

    const boletoResult = await this.bancoInterGateway.registerBoletoWebhook(webhookUrl);
    const pixResult = await this.bancoInterGateway.registerPixWebhook(webhookUrl);

    return {
      webhookUrl,
      boleto: boletoResult,
      pix: pixResult,
    };
  }

  @Get('boleto-pdf/:nossoNumero')
  @ApiOperation({ summary: 'Get boleto PDF by nossoNumero' })
  async getBoletoPdf(@Param('nossoNumero') nossoNumero: string, @Res() res: any): Promise<void> {
    if (!this.bancoInterGateway) {
      res.status(503).json({ error: 'Banco Inter gateway not configured' });
      return;
    }
    const pdfBase64 = await this.bancoInterGateway.getBoletoPdf(nossoNumero);
    if (!pdfBase64) {
      res.status(404).json({ error: 'Boleto PDF not found' });
      return;
    }
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="boleto-${nossoNumero}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    res.send(pdfBuffer);
  }
}
