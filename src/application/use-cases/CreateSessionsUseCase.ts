/**
 * CreateSessionsUseCase — Creates treatment + sessions in tbTreatments/tbSessions
 * when a boleto/PIX payment is confirmed.
 *
 * Mirrors legacy PedidoProcessaAgendamento():
 *  1. Create a treatment record in tbTreatments
 *  2. Create the first consultation (1ª Consulta) in tbSessions
 *  3. Create recurring session slots in tbSessions
 *
 * Schedule data comes from the order (FirstAppointmentDay/Hour, SessionDay/Hour).
 * Session dates are calculated the same way as ScheduleController.
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
function isBusinessDay(d: Date): boolean {
  return d.getDay() >= 1 && d.getDay() <= 5;
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

  async execute(orderId: number, overrides?: { firstAppointmentDate?: string; sessionStartDate?: string }): Promise<number | null> {
    const { QueryTypes } = require('sequelize');

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

    // Check if sessions already exist for this order
    const existing = await this.sequelize.query(
      `SELECT COUNT(*) as cnt FROM tbSessions WHERE OrderNumber = :orderId`,
      { replacements: { orderId }, type: QueryTypes.SELECT },
    ) as any[];
    if (existing[0]?.cnt > 0) {
      logger.info(`Sessions already exist for order ${orderId}, skipping`);
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

    // Create first consultation (1ª Consulta)
    const apptHour = order.FirstAppointmentHour || 'das 09:00 às 10:00';
    const apptBt = extractBegin(apptHour);
    const apptEt = extractEnd(apptHour);
    const [apptHH, apptMM] = apptBt.split(':').map(Number);

    // Use the actual date from the payment request if available, otherwise find next weekday
    let apptDate: Date;
    if (overrides?.firstAppointmentDate && overrides.firstAppointmentDate.match(/^\d{4}-\d{2}-\d{2}/)) {
      // Parse the actual date (e.g. "2026-05-20")
      const [y, m, d] = overrides.firstAppointmentDate.split('-').map(Number);
      apptDate = new Date(y, m - 1, d);
    } else {
      const apptDow = Number(order.FirstAppointmentDay) || 1;
      apptDate = nextWeekday(addDays(new Date(), 1), apptDow);
    }

    const apptBegins = new Date(apptDate);
    apptBegins.setHours(apptHH, apptMM, 0, 0);
    const apptEnds = new Date(apptDate);
    const [apptEHH, apptEMM] = apptEt.split(':').map(Number);
    apptEnds.setHours(apptEHH, apptEMM, 0, 0);

    await this.sequelize.query(
      `INSERT INTO tbSessions (Name, OrderNumber, ClientID, Treatment, DateBegins, DateEnds, Value, ValueValue, FirstSession, Status, Paid, PaymentType, ConfirmationEmailSent, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
       VALUES ('1a Consulta', :orderId, :clientId, :treatmentId, :dateBegins, :dateEnds, :value, :valueValue, 1, '23', 1, 1, 0, 0, GETDATE(), GETDATE(), 1, 1)`,
      {
        replacements: {
          orderId, clientId: order.CustomerID, treatmentId,
          dateBegins: formatDateLocal(apptBegins), dateEnds: formatDateLocal(apptEnds),
          value: sessionValue, valueValue: sessionValue * 0.965,
        },
      },
    );
    logger.info(`Created 1ª Consulta for order ${orderId}: ${formatDateLocal(apptBegins)}`);

    // Create recurring sessions
    const sessionHour = order.SessionHour || 'das 09:00 às 10:00';
    const sBt = extractBegin(sessionHour);
    const sEt = extractEnd(sessionHour);
    const [sHH, sMM] = sBt.split(':').map(Number);
    const [sEHH, sEMM] = sEt.split(':').map(Number);

    // Use the actual session start date if provided, otherwise 30 days from now on the selected weekday
    let current: Date;
    if (overrides?.sessionStartDate && overrides.sessionStartDate.match(/^\d{4}-\d{2}-\d{2}/)) {
      const [y, m, d] = overrides.sessionStartDate.split('-').map(Number);
      current = new Date(y, m - 1, d);
    } else {
      const sessionDow = Number(order.SessionDay) || 2;
      const earliest = addDays(new Date(), 30);
      current = nextWeekday(earliest, sessionDow);
    }

    for (let i = 0; i < sessionCount; i++) {
      const begins = new Date(current);
      begins.setHours(sHH, sMM, 0, 0);
      const ends = new Date(current);
      ends.setHours(sEHH, sEMM, 0, 0);

      await this.sequelize.query(
        `INSERT INTO tbSessions (Name, Notes, OrderNumber, ClientID, Treatment, DateBegins, DateEnds, Value, ValueValue, FirstSession, Status, Paid, PaymentType, ConfirmationEmailSent, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
         VALUES ('Sessão', :notes, :orderId, :clientId, :treatmentId, :dateBegins, :dateEnds, :value, :valueValue, 0, '1', 1, 1, 0, 0, GETDATE(), GETDATE(), 1, 1)`,
        {
          replacements: {
            notes: `${i + 1}ª Sessão`,
            orderId, clientId: order.CustomerID, treatmentId,
            dateBegins: formatDateLocal(begins), dateEnds: formatDateLocal(ends),
            value: sessionValue, valueValue: sessionValue * 0.965,
          },
        },
      );

      current = addDays(current, 7); // weekly
    }

    logger.info(`Created ${sessionCount} sessions for order ${orderId} (treatment ${treatmentId})`);
    return treatmentId;
  }

  private extractSessionCount(productName: string | null): number {
    if (!productName) return 10;
    const match = productName.match(/(\d+)\s*Sess/i);
    return match ? parseInt(match[1], 10) : 10;
  }
}
