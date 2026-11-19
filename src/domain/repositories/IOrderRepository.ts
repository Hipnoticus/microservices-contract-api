import { Order } from '../entities/Order';

export interface IOrderRepository {
  findAll(): Promise<Order[]>;
  findById(id: number): Promise<Order | null>;
  findByCustomerId(customerId: number): Promise<Order[]>;
  /** transaction: a Sequelize Transaction, so the insert commits or rolls back with the customer and address. */
  create(order: Partial<Order>, transaction?: unknown): Promise<Order>;
  updateStatus(id: number, statusId: number): Promise<Order | null>;
  updatePayment(id: number, identifier: string, registry: string): Promise<Order | null>;
  /** True when one of the customer's orders carries this payment identifier (boleto nossoNumero, PIX txid). */
  ownsPaymentIdentifier(customerId: number, identifier: string): Promise<boolean>;
}
