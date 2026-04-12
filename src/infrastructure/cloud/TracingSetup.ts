import { NodeSDK } from '@opentelemetry/sdk-node';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('TracingSetup');
let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry tracing with Zipkin exporter.
 *
 * Must be called BEFORE importing Express/NestJS to instrument HTTP.
 * Follows same pattern as HypnoticMaterialAPI.
 */
export function initTracing(): void {
  const zipkinEndpoint =
    process.env.ZIPKIN_ENDPOINT || 'http://zipkin:9411/api/v2/spans';

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: 'ISSUE-SERVICE',
    }),
    traceExporter: new ZipkinExporter({ url: zipkinEndpoint }),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
    ],
  });

  sdk.start();
  logger.info(
    `Tracing initialized — Zipkin endpoint: ${zipkinEndpoint}`,
  );
}

/**
 * Gracefully shut down the OpenTelemetry SDK.
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    logger.info('Tracing shut down');
  }
}
