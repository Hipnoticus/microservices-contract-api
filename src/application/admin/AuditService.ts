import { HttpException, HttpStatus } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('AuditService');

/**
 * Activity log (ControleWeb's "Logs", pseudo-module -1, which was never built). The gateway sees every request and
 * posts one entry per audited request to POST /internal/audit; this stores them in tbAuditLog and serves the
 * Moses Logs page. Request bodies are never stored (passwords, card data).
 */
export interface AuditEntry {
  ts?: string;
  method: string;
  path: string;
  query?: string;
  status?: number;
  durationMs?: number;
  actorType?: string;
  actorId?: string | number | null;
  actorName?: string;
  actorEmail?: string;
  ip?: string;
  userAgent?: string;
  outcome?: string;
}

const s = (v: any, n: number) => (v === null || v === undefined ? null : String(v).slice(0, n));

/** The client the request is about, when the path names one (e.g. /admin/customers/43/..., /orders/customer/43). */
export function subjectCustomer(path: string, query: string, actorType: string, actorId: number | null): number | null {
  const m = path.match(/\/(?:customers?|clientes?|clientId|customerId)\/(\d{1,9})(?:\/|$)/i)
    || (query || '').match(/(?:^|&)(?:customerId|clientId|customer)=(\d{1,9})(?:&|$)/i);
  if (m) return parseInt(m[1], 10);
  return actorType === 'customer' && actorId ? actorId : null;
}

/** tbConfig key holding how many years of log are kept. Missing or empty = kept indefinitely (the default). */
export const RETENTION_KEY = 'audit.retention.years';
const MAX_YEARS = 100;

