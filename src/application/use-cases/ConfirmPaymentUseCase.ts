/**
 * ConfirmPaymentUseCase — Confirms that a boleto or PIX payment has been received.
 *
 * Called by:
 *  - Banco Inter webhook callback (instant)
 *  - Polling job that checks pending orders (background)
 *
 * Actions:
 *  1. Update order status to Paid (2)
 *  2. Send payment confirmation emails to clinic + customer
 */
import { IOrderRepository } from '../../domain/repositories/IOrderRepository';
import { SendConfirmationEmailUseCase, EmailContext } from './SendConfirmationEmailUseCase';
import { CreateSessionsUseCase } from './CreateSessionsUseCase';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('ConfirmPaymentUseCase');

export class ConfirmPaymentUseCase {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly sendEmailUseCase: SendConfirmationEmailUseCase | null,
    private readonly sequelize: any,
    private readonly createSessionsUseCase?: CreateSessionsUseCase | null,
  ) {}

  async execute(orderId: number, source: string): Promise<boolean> {
    const order = await this.orderRepository.findById(orderId);
    if (!order) {
      logger.warn(`Order ${orderId} not found (source: ${source})`);
      return false;
    }

    // Already in analysis or confirmed — skip
    if (order.statusId >= 2) {
      logger.info(`Order ${orderId} already confirmed (status ${order.statusId}, source: ${source})`);
      return true;
    }

    logger.info(`Confirming payment for order ${orderId} (source: ${source}, previous status: ${order.statusId})`);

    // Update status to Em Análise (2) — payment received
    await this.orderRepository.updateStatus(orderId, 2);

    // Create treatment + sessions (tbTreatments + tbSessions)
    try {
      if (this.createSessionsUseCase) {
        await this.createSessionsUseCase.execute(orderId);
      }
    } catch (e) {
      logger.error(`Failed to create sessions for order ${orderId}: ${(e as Error).message}`);
    }

    // Send payment confirmation emails
    try {
      await this.sendPaymentConfirmedEmails(order);
    } catch (e) {
      logger.error(`Failed to send confirmation emails for order ${orderId}: ${(e as Error).message}`);
    }

    logger.info(`Order ${orderId} confirmed successfully (source: ${source})`);
    return true;
  }

  private async sendPaymentConfirmedEmails(order: any): Promise<void> {
    if (!this.sendEmailUseCase || !this.sequelize) return;

    // Load customer data from the order
    const { QueryTypes } = require('sequelize');
    const rows = await this.sequelize.query(
      `SELECT o.ID, o.CustomerEmail, o.Total, o.MainGoal, o.Identifier, o.Registry,
              c.FirstName, c.LastName, c.CPFCNPJ as CPF, c.PhoneNumber as TelCelular, c.Email
       FROM tbOrders o
       LEFT JOIN tbCustomers c ON o.CustomerID = c.ID
       WHERE o.ID = :orderId`,
      { replacements: { orderId: order.id }, type: QueryTypes.SELECT },
    ) as any[];

    if (!rows.length) return;
    const data = rows[0];
    const customerName = `${data.FirstName || ''} ${data.LastName || ''}`.trim();
    const customerEmail = data.Email || data.CustomerEmail || '';

    if (!customerEmail) {
      logger.warn(`No email found for order ${order.id}, skipping confirmation email`);
      return;
    }

    const ctx: EmailContext = {
      customerName,
      customerCpf: data.CPF || '',
      customerEmail,
      customerPhone: data.TelCelular || '',
      customerBirthDate: '',
      addressCountry: 'Brasil',
      addressCep: '', addressStreet: '', addressNumber: '',
      addressComplement: '', addressNeighborhood: '', addressCity: '', addressState: '',
      mainGoal: data.MainGoal || '',
      packageSize: 0,
      orderItems: '',
      firstAppointmentDay: '', firstAppointmentHour: '',
      sessionDay: '', sessionHour: '',
      paymentMethod: 'inter-boleto',
      amount: Number(data.Total) || 0,
      installments: 1,
      transactionStatus: '<strong style="color: green;">PAGO / CONFIRMADO</strong>',
      boletoUrl: '',
      boletoCodigoBarras: data.Registry || '',
      pixCopiaECola: '',
      depositValue: '',
      bankData: '',
    };

    await this.sendEmailUseCase.execute(ctx);
  }
}
