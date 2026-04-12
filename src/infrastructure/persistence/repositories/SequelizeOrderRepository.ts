import { IOrderRepository } from '../../../domain/repositories/IOrderRepository';
import { Order } from '../../../domain/entities/Order';
import { OrderModel } from '../models/OrderModel';

export class SequelizeOrderRepository implements IOrderRepository {
  async findAll(): Promise<Order[]> {
    const models = await OrderModel.findAll({ order: [['id', 'DESC']], limit: 100 });
    return models.map((m) => this.toDomain(m));
  }

  async findById(id: number): Promise<Order | null> {
    const model = await OrderModel.findByPk(id);
    return model ? this.toDomain(model) : null;
  }

  async findByCustomerId(customerId: number): Promise<Order[]> {
    const models = await OrderModel.findAll({ where: { customerId }, order: [['id', 'DESC']] });
    return models.map((m) => this.toDomain(m));
  }

  async create(data: Partial<Order>): Promise<Order> {
    const model = await OrderModel.create({
      customerId: data.customerId,
      customerEmail: (data as any).customerEmail || null,
      orderStatusId: data.statusId || 1,
      mainGoal: data.mainGoal,
      formaPagamento: data.paymentMethodId,
      subTotal: data.total,
      total: data.total,
      firstAppointmentDay: data.firstAppointmentDay,
      firstAppointmentHour: data.firstAppointmentHour,
      sessionDay: data.sessionDay,
      sessionHour: data.sessionHour,
      blocked: false,
      dateCreated: new Date(),
      dateModified: new Date(),
      createdBy: 1,
      modifiedBy: 1,
    } as any);
    return this.toDomain(model);
  }

  async updateStatus(id: number, statusId: number): Promise<Order | null> {
    const model = await OrderModel.findByPk(id);
    if (!model) return null;
    model.orderStatusId = statusId;
    model.dateModified = new Date();
    await model.save();
    return this.toDomain(model);
  }

  async updatePayment(id: number, identifier: string, registry: string): Promise<Order | null> {
    const model = await OrderModel.findByPk(id);
    if (!model) return null;
    model.identifier = identifier;
    model.registry = registry;
    model.dateModified = new Date();
    await model.save();
    return this.toDomain(model);
  }

  private toDomain(model: OrderModel): Order {
    return new Order(
      model.id, model.customerId || 0, model.orderStatusId || 1,
      model.mainGoal || '', model.formaPagamento || 0,
      model.identifier, model.registry,
      String(model.firstAppointmentDay || ''), model.firstAppointmentHour || '',
      String(model.sessionDay || ''), model.sessionHour || '',
      Number(model.subTotal) || 0, Number(model.total) || 0,
      1, 0, model.blocked || false,
      model.dateCreated || new Date(), model.dateModified || new Date(),
      model.createdBy || 1, model.modifiedBy || 1,
    );
  }
}
