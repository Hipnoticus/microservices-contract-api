import { HttpException, HttpStatus } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

/**
 * Read models and small writes for the Moses admin area: customers hub, orders, treatments, payment methods,
 * tbConfig and the dashboard. SQL mirrors what ControleWeb reads and writes for the same screens.
 */
function page(q: any): { page: number; size: number; offset: number } {
  const size = Math.min(Math.max(parseInt(q?.pageSize, 10) || 25, 1), 200);
  const p = Math.max(parseInt(q?.page, 10) || 1, 1);
  return { page: p, size, offset: (p - 1) * size };
}

function notFound(what: string): never {
  throw new HttpException({ error: `${what} não encontrado.` }, HttpStatus.NOT_FOUND);
}

export class AdminDataService {
  constructor(private readonly db: Sequelize) {}

  private q<T extends object = any>(sql: string, replacements: Record<string, any> = {}): Promise<T[]> {
    return this.db.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  }

  // ---- customers ------------------------------------------------------------------------------------------------

  async customers(query: any) {
    const { page: p, size, offset } = page(query);
    const search = String(query?.search || '').trim().slice(0, 100);
    const email = String(query?.email || '').trim().slice(0, 255);
    // Digits only count as a CPF/phone search when the text is essentially a number ("punkore8" is not)
    const digits = /^[\d.\-()/\s+]+$/.test(search) && search.replace(/\D/g, '').length >= 3 ? search.replace(/\D/g, '') : '';
    const where: string[] = ['1 = 1'];
    const rep: any = { offset, size };
    if (email) { where.push('LOWER(c.Email) = LOWER(:email)'); rep.email = email; }
    if (search) {
      rep.like = `%${search}%`;
      rep.digits = digits ? `%${digits}%` : '__no_digits__';
      where.push(`(c.FirstName + ' ' + ISNULL(c.LastName, '') LIKE :like OR c.CallName LIKE :like OR c.Email LIKE :like
                   OR c.CPFCNPJ LIKE :digits OR REPLACE(REPLACE(REPLACE(REPLACE(c.PhoneNumber, '(', ''), ')', ''), '-', ''), ' ', '') LIKE :digits
                   OR CAST(c.ID AS varchar(12)) = :search)`);
      rep.search = search;
    }
    if (query?.groupId) { where.push('c.GroupID = :groupId'); rep.groupId = parseInt(query.groupId, 10); }
    const w = where.join(' AND ');
    const [{ total }] = await this.q<any>(`SELECT COUNT(*) AS total FROM tbCustomers c WHERE ${w}`, rep);
    const items = await this.q(`
      SELECT c.ID AS id, c.CallName AS callName, c.FirstName AS firstName, c.LastName AS lastName, c.Email AS email,
             c.CPFCNPJ AS cpf, c.PhoneNumber AS phone, c.GroupID AS groupId, g.Name AS groupName,
             CAST(ISNULL(c.Blocked, 0) AS bit) AS blocked, CONVERT(varchar(19), c.DateCreated, 126) AS dateCreated,
             (SELECT COUNT(*) FROM tbSessions s WHERE s.ClientID = c.ID) AS sessions,
             (SELECT CONVERT(varchar(19), MAX(s.DateBegins), 126) FROM tbSessions s WHERE s.ClientID = c.ID) AS lastSession
      FROM tbCustomers c LEFT JOIN tbCustomersGroups g ON g.ID = c.GroupID
      WHERE ${w}
      ORDER BY c.ID DESC OFFSET :offset ROWS FETCH NEXT :size ROWS ONLY`, rep);
    return { items, total: Number(total), page: p, pageSize: size };
  }

