const { Sequelize } = require('sequelize');
const s = new Sequelize({
  dialect: 'mssql', host: process.env.HOST, port: parseInt(process.env.SQL_PORT || '1433'),
  database: process.env.DB, username: process.env.USER, password: process.env.PASSWORD,
  logging: false, dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});
(async () => {
  const targets = ['tbOrdersStatus', 'tbOrdersProducts', 'tbFormasPagamento', 'tbCustomersAddresses',
    'tbSessions', 'tbSessionsStatus', 'tbSchedule', 'tbPayments'];
  for (const tbl of targets) {
    try {
      const [cols] = await s.query(
        `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${tbl}' ORDER BY ORDINAL_POSITION`
      );
      if (cols.length > 0) {
        console.log(`\n=== ${tbl} ===`);
        cols.forEach(c => console.log(`  ${c.COLUMN_NAME} ${c.DATA_TYPE}${c.CHARACTER_MAXIMUM_LENGTH ? '(' + c.CHARACTER_MAXIMUM_LENGTH + ')' : ''}`));
      }
    } catch (e) {}
  }
  // Sample data from tbProducts and tbOrdersStatus
  try {
    const [products] = await s.query('SELECT TOP 5 ID, Name, NormalPrice, PromotionalPrice, Category FROM tbProducts WHERE Blocked=0 OR Blocked IS NULL ORDER BY ID');
    console.log('\n=== tbProducts SAMPLE ===');
    products.forEach(p => console.log(`  ${p.ID}: ${p.Name} | Normal: ${p.NormalPrice} | Promo: ${p.PromotionalPrice} | Cat: ${p.Category}`));
  } catch(e) { console.log('Products query error:', e.message); }
  try {
    const [statuses] = await s.query('SELECT * FROM tbOrdersStatus ORDER BY ID');
    console.log('\n=== tbOrdersStatus ===');
    statuses.forEach(s => console.log(`  ${s.ID}: ${s.Name}`));
  } catch(e) { console.log('Status query error:', e.message); }
  try {
    const [fp] = await s.query('SELECT * FROM tbFormasPagamento ORDER BY ID');
    console.log('\n=== tbFormasPagamento ===');
    fp.forEach(f => console.log(`  ${JSON.stringify(f)}`));
  } catch(e) { console.log('FormasPagamento query error:', e.message); }
  await s.close();
})();
