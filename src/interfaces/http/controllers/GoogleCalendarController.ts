/**
 * GoogleCalendarController — admin endpoints for the one-way agenda -> Google Calendar sync.
 *
 * Auth: these routes are public at the gateway (Google's OAuth callback carries no auth header),
 * so every endpoint enforces its own check:
 *   - oauth/start and the JSON endpoints require a single-use, 5-minute ticket minted by ControleWeb
 *     in tbGoogleCalendarTickets after its own admin login check (`?ticket=` / `X-GCal-Ticket`);
 *   - oauth/callback requires the HMAC-signed, 10-minute `state` produced by oauth/start.
 * Tokens are never logged or returned.
 */
import { Controller, Delete, Get, Headers, HttpException, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IGoogleCalendarClient } from '../../../infrastructure/google/GoogleCalendarClient';
import { TokenCrypto } from '../../../infrastructure/google/TokenCrypto';
import { GCalAccount, IGoogleCalendarRepository } from '../../../infrastructure/persistence/repositories/GoogleCalendarRepository';
import { SyncGoogleCalendarUseCase } from '../../../application/use-cases/SyncGoogleCalendarUseCase';
import { Logger } from '../../../shared/logger/Logger';

const logger = new Logger('GoogleCalendarController');

export const GCAL_NOT_CONFIGURED = 'Integração com Google Agenda não configurada';
const TICKET_INVALID = 'Autorização inválida ou expirada. Recarregue a página e tente novamente.';

