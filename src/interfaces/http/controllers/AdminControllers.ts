import { Body, Controller, Delete, Get, HttpException, HttpStatus, Inject, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { QueryTypes, Sequelize } from 'sequelize';
import { randomBytes } from 'crypto';
import { MODULE, StaffGuard, requireModule, staffOf } from '../auth/StaffAuth';
import { SessionAdminService, SessionInput } from '../../../application/admin/SessionAdminService';
import { SessionEmailService } from '../../../application/admin/SessionEmailService';
import { AdminDataService } from '../../../application/admin/AdminDataService';
import { GoogleCalendarContext } from './GoogleCalendarController';
import { Logger } from '../../../shared/logger/Logger';

const logger = new Logger('AdminControllers');

function id(raw: string): number {
  const n = /^\d{1,9}$/.test(raw || '') ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) throw new HttpException({ error: 'ID inválido.' }, HttpStatus.BAD_REQUEST);
  return n;
}

/**
 * Agenda + Sessões (ControleWeb modules 7 Calendário and 6 Sessões). Reading the agenda needs either; writing needs 6.
 * ?source=schedule addresses tbSchedule (reserved, unpaid) instead of tbSessions.
 */
@ApiTags('Admin')
@Controller('admin')
@UseGuards(StaffGuard(MODULE.SESSOES, MODULE.CALENDARIO))
export class AdminAgendaController {
  constructor(
    @Inject('SESSION_ADMIN') private readonly sessions: SessionAdminService,
    @Inject('SESSION_EMAIL') private readonly email: SessionEmailService,
  ) {}

  @Get('session-statuses') statuses() { return this.sessions.statuses(); }
  @Get('session-payment-types') paymentTypes() { return this.sessions.paymentTypes(); }
  /** Bookable slots from tbConfig schedule.* (see parseSlots). */
  @Get('calendar/slots') async slots() { return { slots: await this.sessions.configuredSlots() }; }

  @Get('calendar')
  calendar(@Query('from') from: string, @Query('to') to: string, @Query('source') source: string, @Query('therapistId') therapistId?: string) {
    return this.sessions.calendar(from, to, source, therapistId ? parseInt(therapistId, 10) : undefined);
  }

  @Get('sessions/:id')
  get(@Param('id') rawId: string, @Query('source') source: string) { return this.sessions.get(id(rawId), source); }

  @Get('customers/:id/treatments')
  customerTreatments(@Param('id') rawId: string) { return this.sessions.customerTreatments(id(rawId)); }

  @Get('calendar/conflicts')
  conflicts(@Query('begins') begins: string, @Query('excludeId') excludeId?: string) {
    return this.sessions.conflicts(begins.replace(' ', 'T'), excludeId ? parseInt(excludeId, 10) : undefined);
  }

  @Post('sessions')
  create(@Req() req: any, @Body() body: SessionInput, @Query('source') source: string) {
    requireModule(staffOf(req), MODULE.SESSOES);
    return this.sessions.create(body, source, staffOf(req).id);
  }

  @Put('sessions/:id')
  update(@Req() req: any, @Param('id') rawId: string, @Body() body: SessionInput, @Query('source') source: string) {
    requireModule(staffOf(req), MODULE.SESSOES);
    return this.sessions.update(id(rawId), body, source, staffOf(req).id);
  }

  @Patch('sessions/:id/content')
  content(@Req() req: any, @Param('id') rawId: string, @Body() body: { content: string }, @Query('source') source: string) {
    requireModule(staffOf(req), MODULE.SESSOES);
    return this.sessions.saveContent(id(rawId), body?.content ?? '', source, staffOf(req).id);
  }

  @Delete('sessions/:id')
  remove(@Req() req: any, @Param('id') rawId: string, @Query('source') source: string) {
    requireModule(staffOf(req), MODULE.SESSOES);
    return this.sessions.remove(id(rawId), source, staffOf(req).id);
  }

  @Post('sessions/:id/confirmation-email')
  confirmationEmail(@Req() req: any, @Param('id') rawId: string) {
    requireModule(staffOf(req), MODULE.SESSOES);
    return this.email.sendConfirmation(id(rawId));
  }

