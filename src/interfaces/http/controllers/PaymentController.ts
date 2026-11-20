import { Controller, Post, Get, Param, Body, Inject, Res, Req, UseGuards, HttpCode } from '@nestjs/common';
import { MODULE, StaffGuard, principalOf, verifyStaffToken } from '../auth/StaffAuth';
import { confirmVerifiedOrders } from '../../../application/payment/PaymentPolicy';
import { PaymentStatusChecker } from '../../../application/payment/PaymentStatus';
import { paymentEvents } from '../../../application/payment/PaymentEvents';
import { webhookUrl as interWebhookUrl } from '../../../infrastructure/payment/BancoInterGateway';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { ProcessPaymentUseCase, PaymentRequest, PaymentResponse } from '../../../application/use-cases/ProcessPaymentUseCase';
import type { ConfirmPaymentUseCase } from '../../../application/use-cases/ConfirmPaymentUseCase';
import type { BancoInterGateway } from '../../../infrastructure/payment/BancoInterGateway';
import type { IOrderRepository } from '../../../domain/repositories/IOrderRepository';
import { Logger } from '../../../shared/logger/Logger';
import { clientIp, userAgent } from '../ClientIp';
import { paymentRateLimiter } from '../RateLimiter';

const logger = new Logger('PaymentController');

const STREAM_RECHECK_MS = 5_000;
const STREAM_PING_MS = 15_000;
const STREAM_MAX_MS = 30 * 60_000;
const MAX_STREAMS = 500;
const MAX_STREAMS_PER_IP = 10;

@ApiTags('Payments')
@Controller('payments')
export class PaymentController {
  constructor(
    @Inject('PROCESS_PAYMENT') private readonly processPayment: ProcessPaymentUseCase,
    @Inject('CONFIRM_PAYMENT') private readonly confirmPayment: ConfirmPaymentUseCase,
    @Inject('BANCO_INTER_GATEWAY') private readonly bancoInterGateway: BancoInterGateway | null,
    @Inject('ORDER_REPOSITORY') private readonly orderRepository: IOrderRepository,
  ) {
    const inter = this.bancoInterGateway;
    this.statusChecker = new PaymentStatusChecker({
      findOrder: (id) => this.orderRepository.findById(id),
      checkPix: inter ? (txid) => inter.checkPixStatus(txid) : null,
      checkBoleto: inter ? (codigo) => inter.checkBoletoStatus(codigo) : null,
      confirm: (id, source) => this.confirmPayment.execute(id, source),
    });
  }

  private readonly statusChecker: PaymentStatusChecker;

  @Post('process')
  @ApiOperation({ summary: 'Process payment for an existing order' })
  async process(@Body() body: PaymentRequest, @Req() req: any): Promise<PaymentResponse> {
    // Public (visitor checkout). Only a verified staff token may unlock the legacy test price.
    const staffCaller = !!verifyStaffToken(req?.headers?.authorization);
    const ip = clientIp(req);
    if (!staffCaller) paymentRateLimiter.check(ip, 'pagamento');
    return this.processPayment.execute({
      ...(body || ({} as PaymentRequest)),
      staffCaller,
      clientIp: ip,
      clientUserAgent: userAgent(req),
    });
  }

  @Get('status/:orderId')
  @ApiOperation({ summary: 'Payment status of an order (paid / pending / not_found), polled by the Moses success page' })
  async getPaymentStatus(@Param('orderId') orderId: string) {
    // Pending Banco Inter orders (PIX and boleto with PIX) are checked live with Inter at most every 10 s per order.
    return this.statusChecker.status(parseInt(orderId, 10));
  }

  /**
   * Server-Sent Events for the Moses success page: `event: status` with the same body as GET /payments/status the
   * moment the order is confirmed (webhook, polling, live check, staff or card), then the stream ends. Public like
   * /payments/status and with the same data (paid / pending only). While open it re-checks the order every 5 s
   * (the live Inter check stays throttled to 10 s per order) and sends a comment every 15 s so nginx, Cloudflare and
   * the gateway keep the connection. Closed after 30 minutes; the page keeps polling as a fallback.
   */
  @Get('stream/:orderId')
  @ApiOperation({ summary: 'Server-Sent Events: pushes the payment confirmation of an order' })
  async streamPaymentStatus(@Param('orderId') orderId: string, @Req() req: any, @Res() res: any): Promise<void> {
    const id = parseInt(orderId, 10);
    const ip = clientIp(req);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Pedido inválido.' });
      return;
    }
    if (PaymentController.openStreams >= MAX_STREAMS || (PaymentController.streamsByIp.get(ip) || 0) >= MAX_STREAMS_PER_IP) {
      res.status(429).json({ error: 'Muitas conexões abertas.' });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // host nginx: do not buffer this response
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    PaymentController.openStreams++;
    PaymentController.streamsByIp.set(ip, (PaymentController.streamsByIp.get(ip) || 0) + 1);
    let closed = false;
    const timers: any[] = [];
    let unsubscribe: () => void = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      for (const t of timers) clearInterval(t);
      unsubscribe();
      PaymentController.openStreams--;
      const n = (PaymentController.streamsByIp.get(ip) || 1) - 1;
      if (n > 0) PaymentController.streamsByIp.set(ip, n); else PaymentController.streamsByIp.delete(ip);
      try { res.end(); } catch { /* already gone */ }
    };
    const send = (body: unknown) => {
      if (closed) return;
      try { res.write(`event: status\ndata: ${JSON.stringify(body)}\n\n`); } catch { close(); }
    };
    let lastSent = '';
    const finishIfDone = (s: { status: string }) => {
      if (s.status === lastSent) return;
      lastSent = s.status;
      send(s);
      if (s.status !== 'pending') close();
    };
    req.on('close', close);
    res.on?.('close', close);

