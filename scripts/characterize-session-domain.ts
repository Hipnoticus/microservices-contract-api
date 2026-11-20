/**
 * Characterization fixtures for the move of the session e-mail, reminder job and Google Calendar sync to SessionAPI
 * (SRP phase 3, 2026-11-19). Runs the real ContractAPI code and writes what it produces, so SessionAPI's Java tests can
 * assert byte-identical output: e-mail subject/body/recipients, event payload JSON + hash, encrypted tokens and OAuth
 * state that SessionAPI must accept.
 *
 *   bun run scripts/characterize-session-domain.ts ../SessionAPI/src/test/resources/contractapi-characterization.json
 */
import { SessionEmailService } from '../src/application/admin/SessionEmailService';
import { buildEventPayload } from '../src/application/use-cases/SyncGoogleCalendarUseCase';
import { sha256Hex, TokenCrypto } from '../src/infrastructure/google/TokenCrypto';
import { properName } from '../src/shared/names';
import { GoogleCalendarClient } from '../src/infrastructure/google/GoogleCalendarClient';
import { writeFileSync } from 'node:fs';

const KEY = Buffer.alloc(32, 7).toString('base64');

async function emails() {
  const template = '<p>Ol&aacute; [NOME_CLIENTE],</p><p>Sua sessão é [DIA_SEMANA], [DATA_COMPLETA] às [HORA]. Valor [VALOR_BRUTO] '
    + '[s*o*m*a] taxa. <a href="https://moses.hipnoticus.com.br/sessao/[ID_SESSAO]">Ver detalhes</a> [HORA]</p>';
  const rows = [
    { id: 43001, callName: null, firstName: 'MARIA DA SILVA', email: 'maria@example.com', value: 1234.5, begins: '2026-11-21T09:30:00', sentCount: 0 },
    { id: 43002, callName: 'gabriel', firstName: 'Gabriel', email: 'punkore8@gmail.com', value: 150, begins: '2026-11-24T19:00:00', sentCount: 2 },
    { id: 43003, callName: '', firstName: '', email: 'x@example.com', value: null, begins: '2026-11-22T00:05:00', sentCount: null },
    { id: 43004, callName: '  ana-clara   de  souza ', firstName: 'x', email: 'a@example.com', value: 0.1, begins: '2026-11-23T14:00:00', sentCount: 1 },
  ];
  const out: any[] = [];
  for (const row of rows) {
    const sent: any[] = [];
    const updates: string[] = [];
    const db: any = {
      query: async (sql: string) => {
        if (sql.includes('FROM tbSessions s INNER JOIN tbCustomers')) return [row];
        if (sql.includes("Name = 'sessions.email.confirmation'")) return [{ value: template }];
        if (sql.startsWith('UPDATE tbSessions')) { updates.push(sql); return [0, 0]; }
        throw new Error(`unexpected ${sql}`);
      },
    };
    (globalThis as any).fetch = async (url: string, init: any) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as any;
    };
    process.env.EMAIL_API_TOKEN = 'tok';
    const result = await new SessionEmailService(db, 'http://email', 'henrique@hipnoterapia.org').sendConfirmation(row.id);
    out.push({ row, template, result, sent, updates: updates.length });
  }
  return out;
}

function events() {
  const base = {
    id: 101, name: 'Sessão', clientName: 'Maria Silva', phone: '21999990000', statusName: 'Confirmada',
    firstSession: true, paid: false, dateBegins: '2026-10-20T10:00:00', dateEnds: '2026-10-20T11:00:00',
  };
  const cases = [
    base,
    { ...base, id: 102, name: null, clientName: null, phone: null, statusName: null, firstSession: false, paid: true },
    { ...base, id: 103, dateBegins: '2026-10-20T23:30:00.000', dateEnds: null },
    { ...base, id: 104, dateEnds: '2026-10-20T09:00:00' },
    { ...base, id: 105, name: '  Hipnose "regressiva" \\ teste\t ', clientName: 'José\u0001 Ñandú 😀', phone: '   ', statusName: ' Reservada ' },
    { ...base, id: 106, clientName: 'Linha\nquebrada\r\u001f\u007f\u2028', dateBegins: '2026-12-31T23:59:59', dateEnds: '2026-12-31T23:59:59' },
  ];
  return cases.map((s) => {
    const payload = buildEventPayload(s as any);
    const json = JSON.stringify(payload);
    return { session: s, json, hash: sha256Hex(json), withId: JSON.stringify({ ...payload, id: `hipno${s.id}` }) };
  });
}

function crypto() {
  const c = new TokenCrypto(KEY);
  const now = Date.now();
  return {
    key: KEY,
    encrypted: [{ plain: '1//0refresh-token-ÁÉ', packed: c.encrypt('1//0refresh-token-ÁÉ') }],
    // valid for 10 years from generation: SessionAPI must accept a state ContractAPI signed (and vice versa)
    state: { uid: 42, value: c.signState(42, 10 * 365 * 24 * 3600 * 1000, now) },
    expiredState: c.signState(42, -1000, now),
  };
}

function names() {
  return ['gabriel', 'MARIA DA SILVA', '  ana-clara   de  souza ', 'JOÃO DOS SANTOS E SILVA', 'de oliveira', "d'avila", 'ÉLLEN', ''].map((n) => ({ in: n, out: properName(n) }));
}

function authUrl() {
  const client = new GoogleCalendarClient({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 's', redirectUri: 'https://api.hipnoticus.com.br/contract-service/google-calendar/oauth/callback' });
  return client.buildAuthUrl('abc.def-_');
}

(async () => {
  const fixtures = {
    generatedBy: 'ContractAPI scripts/characterize-session-domain.ts',
    emails: await emails(),
    events: events(),
    crypto: crypto(),
    names: names(),
    authUrl: authUrl(),
  };
  writeFileSync(process.argv[2], JSON.stringify(fixtures, null, 2) + '\n', 'utf8');
})();
