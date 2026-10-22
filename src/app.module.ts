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
import { TreatmentController } from './interfaces/http/controllers/TreatmentController';
import { NFSeController } from './interfaces/http/controllers/NFSeController';
import { LeadController } from './interfaces/http/controllers/LeadController';
import { HealthController } from './interfaces/http/controllers/HealthController';
import { ExternalPaymentController } from './interfaces/http/controllers/ExternalPaymentController';
import { GoogleCalendarController, GoogleCalendarContext } from './interfaces/http/controllers/GoogleCalendarController';
import { GoogleCalendarClient } from './infrastructure/google/GoogleCalendarClient';
import { GoogleCalendarSyncJob } from './infrastructure/google/GoogleCalendarSyncJob';
import { TokenCrypto } from './infrastructure/google/TokenCrypto';
import { GoogleCalendarRepository } from './infrastructure/persistence/repositories/GoogleCalendarRepository';
import { SyncGoogleCalendarUseCase } from './application/use-cases/SyncGoogleCalendarUseCase';
import { initializeCustomerCardModel } from './infrastructure/persistence/models/CustomerCardModel';
import { Logger } from './shared/logger/Logger';
import { AdminAgendaController, AdminCustomerController, AdminTreatmentController, AdminSettingsController, AdminHomeController } from './interfaces/http/controllers/AdminControllers';
import { SessionAdminService } from './application/admin/SessionAdminService';
import { SessionEmailService } from './application/admin/SessionEmailService';
import { AdminDataService } from './application/admin/AdminDataService';
import { SessionReminderJob } from './infrastructure/jobs/SessionReminderJob';

const logger = new Logger('AppModule');

@Module({
  controllers: [OrderController, PackageController, PaymentMethodController, OrderStatusController, PaymentController, ConfigController, ScheduleController, CustomerCardController, TreatmentController, NFSeController, LeadController, HealthController, ExternalPaymentController, GoogleCalendarController,
    AdminAgendaController, AdminCustomerController, AdminTreatmentController, AdminSettingsController, AdminHomeController],
  providers: [
    // ---- Moses admin area (staff JWT verified in ContractAPI itself, see interfaces/http/auth/StaffAuth.ts) ----
    {
      provide: 'SESSION_ADMIN',
      useFactory: (db: Sequelize) => new SessionAdminService(db),
      inject: ['DATABASE'],
    },
    {
      provide: 'SESSION_EMAIL',
      useFactory: (db: Sequelize) => new SessionEmailService(db, process.env.EMAIL_API_URL || 'http://hipnoticus-email-api:8100'),
      inject: ['DATABASE'],
    },
    {
      provide: 'ADMIN_DATA',
      useFactory: (db: Sequelize) => new AdminDataService(db),
      inject: ['DATABASE'],
    },
    {
      // cron.asp replacement; off unless SESSION_REMINDER_JOB=on
      provide: 'SESSION_REMINDER_JOB',
      useFactory: (db: Sequelize, email: SessionEmailService) => {
        const job = new SessionReminderJob(db, email);
        job.start();
        return job;
      },
      inject: ['DATABASE', 'SESSION_EMAIL'],
    },
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
      useFactory: (repo: SequelizeOrderRepository, cielo: CieloGateway | null, inter: BancoInterGateway | null, db: Sequelize, emailUseCase: SendConfirmationEmailUseCase) => {
        const createSessions = new CreateSessionsUseCase(db);
        return new ProcessPaymentUseCase(repo, cielo, inter, db, emailUseCase, createSessions);
      },
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
    {
      // One-way agenda -> Google Calendar sync. Without credentials the endpoints answer 503 and the job stays off.
      provide: 'GCAL_CONTEXT',
      useFactory: (db: Sequelize): GoogleCalendarContext => {
        const repo = new GoogleCalendarRepository(db);
        const clientId = process.env.GCAL_OAUTH_CLIENT_ID || '';
        const clientSecret = process.env.GCAL_OAUTH_CLIENT_SECRET || '';
        const redirectUri = process.env.GCAL_OAUTH_REDIRECT_URI
          || 'https://api.hipnoticus.com.br/contract-service/google-calendar/oauth/callback';
        let crypto: TokenCrypto | null = null;
        try {
          crypto = process.env.GCAL_TOKEN_ENC_KEY ? new TokenCrypto(process.env.GCAL_TOKEN_ENC_KEY) : null;
        } catch (e) {
          logger.warn(`Google Calendar: ${(e as Error).message}`);
        }
        if (!clientId || !clientSecret || !crypto) {
          logger.warn('Google Calendar OAuth client not configured — agenda sync disabled');
          return { repo, client: null, crypto: null, sync: null };
        }
        const client = new GoogleCalendarClient({ clientId, clientSecret, redirectUri });
        const pastDays = parseInt(process.env.GCAL_SYNC_PAST_DAYS || '30', 10) || 30;
        logger.info(`Google Calendar sync configured (redirect ${redirectUri}, past ${pastDays} days)`);
        return { repo, client, crypto, sync: new SyncGoogleCalendarUseCase(repo, client, crypto, pastDays) };
      },
      inject: ['DATABASE'],
    },
    {
      provide: 'GCAL_SYNC_JOB',
      useFactory: (ctx: GoogleCalendarContext) => {
        const job = new GoogleCalendarSyncJob(ctx.sync, ctx.repo, parseInt(process.env.GCAL_SYNC_INTERVAL_MS || '300000', 10) || 300000);
        job.start();
        return job;
      },
      inject: ['GCAL_CONTEXT'],
    },
  ],
})
export class AppModule {}
