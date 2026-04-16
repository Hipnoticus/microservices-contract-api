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

async function audit(db, label) {
  console.log(`\n=== ${label} ===`);

  // Sessions for customer 43 (Gabriel)
  const sessions = await db.query(
    "SELECT ID, Name, Notes, OrderNumber, ClientID, Treatment, DateBegins, Status FROM tbSessions WHERE ClientID = 43 ORDER BY ID"
  );
  console.log(`\ntbSessions (ClientID=43): ${sessions[0].length} rows`);
  sessions[0].forEach(r => console.log(`  ID=${r.ID} Order=${r.OrderNumber} Treatment=${r.Treatment} "${r.Notes||r.Name}" ${new Date(r.DateBegins).toISOString().split('T')[0]} Status=${r.Status}`));

  // Schedule for customer 43
  const schedule = await db.query(
    "SELECT ID, Name, OrderNumber, ClientID, Treatment, DateBegins FROM tbSchedule WHERE ClientID = 43 ORDER BY ID"
  );
  console.log(`\ntbSchedule (ClientID=43): ${schedule[0].length} rows`);
  schedule[0].forEach(r => console.log(`  ID=${r.ID} Order=${r.OrderNumber} Treatment=${r.Treatment} "${r.Name}" ${new Date(r.DateBegins).toISOString().split('T')[0]}`));

  // Treatments for customer 43
  const treatments = await db.query(
    "SELECT ID, Customer, OrderNumber, SessionsNumber FROM tbTreatments WHERE Customer = 43 ORDER BY ID"
  );
  console.log(`\ntbTreatments (Customer=43): ${treatments[0].length} rows`);
  treatments[0].forEach(r => console.log(`  ID=${r.ID} Order=${r.OrderNumber} Sessions=${r.SessionsNumber}`));

  // Orders for customer 43 created in 2024+
  const orders = await db.query(
    "SELECT ID, OrderStatusID, Total, DateCreated FROM tbOrders WHERE CustomerID = 43 AND DateCreated >= '2024-01-01' ORDER BY ID"
  );
  console.log(`\ntbOrders (CustomerID=43, 2024+): ${orders[0].length} rows`);
  orders[0].forEach(r => console.log(`  ID=${r.ID} Status=${r.OrderStatusID} Total=${r.Total} ${new Date(r.DateCreated).toISOString().split('T')[0]}`));

  // OrdersProducts for those orders
  const orderIds = orders[0].map(r => r.ID);
  if (orderIds.length > 0) {
    const products = await db.query(
      `SELECT ID, OrderID, ProductName FROM tbOrdersProducts WHERE OrderID IN (${orderIds.join(',')}) ORDER BY ID`
    );
    console.log(`\ntbOrdersProducts (test orders): ${products[0].length} rows`);
    products[0].forEach(r => console.log(`  ID=${r.ID} OrderID=${r.OrderID} "${r.ProductName}"`));
  }

  // Max IDs for identity reseed reference
  const tables = ['tbOrders','tbSessions','tbSchedule','tbTreatments','tbOrdersProducts'];
  console.log('\nMax IDs:');
  for (const t of tables) {
    const r = await db.query(`SELECT MAX(ID) as maxId FROM ${t}`);
    console.log(`  ${t}: ${r[0][0].maxId}`);
  }
}

async function main() {
  await audit(devDb, 'DEV DATABASE (hipnoticus-mssql)');
  await audit(prodDb, 'PROD DATABASE (mssql2.hipnoterapia.org)');
  await devDb.close();
  await prodDb.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
