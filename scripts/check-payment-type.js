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

async function check(db, label) {
  const cols = await db.query("SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbSessions' AND COLUMN_NAME LIKE '%ayment%' ORDER BY ORDINAL_POSITION");
  console.log(label + ':', JSON.stringify(cols[0]));
}

async function main() {
  await check(devDb, 'DEV');
  await check(prodDb, 'PROD');
  await devDb.close();
  await prodDb.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
