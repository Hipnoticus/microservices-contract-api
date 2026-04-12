import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import { initTracing, shutdownTracing } from './infrastructure/cloud/TracingSetup';
initTracing();

import { loadCloudConfig } from './infrastructure/cloud/ConfigClient';
import { registerWithEureka, deregisterFromEureka } from './infrastructure/cloud/DiscoveryClient';
import { NestFactory } from '@nestjs/core';
import { Logger } from './shared/logger/Logger';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

const logger = new Logger('Main');

async function bootstrap(): Promise<void> {
  const config = await loadCloudConfig();
  const { serverPort, applicationName } = config;

  const app = await NestFactory.create(AppModule);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Contract Service API')
    .setDescription('Package contracting, order management, and payment processing')
    .setVersion('1.0.0')
    .addServer('/contract-service', 'API Gateway')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, document);

  await app.listen(serverPort);
  logger.info(`*** ${applicationName} listening on http://localhost:${serverPort} ***`);

  registerWithEureka(serverPort);

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down...`);
    await app.close();
    await deregisterFromEureka();
    await shutdownTracing();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  logger.error('Failed to start application:', error);
  process.exit(1);
});
