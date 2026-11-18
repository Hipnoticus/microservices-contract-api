/**
 * Agenda availability rules shared by the public schedule endpoints (ScheduleController, what Moses offers) and the
 * order/payment checks (what the API accepts). Source: tbConfig 'schedule.appointments.*' (1ª consulta) and
 * 'schedule.sessions.*' (weekly sessions): weekdays.slotN (+ .blocked) and times.slotN.begin/.end (+ .blocked),
 * the same keys ControleWeb edits. Occupied slots come from tbSessions (blocking statuses) and tbSchedule (claimed).
 *
 * Rules mirrored from ScheduleController (legacy Hipnoticus.dll):
 *  - the 1ª consulta is the earliest business day (Mon-Fri) from today whose slot is free; today only while the slot
 *    has not started yet; searched up to 365 days ahead;
 *  - weekly sessions start only after the 30-day pre-treatment period, on the chosen weekday.
 */
import { QueryTypes } from 'sequelize';
import { parseIsoDate, todayBrt } from './SignupValidation';

export const DAY_NAMES: Record<number, string> = {
  0: 'domingo', 1: 'segunda-feira', 2: 'terça-feira', 3: 'quarta-feira',
  4: 'quinta-feira', 5: 'sexta-feira', 6: 'sábado',
};

/** Statuses that block a slot: 1/2 Confirmada, 3/4 Reservada, 21/22 Acompanhamento, 23/24 Consulta. */
export const BLOCKING_SESSION_STATUSES = ['1', '2', '3', '4', '21', '22', '23', '24'];

export const FIRST_APPOINTMENT_MAX_DAYS = 365;
/** Sessions start after the 30-day pre-treatment period; one day of slack for the browser/server date boundary. */
export const SESSIONS_MIN_DAYS = 29;
export const SESSIONS_MAX_DAYS = 400;

export interface WeekdaySlot { dayOfWeek: number; dayName: string; blocked: boolean }
export interface TimeSlot { begin: string; end: string; time: string; blocked: boolean; order: number }
export interface AgendaConfig { weekdays: WeekdaySlot[]; timeSlots: TimeSlot[] }

export function parseWeekdays(cfg: Record<string, string>): WeekdaySlot[] {
  const result: WeekdaySlot[] = [];
  for (let i = 1; i <= 7; i++) {
    const suffix = 'weekdays.slot' + i;
    const key = Object.keys(cfg).find(k => k.endsWith(suffix));
    if (key) {
      const day = parseInt(cfg[key], 10);
      const blocked = cfg[key + '.blocked'] === '1';
      result.push({ dayOfWeek: day, dayName: DAY_NAMES[day] || '', blocked });
    }
  }
  return result;
}

export function parseTimeSlots(cfg: Record<string, string>): TimeSlot[] {
  const result: TimeSlot[] = [];
  for (let i = 1; i <= 10; i++) {
    const bk = Object.keys(cfg).find(k => k.endsWith('times.slot' + i + '.begin'));
    const ek = Object.keys(cfg).find(k => k.endsWith('times.slot' + i + '.end'));
    const blk = Object.keys(cfg).find(k => k.endsWith('times.slot' + i + '.blocked'));
    if (bk && ek) {
      result.push({
        begin: cfg[bk], end: cfg[ek], time: `das ${cfg[bk]} às ${cfg[ek]}`,
        blocked: blk ? cfg[blk] === '1' : false, order: i,
      });
    }
  }
  return result;
}

export async function loadConfig(sequelize: any, prefix: string): Promise<Record<string, string>> {
  const rows = await sequelize.query(
    `SELECT Name, Value FROM tbConfig WHERE Name LIKE :prefix ORDER BY Name`,
    { replacements: { prefix: `${prefix}%` }, type: QueryTypes.SELECT },
  ) as any[];
  const cfg: Record<string, string> = {};
  for (const r of rows) {
    if (r?.Name) cfg[r.Name] = (r.Value || '').replace(/<\/?p>/g, '').trim();
  }
  return cfg;
}

