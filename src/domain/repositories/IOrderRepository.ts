import { Order } from '../entities/Order';

export interface IOrderRepository {
  findAll(): Promise<Order[]>;
  findById(id: number): Promise<Order | null>;
  findByCustomerId(customerId: number): Promise<Order[]>;
  create(order: Partial<Order>): Promise<Order>;
  updateStatus(id: number, statusId: number): Promise<Order | null>;
  updatePayment(id: number, identifier: string, registry: string): Promise<Order | null>;
}
