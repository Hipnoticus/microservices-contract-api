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

export class AuditService {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Sequelize, private readonly retentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS || '730', 10) || 730) {}

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

  /** Daily retention prune (AUDIT_RETENTION_DAYS, default 730). */
  startPruning() {
    const run = async () => {
      try {
        await this.ensureTable();
        await this.db.query('DELETE TOP (50000) FROM tbAuditLog WHERE DateCreated < DATEADD(day, -:days, SYSDATETIME())',
          { replacements: { days: this.retentionDays } });
      } catch (e) {
        logger.warn(`Audit prune failed: ${(e as Error).message}`);
      }
    };
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
