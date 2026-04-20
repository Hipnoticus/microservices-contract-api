import { Controller, Post, Body, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Sequelize, QueryTypes } from 'sequelize';
import { Logger } from '../../../shared/logger/Logger';

const logger = new Logger('LeadController');

/**
 * Interspire Email Marketer integration.
 * Registers unlogged visitors as subscribers on the mailing list
 * at https://email.hipnoterapia.org/xml.php
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
  private readonly interspireUrl = 'https://email.hipnoterapia.org/xml.php';
  private readonly interspireUsername = 'henrique';
  private readonly interspireToken = '6786356436b7b4909106613bbd0c4203c06d9d56';
  private readonly mailingListId = '26'; // Probable clients list

  constructor(@Inject('DATABASE') private readonly db: Sequelize) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a lead (unlogged visitor) to Interspire Email Marketer' })
  async registerLead(@Body() body: { name: string; email: string; phone?: string; cpf?: string; packageName?: string }) {
    const { name, email, phone, cpf, packageName } = body;

    if (!name || !email) {
      return { success: false, error: 'Nome e e-mail são obrigatórios.' };
    }

    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // 1. Register on Interspire Email Marketer
    try {
      const xml = this.buildInterspireXml(email, name, firstName, lastName, phone || '', cpf || '');
      const response = await fetch(this.interspireUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: xml,
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

    // 2. Optionally log the lead in the local database for tracking
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
        { replacements: { name, email, phone: phone || null, cpf: cpf || null, pkg: packageName || null }, type: QueryTypes.INSERT },
      );
    } catch (err: any) {
      logger.warn(`Failed to log lead locally: ${err.message}`);
    }

    return { success: true };
  }

  private buildInterspireXml(email: string, fullName: string, firstName: string, lastName: string, phone: string, cpf: string): string {
    return `<xmlrequest>
  <username>${this.interspireUsername}</username>
  <usertoken>${this.interspireToken}</usertoken>
  <requesttype>subscribers</requesttype>
  <requestmethod>AddSubscriberToList</requestmethod>
  <details>
    <emailaddress>${this.escapeXml(email)}</emailaddress>
    <mailinglist>${this.mailingListId}</mailinglist>
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
