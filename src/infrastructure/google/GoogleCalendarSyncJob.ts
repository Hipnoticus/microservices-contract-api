/**
 * GoogleCalendarSyncJob — background job pushing the agenda to every connected Google account.
 * Same pattern as PaymentPollingService: first run 30 s after start, then every
 * GCAL_SYNC_INTERVAL_MS (default 5 minutes). Disabled when the OAuth client is not configured.
 */
import { SyncGoogleCalendarUseCase } from '../../application/use-cases/SyncGoogleCalendarUseCase';
import { IGoogleCalendarRepository } from '../persistence/repositories/GoogleCalendarRepository';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('GoogleCalendarSyncJob');

export class GoogleCalendarSyncJob {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private readonly useCase: SyncGoogleCalendarUseCase | null,
    private readonly repo: IGoogleCalendarRepository,
    private readonly intervalMs: number = 5 * 60 * 1000,
  ) {}

  start(): void {
    if (!this.useCase) {
      logger.warn('Google Calendar OAuth client not configured (GCAL_OAUTH_CLIENT_ID/SECRET, GCAL_TOKEN_ENC_KEY) — agenda sync disabled');
      return;
    }
    logger.info(`Google Calendar agenda sync started (interval: ${this.intervalMs / 1000}s)`);
    setTimeout(() => this.run(), 30000);
    this.intervalId = setInterval(() => this.run(), this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async run(): Promise<void> {
    if (this.busy || !this.useCase) return;
    this.busy = true;
    try {
      await this.repo.purgeExpiredTickets();
      await this.useCase.syncAll();
    } catch (e) {
      logger.error(`Google Calendar sync run failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
