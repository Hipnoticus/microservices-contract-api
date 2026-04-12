import client from 'cloud-config-client';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('ConfigClient');

/**
 * Application configuration loaded from Spring Cloud Config Server.
 */
export interface AppConfig {
  serverPort: number;
  applicationName: string;
  raw: any;
}

/**
 * Load configuration from Spring Cloud Config Server.
 *
 * Uses `cloud-config-client` package (same as HypnoticMaterialAPI).
 * Falls back to environment variables when Config Server is unavailable.
 */
export async function loadCloudConfig(): Promise<AppConfig> {
  const configEndpoint =
    process.env.HIPNOTICUS_CONFIG_CLIENT_SERVER_CONFIG_URI_AUTHENTICATED;

  if (!configEndpoint) {
    logger.warn(
      'No Config Server endpoint configured — using environment defaults',
    );
    return {
      serverPort: parseInt(process.env.PORT || '3002', 10),
      applicationName:
        process.env.CLOUD_APPLICATION_NAME || 'contract-service',
      raw: null,
    };
  }

  try {
    const config = await client.load({
      endpoint: configEndpoint,
      name: 'contract-service',
      profiles: 'default',
    });

    const serverPort =
      config.get('server.port') ||
      parseInt(process.env.PORT || '3002', 10);
    const applicationName =
      config.get('spring.application.name') || 'contract-service';

    logger.info(
      `Config loaded from Cloud Config Server — port: ${serverPort}, app: ${applicationName}`,
    );
    return { serverPort, applicationName, raw: config };
  } catch (error) {
    logger.error(
      'Failed to load Cloud Config — falling back to env defaults',
      error as Error,
    );
    return {
      serverPort: parseInt(process.env.PORT || '3002', 10),
      applicationName:
        process.env.CLOUD_APPLICATION_NAME || 'contract-service',
      raw: null,
    };
  }
}
