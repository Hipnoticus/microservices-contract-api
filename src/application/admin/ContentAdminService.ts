import { HttpException, HttpStatus } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

/**
 * ControleWeb modules 8 Depoimentos, 9 Relatórios, 10 Leads, 13 Produtos and the NFS-e draft removal (15).
 * SQL follows what the ASP pages read and write; deviations are commented where they are made.
 */
function page(q: any) {
  const size = Math.min(Math.max(parseInt(q?.pageSize, 10) || 25, 1), 200);
  const p = Math.max(parseInt(q?.page, 10) || 1, 1);
  return { page: p, size, offset: (p - 1) * size };
}

function bad(msg: string): never {
  throw new HttpException({ error: msg }, HttpStatus.BAD_REQUEST);
}

function notFound(what: string): never {
  throw new HttpException({ error: `${what} não encontrado.` }, HttpStatus.NOT_FOUND);
}

const str = (v: any, n: number) => String(v ?? '').trim().slice(0, n);

/** CharLink.URL in ControleWeb: lower-case ASCII slug of the title. */
export function slug(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
}

function money(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) bad('Valor inválido.');
  return Math.round(n * 100) / 100;
}

export class ContentAdminService {
  constructor(private readonly db: Sequelize) {}

  private q<T extends object = any>(sql: string, replacements: Record<string, any> = {}): Promise<T[]> {
    return this.db.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  }

  // ---- 8 Depoimentos ------------------------------------------------------------------------------------------------

  async testimonials(query: any) {
    const { page: p, size, offset } = page(query);
    const where = ['1 = 1'];
    const rep: any = { offset, size };
    const search = str(query?.search, 100);
    if (search) {
      where.push(`(d.Titulo LIKE :like OR d.ClienteNomeExibicao LIKE :like OR c.FirstName + ' ' + ISNULL(c.LastName, '') LIKE :like)`);
      rep.like = `%${search}%`;
    }
    const w = where.join(' AND ');
    const from = 'FROM tbDepoimentos d LEFT JOIN tbCustomers c ON c.ID = d.ClientID';
    const [{ total }] = await this.q<any>(`SELECT COUNT(*) AS total ${from} WHERE ${w}`, rep);
    const items = await this.q(`
      SELECT d.ID AS id, d.Titulo AS title, d.ClienteNomeExibicao AS displayName, LTRIM(RTRIM(d.ClienteIdade)) AS age,
             d.ClienteOcupacao AS occupation, d.ClienteLocalizacao AS location, d.ClientID AS customerId,
             LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS customerName,
             LEFT(d.Resumo, 220) AS summary, CAST(ISNULL(d.Blocked, 0) AS bit) AS blocked,
             CONVERT(varchar(19), d.DateCreated, 126) AS dateCreated
      ${from} WHERE ${w} ORDER BY d.ID DESC OFFSET :offset ROWS FETCH NEXT :size ROWS ONLY`, rep);
    return { items, total: Number(total), page: p, pageSize: size };
  }

  async testimonial(id: number) {
    const rows = await this.q(`
      SELECT d.ID AS id, d.ClientID AS customerId, LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS customerName,
             d.URL AS url, d.Titulo AS title, d.Resumo AS summary, d.Conteudo AS content, d.Observacoes AS notes,
             d.Maisde100Maneiras AS maisDe100, d.ClienteNomeExibicao AS displayName, LTRIM(RTRIM(d.ClienteIdade)) AS age,
             d.ClienteOcupacao AS occupation, d.ClienteLocalizacao AS location, CAST(ISNULL(d.Blocked, 0) AS bit) AS blocked,
             CONVERT(varchar(19), d.DateCreated, 126) AS dateCreated
      FROM tbDepoimentos d LEFT JOIN tbCustomers c ON c.ID = d.ClientID WHERE d.ID = :id`, { id });
    if (!rows.length) notFound('Depoimento');
    return rows[0];
  }