export interface GoogleCalendarContext {
  repo: IGoogleCalendarRepository;
  client: IGoogleCalendarClient | null;
  crypto: TokenCrypto | null;
  sync: SyncGoogleCalendarUseCase | null;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function resultPage(title: string, message: string, ok: boolean): string {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:Tahoma,Arial,sans-serif;color:#333;margin:40px auto;max-width:480px;text-align:center}
h1{font-size:20px;color:${ok ? '#2e7d32' : '#c62828'}}p{font-size:14px;line-height:1.5}
button{margin-top:16px;padding:8px 18px;font-size:14px;cursor:pointer}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${message}</p>
<button type="button" onclick="window.close()">Fechar janela</button>
${ok ? '<script>setTimeout(function(){window.close();},4000);</script>' : ''}
</body></html>`;
}

@Controller('google-calendar')
export class GoogleCalendarController {
  constructor(@Inject('GCAL_CONTEXT') private readonly ctx: GoogleCalendarContext) {}

  @Get('oauth/start')
  async oauthStart(@Query('ticket') ticket: string, @Res() res: Response): Promise<void> {
    const userId = await this.ctx.repo.consumeTicket(ticket);
    if (!userId) {
      this.html(res, 401, resultPage('Link expirado', escapeHtml(TICKET_INVALID), false));
      return;
    }
    if (!this.ctx.client || !this.ctx.crypto) {
      this.html(res, 503, resultPage('Google Agenda', escapeHtml(GCAL_NOT_CONFIGURED), false));
      return;
    }
    res.redirect(302, this.ctx.client.buildAuthUrl(this.ctx.crypto.signState(userId)));
  }

  @Get('oauth/callback')
  async oauthCallback(@Query() query: Record<string, string>, @Res() res: Response): Promise<void> {
    const fail = (status: number, reason: string) =>
      this.html(res, status, resultPage('Google Agenda', `Não foi possível conectar a conta Google: ${escapeHtml(reason)}.`, false));

    if (!this.ctx.client || !this.ctx.crypto || !this.ctx.sync) return fail(503, GCAL_NOT_CONFIGURED);
    const state = this.ctx.crypto.verifyState(query.state);
    if (!state) return fail(400, 'a autorização expirou ou é inválida, tente novamente pelo ControleWeb');
    if (query.error) return fail(400, query.error === 'access_denied' ? 'acesso negado na tela do Google' : query.error);
    if (!query.code) return fail(400, 'o Google não retornou o código de autorização');

    try {
      const exchanged = await this.ctx.client.exchangeCode(query.code);
      if (!exchanged.email || !exchanged.emailVerified) return fail(400, 'o e-mail da conta Google não está verificado');
      const enc = exchanged.refreshToken ? this.ctx.crypto.encrypt(exchanged.refreshToken) : null;
      const accountId = await this.ctx.repo.upsertAccount(state.uid, exchanged.email, enc);
      logger.info(`Google account connected: account=${accountId} user=${state.uid}`);
      this.ctx.sync.syncAccount(accountId).catch((e) =>
        logger.warn(`Initial sync of account ${accountId} failed: ${(e as Error).message}`));
      this.html(res, 200, resultPage('Conta conectada',
        `Conta Google ${escapeHtml(exchanged.email)} conectada. A primeira sincronização já começou. Você pode fechar esta janela.`, true));
    } catch (e) {
      logger.warn(`OAuth callback failed: ${(e as Error).message}`);
      fail(502, (e as Error).message || 'erro desconhecido');
    }
  }

  @Get('accounts')
  async listAccounts(@Headers('x-gcal-ticket') ticket: string) {
    const userId = await this.requireTicket(ticket);
    return this.ctx.repo.listAccounts(userId);
  }

  @Post('accounts/:id/sync')
  async syncNow(@Headers('x-gcal-ticket') ticket: string, @Param('id') id: string) {
    const userId = await this.requireTicket(ticket);
    const account = await this.requireOwnAccount(userId, id);
    try {
      return await this.ctx.sync!.syncAccount(account.id);
    } catch (e) {
      throw new HttpException({ error: `Falha na sincronização: ${(e as Error).message}` }, HttpStatus.BAD_GATEWAY);
    }
  }

  @Delete('accounts/:id')
  async disconnect(@Headers('x-gcal-ticket') ticket: string, @Param('id') id: string) {
    const userId = await this.requireTicket(ticket);
    const account = await this.requireOwnAccount(userId, id);
    // Best effort: remove the app calendar and revoke the grant, then forget the account locally.
    try {
      const refreshToken = this.ctx.crypto!.decrypt(account.refreshTokenEnc);
      try {
        if (account.calendarId) {
          const at = await this.ctx.client!.getAccessToken(refreshToken);
          await this.ctx.client!.deleteCalendar(at, account.calendarId);
        }
      } catch (e) {
        logger.warn(`Account ${account.id}: calendar delete skipped: ${(e as Error).message}`);
      }
      await this.ctx.client!.revoke(refreshToken);
    } catch (e) {
      logger.warn(`Account ${account.id}: revoke skipped: ${(e as Error).message}`);
    }
    await this.ctx.repo.deleteAccount(account.id);
    logger.info(`Google account disconnected: account=${account.id} user=${userId}`);
    return { removed: true };
  }

  /** 401 for a missing/invalid/used/expired ticket, then 503 when the OAuth client is not configured. */
  private async requireTicket(ticket: string): Promise<number> {
    const userId = await this.ctx.repo.consumeTicket(ticket);
    if (!userId) throw new HttpException({ error: TICKET_INVALID }, HttpStatus.UNAUTHORIZED);
    if (!this.ctx.client || !this.ctx.crypto || !this.ctx.sync) {
      throw new HttpException({ error: GCAL_NOT_CONFIGURED }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return userId;
  }

  private async requireOwnAccount(userId: number, rawId: string): Promise<GCalAccount> {
    const id = /^\d{1,9}$/.test(rawId || '') ? parseInt(rawId, 10) : NaN;
    const account = Number.isNaN(id) ? null : await this.ctx.repo.getAccount(id);
    if (!account || Number(account.userId) !== userId) {
      throw new HttpException({ error: 'Conta não encontrada' }, HttpStatus.NOT_FOUND);
    }
    return account;
  }

  private html(res: Response, status: number, body: string): void {
    res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }
}
