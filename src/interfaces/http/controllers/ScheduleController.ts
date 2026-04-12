import { Controller, Get, Query, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Sequelize, QueryTypes } from 'sequelize';

interface TimeSlot {
  begin: string;
  end: string;
  blocked: boolean;
}

interface WeekdaySlot {
  dayOfWeek: number;
  dayName: string;
  blocked: boolean;
}

interface AvailableSlot {
  dayOfWeek: number;
  dayName: string;
  time: string;
  begin: string;
  end: string;
  available: boolean;
}

const DAY_NAMES: Record<number, string> = {
  0: 'Domingo', 1: 'Segunda-feira', 2: 'Terça-feira', 3: 'Quarta-feira',
  4: 'Quinta-feira', 5: 'Sexta-feira', 6: 'Sábado',
};

@ApiTags('Schedule')
@Controller('schedule')
export class ScheduleController {
  constructor(@Inject('DATABASE') private readonly sequelize: Sequelize) {}

  @Get('appointments')
  @ApiOperation({ summary: 'Get available first consultation slots (from tbConfig)' })
  async getAppointmentSlots(): Promise<{ weekdays: WeekdaySlot[]; timeSlots: TimeSlot[]; available: AvailableSlot[] }> {
    const config = await this.loadConfig('schedule.appointments');
    const weekdays = this.parseWeekdays(config);
    const timeSlots = this.parseTimeSlots(config);
    const booked = await this.getBookedSlots('appointments');
    const available = this.buildAvailableSlots(weekdays, timeSlots, booked);
    return { weekdays, timeSlots, available };
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Get available session slots (from tbConfig)' })
  async getSessionSlots(): Promise<{ weekdays: WeekdaySlot[]; timeSlots: TimeSlot[]; available: AvailableSlot[] }> {
    const config = await this.loadConfig('schedule.sessions');
    const weekdays = this.parseWeekdays(config);
    const timeSlots = this.parseTimeSlots(config);
    const booked = await this.getBookedSlots('sessions');
    const available = this.buildAvailableSlots(weekdays, timeSlots, booked);
    return { weekdays, timeSlots, available };
  }

  @Get('appointments/by-day')
  @ApiOperation({ summary: 'Get available appointment time slots for a specific weekday' })
  @ApiQuery({ name: 'day', type: Number, description: 'Day of week (0=Sun, 1=Mon, ..., 6=Sat)' })
  async getAppointmentSlotsByDay(@Query('day') day: number): Promise<AvailableSlot[]> {
    const config = await this.loadConfig('schedule.appointments');
    const weekdays = this.parseWeekdays(config);
    const timeSlots = this.parseTimeSlots(config);
    const booked = await this.getBookedSlots('appointments');
    return this.buildAvailableSlots(weekdays, timeSlots, booked).filter(s => s.dayOfWeek === Number(day));
  }

  @Get('sessions/by-day')
  @ApiOperation({ summary: 'Get available session time slots for a specific weekday' })
  @ApiQuery({ name: 'day', type: Number, description: 'Day of week (0=Sun, 1=Mon, ..., 6=Sat)' })
  async getSessionSlotsByDay(@Query('day') day: number): Promise<AvailableSlot[]> {
    const config = await this.loadConfig('schedule.sessions');
    const weekdays = this.parseWeekdays(config);
    const timeSlots = this.parseTimeSlots(config);
    const booked = await this.getBookedSlots('sessions');
    return this.buildAvailableSlots(weekdays, timeSlots, booked).filter(s => s.dayOfWeek === Number(day));
  }

  private async loadConfig(prefix: string): Promise<Record<string, string>> {
    const rows = await this.sequelize.query(
      `SELECT Name, Value FROM tbConfig WHERE Name LIKE :prefix ORDER BY Name`,
      { replacements: { prefix: `${prefix}%` }, type: QueryTypes.SELECT },
    ) as any[];
    const config: Record<string, string> = {};
    rows.forEach((r: any) => {
      if (r && r.Name) {
        config[r.Name] = (r.Value || '').replace(/<\/?p>/g, '').trim();
      }
    });
    return config;
  }

  private parseWeekdays(config: Record<string, string>): WeekdaySlot[] {
    const weekdays: WeekdaySlot[] = [];
    for (let i = 1; i <= 7; i++) {
      const key = Object.keys(config).find(k => k.match(new RegExp(`weekdays\\.slot${i}$`)));
      if (key) {
        const day = parseInt(config[key], 10);
        const blockedKey = `${key}.blocked`;
        const blocked = config[blockedKey] === '1';
        weekdays.push({ dayOfWeek: day, dayName: DAY_NAMES[day] || `Day ${day}`, blocked });
      }
    }
    return weekdays;
  }

  private parseTimeSlots(config: Record<string, string>): TimeSlot[] {
    const slots: TimeSlot[] = [];
    for (let i = 1; i <= 10; i++) {
      const beginKey = Object.keys(config).find(k => k.match(new RegExp(`times\\.slot${i}\\.begin$`)));
      const endKey = Object.keys(config).find(k => k.match(new RegExp(`times\\.slot${i}\\.end$`)));
      const blockedKey = Object.keys(config).find(k => k.match(new RegExp(`times\\.slot${i}\\.blocked$`)));
      if (beginKey && endKey) {
        slots.push({
          begin: config[beginKey],
          end: config[endKey],
          blocked: config[blockedKey!] === '1',
        });
      }
    }
    return slots;
  }

  private async getBookedSlots(type: string): Promise<Set<string>> {
    const rows = await this.sequelize.query(
      `SELECT DATEPART(dw, DateBegins) as DayOfWeek, 
              CONVERT(VARCHAR(5), DateBegins, 108) as TimeBegin
       FROM tbSchedule 
       WHERE DateBegins > GETDATE() 
         AND DateBegins < DATEADD(month, 6, GETDATE())
         AND ClientID IS NOT NULL AND ClientID > 0
         AND (Blocked = 0 OR Blocked IS NULL)
       GROUP BY DATEPART(dw, DateBegins), CONVERT(VARCHAR(5), DateBegins, 108)
       HAVING COUNT(*) >= 4`,
      { type: QueryTypes.SELECT },
    ) as any[];
    const booked = new Set<string>();
    rows.forEach((r: any) => {
      const adjustedDay = (r.DayOfWeek - 1) % 7;
      booked.add(`${adjustedDay}-${r.TimeBegin}`);
    });
    return booked;
  }

  private buildAvailableSlots(weekdays: WeekdaySlot[], timeSlots: TimeSlot[], booked: Set<string>): AvailableSlot[] {
    const available: AvailableSlot[] = [];
    for (const wd of weekdays) {
      for (const ts of timeSlots) {
        const key = `${wd.dayOfWeek}-${ts.begin}`;
        const isBooked = booked.has(key);
        const isAvailable = !wd.blocked && !ts.blocked && !isBooked;
        available.push({
          dayOfWeek: wd.dayOfWeek,
          dayName: wd.dayName,
          time: `das ${ts.begin} às ${ts.end}`,
          begin: ts.begin,
          end: ts.end,
          available: isAvailable,
        });
      }
    }
    return available;
  }
}
