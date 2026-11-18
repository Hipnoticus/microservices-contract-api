import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import {
  birthDateError, isDisposableEmail, isValidCpf, isValidPhone, normaliseSex, validateSignupCustomer,
} from '../src/application/order/SignupValidation';
import {
  matchOfferedSlot, parseTimeSlots, parseWeekdays, validateOrderSchedule, validatePaymentDates,
} from '../src/application/order/ScheduleRules';
import { clientIp } from '../src/interfaces/http/ClientIp';
import { RateLimiter } from '../src/interfaces/http/RateLimiter';
import { flattenSubmitted, insertBeforeFooter, pixSection, submittedDataSection } from '../src/application/order/InternalEmailSections';

// Incident 20261118: order 5009 was posted with curl, a mailinator address, the generator CPF 52998224725 and
// "14:00" slots that the agenda does not offer.

const validCustomer = () => ({
  firstName: 'Gabriel', lastName: 'Veloso', cpf: '109.625.097-79', email: 'punkore8@gmail.com',
  phone: '(61) 99551-5600', birthDate: '1986-05-28', gender: 'M',
  address: { cep: '70000-000', street: 'SQN 100', number: '10', complement: '', neighborhood: 'Asa Norte', city: 'Brasília', state: 'df' },
});

describe('sign-up validation', () => {
  test('CPF check digits, repeated digits and the generator example', () => {
    expect(isValidCpf('10962509779')).toBe(true);
    expect(isValidCpf('109.625.097-79')).toBe(true);
    expect(isValidCpf('10962509778')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('52998224725')).toBe(false);
    expect(isValidCpf('1234')).toBe(false);
  });

  test('phone: 10-11 digits with DDD, +55 accepted', () => {
    expect(isValidPhone('61995515600')).toBe(true);
    expect(isValidPhone('+55 61 99551-5600')).toBe(true);
    expect(isValidPhone('6133334444')).toBe(true);
    expect(isValidPhone('61895515600')).toBe(false); // 11 digits must be a mobile (9)
    expect(isValidPhone('0199551560')).toBe(false);
    expect(isValidPhone('99999999999')).toBe(false);
    expect(isValidPhone('123')).toBe(false);
  });

  test('disposable e-mail domains, subdomains included', () => {
    expect(isDisposableEmail('rafael.bittencourt.mkt@mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@YOPMAIL.com')).toBe(true);
    expect(isDisposableEmail('x@sub.guerrillamail.com')).toBe(true);
    expect(isDisposableEmail('x@sharklasers.com')).toBe(true);
    expect(isDisposableEmail('punkore8@gmail.com')).toBe(false);
    expect(isDisposableEmail('a@notmailinator.com.br')).toBe(false);
  });

  test('sex and birth date', () => {
    expect(normaliseSex('M')).toBe('M');
    expect(normaliseSex('feminino')).toBe('F');
    expect(normaliseSex('X')).toBeNull();
    expect(birthDateError('1986-05-28', '2026-11-18')).toBeNull();
    expect(birthDateError('2026-11-19', '2026-11-18')).not.toBeNull();
    expect(birthDateError('2015-01-01', '2026-11-18')).not.toBeNull(); // 11 years
    expect(birthDateError('2014-11-18', '2026-11-18')).toBeNull();     // 12 today
    expect(birthDateError('1900-01-01', '2026-11-18')).not.toBeNull();
    expect(birthDateError('1990-02-30', '2026-11-18')).not.toBeNull();
    expect(birthDateError('', '2026-11-18')).not.toBeNull();
  });

  test('a complete customer passes and is normalised', () => {
    const r = validateSignupCustomer(validCustomer(), '2026-11-18');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.customer.cpf).toBe('10962509779');
      expect(r.customer.phone).toBe('61995515600');
      expect(r.customer.address.cep).toBe('70000000');
      expect(r.customer.address.state).toBe('DF');
      expect(r.customer.gender).toBe('M');
    }
  });

  test('the bot order is refused, listing the problems', () => {
    const c = { ...validCustomer(), cpf: '52998224725', email: 'rafael.bittencourt.mkt@mailinator.com' };
    const r = validateSignupCustomer(c, '2026-11-18');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('CPF');
      expect(r.error).toContain('temporários');
    }
  });

  test('missing sex, birth date, phone and address fields are refused', () => {
    for (const patch of [
      { gender: '' }, { birthDate: '' }, { phone: '' },
      { address: { ...validCustomer().address, cep: '' } },
      { address: { ...validCustomer().address, street: '' } },
      { address: { ...validCustomer().address, number: '' } },
      { address: { ...validCustomer().address, neighborhood: '' } },
      { address: { ...validCustomer().address, city: '' } },
      { address: { ...validCustomer().address, state: 'XX' } },
    ]) {
      expect(validateSignupCustomer({ ...validCustomer(), ...patch }, '2026-11-18').ok).toBe(false);
    }
    expect(validateSignupCustomer(undefined, '2026-11-18').ok).toBe(false);
  });
});

