import { createHash } from 'crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';
import { htmlShell, sendEmail } from './EmailApiClient';
import { Logger } from '../../shared/logger/Logger';
import { properName } from '../../shared/names';

const logger = new Logger('ClientActionsService');

function bad(msg: string): never {
  throw new HttpException({ error: msg }, HttpStatus.BAD_REQUEST);
}

function notFound(what: string): never {
  throw new HttpException({ error: `${what} não encontrado.` }, HttpStatus.NOT_FOUND);
}

/** Templates shorter than this are not real e-mails (most clients.* rows were cut to 30 bytes at some point). */
const MIN_TEMPLATE = 60;

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

export interface AddressInput {
  address: string; number?: string; address2?: string; town?: string; city: string; state: string; zip?: string;
  country?: string; reference?: string;
}

/**
 * Client page actions from ControleWeb clientes_edit.asp: addresses (clientes_enderecos*), Material Hipnótico
 * (clientes_material_hipnotico.asp), the password and Bloqueado fields of the data form (process/clientes_edit.asp).
 */
export class ClientActionsService {
  constructor(
    private readonly db: Sequelize,
    private readonly emailApiBaseUrl: string,
    private readonly therapistEmail = process.env.THERAPIST_EMAIL || 'henrique@hipnoterapia.org',
  ) {}

  private q<T extends object = any>(sql: string, replacements: Record<string, any> = {}): Promise<T[]> {
    return this.db.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  }

  private async customer(id: number) {
    const rows = await this.q<any>(`
      SELECT c.ID AS id, c.CallName AS callName, c.FirstName AS firstName, c.LastName AS lastName, c.Email AS email,
             c.CPFCNPJ AS cpf, CONVERT(varchar(10), c.DateOfBirth, 103) AS dateOfBirth, c.PhoneNumber AS phone,
             c.MainGoal AS mainGoalId, i.Name AS mainGoalName
      FROM tbCustomers c LEFT JOIN tbIssues i ON i.ID = c.MainGoal WHERE c.ID = :id`, { id });
    if (!rows.length) notFound('Cliente');
    return rows[0];
  }

  // ---- addresses ------------------------------------------------------------------------------------------------

  private clean(body: AddressInput) {
    const s = (v: any, n: number) => String(v ?? '').trim().slice(0, n);
    const a = {
      address: s(body?.address, 255), number: s(body?.number, 15), address2: s(body?.address2, 255), town: s(body?.town, 255),
      city: s(body?.city, 255), state: s(body?.state, 255).toUpperCase(), zip: s(body?.zip, 9).replace(/[^\d-]/g, ''),
      country: s(body?.country, 255) || 'Brasil', reference: s(body?.reference, 255),
    };
    // validateCustomerAddressForm (clientes.js): endereço, cidade and UF are required
    if (!a.address || !a.city || !a.state) bad('Endereço, cidade e estado são obrigatórios.');
    if (a.country === 'Brasil' && !UFS.includes(a.state)) bad('Estado (UF) inválido.');
    if (a.zip && a.zip.replace(/\D/g, '').length !== 8) bad('CEP inválido.');
    return a;
  }

  private async address(id: number) {
    const rows = await this.q<any>('SELECT ID AS id, CustomerID AS customerId, CAST(ISNULL(MainAddress, 0) AS bit) AS main FROM tbCustomersAddresses WHERE ID = :id', { id });
    if (!rows.length) notFound('Endereço');
    return rows[0];
  }

  /** clientes_enderecos_add.asp: the first address becomes the main one. */
  async addAddress(customerId: number, body: AddressInput, staffId: number) {
    await this.customer(customerId);
    const a = this.clean(body);
    const [{ n }] = await this.q<any>('SELECT COUNT(*) AS n FROM tbCustomersAddresses WHERE CustomerID = :customerId AND MainAddress = 1', { customerId });
    const rows = await this.q<any>(`
      INSERT INTO tbCustomersAddresses (Address, Address2, Number, Town, City, State, Zip, Country, Reference, CustomerID, MainAddress, Blocked,
                                        DateCreated, DateModified, CreatedBy, ModifiedBy)
      OUTPUT inserted.ID AS id
      VALUES (:address, :address2, :number, :town, :city, :state, :zip, :country, :reference, :customerId, :main, 0, GETDATE(), GETDATE(), :staffId, :staffId)`,
      { ...a, customerId, main: Number(n) === 0 ? 1 : 0, staffId });
    return { id: Number(rows[0].id), main: Number(n) === 0 };
  }

