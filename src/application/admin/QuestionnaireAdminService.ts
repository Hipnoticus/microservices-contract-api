import { HttpException, HttpStatus } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

/**
 * Questionários (ControleWeb module 11) and the client page's "Solicitar Questionários".
 *
 * tbQuestionnairesRequests is a request with a Hash the client answers in Moses; answers live in
 * tbQuestionnairesAnswersRecords keyed by that Hash, where Question is the question's PriorityOrder (not its ID).
 * QuestionnaireAPI sets Status 4 (Answered) when the last question is answered; ControleWeb treats 4, 5, 10 and 11
 * as finished when it checks for a pending duplicate.
 */
const FINISHED = [4, 5, 10, 11];

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

/** Progress of a request: distinct questions answered against the questionnaire's active questions. */
const PROGRESS = `
  (SELECT COUNT(*) FROM tbQuestionnairesQuestions qq WHERE qq.Questionnaire = r.Questionnaire AND ISNULL(qq.Blocked, 0) = 0) AS totalQuestions,
  (SELECT COUNT(DISTINCT a.Question) FROM tbQuestionnairesAnswersRecords a WHERE a.Request = r.Hash AND ISNULL(a.Blocked, 0) = 0) AS answered,
  (SELECT CONVERT(varchar(19), MAX(a.DateCreated), 126) FROM tbQuestionnairesAnswersRecords a WHERE a.Request = r.Hash) AS lastAnswer`;

export class QuestionnaireAdminService {
  constructor(private readonly db: Sequelize) {}

  private q<T extends object = any>(sql: string, replacements: Record<string, any> = {}): Promise<T[]> {
    return this.db.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  }

  // ---- questionnaires ---------------------------------------------------------------------------------------------

  async questionnaires() {
    return this.q(`
      SELECT q.ID AS id, q.Name AS name, q.ShortName AS shortName, CAST(q.Description AS nvarchar(max)) AS description,
             CAST(ISNULL(q.Blocked, 0) AS bit) AS blocked,
             (SELECT COUNT(*) FROM tbQuestionnairesQuestions qq WHERE qq.Questionnaire = q.ID AND ISNULL(qq.Blocked, 0) = 0) AS questions,
             (SELECT COUNT(*) FROM tbQuestionnairesRequests r WHERE r.Questionnaire = q.ID AND ISNULL(r.Blocked, 0) = 0) AS requests,
             (SELECT COUNT(*) FROM tbQuestionnairesRequests r WHERE r.Questionnaire = q.ID AND ISNULL(r.Blocked, 0) = 0
                AND r.Status IN (${FINISHED.join(',')})) AS answered
      FROM tbQuestionnaires q ORDER BY q.ID`);
  }

  /** One questionnaire with its questions and each question's answer options (tbQuestionnairesAnswers by AnswerType). */
  async questionnaire(id: number) {
    const rows = await this.q(`
      SELECT ID AS id, Name AS name, ShortName AS shortName, CAST(Description AS nvarchar(max)) AS description,
             CAST(ISNULL(Blocked, 0) AS bit) AS blocked
      FROM tbQuestionnaires WHERE ID = :id`, { id });
    if (!rows.length) notFound('Questionário');
    const questions = await this.q<any>(`
      SELECT ID AS id, CAST(Question AS nvarchar(max)) AS question, PriorityOrder AS [order], AnswerType AS answerType,
             CAST(ISNULL(Blocked, 0) AS bit) AS blocked
      FROM tbQuestionnairesQuestions WHERE Questionnaire = :id ORDER BY PriorityOrder`, { id });
    const types = [...new Set(questions.map((x) => x.answerType).filter((t) => t !== null && t !== undefined))];
    const options = types.length ? await this.q<any>(`
      SELECT ID AS id, CAST(Answer AS nvarchar(max)) AS answer, Value AS value, Points AS points, AnswerType AS answerType
      FROM tbQuestionnairesAnswers WHERE AnswerType IN (:types) AND ISNULL(Blocked, 0) = 0 ORDER BY AnswerType, ID`, { types }) : [];
    return {
      ...rows[0],
      questions: questions.map((x) => ({ ...x, options: options.filter((o) => o.answerType === x.answerType) })),
    };
  }

  /** ControleWeb edits Name, ShortName, Description and Blocked through its generic lister; questions are seeded. */
  async saveQuestionnaire(id: number, body: any, staffId: number) {
    await this.questionnaire(id);
    const name = String(body?.name ?? '').trim().slice(0, 255);
    const shortName = String(body?.shortName ?? '').trim().slice(0, 50);
    if (!name || !shortName) bad('Nome e sigla são obrigatórios.');
    await this.db.query(`
      UPDATE tbQuestionnaires SET Name = :name, ShortName = :shortName, Description = :description, Blocked = :blocked,
             DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id`,
      { replacements: { id, name, shortName, description: String(body?.description ?? '').slice(0, 4000), blocked: body?.blocked ? 1 : 0, staffId } });
    return { id };
  }