// tbConfig on production, 2026-11-18
const prodAppointments = {
  'schedule.appointments.times.slot1.begin': '19:00', 'schedule.appointments.times.slot1.end': '20:00', 'schedule.appointments.times.slot1.blocked': '1',
  'schedule.appointments.times.slot2.begin': '20:00', 'schedule.appointments.times.slot2.end': '21:00', 'schedule.appointments.times.slot2.blocked': '0',
  'schedule.appointments.times.slot3.begin': '21:00', 'schedule.appointments.times.slot3.end': '22:00', 'schedule.appointments.times.slot3.blocked': '1',
  'schedule.appointments.weekdays.slot1': '1', 'schedule.appointments.weekdays.slot1.blocked': '0',
  'schedule.appointments.weekdays.slot2': '2', 'schedule.appointments.weekdays.slot2.blocked': '0',
  'schedule.appointments.weekdays.slot3': '3', 'schedule.appointments.weekdays.slot3.blocked': '0',
  'schedule.appointments.weekdays.slot4': '4', 'schedule.appointments.weekdays.slot4.blocked': '0',
  'schedule.appointments.weekdays.slot5': '5', 'schedule.appointments.weekdays.slot5.blocked': '0',
};
const prodSessions = {
  'schedule.sessions.times.slot3.begin': '14:00', 'schedule.sessions.times.slot3.end': '15:00', 'schedule.sessions.times.slot3.blocked': '1',
  'schedule.sessions.times.slot5.begin': '17:00', 'schedule.sessions.times.slot5.end': '18:00', 'schedule.sessions.times.slot5.blocked': '0',
  'schedule.sessions.weekdays.slot1': '2', 'schedule.sessions.weekdays.slot1.blocked': '0',
  'schedule.sessions.weekdays.slot2': '3', 'schedule.sessions.weekdays.slot2.blocked': '1',
  'schedule.sessions.weekdays.slot3': '4', 'schedule.sessions.weekdays.slot3.blocked': '0',
};
const agenda = (cfg: Record<string, string>) => ({ weekdays: parseWeekdays(cfg), timeSlots: parseTimeSlots(cfg) });

