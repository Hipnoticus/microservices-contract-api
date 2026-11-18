import { IOrderRepository } from '../../domain/repositories/IOrderRepository';
import { Order } from '../../domain/entities/Order';
import { Sequelize, QueryTypes, Transaction } from 'sequelize';
import { Logger } from '../../shared/logger/Logger';
import * as crypto from 'crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import { packagePrice } from '../payment/PaymentPolicy';
import { SignupCustomer, validateSignupCustomer } from '../order/SignupValidation';
import { loadAgenda, validateOrderSchedule } from '../order/ScheduleRules';
import { orderSubmissions } from '../order/OrderSubmissions';

const logger = new Logger('CreateOrderUseCase');

export interface CustomerDTO {
  firstName: string;
  lastName: string;
  cpf: string;
  email: string;
  phone: string;
  birthDate: string;
  gender: string;
  address: {
    cep: string;
    street: string;
    number: string;
    complement: string;
    neighborhood: string;
    city: string;
    state: string;
    country?: string;
  };
}

export interface CreateOrderDTO {
  customer: CustomerDTO;
  mainGoal: string;
  paymentMethodId: number;
  firstAppointmentDay: number;
  firstAppointmentHour: string;
  sessionDay: number;
  sessionHour: string;
  total: number;
  installments: number;
  packageId: number;
  packageSize: number;
}

/** Who sent the request (resolved by the controller from CF-Connecting-IP / X-Forwarded-For). */
export interface RequestMeta {
  ip: string;
  userAgent: string;
}

