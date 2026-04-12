import { Eureka } from '@rocketsoftware/eureka-js-client';
import ip from 'ip';
import os from 'os';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('DiscoveryClient');
let eurekaClient: Eureka | null = null;

/**
 * Register this service instance with Eureka.
 *
 * Follows the same pattern as HypnoticMaterialAPI:
 * - Reads HIPNOTICUS_DISCOVERY_CLIENT_SERVICE_URL_DEFAULT_ZONE
 * - Parses credentials from URL
 * - Exposes /actuator/health and /actuator/info for monitoring
 */
export function registerWithEureka(serverPort: number): void {
  const rawUrl =
    process.env.HIPNOTICUS_DISCOVERY_CLIENT_SERVICE_URL_DEFAULT_ZONE;

  if (!rawUrl) {
    logger.warn('No Eureka URL configured — skipping service registration');
    return;
  }

  let eurekaHost: string;
  let eurekaPort: number;

  try {
    const url = new URL(rawUrl);
    eurekaHost = `${url.username}:${url.password}@${url.hostname}`;
    eurekaPort = parseInt(url.port, 10) || 8082;
  } catch {
    logger.error('Failed to parse Eureka URL: ' + rawUrl);
    return;
  }

  const appName =
    process.env.CLOUD_APPLICATION_NAME || 'contract-service';
  const instanceIp = ip.address();

  eurekaClient = new Eureka({
    instance: {
      instanceId: `${instanceIp}:${appName}:${serverPort}`,
      app: appName,
      hostName: os.hostname(),
      ipAddr: instanceIp,
      port: { $: serverPort, '@enabled': true },
      vipAddress: appName,
      secureVipAddress: appName,
      dataCenterInfo: {
        name: 'MyOwn',
        '@class':
          'com.netflix.appinfo.InstanceInfo$DefaultDataCenterInfo',
      },
      statusPageUrl: `http://${instanceIp}:${serverPort}/actuator/info`,
      healthCheckUrl: `http://${instanceIp}:${serverPort}/actuator/health`,
    },
    eureka: {
      host: eurekaHost,
      servicePath: '/eureka/apps/',
      port: eurekaPort,
    },
  });

  eurekaClient.logger.level('debug');
  eurekaClient.start((error?: Error) => {
    if (error) logger.error('Eureka registration failed:', error);
    else
      logger.info(
        `Registered with Eureka as "${appName}" on port ${serverPort}`,
      );
  });
}

/**
 * Deregister from Eureka (call on shutdown).
 */
export function deregisterFromEureka(): Promise<void> {
  return new Promise((resolve) => {
    if (eurekaClient) {
      eurekaClient.stop(() => {
        logger.info('Deregistered from Eureka');
        resolve();
      });
    } else {
      resolve();
    }
  });
}