  async statuses() {
    return this.q('SELECT ID AS id, Name AS name FROM tbQuestionnairesRequestsStatus WHERE ISNULL(Blocked, 0) = 0 ORDER BY ID');
  }

  // ---- requests -----------------------------------------------------------------------------------------------------

  async requests(query: any) {
    const { page: p, size, offset } = page(query);
    const where = ['ISNULL(r.Blocked, 0) = 0'];
    const rep: any = { offset, size };
    if (query?.customerId) { where.push('r.ClientID = :customerId'); rep.customerId = parseInt(query.customerId, 10); }
    if (query?.questionnaireId) { where.push('r.Questionnaire = :qid'); rep.qid = parseInt(query.questionnaireId, 10); }
    if (query?.statusId) { where.push('r.Status = :statusId'); rep.statusId = parseInt(query.statusId, 10); }
    if (query?.state === 'pending') where.push(`ISNULL(r.Status, 1) NOT IN (${FINISHED.join(',')})`);
    if (query?.state === 'answered') where.push(`r.Status IN (${FINISHED.join(',')})`);
    const search = String(query?.search || '').trim().slice(0, 100);
    if (search) {
      where.push(`(c.FirstName + ' ' + ISNULL(c.LastName, '') LIKE :like OR c.Email LIKE :like OR q.ShortName LIKE :like OR q.Name LIKE :like)`);
      rep.like = `%${search}%`;
    }
    const w = where.join(' AND ');
    const from = `FROM tbQuestionnairesRequests r
      LEFT JOIN tbQuestionnaires q ON q.ID = r.Questionnaire
      LEFT JOIN tbCustomers c ON c.ID = r.ClientID
      LEFT JOIN tbQuestionnairesRequestsStatus s ON s.ID = r.Status
      LEFT JOIN tbTreatments t ON t.ID = r.Treatment
      LEFT JOIN tbTreatmentsPhases tp ON tp.ID = COALESCE(t.PhaseDefined, t.PhaseDetected, 1)
      LEFT JOIN tbUsers u ON u.ID = r.Author`;
    const [{ total }] = await this.q<any>(`SELECT COUNT(*) AS total ${from} WHERE ${w}`, rep);
    const items = await this.q(`
      SELECT r.ID AS id, CONVERT(varchar(36), r.Hash) AS hash, r.ClientID AS customerId,
             LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS customerName,
             r.Questionnaire AS questionnaireId, q.Name AS questionnaireName, q.ShortName AS shortName,
             r.Status AS statusId, s.Name AS statusName, r.Treatment AS treatmentId, tp.Name AS phaseName,
             u.UserName AS author, CONVERT(varchar(19), r.DateCreated, 126) AS dateCreated,
             CONVERT(varchar(19), r.DateModified, 126) AS dateModified, ${PROGRESS}
      ${from} WHERE ${w}
      ORDER BY r.ID DESC OFFSET :offset ROWS FETCH NEXT :size ROWS ONLY`, rep);
    return { items, total: Number(total), page: p, pageSize: size };
  }

  /**
   * clientes_questionnaire_request.asp: refuses a duplicate while one for the same questionnaire is still open,
   * otherwise inserts Status 1 (Requested) tied to the client's latest treatment. Sexuality questionnaires follow
   * the client's sex like the ControleWeb list (3, 4 male; 5, 6 female).
   */
  async createRequest(customerId: number, questionnaireId: number, staffId: number) {
    if (!customerId || !questionnaireId) bad('Cliente e questionário são obrigatórios.');
    const c = await this.q<any>('SELECT ID AS id, Sex AS sex FROM tbCustomers WHERE ID = :customerId', { customerId });
    if (!c.length) notFound('Cliente');
    const qs = await this.q<any>('SELECT ID AS id, ShortName AS shortName, CAST(ISNULL(Blocked, 0) AS bit) AS blocked FROM tbQuestionnaires WHERE ID = :questionnaireId', { questionnaireId });
    if (!qs.length) notFound('Questionário');
    const sex = String(c[0].sex ?? '').trim().toUpperCase();
    const male = sex === '0' || sex === 'M';
    const female = sex === '1' || sex === 'F';
    if ((male && [5, 6].includes(questionnaireId)) || (female && [3, 4].includes(questionnaireId))) {
      bad('Este questionário de sexualidade não corresponde ao sexo do cliente.');
    }
    const open = await this.q(`
      SELECT ID FROM tbQuestionnairesRequests WHERE ClientID = :customerId AND Questionnaire = :questionnaireId
        AND ISNULL(Status, 1) NOT IN (${FINISHED.join(',')}) AND ISNULL(Blocked, 0) = 0`, { customerId, questionnaireId });
    if (open.length) {
      throw new HttpException({ error: 'Já existe uma solicitação pendente para este questionário.', existingId: (open[0] as any).ID }, HttpStatus.CONFLICT);
    }
    const rows = await this.q<any>(`
      INSERT INTO tbQuestionnairesRequests (Hash, Questionnaire, ClientID, Treatment, Author, Status, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
      OUTPUT inserted.ID AS id, CONVERT(varchar(36), inserted.Hash) AS hash
      VALUES (NEWID(), :questionnaireId, :customerId, (SELECT TOP 1 ID FROM tbTreatments WHERE Customer = :customerId ORDER BY ID DESC),
              :staffId, 1, 0, GETDATE(), GETDATE(), :staffId, :staffId)`, { questionnaireId, customerId, staffId });
    return { id: Number(rows[0].id), hash: rows[0].hash, shortName: qs[0].shortName };
  }

