import { Controller, Headers, HttpException, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';
import { liveKitToken } from '../../../application/video/LiveKitToken';
import { MODULE, verifyCaller } from '../auth/StaffAuth';
import { Logger } from '../../../shared/logger/Logger';

const logger = new Logger('VideoSessionController');

/** Minutes before the start a customer may enter, and after the end the room stays open. */
const EARLY_MIN = 15;
const LATE_MIN = 60;

/** Customer e-mails exempt from the time window (VIDEO_ANYTIME_EMAILS, comma separated; default: the owner's). */
function anytimeEmails(): Set<string> {
  const raw = process.env.VIDEO_ANYTIME_EMAILS ?? 'punkore8@gmail.com,henrique@hipnoterapia.org';
  return new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
}

/**
 * Video room access for a session (tbSessions.ID). The same room, "session-<id>", is joined by the customer from the
 * Moses client area (/agenda/sessao/:id) and by the therapist from the therapist area (/terapeuta/agenda/sessao/:id).
 *
 * Customer: must own the session, it must not be blocked, and it must be within its time window.
 * Staff: needs Sessões (6) or Calendário (7); no time window, so the therapist can open the room early.
 */
@Controller('video/sessions')
export class VideoSessionController {
  constructor(@Inject('DATABASE') private readonly db: Sequelize) {}

  @Post(':id/token')
  async token(@Headers('authorization') auth: string, @Param('id') idParam: string) {
    const caller = verifyCaller(auth);
    if (!caller) throw new HttpException({ error: 'Autenticação necessária.' }, HttpStatus.UNAUTHORIZED);
    const id = parseInt(idParam, 10);
    if (!Number.isFinite(id) || id <= 0) throw new HttpException({ error: 'Sessão inválida.' }, HttpStatus.BAD_REQUEST);

    const rows = await this.db.query<any>(`
      SELECT s.ID AS id, s.ClientID AS clientId, ISNULL(s.Blocked, 0) AS blocked,
             CONVERT(varchar(19), s.DateBegins, 126) AS begins, CONVERT(varchar(19), s.DateEnds, 126) AS ends,
             c.CallName AS callName, c.FirstName AS firstName, c.Email AS email
      FROM tbSessions s LEFT JOIN tbCustomers c ON c.ID = s.ClientID WHERE s.ID = :id`,
      { replacements: { id }, type: QueryTypes.SELECT });
    const s = rows[0];
    if (!s) throw new HttpException({ error: 'Sessão não encontrada.' }, HttpStatus.NOT_FOUND);

    let identity: string;
    let name: string;
    let admin = false;
    if (caller.kind === 'customer') {
      if (Number(s.clientId) !== caller.id) throw new HttpException({ error: 'Sessão não encontrada.' }, HttpStatus.NOT_FOUND);
      if (Number(s.blocked)) throw new HttpException({ error: 'Esta sessão foi cancelada.' }, HttpStatus.FORBIDDEN);
      // The owner's own customer accounts (testing as a client) may enter at any time
      if (!anytimeEmails().has(String(s.email || '').trim().toLowerCase())) this.checkWindow(s.begins, s.ends);
      identity = `customer-${caller.id}`;
      name = s.callName || s.firstName || 'Cliente';
    } else {
      if (![MODULE.SESSOES, MODULE.CALENDARIO].some((m) => caller.user.perms.includes(m))) {
        throw new HttpException({ error: 'Sem permissão para este módulo.' }, HttpStatus.FORBIDDEN);
      }
      identity = `staff-${caller.user.id}`;
      name = caller.user.name || 'Terapeuta';
      admin = true;
    }

    const url = process.env.LIVEKIT_URL || '';
    const key = process.env.LIVEKIT_API_KEY || '';
    const secret = process.env.LIVEKIT_API_SECRET || '';
    if (!url || !key || !secret) {
      throw new HttpException({ error: 'Sala de vídeo indisponível no momento.' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const token = liveKitToken(key, secret, {
      room: `session-${id}`,
      identity,
      name,
      admin,
      ttlSeconds: 3 * 3600,
      metadata: { role: caller.kind === 'customer' ? 'client' : 'therapist', sessionId: id },
    });
    logger.info(`Video token for session ${id} issued to ${identity}`);
    return { url, token, room: `session-${id}`, identity, role: caller.kind === 'customer' ? 'client' : 'therapist' };
  }

  /** Brasília wall-clock times stored without offset (as everywhere in tbSessions). */
  private checkWindow(begins: string | null, ends: string | null): void {
    if (process.env.VIDEO_ANYTIME === 'on') return;
    if (!begins) throw new HttpException({ error: 'A sessão não tem horário.' }, HttpStatus.FORBIDDEN);
    const start = Date.parse(`${begins}-03:00`);
    const endRaw = ends ? Date.parse(`${ends}-03:00`) : NaN;
    const end = Number.isFinite(endRaw) && endRaw > start ? endRaw : start + 50 * 60000;
    const now = Date.now();
    if (now < start - EARLY_MIN * 60000) {
      throw new HttpException({ error: `A sala abre ${EARLY_MIN} minutos antes do horário da sessão.` }, HttpStatus.FORBIDDEN);
    }
    if (now > end + LATE_MIN * 60000) {
      throw new HttpException({ error: 'O horário desta sessão já passou.' }, HttpStatus.FORBIDDEN);
    }
  }
}
