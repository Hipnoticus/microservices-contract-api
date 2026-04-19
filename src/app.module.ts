import { Module } from '@nestjs/common';
import { Sequelize } from 'sequelize';
import { initializeOrderModel } from './infrastructure/persistence/models/OrderModel';
import { initializePackageModel } from './infrastructure/persistence/models/PackageModel';
import { initializePaymentMethodModel } from './infrastructure/persistence/models/PaymentMethodModel';
import { initializeOrderStatusModel } from './infrastructure/persistence/models/OrderStatusModel';
import { SequelizeOrderRepository } from './infrastructure/persistence/repositories/SequelizeOrderRepository';
import { SequelizePackageRepository } from './infrastructure/persistence/repositories/SequelizePackageRepository';
import { CreateOrderUseCase } from './application/use-cases/CreateOrderUseCase';
import { ListPackagesUseCase } from './application/use-cases/ListPackagesUseCase';
import { ProcessPaymentUseCase } from './application/use-cases/ProcessPaymentUseCase';
import { SendConfirmationEmailUseCase } from './application/use-cases/SendConfirmationEmailUseCase';
import { ConfirmPaymentUseCase } from './application/use-cases/ConfirmPaymentUseCase';
import { CreateSessionsUseCase } from './application/use-cases/CreateSessionsUseCase';
import { CieloGateway } from './infrastructure/payment/CieloGateway';
import { BancoInterGateway } from './infrastructure/payment/BancoInterGateway';
import { PaymentPollingService } from './infrastructure/payment/PaymentPollingService';
import { OrderController } from './interfaces/http/controllers/OrderController';
import { PackageController } from './interfaces/http/controllers/PackageController';
import { PaymentMethodController, OrderStatusController } from './interfaces/http/controllers/PaymentMethodController';
import { PaymentController } from './interfaces/http/controllers/PaymentController';
import { ConfigController } from './interfaces/http/controllers/ConfigController';
import { ScheduleController } from './interfaces/http/controllers/ScheduleController';
import { CustomerCardController } from './interfaces/http/controllers/CustomerCardController';
import { initializeCustomerCardModel } from './infrastructure/persistence/models/CustomerCardModel';
import { Logger } from './shared/logger/Logger';

const logger = new Logger('AppModule');

@Module({
  controllers: [OrderController, PackageController, PaymentMethodController, OrderStatusController, PaymentController, ConfigController, ScheduleController, CustomerCardController],
  providers: [
    {
      provide: 'DATABASE',
      useFactory: async () => {
        const host = process.env.HOST || 'localhost';
        const port = parseInt(process.env.SQL_PORT || '1433', 10);
        const database = process.env.DB || 'Hipnoticus';
        const username = process.env.USER || 'sa';
        const password = process.env.PASSWORD || '';
        const dialect = (process.env.DIALECT as 'mssql') || 'mssql';

        logger.info(`Connecting to ${dialect}://${host}:${port}/${database}`);

        const sequelize = new Sequelize({
          dialect, host, port, database, username, password,
          logging: false,
          dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
        });

        initializeOrderModel(sequelize);
        initializePackageModel(sequelize);
        initializePaymentMethodModel(sequelize);
        initializeOrderStatusModel(sequelize);
        initializeCustomerCardModel(sequelize);

        await sequelize.authenticate();
        logger.info('Database connection established');
        return sequelize;
      },
    },
    {
      provide: 'ORDER_REPOSITORY',
      useFactory: () => new SequelizeOrderRepository(),
    },
    {
      provide: 'PACKAGE_REPOSITORY',
      useFactory: () => new SequelizePackageRepository(),
    },
    {
      provide: CreateOrderUseCase,
      useFactory: (repo: SequelizeOrderRepository, db: Sequelize) => new CreateOrderUseCase(repo, db),
      inject: ['ORDER_REPOSITORY', 'DATABASE'],
    },
    {
      provide: ListPackagesUseCase,
      useFactory: (repo: SequelizePackageRepository) => new ListPackagesUseCase(repo),
      inject: ['PACKAGE_REPOSITORY'],
    },
    {
      provide: 'CIELO_GATEWAY',
      useFactory: () => {
        // Always use production credentials — test mode only changes the amount
        // (mirrors legacy: production Cielo even for test transactions)
        const merchantId = process.env.CIELO_MERCHANT_ID || '';
        const merchantKey = process.env.CIELO_MERCHANT_KEY || '';
        if (!merchantId || !merchantKey) {
          logger.warn('Cielo credentials not configured — credit card payments disabled');
          return null;
        }
        logger.info(`Cielo gateway: PRODUCTION merchantId=${merchantId.substring(0, 8)}...`);
        return new CieloGateway({ merchantId, merchantKey, sandbox: false });
      },
    },
    {
      provide: 'BANCO_INTER_GATEWAY',
      useFactory: () => {
        const clientId = process.env.BANCO_INTER_CLIENT_ID || '';
        const clientSecret = process.env.BANCO_INTER_CLIENT_SECRET || '';
        if (!clientId || !clientSecret) {
          logger.warn('Banco Inter credentials not configured — boleto/PIX payments disabled');
          return null;
        }
        logger.info('Banco Inter gateway: PRODUCTION');
        return new BancoInterGateway({
          clientId,
          clientSecret,
          certPath: process.env.BANCO_INTER_CERT_PATH || '',
          keyPath: process.env.BANCO_INTER_KEY_PATH || '',
          accountNumber: process.env.BANCO_INTER_ACCOUNT || '',
          pixKey: process.env.BANCO_INTER_PIX_KEY || '12344385000193',
          scope: process.env.BANCO_INTER_SCOPE || 'boleto-cobranca.read boleto-cobranca.write pix.write pix.read cob.read cob.write',
          sandbox: false,
        });
      },
    },
    {
      provide: 'SEND_EMAIL',
      useFactory: (db: Sequelize) => {
        const emailApiUrl = process.env.EMAIL_API_URL || 'http://hipnoticus-email-api:8100';
        return new SendConfirmationEmailUseCase(db, emailApiUrl);
      },
      inject: ['DATABASE'],
    },
    {
      provide: 'PROCESS_PAYMENT',
      useFactory: (repo: SequelizeOrderRepository, cielo: CieloGateway | null, inter: BancoInterGateway | null, db: Sequelize, emailUseCase: SendConfirmationEmailUseCase) =>
        new ProcessPaymentUseCase(repo, cielo, inter, db, emailUseCase),
      inject: ['ORDER_REPOSITORY', 'CIELO_GATEWAY', 'BANCO_INTER_GATEWAY', 'DATABASE', 'SEND_EMAIL'],
    },
    {
      provide: 'CONFIRM_PAYMENT',
      useFactory: (repo: SequelizeOrderRepository, emailUseCase: SendConfirmationEmailUseCase, db: Sequelize) => {
        const createSessions = new CreateSessionsUseCase(db);
        return new ConfirmPaymentUseCase(repo, emailUseCase, db, createSessions);
      },
      inject: ['ORDER_REPOSITORY', 'SEND_EMAIL', 'DATABASE'],
    },
    {
      provide: 'PAYMENT_POLLING',
      useFactory: (db: Sequelize, inter: BancoInterGateway | null, confirmUseCase: ConfirmPaymentUseCase) => {
        const service = new PaymentPollingService(db, inter, confirmUseCase);
        service.start();
        return service;
      },
      inject: ['DATABASE', 'BANCO_INTER_GATEWAY', 'CONFIRM_PAYMENT'],
    },
  ],
})
export class AppModule {}
