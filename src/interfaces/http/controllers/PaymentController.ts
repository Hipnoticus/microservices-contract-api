import { Controller, Post, Get, Param, Body, Inject, Res, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ProcessPaymentUseCase, PaymentRequest, PaymentResponse } from '../../../application/use-cases/ProcessPaymentUseCase';
import { ConfirmPaymentUseCase } from '../../../application/use-cases/ConfirmPaymentUseCase';
import { BancoInterGateway } from '../../../infrastructure/payment/BancoInterGateway';
import { IOrderRepository } from '../../../domain/repositories/IOrderRepository';
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
  async process(@Body() req: PaymentRequest): Promise<PaymentResponse> {
    return this.processPayment.execute(req);
  }

  @Get('status/:orderId')
  @ApiOperation({ summary: 'Check payment status for an order (used by frontend polling)' })
  async getPaymentStatus(@Param('orderId') orderId: string) {
    const id = parseInt(orderId, 10);
    const order = await this.orderRepository.findById(id);
    if (!order) return { orderId: id, status: 'not_found' };

    // Status 2 = Em Análise (paid), 1 = Pendente (awaiting payment)
    const paid = order.statusId >= 2;
    return {
      orderId: id,
      status: paid ? 'paid' : 'pending',
      statusId: order.statusId,
      paid,
    };
  }

  @Post('confirm/:orderId')
  @ApiOperation({ summary: 'Manually confirm payment for an order (admin/webhook fallback)' })
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
  async bancoInterWebhook(@Body() body: any, @Req() req: any) {
    logger.info(`Banco Inter webhook received: ${JSON.stringify(body).substring(0, 500)}`);

    // Banco Inter webhook payload varies by type:
    // Boleto: { nossoNumero, seuNumero, situacao: "PAGO", ... }
    // PIX: { endToEndId, txid, valor, ... }
    try {
      let orderId: number | null = null;

      if (body.seuNumero) {
        // Boleto callback — seuNumero is our orderId
        orderId = parseInt(body.seuNumero, 10);
      } else if (body.txid) {
        // PIX callback — txid may contain our orderId
        // Try to extract orderId from txid or look up by payment identifier
        const txid = body.txid;
        // Our PIX txid format: orderId as string, or "PEDorderId", or "static-orderId"
        const match = txid.match(/(\d+)/);
        if (match) orderId = parseInt(match[1], 10);
      } else if (body.pix && Array.isArray(body.pix)) {
        // PIX webhook array format
        for (const pix of body.pix) {
          if (pix.txid) {
            const match = pix.txid.match(/(\d+)/);
            if (match) {
              orderId = parseInt(match[1], 10);
              break;
            }
          }
        }
      }

      if (orderId && orderId > 0) {
        const situacao = body.situacao || body.status || 'PAGO';
        if (situacao === 'PAGO' || situacao === 'REALIZADO' || body.endToEndId) {
          await this.confirmPayment.execute(orderId, `webhook:banco-inter:${situacao}`);
        } else {
          logger.info(`Webhook for order ${orderId}: situacao=${situacao} (not paid yet)`);
        }
      } else {
        logger.warn(`Could not extract orderId from webhook payload`);
      }
    } catch (e) {
      logger.error(`Webhook processing error: ${(e as Error).message}`);
    }

    // Always return 200 to acknowledge the webhook
    return { received: true };
  }

  @Post('webhook/register')
  @ApiOperation({ summary: 'Register Banco Inter webhooks for payment notifications' })
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