  async updateAddress(id: number, body: AddressInput, staffId: number) {
    await this.address(id);
    const a = this.clean(body);
    await this.db.query(`
      UPDATE tbCustomersAddresses SET Address = :address, Address2 = :address2, Number = :number, Town = :town, City = :city,
             State = :state, Zip = :zip, Country = :country, Reference = :reference, DateModified = GETDATE(), ModifiedBy = :staffId
      WHERE ID = :id`, { replacements: { ...a, id, staffId } });
    return { id };
  }

  /** clientes_enderecos_del.asp: hard delete; when the main address goes, the oldest remaining one takes over. */
  async deleteAddress(id: number) {
    const a = await this.address(id);
    const t = await this.db.transaction();
    try {
      await this.db.query('DELETE FROM tbCustomersAddresses WHERE ID = :id', { replacements: { id }, transaction: t });
      if (a.main) {
        await this.db.query(`
          UPDATE tbCustomersAddresses SET MainAddress = 1 WHERE ID = (SELECT TOP 1 ID FROM tbCustomersAddresses WHERE CustomerID = :cid ORDER BY ID)`,
          { replacements: { cid: a.customerId }, transaction: t });
      }
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
    return { id, deleted: true };
  }

  async setMainAddress(id: number, staffId: number) {
    const a = await this.address(id);
    await this.db.query(`
      UPDATE tbCustomersAddresses SET MainAddress = CASE WHEN ID = :id THEN 1 ELSE 0 END, DateModified = GETDATE(), ModifiedBy = :staffId
      WHERE CustomerID = :cid`, { replacements: { id, cid: a.customerId, staffId } });
    return { id, main: true };
  }

  // ---- Material Hipnótico -----------------------------------------------------------------------------------------

  async materialTemplates() {
    const rows = await this.q<any>(`
      SELECT ID AS id, Name AS name, DATALENGTH(Value) AS length FROM tbConfig WHERE Name LIKE 'clients.%' ORDER BY Name, DateCreated, ID`);
    return rows.map((r) => ({ ...r, length: Number(r.length) || 0, usable: (Number(r.length) || 0) >= MIN_TEMPLATE }));
  }

  /**
   * clientes_material_hipnotico.asp: the tbConfig body with the client markers filled, subject by the .en suffix,
   * sent to the client and a copy to the therapist. The markers come from the database (ControleWeb passed them
   * in the query string and lost the address and package on the way, so those always went out empty).
   */
  async sendMaterial(customerId: number, configId: number) {
    const tpl = await this.q<any>(`SELECT ID AS id, Name AS name, CAST(Value AS varchar(max)) AS value FROM tbConfig WHERE ID = :configId AND Name LIKE 'clients.%'`, { configId });
    if (!tpl.length) notFound('Material');
    const value = String(tpl[0].value || '');
    if (value.length < MIN_TEMPLATE) {
      throw new HttpException({ error: `O conteúdo de '${tpl[0].name}' está vazio ou truncado (${value.length} caracteres). Corrija-o em Configurações antes de enviar.` },
        HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const c = await this.customer(customerId);
    if (!c.email) bad('O cliente não tem e-mail cadastrado.');
    const [addr] = await this.q<any>(`
      SELECT TOP 1 Zip AS zip, Address AS address, Number AS number, Address2 AS address2, Town AS town, City AS city, State AS state, Country AS country
      FROM tbCustomersAddresses WHERE CustomerID = :customerId ORDER BY MainAddress DESC, ID`, { customerId });
    const [pkg] = await this.q<any>(`
      SELECT TOP 1 op.ProductName AS name, o.Total AS total FROM tbOrders o
      LEFT JOIN tbOrdersProducts op ON op.OrderID = o.ID
      WHERE o.CustomerID = :customerId AND o.OrderStatusID = 3 ORDER BY o.ID DESC`, { customerId });
    const name = properName(c.callName || c.firstName) || 'Cliente';
    const marks: Record<string, string> = {
      NOME_CLIENTE: name, EMAIL_CLIENTE: c.email, CPF_CLIENTE: c.cpf || '', DATA_NASCIMENTO_CLIENTE: c.dateOfBirth || '',
      TELEFONE_CLIENTE: c.phone || '',
      CLIENTE_ENDERECO_CEP: addr?.zip || '', CLIENTE_ENDERECO_ENDERECO: addr?.address || '', CLIENTE_ENDERECO_NUMERO: addr?.number || '',
      CLIENTE_ENDERECO_COMPLEMENTO: addr?.address2 || '', CLIENTE_ENDERECO_BAIRRO: addr?.town || '', CLIENTE_ENDERECO_CIDADE: addr?.city || '',
      CLIENTE_ENDERECO_ESTADO: addr?.state || '', CLIENTE_ENDERECO_PAIS: addr?.country || '',
      CLIENTE_OBJETIVO_PRIORITARIO: c.mainGoalName || '',
      CLIENTE_PACOTE_CONTRATADO: pkg?.name || '',
      CLIENTE_PACOTE_VALOR: pkg?.total ? Number(pkg.total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '',
    };
    let body = value;
    for (const [k, v] of Object.entries(marks)) body = body.split(`[${k}]`).join(v);
    body = body.split('[s*o*m*a]').join('+');
    const html = htmlShell(body);
    const subject = tpl[0].name.endsWith('.en') ? 'Hipnoticus :: Hypnotic Material' : 'Hipnoticus :: Material Hipnótico';

    await sendEmail(this.emailApiBaseUrl, { to: c.email, toName: name, subject, content: html });
    await sendEmail(this.emailApiBaseUrl, {
      to: this.therapistEmail, toName: 'Henrique', subject,
      content: html + `<br /><small>* Cópia do terapeuta. E-mail originalmente enviado para: ${c.email}</small>`,
    });
    logger.info(`Material '${tpl[0].name}' sent to customer ${customerId}`);
    return { sent: true, to: c.email, material: tpl[0].name };
  }

  // ---- data form extras ---------------------------------------------------------------------------------------------

  /** process/clientes_edit.asp: the password typed by the therapist, stored as the legacy MD5 hex CustomerAPI checks. */
  async setPassword(customerId: number, password: string, staffId: number) {
    await this.customer(customerId);
    const p = String(password ?? '');
    if (p.length < 6 || p.length > 100) bad('A senha deve ter entre 6 e 100 caracteres.');
    const hash = createHash('md5').update(p, 'utf8').digest('hex');
    await this.db.query('UPDATE tbCustomers SET Password = :hash, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id',
      { replacements: { id: customerId, hash, staffId } });
    return { id: customerId, changed: true };
  }

  async setBlocked(customerId: number, blocked: boolean, staffId: number) {
    await this.customer(customerId);
    await this.db.query('UPDATE tbCustomers SET Blocked = :blocked, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id',
      { replacements: { id: customerId, blocked: blocked ? 1 : 0, staffId } });
    return { id: customerId, blocked };
  }

  /** Session counts per status for the client (the "Tipo de Sessão" selector of clientes_edit.asp). */
  async sessionStatusCounts(customerId: number) {
    return this.q(`
      SELECT ss.ID AS id, ss.Name AS name, ss.Color AS color,
             (SELECT COUNT(*) FROM tbSessions s WHERE s.ClientID = :customerId AND LTRIM(RTRIM(s.Status)) = CAST(ss.ID AS varchar(10))) AS total
      FROM tbSessionsStatus ss ORDER BY total DESC, ss.Name`, { customerId });
  }
}
