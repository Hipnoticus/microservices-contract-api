import { Controller, Get, Query, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Sequelize, QueryTypes } from 'sequelize';

const DAY_NAMES: Record<number, string> = {
  0: 'domingo', 1: 'segunda-feira', 2: 'terça-feira', 3: 'quarta-feira',
  4: 'quinta-feira', 5: 'sexta-feira', 6: 'sábado',
};

const MONTHS = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

function formatDateBR(d: Date): string {
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

function formatDateLong(d: Date): string {
  return `${DAY_NAMES[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}

function nextWeekday(from: Date, targetDay: number): Date {
  const d = new Date(from);
  while (d.getDay() !== targetDay) d.setDate(d.getDate() + 1);
  return d;
}

function isBusinessDay(d: Date): boolean {
  return d.getDay() >= 1 && d.getDay() <= 5;
}

function next24BusinessHours(from: Date): Date {
  let d = new Date(from);
  d.setDate(d.getDate() + 1);
  while (!isBusinessDay(d)) d.setDate(d.getDate() + 1);
  return d;
}

@ApiTags('Schedule')
@Controller('schedule')
export class ScheduleController {
  constructor(@Inject('DATABASE') private readonly sequelize: Sequelize) {}

  @Get('appointments')
  @ApiOperation({ summary: 'Get first consultation slots with actual dates' })
  async getAppointmentSlots() {
    const config = await this.loadConfig('schedule.appointments');
    const weekdays = this.parseWeekdays(config);
    const timeSlots = this.parseTimeSlots(config);
    return { weekdays, timeSlots };
  }

  @Get('appointments/available-dates')
  @ApiOperation({ summary: 'Get available first consultation dates for a day+time' })
  @ApiQuery({ name: 'day', type: Number }) @ApiQuery({ name: 'time', type: String })
  async getAppointmentDates(@Query('day') day: number, @Query('time') time: string) {
    const now = new Date();
    const earliest = next24BusinessHours(now);
    let target = nextWeekday(earliest, Number(day));

    // Check if this slot is booked, find next available
    const booked = await this.getBookedDates(Number(day), time);
    let attempts = 0;
    while (booked.has(formatDateBR(target)) && attempts < 52) {
      target = addDays(target, 7);
      attempts++;
    }

    const isTomorrow = target.toDateString() === addDays(now, 1).toDateString();
    const label = isTomorrow ? 'AMANHÃ' : formatDateLong(target);

    return {
      date: formatDateBR(target),
      dateLong: formatDateLong(target),
      dateISO: target.toISOString().split('T')[0],
      time,
      dayName: DAY_NAMES[target.getDay()],
      label,
      isTomorrow,
    };
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Get session slots with weekdays and times' })
  async getSessionSlots() {
    const config = await this.loadConfig('schedule.sessions');
    const weekdays = this.parseWeekdays(config);
    const timeSlots = this.parseTimeSlots(config);
    return { weekdays, timeSlots };
  }

  @Get('sessions/schedule')
  @ApiOperation({ summary: 'Generate full session schedule with actual dates' })
  @ApiQuery({ name: 'day', type: Number }) @ApiQuery({ name: 'time', type: String }) @ApiQuery({ name: 'count', type: Number })
  async getSessionSchedule(@Query('day') day: number, @Query('time') time: string, @Query('count') count: number) {
    const now = new Date();
    // Sessions start at least 2 weeks from now
    const earliest = addDays(now, 14);
    let start = nextWeekday(earliest, Number(day));
    const sessions: any[] = [];
    const numSessions = Number(count) || 10;
    const booked = await this.getBookedDates(Number(day), time);

    let current = new Date(start);
    let found = 0;
    let attempts = 0;
    while (found < numSessions && attempts < 100) {
      if (!booked.has(formatDateBR(current))) {
        sessions.push({
          number: found + 1,
          date: formatDateBR(current),
          dateISO: current.toISOString().split('T')[0],
          dayName: DAY_NAMES[current.getDay()],
        });
        found++;
      }
      current = addDays(current, 7);
      attempts++;
    }

    const startDate = sessions.length > 0 ? sessions[0] : null;
    const dayName = DAY_NAMES[Number(day)] || '';

    return {
      startDateLong: startDate ? formatDateLong(new Date(startDate.dateISO)) : '',
      dayName,
      time,
      totalSessions: numSessions,
      sessions,
      summary: `${numSessions} Sessões semanais. Mesmo dia e horário. Toda ${dayName} ${time}.`,
    };
  }

  @Get('appointments/by-day')
  @ApiOperation({ summary: 'Get available time slots for a weekday' })
  @ApiQuery({ name: 'day', type: Number })
  async getSlotsByDay(@Query('day') day: number) {
    const config = await this.loadConfig('schedule.appointments');
    const timeSlots = this.parseTimeSlots(config);
    return timeSlots;
  }

  @Get('sessions/by-day')
  @ApiOperation({ summary: 'Get available session time slots for a weekday' })
  @ApiQuery({ name: 'day', type: Number })
  async getSessionSlotsByDay(@Query('day') day: number) {
    const config = await this.loadConfig('schedule.sessions');
    const timeSlots = this.parseTimeSlots(config);
    return timeSlots;
  }

  private async loadConfig(prefix: string): Promise<Record<string, string>> {
    const rows = await this.sequelize.query(
      `SELECT Name, Value FROM tbConfig WHERE Name LIKE :prefix ORDER BY Name`,
      { replacements: { prefix: `${prefix}%` }, type: QueryTypes.SELECT },
    ) as any[];
    const config: Record<string, string> = {};
    rows.forEach((r: any) => { if (r?.Name) config[r.Name] = (r.Value || '').replace(/<\/?p>/g, '').trim(); });
    return config;
  }

  private parseWeekdays(config: Record<string, string>): any[] {
    const weekdays: any[] = [];
    for (let i = 1; i <= 7; i++) {
      const key = Object.keys(config).find(k => k.match(new RegExp(`weekdays\\.slot${i}$`)));
      if (key) {
        const day = parseInt(config[key], 10);
        const blocked = config[`${key}.blocked`] === '1';
        weekdays.push({ dayOfWeek: day, dayName: DAY_NAMES[day] || '', blocked });
      }
    }
    return weekdays;
  }

  private parseTimeSlots(config: Record<string, string>): any[] {
    const slots: any[] = [];
    for (let i = 1; i <= 10; i++) {
      const bk = Object.keys(config).find(k => k.match(new RegExp(`times\\.slot${i}\\.begin$`)));
      const ek = Object.keys(config).find(k => k.match(new RegExp(`times\\.slot${i}\\.end$`)));
      const blk = Object.keys(config).find(k => k.match(new RegExp(`times\\.slot${i}\\.blocked$`)));
      if (bk && ek) {
        const blocked = config[blk!] === '1';
        slots.push({ begin: config[bk], end: config[ek], time: `das ${config[bk]} às ${config[ek]}`, blocked, order: i });
      }
    }
    return slots;
  }

  private async getBookedDates(dayOfWeek: number, time: string): Promise<Set<string>> {
    const begin = time.replace('das ', '').split(' às ')[0] || time;
    const rows = await this.sequelize.query(
      `SELECT CONVERT(VARCHAR(10), DateBegins, 103) as DateStr
       FROM tbSchedule
       WHERE DATEPART(dw, DateBegins) = :dow AND CONVERT(VARCHAR(5), DateBegins, 108) = :begin
         AND DateBegins > GETDATE() AND ClientID IS NOT NULL AND ClientID > 0`,
      { replacements: { dow: dayOfWeek + 1, begin }, type: QueryTypes.SELECT },
    ) as any[];
    return new Set(rows.map((r: any) => r.DateStr));
  }
}
