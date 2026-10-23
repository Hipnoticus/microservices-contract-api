import { HttpException, HttpStatus } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('SessionAdminService');

/**
 * Agenda and sessions for the Moses admin area, with ControleWeb's rules (source/modules/sessions and calendar).
 *
 *  tbSessions  "Calendário (pagos)": confirmed sessions, the source of truth.
 *  tbSchedule  "Agenda (reservados)": reserved, not yet paid requests (Contratar boleto/PIX). Whoever pays first gets
 *              the slots copied into tbSessions (CreateSessionsUseCase.confirmSessions). Several requests may claim
 *              the same slot, which is why it is a separate table.
 *
 * Dates are read with CONVERT(varchar(19), x, 126) and written as 'YYYY-MM-DDTHH:MM:SS' strings: tedious treats
 * DATETIME as UTC and would shift the Brasília wall-clock values stored in these tables.
 */
export type AgendaSource = 'sessions' | 'schedule';

export interface SessionInput {
  clientId: number;
  name?: string;
  notes?: string;
  begins: string;          // 'YYYY-MM-DDTHH:MM'
  ends: string;
  value?: number | null;
  valueValue?: number | null;
  treatmentId?: number | null;
  issueId?: number | null;
  firstSession?: boolean;
  status: number;
  paid?: boolean;
  paymentType?: number | null;
  sessionContent?: string | null;
  packageSize?: number;    // create only: N weekly sessions
}

export type SlotKind = 'session' | 'appointment';
export interface ConfiguredSlot {
  kind: SlotKind; begin: string; end: string; weekdays: number[];
  /** Weekdays on which customers cannot self-book this slot (blocked weekday or blocked time). Staff always can. */
  customerBlockedWeekdays: number[];
}