  /** depoimentos.class.asp AddTestimonial / EditTestimonial; URL is the slug of Título. */
  async saveTestimonial(id: number | null, body: any, staffId: number) {
    const title = str(body?.title, 100);
    if (!title) bad('O título é obrigatório.');
    const customerId = body?.customerId ? parseInt(body.customerId, 10) : null;
    if (customerId) {
      const c = await this.q('SELECT ID FROM tbCustomers WHERE ID = :customerId', { customerId });
      if (!c.length) notFound('Cliente');
    }
    const rep = {
      customerId, url: slug(title), title, summary: str(body?.summary, 100000), content: str(body?.content, 1000000),
      notes: str(body?.notes, 100000), maisDe100: str(body?.maisDe100, 100000), displayName: str(body?.displayName, 60),
      age: str(body?.age, 60), occupation: str(body?.occupation, 60), location: str(body?.location, 60),
      blocked: body?.blocked ? 1 : 0, staffId,
    };
    if (id === null) {
      const rows = await this.q<any>(`
        INSERT INTO tbDepoimentos (ClientID, URL, Titulo, Resumo, Conteudo, Observacoes, Maisde100Maneiras, ClienteNomeExibicao, ClienteIdade,
                                   ClienteOcupacao, ClienteLocalizacao, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
        OUTPUT inserted.ID AS id
        VALUES (:customerId, :url, :title, :summary, :content, :notes, :maisDe100, :displayName, :age, :occupation, :location, :blocked,
                GETDATE(), GETDATE(), :staffId, :staffId)`, rep);
      return { id: Number(rows[0].id) };
    }
    await this.testimonial(id);
    await this.db.query(`
      UPDATE tbDepoimentos SET ClientID = :customerId, URL = :url, Titulo = :title, Resumo = :summary, Conteudo = :content,
             Observacoes = :notes, Maisde100Maneiras = :maisDe100, ClienteNomeExibicao = :displayName, ClienteIdade = :age,
             ClienteOcupacao = :occupation, ClienteLocalizacao = :location, Blocked = :blocked, DateModified = GETDATE(), ModifiedBy = :staffId
      WHERE ID = :id`, { replacements: { ...rep, id } });
    return { id };
  }

  async deleteTestimonial(id: number) {
    await this.testimonial(id);
    await this.db.query('DELETE FROM tbDepoimentos WHERE ID = :id', { replacements: { id } });
    return { id, deleted: true };
  }

  // ---- 10 Leads -----------------------------------------------------------------------------------------------------

  /**
   * ControleWeb lists tbSiteContacts (old site contact and scheduling forms). Contratar now registers leads in
   * tbLeads (LeadController), which ControleWeb never showed; both are listed here with their origin.
   */
  async leads(query: any) {
    const { page: p, size, offset } = page(query);
    const rep: any = { offset, size };
    const filters: string[] = ['1 = 1'];
    const search = str(query?.search, 100);
    if (search) { filters.push('(x.name LIKE :like OR x.email LIKE :like OR x.phone LIKE :like OR x.message LIKE :like)'); rep.like = `%${search}%`; }
    if (query?.source === 'site' || query?.source === 'contratar') { filters.push('x.source = :source'); rep.source = query.source; }
    const union = `(
      SELECT 'site' AS source, ID AS id, Name AS name, Email AS email, PhoneNumber AS phone, ContactType AS type,
             CAST(Message AS varchar(max)) AS message, NULL AS cpf, DateCreated AS created
      FROM tbSiteContacts WHERE ISNULL(Blocked, 0) = 0
      UNION ALL
      SELECT 'contratar', ID, Name, Email, Phone, ISNULL(Source, 'Contratar'), PackageName, CPF, DateCreated
      FROM tbLeads WHERE ISNULL(Blocked, 0) = 0) x`;
    const w = filters.join(' AND ');
    const [{ total }] = await this.q<any>(`SELECT COUNT(*) AS total FROM ${union} WHERE ${w}`, rep);
    const items = await this.q(`
      SELECT x.source, x.id, x.name, x.email, x.phone, x.type, x.message, x.cpf, CONVERT(varchar(19), x.created, 126) AS dateCreated
      FROM ${union} WHERE ${w}
      ORDER BY CASE WHEN x.created IS NULL THEN 1 ELSE 0 END, x.created DESC, x.id DESC
      OFFSET :offset ROWS FETCH NEXT :size ROWS ONLY`, rep);
    return { items, total: Number(total), page: p, pageSize: size };
  }