  async customerOverview(id: number) {
    const rows = await this.q(`
      SELECT c.ID AS id, c.CallName AS callName, c.FirstName AS firstName, c.LastName AS lastName, c.Email AS email,
             c.CPFCNPJ AS cpf, c.Sex AS sex, CONVERT(varchar(10), c.DateOfBirth, 126) AS dateOfBirth,
             c.PhoneNumber AS phone, c.PhoneNumber2 AS phone2, c.GroupID AS groupId, g.Name AS groupName,
             c.MainGoal AS mainGoalId, i.Name AS mainGoalName, CAST(ISNULL(c.Blocked, 0) AS bit) AS blocked,
             CAST(ISNULL(c.Newsletter, 0) AS bit) AS newsletter, CAST(ISNULL(c.TestUser, 0) AS bit) AS testUser,
             CONVERT(varchar(19), c.DateCreated, 126) AS dateCreated
      FROM tbCustomers c LEFT JOIN tbCustomersGroups g ON g.ID = c.GroupID LEFT JOIN tbIssues i ON i.ID = c.MainGoal
      WHERE c.ID = :id`, { id });
    if (!rows.length) notFound('Cliente');
    const [addresses, orders, treatments, sessions, reserved] = await Promise.all([
      this.q(`SELECT ID AS id, Address AS address, Number AS number, Address2 AS address2, Town AS town, City AS city,
                     State AS state, Zip AS zip, Country AS country, Reference AS reference, CAST(ISNULL(MainAddress, 0) AS bit) AS main
              FROM tbCustomersAddresses WHERE CustomerID = :id AND ISNULL(Blocked, 0) = 0 ORDER BY MainAddress DESC, ID`, { id }),
      this.q(`SELECT o.ID AS id, o.OrderStatusID AS statusId, os.Name AS statusName, o.Total AS total, o.MainGoal AS mainGoal,
                     fp.Name AS paymentMethod, CONVERT(varchar(19), o.DateCreated, 126) AS dateCreated
              FROM tbOrders o LEFT JOIN tbOrdersStatus os ON os.ID = o.OrderStatusID LEFT JOIN tbFormasPagamento fp ON fp.ID = o.FormaPagamento
              WHERE o.CustomerID = :id ORDER BY o.ID DESC`, { id }),
      this.q(`SELECT t.ID AS id, t.MainGoal AS mainGoalId, i.Name AS goalName, t.SessionsNumber AS sessionsNumber,
                     COALESCE(t.PhaseDefined, t.PhaseDetected, 1) AS phaseId, tp.Name AS phaseName, t.OrderNumber AS orderId,
                     CONVERT(varchar(19), t.DateCreated, 126) AS dateCreated
              FROM tbTreatments t LEFT JOIN tbIssues i ON i.ID = t.MainGoal
              LEFT JOIN tbTreatmentsPhases tp ON tp.ID = COALESCE(t.PhaseDefined, t.PhaseDetected, 1)
              WHERE t.Customer = :id AND ISNULL(t.Blocked, 0) = 0 ORDER BY t.ID DESC`, { id }),
      this.q(`SELECT TOP 200 s.ID AS id, s.Name AS name, CONVERT(varchar(19), s.DateBegins, 126) AS begins,
                     LTRIM(RTRIM(s.Status)) AS status, ss.Name AS statusName, ss.Color AS color,
                     CAST(ISNULL(s.Paid, 0) AS bit) AS paid, CAST(ISNULL(s.FirstSession, 0) AS bit) AS firstSession,
                     CAST(s.Notes AS nvarchar(max)) AS notes
              FROM tbSessions s LEFT JOIN tbSessionsStatus ss ON CAST(ss.ID AS varchar(10)) = LTRIM(RTRIM(s.Status))
              WHERE s.ClientID = :id ORDER BY s.DateBegins DESC`, { id }),
      this.q(`SELECT s.ID AS id, s.Name AS name, CONVERT(varchar(19), s.DateBegins, 126) AS begins, LTRIM(RTRIM(s.Status)) AS status,
                     ss.Name AS statusName, ss.Color AS color, s.OrderNumber AS orderNumber
              FROM tbSchedule s LEFT JOIN tbSessionsStatus ss ON CAST(ss.ID AS varchar(10)) = LTRIM(RTRIM(s.Status))
              WHERE s.ClientID = :id ORDER BY s.DateBegins`, { id }),
    ]);
    return { customer: rows[0], addresses, orders, treatments, sessions, reserved };
  }

  async customerGroups() {
    return this.q('SELECT ID AS id, Name AS name FROM tbCustomersGroups WHERE ISNULL(Blocked, 0) = 0 ORDER BY ID');
  }