const bad = (error: string) => new HttpException({ error }, HttpStatus.BAD_REQUEST);
const intIn = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export class CreateOrderUseCase {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly sequelize: Sequelize,
  ) {}

  async execute(dto: CreateOrderDTO, meta: RequestMeta = { ip: 'unknown', userAgent: '' }): Promise<Order> {
    // The body is public and untrusted (incident 20261118: a bot posted it with curl). Everything is checked here,
    // before anything is written.
    if (!dto || typeof dto !== 'object') throw bad('Pedido inválido.');
    const checked = validateSignupCustomer(dto.customer);
    if (!checked.ok) {
      logger.warn(`Order refused (ip ${meta.ip}): ${checked.error}`);
      throw bad(checked.error);
    }
    const customer = checked.customer;

    const mainGoal = typeof dto.mainGoal === 'string' ? dto.mainGoal.trim() : '';
    if (!mainGoal || mainGoal.length > 255) throw bad('Informe o objetivo prioritário.');
    const paymentMethodId = intIn(dto.paymentMethodId, 1, 1000);
    if (paymentMethodId === null) throw bad('Forma de pagamento inválida.');
    const installments = intIn(dto.installments ?? 1, 1, 12);
    if (installments === null) throw bad('Número de parcelas inválido.');

    // Weekday and time of the 1ª consulta and of the weekly sessions must be offered slots in tbConfig.
    const [appointments, sessions] = await Promise.all([
      loadAgenda(this.sequelize, 'schedule.appointments'),
      loadAgenda(this.sequelize, 'schedule.sessions'),
    ]);
    const schedule = validateOrderSchedule(appointments, sessions, dto);
    if (!schedule.ok) {
      logger.warn(`Order refused (ip ${meta.ip}): ${schedule.error} [${dto.firstAppointmentDay} ${dto.firstAppointmentHour} / ${dto.sessionDay} ${dto.sessionHour}]`);
      throw bad(schedule.error);
    }

    // The order total is the package price in tbProducts, never dto.total.
    const [product] = await this.sequelize.query(
      `SELECT ID, NormalPrice, PromotionalPrice, Blocked FROM tbProducts WHERE ID = :id`,
      { replacements: { id: Number(dto?.packageId) || 0 }, type: QueryTypes.SELECT },
    ) as any[];
    const price = packagePrice(product);
    if (price === null) {
      throw bad('Pacote inválido.');
    }
    if (Math.abs(Number(dto.total) - price) > 0.005) {
      logger.warn(`Order total from the client (${dto.total}) differs from package ${dto.packageId} price (${price}); using the package price`);
    }

    const t = await this.sequelize.transaction();
    try {
      // 1. Find or create customer
      const customerId = await this.findOrCreateCustomer(customer, mainGoal, t);
      logger.info(`Customer ID: ${customerId}`);

      // 2. Create/update address
      const addressId = await this.createAddress(customerId, customer.address, t);
      logger.info(`Address ID: ${addressId}`);

      // 3. Create order
      const order = await this.orderRepository.create({
        customerId,
        customerEmail: customer.email,
        customerAddressId: addressId,
        statusId: 1, // Pendente (awaiting payment)
        mainGoal,
        paymentMethodId,
        firstAppointmentDay: String(schedule.value.firstAppointmentDay),
        firstAppointmentHour: schedule.value.firstAppointmentHour,
        sessionDay: String(schedule.value.sessionDay),
        sessionHour: schedule.value.sessionHour,
        total: price,
        installments,
        packageSize: Number(dto.packageSize) || 0,
      } as any, t);

      // 4. Link order to product
      await this.linkOrderProduct(order.id, product.ID, price, t);

      await t.commit();
      logger.info(`Order created: ${order.id} (customer ${customerId}, ip ${meta.ip})`);
      orderSubmissions.recordOrder(order.id, { ip: meta.ip, userAgent: meta.userAgent, at: new Date(), body: dto });
      return order;
    } catch (error) {
      await t.rollback();
      logger.error(`Order creation failed: ${(error as Error).message}`);
      throw error;
    }
  }

  private async findOrCreateCustomer(c: SignupCustomer, mainGoalName: string, transaction: Transaction): Promise<number> {
    // Check if customer exists by CPF or email
    const [existing] = await this.sequelize.query(
      `SELECT ID FROM tbCustomers WHERE CPFCNPJ = :cpf OR Email = :email`,
      { replacements: { cpf: c.cpf, email: c.email }, type: QueryTypes.SELECT, transaction },
    ) as any[];

    if (existing) return existing.ID;

    // Create new customer
    const passwordHash = crypto.createHash('md5').update(c.firstName).digest('hex');

    // Look up MainGoal issue ID (FK to tbIssues)
    const [issue] = await this.sequelize.query(
      `SELECT TOP 1 ID FROM tbIssues WHERE Name = :goal`,
      { replacements: { goal: mainGoalName }, type: QueryTypes.SELECT, transaction },
    ) as any[];
    const mainGoalId = issue?.ID || null;

    const [result] = await this.sequelize.query(
      `INSERT INTO tbCustomers (CallName, FirstName, LastName, Email, Password, CPFCNPJ, Sex, DateOfBirth, PhoneNumber, MainGoal, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
       OUTPUT INSERTED.ID
       VALUES (:callName, :firstName, :lastName, :email, :password, :cpf, :sex, :dob, :phone, :mainGoal, 0, GETDATE(), GETDATE(), 1, 1)`,
      {
        replacements: {
          callName: c.firstName, firstName: c.firstName, lastName: c.lastName,
          email: c.email, password: passwordHash, cpf: c.cpf,
          sex: c.gender,
          dob: c.birthDate, phone: c.phone, mainGoal: mainGoalId,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );
    return (result as any)[0]?.ID || (result as any);
  }

  private async createAddress(customerId: number, a: SignupCustomer['address'], transaction: Transaction): Promise<number> {
    const [result] = await this.sequelize.query(
      `INSERT INTO tbCustomersAddresses (Address, Number, Address2, Town, City, State, Zip, Country, CustomerID, MainAddress, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
       OUTPUT INSERTED.ID
       VALUES (:street, :number, :complement, :neighborhood, :city, :state, :cep, :country, :customerId, 1, 0, GETDATE(), GETDATE(), 1, 1)`,
      {
        replacements: {
          street: a.street, number: a.number, complement: a.complement || '',
          neighborhood: a.neighborhood, city: a.city, state: a.state,
          cep: a.cep, country: a.country || 'Brasil', customerId,
        },
        type: QueryTypes.INSERT,
        transaction,
      },
    );
    return (result as any)[0]?.ID || (result as any);
  }

  private async linkOrderProduct(orderId: number, productId: number, value: number, transaction: Transaction): Promise<void> {
    const [product] = await this.sequelize.query(
      `SELECT ID, Name, PromotionalPrice FROM tbProducts WHERE ID = :id`,
      { replacements: { id: productId }, type: QueryTypes.SELECT, transaction },
    ) as any[];

    if (product) {
      await this.sequelize.query(
        `INSERT INTO tbOrdersProducts (OrderID, ProductID, ProductName, ProductValue, ProductQuantity, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
         VALUES (:orderId, :productId, :name, :value, 1, 0, GETDATE(), GETDATE(), 1, 1)`,
        {
          replacements: {
            orderId, productId: product.ID,
            name: product.Name, value: String(product.PromotionalPrice || value),
          },
          transaction,
        },
      );
    }
  }
}
