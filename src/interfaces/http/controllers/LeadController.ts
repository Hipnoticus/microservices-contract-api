import { Controller, Post, Body, Inject, Req, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Sequelize, QueryTypes } from 'sequelize';
import { Logger } from '../../../shared/logger/Logger';
import { validateLead, type Lead } from '../../../application/order/SignupValidation';
import { clientIp } from '../ClientIp';
import { leadRateLimiter } from '../RateLimiter';
import { verifyStaffToken } from '../auth/StaffAuth';
import { requireTurnstile, TURNSTILE_BODY_FIELD } from '../Turnstile';

const logger = new Logger('LeadController');

/**
 * Interspire Email Marketer integration.
 * Registers unlogged visitors as subscribers on the mailing list
 * at https://email.hipnoterapia.org/xml.php
 *
 * Public (the first Contratar step in Moses), so it is rate limited per IP (LEAD_RATE_LIMIT_PER_HOUR) and the body
 * is validated (full name, a permanent e-mail, valid phone/CPF when sent). The Interspire API credentials come from
 * the environment: INTERSPIRE_USERNAME, INTERSPIRE_TOKEN (zeus .env.prod; dev: untracked secrets/interspire.env).
 * Without a token the lead is still stored in tbLeads and Interspire is skipped.
 *
 * Cloudflare Turnstile (same verifier as POST /orders): Moses renders its own widget on the lead form, because a
 * token works once and cannot be shared with the Pagamento step, and sends it as body.turnstileToken. It is checked
 * with the client IP and fails closed in production; it is stripped before the lead is stored or sent to Interspire.
 * A verified staff token skips the rate limit and Turnstile; a customer token does not.
 *
 * Custom field IDs (from ListCILog.txt):
 *   26 = Nome Completo
 *    2 = Primeiro Nome
 *    3 = Último Nome
 *   44 = Nome (alias)
 *   19 = Nome (alias 2)
 *    4 = Telefone
 *   21 = CPF
 */
@ApiTags('Leads')
@Controller('leads')
export class LeadController {
  private readonly interspireUrl = process.env.INTERSPIRE_URL || 'https://email.hipnoterapia.org/xml.php';
  private readonly interspireUsername = process.env.INTERSPIRE_USERNAME || 'henrique';
  private readonly interspireToken = (process.env.INTERSPIRE_TOKEN || '').trim();
  private readonly mailingListId = process.env.INTERSPIRE_LEADS_LIST_ID || '26'; // Probable clients list
  private warnedNoToken = false;

  constructor(@Inject('DATABASE') private readonly db: Sequelize) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a lead (unlogged visitor) to Interspire Email Marketer (public, validated, rate limited per IP)' })
  async registerLead(@Body() body: any, @Req() req: any) {
    // The Turnstile token is not lead data: keep it out of tbLeads and Interspire.
    const { [TURNSTILE_BODY_FIELD]: turnstileToken, ...lead } = (body && typeof body === 'object' ? body : {}) as any;
    if (!verifyStaffToken(req?.headers?.authorization)) {
      const ip = clientIp(req);
      leadRateLimiter.check(ip, 'cadastro');
      // Before validation, so an unverified caller learns nothing about what the validator accepts.
      await requireTurnstile(turnstileToken, ip, 'POST /leads/register');
    }
    const v = validateLead(lead);
    if (!v.ok) throw new HttpException({ success: false, error: v.error }, HttpStatus.BAD_REQUEST);
    const { name, email, phone, cpf, packageName } = v.lead;

    const nameParts = name.split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // 1. Register on Interspire Email Marketer
    if (!this.interspireToken) {
      if (!this.warnedNoToken) {
        logger.warn('INTERSPIRE_TOKEN is not set: leads are stored in tbLeads but not sent to Interspire');
        this.warnedNoToken = true;
      }
    } else {
      try {
        const xml = this.buildInterspireXml(email, name, firstName, lastName, phone, cpf);
        const response = await fetch(this.interspireUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/xml' },
          body: xml,
          signal: AbortSignal.timeout(15000),
        });
        const responseText = await response.text();
        const success = responseText.includes('<status>SUCCESS</status>');
        const alreadyExists = responseText.includes('already exists');
        if (success || alreadyExists) {
          logger.info(`Lead registered on Interspire: ${email} (${success ? 'new' : 'already existed'})`);
        } else {
          logger.warn(`Interspire registration issue for ${email}: ${responseText.substring(0, 200)}`);
        }
      } catch (err: any) {
        logger.error(`Interspire API error: ${err.message}`);
        // Non-blocking — continue even if Interspire is down
      }
    }

    // 2. Log the lead in the local database for tracking
    await this.storeLead({ name, email, phone, cpf, packageName });

    return { success: true };
  }

  private async storeLead(lead: Lead): Promise<void> {
    try {
      // Check if tbLeads exists, create if not
      await this.db.query(`
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tbLeads')
        BEGIN
          CREATE TABLE tbLeads (
            ID INT IDENTITY(1,1) PRIMARY KEY,
            Name NVARCHAR(200) NOT NULL,
            Email NVARCHAR(200) NOT NULL,
            Phone NVARCHAR(50) NULL,
            CPF NVARCHAR(14) NULL,
            PackageName NVARCHAR(200) NULL,
            Source NVARCHAR(50) DEFAULT 'moses',
            DateCreated DATETIME DEFAULT GETDATE()
          );
          CREATE INDEX IX_Leads_Email ON tbLeads(Email);
        END
      `);
      await this.db.query(
        `INSERT INTO tbLeads (Name, Email, Phone, CPF, PackageName) VALUES (:name, :email, :phone, :cpf, :pkg)`,
        {
          replacements: { name: lead.name, email: lead.email, phone: lead.phone || null, cpf: lead.cpf || null, pkg: lead.packageName || null },
          type: QueryTypes.INSERT,
        },
      );
    } catch (err: any) {
      logger.warn(`Failed to log lead locally: ${err.message}`);
    }
  }

  private buildInterspireXml(email: string, fullName: string, firstName: string, lastName: string, phone: string, cpf: string): string {
    return `<xmlrequest>
  <username>${this.escapeXml(this.interspireUsername)}</username>
  <usertoken>${this.escapeXml(this.interspireToken)}</usertoken>
  <requesttype>subscribers</requesttype>
  <requestmethod>AddSubscriberToList</requestmethod>
  <details>
    <emailaddress>${this.escapeXml(email)}</emailaddress>
    <mailinglist>${this.escapeXml(this.mailingListId)}</mailinglist>
    <format>html</format>
    <confirmed>yes</confirmed>
    <customfields>
      <item><fieldid>26</fieldid><value>${this.escapeXml(fullName)}</value></item>
      <item><fieldid>2</fieldid><value>${this.escapeXml(firstName)}</value></item>
      <item><fieldid>3</fieldid><value>${this.escapeXml(lastName)}</value></item>
      <item><fieldid>44</fieldid><value>${this.escapeXml(firstName)}</value></item>
      <item><fieldid>19</fieldid><value>${this.escapeXml(firstName)}</value></item>
      <item><fieldid>4</fieldid><value>${this.escapeXml(phone)}</value></item>
      <item><fieldid>21</fieldid><value>${this.escapeXml(cpf)}</value></item>
    </customfields>
  </details>
</xmlrequest>`;
  }

  private escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
}
