/**
 * Which service runs the session background jobs (daily reminder, Google Calendar sync). They moved to SessionAPI
 * (SRP phase 3, 2026-11-19); SessionAPI reads the same variable the other way round, so the jobs never run in both.
 * SESSION_JOBS_OWNER=contract-api hands them back to ContractAPI (rollback); unset or anything else = SessionAPI.
 */
export function sessionJobsRunHere(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SESSION_JOBS_OWNER || '').trim().toLowerCase() === 'contract-api';
}
