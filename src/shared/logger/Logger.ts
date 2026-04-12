/**
 * Logger
 *
 * Simple structured logger for consistent logging across the application.
 * Outputs JSON for ELK/Zipkin tracing integration.
 */
export class Logger {
  constructor(private readonly context: string) {}

  info(message: string, meta?: any): void {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        context: this.context,
        message,
        ...(meta && { meta }),
      }),
    );
  }

  warn(message: string, meta?: any): void {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        context: this.context,
        message,
        ...(meta && { meta }),
      }),
    );
  }

  error(message: string, error?: Error, meta?: any): void {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        context: this.context,
        message,
        error: error ? { name: error.name, message: error.message } : undefined,
        ...(meta && { meta }),
      }),
    );
  }

  debug(message: string, meta?: any): void {
    if (process.env.DEBUG === 'true') {
      console.debug(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'DEBUG',
          context: this.context,
          message,
          ...(meta && { meta }),
        }),
      );
    }
  }
}
