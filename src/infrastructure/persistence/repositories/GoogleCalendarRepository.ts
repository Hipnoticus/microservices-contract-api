/**
 * GoogleCalendarRepository — DB access for the one-way agenda -> Google Calendar sync.
 * Tables: tbGoogleCalendarAccounts, tbGoogleCalendarEvents, tbGoogleCalendarTickets
 * (see scripts/gcal-sync-migration.sql). Source of truth: tbSessions.
 */
import { QueryTypes, Sequelize } from 'sequelize';

export type GCalAccountStatus = 'active' | 'error' | 'revoked';

export interface GCalAccount {
  id: number;
  userId: number;
  googleEmail: string;
  refreshTokenEnc: string;
  calendarId: string | null;
  status: GCalAccountStatus;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface GCalAccountSummary {
  id: number;
  googleEmail: string;
  status: GCalAccountStatus;
  lastSyncAt: string | null;
  lastError: string | null;
}

/** A tbSessions row the given therapist should see in Google. Dates are naive BRT wall-clock strings. */
export interface DesiredSession {
  id: number;
  name: string | null;
  clientName: string | null;
  phone: string | null;
  statusName: string | null;
  firstSession: boolean;
  paid: boolean;
  dateBegins: string;
  dateEnds: string | null;
}

export interface EventMapping {
  sessionId: number;
  googleEventId: string;
  payloadHash: string;
}

export interface IGoogleCalendarRepository {
  consumeTicket(token: string): Promise<number | null>;
  listAccounts(userId: number): Promise<GCalAccountSummary[]>;
  listSyncableAccounts(): Promise<GCalAccount[]>;
  getAccount(id: number): Promise<GCalAccount | null>;
  upsertAccount(userId: number, googleEmail: string, refreshTokenEnc: string | null): Promise<number>;
  setCalendarId(accountId: number, calendarId: string): Promise<void>;
  markSyncResult(accountId: number, status: GCalAccountStatus, error: string | null): Promise<void>;
  deleteAccount(accountId: number): Promise<void>;
  getDesiredSessions(userId: number, pastDays: number): Promise<DesiredSession[]>;
  getMappings(accountId: number): Promise<Map<number, EventMapping>>;
  getStaleMappings(accountId: number, userId: number): Promise<EventMapping[]>;
  clearMappings(accountId: number): Promise<void>;
  upsertMapping(accountId: number, sessionId: number, googleEventId: string, payloadHash: string): Promise<void>;
  deleteMapping(accountId: number, sessionId: number): Promise<void>;
  purgeExpiredTickets(): Promise<void>;
}

const TICKET_RE = /^[0-9A-Fa-f]{64}$/;

/**
 * Current Brasilia wall-clock time as ISO `YYYY-MM-DDTHH:mm:ss` (the `T` form is
 * DATEFORMAT/language independent in SQL Server), independent of server/DB timezone.
 */
export function brtNow(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

export class GoogleCalendarRepository implements IGoogleCalendarRepository {
  constructor(private readonly db: Sequelize) {}

  /** Atomically marks a valid, unused, unexpired ticket as used and returns its (non-blocked) user id. */
  async consumeTicket(token: string): Promise<number | null> {
    if (!TICKET_RE.test(token || '')) return null;
    const rows = await this.db.query<{ userId: number }>(`
      UPDATE t SET UsedAt = GETDATE()
      OUTPUT inserted.UserID AS userId
      FROM tbGoogleCalendarTickets t
      INNER JOIN tbUsers u ON u.ID = t.UserID AND ISNULL(u.Blocked, 0) = 0
      WHERE t.Token = :token AND t.UsedAt IS NULL AND t.ExpiresAt > GETDATE()
    `, { replacements: { token: token.toUpperCase() }, type: QueryTypes.SELECT });
    return rows.length ? Number(rows[0].userId) : null;
  }

  async listAccounts(userId: number): Promise<GCalAccountSummary[]> {
    return this.db.query<GCalAccountSummary>(`
      SELECT ID AS id, GoogleEmail AS googleEmail, Status AS status,
             CONVERT(varchar(19), LastSyncAt, 126) AS lastSyncAt, LastError AS lastError
      FROM tbGoogleCalendarAccounts
      WHERE UserID = :userId AND Blocked = 0
      ORDER BY GoogleEmail
    `, { replacements: { userId }, type: QueryTypes.SELECT });
  }

  async listSyncableAccounts(): Promise<GCalAccount[]> {
    return this.db.query<GCalAccount>(`${this.accountSelect()} WHERE Status IN ('active', 'error') AND Blocked = 0 ORDER BY ID`,
      { type: QueryTypes.SELECT });
  }

  async getAccount(id: number): Promise<GCalAccount | null> {
    const rows = await this.db.query<GCalAccount>(`${this.accountSelect()} WHERE ID = :id AND Blocked = 0`,
      { replacements: { id }, type: QueryTypes.SELECT });
    return rows[0] || null;
  }

  async upsertAccount(userId: number, googleEmail: string, refreshTokenEnc: string | null): Promise<number> {
    const existing = await this.db.query<{ id: number }>(
      'SELECT ID AS id FROM tbGoogleCalendarAccounts WHERE UserID = :userId AND GoogleEmail = :googleEmail',
      { replacements: { userId, googleEmail }, type: QueryTypes.SELECT });
    if (existing.length) {
      await this.db.query(`
        UPDATE tbGoogleCalendarAccounts
        SET RefreshTokenEnc = COALESCE(:refreshTokenEnc, RefreshTokenEnc), Status = 'active', LastError = NULL,
            Blocked = 0, DateModified = GETDATE(), ModifiedBy = :userId
        WHERE ID = :id
      `, { replacements: { refreshTokenEnc, userId, id: existing[0].id } });
      return Number(existing[0].id);
    }
    if (!refreshTokenEnc) throw new Error('O Google não retornou um refresh token para esta conta');
    const rows = await this.db.query<{ id: number }>(`
      INSERT INTO tbGoogleCalendarAccounts (UserID, GoogleEmail, RefreshTokenEnc, Status, CreatedBy, ModifiedBy)
      OUTPUT inserted.ID AS id
      VALUES (:userId, :googleEmail, :refreshTokenEnc, 'active', :userId, :userId)
    `, { replacements: { userId, googleEmail, refreshTokenEnc }, type: QueryTypes.SELECT });
    return Number(rows[0].id);
  }

  async setCalendarId(accountId: number, calendarId: string): Promise<void> {
    await this.db.query('UPDATE tbGoogleCalendarAccounts SET CalendarID = :calendarId, DateModified = GETDATE() WHERE ID = :accountId',
      { replacements: { calendarId, accountId } });
  }

  async markSyncResult(accountId: number, status: GCalAccountStatus, error: string | null): Promise<void> {
    await this.db.query(`
      UPDATE tbGoogleCalendarAccounts
      SET Status = :status, LastError = :error, DateModified = GETDATE(),
          LastSyncAt = CASE WHEN :status = 'active' THEN :now ELSE LastSyncAt END
      WHERE ID = :accountId
    `, { replacements: { status, error: error ? error.substring(0, 1000) : null, now: brtNow(), accountId } });
  }

  async deleteAccount(accountId: number): Promise<void> {
    // tbGoogleCalendarEvents rows go with it (ON DELETE CASCADE)
    await this.db.query('DELETE FROM tbGoogleCalendarAccounts WHERE ID = :accountId', { replacements: { accountId } });
  }

  async getDesiredSessions(userId: number, pastDays: number): Promise<DesiredSession[]> {
    // Dates as strings (style 126): tedious treats DATETIME as UTC and would shift the BRT wall-clock values.
    const rows = await this.db.query<any>(`
      SELECT s.ID AS id, s.Name AS name,
             LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS clientName,
             c.PhoneNumber AS phone, ss.Name AS statusName,
             ISNULL(s.FirstSession, 0) AS firstSession, ISNULL(s.Paid, 0) AS paid,
             CONVERT(varchar(19), s.DateBegins, 126) AS dateBegins,
             CONVERT(varchar(19), s.DateEnds, 126) AS dateEnds
      FROM tbSessions s
      LEFT JOIN tbCustomers c ON c.ID = s.ClientID
      LEFT JOIN tbSessionsStatus ss ON CAST(ss.ID AS varchar(10)) = LTRIM(RTRIM(s.Status)) AND ss.LanguageCode = 'pt-br'
      WHERE s.TherapistUserID = :userId
        AND s.DateBegins IS NOT NULL
        AND s.DateBegins >= DATEADD(day, :negDays, CAST(GETDATE() AS date))
        AND ISNULL(LTRIM(RTRIM(s.Status)), '') NOT IN ('5', '7')
        AND ISNULL(s.Blocked, 0) = 0
      ORDER BY s.DateBegins, s.ID
    `, { replacements: { userId, negDays: -Math.abs(Math.trunc(pastDays)) }, type: QueryTypes.SELECT });
    return rows.map((r) => ({
      ...r,
      id: Number(r.id),
      firstSession: r.firstSession === true || r.firstSession === 1,
      paid: r.paid === true || r.paid === 1,
    }));
  }

  async getMappings(accountId: number): Promise<Map<number, EventMapping>> {
    const rows = await this.db.query<EventMapping>(`
      SELECT SessionID AS sessionId, GoogleEventID AS googleEventId, PayloadHash AS payloadHash
      FROM tbGoogleCalendarEvents WHERE AccountID = :accountId
    `, { replacements: { accountId }, type: QueryTypes.SELECT });
    return new Map(rows.map((r) => [Number(r.sessionId), { ...r, sessionId: Number(r.sessionId) }]));
  }

  /**
   * Mapped events whose session must disappear from Google: hard-deleted, cancelled (5),
   * rescheduled (7), blocked or re-assigned to another therapist. Sessions that merely aged
   * out of the sync window are NOT returned, so past events stay in Google untouched.
   */
  async getStaleMappings(accountId: number, userId: number): Promise<EventMapping[]> {
    const rows = await this.db.query<EventMapping>(`
      SELECT m.SessionID AS sessionId, m.GoogleEventID AS googleEventId, m.PayloadHash AS payloadHash
      FROM tbGoogleCalendarEvents m
      LEFT JOIN tbSessions s ON s.ID = m.SessionID
      WHERE m.AccountID = :accountId
        AND (s.ID IS NULL
             OR ISNULL(LTRIM(RTRIM(s.Status)), '') IN ('5', '7')
             OR ISNULL(s.Blocked, 0) = 1
             OR s.TherapistUserID <> :userId
             OR s.DateBegins IS NULL)
    `, { replacements: { accountId, userId }, type: QueryTypes.SELECT });
    return rows.map((r) => ({ ...r, sessionId: Number(r.sessionId) }));
  }

  async clearMappings(accountId: number): Promise<void> {
    await this.db.query('DELETE FROM tbGoogleCalendarEvents WHERE AccountID = :accountId', { replacements: { accountId } });
  }

  async upsertMapping(accountId: number, sessionId: number, googleEventId: string, payloadHash: string): Promise<void> {
    await this.db.query(`
      UPDATE tbGoogleCalendarEvents SET GoogleEventID = :googleEventId, PayloadHash = :payloadHash, DateModified = GETDATE()
      WHERE AccountID = :accountId AND SessionID = :sessionId;
      IF @@ROWCOUNT = 0
        INSERT INTO tbGoogleCalendarEvents (AccountID, SessionID, GoogleEventID, PayloadHash)
        VALUES (:accountId, :sessionId, :googleEventId, :payloadHash);
    `, { replacements: { accountId, sessionId, googleEventId, payloadHash } });
  }

  async deleteMapping(accountId: number, sessionId: number): Promise<void> {
    await this.db.query('DELETE FROM tbGoogleCalendarEvents WHERE AccountID = :accountId AND SessionID = :sessionId',
      { replacements: { accountId, sessionId } });
  }

  async purgeExpiredTickets(): Promise<void> {
    await this.db.query('DELETE FROM tbGoogleCalendarTickets WHERE ExpiresAt < DATEADD(day, -1, GETDATE())');
  }

  private accountSelect(): string {
    return `SELECT ID AS id, UserID AS userId, GoogleEmail AS googleEmail, RefreshTokenEnc AS refreshTokenEnc,
                   CalendarID AS calendarId, Status AS status,
                   CONVERT(varchar(19), LastSyncAt, 126) AS lastSyncAt, LastError AS lastError
            FROM tbGoogleCalendarAccounts`;
  }
}
