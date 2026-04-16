import { Controller, Get, Query, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Sequelize, QueryTypes } from 'sequelize';

/*
 * ══════════════════════════════════════════════════════════════════
 *  SCHEDULING ARCHITECTURE (mirrors legacy Hipnoticus.dll)
 * ══════════════════════════════════════════════════════════════════
 *
 *  tbConfig          Template: which weekdays/times are offered
 *  tbSessions        Source of truth: confirmed sessions (first to pay wins)
 *  tbSchedule        Booking ledger: optimistic requests (can have duplicates
 *                    for the same datetime — multiple clients requesting the
 *                    same slot before payment)
 *
 *  Availability = generated from tbConfig template, minus slots that are
 *  CONFIRMED in tbSessions (status Confirmada/Consulta/Acompanhamento)
 *  or already CLAIMED in tbSchedule (ClientID > 0).
 *
 *  tbSessionsStatus reference:
 *    1  Confirmada        (functional)
 *    3  Reservada
 *    5  Cancelada
 *    7  Reagendada
 *    9  Pagamento Pendente
 *   11  Férias
 *   13  Folga
 *   15  Feriado
 *   17  Dia de Branco
 *   19  Reunião
 *   21  Acompanhamento    (functional)
 *   23  Consulta          (functional)
 * ══════════════════════════════════════════════════════════════════
 */

const DAY_NAMES: Record<number, string> = {
  0: 'domingo', 1: 'segunda-feira', 2: 'terça-feira', 3: 'quarta-feira',
  4: 'quinta-feira', 5: 'sexta-feira', 6: 'sábado',
};
const DAY_NAMES_SHORT: Record<number, string> = {
  0: 'dom', 1: '2ª feira', 2: '3ª feira', 3: '4ª feira',
  4: '5ª feira', 5: '6ª feira', 6: 'sáb',
};
const MONTHS = [
  'janeiro','fevereiro','março','abril','maio','junho',
  'julho','agosto','setembro','outubro','novembro','dezembro',
];

// Statuses that block a slot (session is active / slot is occupied)
const BLOCKING_SESSION_STATUSES = ['1','2','3','4','21','22','23','24'];
// 1=Confirmada, 2=Confirmed, 3=Reservada, 4=Reserved,
// 21=Acompanhamento, 22=Follow-Up, 23=Consulta, 24=Appointment

