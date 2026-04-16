const { Sequelize } = require('sequelize');
const s = new Sequelize({
  dialect: 'mssql', host: 'hipnoticus-mssql', port: 1433,
  database: 'Hipnoticus', username: 'sa', password: 'Hipno8991!!',
  logging: false, dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});

async function main() {
  // Find package table
  const tables = await s.query("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%Pacot%' OR TABLE_NAME LIKE '%Product%' OR TABLE_NAME LIKE '%Package%'");
  console.log('Package tables:', JSON.stringify(tables[0]));

  // Check tbIssues
  const issues = await s.query("SELECT TOP 2 * FROM tbIssues ORDER BY ID");
  console.log('Issues sample:', JSON.stringify(issues[0]));

  // Check how package size is determined from orders
  const orders = await s.query("SELECT TOP 1 o.*, p.Sessions FROM tbOrders o LEFT JOIN tbPacotes p ON o.Total = p.Price WHERE o.ID = (SELECT MAX(ID) FROM tbOrders)");
  console.log('Order+Package:', JSON.stringify(orders[0]));

  await s.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
