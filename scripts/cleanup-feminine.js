const { Sequelize } = require('sequelize');
const s = new Sequelize({
  dialect: 'mssql', host: 'hipnoticus-mssql', port: 1433,
  database: 'Hipnoticus', username: 'sa', password: 'Hipno8991!!',
  logging: false, dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});

async function main() {
  // Delete feminine questionnaire answers for customer 43
  const delAnswers = await s.query("DELETE FROM tbQuestionnairesAnswersRecords WHERE Customer = 43 AND Questionnaire IN (5, 6)");
  console.log('Deleted feminine answers');

  // Delete feminine questionnaire requests for customer 43
  const delRequests = await s.query("DELETE FROM tbQuestionnairesRequests WHERE ClientID = 43 AND Questionnaire IN (5, 6)");
  console.log('Deleted feminine requests');

  // Reseed
  const maxReq = await s.query("SELECT ISNULL(MAX(ID), 0) as m FROM tbQuestionnairesRequests");
  await s.query("DBCC CHECKIDENT ('tbQuestionnairesRequests', RESEED, " + maxReq[0][0].m + ")");
  const maxAns = await s.query("SELECT ISNULL(MAX(ID), 0) as m FROM tbQuestionnairesAnswersRecords");
  await s.query("DBCC CHECKIDENT ('tbQuestionnairesAnswersRecords', RESEED, " + maxAns[0][0].m + ")");
  console.log('Reseeded: requests=' + maxReq[0][0].m + ' answers=' + maxAns[0][0].m);

  // Verify
  const remaining = await s.query("SELECT r.Questionnaire, q.ShortName, r.Status FROM tbQuestionnairesRequests r JOIN tbQuestionnaires q ON q.ID = r.Questionnaire WHERE r.ClientID = 43 ORDER BY r.Questionnaire");
  console.log('\nRemaining requests for customer 43:');
  remaining[0].forEach(r => console.log('  Q' + r.Questionnaire + ' (' + r.ShortName + ') Status=' + r.Status));

  await s.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