export async function loadAgenda(sequelize: any, prefix: 'schedule.appointments' | 'schedule.sessions'): Promise<AgendaConfig> {
  const cfg = await loadConfig(sequelize, prefix);
  return { weekdays: parseWeekdays(cfg), timeSlots: parseTimeSlots(cfg) };
}

/** "H:MM" / "HH:MM" to minutes since midnight. */
export function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

/**
 * The offered (not blocked) slot a submitted time names: "das 20:00 às 21:00" (what Moses sends) or a bare begin
 * time "20:00". Null for anything that is not an offered slot.
 */
export function matchOfferedSlot(slots: TimeSlot[], raw: unknown): TimeSlot | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 40) return null;
  const times = s.match(/\d{1,2}:\d{2}/g) || [];
  if (times.length < 1 || times.length > 2) return null;
  if (!/^(das\s+)?\d{1,2}:\d{2}(\s+(às|as|a|-)\s+\d{1,2}:\d{2})?$/i.test(s)) return null;
  const begin = toMinutes(times[0]!);
  const end = times[1] ? toMinutes(times[1]) : null;
  if (begin === null || (times[1] && end === null)) return null;
  return slots.find(t => !t.blocked && toMinutes(t.begin) === begin && (end === null || toMinutes(t.end) === end)) || null;
}

export function isOfferedWeekday(days: WeekdaySlot[], raw: unknown): number | null {
  const s = String(raw ?? '').trim();
  if (!/^\d$/.test(s)) return null;
  const n = Number(s);
  return days.some(d => d.dayOfWeek === n && !d.blocked) ? n : null;
}

export interface ValidatedOrderSchedule {
  firstAppointmentDay: number;
  firstAppointmentHour: string;
  sessionDay: number;
  sessionHour: string;
}

/** Checks the weekday/time choices of POST /orders against the configured, unblocked slots. */
export function validateOrderSchedule(
  appointments: AgendaConfig,
  sessions: AgendaConfig,
  dto: { firstAppointmentDay?: unknown; firstAppointmentHour?: unknown; sessionDay?: unknown; sessionHour?: unknown },
): { ok: true; value: ValidatedOrderSchedule } | { ok: false; error: string } {
  const apptDay = isOfferedWeekday(appointments.weekdays, dto.firstAppointmentDay);
  if (apptDay === null) return { ok: false, error: 'O dia escolhido para a 1ª consulta não está disponível. Escolha um dos dias oferecidos.' };
  const apptSlot = matchOfferedSlot(appointments.timeSlots, dto.firstAppointmentHour);
  if (!apptSlot) return { ok: false, error: 'O horário escolhido para a 1ª consulta não está disponível. Escolha um dos horários oferecidos.' };
  const sessDay = isOfferedWeekday(sessions.weekdays, dto.sessionDay);
  if (sessDay === null) return { ok: false, error: 'O dia escolhido para as sessões não está disponível. Escolha um dos dias oferecidos.' };
  const sessSlot = matchOfferedSlot(sessions.timeSlots, dto.sessionHour);
  if (!sessSlot) return { ok: false, error: 'O horário escolhido para as sessões não está disponível. Escolha um dos horários oferecidos.' };
  return { ok: true, value: { firstAppointmentDay: apptDay, firstAppointmentHour: apptSlot.time, sessionDay: sessDay, sessionHour: sessSlot.time } };
}

/** Brasília wall clock: date yyyy-mm-dd and minutes since midnight. */
export function nowBrt(now = new Date()): { day: string; minutes: number } {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = f.format(now).split(':').map(Number);
  return { day: todayBrt(now), minutes: (h % 24) * 60 + m };
}