  /** Grupo de Acesso (1 = VIP), as clientes_access_group.asp sets it. */
  async setCustomerGroup(id: number, groupId: number, staffId: number) {
    const g = await this.q('SELECT ID FROM tbCustomersGroups WHERE ID = :groupId', { groupId });
    if (!g.length) throw new HttpException({ error: 'Grupo inválido.' }, HttpStatus.BAD_REQUEST);
    await this.ensureCustomer(id);
    await this.db.query('UPDATE tbCustomers SET GroupID = :groupId, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id',
      { replacements: { id, groupId, staffId } });
    return { id, groupId };
  }

  /** Objetivo Prioritário: a tbIssues id, as clientes_objetivo_prioritario.asp stores it. */
  async setCustomerMainGoal(id: number, issueId: number, staffId: number) {
    const i = await this.q('SELECT ID FROM tbIssues WHERE ID = :issueId', { issueId });
    if (!i.length) throw new HttpException({ error: 'Objetivo inválido.' }, HttpStatus.BAD_REQUEST);
    await this.ensureCustomer(id);
    await this.db.query('UPDATE tbCustomers SET MainGoal = :issueId, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id',
      { replacements: { id, issueId, staffId } });
    return { id, mainGoalId: issueId };
  }

  private async ensureCustomer(id: number) {
    const c = await this.q('SELECT ID FROM tbCustomers WHERE ID = :id', { id });
    if (!c.length) notFound('Cliente');
  }

  // ---- orders ---------------------------------------------------------------------------------------------------

  async orders(query: any) {
    const { page: p, size, offset } = page(query);
    const where: string[] = ['1 = 1'];
    const rep: any = { offset, size };
    if (query?.statusId) { where.push('o.OrderStatusID = :statusId'); rep.statusId = parseInt(query.statusId, 10); }
    if (query?.customerId) { where.push('o.CustomerID = :customerId'); rep.customerId = parseInt(query.customerId, 10); }
    const search = String(query?.search || '').trim().slice(0, 100);
    if (search) {
      where.push(`(c.FirstName + ' ' + ISNULL(c.LastName, '') LIKE :like OR o.CustomerEmail LIKE :like OR CAST(o.ID AS varchar(12)) = :search)`);
      rep.like = `%${search}%`; rep.search = search;
    }
    if (query?.from) { where.push('o.DateCreated >= CAST(:from AS date)'); rep.from = String(query.from).slice(0, 10); }
    if (query?.to) { where.push('o.DateCreated < DATEADD(day, 1, CAST(:to AS date))'); rep.to = String(query.to).slice(0, 10); }
    const w = where.join(' AND ');
    const [{ total, sum }] = await this.q<any>(`
      SELECT COUNT(*) AS total, ISNULL(SUM(o.Total), 0) AS sum FROM tbOrders o LEFT JOIN tbCustomers c ON c.ID = o.CustomerID WHERE ${w}`, rep);
    const items = await this.q(`
      SELECT o.ID AS id, o.CustomerID AS customerId, LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS customerName,
             o.CustomerEmail AS customerEmail, o.OrderStatusID AS statusId, os.Name AS statusName, o.Total AS total,
             o.FormaPagamento AS paymentMethodId, fp.Name AS paymentMethod, o.MainGoal AS mainGoal, o.Identifier AS identifier,
             CONVERT(varchar(19), o.DateCreated, 126) AS dateCreated,
             (SELECT COUNT(*) FROM tbSchedule s WHERE s.OrderNumber = o.ID) AS reserved,
             (SELECT COUNT(*) FROM tbSessions s WHERE s.OrderNumber = o.ID) AS confirmed
      FROM tbOrders o
      LEFT JOIN tbCustomers c ON c.ID = o.CustomerID
      LEFT JOIN tbOrdersStatus os ON os.ID = o.OrderStatusID
      LEFT JOIN tbFormasPagamento fp ON fp.ID = o.FormaPagamento
      WHERE ${w}
      ORDER BY o.ID DESC OFFSET :offset ROWS FETCH NEXT :size ROWS ONLY`, rep);
    return { items, total: Number(total), sum: Number(sum), page: p, pageSize: size };
  }