  @Post('schedule/:id/confirm')
  confirmReservation(@Req() req: any, @Param('id') rawId: string, @Body() body: { wholeTreatment?: boolean }) {
    requireModule(staffOf(req), MODULE.SESSOES);
    return this.sessions.confirmReservation(id(rawId), !!body?.wholeTreatment, staffOf(req).id);
  }
}

/** Clientes hub and Pedidos (ControleWeb module 3; orders are reached from the client page there). */
@ApiTags('Admin')
@Controller('admin')
@UseGuards(StaffGuard(MODULE.CLIENTES))
export class AdminCustomerController {
  constructor(@Inject('ADMIN_DATA') private readonly data: AdminDataService) {}

  @Get('customers') customers(@Query() q: any) { return this.data.customers(q); }
  @Get('customer-groups') groups() { return this.data.customerGroups(); }
  @Get('customers/:id/overview') overview(@Param('id') rawId: string) { return this.data.customerOverview(id(rawId)); }

  @Put('customers/:id/group')
  group(@Req() req: any, @Param('id') rawId: string, @Body() body: { groupId: number }) {
    return this.data.setCustomerGroup(id(rawId), parseInt(String(body?.groupId), 10), staffOf(req).id);
  }

  @Put('customers/:id/main-goal')
  mainGoal(@Req() req: any, @Param('id') rawId: string, @Body() body: { issueId: number }) {
    return this.data.setCustomerMainGoal(id(rawId), parseInt(String(body?.issueId), 10), staffOf(req).id);
  }

  @Get('orders') orders(@Query() q: any) { return this.data.orders(q); }
  @Get('order-statuses') orderStatuses() { return this.data.orderStatuses(); }

  @Put('orders/:id/status')
  orderStatus(@Req() req: any, @Param('id') rawId: string, @Body() body: { statusId: number }) {
    return this.data.setOrderStatus(id(rawId), parseInt(String(body?.statusId), 10), staffOf(req).id);
  }
}

/** Tratamentos (ControleWeb module 16). */
@ApiTags('Admin')
@Controller('admin')
@UseGuards(StaffGuard(MODULE.TRATAMENTOS))
export class AdminTreatmentController {
  constructor(@Inject('ADMIN_DATA') private readonly data: AdminDataService) {}

  @Get('treatments') list(@Query() q: any) { return this.data.treatments(q); }
  @Get('treatment-phases') phases() { return this.data.phases(); }
  @Get('treatments/:id') get(@Param('id') rawId: string) { return this.data.treatment(id(rawId)); }
  @Post('treatments') create(@Req() req: any, @Body() body: any) { return this.data.saveTreatment(null, body, staffOf(req).id); }
  @Put('treatments/:id') update(@Req() req: any, @Param('id') rawId: string, @Body() body: any) {
    return this.data.saveTreatment(id(rawId), body, staffOf(req).id);
  }
  @Delete('treatments/:id') remove(@Req() req: any, @Param('id') rawId: string) { return this.data.deleteTreatment(id(rawId), staffOf(req).id); }
}

/** Formas de Pagamento (module 4) and Configurações (pseudo-module 9999). */
@ApiTags('Admin')
@Controller('admin')
@UseGuards(StaffGuard(MODULE.FORMAS_PAGAMENTO, MODULE.CONFIGURACOES))
export class AdminSettingsController {
  constructor(@Inject('ADMIN_DATA') private readonly data: AdminDataService) {}

  @Get('payment-methods')
  paymentMethods(@Req() req: any) { requireModule(staffOf(req), MODULE.FORMAS_PAGAMENTO); return this.data.paymentMethods(); }

  @Post('payment-methods')
  createPm(@Req() req: any, @Body() body: any) {
    requireModule(staffOf(req), MODULE.FORMAS_PAGAMENTO);
    return this.data.savePaymentMethod(null, body, staffOf(req).id);
  }

  @Put('payment-methods/:id')
  updatePm(@Req() req: any, @Param('id') rawId: string, @Body() body: any) {
    requireModule(staffOf(req), MODULE.FORMAS_PAGAMENTO);
    return this.data.savePaymentMethod(id(rawId), body, staffOf(req).id);
  }