  async deleteLead(source: string, id: number) {
    const table = source === 'site' ? 'tbSiteContacts' : source === 'contratar' ? 'tbLeads' : bad('Origem inválida.');
    const rows = await this.q(`SELECT ID FROM ${table} WHERE ID = :id`, { id });
    if (!rows.length) notFound('Lead');
    await this.db.query(`DELETE FROM ${table} WHERE ID = :id`, { replacements: { id } });
    return { id, deleted: true };
  }

  // ---- 13 Produtos ------------------------------------------------------------------------------------------------

  async products(query: any) {
    const where = ['1 = 1'];
    const rep: any = {};
    const search = str(query?.search, 100);
    if (search) { where.push('(p.Name LIKE :like OR p.CodProduto LIKE :like)'); rep.like = `%${search}%`; }
    return this.q(`
      SELECT p.ID AS id, p.Name AS name, p.NormalPrice AS normalPrice, p.PromotionalPrice AS promotionalPrice,
             CAST(ISNULL(p.Promotion, 0) AS bit) AS promotion, CAST(ISNULL(p.Release, 0) AS bit) AS release,
             p.Category AS categoryId, cat.Name AS categoryName, p.Brand AS brandId, b.Name AS brandName, p.CodProduto AS code,
             CAST(ISNULL(p.Blocked, 0) AS bit) AS blocked, ISNULL(p.TotalBroughts, 0) AS sold,
             (SELECT COUNT(*) FROM tbOrdersProducts op WHERE op.ProductID = p.ID) AS orders,
             CONVERT(varchar(19), p.DateCreated, 126) AS dateCreated
      FROM tbProducts p LEFT JOIN tbProductsCategories cat ON cat.ID = p.Category LEFT JOIN tbProductsBrands b ON b.ID = p.Brand
      WHERE ${where.join(' AND ')} ORDER BY p.ID`, rep);
  }

  async product(id: number) {
    const rows = await this.q(`
      SELECT ID AS id, Name AS name, Description AS description, NormalPrice AS normalPrice, PromotionalPrice AS promotionalPrice,
             CAST(ISNULL(Promotion, 0) AS bit) AS promotion, CAST(ISNULL(Release, 0) AS bit) AS release, Category AS categoryId,
             Brand AS brandId, CodProduto AS code, CodDistribuidor AS distributorCode, Weight AS weight, ICMS AS icms,
             CAST(ISNULL(Blocked, 0) AS bit) AS blocked
      FROM tbProducts WHERE ID = :id`, { id });
    if (!rows.length) notFound('Produto');
    return rows[0];
  }