  async orderStatuses() {
    return this.q('SELECT ID AS id, Name AS name FROM tbOrdersStatus WHERE ISNULL(Blocked, 0) = 0 ORDER BY ID');
  }

  /** ControleWeb orders_update_status.asp: a bare status change, no e-mail, no session creation. */
  async setOrderStatus(id: number, statusId: number, staffId: number) {
    const s = await this.q('SELECT ID FROM tbOrdersStatus WHERE ID = :statusId', { statusId });
    if (!s.length) throw new HttpException({ error: 'Status inválido.' }, HttpStatus.BAD_REQUEST);
    const o = await this.q('SELECT ID FROM tbOrders WHERE ID = :id', { id });
    if (!o.length) notFound('Pedido');
    await this.db.query('UPDATE tbOrders SET OrderStatusID = :statusId, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id',
      { replacements: { id, statusId, staffId } });
    return { id, statusId };
  }

  // ---- treatments -----------------------------------------------------------------------------------------------

  async treatments(query: any) {
    const { page: p, size, offset } = page(query);
    const where: string[] = ['ISNULL(t.Blocked, 0) = 0'];
    const rep: any = { offset, size };
    if (query?.customerId) { where.push('t.Customer = :customerId'); rep.customerId = parseInt(query.customerId, 10); }
    if (query?.phaseId) { where.push('COALESCE(t.PhaseDefined, t.PhaseDetected, 1) = :phaseId'); rep.phaseId = parseInt(query.phaseId, 10); }
    const search = String(query?.search || '').trim().slice(0, 100);
    if (search) { where.push(`(c.FirstName + ' ' + ISNULL(c.LastName, '') LIKE :like OR i.Name LIKE :like)`); rep.like = `%${search}%`; }
    const w = where.join(' AND ');
    const from = `FROM tbTreatments t LEFT JOIN tbCustomers c ON c.ID = t.Customer LEFT JOIN tbIssues i ON i.ID = t.MainGoal
                  LEFT JOIN tbTreatmentsPhases tp ON tp.ID = COALESCE(t.PhaseDefined, t.PhaseDetected, 1)`;
    const [{ total }] = await this.q<any>(`SELECT COUNT(*) AS total ${from} WHERE ${w}`, rep);
    const items = await this.q(`
      SELECT t.ID AS id, t.Customer AS customerId, LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS customerName,
             t.MainGoal AS mainGoalId, i.Name AS goalName, t.SessionsNumber AS sessionsNumber,
             COALESCE(t.PhaseDefined, t.PhaseDetected, 1) AS phaseId, tp.Name AS phaseName, t.OrderNumber AS orderId,
             CONVERT(varchar(19), t.DateCreated, 126) AS dateCreated
      ${from} WHERE ${w} ORDER BY t.ID DESC OFFSET :offset ROWS FETCH NEXT :size ROWS ONLY`, rep);
    return { items, total: Number(total), page: p, pageSize: size };
  }

  async treatment(id: number) {
    const rows = await this.q(`
      SELECT t.ID AS id, t.Customer AS customerId, LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS customerName,
             t.MainGoal AS mainGoalId, i.Name AS goalName, t.SessionsNumber AS sessionsNumber, t.PhaseDefined AS phaseDefined,
             t.PhaseDetected AS phaseDetected, t.OrderNumber AS orderId, CONVERT(varchar(19), t.DateCreated, 126) AS dateCreated
      FROM tbTreatments t LEFT JOIN tbCustomers c ON c.ID = t.Customer LEFT JOIN tbIssues i ON i.ID = t.MainGoal
      WHERE t.ID = :id AND ISNULL(t.Blocked, 0) = 0`, { id });
    if (!rows.length) notFound('Tratamento');
    const sessions = await this.q(`
      SELECT s.ID AS id, s.Name AS name, CONVERT(varchar(19), s.DateBegins, 126) AS begins, ss.Name AS statusName, ss.Color AS color,
             CAST(ISNULL(s.Paid, 0) AS bit) AS paid
      FROM tbSessions s LEFT JOIN tbSessionsStatus ss ON CAST(ss.ID AS varchar(10)) = LTRIM(RTRIM(s.Status))
      WHERE COALESCE(s.TreatmentID, s.Treatment) = :id ORDER BY s.DateBegins`, { id });
    return { ...rows[0], sessions };
  }