  private async request(id: number) {
    const rows = await this.q<any>(`
      SELECT r.ID AS id, CONVERT(varchar(36), r.Hash) AS hash, r.ClientID AS customerId, r.Questionnaire AS questionnaireId,
             r.Status AS statusId, CAST(ISNULL(r.Blocked, 0) AS bit) AS blocked
      FROM tbQuestionnairesRequests r WHERE r.ID = :id`, { id });
    if (!rows.length) notFound('Solicitação');
    return rows[0];
  }

  async updateRequest(id: number, body: any, staffId: number) {
    await this.request(id);
    const statusId = parseInt(String(body?.statusId), 10);
    const s = await this.q('SELECT ID FROM tbQuestionnairesRequestsStatus WHERE ID = :statusId', { statusId });
    if (!s.length) bad('Status inválido.');
    await this.db.query('UPDATE tbQuestionnairesRequests SET Status = :statusId, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id',
      { replacements: { id, statusId, staffId } });
    return { id, statusId };
  }

  /**
   * ControleWeb deletes the row outright. That is kept for a request nobody answered; once answers exist the request
   * is blocked instead, so the answers and the client's results are not orphaned.
   */
  async deleteRequest(id: number, staffId: number) {
    const r = await this.request(id);
    const [{ n }] = await this.q<any>('SELECT COUNT(*) AS n FROM tbQuestionnairesAnswersRecords WHERE Request = :hash', { hash: r.hash });
    if (Number(n) === 0) {
      await this.db.query('DELETE FROM tbQuestionnairesRequests WHERE ID = :id', { replacements: { id } });
      return { id, deleted: true };
    }
    await this.db.query('UPDATE tbQuestionnairesRequests SET Blocked = 1, DateModified = GETDATE(), ModifiedBy = :staffId WHERE ID = :id',
      { replacements: { id, staffId } });
    return { id, blocked: true };
  }

  /** Every question of the questionnaire with the option the client chose (latest record per question). */
  async answers(id: number) {
    const r = await this.request(id);
    const head = await this.q<any>(`
      SELECT q.Name AS questionnaireName, q.ShortName AS shortName, s.Name AS statusName,
             LTRIM(RTRIM(ISNULL(c.FirstName, '') + ' ' + ISNULL(c.LastName, ''))) AS customerName,
             CONVERT(varchar(19), rq.DateCreated, 126) AS dateCreated
      FROM tbQuestionnairesRequests rq LEFT JOIN tbQuestionnaires q ON q.ID = rq.Questionnaire
      LEFT JOIN tbQuestionnairesRequestsStatus s ON s.ID = rq.Status LEFT JOIN tbCustomers c ON c.ID = rq.ClientID
      WHERE rq.ID = :id`, { id });
    const items = await this.q<any>(`
      SELECT qq.PriorityOrder AS [order], CAST(qq.Question AS nvarchar(max)) AS question,
             x.answerId, x.answer, x.value, x.points, x.answeredAt
      FROM tbQuestionnairesQuestions qq
      OUTER APPLY (
        SELECT TOP 1 qa.ID AS answerId, CAST(qa.Answer AS nvarchar(max)) AS answer, qa.Value AS value, qa.Points AS points,
               CONVERT(varchar(19), a.DateCreated, 126) AS answeredAt
        FROM tbQuestionnairesAnswersRecords a LEFT JOIN tbQuestionnairesAnswers qa ON qa.ID = a.Answer
        WHERE a.Request = :hash AND a.Questionnaire = qq.Questionnaire AND a.Question = qq.PriorityOrder AND ISNULL(a.Blocked, 0) = 0
        ORDER BY a.ID DESC) x
      WHERE qq.Questionnaire = :qid AND ISNULL(qq.Blocked, 0) = 0
      ORDER BY qq.PriorityOrder`, { hash: r.hash, qid: r.questionnaireId });
    const answered = items.filter((i) => i.answerId !== null && i.answerId !== undefined);
    const points = answered.reduce((s, i) => s + (Number(i.points) || 0), 0);
    const diagnostic = await this.q<any>(`
      SELECT TOP 1 InstrumentShortName AS instrument, TotalScore AS totalScore, SeverityClassification AS severity,
             InterpretationText AS interpretation, CONVERT(varchar(19), DateCreated, 126) AS dateCreated
      FROM tbDiagnosticResults WHERE RequestHash = :hash ORDER BY ID DESC`, { hash: r.hash });
    return {
      ...r, ...(head[0] || {}), items,
      totalQuestions: items.length, answered: answered.length, points,
      diagnostic: diagnostic[0] || null,
    };
  }
}
