import { HttpException, HttpStatus } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';
import { Logger } from '../../shared/logger/Logger';
import { properName } from '../../shared/names';

const logger = new Logger('SessionEmailService');

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/** Parts of a 'YYYY-MM-DDTHH:MM:SS' wall-clock string, never through a time zone. */
function parts(wall: string) {
  const [d, t = '00:00:00'] = wall.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  const p = (n: number) => String(n).padStart(2, '0');
  return { weekday: WEEKDAYS[weekday], date: `${p(day)}/${p(m)}/${y}`, time: t.slice(0, 5) };
}

function brl(v: number | null | undefined): string {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * The session confirmation e-mail, as ControleWeb sends it (SessionItem.SendConfirmationEmail):
 * template tbConfig 'sessions.email.confirmation', placeholders [NOME_CLIENTE] [DIA_SEMANA] [DATA_COMPLETA] [HORA]
 * [VALOR_BRUTO] [s*o*m*a], one copy to the therapist marked "* Cópia do Terapeuta" and one to the client, then
 * tbSessions.ConfirmationEmailSent + 1. Sent through EmailAPI with the service X-Internal-Token.
 */
export class SessionEmailService {
  constructor(
    private readonly db: Sequelize,
    private readonly emailApiBaseUrl: string,
    private readonly therapistEmail = process.env.THERAPIST_EMAIL || 'henrique@hipnoterapia.org',
  ) {}

  async sendConfirmation(sessionId: number): Promise<{ sent: boolean; to: string; count: number }> {
    const rows = await this.db.query<any>(`
      SELECT s.ID AS id, c.CallName AS callName, c.FirstName AS firstName, c.Email AS email, s.Value AS value,
             CONVERT(varchar(19), s.DateBegins, 126) AS begins, ISNULL(s.ConfirmationEmailSent, 0) AS sentCount
      FROM tbSessions s INNER JOIN tbCustomers c ON c.ID = s.ClientID WHERE s.ID = :id`,
      { replacements: { id: sessionId }, type: QueryTypes.SELECT });
    if (!rows.length) throw new HttpException({ error: 'Sessão não encontrada.' }, HttpStatus.NOT_FOUND);
    const s = rows[0];
    if (!s.email) throw new HttpException({ error: 'O cliente não tem e-mail cadastrado.' }, HttpStatus.BAD_REQUEST);
    if (!s.begins) throw new HttpException({ error: 'A sessão não tem data.' }, HttpStatus.BAD_REQUEST);

    const tpl = await this.db.query<any>(`SELECT CAST(Value AS varchar(max)) AS value FROM tbConfig WHERE Name = 'sessions.email.confirmation'`,
      { type: QueryTypes.SELECT });
    if (!tpl.length || !tpl[0].value) {
      throw new HttpException({ error: "Modelo 'sessions.email.confirmation' não encontrado em Configurações." }, HttpStatus.UNPROCESSABLE_ENTITY);
    }

    const when = parts(s.begins);
    const name = properName(s.callName || s.firstName) || 'Cliente';
    const body = tpl[0].value
      .replace(/\[NOME_CLIENTE\]/g, name)
      .replace(/\[DIA_SEMANA\]/g, when.weekday)
      .replace(/\[DATA_COMPLETA\]/g, when.date)
      .replace(/\[HORA\]/g, when.time)
      .replace(/\[VALOR_BRUTO\]/g, brl(s.value))
      // "Ver detalhes" opens the session in Moses (login first, then back to it)
      .replace(/\[ID_SESSAO\]/g, String(s.id))
      .replace(/\[s\*o\*m\*a\]/g, '+');
    // EmailAPI wraps every message in the shared Hipnoticus layout (logo, footer, year)
    const html = '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /><title></title></head>'
      + `<body>${body}</body></html>`;
    const subject = `Hipnoticus :: Sessão Agendada para ${when.weekday}, dia ${when.date} às ${when.time}`;

    await this.send(this.therapistEmail, 'Henrique', subject, html + ' * Cópia do Terapeuta');
    await this.send(s.email, name, subject, html);

    await this.db.query('UPDATE tbSessions SET ConfirmationEmailSent = ISNULL(ConfirmationEmailSent, 0) + 1 WHERE ID = :id',
      { replacements: { id: sessionId } });
    logger.info(`Confirmation e-mail for session ${sessionId} sent`);
    return { sent: true, to: s.email, count: Number(s.sentCount) + 1 };
  }

  private async send(to: string, toName: string, subject: string, content: string): Promise<void> {
    const token = process.env.EMAIL_API_TOKEN;
    let res: Response;
    try {
      res = await fetch(`${this.emailApiBaseUrl}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { 'X-Internal-Token': token } : {}) },
        body: JSON.stringify({ from: 'contato@hipnoterapia.org', fromName: 'Hipnoticus', to, toName, replyTo: 'contato@hipnoterapia.org', subject, content }),
      });
    } catch (e) {
      throw new HttpException({ error: `EmailAPI indisponível: ${(e as Error).message}` }, HttpStatus.BAD_GATEWAY);
    }
    if (!res.ok) throw new HttpException({ error: `EmailAPI respondeu ${res.status}.` }, HttpStatus.BAD_GATEWAY);
  }
}
