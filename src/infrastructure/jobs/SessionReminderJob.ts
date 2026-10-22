import { QueryTypes, Sequelize } from 'sequelize';
import { SessionEmailService } from '../../application/admin/SessionEmailService';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('SessionReminderJob');

/**
 * Daily reminder: the replacement for ControleWeb's cron.asp. Every session tomorrow whose status is Confirmada gets
 * the confirmation e-mail again, once a day.
 *
 * OFF unless SESSION_REMINDER_JOB=on, because cron.asp may still be scheduled against ControleWeb and running both
 * would e-mail every client twice. Turn this on and retire the cron.asp schedule together.
 *
 * Runs at SESSION_REMINDER_HOUR (Brasília, default 9). The last run day is kept in tbConfig
 * ('sessions.reminder.lastrun') so a restart never sends the same day twice.
 */
export class SessionReminderJob {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private readonly db: Sequelize,
    private readonly email: SessionEmailService,
    private readonly hour = parseInt(process.env.SESSION_REMINDER_HOUR || '9', 10),
  ) {}

  start(): void {
    if ((process.env.SESSION_REMINDER_JOB || '').toLowerCase() !== 'on') {
      logger.info('Session reminder job off (SESSION_REMINDER_JOB != on; cron.asp may still be doing it)');
      return;
    }
    logger.info(`Session reminder job on, daily after ${this.hour}:00 BRT`);
    this.intervalId = setInterval(() => this.tick(), 10 * 60 * 1000);
    setTimeout(() => this.tick(), 60000);
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
  }

  /** Brasília wall clock, independent of the container's time zone. */
  private nowBrt(): { day: string; hour: number } {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
    const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24 };
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    const { day, hour } = this.nowBrt();
    if (hour < this.hour) return;
    this.busy = true;
    try {
      const last = await this.db.query<any>(`SELECT CAST(Value AS varchar(20)) AS v FROM tbConfig WHERE Name = 'sessions.reminder.lastrun'`,
        { type: QueryTypes.SELECT });
      if (last[0]?.v === day) return;
      await this.markRun(day, last.length > 0);

      const sessions = await this.db.query<any>(`
        SELECT s.ID AS id FROM tbSessions s
        INNER JOIN tbSessionsStatus ss ON CAST(ss.ID AS varchar(10)) = LTRIM(RTRIM(s.Status))
        WHERE ss.Name = 'Confirmada'
          AND CAST(s.DateBegins AS date) = DATEADD(day, 1, CAST(:day AS date))
          AND ISNULL(s.Blocked, 0) = 0`, { replacements: { day }, type: QueryTypes.SELECT });
      let ok = 0;
      for (const s of sessions) {
        try { await this.email.sendConfirmation(Number(s.id)); ok++; } catch (e) {
          logger.warn(`Reminder for session ${s.id} failed: ${(e as Error).message}`);
        }
      }
      logger.info(`Reminders for ${day}+1: ${ok}/${sessions.length} sent`);
    } catch (e) {
      logger.error(`Reminder run failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async markRun(day: string, exists: boolean): Promise<void> {
    if (exists) {
      await this.db.query(`UPDATE tbConfig SET Value = :day, DateModified = GETDATE() WHERE Name = 'sessions.reminder.lastrun'`, { replacements: { day } });
    } else {
      await this.db.query(`INSERT INTO tbConfig (Name, Value, Type, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
        VALUES ('sessions.reminder.lastrun', :day, 'text', 0, GETDATE(), GETDATE(), '1', '1')`, { replacements: { day } });
    }
  }
}