  @Get('config')
  config(@Req() req: any, @Query() q: any) { requireModule(staffOf(req), MODULE.CONFIGURACOES); return this.data.configList(q); }

  @Get('config/:id')
  configGet(@Req() req: any, @Param('id') rawId: string) { requireModule(staffOf(req), MODULE.CONFIGURACOES); return this.data.configGet(id(rawId)); }

  @Put('config/:id')
  configSave(@Req() req: any, @Param('id') rawId: string, @Body() body: { value: string }) {
    requireModule(staffOf(req), MODULE.CONFIGURACOES);
    return this.data.configSave(id(rawId), body?.value, staffOf(req).id);
  }
}

/** Dashboard and the Google Calendar panel: any staff member, for their own data. */
@ApiTags('Admin')
@Controller('admin')
@UseGuards(StaffGuard())
export class AdminHomeController {
  constructor(
    @Inject('ADMIN_DATA') private readonly data: AdminDataService,
    @Inject('GCAL_CONTEXT') private readonly gcal: GoogleCalendarContext,
    @Inject('DATABASE') private readonly db: Sequelize,
  ) {}

  @Get('dashboard') dashboard(@Req() req: any) { return this.data.dashboard(staffOf(req).id); }

  @Get('google-calendar/accounts')
  accounts(@Req() req: any) {
    return this.gcal.repo.listAccounts(staffOf(req).id).then((accounts) => ({ configured: !!this.gcal.sync, accounts }));
  }

  /** Single-use 5-minute ticket for the OAuth popup (a top-level navigation cannot carry the Bearer token). */
  @Post('google-calendar/connect-ticket')
  async connectTicket(@Req() req: any) {
    if (!this.gcal.sync) throw new HttpException({ error: 'Google Agenda não configurado no servidor.' }, HttpStatus.SERVICE_UNAVAILABLE);
    const token = randomBytes(32).toString('hex').toUpperCase();
    await this.db.query(`INSERT INTO tbGoogleCalendarTickets (Token, UserID, ExpiresAt) VALUES (:token, :userId, DATEADD(minute, 5, GETDATE()))`,
      { replacements: { token, userId: staffOf(req).id } });
    return { url: `/contract-service/google-calendar/oauth/start?ticket=${token}` };
  }

  @Post('google-calendar/accounts/:id/sync')
  async sync(@Req() req: any, @Param('id') rawId: string) {
    const account = await this.ownAccount(staffOf(req).id, rawId);
    try {
      return await this.gcal.sync!.syncAccount(account.id);
    } catch (e) {
      throw new HttpException({ error: `Falha na sincronização: ${(e as Error).message}` }, HttpStatus.BAD_GATEWAY);
    }
  }

  @Delete('google-calendar/accounts/:id')
  async disconnect(@Req() req: any, @Param('id') rawId: string) {
    const account = await this.ownAccount(staffOf(req).id, rawId);
    try {
      const refreshToken = this.gcal.crypto!.decrypt(account.refreshTokenEnc);
      try {
        if (account.calendarId) {
          const at = await this.gcal.client!.getAccessToken(refreshToken);
          await this.gcal.client!.deleteCalendar(at, account.calendarId);
        }
      } catch (e) { logger.warn(`Account ${account.id}: calendar delete skipped: ${(e as Error).message}`); }
      await this.gcal.client!.revoke(refreshToken);
    } catch (e) { logger.warn(`Account ${account.id}: revoke skipped: ${(e as Error).message}`); }
    await this.gcal.repo.deleteAccount(account.id);
    return { removed: true };
  }

  private async ownAccount(userId: number, rawId: string) {
    if (!this.gcal.client || !this.gcal.crypto || !this.gcal.sync) {
      throw new HttpException({ error: 'Google Agenda não configurado no servidor.' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const account = await this.gcal.repo.getAccount(id(rawId));
    if (!account || Number(account.userId) !== userId) throw new HttpException({ error: 'Conta não encontrada' }, HttpStatus.NOT_FOUND);
    return account;
  }
}

// keep QueryTypes referenced for future raw selects in this module
void QueryTypes;
