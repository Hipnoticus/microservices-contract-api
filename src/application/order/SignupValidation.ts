/**
 * Server-side checks for the public sign-up/order body (incident 20261118: a bot called POST /orders directly).
 * Moses validates the same fields, but the API is public, so nothing the browser checked is trusted here.
 * Every function is pure so the rules can be unit tested.
 */

/** Valid check digits, but published as the example output of CPF generators, so never a real customer. */
export const EXAMPLE_CPFS = new Set(['52998224725']);

/** Common throwaway-mailbox domains (and their aliases). Subdomains are matched too. */
export const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'mailinator.net', 'mailinator.org', 'mailinator2.com', 'notmailinator.com', 'reallymymail.com',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'guerrillamail.de',
  'guerrillamailblock.com', 'grr.la', 'sharklasers.com', 'pokemail.net', 'spam4.me',
  '10minutemail.com', '10minutemail.net', '10minutemail.co.uk', '10minutemail.de', '10minemail.com', '20minutemail.com',
  'temp-mail.org', 'temp-mail.io', 'tempmail.com', 'tempmail.net', 'tempmail.dev', 'tempmailo.com', 'tempmail.plus',
  'tempail.com', 'tempr.email', 'tmpmail.org', 'tmpmail.net', 'tmail.ws', 'emailtemporario.com.br',
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'cool.fr.nf', 'jetable.fr.nf', 'courriel.fr.nf', 'moncourrier.fr.nf',
  'trashmail.com', 'trashmail.net', 'trashmail.de', 'trashmail.me', 'trashmail.io', 'trash-mail.com', 'trashmail.ws',
  'throwawaymail.com', 'dispostable.com', 'getnada.com', 'nada.email', 'maildrop.cc', 'mailnesia.com', 'mailcatch.com',
  'mintemail.com', 'mohmal.com', 'fakeinbox.com', 'fakemail.net', 'emailondeck.com', 'spamgourmet.com',
  'mytemp.email', 'burnermail.io', 'discard.email', 'mailpoof.com', 'inboxkitten.com', 'getairmail.com',
  'mail.tm', 'mail.gw', '1secmail.com', '1secmail.net', '1secmail.org', 'harakirimail.com', 'spambox.us',
  'emailfake.com', 'crazymailing.com', 'linshiyouxiang.net', 'mailtemp.net', 'byom.de', 'mvrht.net',
]);

export const BR_STATES = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]);

export const MIN_AGE = 12;
export const MAX_AGE = 110;

export const digits = (v: unknown): string => String(v ?? '').replace(/\D/g, '');
const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

export function isValidCpf(raw: unknown): boolean {
  const d = digits(raw);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d) || EXAMPLE_CPFS.has(d)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === Number(d[9]) && check(10) === Number(d[10]);
}

/** BR phone: DDD 11..99 plus 8 digits (landline, first digit 2-9) or 9 digits starting with 9 (mobile). */
export function isValidPhone(raw: unknown): boolean {
  let d = digits(raw);
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2); // +55 prefix
  if (d.length !== 10 && d.length !== 11) return false;
  if (/^(\d)\1+$/.test(d) || !/^[1-9][1-9]/.test(d)) return false;
  if (d.length === 11 && d[2] !== '9') return false;
  if (d.length === 10 && /[01]/.test(d[2])) return false;
  return true;
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
}

export function isDisposableEmail(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i.test(email);
}

/** 'M' / 'F' (also the stored forms '0'/'1' and the words). Anything else is null. */
export function normaliseSex(raw: unknown): 'M' | 'F' | null {
  const v = text(raw).toUpperCase();
  if (v === 'M' || v === '0' || v === 'MASCULINO') return 'M';
  if (v === 'F' || v === '1' || v === 'FEMININO') return 'F';
  return null;
}

