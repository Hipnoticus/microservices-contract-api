/**
 * CreateSessionsUseCase — Mirrors legacy Treatments.Save() + Treatments.ConfirmSessions()
 *
 * Legacy workflow (PacotesContratar.aspx.cs → Treatments.cs):
 *  1. Create treatment in tbTreatments
 *  2. Insert first follow-up + sessions into tbSchedule (reservation)
 *  3. If payment already confirmed (credit card): OUTPUT INTO tbSessions simultaneously
 *  4. On later payment confirmation (boleto/PIX): copy tbSchedule → tbSessions, delete from tbSchedule
 *
 * This matches the /cliente application exactly.
 */
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('CreateSessionsUseCase');

function nextWeekday(from: Date, dow: number): Date {
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  return d;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}
function extractBegin(t: string): string {
  return t.replace('das ', '').split(' às ')[0] || t;
}
function extractEnd(t: string): string {
  const p = t.split(' às '); return p.length > 1 ? p[1] : t;
}
/** Format a Date as 'YYYY-MM-DD HH:MM:SS' without timezone conversion (keeps local/BRT time). */
function formatDateLocal(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class CreateSessionsUseCase {
  constructor(private readonly sequelize: any) {}

  /**
   * Reserve schedule slots (insert into tbSchedule).
   * Called at ORDER CREATION time — before payment.
   * If confirmNow=true (credit card), also inserts into tbSessions simultaneously.
   */
  async execute(orderId: number, overrides?: { firstAppointmentDate?: string; sessionStartDate?: string; confirmNow?: boolean }): Promise<number | null> {
    const { QueryTypes } = require('sequelize');
    const confirmNow = overrides?.confirmNow || false;

    // Load order data
    const orders = await this.sequelize.query(
      `SELECT o.ID, o.CustomerID, o.Total, o.MainGoal,
              o.FirstAppointmentDay, o.FirstAppointmentHour,
              o.SessionDay, o.SessionHour,
              p.Name as ProductName
       FROM tbOrders o
       LEFT JOIN tbOrdersProducts op ON op.OrderID = o.ID
       LEFT JOIN tbProducts p ON op.ProductID = p.ID
       WHERE o.ID = :orderId`,
      { replacements: { orderId }, type: QueryTypes.SELECT },
    ) as any[];

    if (!orders.length) {
      logger.warn(`Order ${orderId} not found for session creation`);
      return null;
    }
    const order = orders[0];

    // Check if schedule already exists for this order (prevent duplicates)
    const existingSchedule = await this.sequelize.query(
      `SELECT COUNT(*) as cnt FROM tbSchedule WHERE OrderNumber = :orderId`,
      { replacements: { orderId }, type: QueryTypes.SELECT },
    ) as any[];
    const existingSessions = await this.sequelize.query(
      `SELECT COUNT(*) as cnt FROM tbSessions WHERE OrderNumber = :orderId`,
      { replacements: { orderId }, type: QueryTypes.SELECT },
    ) as any[];

    if (existingSchedule[0]?.cnt > 0 || existingSessions[0]?.cnt > 0) {
      logger.info(`Schedule/sessions already exist for order ${orderId}, skipping`);
      return null;
    }

    // Determine session count from product name (e.g., "10 Sessões - 4 Meses")
    const sessionCount = this.extractSessionCount(order.ProductName) || 10;
    const sessionValue = Number(order.Total) / sessionCount;

    // Resolve MainGoal to issue ID
    let mainGoalId = 0;
    if (order.MainGoal) {
      const issues = await this.sequelize.query(
        `SELECT ID FROM tbIssues WHERE Name = :name`,
        { replacements: { name: order.MainGoal }, type: QueryTypes.SELECT },
      ) as any[];
      mainGoalId = issues[0]?.ID || 0;
    }

    // Create treatment
    const treatmentResult = await this.sequelize.query(
      `INSERT INTO tbTreatments (MainGoal, Customer, OrderNumber, SessionsNumber, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
       OUTPUT INSERTED.ID
       VALUES (:mainGoal, :customerId, :orderId, :sessionCount, 0, GETDATE(), GETDATE(), 1, 1)`,
      { replacements: { mainGoal: mainGoalId, customerId: order.CustomerID, orderId, sessionCount }, type: QueryTypes.SELECT },
    ) as any[];
    const treatmentId = treatmentResult[0]?.ID;
    logger.info(`Created treatment ${treatmentId} for order ${orderId}`);

    // Determine status: Confirmada (1) if paying now, Pagamento Pendente (9) if not
    const statusId = confirmNow ? 1 : 9;

    // Build first follow-up appointment
    const apptHour = order.FirstAppointmentHour || 'das 09:00 às 10:00';
    const apptBt = extractBegin(apptHour);
    const apptEt = extractEnd(apptHour);
    const [apptHH, apptMM] = apptBt.split(':').map(Number);
    const [apptEHH, apptEMM] = apptEt.split(':').map(Number);

    let apptDate: Date;
    if (overrides?.firstAppointmentDate && overrides.firstAppointmentDate.match(/^\d{4}-\d{2}-\d{2}/)) {
      const [y, m, d] = overrides.firstAppointmentDate.split('-').map(Number);
      apptDate = new Date(y, m - 1, d);
    } else {
      const apptDow = Number(order.FirstAppointmentDay) || 1;
      apptDate = nextWeekday(addDays(new Date(), 1), apptDow);
    }

    const apptBegins = new Date(apptDate); apptBegins.setHours(apptHH, apptMM, 0, 0);
    const apptEnds = new Date(apptDate); apptEnds.setHours(apptEHH, apptEMM, 0, 0);

    // Build session dates
    const sessionHour = order.SessionHour || 'das 09:00 às 10:00';
    const sBt = extractBegin(sessionHour);
    const sEt = extractEnd(sessionHour);
    const [sHH, sMM] = sBt.split(':').map(Number);
    const [sEHH, sEMM] = sEt.split(':').map(Number);

    let sessionStart: Date;
    if (overrides?.sessionStartDate && overrides.sessionStartDate.match(/^\d{4}-\d{2}-\d{2}/)) {
      const [y, m, d] = overrides.sessionStartDate.split('-').map(Number);
      sessionStart = new Date(y, m - 1, d);
    } else {
      const sessionDow = Number(order.SessionDay) || 2;
      const earliest = addDays(new Date(), 30);
      sessionStart = nextWeekday(earliest, sessionDow);
    }

    // Build INSERT SQL for tbSchedule (matching legacy Treatments.Save())
    // If confirmNow, use OUTPUT INTO tbSessions to insert into both tables simultaneously
    const outputClause = confirmNow
      ? `OUTPUT inserted.Name, inserted.Notes, inserted.OrderNumber, inserted.ClientID, inserted.Treatment,
              inserted.DateBegins, inserted.DateEnds, inserted.Value, inserted.ValueValue, inserted.FirstSession,
              inserted.Status, inserted.Paid, inserted.PaymentType, inserted.ConfirmationEmailSent,
              inserted.SessionContent, inserted.Blocked, inserted.DateCreated, inserted.DateModified,
              inserted.CreatedBy, inserted.ModifiedBy
         INTO tbSessions`
      : '';

    // First follow-up row
    const rows: string[] = [];
    rows.push(`('1a Consulta', NULL, ${orderId}, ${order.CustomerID}, ${treatmentId}, '${formatDateLocal(apptBegins)}', '${formatDateLocal(apptEnds)}', ${sessionValue.toFixed(4)}, ${(sessionValue * 0.965).toFixed(4)}, 1, ${statusId}, ${confirmNow ? 1 : 0}, 1, 0, NULL, 0, GETDATE(), GETDATE(), 1, 1)`);

    // Session rows
    let current = new Date(sessionStart);
    for (let i = 0; i < sessionCount; i++) {
      const begins = new Date(current); begins.setHours(sHH, sMM, 0, 0);
      const ends = new Date(current); ends.setHours(sEHH, sEMM, 0, 0);
      rows.push(`('Sessão', '${i + 1}ª Sessão', ${orderId}, ${order.CustomerID}, ${treatmentId}, '${formatDateLocal(begins)}', '${formatDateLocal(ends)}', ${sessionValue.toFixed(4)}, ${(sessionValue * 0.965).toFixed(4)}, 0, ${statusId}, ${confirmNow ? 1 : 0}, 1, 0, NULL, 0, GETDATE(), GETDATE(), 1, 1)`);
      current = addDays(current, 7);
    }

    const insertSQL = `INSERT INTO tbSchedule (Name, Notes, OrderNumber, ClientID, Treatment, DateBegins, DateEnds, Value, ValueValue, FirstSession, Status, Paid, PaymentType, ConfirmationEmailSent, SessionContent, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
      ${outputClause}
      VALUES ${rows.join(',\n      ')}`;

    await this.sequelize.query(insertSQL);

    logger.info(`Inserted ${rows.length} rows into tbSchedule for order ${orderId} (treatment ${treatmentId})${confirmNow ? ' + copied to tbSessions' : ''}`);

    return treatmentId;
  }

  /**
   * Confirm sessions — copy from tbSchedule to tbSessions, then delete from tbSchedule.
   * Called when boleto/PIX payment is confirmed (mirrors legacy Treatments.ConfirmSessions()).
   */
  async confirmSessions(orderId: number): Promise<boolean> {
    const { QueryTypes } = require('sequelize');

    // Find treatment for this order
    const treatments = await this.sequelize.query(
      `SELECT ID FROM tbTreatments WHERE OrderNumber = :orderId`,
      { replacements: { orderId }, type: QueryTypes.SELECT },
    ) as any[];

    if (!treatments.length) {
      logger.warn(`No treatment found for order ${orderId} — cannot confirm sessions`);
      return false;
    }
    const treatmentId = treatments[0].ID;

    // Check if there are rows in tbSchedule to confirm
    const scheduleCount = await this.sequelize.query(
      `SELECT COUNT(*) as cnt FROM tbSchedule WHERE Treatment = :treatmentId`,
      { replacements: { treatmentId }, type: QueryTypes.SELECT },
    ) as any[];

    if (scheduleCount[0]?.cnt === 0) {
      logger.info(`No schedule rows for treatment ${treatmentId} — may already be confirmed`);
      return false;
    }

    // Copy from tbSchedule to tbSessions with status "Confirmada" (1)
    // Mirrors legacy: INSERT INTO tbSessions SELECT ... FROM tbSchedule WHERE Treatment = X
    await this.sequelize.query(
      `INSERT INTO tbSessions (Name, Notes, OrderNumber, ClientID, Treatment, DateBegins, DateEnds, Value, ValueValue, FirstSession, Status, Paid, PaymentType, ConfirmationEmailSent, SessionContent, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
       SELECT Name, Notes, OrderNumber, ClientID, Treatment, DateBegins, DateEnds, Value, ValueValue, FirstSession,
              (SELECT TOP 1 ID FROM tbSessionsStatus WHERE Name = 'Confirmada'), 1, PaymentType,
              ConfirmationEmailSent, SessionContent, Blocked, DateCreated, GETDATE(), CreatedBy, ModifiedBy
       FROM tbSchedule
       WHERE Treatment = :treatmentId`,
      { replacements: { treatmentId } },
    );

    // Delete from tbSchedule
    await this.sequelize.query(
      `DELETE FROM tbSchedule WHERE Treatment = :treatmentId`,
      { replacements: { treatmentId } },
    );

    logger.info(`Confirmed sessions for treatment ${treatmentId} (order ${orderId}): copied tbSchedule → tbSessions`);
    return true;
  }

  private extractSessionCount(productName: string | null): number {
    if (!productName) return 10;
    const match = productName.match(/(\d+)\s*Sess/i);
    return match ? parseInt(match[1], 10) : 10;
  }
}
