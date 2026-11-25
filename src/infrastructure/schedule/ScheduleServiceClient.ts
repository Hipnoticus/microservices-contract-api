import { callerHeaders } from '../../interfaces/http/auth/InternalAuth';
/**
 * The agenda now lives in ScheduleAPI (.NET, schedule-service; SRP refactor phase 3). With SCHEDULE_SERVICE_ENABLED=true
 * the payment flow asks it, over the Docker network with X-Service-Token, instead of running ContractAPI's own copy:
 *  - POST /orders           -> POST /internal/schedule/order-choices/validate (weekday/time are offered slots)
 *  - POST /payments/process -> POST /internal/reservations/check (dates follow the rules, slots still free)
 *  - reservation            -> POST /internal/reservations (tbTreatments + tbSchedule, or tbSessions too when paid)
 *  - payment confirmed      -> POST /internal/reservations/:orderId/confirm (tbSchedule -> tbSessions)
 * Synchronous on purpose: when the agenda does not answer, the order or payment fails instead of booking blindly.
 * The old code paths (ScheduleRules.ts, CreateSessionsUseCase) stay in place until this is verified everywhere.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('ScheduleServiceClient');

export type OrderScheduleCheck =
  | { ok: true; value: { firstAppointmentDay: number; firstAppointmentHour: string; sessionDay: number; sessionHour: string } }
  | { ok: false; error: string };

/** What the payment flow needs from the agenda. CreateSessionsUseCase (local) and ScheduleServiceClient (remote) both fit. */
export interface SessionReservations {
  execute(orderId: number, overrides?: { firstAppointmentDate?: string; sessionStartDate?: string; confirmNow?: boolean }): Promise<number | null>;
  confirmSessions(orderId: number): Promise<boolean>;
}

/** The agenda checks of POST /orders and POST /payments/process. */
export interface ScheduleRulesPort {
  validateOrderSchedule(dto: { firstAppointmentDay?: unknown; firstAppointmentHour?: unknown; sessionDay?: unknown; sessionHour?: unknown }): Promise<OrderScheduleCheck>;
  checkReservation(
    order: { id: number; firstAppointmentDay: unknown; firstAppointmentHour: unknown; sessionDay: unknown; sessionHour: unknown },
    firstAppointmentDate: unknown,
    sessionStartDate: unknown,
  ): Promise<{ ok: boolean; error?: string | null }>;
}

export function scheduleServiceEnabled(env = process.env): boolean {
  return String(env.SCHEDULE_SERVICE_ENABLED || '').trim().toLowerCase() === 'true';
}

export class ScheduleServiceClient implements SessionReservations, ScheduleRulesPort {
  constructor(
    private readonly sequelize: any,
    private readonly baseUrl = process.env.SCHEDULE_SERVICE_URL || 'http://hipnoticus-schedule-api:2003',
    private readonly token = process.env.SCHEDULE_SERVICE_TOKEN || '',
    private readonly timeoutMs = 10000,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Token': this.token, ...callerHeaders('contract-api') },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      logger.error(`ScheduleAPI ${path} unreachable: ${(e as Error).message}`);
      throw new HttpException({ error: 'Agenda indisponível no momento. Tente novamente em instantes.' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    if (!res.ok) {
      logger.error(`ScheduleAPI ${path} answered ${res.status}`);
      throw new HttpException({ error: 'Agenda indisponível no momento. Tente novamente em instantes.' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return (await res.json()) as T;
  }

  validateOrderSchedule(dto: { firstAppointmentDay?: unknown; firstAppointmentHour?: unknown; sessionDay?: unknown; sessionHour?: unknown }) {
    return this.post<OrderScheduleCheck>('/internal/schedule/order-choices/validate', {
      firstAppointmentDay: dto?.firstAppointmentDay ?? null,
      firstAppointmentHour: dto?.firstAppointmentHour ?? null,
      sessionDay: dto?.sessionDay ?? null,
      sessionHour: dto?.sessionHour ?? null,
    });
  }

  checkReservation(
    order: { id: number; firstAppointmentDay: unknown; firstAppointmentHour: unknown; sessionDay: unknown; sessionHour: unknown },
    firstAppointmentDate: unknown,
    sessionStartDate: unknown,
  ) {
    return this.post<{ ok: boolean; error?: string | null }>('/internal/reservations/check', {
      orderId: order.id,
      firstAppointmentDay: order.firstAppointmentDay ?? null,
      firstAppointmentHour: order.firstAppointmentHour ?? null,
      sessionDay: order.sessionDay ?? null,
      sessionHour: order.sessionHour ?? null,
      firstAppointmentDate: firstAppointmentDate ?? null,
      sessionStartDate: sessionStartDate ?? null,
    });
  }

  /** Same contract as CreateSessionsUseCase.execute: the treatment id, or null (order missing or already reserved). */
  async execute(orderId: number, overrides?: { firstAppointmentDate?: string; sessionStartDate?: string; confirmNow?: boolean }): Promise<number | null> {
    // ContractAPI owns tbOrders: send the agenda what it needs from the order (same query as CreateSessionsUseCase)
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
    const o = orders[0];
    const r = await this.post<{ treatmentId: number | null }>('/internal/reservations', {
      order: {
        id: Number(o.ID), customerId: Number(o.CustomerID), total: o.Total === null ? null : Number(o.Total),
        mainGoal: o.MainGoal ?? null, productName: o.ProductName ?? null,
        firstAppointmentDay: o.FirstAppointmentDay ?? null, firstAppointmentHour: o.FirstAppointmentHour ?? null,
        sessionDay: o.SessionDay ?? null, sessionHour: o.SessionHour ?? null,
      },
      firstAppointmentDate: overrides?.firstAppointmentDate || null,
      sessionStartDate: overrides?.sessionStartDate || null,
      confirmNow: overrides?.confirmNow || false,
    });
    logger.info(r.treatmentId
      ? `ScheduleAPI reserved order ${orderId} as treatment ${r.treatmentId}${overrides?.confirmNow ? ' (confirmed)' : ''}`
      : `ScheduleAPI: schedule/sessions already exist for order ${orderId}, skipping`);
    return r.treatmentId ?? null;
  }

  /** Same contract as CreateSessionsUseCase.confirmSessions: false when nothing was reserved for the order. */
  async confirmSessions(orderId: number): Promise<boolean> {
    const r = await this.post<{ confirmed: boolean }>(`/internal/reservations/${Number(orderId) || 0}/confirm`, {});
    logger.info(`ScheduleAPI confirm order ${orderId}: ${r.confirmed}`);
    return !!r.confirmed;
  }
}
