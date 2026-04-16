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

async function cleanup(db, label) {
  console.log(`\n=== CLEANING ${label} ===`);

  // 1. Delete the 4 specific sessions the user mentioned (IDs 3560-3563)
  await db.query("DELETE FROM tbSessions WHERE ID IN (3560, 3561, 3562, 3563)");
  console.log('Deleted sessions 3560-3563');

  // 2. Delete all test schedule entries for customer 43 (all are test data)
  const schedBefore = await db.query("SELECT COUNT(*) as cnt FROM tbSchedule WHERE ClientID = 43");
  await db.query("DELETE FROM tbSchedule WHERE ClientID = 43");
  console.log(`Deleted ${schedBefore[0][0].cnt} schedule entries for customer 43`);

  // 3. Delete test treatments for customer 43 (keep Treatment ID=1 which is the original)
  const treatBefore = await db.query("SELECT COUNT(*) as cnt FROM tbTreatments WHERE Customer = 43 AND ID > 1");
  await db.query("DELETE FROM tbTreatments WHERE Customer = 43 AND ID > 1");
  console.log(`Deleted ${treatBefore[0][0].cnt} test treatments for customer 43`);

  // 4. Delete test orders for customer 43 created from 2024 onwards
  //    (orders before 2024 are legacy real data from the clinic's early days)
  const testOrderIds = await db.query(
    "SELECT ID FROM tbOrders WHERE CustomerID = 43 AND DateCreated >= '2024-01-01'"
  );
  const ids = testOrderIds[0].map(r => r.ID);
  if (ids.length > 0) {
    await db.query(`DELETE FROM tbOrdersProducts WHERE OrderID IN (${ids.join(',')})`);
    await db.query(`DELETE FROM tbOrders WHERE ID IN (${ids.join(',')})`);
    console.log(`Deleted ${ids.length} test orders and their products: ${ids.join(', ')}`);
  }

  // 5. Reseed identities
  const tables = ['tbOrders', 'tbSessions', 'tbSchedule', 'tbTreatments', 'tbOrdersProducts'];
  for (const t of tables) {
    const r = await db.query(`SELECT ISNULL(MAX(ID), 0) as maxId FROM ${t}`);
    const maxId = r[0][0].maxId;
    await db.query(`DBCC CHECKIDENT ('${t}', RESEED, ${maxId})`);
    console.log(`${t}: reseeded to ${maxId}`);
  }

  // 6. Verify
  const sessionsLeft = await db.query("SELECT COUNT(*) as cnt FROM tbSessions WHERE ClientID = 43");
  const schedLeft = await db.query("SELECT COUNT(*) as cnt FROM tbSchedule WHERE ClientID = 43");
  const treatLeft = await db.query("SELECT COUNT(*) as cnt FROM tbTreatments WHERE Customer = 43");
  const ordersLeft = await db.query("SELECT COUNT(*) as cnt FROM tbOrders WHERE CustomerID = 43 AND DateCreated >= '2024-01-01'");
  console.log(`\nRemaining for customer 43:`);
  console.log(`  Sessions: ${sessionsLeft[0][0].cnt}`);
  console.log(`  Schedule: ${schedLeft[0][0].cnt}`);
  console.log(`  Treatments: ${treatLeft[0][0].cnt}`);
  console.log(`  Orders (2024+): ${ordersLeft[0][0].cnt}`);
}

async function main() {
  await cleanup(devDb, 'DEV DATABASE');
  await cleanup(prodDb, 'PROD DATABASE');
  await devDb.close();
  await prodDb.close();
  console.log('\nDone!');
}

main().catch(e => { console.error(e.message); process.exit(1); });