  /** produtos_add.asp / produtos_edit.asp core fields. Prices are what Contratar shows (PromotionalPrice when set). */
  async saveProduct(id: number | null, body: any, staffId: number) {
    const name = str(body?.name, 255);
    if (!name) bad('O nome é obrigatório.');
    const normalPrice = money(body?.normalPrice);
    if (normalPrice === null) bad('O preço normal é obrigatório.');
    const icms = body?.icms === '' || body?.icms === null || body?.icms === undefined ? null : parseInt(body.icms, 10);
    const rep = {
      name, description: str(body?.description, 1000000), normalPrice, promotionalPrice: money(body?.promotionalPrice),
      promotion: body?.promotion ? 1 : 0, release: body?.release ? 1 : 0,
      categoryId: body?.categoryId ? parseInt(body.categoryId, 10) : null, brandId: body?.brandId ? parseInt(body.brandId, 10) : null,
      code: str(body?.code, 50), distributorCode: str(body?.distributorCode, 50), weight: str(body?.weight, 40),
      icms: Number.isFinite(icms as number) ? icms : null, blocked: body?.blocked ? 1 : 0, staffId,
    };
    if (id === null) {
      const rows = await this.q<any>(`
        INSERT INTO tbProducts (Name, Description, NormalPrice, PromotionalPrice, Weight, Promotion, Release, Category, Brand, CodProduto,
                                CodDistribuidor, ICMS, TotalBroughts, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
        OUTPUT inserted.ID AS id
        VALUES (:name, :description, :normalPrice, :promotionalPrice, :weight, :promotion, :release, :categoryId, :brandId, :code,
                :distributorCode, :icms, 0, :blocked, GETDATE(), GETDATE(), :staffId, :staffId)`, rep);
      return { id: Number(rows[0].id) };
    }
    await this.product(id);
    await this.db.query(`
      UPDATE tbProducts SET Name = :name, Description = :description, NormalPrice = :normalPrice, PromotionalPrice = :promotionalPrice,
             Weight = :weight, Promotion = :promotion, Release = :release, Category = :categoryId, Brand = :brandId, CodProduto = :code,
             CodDistribuidor = :distributorCode, ICMS = :icms, Blocked = :blocked, DateModified = GETDATE(), ModifiedBy = :staffId
      WHERE ID = :id`, { replacements: { ...rep, id } });
    return { id };
  }

  /**
   * ControleWeb deletes the product and its images. A product that was ever ordered is blocked instead, because
   * tbOrdersProducts and the treatments point at it; Contratar hides blocked products.
   */
  async deleteProduct(id: number, staffId: number) {
    await this.product(id);
    const [{ n }] = await this.q<any>('SELECT COUNT(*) AS n FROM tbOrdersProducts WHERE ProductID = :id', { id });
    if (Number(n) > 0) {
      await this.db.query('UPDATE tbProducts SET Blocked = 1, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id', { replacements: { id, staffId } });
      return { id, blocked: true };
    }
    await this.db.query('DELETE FROM tbProductsImages WHERE ProductID = :id', { replacements: { id } });
    await this.db.query('DELETE FROM tbProducts WHERE ID = :id', { replacements: { id } });
    return { id, deleted: true };
  }

  /** Marcas and Categorias (tbProductsBrands, tbProductsCategories): name and description. */
  async productLookups() {
    const [categories, brands] = await Promise.all([
      this.q('SELECT ID AS id, Name AS name, Description AS description, CAST(ISNULL(Blocked, 0) AS bit) AS blocked FROM tbProductsCategories ORDER BY Name'),
      this.q('SELECT ID AS id, Name AS name, Description AS description, CAST(ISNULL(Blocked, 0) AS bit) AS blocked FROM tbProductsBrands ORDER BY Name'),
    ]);
    return { categories, brands };
  }

  async saveLookup(kind: string, id: number | null, body: any, staffId: number) {
    const table = kind === 'categories' ? 'tbProductsCategories' : kind === 'brands' ? 'tbProductsBrands' : bad('Tipo inválido.');
    const name = str(body?.name, 255);
    if (!name) bad('O nome é obrigatório.');
    const rep = { name, description: str(body?.description, 4000), blocked: body?.blocked ? 1 : 0, staffId };
    if (id === null) {
      const rows = await this.q<any>(`
        INSERT INTO ${table} (Name, Description, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
        OUTPUT inserted.ID AS id VALUES (:name, :description, :blocked, GETDATE(), GETDATE(), :staffId, :staffId)`, rep);
      return { id: Number(rows[0].id) };
    }
    const rows = await this.q(`SELECT ID FROM ${table} WHERE ID = :id`, { id });
    if (!rows.length) notFound('Registro');
    await this.db.query(`UPDATE ${table} SET Name = :name, Description = :description, Blocked = :blocked, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id`,
      { replacements: { ...rep, id } });
    return { id };
  }