  async phases() {
    return this.q('SELECT ID AS id, Name AS name FROM tbTreatmentsPhases WHERE ISNULL(Blocked, 0) = 0 ORDER BY ID');
  }

  /**
   * ControleWeb treatments.class.asp: Cliente and Objetivo Principal required, phase chosen by hand, and
   * SessionsNumber recomputed on save (on add from the client's sessions, on edit from the treatment's sessions).
   */
  async saveTreatment(id: number | null, body: any, staffId: number) {
    const customerId = parseInt(body?.customerId, 10);
    const mainGoal = parseInt(body?.mainGoalId, 10);
    const phase = body?.phaseDefined ? parseInt(body.phaseDefined, 10) : null;
    if (!customerId || !mainGoal) throw new HttpException({ error: 'Cliente e Objetivo Principal são obrigatórios.' }, HttpStatus.BAD_REQUEST);
    await this.ensureCustomer(customerId);
    if (id === null) {
      const [{ n }] = await this.q<any>('SELECT COUNT(*) AS n FROM tbSessions WHERE ClientID = :customerId', { customerId });
      const rows = await this.q<any>(`
        INSERT INTO tbTreatments (MainGoal, Customer, PhaseDefined, SessionsNumber, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
        OUTPUT inserted.ID AS id VALUES (:mainGoal, :customerId, :phase, :n, 0, GETDATE(), GETDATE(), :staffId, :staffId)`,
        { mainGoal, customerId, phase, n, staffId });
      return { id: Number(rows[0].id) };
    }
    await this.treatment(id);
    const [{ n }] = await this.q<any>('SELECT COUNT(*) AS n FROM tbSessions WHERE COALESCE(TreatmentID, Treatment) = :id', { id });
    await this.db.query(`UPDATE tbTreatments SET MainGoal = :mainGoal, Customer = :customerId, PhaseDefined = :phase, SessionsNumber = :n,
                           DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id`,
      { replacements: { id, mainGoal, customerId, phase, n, staffId } });
    return { id };
  }

  async deleteTreatment(id: number, staffId: number) {
    await this.treatment(id);
    // Blocked rather than deleted: sessions, orders and questionnaire requests point at the treatment.
    await this.db.query('UPDATE tbTreatments SET Blocked = 1, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id',
      { replacements: { id, staffId } });
    return { removed: true };
  }

  // ---- payment methods (tbFormasPagamento, ControleWeb module 4) --------------------------------------------------

  async paymentMethods() {
    return this.q(`SELECT ID AS id, Name AS name, Description AS description, Parcelas AS installments, IDExt AS idExt,
                          KeyNumber AS keyNumber, CAST(ISNULL(Blocked, 0) AS bit) AS blocked FROM tbFormasPagamento ORDER BY Name`);
  }

  async savePaymentMethod(id: number | null, body: any, staffId: number) {
    const name = String(body?.name || '').trim().slice(0, 100);
    if (!name) throw new HttpException({ error: 'Informe o nome.' }, HttpStatus.BAD_REQUEST);
    const rep = {
      id, name, description: String(body?.description || '').slice(0, 4000), installments: parseInt(body?.installments, 10) || 1,
      idExt: String(body?.idExt || '').slice(0, 100), blocked: body?.blocked ? 1 : 0, staffId,
    };
    if (id === null) {
      const rows = await this.q<any>(`
        INSERT INTO tbFormasPagamento (Name, Description, Parcelas, IDExt, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
        OUTPUT inserted.ID AS id VALUES (:name, :description, :installments, :idExt, :blocked, GETDATE(), GETDATE(), :staffId, :staffId)`, rep);
      return { id: Number(rows[0].id) };
    }
    const found = await this.q('SELECT ID FROM tbFormasPagamento WHERE ID = :id', { id });
    if (!found.length) notFound('Forma de pagamento');
    await this.db.query(`UPDATE tbFormasPagamento SET Name = :name, Description = :description, Parcelas = :installments, IDExt = :idExt,
                           Blocked = :blocked, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id`, { replacements: rep });
    return { id };
  }

