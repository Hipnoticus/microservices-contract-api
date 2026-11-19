import { Eureka } from '@rocketsoftware/eureka-js-client';
import ip from 'ip';
import os from 'os';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('DiscoveryClient');
let eurekaClient: Eureka | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let stopping = false;

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/** Replace the user:password part of any URL with ***. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, '//***:***@');
  }
  if (value instanceof Error) {
    return `${value.name}: ${redact(value.message)}`;
  }
  return value;
}

/**
 * eureka-js-client logger that never prints the Eureka credentials
 * (the library logs the full endpoint URL, user:password included, on errors).
 */
const LEVELS: Record<string, number> = { debug: 20, info: 30, warn: 40, error: 50 };
const eurekaLogger = {
  current: LEVELS.warn,
  level(val?: string | number): number {
    if (val) this.current = typeof val === 'string' ? LEVELS[val] ?? LEVELS.warn : val;
    return this.current;
  },
  log(method: 'debug' | 'info' | 'warn' | 'error', args: unknown[]): void {
    if (this.current <= LEVELS[method]) {
      // eslint-disable-next-line no-console
      console[method](...args.map(redact));
    }
  },
  debug(...args: unknown[]) { this.log('debug', args); },
  info(...args: unknown[]) { this.log('info', args); },
  warn(...args: unknown[]) { this.log('warn', args); },
  error(...args: unknown[]) { this.log('error', args); },
};

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
    logger.error('Failed to parse Eureka URL: ' + String(redact(rawUrl)));
    return;
  }

  const appName =
    process.env.CLOUD_APPLICATION_NAME || 'contract-service';
  const instanceIp = ip.address();

  eurekaClient = new Eureka({
    logger: eurekaLogger,
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

  // A failed start never registers or heartbeats again (e.g. Eureka still
  // booting after a host restart), so keep retrying until it succeeds.
  const client = eurekaClient;
  const start = (delayMs: number): void => {
    client.start((error?: Error) => {
      if (stopping) return;
      if (!error) {
        logger.info(
          `Registered with Eureka as "${appName}" on port ${serverPort}`,
        );
        return;
      }
      logger.error(
        `Eureka registration failed, retrying in ${delayMs / 1000}s:`,
        new Error(String(redact(error.message))),
      );
      retryTimer = setTimeout(
        () => start(Math.min(delayMs * 2, RETRY_MAX_MS)),
        delayMs,
      );
    });
  };
  start(RETRY_MIN_MS);
}

/**
 * Deregister from Eureka (call on shutdown).
 */
export function deregisterFromEureka(): Promise<void> {
  stopping = true;
  if (retryTimer) clearTimeout(retryTimer);
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
