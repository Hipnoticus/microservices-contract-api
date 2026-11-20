import { IOrderRepository } from '../../../domain/repositories/IOrderRepository';
import { Order } from '../../../domain/entities/Order';
import { QueryTypes, Transaction } from 'sequelize';
import { isIP } from 'net';
import { OrderModel } from '../models/OrderModel';
import { publishCustomerGroupChanged } from '../../events/CustomerGroupEvents';

/** tbOrders.IP is varchar(45): a real address or NULL ('unknown' and anything else is not stored). */
export function orderIp(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= 45 && isIP(s) ? s : null;
}

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

  async create(data: Partial<Order>, transaction?: unknown): Promise<Order> {
    const tx = (transaction as Transaction | undefined) || undefined;
    // Use raw INSERT with GETDATE() to avoid Sequelize timezone offset issues with SQL Server datetime
    // Include CustomerEmail and CustomerAddressID to match legacy order structure
    const [result] = await OrderModel.sequelize!.query(
      `INSERT INTO tbOrders (CustomerID, CustomerEmail, CustomerAddressID, OrderStatusID, MainGoal, FormaPagamento, SubTotal, Total, ShipValue,
        FirstAppointmentDay, FirstAppointmentHour, SessionDay, SessionHour, IP, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
       OUTPUT INSERTED.ID
       VALUES (:customerId, :email, :addressId, :statusId, :mainGoal, :paymentMethodId, :subTotal, :total, 0,
        :firstAppointmentDay, :firstAppointmentHour, :sessionDay, :sessionHour, :ip, 0, GETDATE(), GETDATE(), 1, 1)`,
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
          firstAppointmentDay: (data.firstAppointmentDay && data.firstAppointmentDay !== 'null') ? data.firstAppointmentDay : null,
          firstAppointmentHour: (data.firstAppointmentHour && data.firstAppointmentHour !== 'null') ? data.firstAppointmentHour : null,
          sessionDay: (data.sessionDay && data.sessionDay !== 'null') ? data.sessionDay : null,
          sessionHour: (data.sessionHour && data.sessionHour !== 'null') ? data.sessionHour : null,
          ip: orderIp((data as any).ip),
        },
        transaction: tx,
      },
    );
    const insertedId = (result as any)[0]?.ID;
    if (!insertedId) throw new Error('Failed to create order — no ID returned');
    // Same transaction: a read on another connection would wait on the uncommitted insert.
    const model = await OrderModel.findByPk(insertedId, { transaction: tx });
    return this.toDomain(model!);
  }

  async updateStatus(id: number, statusId: number): Promise<Order | null> {
    await OrderModel.sequelize!.query(
      `UPDATE tbOrders SET OrderStatusID = :statusId, DateModified = GETDATE() WHERE ID = :id`,
      { replacements: { statusId, id } },
    );
    // Paid (2 Em Analise) or confirmed (3): a customer with no access group yet (e.g. a Google signup) becomes a
    // VIP customer (group 1), which unlocks Moses and downloads for them. Existing groups are never touched.
    if (statusId === 2 || statusId === 3) {
      const changed = await OrderModel.sequelize!.query<{ ID: number }>(
        `DECLARE @changed TABLE (ID int);
         UPDATE tbCustomers SET GroupID = 1, DateModified = GETDATE()
         OUTPUT INSERTED.ID INTO @changed
         WHERE ID = (SELECT CustomerID FROM tbOrders WHERE ID = :id) AND ISNULL(GroupID, 0) = 0;
         SELECT ID FROM @changed`,
        { replacements: { id }, type: QueryTypes.SELECT },
      );
      // VIP access in the apps follows the group in real time (CouponAPI)
      for (const c of changed) void publishCustomerGroupChanged(c.ID, 1);
    }
    const model = await OrderModel.findByPk(id);
    return model ? this.toDomain(model) : null;
  }

  async ownsPaymentIdentifier(customerId: number, identifier: string): Promise<boolean> {
    if (!customerId || !identifier) return false;
    const rows = await OrderModel.sequelize!.query<any>(
      `SELECT TOP 1 ID FROM tbOrders WHERE CustomerID = :customerId AND Identifier = :identifier`,
      { replacements: { customerId, identifier }, type: QueryTypes.SELECT },
    );
    return rows.length > 0;
  }

  async findByPaymentIdentifier(identifier: string): Promise<Order | null> {
    if (!identifier || identifier.length > 100) return null;
    const rows = await OrderModel.sequelize!.query<any>(
      `SELECT TOP 1 ID FROM tbOrders WHERE Identifier = :identifier ORDER BY ID DESC`,
      { replacements: { identifier }, type: QueryTypes.SELECT },
    );
    return rows.length ? this.findById(rows[0].ID) : null;
  }

  async recentPendingBoletoOrderIds(days: number, limit: number): Promise<number[]> {
    const rows = await OrderModel.sequelize!.query<any>(
      `SELECT TOP (:limit) ID FROM tbOrders
       WHERE OrderStatusID = 1 AND FormaPagamento = 4 AND Identifier IS NOT NULL AND Identifier <> ''
         AND DateCreated > DATEADD(day, -:days, GETDATE())
       ORDER BY ID DESC`,
      { replacements: { days, limit }, type: QueryTypes.SELECT },
    );
    return rows.map((r) => Number(r.ID));
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
      model.ip || null,
    );
  }
}