    try { res.write('retry: 3000\n\n'); } catch { close(); return; }
    unsubscribe = paymentEvents.onPaid(id, () => finishIfDone({ orderId: id, status: 'paid', statusId: 2, paid: true } as any));
    let checking = false;
    const check = async () => {
      if (closed || checking) return;
      checking = true;
      try { finishIfDone(await this.statusChecker.status(id)); } catch { /* next tick */ } finally { checking = false; }
    };
    timers.push(setInterval(check, STREAM_RECHECK_MS));
    timers.push(setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch { close(); } } }, STREAM_PING_MS));
    timers.push(setInterval(close, STREAM_MAX_MS));
    await check();
  }

  /** Open SSE streams (process-wide), to cap what a public endpoint can hold open. */
  private static openStreams = 0;
  private static streamsByIp = new Map<string, number>();

  @Post('confirm/:orderId')
  @UseGuards(StaffGuard(MODULE.CLIENTES))
  @ApiOperation({ summary: 'Manually confirm payment for an order (staff with Clientes)' })
  async confirmOrder(@Param('orderId') orderId: string) {
    const id = parseInt(orderId, 10);
    const result = await this.confirmPayment.execute(id, 'manual');
    return { orderId: id, confirmed: result };
  }

  /**
   * Banco Inter callback: Cobrança v3 (array of { codigoSolicitacao, seuNumero, situacao, txid, ... }) at the
   * registered URL and PIX ({ pix: [{ txid, endToEndId, valor, horario }] }) at {registered URL}/pix, as the BCB
   * API Pix appends. A bolepix paid by PIX fires the Cobrança v3 callback with situacao RECEBIDO.
   */
  @Post('webhook/banco-inter')
  @HttpCode(200)
  @ApiOperation({ summary: 'Banco Inter webhook callback for payment notifications' })
  async bancoInterWebhook(@Body() body: any) {
    return this.handleInterCallback('cobranca', body);
  }

  @Post('webhook/banco-inter/pix')
  @HttpCode(200)
  @ApiOperation({ summary: 'Banco Inter PIX webhook callback ({webhookUrl}/pix)' })
  async bancoInterPixWebhook(@Body() body: any) {
    return this.handleInterCallback('pix', body);
  }

  private async handleInterCallback(kind: string, body: any) {
    logger.info(`Banco Inter ${kind} webhook received: ${JSON.stringify(body ?? null).substring(0, 500)}`);

    // Public URL, so the payload is never believed: it only names candidate orders (codigoSolicitacao, seuNumero,
    // PIX txid), and each one is confirmed only if Banco Inter reports that order's own charge as paid.
    const gateway = this.bancoInterGateway;
    if (gateway) {
      try {
        const confirmed = await confirmVerifiedOrders(body, {
          findOrder: (id) => this.orderRepository.findById(id),
          findOrderByIdentifier: (ident) => this.orderRepository.findByPaymentIdentifier(ident),
          recentPendingBoletoOrderIds: () => this.orderRepository.recentPendingBoletoOrderIds(7, 30),
          checkPix: (txid) => gateway.checkPixStatus(txid),
          checkBoleto: (codigo) => gateway.checkBoletoStatus(codigo),
          confirm: (id, source) => this.confirmPayment.execute(id, source),
        });
        logger.info(`Banco Inter ${kind} webhook: confirmed orders [${confirmed.join(',')}] after checking with Banco Inter`);
      } catch (e) {
        logger.error(`Webhook processing error: ${(e as Error).message}`);
      }
    }

    // Always acknowledge, or Inter retries
    return { received: true };
  }

  @Post('webhook/register')
  @UseGuards(StaffGuard(MODULE.CONFIGURACOES))
  @ApiOperation({ summary: 'Register Banco Inter webhooks for payment notifications (staff with Configurações)' })
  async registerWebhooks() {
    if (!this.bancoInterGateway) {
      return { success: false, error: 'Banco Inter gateway not configured' };
    }
    const url = interWebhookUrl();
    const boletoResult = await this.bancoInterGateway.registerBoletoWebhook(url);
    const pixResult = await this.bancoInterGateway.registerPixWebhook(url);

    return {
      webhookUrl: url,
      boleto: boletoResult,
      pix: pixResult,
    };
  }

  @Get('boleto-pdf/:nossoNumero')
  @ApiOperation({ summary: 'Get boleto PDF by nossoNumero' })
  async getBoletoPdf(@Param('nossoNumero') nossoNumero: string, @Res() res: any, @Req() req: any): Promise<void> {
    // The PDF carries the payer's name, CPF and address: a customer gets only the boleto of one of their orders
    // (tbOrders.Identifier holds the nossoNumero). Staff and server-side callers are unchanged.
    const who = principalOf(req?.headers);
    if (who.kind === 'customer') {
      const owned = who.id > 0 && String(nossoNumero || '').length <= 100
        ? await this.orderRepository.ownsPaymentIdentifier(who.id, String(nossoNumero))
        : false;
      if (!owned) {
        res.status(403).json({ error: 'Sem permissão para este boleto.' });
        return;
      }
    }
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