  // ---- 9 Relatórios -------------------------------------------------------------------------------------------------

  /**
   * ControleWeb's only report was "Faturamento Mensal por Ano" (ReportViewer pages for 2011-2014 over views that no
   * longer exist). Rebuilt from the live tables: confirmed orders (tbOrders status 3) and paid sessions (tbSessions).
   */
  async monthlyRevenue(year: number) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) bad('Ano inválido.');
    const [orders, sessions, years] = await Promise.all([
      this.q<any>(`
        SELECT MONTH(DateCreated) AS month, COUNT(*) AS orders, ISNULL(SUM(Total), 0) AS ordersTotal
        FROM tbOrders WHERE OrderStatusID = 3 AND YEAR(DateCreated) = :year GROUP BY MONTH(DateCreated)`, { year }),
      this.q<any>(`
        SELECT MONTH(DateBegins) AS month, COUNT(*) AS sessions,
               SUM(CASE WHEN ISNULL(Paid, 0) = 1 THEN 1 ELSE 0 END) AS paidSessions,
               ISNULL(SUM(CASE WHEN ISNULL(Paid, 0) = 1 THEN ISNULL(Value, 0) ELSE 0 END), 0) AS paidTotal,
               COUNT(DISTINCT ClientID) AS customers
        FROM tbSessions WHERE YEAR(DateBegins) = :year GROUP BY MONTH(DateBegins)`, { year }),
      this.q<any>(`
        SELECT y FROM (SELECT DISTINCT YEAR(DateCreated) AS y FROM tbOrders WHERE DateCreated IS NOT NULL
                       UNION SELECT DISTINCT YEAR(DateBegins) FROM tbSessions WHERE DateBegins IS NOT NULL) t
        WHERE y BETWEEN 2000 AND 2100 ORDER BY y DESC`),
    ]);
    const months = Array.from({ length: 12 }, (_, i) => {
      const o = orders.find((r) => Number(r.month) === i + 1) || {};
      const s = sessions.find((r) => Number(r.month) === i + 1) || {};
      return {
        month: i + 1, orders: Number(o.orders || 0), ordersTotal: Number(o.ordersTotal || 0),
        sessions: Number(s.sessions || 0), paidSessions: Number(s.paidSessions || 0), paidTotal: Number(s.paidTotal || 0),
        customers: Number(s.customers || 0),
      };
    });
    const sum = (k: keyof (typeof months)[number]) => months.reduce((a, m) => a + Number(m[k]), 0);
    return {
      year, years: years.map((r) => Number(r.y)), months,
      totals: { orders: sum('orders'), ordersTotal: sum('ordersTotal'), sessions: sum('sessions'), paidSessions: sum('paidSessions'), paidTotal: sum('paidTotal') },
    };
  }

  // ---- 15 NFS-e ---------------------------------------------------------------------------------------------------

  /** nfse_delete.asp: only drafts (Status 1) can go, and they are blocked rather than deleted. */
  async deleteNfseDraft(id: number, staffId: number) {
    const rows = await this.q<any>('SELECT ID, Status FROM tbNFSe WHERE ID = :id AND ISNULL(Blocked, 0) = 0', { id });
    if (!rows.length) notFound('NFS-e');
    if (Number(rows[0].Status) !== 1 && Number(rows[0].Status) !== 5) bad('Apenas rascunhos (ou notas com erro) podem ser excluídos.');
    await this.db.query('UPDATE tbNFSe SET Blocked = 1, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id', { replacements: { id, staffId } });
    return { id, deleted: true };
  }
}