/** '9:30' -> '09:30'; anything that is not H:MM / HH:MM -> null. */
export function hhmm(v: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v || '').replace(/<\/?p>/g, '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/**
 * The bookable slots, from tbConfig: the same keys the Contratar flow and the legacy client site read
 * (schedule.sessions.* for weekly sessions, schedule.appointments.* for the 1ª consulta / follow-ups):
 *   <prefix>.weekdays.slotN = weekday (0 = Sunday), <prefix>.weekdays.slotN.blocked = 1 to switch it off
 *   <prefix>.times.slotN.begin / .end = HH:MM,      <prefix>.times.slotN.blocked = 1 to switch it off
 *
 * ".blocked" only closes a weekday or time to CUSTOMER self-scheduling (Contratar in Moses, the legacy Cliente).
 * The therapist's Agenda shows every configured slot, blocked or not, as ControleWeb does; each slot says which
 * weekdays customers cannot book (customerBlockedWeekdays) so the Agenda can mark them.
 */
export function parseSlots(rows: { Name: string; Value: string }[]): ConfiguredSlot[] {
  const cfg: Record<string, string> = {};
  for (const r of rows) if (r?.Name) cfg[r.Name] = String(r.Value ?? '').replace(/<\/?p>/g, '').trim();
  const out: ConfiguredSlot[] = [];
  for (const [kind, prefix] of [['session', 'schedule.sessions'], ['appointment', 'schedule.appointments']] as const) {
    const weekdays: number[] = [];
    const blockedDays: number[] = [];
    for (let i = 1; i <= 7; i++) {
      const v = cfg[`${prefix}.weekdays.slot${i}`];
      if (v === undefined) continue;
      const d = parseInt(v, 10);
      if (!(d >= 0 && d <= 6) || weekdays.includes(d)) continue;
      weekdays.push(d);
      if (cfg[`${prefix}.weekdays.slot${i}.blocked`] === '1') blockedDays.push(d);
    }
    if (!weekdays.length) continue;
    for (let i = 1; i <= 10; i++) {
      const begin = hhmm(cfg[`${prefix}.times.slot${i}.begin`]);
      const end = hhmm(cfg[`${prefix}.times.slot${i}.end`]);
      if (!begin || !end) continue;
      const timeBlocked = cfg[`${prefix}.times.slot${i}.blocked`] === '1';
      const sorted = [...weekdays].sort();
      out.push({
        kind, begin, end, weekdays: sorted,
        customerBlockedWeekdays: timeBlocked ? sorted : [...blockedDays].sort(),
      });
    }
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

export function tableOf(source: string | undefined): { table: 'tbSessions' | 'tbSchedule'; source: AgendaSource } {
  return source === 'schedule' ? { table: 'tbSchedule', source: 'schedule' } : { table: 'tbSessions', source: 'sessions' };
}

/** Normalise a wall-clock date-time to 'YYYY-MM-DDTHH:MM:SS', rejecting anything else. */
export function wallClock(v: string, field: string): string {
  const m = DATETIME_RE.exec((v || '').trim());
  if (!m) throw new HttpException({ error: `${field}: use AAAA-MM-DDTHH:MM` }, HttpStatus.BAD_REQUEST);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`;
}

/** Adds whole days to a wall-clock string without touching time zones. */
export function addDaysWallClock(v: string, days: number): string {
  const [d, t] = v.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, da + days));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}T${t}`;
}

/** ControleWeb numbered package notes by replacing "1" with the session number; this only touches "1ª"/"1a". */
export function renumberNotes(notes: string, n: number): string {
  if (!notes || n === 1) return notes;
  return notes.replace(/(^|[^\d])1(ª|a\b|º|o\b)/g, (_m, pre, suf) => `${pre}${n}${suf}`);
}

export class SessionAdminService {
  constructor(private readonly db: Sequelize) {}

  async configuredSlots(): Promise<ConfiguredSlot[]> {
    const rows = await this.db.query<any>(
      `SELECT Name, CAST(Value AS varchar(200)) AS Value FROM tbConfig
       WHERE (Name LIKE 'schedule.sessions.%' OR Name LIKE 'schedule.appointments.%') AND ISNULL(Blocked, 0) = 0`,
      { type: QueryTypes.SELECT });
    return parseSlots(rows);
  }

  async statuses() {
    return this.db.query(`
      SELECT ID AS id, Name AS name, Color AS color, CAST(ISNULL(Functional, 0) AS bit) AS functional
      FROM tbSessionsStatus WHERE LanguageCode = 'pt-br' AND ISNULL(Blocked, 0) = 0 ORDER BY ID`,
      { type: QueryTypes.SELECT });
  }

  async paymentTypes() {
    return this.db.query(`SELECT ID AS id, Name AS name FROM tbFormasPagamento WHERE ISNULL(Blocked, 0) = 0 ORDER BY Name`,
      { type: QueryTypes.SELECT });
  }

  /** Every entry between two dates (inclusive), with the client and the status colour. */
  async calendar(from: string, to: string, source: string | undefined, therapistId?: number) {
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
      throw new HttpException({ error: 'from/to: use AAAA-MM-DD' }, HttpStatus.BAD_REQUEST);
    }
    const { table, source: src } = tableOf(source);
    const therapistFilter = table === 'tbSessions' && therapistId ? 'AND s.TherapistUserID = :therapistId' : '';
    const rows = await this.db.query<any>(`
      SELECT s.ID AS id, s.Name AS name, CAST(s.Notes AS varchar(2000)) AS notes, s.ClientID AS clientId,
             LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS clientName,
             c.PhoneNumber AS phone,
             CONVERT(varchar(19), s.DateBegins, 126) AS begins, CONVERT(varchar(19), s.DateEnds, 126) AS ends,
             LTRIM(RTRIM(s.Status)) AS status, ss.Name AS statusName, ss.Color AS color,
             CAST(ISNULL(s.FirstSession, 0) AS bit) AS firstSession, CAST(ISNULL(s.Paid, 0) AS bit) AS paid,
             ISNULL(s.ConfirmationEmailSent, 0) AS confirmationEmailSent, s.OrderNumber AS orderNumber,
             ${table === 'tbSessions' ? 'COALESCE(s.TreatmentID, s.Treatment)' : 's.Treatment'} AS treatmentId
      FROM ${table} s
      LEFT JOIN tbCustomers c ON c.ID = s.ClientID
      LEFT JOIN tbSessionsStatus ss ON CAST(ss.ID AS varchar(10)) = LTRIM(RTRIM(s.Status))
      WHERE s.DateBegins >= :from AND s.DateBegins < DATEADD(day, 1, CAST(:to AS date)) ${therapistFilter}
      ORDER BY s.DateBegins, s.ID`,
      { replacements: { from, to, therapistId }, type: QueryTypes.SELECT });
    return rows.map((r) => ({ ...r, source: src, firstSession: !!r.firstSession, paid: !!r.paid }));
  }

  async get(id: number, source: string | undefined) {
    const { table, source: src } = tableOf(source);
    const rows = await this.db.query<any>(`
      SELECT s.ID AS id, s.Name AS name, CAST(s.Notes AS varchar(max)) AS notes, s.ClientID AS clientId,
             LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS clientName,
             c.CallName AS clientCallName, c.Email AS clientEmail, c.PhoneNumber AS phone,
             CONVERT(varchar(19), s.DateBegins, 126) AS begins, CONVERT(varchar(19), s.DateEnds, 126) AS ends,
             s.Value AS value, s.ValueValue AS valueValue,
             ${table === 'tbSessions' ? 'COALESCE(s.TreatmentID, s.Treatment)' : 's.Treatment'} AS treatmentId,
             ${table === 'tbSessions' ? 's.IssueID' : 'NULL'} AS issueId,
             CAST(ISNULL(s.FirstSession, 0) AS bit) AS firstSession, LTRIM(RTRIM(s.Status)) AS status,
             CAST(ISNULL(s.Paid, 0) AS bit) AS paid, s.PaymentType AS paymentType,
             ISNULL(s.ConfirmationEmailSent, 0) AS confirmationEmailSent, s.OrderNumber AS orderNumber,
             s.SessionContent AS sessionContent,
             ${table === 'tbSessions' ? 's.TherapistUserID' : 'NULL'} AS therapistUserId
      FROM ${table} s LEFT JOIN tbCustomers c ON c.ID = s.ClientID
      WHERE s.ID = :id`, { replacements: { id }, type: QueryTypes.SELECT });
    if (!rows.length) throw new HttpException({ error: 'Sessão não encontrada.' }, HttpStatus.NOT_FOUND);
    const s = rows[0];

    // ControleWeb's edit page shows the previous session's content and date
    const prev = await this.db.query<any>(`
      SELECT TOP 1 ID AS id, CONVERT(varchar(19), DateBegins, 126) AS begins, SessionContent AS sessionContent
      FROM tbSessions WHERE ClientID = :clientId AND DateBegins < CAST(:begins AS datetime) AND ID <> :id
      ORDER BY DateBegins DESC`,
      { replacements: { clientId: s.clientId, begins: s.begins, id: src === 'sessions' ? id : -1 }, type: QueryTypes.SELECT });

    return {
      ...s, source: src, firstSession: !!s.firstSession, paid: !!s.paid,
      paymentType: s.paymentType === null || s.paymentType === '' ? null : Number(s.paymentType),
      status: s.status ? Number(s.status) : null,
      previous: prev[0] || null,
    };
  }

  private validate(input: SessionInput) {
    if (!Number.isInteger(Number(input.clientId)) || Number(input.clientId) <= 0) {
      throw new HttpException({ error: 'Selecione o cliente.' }, HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(Number(input.status))) {
      throw new HttpException({ error: 'Selecione o status.' }, HttpStatus.BAD_REQUEST);
    }
    const begins = wallClock(input.begins, 'Início');
    // ControleWeb copied the start into the end when the end was left empty
    const ends = input.ends ? wallClock(input.ends, 'Fim') : begins;
    if (ends < begins) throw new HttpException({ error: 'O fim é anterior ao início.' }, HttpStatus.BAD_REQUEST);
    return { begins, ends };
  }

  /** Sessions already at that start time (any status, like ControleWeb's slot check), excluding one id. */
  async conflicts(begins: string, excludeId?: number) {
    return this.db.query<any>(`
      SELECT 'sessions' AS source, s.ID AS id, LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS clientName,
             ss.Name AS statusName
      FROM tbSessions s LEFT JOIN tbCustomers c ON c.ID = s.ClientID
      LEFT JOIN tbSessionsStatus ss ON CAST(ss.ID AS varchar(10)) = LTRIM(RTRIM(s.Status))
      WHERE s.DateBegins = CAST(:begins AS datetime) AND s.ID <> :excludeId
        AND ISNULL(LTRIM(RTRIM(s.Status)), '') NOT IN ('5', '6', '7', '8')
      UNION ALL
      SELECT 'schedule', s.ID, LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))), ss.Name
      FROM tbSchedule s LEFT JOIN tbCustomers c ON c.ID = s.ClientID
      LEFT JOIN tbSessionsStatus ss ON CAST(ss.ID AS varchar(10)) = LTRIM(RTRIM(s.Status))
      WHERE s.DateBegins = CAST(:begins AS datetime) AND ISNULL(s.ClientID, 0) > 0`,
      { replacements: { begins, excludeId: excludeId || -1 }, type: QueryTypes.SELECT });
  }

  /**
   * Create one session, or a package of N weekly sessions on the same weekday and time (ControleWeb sessions_add.asp):
   * only the first keeps FirstSession, notes are renumbered, and everything else is shared.
   */
  async create(input: SessionInput, source: string | undefined, staffId: number) {
    const { table, source: src } = tableOf(source);
    const { begins, ends } = this.validate(input);
    const count = Math.min(Math.max(parseInt(String(input.packageSize || 1), 10) || 1, 1), 52);
    const created: number[] = [];
    const conflicts: any[] = [];
    // Checked before the transaction: a read outside it would wait on the rows the transaction is inserting.
    for (let i = 0; i < count; i++) conflicts.push(...(await this.conflicts(addDaysWallClock(begins, i * 7))));

    const t = await this.db.transaction();
    try {
      // OrderNumber = the client's running session number (COUNT + 1), as ControleWeb sets it
      const [{ n }] = await this.db.query<any>(`SELECT COUNT(*) AS n FROM ${table} WHERE ClientID = :clientId`,
        { replacements: { clientId: input.clientId }, type: QueryTypes.SELECT, transaction: t });

      for (let i = 0; i < count; i++) {
        const b = addDaysWallClock(begins, i * 7);
        const e = addDaysWallClock(ends, i * 7);
        const rep: any = {
          name: (input.name || 'Sessão').slice(0, 60),
          notes: renumberNotes(input.notes || '', i + 1),
          orderNumber: Number(n) + i + 1,
          clientId: input.clientId,
          treatment: input.treatmentId || null,
          begins: b, ends: e,
          value: input.value ?? null, valueValue: input.valueValue ?? null,
          firstSession: i === 0 && input.firstSession ? 1 : 0,
          status: String(input.status),
          paid: input.paid ? 1 : 0,
          paymentType: input.paymentType ?? null,
          content: input.sessionContent ?? null,
          staffId,
          issueId: input.issueId || null,
        };
        const sql = table === 'tbSessions'
          ? `INSERT INTO tbSessions (Name, Notes, OrderNumber, ClientID, Treatment, TreatmentID, IssueID, DateBegins, DateEnds, Value, ValueValue,
               FirstSession, Status, Paid, PaymentType, ConfirmationEmailSent, SessionContent, Blocked, DateCreated, DateModified,
               CreatedBy, ModifiedBy, TherapistUserID)
             OUTPUT inserted.ID AS id
             VALUES (:name, :notes, :orderNumber, :clientId, :treatment, :treatment, :issueId, CAST(:begins AS datetime), CAST(:ends AS datetime),
               :value, :valueValue, :firstSession, :status, :paid, :paymentType, 0, :content, 0, GETDATE(), GETDATE(), :staffId, :staffId, :staffId)`
          : `INSERT INTO tbSchedule (Name, Notes, OrderNumber, ClientID, Treatment, DateBegins, DateEnds, Value, ValueValue,
               FirstSession, Status, Paid, PaymentType, ConfirmationEmailSent, SessionContent, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
             OUTPUT inserted.ID AS id
             VALUES (:name, :notes, :orderNumber, :clientId, :treatment, CAST(:begins AS datetime), CAST(:ends AS datetime),
               :value, :valueValue, :firstSession, :status, :paid, CAST(:paymentType AS varchar(255)), 0, :content, 0, GETDATE(), GETDATE(), :staffId, :staffId)`;
        const rows = await this.db.query<any>(sql, { replacements: rep, type: QueryTypes.SELECT, transaction: t });
        created.push(Number(rows[0].id));
      }
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
    logger.info(`Staff ${staffId} created ${created.length} entr${created.length === 1 ? 'y' : 'ies'} in ${table} for client ${input.clientId}`);
    return { source: src, ids: created, conflicts };
  }

  async update(id: number, input: SessionInput, source: string | undefined, staffId: number) {
    const { table } = tableOf(source);
    const { begins, ends } = this.validate(input);
    await this.get(id, source); // 404 when missing
    const rep: any = {
      id, name: (input.name || 'Sessão').slice(0, 60), notes: input.notes || '', clientId: input.clientId,
      treatment: input.treatmentId || null, issueId: input.issueId || null, begins, ends,
      value: input.value ?? null, valueValue: input.valueValue ?? null, firstSession: input.firstSession ? 1 : 0,
      status: String(input.status), paid: input.paid ? 1 : 0, paymentType: input.paymentType ?? null, staffId,
    };
    const extra = table === 'tbSessions' ? ', TreatmentID = :treatment, IssueID = :issueId, PaymentType = :paymentType'
      : ', PaymentType = CAST(:paymentType AS varchar(255))';
    // TherapistUserID is left alone on edit, as in ControleWeb
    await this.db.query(`
      UPDATE ${table} SET Name = :name, Notes = :notes, ClientID = :clientId, Treatment = :treatment,
        DateBegins = CAST(:begins AS datetime), DateEnds = CAST(:ends AS datetime), Value = :value, ValueValue = :valueValue,
        FirstSession = :firstSession, Status = :status, Paid = :paid${extra}, DateModified = GETDATE(), ModifiedBy = :staffId
      WHERE ID = :id`, { replacements: rep });
    return { id, conflicts: await this.conflicts(begins, table === 'tbSessions' ? id : undefined) };
  }

  /** Autosave of the session content (ControleWeb EditSessionZero). */
  async saveContent(id: number, content: string, source: string | undefined, staffId: number) {
    const { table } = tableOf(source);
    const found = await this.db.query<any>(`SELECT ID FROM ${table} WHERE ID = :id`, { replacements: { id }, type: QueryTypes.SELECT });
    if (!found.length) throw new HttpException({ error: 'Sessão não encontrada.' }, HttpStatus.NOT_FOUND);
    await this.db.query(`UPDATE ${table} SET SessionContent = :content, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id`,
      { replacements: { id, content: content ?? '', staffId } });
    return { saved: true, at: new Date().toISOString() };
  }

  async remove(id: number, source: string | undefined, staffId: number) {
    const { table } = tableOf(source);
    await this.get(id, source);
    await this.db.query(`DELETE FROM ${table} WHERE ID = :id`, { replacements: { id } });
    logger.info(`Staff ${staffId} deleted ${table} ${id}`);
    return { removed: true };
  }

  /**
   * Confirm a reservation by hand (payment received outside the gateways): copy the tbSchedule row, or every row of
   * its treatment, into tbSessions as Confirmada + paid, then remove it from tbSchedule.
   */
  async confirmReservation(id: number, wholeTreatment: boolean, staffId: number) {
    const rows = await this.db.query<any>('SELECT ID, Treatment FROM tbSchedule WHERE ID = :id', { replacements: { id }, type: QueryTypes.SELECT });
    if (!rows.length) throw new HttpException({ error: 'Reserva não encontrada.' }, HttpStatus.NOT_FOUND);
    const where = wholeTreatment && rows[0].Treatment ? 'Treatment = :treatment' : 'ID = :id';
    const rep = { id, treatment: rows[0].Treatment, staffId };
    const t = await this.db.transaction();
    try {
      const inserted = await this.db.query<any>(`
        INSERT INTO tbSessions (Name, Notes, OrderNumber, ClientID, Treatment, TreatmentID, DateBegins, DateEnds, Value, ValueValue, FirstSession,
          Status, Paid, PaymentType, ConfirmationEmailSent, SessionContent, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy, TherapistUserID)
        OUTPUT inserted.ID AS id
        SELECT Name, Notes, OrderNumber, ClientID, Treatment, Treatment, DateBegins, DateEnds, Value, ValueValue, FirstSession,
          '1', 1, TRY_CAST(PaymentType AS int), ConfirmationEmailSent, SessionContent, Blocked, DateCreated, GETDATE(), CreatedBy, :staffId, :staffId
        FROM tbSchedule WHERE ${where}`, { replacements: rep, type: QueryTypes.SELECT, transaction: t });
      await this.db.query(`DELETE FROM tbSchedule WHERE ${where}`, { replacements: rep, transaction: t });
      await t.commit();
      logger.info(`Staff ${staffId} confirmed ${inserted.length} reserved entr${inserted.length === 1 ? 'y' : 'ies'} (tbSchedule ${id})`);
      return { ids: inserted.map((r) => Number(r.id)) };
    } catch (e) {
      await t.rollback();
      throw e;
    }
  }

  async customerTreatments(customerId: number) {
    return this.db.query(`
      SELECT t.ID AS id, t.MainGoal AS mainGoal, i.Name AS goalName, t.SessionsNumber AS sessionsNumber,
             COALESCE(t.PhaseDefined, t.PhaseDetected, 1) AS phaseId, tp.Name AS phaseName,
             CONVERT(varchar(19), t.DateCreated, 126) AS dateCreated
      FROM tbTreatments t
      LEFT JOIN tbIssues i ON i.ID = t.MainGoal
      LEFT JOIN tbTreatmentsPhases tp ON tp.ID = COALESCE(t.PhaseDefined, t.PhaseDetected, 1)
      WHERE t.Customer = :customerId AND ISNULL(t.Blocked, 0) = 0
      ORDER BY t.ID DESC`, { replacements: { customerId }, type: QueryTypes.SELECT });
  }
}
