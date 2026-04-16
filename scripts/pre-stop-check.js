const { Sequelize } = require('sequelize');
const s = new Sequelize({
  dialect: 'mssql', host: 'hipnoticus-mssql', port: 1433,
  database: 'Hipnoticus', username: 'sa', password: 'Hipno8991!!',
  logging: false, dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});

async function main() {
  // Check feminine questionnaire answers
  const newAnswers = await s.query("SELECT ID, Questionnaire, Question, Answer, Customer, Request FROM tbQuestionnairesAnswersRecords WHERE Customer = 43 AND Questionnaire IN (5,6) ORDER BY ID");
  console.log('Feminine questionnaire answers:', newAnswers[0].length);
  newAnswers[0].forEach(a => console.log('  ID=' + a.ID + ' Q=' + a.Questionnaire + ' Qn=' + a.Question + ' Ans=' + a.Answer + ' Req=' + a.Request));

  // Check requests for customer 43
  const reqs = await s.query("SELECT ID, Hash, Questionnaire, Status FROM tbQuestionnairesRequests WHERE ClientID = 43 ORDER BY Questionnaire");
  console.log('\nRequests:', reqs[0].length);
  reqs[0].forEach(r => console.log('  ID=' + r.ID + ' Q=' + r.Questionnaire + ' Status=' + r.Status + ' Hash=' + r.Hash));

  // Max IDs
  const maxReq = await s.query('SELECT MAX(ID) as m FROM tbQuestionnairesRequests');
  const maxAns = await s.query('SELECT MAX(ID) as m FROM tbQuestionnairesAnswersRecords');
  console.log('\nMax request ID:', maxReq[0][0].m);
  console.log('Max answer record ID:', maxAns[0][0].m);

  // PaymentTypeOld check
  const cols = await s.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbSessions' AND COLUMN_NAME LIKE '%ayment%'");
  console.log('\nPayment columns:', JSON.stringify(cols[0]));

  await s.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
