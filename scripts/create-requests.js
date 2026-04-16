const { Sequelize } = require('sequelize');
const crypto = require('crypto');

const s = new Sequelize({
  dialect: 'mssql', host: 'hipnoticus-mssql', port: 1433,
  database: 'Hipnoticus', username: 'sa', password: 'Hipno8991!!',
  logging: false, dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});

async function main() {
  // Check existing requests
  const existing = await s.query("SELECT ID, Hash, Questionnaire, Status FROM tbQuestionnairesRequests WHERE ClientID = 43");
  console.log('Existing requests:', existing[0].length);

  // Get all questionnaires
  const questionnaires = await s.query("SELECT ID, ShortName FROM tbQuestionnaires ORDER BY ID");

  // Get treatment for customer 43
  const treatments = await s.query("SELECT TOP 1 ID FROM tbTreatments WHERE Customer = 43 ORDER BY ID");
  const treatmentId = treatments[0].length > 0 ? treatments[0][0].ID : 1;

  // Create missing requests
  const existingQIds = existing[0].map(r => r.Questionnaire);
  for (const q of questionnaires[0]) {
    if (existingQIds.includes(q.ID)) {
      console.log('Q' + q.ID + ' (' + q.ShortName + ') already exists, skipping');
      continue;
    }
    const hash = crypto.randomUUID().toUpperCase();
    await s.query(
      "INSERT INTO tbQuestionnairesRequests (Hash, ClientID, Treatment, Author, Questionnaire, Status, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy) VALUES (:hash, 43, :tid, 1, :qid, 1, 0, GETDATE(), GETDATE(), 1, 1)",
      { replacements: { hash, tid: treatmentId, qid: q.ID } }
    );
    console.log('Created Q' + q.ID + ' (' + q.ShortName + '): ' + hash);
  }

  // Also reset the answered feminine questionnaire answers if they exist
  const femAnswers = await s.query("SELECT COUNT(*) as cnt FROM tbQuestionnairesAnswersRecords WHERE Customer = 43 AND Questionnaire IN (5,6)");
  console.log('Feminine answers:', femAnswers[0][0].cnt);

  // Verify final state
  const final = await s.query("SELECT r.ID, r.Hash, r.Questionnaire, q.ShortName, r.Status FROM tbQuestionnairesRequests r JOIN tbQuestionnaires q ON q.ID = r.Questionnaire WHERE r.ClientID = 43 ORDER BY r.Questionnaire");
  console.log('\nFinal requests:');
  final[0].forEach(r => console.log('  Q' + r.Questionnaire + ' (' + r.ShortName + ') Status=' + r.Status + ' Hash=' + r.Hash));

  await s.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
