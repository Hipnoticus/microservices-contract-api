const { Sequelize } = require('sequelize');

const devDb = new Sequelize({
  dialect: 'mssql', host: 'hipnoticus-mssql', port: 1433,
  database: 'Hipnoticus', username: 'sa', password: 'Hipno8991!!',
  logging: false, dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});

const prodDb = new Sequelize({
  dialect: 'mssql', host: 'mssql2.hipnoterapia.org', port: 1433,
  database: 'hipnoticus', username: 'hipnoticus', password: 'hipno8991',
  logging: false, dialectOptions: { options: { encrypt: true, trustServerCertificate: true } },
});

async function analyze(db, label) {
  console.log(`\n=== ${label} ===`);

  // 1. tbQuestionnairesRequests schema
  const reqCols = await db.query("SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbQuestionnairesRequests' ORDER BY ORDINAL_POSITION");
  console.log('\ntbQuestionnairesRequests columns:', reqCols[0].map(c => c.COLUMN_NAME + '(' + c.DATA_TYPE + ')').join(', '));

  // 2. Sample requests with their associations
  const requests = await db.query(`
    SELECT r.ID, r.Hash, r.ClientID, r.Treatment, r.Author, r.Questionnaire, r.Status, r.DateCreated,
           q.ShortName as QuestionnaireName,
           t.OrderNumber as TreatmentOrder, t.SessionsNumber as TreatmentSessions,
           t.MainGoal as TreatmentMainGoal
    FROM tbQuestionnairesRequests r
    LEFT JOIN tbQuestionnaires q ON q.ID = r.Questionnaire
    LEFT JOIN tbTreatments t ON t.ID = r.Treatment
    ORDER BY r.ClientID, r.DateCreated
  `);
  console.log('\nSample requests (first 20):');
  requests[0].slice(0, 20).forEach(r => {
    console.log(`  Client=${r.ClientID} Q=${r.QuestionnaireName} Treatment=${r.Treatment}(Order=${r.TreatmentOrder}) Status=${r.Status} Date=${r.DateCreated ? new Date(r.DateCreated).toISOString().split('T')[0] : 'null'}`);
  });

  // 3. Check if any client has multiple requests for the same questionnaire
  const dupes = await db.query(`
    SELECT ClientID, Questionnaire, COUNT(*) as cnt
    FROM tbQuestionnairesRequests
    GROUP BY ClientID, Questionnaire
    HAVING COUNT(*) > 1
  `);
  console.log('\nClients with multiple requests for same questionnaire:', JSON.stringify(dupes[0]));

  // 4. Check tbTreatments structure
  const treatCols = await db.query("SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbTreatments' ORDER BY ORDINAL_POSITION");
  console.log('\ntbTreatments columns:', treatCols[0].map(c => c.COLUMN_NAME + '(' + c.DATA_TYPE + ')').join(', '));

  // 5. Check tbTreatmentsPhases if it exists
  try {
    const phases = await db.query("SELECT * FROM tbTreatmentsPhases ORDER BY ID");
    console.log('\ntbTreatmentsPhases:', JSON.stringify(phases[0], null, 2));
  } catch (e) {
    console.log('\ntbTreatmentsPhases: table not found or empty');
  }

  // 6. Check how many unique clients have questionnaire data
  const clients = await db.query("SELECT COUNT(DISTINCT ClientID) as cnt FROM tbQuestionnairesRequests");
  console.log('\nUnique clients with questionnaire requests:', clients[0][0].cnt);

  // 7. Check answer records - are they tied to request hash?
  const answerSample = await db.query(`
    SELECT TOP 5 ar.ID, ar.Questionnaire, ar.Question, ar.Answer, ar.Customer, ar.Request,
           q.ShortName
    FROM tbQuestionnairesAnswersRecords ar
    LEFT JOIN tbQuestionnaires q ON q.ID = ar.Questionnaire
    ORDER BY ar.ID DESC
  `);
  console.log('\nRecent answer records:', JSON.stringify(answerSample[0], null, 2));
}

async function main() {
  await analyze(devDb, 'DEV');
  await analyze(prodDb, 'PROD');
  await devDb.close();
  await prodDb.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