describe('agenda rules', () => {
  const A = agenda(prodAppointments);
  const S = agenda(prodSessions);

  test('slot matching: full Moses text or bare begin, never a blocked or unknown slot', () => {
    expect(matchOfferedSlot(A.timeSlots, 'das 20:00 às 21:00')?.time).toBe('das 20:00 às 21:00');
    expect(matchOfferedSlot(A.timeSlots, '20:00')?.time).toBe('das 20:00 às 21:00');
    expect(matchOfferedSlot(A.timeSlots, '14:00')).toBeNull();
    expect(matchOfferedSlot(A.timeSlots, 'das 19:00 às 20:00')).toBeNull(); // blocked
    expect(matchOfferedSlot(A.timeSlots, 'das 20:00 às 22:00')).toBeNull();
    expect(matchOfferedSlot(A.timeSlots, '20:00; DROP')).toBeNull();
    expect(matchOfferedSlot(A.timeSlots, 2000 as any)).toBeNull();
  });

  test('order 5009 (day 2 14:00 / day 3 14:00) is refused', () => {
    const r = validateOrderSchedule(A, S, { firstAppointmentDay: 2, firstAppointmentHour: '14:00', sessionDay: 3, sessionHour: '14:00' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('1ª consulta');
  });

  test('a blocked session weekday or time is refused, an offered one passes and is canonical', () => {
    expect(validateOrderSchedule(A, S, { firstAppointmentDay: 2, firstAppointmentHour: 'das 20:00 às 21:00', sessionDay: 3, sessionHour: 'das 17:00 às 18:00' }).ok).toBe(false);
    expect(validateOrderSchedule(A, S, { firstAppointmentDay: 2, firstAppointmentHour: 'das 20:00 às 21:00', sessionDay: 2, sessionHour: 'das 14:00 às 15:00' }).ok).toBe(false);
    const ok = validateOrderSchedule(A, S, { firstAppointmentDay: '2', firstAppointmentHour: '20:00', sessionDay: 4, sessionHour: 'das 17:00 às 18:00' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toEqual({ firstAppointmentDay: 2, firstAppointmentHour: 'das 20:00 às 21:00', sessionDay: 4, sessionHour: 'das 17:00 às 18:00' });
    expect(validateOrderSchedule(A, S, { firstAppointmentDay: 0, firstAppointmentHour: '20:00', sessionDay: 4, sessionHour: '17:00' }).ok).toBe(false);
    expect(validateOrderSchedule(A, S, {}).ok).toBe(false);
  });

  const order = { firstAppointmentHour: 'das 20:00 às 21:00', sessionDay: '4', sessionHour: 'das 17:00 às 18:00' };
  const now = { day: '2026-11-18', minutes: 12 * 60 }; // Wednesday 12:00 BRT

  test('payment dates: business day, not in the past, sessions after the 30-day period on the chosen weekday', () => {
    const ok = validatePaymentDates(order, '2026-11-18', '2026-12-24', now);
    expect(ok).toEqual({ ok: true, checks: ['2026-11-18 20:00:00', '2026-12-24 17:00:00'] });
    expect(validatePaymentDates(order, '', '', now)).toEqual({ ok: true, checks: [] });
    expect(validatePaymentDates(order, '2026-11-17', '', now).ok).toBe(false);          // yesterday
    expect(validatePaymentDates(order, '2026-11-21', '', now).ok).toBe(false);          // Saturday
    expect(validatePaymentDates(order, '2026-11-18', '', { day: '2026-11-18', minutes: 20 * 60 }).ok).toBe(false); // started
    expect(validatePaymentDates(order, '2026-11-19', '2026-11-26', now).ok).toBe(false); // inside the 30 days
    expect(validatePaymentDates(order, '2026-11-19', '2026-12-23', now).ok).toBe(false); // Wednesday, not Thursday
    expect(validatePaymentDates(order, 'amanhã', '', now).ok).toBe(false);
  });
});

describe('client IP and rate limit', () => {
  test('CF-Connecting-IP, then the first X-Forwarded-For hop, then the socket', () => {
    expect(clientIp({ headers: { 'cf-connecting-ip': '155.2.219.49', 'x-forwarded-for': '10.0.0.1' } })).toBe('155.2.219.49');
    expect(clientIp({ headers: { 'x-forwarded-for': '155.2.219.49, 172.18.0.5' } })).toBe('155.2.219.49');
    expect(clientIp({ headers: { 'cf-connecting-ip': 'garbage' }, socket: { remoteAddress: '::ffff:172.18.0.9' } })).toBe('172.18.0.9');
    expect(clientIp({ headers: {} })).toBe('unknown');
  });

  test('5 per hour per IP, then a wait in seconds', () => {
    const rl = new RateLimiter(5, 3600_000);
    for (let i = 0; i < 5; i++) expect(rl.hit('1.2.3.4', 1000)).toBe(0);
    expect(rl.hit('1.2.3.4', 1000)).toBe(3600);
    expect(rl.hit('5.6.7.8', 1000)).toBe(0);
    expect(rl.hit('1.2.3.4', 3601_000)).toBe(0);
    expect(() => { const r = new RateLimiter(0, 1000); r.check('x', 'cadastro'); }).toThrow();
  });
});

describe('internal e-mail sections', () => {
  test('submitted fields are flattened; card number masked and CVV omitted', () => {
    const f = Object.fromEntries(flattenSubmitted({ customer: { cpf: '1' }, card: { number: '4111111111111111', securityCode: '123' } }));
    expect(f['customer.cpf']).toBe('1');
    expect(f['card.number']).toBe('**** 1111');
    expect(f['card.securityCode']).toBe('(omitido)');
  });

  test('"Dados enviados" escapes values and includes birth date and IP', () => {
    const html = submittedDataSection({
      order: { ip: '155.2.219.49', userAgent: 'curl/8.5.0', at: new Date(), body: { customer: { firstName: '<b>x</b>' } } },
    }, '12/04/1988', '155.2.219.49');
    expect(html).toContain('Dados enviados');
    expect(html).toContain('12/04/1988');
    expect(html).toContain('155.2.219.49');
    expect(html).toContain('curl/8.5.0');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  test('PIX section has a QR code table and the copia-e-cola text', () => {
    const code = '00020101021226930014BR.GOV.BCB.PIX2571spi-qrcode.bancointer.com.br/spi/pj/v2/eca95dde1089488a9e13dd9e318cf70a520400005303986540819990.005802BR5901*6008BRASILIA61087067307962070503***6304AD45';
    const html = pixSection(code);
    expect(html).toContain(code);
    expect(html).toContain('bgcolor="#000000"');
    expect(html.length).toBeLessThan(90_000);
    expect(pixSection('')).toBe('');
  });

  test('sections go before the footer row that holds [IP_CLIENTE]', () => {
    const tpl = '<tr><td>body</td></tr><tr><td class="hx-pad">Pedido enviado em [DATA_HORA_ENVIO] &middot; IP [IP_CLIENTE]</td></tr>';
    expect(insertBeforeFooter(tpl, '<tr>X</tr>', '1.2.3.4')).toBe('<tr><td>body</td></tr><tr>X</tr><tr><td class="hx-pad">Pedido enviado em [DATA_HORA_ENVIO] &middot; IP [IP_CLIENTE]</td></tr>');
    expect(insertBeforeFooter('<p>old</p>', '<tr>X</tr>', '1.2.3.4')).toContain('IP 1.2.3.4');
  });
});

describe('SendConfirmationEmailUseCase (internal PIX e-mail)', () => {
  test('staff e-mail has birth date, IP, Dados enviados and the PIX QR; customer e-mail has none of the extras', async () => {
    const fs = require('fs');
    const tpl = fs.readFileSync(__dirname + '/../templates/email/client.email.depositodata.html', 'utf8');
    const db = { query: async () => [
      { Name: 'client.email.depositodata', Value: tpl },
      { Name: 'client.email.depositodata_cliente_success', Value: '<p>Ola [NOME_CLIENTE]</p>' },
    ] };
    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string, init: any) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };
    try {
      const { SendConfirmationEmailUseCase } = require('../src/application/use-cases/SendConfirmationEmailUseCase');
      await new SendConfirmationEmailUseCase(db, 'http://email').execute({
        customerName: 'Rafael <i>B</i>', customerCpf: '1', customerEmail: 'a@b.com', customerPhone: '', customerBirthDate: '12/04/1988',
        addressCountry: 'Brasil', addressCep: '', addressStreet: '', addressNumber: '', addressComplement: '', addressNeighborhood: '',
        addressCity: '', addressState: '', mainGoal: 'Ansiedade', packageSize: 10, orderItems: '', firstAppointmentDay: '',
        firstAppointmentHour: '', sessionDay: '', sessionHour: '', paymentMethod: 'pix', amount: 19990, installments: 1,
        pixCopiaECola: '00020101021226930014BR.GOV.BCB.PIX', clientIp: '155.2.219.49',
        submitted: { order: { ip: '155.2.219.49', userAgent: 'curl/8', at: new Date(), body: { customer: { email: 'a@b.com' } } } },
      });
    } finally { (globalThis as any).fetch = realFetch; }
    const staff = sent.find((m) => m.to === 'contato@hipnoterapia.org');
    const client = sent.find((m) => m.to === 'a@b.com');
    expect(staff.content).toContain('12/04/1988');
    expect(staff.content).toContain('IP 155.2.219.49');
    expect(staff.content).toContain('Dados enviados');
    expect(staff.content).toContain('curl/8');
    expect(staff.content).toContain('00020101021226930014BR.GOV.BCB.PIX');
    expect(staff.content).toContain('bgcolor="#000000"');
    expect(staff.content).toContain('&lt;');
    expect(staff.content).not.toMatch(/<i>B/i);
    expect(staff.content.indexOf('Dados enviados</div>')).toBeLessThan(staff.content.indexOf('Pedido enviado em'));
    expect(staff.content).not.toContain('\u0000');
    expect(client.content).not.toContain('Dados enviados');
  });
});