function fmtBR(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}
function fmtLong(d: Date): string {
  return `${DAY_NAMES_SHORT[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
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
function nextWeekday(from: Date, dow: number): Date {
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  return d;
}

@ApiTags('Schedule')
@Controller('schedule')
export class ScheduleController {
  constructor(@Inject('DATABASE') private readonly sequelize: Sequelize) {}

  // ── CONFIG ENDPOINTS (populate weekday/time dropdowns) ───────────

  @Get('appointments')
  @ApiOperation({ summary: 'Appointment weekdays + time slots from tbConfig' })
  async getAppointmentSlots() {
    const cfg = await this.loadConfig('schedule.appointments');
    return { weekdays: this.parseWeekdays(cfg), timeSlots: this.parseTimeSlots(cfg) };
  }

  @Get('appointments/by-day')
  @ApiOperation({ summary: 'Appointment time slots for a weekday' })
  @ApiQuery({ name: 'day', type: Number })
  async getSlotsByDay(@Query('day') _day: number) {
    return this.parseTimeSlots(await this.loadConfig('schedule.appointments'));
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Session weekdays + time slots from tbConfig' })
  async getSessionSlots() {
    const cfg = await this.loadConfig('schedule.sessions');
    return { weekdays: this.parseWeekdays(cfg), timeSlots: this.parseTimeSlots(cfg) };
  }

  @Get('sessions/by-day')
  @ApiOperation({ summary: 'Session time slots for a weekday' })
  @ApiQuery({ name: 'day', type: Number })
  async getSessionSlotsByDay(@Query('day') _day: number) {
    return this.parseTimeSlots(await this.loadConfig('schedule.sessions'));
  }

  // ── AVAILABILITY: 1ª CONSULTA ────────────────────────────────────
  //
  // Legacy: ReturnFollowUpSlotsByAvailability(DateTime.Now, 0, 1, 1)
  // daysFromNow=0 means starting from TODAY. If today is a business
  // day and the time slot hasn't passed yet, today is available.

  @Get('appointments/available-dates')
  @ApiOperation({ summary: 'Find next available first-consultation date' })
  @ApiQuery({ name: 'day', type: Number, description: 'Preferred weekday (0=Sun..6=Sat)' })
  @ApiQuery({ name: 'time', type: String, description: '"das HH:MM às HH:MM"' })
  async getAppointmentDates(
    @Query('day') day: number,
    @Query('time') time: string,
  ) {
    const now = new Date();
    const requestedDow = Number(day);
    const bt = extractBegin(time);
    const et = extractEnd(time);
    const [hh, mm] = bt.split(':').map(Number);

    // Start from TODAY (legacy daysFromNow=0)
    let earliest = new Date(now);
    earliest.setHours(0, 0, 0, 0);

    // If today is not a business day, advance to next business day
    if (!isBusinessDay(earliest)) {
      earliest = addDays(earliest, 1);
      while (!isBusinessDay(earliest)) earliest = addDays(earliest, 1);
    } else {
      // If the requested time has already passed today, start tomorrow
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const slotMins = hh * 60 + mm;
      if (nowMins >= slotMins) {
        earliest = addDays(earliest, 1);
        while (!isBusinessDay(earliest)) earliest = addDays(earliest, 1);
      }
    }

    // Check BOTH tables on the current database (tbSessions + tbSchedule)
    const occupied = await this.getOccupiedDateTimes(bt, et);

    let candidate = new Date(earliest);
    candidate.setHours(hh, mm, 0, 0);
    let found = false;
    for (let i = 0; i < 365; i++) {
      if (isBusinessDay(candidate) && !occupied.has(candidate.getTime())) {
        found = true;
        break;
      }
      candidate = addDays(candidate, 1);
      candidate.setHours(hh, mm, 0, 0);
    }

    // If the found date's weekday doesn't match the preference, notify
    let notFoundMessage: string | null = null;
    if (found && candidate.getDay() !== requestedDow) {
      notFoundMessage =
        `Vaga para uma ${DAY_NAMES[requestedDow]} próxima às ${bt} não encontrada. Vaga mais próxima disponível selecionada.`;
    }

    const isToday = sameDay(candidate, now);
    const isTomorrow = sameDay(candidate, addDays(now, 1));

    return {
      date: fmtBR(candidate),
      dateLong: fmtLong(candidate),
      dateISO: candidate.toISOString().split('T')[0],
      time,
      beginTime: bt,
      dayName: DAY_NAMES[candidate.getDay()],
      label: isToday ? 'HOJE' : isTomorrow ? 'AMANHÃ' : fmtLong(candidate),
      isToday,
      isTomorrow,
      exactDayFound: notFoundMessage === null,
      notFoundMessage,
    };
  }

  // ── AVAILABILITY: SESSÕES ────────────────────────────────────────
  //
  // Rule: recurring sessions only start AFTER the 30-day pre-treatment
  // period (which includes the first consultation). The user picks
  // the weekday and time for their weekly sessions.

  @Get('sessions/schedule')
  @ApiOperation({ summary: 'Generate full session schedule with real dates' })
  @ApiQuery({ name: 'day', type: Number })
  @ApiQuery({ name: 'time', type: String })
  @ApiQuery({ name: 'count', type: Number, required: false })
  async getSessionSchedule(
    @Query('day') day: number,
    @Query('time') time: string,
    @Query('count') count: number,
  ) {
    const requestedDow = Number(day);
    const numSessions = Number(count) || 10;
    const bt = extractBegin(time);
    const et = extractEnd(time);
    const [hh, mm] = bt.split(':').map(Number);
    const dayName = DAY_NAMES[requestedDow] || '';

    // Sessions start after the 30-day pre-treatment period
    const earliest = addDays(new Date(), 30);
    let current = nextWeekday(earliest, requestedDow);
    current.setHours(hh, mm, 0, 0);

    const occupied = await this.getOccupiedDateTimes(bt, et);
    const sessions: any[] = [];
    let attempts = 0;

    while (sessions.length < numSessions && attempts < 200) {
      if (!occupied.has(current.getTime())) {
        sessions.push({
          number: sessions.length + 1,
          date: fmtBR(current),
          dateISO: current.toISOString().split('T')[0],
          dayName: DAY_NAMES[current.getDay()],
        });
      }
      current = addDays(current, 7);
      current.setHours(hh, mm, 0, 0);
      attempts++;
    }

    const first = sessions.length > 0 ? sessions[0] : null;

    return {
      startDateLong: first
        ? fmtLong(new Date(first.dateISO + 'T12:00:00'))
        : '',
      dayName,
      time,
      beginTime: bt,
      totalSessions: numSessions,
      sessionsFound: sessions.length,
      isComplete: sessions.length >= numSessions,
      sessions,
      summary: `${numSessions} Sessões semanais. Mesmo dia e horário. Toda ${dayName} ${time}.`,
    };
  }

  // ── PRIVATE: DUAL-TABLE AVAILABILITY CHECK ───────────────────────

  /**
   * A datetime is OCCUPIED if:
   *
   *  1. tbSessions has a row for that datetime with a blocking status
   *     (Confirmada, Reservada, Consulta, Acompanhamento) — the slot
   *     is confirmed/taken, source of truth.
   *
   *  2. tbSchedule has a row for that datetime with ClientID > 0 —
   *     someone has already requested this slot (optimistic booking).
   *     Multiple requests can exist (duplicates), but the slot is
   *     still considered occupied for new availability queries.
   *
   * Both tables are checked. A slot blocked in EITHER is unavailable.
   */
  private async getOccupiedDateTimes(
    bt: string,
    et: string,
  ): Promise<Set<number>> {
    const set = new Set<number>();

    // 1. Confirmed sessions (tbSessions) — source of truth
    const confirmedRows = await this.sequelize.query(
      `SELECT DateBegins
       FROM tbSessions
       WHERE CONVERT(VARCHAR(5), DateBegins, 108) = :bt
         AND CONVERT(VARCHAR(5), DateEnds, 108) = :et
         AND Status IN (:statuses)
         AND DateBegins > GETDATE()`,
      {
        replacements: { bt, et, statuses: BLOCKING_SESSION_STATUSES },
        type: QueryTypes.SELECT,
      },
    ) as any[];
    for (const r of confirmedRows) {
      set.add(new Date(r.DateBegins).getTime());
    }

    // 2. Booking requests (tbSchedule) — optimistic ledger
    const scheduledRows = await this.sequelize.query(
      `SELECT DateBegins
       FROM tbSchedule
       WHERE CONVERT(VARCHAR(5), DateBegins, 108) = :bt
         AND CONVERT(VARCHAR(5), DateEnds, 108) = :et
         AND ClientID IS NOT NULL AND ClientID > 0
         AND DateBegins > GETDATE()`,
      {
        replacements: { bt, et },
        type: QueryTypes.SELECT,
      },
    ) as any[];
    for (const r of scheduledRows) {
      set.add(new Date(r.DateBegins).getTime());
    }

    return set;
  }

  // ── PRIVATE: tbConfig PARSING ────────────────────────────────────

  private async loadConfig(prefix: string): Promise<Record<string, string>> {
    const rows = await this.sequelize.query(
      `SELECT Name, Value FROM tbConfig WHERE Name LIKE :prefix ORDER BY Name`,
      { replacements: { prefix: `${prefix}%` }, type: QueryTypes.SELECT },
    ) as any[];
    const cfg: Record<string, string> = {};
    for (const r of rows) {
      if (r?.Name) cfg[r.Name] = (r.Value || '').replace(/<\/?p>/g, '').trim();
    }
    return cfg;
  }

  private parseWeekdays(cfg: Record<string, string>): any[] {
    const result: any[] = [];
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

  private parseTimeSlots(cfg: Record<string, string>): any[] {
    const result: any[] = [];
    for (let i = 1; i <= 10; i++) {
      const bSuffix = 'times.slot' + i + '.begin';
      const eSuffix = 'times.slot' + i + '.end';
      const blSuffix = 'times.slot' + i + '.blocked';
      const bk = Object.keys(cfg).find(k => k.endsWith(bSuffix));
      const ek = Object.keys(cfg).find(k => k.endsWith(eSuffix));
      const blk = Object.keys(cfg).find(k => k.endsWith(blSuffix));
      if (bk && ek) {
        const blocked = blk ? cfg[blk] === '1' : false;
        result.push({
          begin: cfg[bk],
          end: cfg[ek],
          time: `das ${cfg[bk]} às ${cfg[ek]}`,
          blocked,
          order: i,
        });
      }
    }
    return result;
  }
}
