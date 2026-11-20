import { afterEach, describe, expect, test } from 'bun:test';
import { SessionReminderJob } from '../src/infrastructure/jobs/SessionReminderJob';
import { GoogleCalendarSyncJob } from '../src/infrastructure/google/GoogleCalendarSyncJob';
import { sessionJobsRunHere } from '../src/shared/sessionJobsOwner';

/**
 * The session reminder and the Google Calendar sync moved to SessionAPI (SRP phase 3, 2026-11-19). ContractAPI keeps
 * the code but runs the jobs only when SESSION_JOBS_OWNER=contract-api, the variable SessionAPI reads the other way
 * round, so the jobs never run in both services.
 */
const saved = { owner: process.env.SESSION_JOBS_OWNER, reminder: process.env.SESSION_REMINDER_JOB };
afterEach(() => {
  process.env.SESSION_JOBS_OWNER = saved.owner;
  process.env.SESSION_REMINDER_JOB = saved.reminder;
  if (saved.owner === undefined) delete process.env.SESSION_JOBS_OWNER;
  if (saved.reminder === undefined) delete process.env.SESSION_REMINDER_JOB;
});

const fakeSync: any = { syncAll: async () => {} };
const fakeRepo: any = { purgeExpiredTickets: async () => {} };

describe('SESSION_JOBS_OWNER', () => {
  test('default (unset) and session-api: the jobs are off in ContractAPI', () => {
    for (const owner of [undefined, '', 'session-api', 'whatever']) {
      if (owner === undefined) delete process.env.SESSION_JOBS_OWNER; else process.env.SESSION_JOBS_OWNER = owner;
      process.env.SESSION_REMINDER_JOB = 'on';
      expect(sessionJobsRunHere()).toBe(false);
      const reminder = new SessionReminderJob({} as any, {} as any);
      reminder.start();
      expect((reminder as any).intervalId).toBeNull();
      const gcal = new GoogleCalendarSyncJob(fakeSync, fakeRepo, 300000);
      gcal.start();
      expect((gcal as any).intervalId).toBeNull();
    }
  });

  test('contract-api hands the jobs back to ContractAPI (reminder still needs SESSION_REMINDER_JOB=on)', () => {
    process.env.SESSION_JOBS_OWNER = ' Contract-API ';
    expect(sessionJobsRunHere()).toBe(true);
    process.env.SESSION_REMINDER_JOB = 'off';
    const off = new SessionReminderJob({} as any, {} as any);
    off.start();
    expect((off as any).intervalId).toBeNull();
    process.env.SESSION_REMINDER_JOB = 'on';
    const reminder = new SessionReminderJob({} as any, {} as any);
    reminder.start();
    expect((reminder as any).intervalId).not.toBeNull();
    reminder.stop();
    const gcal = new GoogleCalendarSyncJob(fakeSync, fakeRepo, 300000);
    gcal.start();
    expect((gcal as any).intervalId).not.toBeNull();
    gcal.stop();
  });
});
