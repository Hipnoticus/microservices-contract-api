import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import { initTracing, shutdownTracing } from './infrastructure/cloud/TracingSetup';
import { serverSpanMiddleware } from './infrastructure/cloud/ServerSpans';
initTracing();

import { loadCloudConfig } from './infrastructure/cloud/ConfigClient';
import { registerWithEureka, deregisterFromEureka } from './infrastructure/cloud/DiscoveryClient';
import { NestFactory } from '@nestjs/core';
import { Logger } from './shared/logger/Logger';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { internalAuthFromEnv, internalAuthMiddleware } from './interfaces/http/auth/InternalAuth';

/**
 * Routes ContractAPI serves without a gateway signature or caller token (AGENTS.md "Internal-call authentication"):
 * the ones public at the gateway (catalogue, checkout, payment status, Banco Inter callbacks, leads).
 */
export const INTERNAL_AUTH_PUBLIC_ROUTES = [
  'GET /packages/**', 'GET /payment-methods/**', 'GET /order-statuses/**', 'GET /schedule/**', 'GET /config/payment',
  'POST /orders', 'POST /payments/process', 'GET /payments/status/*', 'GET /payments/stream/*',
  'POST /payments/webhook/banco-inter', 'POST /payments/webhook/banco-inter/pix', 'POST /leads/register',
  'GET /contratar/prefill/*', '/google-calendar/**',
];

const logger = new Logger('Main');

async function bootstrap(): Promise<void> {
  const config = await loadCloudConfig();
  const { serverPort, applicationName } = config;

  const app = await NestFactory.create(AppModule);
  // SERVER span per request: Bun's http instrumentation records only outgoing calls (ServerSpans.ts)
  app.use(serverSpanMiddleware());
  // Internal-call authentication before every route; the gateway's X-Internal-Token (AUDIT_TOKEN) stays accepted on
  // /internal/audit during the transition
  app.use(internalAuthMiddleware(internalAuthFromEnv(INTERNAL_AUTH_PUBLIC_ROUTES,
    [{ header: 'X-Internal-Token', list: process.env.AUDIT_TOKEN ? 'gateway:' + process.env.AUDIT_TOKEN : '' }]),
    (level, msg) => (level === 'warn' ? logger.warn(msg) : logger.info(msg))));

  // API docs only where explicitly enabled (dev). In production they mapped every payment route for an attacker
  // (incident 20261118).
  if (process.env.EXPOSE_API_DOCS === 'true') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Contract Service API')
      .setDescription('Package contracting, order management, and payment processing')
      .setVersion('1.0.0')
      .addServer('/contract-service', 'API Gateway')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api-docs', app, document);
  } else {
    logger.info('API docs disabled (set EXPOSE_API_DOCS=true to serve /api-docs)');
  }

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
