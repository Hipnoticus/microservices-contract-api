const { Sequelize } = require('sequelize');

const s = new Sequelize({
  dialect: 'mssql', host: 'hipnoticus-mssql', port: 1433,
  database: 'Hipnoticus', username: 'sa', password: 'Hipno8991!!',
  logging: false, dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});

async function main() {
  // 1. Drop PaymentTypeOld column
  console.log('Dropping PaymentTypeOld from tbSessions...');
  await s.query("ALTER TABLE tbSessions DROP COLUMN PaymentTypeOld");
  console.log('Done.');

  // Verify
  const cols = await s.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbSessions' AND COLUMN_NAME LIKE '%ayment%'");
  console.log('Payment columns now:', JSON.stringify(cols[0]));

  // 2. Check what questionnaires exist
  const questionnaires = await s.query("SELECT ID, Name, ShortName FROM tbQuestionnaires ORDER BY ID");
  console.log('\nQuestionnaires:', JSON.stringify(questionnaires[0], null, 2));

  // 3. Check existing requests for customer 43
  const existing = await s.query("SELECT ID, Hash, Questionnaire, Status FROM tbQuestionnairesRequests WHERE ClientID = 43");
  console.log('\nExisting requests for customer 43:', JSON.stringify(existing[0]));

  // 4. Check existing answer records for customer 43
  const answers = await s.query("SELECT COUNT(*) as cnt FROM tbQuestionnairesAnswersRecords WHERE Customer = 43");
  console.log('Existing answer records:', JSON.stringify(answers[0]));

  // 5. Get treatment ID for customer 43 (need it for the request)
  const treatments = await s.query("SELECT TOP 1 ID FROM tbTreatments WHERE Customer = 43 ORDER BY ID");
  const treatmentId = treatments[0].length > 0 ? treatments[0][0].ID : 1;
  console.log('Treatment ID:', treatmentId);

  // 6. Create questionnaire requests for all 8 questionnaires
  // Status 1 = Requested (ready to answer)
  const questIds = questionnaires[0].map(q => q.ID);
  const existingQIds = existing[0].map(r => r.Questionnaire);

  for (const qId of questIds) {
    if (existingQIds.includes(qId)) {
      console.log(`Questionnaire ${qId} already has a request, skipping`);
      continue;
    }
    const hash = crypto.randomUUID().toUpperCase();
    await s.query(
      `INSERT INTO tbQuestionnairesRequests (Hash, ClientID, Treatment, Author, Questionnaire, Status, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
       VALUES (:hash, 43, :treatmentId, 1, :qId, 1, 0, GETDATE(), GETDATE(), 1, 1)`,
      { replacements: { hash, treatmentId, qId } }
    );
    console.log(`Created request for questionnaire ${qId}: ${hash}`);
  }

  // 7. Verify
  const final = await s.query("SELECT r.ID, r.Hash, r.Questionnaire, q.ShortName, r.Status FROM tbQuestionnairesRequests r JOIN tbQuestionnaires q ON q.ID = r.Questionnaire WHERE r.ClientID = 43 ORDER BY r.Questionnaire");
  console.log('\nFinal requests for customer 43:');
  final[0].forEach(r => console.log(`  Q${r.Questionnaire} (${r.ShortName}) - Hash: ${r.Hash} - Status: ${r.Status}`));

  await s.close();
  console.log('\nDone!');
}

const crypto = require('crypto');
main().catch(e => { console.error(e.message); process.exit(1); });