function dayNumber(p: { y: number; m: number; d: number }): number {
  return Date.UTC(p.y, p.m - 1, p.d) / 86400000;
}
function weekday(p: { y: number; m: number; d: number }): number {
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}
const iso = (p: { y: number; m: number; d: number }) =>
  `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
const beginOf = (time: string) => (time.match(/\d{1,2}:\d{2}/) || [''])[0];

/**
 * Checks the concrete dates sent with POST /payments/process against the order's (already validated) weekday and
 * time and the rules above. Empty dates are allowed: CreateSessionsUseCase then computes them from the order.
 * Returns the slot start times ('yyyy-mm-dd HH:MM:00') to check for occupancy, or an error.
 */
export function validatePaymentDates(
  order: { firstAppointmentHour: string; sessionDay: string; sessionHour: string },
  firstDateRaw: unknown,
  sessionDateRaw: unknown,
  now = nowBrt(),
): { ok: true; checks: string[] } | { ok: false; error: string } {
  const today = parseIsoDate(now.day)!;
  const checks: string[] = [];
  const pad = (hhmm: string) => { const t = toMinutes(hhmm)!; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00`; };
  let first: { y: number; m: number; d: number } | null = null;

  if (firstDateRaw) {
    first = parseIsoDate(firstDateRaw);
    if (!first) return { ok: false, error: 'Data da 1ª consulta inválida.' };
    const diff = dayNumber(first) - dayNumber(today);
    const wd = weekday(first);
    if (wd === 0 || wd === 6) return { ok: false, error: 'A 1ª consulta precisa ser em um dia útil (segunda a sexta-feira).' };
    if (diff < 0 || diff > FIRST_APPOINTMENT_MAX_DAYS) return { ok: false, error: 'Data da 1ª consulta fora do período disponível. Escolha o horário novamente.' };
    const begin = toMinutes(beginOf(order.firstAppointmentHour));
    if (begin === null) return { ok: false, error: 'Horário da 1ª consulta do pedido inválido.' };
    if (diff === 0 && now.minutes >= begin) return { ok: false, error: 'O horário da 1ª consulta de hoje já passou. Escolha o horário novamente.' };
    checks.push(`${iso(first)} ${pad(beginOf(order.firstAppointmentHour))}`);
  }

  if (sessionDateRaw) {
    const s = parseIsoDate(sessionDateRaw);
    if (!s) return { ok: false, error: 'Data da 1ª sessão inválida.' };
    if (String(weekday(s)) !== String(order.sessionDay).trim()) return { ok: false, error: 'A data da 1ª sessão não cai no dia da semana escolhido para as sessões.' };
    const diff = dayNumber(s) - dayNumber(today);
    if (diff < SESSIONS_MIN_DAYS) return { ok: false, error: 'As sessões semanais começam somente após o período de 30 dias de pré-tratamento.' };
    if (diff > SESSIONS_MAX_DAYS) return { ok: false, error: 'Data da 1ª sessão fora do período disponível.' };
    if (first && dayNumber(s) <= dayNumber(first)) return { ok: false, error: 'A 1ª sessão precisa ser depois da 1ª consulta.' };
    if (toMinutes(beginOf(order.sessionHour)) === null) return { ok: false, error: 'Horário das sessões do pedido inválido.' };
    checks.push(`${iso(s)} ${pad(beginOf(order.sessionHour))}`);
  }
  return { ok: true, checks };
}

/** True if another order already holds this start time (confirmed in tbSessions or requested in tbSchedule). */
export async function slotTaken(sequelize: any, begins: string, ownOrderId: number): Promise<boolean> {
  const rows = await sequelize.query(
    `SELECT (SELECT COUNT(*) FROM tbSessions WHERE DateBegins = :begins AND LTRIM(RTRIM(Status)) IN (:statuses)
               AND ISNULL(OrderNumber, 0) <> :orderId)
          + (SELECT COUNT(*) FROM tbSchedule WHERE DateBegins = :begins AND ClientID > 0
               AND ISNULL(OrderNumber, 0) <> :orderId) AS n`,
    { replacements: { begins, statuses: BLOCKING_SESSION_STATUSES, orderId: ownOrderId }, type: QueryTypes.SELECT },
  ) as any[];
  return Number(rows?.[0]?.n) > 0;
}
