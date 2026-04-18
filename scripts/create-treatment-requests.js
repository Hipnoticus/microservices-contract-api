const { Sequelize } = require('sequelize');
const crypto = require('crypto');

const s = new Sequelize({
  dialect: 'mssql', host: 'hipnoticus-mssql', port: 1433,
  database: 'Hipnoticus', username: 'sa', password: 'Hipno8991!!',
  logging: false, dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});

async function main() {
  // First, ensure the existing treatment (ID from pre-treatment) has PhaseDefined = 1
  const existingTreatment = await s.query("SELECT TOP 1 ID FROM tbTreatments WHERE Customer = 43 ORDER BY ID");
  const preTreatmentId = existingTreatment[0][0]?.ID;
  if (preTreatmentId) {
    await s.query("UPDATE tbTreatments SET PhaseDefined = 1 WHERE ID = :id", { replacements: { id: preTreatmentId } });
    console.log('Set treatment ' + preTreatmentId + ' to PhaseDefined=1 (Pre-Tratamento)');
    // Update existing requests to point to this treatment
    await s.query("UPDATE tbQuestionnairesRequests SET Treatment = :tid WHERE ClientID = 43 AND Treatment != :tid", { replacements: { tid: preTreatmentId } });
  }

  // Create a new treatment for the "Tratamento" phase (phase 2)
  const treatResult = await s.query(
    "INSERT INTO tbTreatments (MainGoal, Customer, OrderNumber, SessionsNumber, PhaseDefined, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy) OUTPUT INSERTED.ID VALUES (1, 43, 0, 10, 2, 0, GETDATE(), GETDATE(), 1, 1)"
  );
  const treatmentPhase2Id = treatResult[0][0]?.ID;
  console.log('Created treatment ' + treatmentPhase2Id + ' for Tratamento phase');

  // Create new questionnaire requests for the Tratamento phase (status 1 = Requested)
  // Only male questionnaires: QSK 1, QSK 2, QSXKM 1, QSXKM 2, QABEG, QDH
  const questionnaires = [1, 2, 3, 4, 7, 8];
  for (const qId of questionnaires) {
    const hash = crypto.randomUUID().toUpperCase();
    await s.query(
      "INSERT INTO tbQuestionnairesRequests (Hash, ClientID, Treatment, Author, Questionnaire, Status, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy) VALUES (:hash, 43, :tid, 1, :qid, 1, 0, GETDATE(), GETDATE(), 1, 1)",
      { replacements: { hash, tid: treatmentPhase2Id, qid: qId } }
    );
    console.log('Created request Q' + qId + ' for Tratamento phase: ' + hash);
  }

  // Verify
  const all = await s.query(
    "SELECT r.ID, r.Questionnaire, q.ShortName, r.Status, r.Treatment, t.PhaseDefined, tp.Name as PhaseName FROM tbQuestionnairesRequests r JOIN tbQuestionnaires q ON q.ID = r.Questionnaire LEFT JOIN tbTreatments t ON t.ID = r.Treatment LEFT JOIN tbTreatmentsPhases tp ON tp.ID = t.PhaseDefined WHERE r.ClientID = 43 ORDER BY t.PhaseDefined, r.Questionnaire"
  );
  console.log('\nAll requests for client 43:');
  all[0].forEach(r => console.log('  ' + (r.PhaseName || 'Unknown') + ' | Q' + r.Questionnaire + ' (' + r.ShortName + ') Status=' + r.Status));

  await s.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
