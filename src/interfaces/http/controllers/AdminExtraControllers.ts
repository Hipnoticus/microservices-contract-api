import { Body, Controller, Delete, Get, HttpException, HttpStatus, Inject, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MODULE, StaffGuard, requireModule, staffOf } from '../auth/StaffAuth';
import { QuestionnaireAdminService } from '../../../application/admin/QuestionnaireAdminService';
import { ClientActionsService } from '../../../application/admin/ClientActionsService';
import { ContentAdminService } from '../../../application/admin/ContentAdminService';

function id(raw: string): number {
  const n = /^\d{1,9}$/.test(raw || '') ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) throw new HttpException({ error: 'ID inválido.' }, HttpStatus.BAD_REQUEST);
  return n;
}

/**
 * Questionários (module 11). Reading questionnaires and a client's requests and answers, and requesting one for a
 * client, is also open to Clientes (module 3), as on ControleWeb's client page; editing needs 11.
 */
@ApiTags('Admin')
@Controller('admin')
@UseGuards(StaffGuard(MODULE.QUESTIONARIOS, MODULE.CLIENTES))
export class AdminQuestionnaireController {
  constructor(@Inject('QUESTIONNAIRE_ADMIN') private readonly svc: QuestionnaireAdminService) {}

  @Get('questionnaires') list() { return this.svc.questionnaires(); }
  @Get('questionnaires/:id') get(@Param('id') rawId: string) { return this.svc.questionnaire(id(rawId)); }

  @Put('questionnaires/:id')
  save(@Req() req: any, @Param('id') rawId: string, @Body() body: any) {
    requireModule(staffOf(req), MODULE.QUESTIONARIOS);
    return this.svc.saveQuestionnaire(id(rawId), body, staffOf(req).id);
  }

  @Get('questionnaire-statuses') statuses() { return this.svc.statuses(); }

  @Get('questionnaire-requests')
  requests(@Req() req: any, @Query() q: any) {
    // Without module 11 only one client's requests can be listed (the client page)
    if (!q?.customerId) requireModule(staffOf(req), MODULE.QUESTIONARIOS);
    return this.svc.requests(q);
  }

  @Post('questionnaire-requests')
  create(@Req() req: any, @Body() body: { customerId: number; questionnaireId: number }) {
    return this.svc.createRequest(parseInt(String(body?.customerId), 10), parseInt(String(body?.questionnaireId), 10), staffOf(req).id);
  }

  @Get('questionnaire-requests/:id/answers') answers(@Param('id') rawId: string) { return this.svc.answers(id(rawId)); }

  @Put('questionnaire-requests/:id')
  update(@Req() req: any, @Param('id') rawId: string, @Body() body: any) {
    requireModule(staffOf(req), MODULE.QUESTIONARIOS);
    return this.svc.updateRequest(id(rawId), body, staffOf(req).id);
  }

  @Delete('questionnaire-requests/:id')
  remove(@Req() req: any, @Param('id') rawId: string) {
    return this.svc.deleteRequest(id(rawId), staffOf(req).id);
  }
}

/** Client page actions (module 3): addresses, Material Hipnótico, password, Bloqueado. */
@ApiTags('Admin')
@Controller('admin')
@UseGuards(StaffGuard(MODULE.CLIENTES))
export class AdminClientActionsController {
  constructor(@Inject('CLIENT_ACTIONS') private readonly svc: ClientActionsService) {}

  @Post('customers/:id/addresses')
  addAddress(@Req() req: any, @Param('id') rawId: string, @Body() body: any) { return this.svc.addAddress(id(rawId), body, staffOf(req).id); }

  @Put('addresses/:id')
  updateAddress(@Req() req: any, @Param('id') rawId: string, @Body() body: any) { return this.svc.updateAddress(id(rawId), body, staffOf(req).id); }

  @Put('addresses/:id/main')
  mainAddress(@Req() req: any, @Param('id') rawId: string) { return this.svc.setMainAddress(id(rawId), staffOf(req).id); }

  @Delete('addresses/:id')
  deleteAddress(@Param('id') rawId: string) { return this.svc.deleteAddress(id(rawId)); }

  @Get('material-templates') materials() { return this.svc.materialTemplates(); }

  @Post('customers/:id/material')
  material(@Param('id') rawId: string, @Body() body: { configId: number }) {
    return this.svc.sendMaterial(id(rawId), parseInt(String(body?.configId), 10));
  }

  @Put('customers/:id/password')
  password(@Req() req: any, @Param('id') rawId: string, @Body() body: { password: string }) {
    return this.svc.setPassword(id(rawId), body?.password, staffOf(req).id);
  }

  @Put('customers/:id/blocked')
  blocked(@Req() req: any, @Param('id') rawId: string, @Body() body: { blocked: boolean }) {
    return this.svc.setBlocked(id(rawId), !!body?.blocked, staffOf(req).id);
  }

