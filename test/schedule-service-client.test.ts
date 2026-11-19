import { afterEach, describe, expect, test } from 'bun:test';
import { ScheduleServiceClient, scheduleServiceEnabled } from '../src/infrastructure/schedule/ScheduleServiceClient';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function capture(answer: unknown, status = 200) {
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(answer), { status, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return calls;
}

describe('ScheduleAPI client (SCHEDULE_SERVICE_ENABLED)', () => {
  test('the flag is opt-in', () => {
    expect(scheduleServiceEnabled({ SCHEDULE_SERVICE_ENABLED: 'true' } as any)).toBe(true);
    expect(scheduleServiceEnabled({ SCHEDULE_SERVICE_ENABLED: ' TRUE ' } as any)).toBe(true);
    expect(scheduleServiceEnabled({ SCHEDULE_SERVICE_ENABLED: 'false' } as any)).toBe(false);
    expect(scheduleServiceEnabled({} as any)).toBe(false);
  });

  test('payment check sends the stored order choices and the dates with the service token', async () => {
    const calls = capture({ ok: false, error: 'O horário de 18/11/2026 às 20:00 acabou de ser reservado por outro cliente. Escolha outro horário.' });
    const c = new ScheduleServiceClient(null, 'http://schedule:2003/', 'tok-0123456789abcdef01234567');
    const r = await c.checkReservation(
      { id: 5100, firstAppointmentDay: '2', firstAppointmentHour: 'das 20:00 às 21:00', sessionDay: '4', sessionHour: 'das 17:00 às 18:00' },
      '2026-11-18', '2026-12-24');
    expect(r.ok).toBe(false);
    expect(calls[0].url).toBe('http://schedule:2003/internal/reservations/check');
    expect(calls[0].init.headers['X-Service-Token']).toBe('tok-0123456789abcdef01234567');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      orderId: 5100, firstAppointmentDay: '2', firstAppointmentHour: 'das 20:00 às 21:00', sessionDay: '4',
      sessionHour: 'das 17:00 às 18:00', firstAppointmentDate: '2026-11-18', sessionStartDate: '2026-12-24',
    });
  });

  test('reservation sends the order snapshot; confirmation answers whether anything moved', async () => {
    const db = { query: async () => [{ ID: 5100, CustomerID: 43, Total: '1500.00', MainGoal: 'Ansiedade', FirstAppointmentDay: 4,
      FirstAppointmentHour: 'das 20:00 às 21:00', SessionDay: 3, SessionHour: 'das 14:00 às 15:00', ProductName: '10 Sessões - 4 Meses' }] };
    let calls = capture({ treatmentId: 9000 });
    const c = new ScheduleServiceClient(db, 'http://schedule:2003', 'tok');
    expect(await c.execute(5100, { firstAppointmentDate: '2026-11-19', sessionStartDate: '2026-12-23', confirmNow: false })).toBe(9000);
    const body = JSON.parse(calls[0].init.body);
    expect(body.order).toEqual({ id: 5100, customerId: 43, total: 1500, mainGoal: 'Ansiedade', productName: '10 Sessões - 4 Meses',
      firstAppointmentDay: 4, firstAppointmentHour: 'das 20:00 às 21:00', sessionDay: 3, sessionHour: 'das 14:00 às 15:00' });
    expect(body.confirmNow).toBe(false);

    calls = capture({ confirmed: true });
    expect(await c.confirmSessions(5100)).toBe(true);
    expect(calls[0].url).toBe('http://schedule:2003/internal/reservations/5100/confirm');
  });

  test('a missing order is not sent; an agenda that does not answer fails the request (503)', async () => {
    const calls = capture({});
    const c = new ScheduleServiceClient({ query: async () => [] }, 'http://schedule:2003', 'tok');
    expect(await c.execute(1, {})).toBeNull();
    expect(calls.length).toBe(0);

    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    await expect(c.confirmSessions(1)).rejects.toMatchObject({ status: 503 });
    capture({ error: 'unauthorized' }, 401);
    await expect(c.validateOrderSchedule({})).rejects.toMatchObject({ status: 503 });
  });
});
