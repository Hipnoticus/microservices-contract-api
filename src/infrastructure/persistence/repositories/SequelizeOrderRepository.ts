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
    // Use raw INSERT with GETDATE() to avoid Sequelize timezone offset issues with SQL Server datetime
    // Include CustomerEmail and CustomerAddressID to match legacy order structure
    const [result] = await OrderModel.sequelize!.query(
      `INSERT INTO tbOrders (CustomerID, CustomerEmail, CustomerAddressID, OrderStatusID, MainGoal, FormaPagamento, SubTotal, Total, ShipValue,
        FirstAppointmentDay, FirstAppointmentHour, SessionDay, SessionHour, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
       OUTPUT INSERTED.ID
       VALUES (:customerId, :email, :addressId, :statusId, :mainGoal, :paymentMethodId, :subTotal, :total, 0,
        :firstAppointmentDay, :firstAppointmentHour, :sessionDay, :sessionHour, 0, GETDATE(), GETDATE(), 1, 1)`,
      {
        replacements: {
          customerId: data.customerId,
          email: (data as any).customerEmail || null,
          addressId: (data as any).customerAddressId || null,
          statusId: data.statusId || 1,
          mainGoal: data.mainGoal || '',
          paymentMethodId: data.paymentMethodId || 0,
          subTotal: data.total || 0,
          total: data.total || 0,
          firstAppointmentDay: data.firstAppointmentDay || null,
          firstAppointmentHour: data.firstAppointmentHour || null,
          sessionDay: data.sessionDay || null,
          sessionHour: data.sessionHour || null,
        },
      },
    );
    const insertedId = (result as any)[0]?.ID;
    if (!insertedId) throw new Error('Failed to create order — no ID returned');
    const model = await OrderModel.findByPk(insertedId);
    return this.toDomain(model!);
  }

  async updateStatus(id: number, statusId: number): Promise<Order | null> {
    await OrderModel.sequelize!.query(
      `UPDATE tbOrders SET OrderStatusID = :statusId, DateModified = GETDATE() WHERE ID = :id`,
      { replacements: { statusId, id } },
    );
    const model = await OrderModel.findByPk(id);
    return model ? this.toDomain(model) : null;
  }

  async updatePayment(id: number, identifier: string, registry: string): Promise<Order | null> {
    await OrderModel.sequelize!.query(
      `UPDATE tbOrders SET Identifier = :identifier, Registry = :registry, DateModified = GETDATE() WHERE ID = :id`,
      { replacements: { identifier, registry, id } },
    );
    const model = await OrderModel.findByPk(id);
    return model ? this.toDomain(model) : null;
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