  @Get('customers/:id/session-status-counts')
  statusCounts(@Param('id') rawId: string) { return this.svc.sessionStatusCounts(id(rawId)); }
}

/** Depoimentos (8), Relatórios (9), Leads (10), Produtos (13) and NFS-e draft removal (15). */
@ApiTags('Admin')
@Controller('admin')
@UseGuards(StaffGuard(MODULE.DEPOIMENTOS, MODULE.RELATORIOS, MODULE.LEADS, MODULE.PRODUTOS, MODULE.NFSE))
export class AdminContentController {
  constructor(@Inject('CONTENT_ADMIN') private readonly svc: ContentAdminService) {}

  // ---- Depoimentos
  @Get('testimonials') testimonials(@Req() req: any, @Query() q: any) { requireModule(staffOf(req), MODULE.DEPOIMENTOS); return this.svc.testimonials(q); }
  @Get('testimonials/:id') testimonial(@Req() req: any, @Param('id') rawId: string) { requireModule(staffOf(req), MODULE.DEPOIMENTOS); return this.svc.testimonial(id(rawId)); }
  @Post('testimonials') createTestimonial(@Req() req: any, @Body() body: any) {
    requireModule(staffOf(req), MODULE.DEPOIMENTOS); return this.svc.saveTestimonial(null, body, staffOf(req).id);
  }
  @Put('testimonials/:id') updateTestimonial(@Req() req: any, @Param('id') rawId: string, @Body() body: any) {
    requireModule(staffOf(req), MODULE.DEPOIMENTOS); return this.svc.saveTestimonial(id(rawId), body, staffOf(req).id);
  }
  @Delete('testimonials/:id') deleteTestimonial(@Req() req: any, @Param('id') rawId: string) {
    requireModule(staffOf(req), MODULE.DEPOIMENTOS); return this.svc.deleteTestimonial(id(rawId));
  }

  // ---- Leads
  @Get('leads') leads(@Req() req: any, @Query() q: any) { requireModule(staffOf(req), MODULE.LEADS); return this.svc.leads(q); }
  @Delete('leads/:source/:id') deleteLead(@Req() req: any, @Param('source') source: string, @Param('id') rawId: string) {
    requireModule(staffOf(req), MODULE.LEADS); return this.svc.deleteLead(source, id(rawId));
  }

  // ---- Produtos
  @Get('products') products(@Req() req: any, @Query() q: any) { requireModule(staffOf(req), MODULE.PRODUTOS); return this.svc.products(q); }
  @Get('product-lookups') lookups(@Req() req: any) { requireModule(staffOf(req), MODULE.PRODUTOS); return this.svc.productLookups(); }
  @Get('products/:id') product(@Req() req: any, @Param('id') rawId: string) { requireModule(staffOf(req), MODULE.PRODUTOS); return this.svc.product(id(rawId)); }
  @Post('products') createProduct(@Req() req: any, @Body() body: any) {
    requireModule(staffOf(req), MODULE.PRODUTOS); return this.svc.saveProduct(null, body, staffOf(req).id);
  }
  @Put('products/:id') updateProduct(@Req() req: any, @Param('id') rawId: string, @Body() body: any) {
    requireModule(staffOf(req), MODULE.PRODUTOS); return this.svc.saveProduct(id(rawId), body, staffOf(req).id);
  }
  @Delete('products/:id') deleteProduct(@Req() req: any, @Param('id') rawId: string) {
    requireModule(staffOf(req), MODULE.PRODUTOS); return this.svc.deleteProduct(id(rawId), staffOf(req).id);
  }
  @Post('product-lookups/:kind') createLookup(@Req() req: any, @Param('kind') kind: string, @Body() body: any) {
    requireModule(staffOf(req), MODULE.PRODUTOS); return this.svc.saveLookup(kind, null, body, staffOf(req).id);
  }
  @Put('product-lookups/:kind/:id') updateLookup(@Req() req: any, @Param('kind') kind: string, @Param('id') rawId: string, @Body() body: any) {
    requireModule(staffOf(req), MODULE.PRODUTOS); return this.svc.saveLookup(kind, id(rawId), body, staffOf(req).id);
  }

  // ---- Relatórios
  @Get('reports/monthly-revenue') revenue(@Req() req: any, @Query('year') year: string) {
    requireModule(staffOf(req), MODULE.RELATORIOS);
    return this.svc.monthlyRevenue(parseInt(year || String(new Date().getFullYear()), 10));
  }

  // ---- NFS-e
  @Delete('nfse/:id') deleteNfse(@Req() req: any, @Param('id') rawId: string) {
    requireModule(staffOf(req), MODULE.NFSE); return this.svc.deleteNfseDraft(id(rawId), staffOf(req).id);
  }
}
