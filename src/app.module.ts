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
import { OrderController } from './interfaces/http/controllers/OrderController';
import { PackageController } from './interfaces/http/controllers/PackageController';
import { PaymentMethodController, OrderStatusController } from './interfaces/http/controllers/PaymentMethodController';
import { ScheduleController } from './interfaces/http/controllers/ScheduleController';
import { Logger } from './shared/logger/Logger';

const logger = new Logger('AppModule');

@Module({
  controllers: [OrderController, PackageController, PaymentMethodController, OrderStatusController, ScheduleController],
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
  ],
})
export class AppModule {}
