const { Sequelize } = require('sequelize');

const prodDb = new Sequelize({
  dialect: 'mssql', host: 'mssql2.hipnoterapia.org', port: 1433,
  database: 'hipnoticus', username: 'hipnoticus', password: 'hipno8991',
  logging: false, dialectOptions: { options: { encrypt: true, trustServerCertificate: true } },
});

async function cleanup() {
  console.log('=== CLEANING PROD DATABASE ===');

  // Get test treatment IDs for customer 43 (excluding ID=1 which is original)
  const treatments = await prodDb.query("SELECT ID FROM tbTreatments WHERE Customer = 43 AND ID > 1");
  const treatIds = treatments[0].map(r => r.ID);
  console.log(`Found ${treatIds.length} test treatments: ${treatIds.join(', ')}`);

  // Delete questionnaire requests referencing these treatments first
  if (treatIds.length > 0) {
    const qrBefore = await prodDb.query(`SELECT COUNT(*) as cnt FROM tbQuestionnairesRequests WHERE Treatment IN (${treatIds.join(',')})`);
    await prodDb.query(`DELETE FROM tbQuestionnairesRequests WHERE Treatment IN (${treatIds.join(',')})`);
    console.log(`Deleted ${qrBefore[0][0].cnt} questionnaire requests`);

    // Now delete treatments
    await prodDb.query(`DELETE FROM tbTreatments WHERE ID IN (${treatIds.join(',')})`);
    console.log(`Deleted ${treatIds.length} treatments`);
  }

  // Delete test orders for customer 43 from 2024+
  const testOrderIds = await prodDb.query(
    "SELECT ID FROM tbOrders WHERE CustomerID = 43 AND DateCreated >= '2024-01-01'"
  );
  const ids = testOrderIds[0].map(r => r.ID);
  if (ids.length > 0) {
    await prodDb.query(`DELETE FROM tbOrdersProducts WHERE OrderID IN (${ids.join(',')})`);
    await prodDb.query(`DELETE FROM tbOrders WHERE ID IN (${ids.join(',')})`);
    console.log(`Deleted ${ids.length} test orders and products: ${ids.join(', ')}`);
  }

  // Reseed identities
  const tables = ['tbOrders', 'tbSessions', 'tbSchedule', 'tbTreatments', 'tbOrdersProducts', 'tbQuestionnairesRequests'];
  for (const t of tables) {
    try {
      const r = await prodDb.query(`SELECT ISNULL(MAX(ID), 0) as maxId FROM ${t}`);
      const maxId = r[0][0].maxId;
      await prodDb.query(`DBCC CHECKIDENT ('${t}', RESEED, ${maxId})`);
      console.log(`${t}: reseeded to ${maxId}`);
    } catch (e) { console.log(`${t}: reseed skipped (${e.message.substring(0, 50)})`); }
  }

  // Verify
  const sessionsLeft = await prodDb.query("SELECT COUNT(*) as cnt FROM tbSessions WHERE ClientID = 43");
  const schedLeft = await prodDb.query("SELECT COUNT(*) as cnt FROM tbSchedule WHERE ClientID = 43");
  const treatLeft = await prodDb.query("SELECT COUNT(*) as cnt FROM tbTreatments WHERE Customer = 43");
  const ordersLeft = await prodDb.query("SELECT COUNT(*) as cnt FROM tbOrders WHERE CustomerID = 43 AND DateCreated >= '2024-01-01'");
  console.log(`\nRemaining for customer 43:`);
  console.log(`  Sessions: ${sessionsLeft[0][0].cnt}`);
  console.log(`  Schedule: ${schedLeft[0][0].cnt}`);
  console.log(`  Treatments: ${treatLeft[0][0].cnt}`);
  console.log(`  Orders (2024+): ${ordersLeft[0][0].cnt}`);

  await prodDb.close();
  console.log('\nDone!');
}

cleanup().catch(e => { console.error(e.message); process.exit(1); });
