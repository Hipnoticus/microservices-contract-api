/**
 * PaymentPollingService — Background job that checks pending boleto/PIX orders
 * against the Banco Inter API and confirms payments.
 *
 * Runs every 5 minutes, checks orders with status "Pending" (1) that have
 * a payment identifier (nossoNumero for boleto).
 */
import { BancoInterGateway } from './BancoInterGateway';
import { ConfirmPaymentUseCase } from '../../application/use-cases/ConfirmPaymentUseCase';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('PaymentPollingService');

export class PaymentPollingService {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sequelize: any,
    private readonly bancoInterGateway: BancoInterGateway | null,
    private readonly confirmPaymentUseCase: ConfirmPaymentUseCase,
    private readonly pollIntervalMs: number = 5 * 60 * 1000, // 5 minutes
  ) {}

  start(): void {
    if (!this.bancoInterGateway) {
      logger.warn('Banco Inter gateway not configured — payment polling disabled');
      return;
    }

    logger.info(`Payment polling started (interval: ${this.pollIntervalMs / 1000}s)`);

    // Register webhooks on startup (fire-and-forget)
    this.registerWebhooks();

    // Run first check after 30 seconds (let the app fully start)
    setTimeout(() => this.checkPendingOrders(), 30000);

    this.intervalId = setInterval(() => this.checkPendingOrders(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Payment polling stopped');
    }
  }

  private async registerWebhooks(): Promise<void> {
    const webhookUrl = process.env.BANCO_INTER_WEBHOOK_URL
      || 'https://moses.hipnoticus.com.br/contract-service/payments/webhook/banco-inter';

    try {
      const boletoResult = await this.bancoInterGateway!.registerBoletoWebhook(webhookUrl);
      logger.info(`Boleto webhook registration: ${boletoResult.success ? 'OK' : boletoResult.error}`);
    } catch (e) {
      logger.warn(`Boleto webhook registration failed: ${(e as Error).message}`);
    }

    try {
      const pixResult = await this.bancoInterGateway!.registerPixWebhook(webhookUrl);
      logger.info(`PIX webhook registration: ${pixResult.success ? 'OK' : pixResult.error}`);
    } catch (e) {
      logger.warn(`PIX webhook registration failed: ${(e as Error).message}`);
    }
  }

  private async checkPendingOrders(): Promise<void> {
    try {
      const { QueryTypes } = require('sequelize');

      // Find orders with status 1 (Pendente) that have a payment identifier
      // and were created in the last 30 days
      const pendingOrders = await this.sequelize.query(
        `SELECT ID, Identifier, Registry, FormaPagamento
         FROM tbOrders
         WHERE OrderStatusID = 1
           AND Identifier IS NOT NULL
           AND Identifier != ''
           AND DateCreated > DATEADD(day, -30, GETDATE())
         ORDER BY ID DESC`,
        { type: QueryTypes.SELECT },
      ) as any[];

      if (!pendingOrders.length) return;

      logger.info(`Checking ${pendingOrders.length} pending orders for payment confirmation`);

      for (const order of pendingOrders) {
        try {
          const nossoNumero = order.Identifier;
          if (!nossoNumero || nossoNumero.startsWith('TEST-') || nossoNumero.startsWith('static-')) continue;

          const status = await this.bancoInterGateway!.checkBoletoStatus(nossoNumero);

          if (status.paid) {
            logger.info(`Order ${order.ID} (nossoNumero=${nossoNumero}) is PAID — confirming`);
            await this.confirmPaymentUseCase.execute(order.ID, `polling:${status.situacao}`);
          }
        } catch (e) {
          logger.warn(`Error checking order ${order.ID}: ${(e as Error).message}`);
        }

        // Small delay between API calls to avoid rate limiting
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      logger.error(`Payment polling error: ${(e as Error).message}`);
    }
  }
}