/** Calendar date in Brasília as yyyy-mm-dd (independent of the container's time zone). */
export function todayBrt(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** yyyy-mm-dd (a time part is ignored) to {y,m,d} if it is a real calendar date. */
export function parseIsoDate(raw: unknown): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(text(raw));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** Error message, or null when the birth date is a real past date giving an age of MIN_AGE..MAX_AGE. */
export function birthDateError(raw: unknown, today = todayBrt()): string | null {
  const b = parseIsoDate(raw);
  if (!b) return 'Informe uma data de nascimento válida (AAAA-MM-DD).';
  const t = parseIsoDate(today)!;
  if (Date.UTC(b.y, b.m - 1, b.d) >= Date.UTC(t.y, t.m - 1, t.d)) return 'A data de nascimento precisa estar no passado.';
  let age = t.y - b.y;
  if (t.m < b.m || (t.m === b.m && t.d < b.d)) age--;
  if (age < MIN_AGE || age > MAX_AGE) return `A idade precisa estar entre ${MIN_AGE} e ${MAX_AGE} anos.`;
  return null;
}

export interface SignupCustomer {
  firstName: string;
  lastName: string;
  cpf: string;
  email: string;
  phone: string;
  birthDate: string;
  gender: 'M' | 'F';
  address: {
    cep: string; street: string; number: string; complement: string;
    neighborhood: string; city: string; state: string; country: string;
  };
}

/**
 * Validates and normalises the customer block of POST /orders. Returns the cleaned customer (CPF, phone and CEP as
 * digits, UF upper case, birth date yyyy-mm-dd) or a pt-BR message listing every problem.
 */
export function validateSignupCustomer(c: any, today = todayBrt()): { ok: true; customer: SignupCustomer } | { ok: false; error: string } {
  const errors: string[] = [];
  const firstName = text(c?.firstName);
  const lastName = text(c?.lastName);
  const email = text(c?.email);
  const a = c?.address ?? {};

  if (firstName.length < 2 || firstName.length > 100) errors.push('nome');
  if (lastName.length < 2 || lastName.length > 150) errors.push('sobrenome');
  if (!isValidCpf(c?.cpf)) errors.push('CPF válido');
  if (!isValidEmail(email)) errors.push('e-mail válido');
  else if (isDisposableEmail(email)) errors.push('e-mail permanente (endereços temporários/descartáveis não são aceitos)');
  if (!isValidPhone(c?.phone)) errors.push('telefone com DDD (10 ou 11 dígitos)');
  const sex = normaliseSex(c?.gender);
  if (!sex) errors.push('sexo (M ou F)');
  const bdError = birthDateError(c?.birthDate, today);
  if (bdError) {
    errors.push(bdError.startsWith('Informe')
      ? 'data de nascimento válida (AAAA-MM-DD)'
      : `data de nascimento (${bdError.replace(/\.$/, '').toLowerCase()})`);
  }

  const cep = digits(a.cep);
  const street = text(a.street);
  const number = text(a.number);
  const neighborhood = text(a.neighborhood);
  const city = text(a.city);
  const state = text(a.state).toUpperCase();
  const country = text(a.country) || 'Brasil';
  if (cep.length !== 8 || /^(\d)\1{7}$/.test(cep)) errors.push('CEP (8 dígitos)');
  if (street.length < 2 || street.length > 255) errors.push('endereço');
  if (!number || number.length > 20) errors.push('número do endereço');
  if (neighborhood.length < 2 || neighborhood.length > 255) errors.push('bairro');
  if (city.length < 2 || city.length > 255) errors.push('cidade');
  if (!BR_STATES.has(state)) errors.push('estado (UF)');

  if (errors.length) return { ok: false, error: `Dados de cadastro inválidos. Informe: ${errors.join('; ')}.` };
  const b = parseIsoDate(c.birthDate)!;
  return {
    ok: true,
    customer: {
      firstName, lastName, email, cpf: digits(c.cpf), phone: digits(c.phone).replace(/^55(?=\d{10,11}$)/, ''),
      birthDate: `${b.y}-${String(b.m).padStart(2, '0')}-${String(b.d).padStart(2, '0')}`,
      gender: sex!,
      address: { cep, street, number, complement: text(a.complement).slice(0, 255), neighborhood, city, state, country },
    },
  };
}

export interface Lead {
  name: string;
  email: string;
  phone: string;
  cpf: string;
  packageName: string;
}

/**
 * POST /leads/register (the first Contratar step, public): full name and a permanent e-mail are required; phone and
 * CPF are optional but must be valid when sent. Returns the cleaned lead (phone and CPF as digits) or a pt-BR error.
 */
export function validateLead(b: any): { ok: true; lead: Lead } | { ok: false; error: string } {
  const errors: string[] = [];
  const name = text(b?.name).replace(/\s+/g, ' ');
  const email = text(b?.email);
  const phone = digits(b?.phone);
  const cpf = digits(b?.cpf);
  if (name.length < 3 || name.length > 200 || !name.includes(' ')) errors.push('nome completo');
  if (!isValidEmail(email)) errors.push('e-mail válido');
  else if (isDisposableEmail(email)) errors.push('e-mail permanente (endereços temporários/descartáveis não são aceitos)');
  if (phone && !isValidPhone(phone)) errors.push('telefone com DDD (10 ou 11 dígitos)');
  if (cpf && !isValidCpf(cpf)) errors.push('CPF válido');
  if (errors.length) return { ok: false, error: `Dados inválidos. Informe: ${errors.join('; ')}.` };
  return {
    ok: true,
    lead: { name, email, phone: phone.replace(/^55(?=\d{10,11}$)/, ''), cpf, packageName: text(b?.packageName).slice(0, 200) },
  };
}
