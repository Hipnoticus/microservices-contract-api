import { IOrderRepository } from '../../domain/repositories/IOrderRepository';
import { Order } from '../../domain/entities/Order';
import { Sequelize, QueryTypes } from 'sequelize';
import { Logger } from '../../shared/logger/Logger';
import * as crypto from 'crypto';

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

export class CreateOrderUseCase {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly sequelize: Sequelize,
  ) {}

  async execute(dto: CreateOrderDTO): Promise<Order> {
    const t = await this.sequelize.transaction();
    try {
      // 1. Find or create customer
      const customerId = await this.findOrCreateCustomer(dto.customer, dto.mainGoal);
      logger.info(`Customer ID: ${customerId}`);

      // 2. Create/update address
      const addressId = await this.createAddress(customerId, dto.customer.address);
      logger.info(`Address ID: ${addressId}`);

      // 3. Create order
      const order = await this.orderRepository.create({
        customerId,
        customerEmail: dto.customer.email,
        customerAddressId: addressId,
        statusId: 1, // Pendente (awaiting payment)
        mainGoal: dto.mainGoal,
        paymentMethodId: dto.paymentMethodId,
        firstAppointmentDay: String(dto.firstAppointmentDay),
        firstAppointmentHour: dto.firstAppointmentHour,
        sessionDay: String(dto.sessionDay),
        sessionHour: dto.sessionHour,
        total: dto.total,
        installments: dto.installments,
        packageSize: dto.packageSize,
      } as any);
      logger.info(`Order created: ${order.id}`);

      // 4. Link order to product
      if (dto.packageId) {
        await this.linkOrderProduct(order.id, dto.packageId, dto.total);
      }

      await t.commit();
      return order;
    } catch (error) {
      await t.rollback();
      logger.error(`Order creation failed: ${(error as Error).message}`);
      throw error;
    }
  }

  private async findOrCreateCustomer(c: CustomerDTO, mainGoalName: string): Promise<number> {
    // Check if customer exists by CPF or email
    const [existing] = await this.sequelize.query(
      `SELECT ID FROM tbCustomers WHERE CPFCNPJ = :cpf OR Email = :email`,
      { replacements: { cpf: c.cpf, email: c.email }, type: QueryTypes.SELECT },
    ) as any[];

    if (existing) return existing.ID;

    // Create new customer
    const passwordHash = crypto.createHash('md5').update(c.firstName).digest('hex');

    // Look up MainGoal issue ID (FK to tbIssues)
    let mainGoalId = 0;
    const [issue] = await this.sequelize.query(
      `SELECT TOP 1 ID FROM tbIssues WHERE Name = :goal`,
      { replacements: { goal: mainGoalName }, type: QueryTypes.SELECT },
    ) as any[];
    mainGoalId = issue?.ID || null;

    const [result] = await this.sequelize.query(
      `INSERT INTO tbCustomers (CallName, FirstName, LastName, Email, Password, CPFCNPJ, Sex, DateOfBirth, PhoneNumber, MainGoal, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
       OUTPUT INSERTED.ID
       VALUES (:callName, :firstName, :lastName, :email, :password, :cpf, :sex, :dob, :phone, :mainGoal, 0, GETDATE(), GETDATE(), 1, 1)`,
      {
        replacements: {
          callName: c.firstName, firstName: c.firstName, lastName: c.lastName,
          email: c.email, password: passwordHash, cpf: c.cpf,
          sex: c.gender === 'M' ? 'M' : 'F',
          dob: c.birthDate, phone: c.phone, mainGoal: mainGoalId,
        },
        type: QueryTypes.INSERT,
      },
    );
    return (result as any)[0]?.ID || (result as any);
  }

  private async createAddress(customerId: number, a: CustomerDTO['address']): Promise<number> {
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
      },
    );
    return (result as any)[0]?.ID || (result as any);
  }

  private async linkOrderProduct(orderId: number, productId: number, value: number): Promise<void> {
    const [product] = await this.sequelize.query(
      `SELECT ID, Name, PromotionalPrice FROM tbProducts WHERE ID = :id`,
      { replacements: { id: productId }, type: QueryTypes.SELECT },
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
        },
      );
    }
  }
}