  // ---- tbConfig (ControleWeb pseudo-module 9999) -----------------------------------------------------------------

  async configList(query: any) {
    const search = String(query?.search || '').trim().slice(0, 100);
    return this.q(`
      SELECT ID AS id, Name AS name, Type AS type, CAST(ISNULL(Blocked, 0) AS bit) AS blocked,
             LEFT(CAST(Value AS varchar(max)), 160) AS preview, CONVERT(varchar(19), DateModified, 126) AS dateModified
      FROM tbConfig ${search ? 'WHERE Name LIKE :like' : ''} ORDER BY Name`, { like: `%${search}%` });
  }

  async configGet(id: number) {
    const rows = await this.q(`SELECT ID AS id, Name AS name, Type AS type, CAST(Value AS varchar(max)) AS value,
                                      CAST(ISNULL(Blocked, 0) AS bit) AS blocked FROM tbConfig WHERE ID = :id`, { id });
    if (!rows.length) notFound('Configuração');
    return rows[0];
  }

  async configSave(id: number, value: string, staffId: number) {
    await this.configGet(id);
    await this.db.query(`UPDATE tbConfig SET Value = :value, DateModified = GETDATE(), ModifiedBy = CAST(:staffId AS nchar(10)) WHERE ID = :id`,
      { replacements: { id, value: String(value ?? ''), staffId } });
    return { id };
  }

  // ---- dashboard -------------------------------------------------------------------------------------------------

  async dashboard(staffId: number) {
    const [counts] = await this.q<any>(`
      SELECT
        (SELECT COUNT(*) FROM tbSessions WHERE CAST(DateBegins AS date) = CAST(GETDATE() AS date) AND LTRIM(RTRIM(Status)) NOT IN ('5','6','7','8')) AS today,
        (SELECT COUNT(*) FROM tbSessions WHERE DateBegins >= CAST(GETDATE() AS date) AND DateBegins < DATEADD(day, 7, CAST(GETDATE() AS date))
                                           AND LTRIM(RTRIM(Status)) NOT IN ('5','6','7','8')) AS next7,
        (SELECT COUNT(*) FROM tbSessions WHERE YEAR(DateBegins) = YEAR(GETDATE()) AND MONTH(DateBegins) = MONTH(GETDATE())
                                           AND LTRIM(RTRIM(Status)) NOT IN ('5','6','7','8')) AS month,
        (SELECT COUNT(*) FROM tbSchedule WHERE DateBegins >= GETDATE()) AS reserved,
        (SELECT COUNT(*) FROM tbOrders WHERE OrderStatusID = 1 AND DateCreated > DATEADD(day, -30, GETDATE())) AS pendingOrders,
        (SELECT COUNT(*) FROM tbCustomers) AS customers,
        (SELECT COUNT(*) FROM tbCustomers WHERE DateCreated > DATEADD(day, -30, GETDATE())) AS newCustomers,
        (SELECT ISNULL(SUM(Total), 0) FROM tbOrders WHERE OrderStatusID IN (2, 3) AND YEAR(DateCreated) = YEAR(GETDATE())
                                                         AND MONTH(DateCreated) = MONTH(GETDATE())) AS monthRevenue`);
    const upcoming = await this.q(`
      SELECT TOP 8 s.ID AS id, s.Name AS name, s.ClientID AS clientId,
             LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS clientName,
             CONVERT(varchar(19), s.DateBegins, 126) AS begins, ss.Name AS statusName, ss.Color AS color,
             CAST(ISNULL(s.FirstSession, 0) AS bit) AS firstSession
      FROM tbSessions s LEFT JOIN tbCustomers c ON c.ID = s.ClientID
      LEFT JOIN tbSessionsStatus ss ON CAST(ss.ID AS varchar(10)) = LTRIM(RTRIM(s.Status))
      WHERE s.DateBegins >= DATEADD(hour, -1, GETDATE()) AND LTRIM(RTRIM(s.Status)) NOT IN ('5','6','7','8')
        AND s.TherapistUserID = :staffId
      ORDER BY s.DateBegins`, { staffId });
    return { ...counts, monthRevenue: Number(counts.monthRevenue), upcoming };
  }
}