export class AuditService {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Sequelize) {}

  /** Creates tbAuditLog the first time (dev and prod stay in step without a manual migration). */
  ensureTable(): Promise<void> {
    if (!this.ready) {
      this.ready = this.db.query(`
        IF OBJECT_ID('dbo.tbAuditLog', 'U') IS NULL
        BEGIN
          CREATE TABLE dbo.tbAuditLog (
            ID bigint IDENTITY(1,1) NOT NULL PRIMARY KEY,
            DateCreated datetime2(3) NOT NULL CONSTRAINT DF_tbAuditLog_DateCreated DEFAULT SYSDATETIME(),
            Method varchar(10) NOT NULL,
            Path nvarchar(500) NOT NULL,
            Query nvarchar(500) NULL,
            Status int NULL,
            DurationMs int NULL,
            Outcome varchar(20) NULL,
            ActorType varchar(10) NOT NULL,
            ActorID int NULL,
            ActorName nvarchar(200) NULL,
            ActorEmail nvarchar(200) NULL,
            SubjectCustomerID int NULL,
            Service varchar(60) NULL,
            IP varchar(64) NULL,
            UserAgent nvarchar(300) NULL
          );
          CREATE INDEX IX_tbAuditLog_DateCreated ON dbo.tbAuditLog (DateCreated DESC);
          CREATE INDEX IX_tbAuditLog_Actor ON dbo.tbAuditLog (ActorType, ActorID, DateCreated DESC);
          CREATE INDEX IX_tbAuditLog_Subject ON dbo.tbAuditLog (SubjectCustomerID, DateCreated DESC);
        END`).then(() => undefined).catch((e) => { this.ready = null; throw e; });
    }
    return this.ready;
  }

  async record(entries: AuditEntry[]): Promise<{ stored: number }> {
    if (!Array.isArray(entries) || !entries.length) return { stored: 0 };
    if (entries.length > 500) throw new HttpException({ error: 'Lote grande demais.' }, HttpStatus.PAYLOAD_TOO_LARGE);
    await this.ensureTable();
    const rows = entries.filter((e) => e && e.method && e.path).map((e) => {
      const actorType = ['customer', 'user', 'service', 'guest', 'anonymous'].includes(String(e.actorType)) ? String(e.actorType) : 'anonymous';
      const actorId = /^-?\d{1,10}$/.test(String(e.actorId ?? '')) ? Number(e.actorId) : null;
      const path = String(e.path).slice(0, 500);
      const query = s(e.query, 500) || '';
      const ts = e.ts && !Number.isNaN(Date.parse(e.ts)) ? new Date(e.ts) : new Date();
      return {
        ts, method: String(e.method).toUpperCase().slice(0, 10), path, query: query || null,
        status: Number.isFinite(Number(e.status)) ? Number(e.status) : null,
        durationMs: Number.isFinite(Number(e.durationMs)) ? Math.min(Number(e.durationMs), 2_000_000_000) : null,
        outcome: s(e.outcome, 20), actorType, actorId: actorId !== null && Math.abs(actorId) <= 2147483647 ? actorId : null,
        actorName: s(e.actorName, 200), actorEmail: s(e.actorEmail, 200),
        subject: subjectCustomer(path, query, actorType, actorId),
        service: s(path.split('/')[1] || '', 60), ip: s(e.ip, 64), userAgent: s(e.userAgent, 300),
      };
    });
    // One multi-row INSERT per chunk (SQL Server allows 2100 parameters: 16 columns x 100 rows)
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const rep: Record<string, any> = {};
      const values = chunk.map((r, j) => {
        const keys = ['ts', 'method', 'path', 'query', 'status', 'durationMs', 'outcome', 'actorType', 'actorId', 'actorName', 'actorEmail', 'subject', 'service', 'ip', 'userAgent'];
        keys.forEach((k) => { rep[`${k}${j}`] = (r as any)[k]; });
        return `(${keys.map((k) => `:${k}${j}`).join(', ')})`;
      });
      await this.db.query(`
        INSERT INTO tbAuditLog (DateCreated, Method, Path, Query, Status, DurationMs, Outcome, ActorType, ActorID, ActorName, ActorEmail,
                                SubjectCustomerID, Service, IP, UserAgent)
        VALUES ${values.join(', ')}`, { replacements: rep });
    }
    return { stored: rows.length };
  }

  // ---- retention (chosen in the Logs page; nothing is deleted unless a number of years is set) --------------------

  /** Years kept, or null for indefinitely. */
  async retentionYears(): Promise<number | null> {
    const rows = await this.db.query<any>(`SELECT TOP 1 CAST(Value AS varchar(20)) AS v FROM tbConfig WHERE Name = :name ORDER BY ID`,
      { replacements: { name: RETENTION_KEY }, type: QueryTypes.SELECT });
    const n = parseInt(String(rows[0]?.v ?? '').trim(), 10);
    return Number.isInteger(n) && n >= 1 && n <= MAX_YEARS ? n : null;
  }

  async retention() {
    await this.ensureTable();
    const years = await this.retentionYears();
    const [stats] = await this.db.query<any>(`
      SELECT COUNT_BIG(*) AS total, CONVERT(varchar(19), MIN(DateCreated), 126) AS oldest FROM tbAuditLog`, { type: QueryTypes.SELECT });
    return { years, total: Number(stats?.total || 0), oldest: stats?.oldest || null };
  }

  /** How many entries a given retention would delete now. */
  async olderThan(years: number): Promise<number> {
    await this.ensureTable();
    const [r] = await this.db.query<any>('SELECT COUNT_BIG(*) AS n FROM tbAuditLog WHERE DateCreated < DATEADD(year, 0 - :years, SYSDATETIME())',
      { replacements: { years }, type: QueryTypes.SELECT });
    return Number(r?.n || 0);
  }

  static parseYears(raw: unknown): number | null {
    if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') return null;
    const s = String(raw).trim();
    if (!/^\d{1,3}$/.test(s)) throw new HttpException({ error: 'Informe um número inteiro de anos (ou indefinido).' }, HttpStatus.BAD_REQUEST);
    const n = parseInt(s, 10);
    if (n < 1 || n > MAX_YEARS) throw new HttpException({ error: `O período deve ser de 1 a ${MAX_YEARS} anos.` }, HttpStatus.BAD_REQUEST);
    return n;
  }

  async setRetention(raw: unknown, staffId: number) {
    const years = AuditService.parseYears(raw);
    const value = years === null ? '' : String(years);
    const exists = await this.db.query<any>('SELECT ID FROM tbConfig WHERE Name = :name', { replacements: { name: RETENTION_KEY }, type: QueryTypes.SELECT });
    if (exists.length) {
      await this.db.query('UPDATE tbConfig SET Value = :value, DateModified = GETDATE(), ModifiedBy = :staff WHERE Name = :name',
        { replacements: { name: RETENTION_KEY, value, staff: String(staffId) } });
    } else {
      await this.db.query(`
        INSERT INTO tbConfig (Name, Value, Type, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
        VALUES (:name, :value, 'Texto', 0, GETDATE(), GETDATE(), :staff, :staff)`,
        { replacements: { name: RETENTION_KEY, value, staff: String(staffId) } });
    }
    const deleted = years === null ? 0 : await this.prune();
    return { years, deleted };
  }

  /** Deletes what is older than the chosen retention; nothing when it is indefinite. Returns how many went. */
  async prune(): Promise<number> {
    await this.ensureTable();
    const years = await this.retentionYears();
    if (years === null) return 0;
    const total = await this.olderThan(years);
    // In batches, so a first run over a large table does not hold one long lock
    for (let i = 0; i < 500 && (await this.olderThan(years)) > 0; i++) {
      await this.db.query('DELETE TOP (20000) FROM tbAuditLog WHERE DateCreated < DATEADD(year, 0 - :years, SYSDATETIME())',
        { replacements: { years } });
    }
    if (total) logger.info(`Audit retention ${years} year(s): ${total} entries deleted`);
    return total;
  }

  /** Daily check of the retention chosen in the Logs page. */
  startPruning() {
    const run = () => this.prune().catch((e) => logger.warn(`Audit prune failed: ${(e as Error).message}`));
    setTimeout(run, 60_000).unref?.();
    setInterval(run, 24 * 3600_000).unref?.();
  }

  async list(query: any) {
    await this.ensureTable();
    const size = Math.min(Math.max(parseInt(query?.pageSize, 10) || 50, 1), 200);
    const p = Math.max(parseInt(query?.page, 10) || 1, 1);
    const where: string[] = ['1 = 1'];
    const rep: any = { offset: (p - 1) * size, size };
    if (query?.from) { where.push('a.DateCreated >= CAST(:from AS date)'); rep.from = String(query.from).slice(0, 10); }
    if (query?.to) { where.push('a.DateCreated < DATEADD(day, 1, CAST(:to AS date))'); rep.to = String(query.to).slice(0, 10); }
    if (query?.actorType) { where.push('a.ActorType = :actorType'); rep.actorType = String(query.actorType).slice(0, 10); }
    if (query?.actorId) { where.push('a.ActorID = :actorId'); rep.actorId = parseInt(query.actorId, 10); }
    if (query?.customerId) {
      // Everything about the client: what they did and what was done to their data
      where.push(`(a.SubjectCustomerID = :customerId OR (a.ActorType = 'customer' AND a.ActorID = :customerId))`);
      rep.customerId = parseInt(query.customerId, 10);
    }
    if (query?.kind === 'writes') where.push(`a.Method NOT IN ('GET', 'HEAD')`);
    if (query?.kind === 'logins') where.push(`a.Path LIKE '%/login%'`);
    if (query?.kind === 'denied') where.push(`(a.Status IN (401, 403) OR a.Outcome = 'denied')`);
    if (query?.kind === 'errors') where.push('a.Status >= 500');
    if (query?.service) { where.push('a.Service = :service'); rep.service = String(query.service).slice(0, 60); }
    const search = String(query?.search || '').trim().slice(0, 100);
    if (search) {
      where.push('(a.Path LIKE :like OR a.ActorName LIKE :like OR a.ActorEmail LIKE :like OR a.IP LIKE :like OR a.Query LIKE :like)');
      rep.like = `%${search}%`;
    }
    const w = where.join(' AND ');
    const [{ total }] = await this.db.query<any>(`SELECT COUNT_BIG(*) AS total FROM tbAuditLog a WHERE ${w}`, { replacements: rep, type: QueryTypes.SELECT });
    const items = await this.db.query(`
      SELECT a.ID AS id, CONVERT(varchar(23), a.DateCreated, 126) AS at, a.Method AS method, a.Path AS path, a.Query AS query,
             a.Status AS status, a.DurationMs AS durationMs, a.Outcome AS outcome, a.ActorType AS actorType, a.ActorID AS actorId,
             a.ActorName AS actorName, a.ActorEmail AS actorEmail, a.SubjectCustomerID AS subjectCustomerId,
             LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS subjectName, a.Service AS service, a.IP AS ip,
             a.UserAgent AS userAgent
      FROM tbAuditLog a LEFT JOIN tbCustomers c ON c.ID = a.SubjectCustomerID
      WHERE ${w} ORDER BY a.ID DESC OFFSET :offset ROWS FETCH NEXT :size ROWS ONLY`, { replacements: rep, type: QueryTypes.SELECT });
    return { items, total: Number(total), page: p, pageSize: size };
  }
}
