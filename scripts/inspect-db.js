const { Sequelize } = require('sequelize');
const s = new Sequelize({
  dialect: 'mssql',
  host: process.env.HOST,
  port: parseInt(process.env.SQL_PORT || '1433'),
  database: process.env.DB,
  username: process.env.USER,
  password: process.env.PASSWORD,
  logging: false,
  dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});

(async () => {
  try {
    // List all tables
    const [tables] = await s.query(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
    );
    console.log('=== TABLES ===');
    tables.forEach((t) => console.log(t.TABLE_NAME));

    // Show columns for order/product related tables
    const targets = ['tbOrders', 'tbProducts', 'tbPackages', 'tbCustomers', 'tbClientes',
      'tbPaymentMethods', 'tbOrderStatus', 'tbTreatments', 'tbSessoes', 'tbIssues'];
    for (const tbl of targets) {
      try {
        const [cols] = await s.query(
          `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
           FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${tbl}' ORDER BY ORDINAL_POSITION`
        );
        if (cols.length > 0) {
          console.log(`\n=== ${tbl} ===`);
          cols.forEach((c) =>
            console.log(`  ${c.COLUMN_NAME} ${c.DATA_TYPE}${c.CHARACTER_MAXIMUM_LENGTH ? '(' + c.CHARACTER_MAXIMUM_LENGTH + ')' : ''} ${c.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'}`)
          );
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error(e.message);
  } finally {
    await s.close();
  }
})();
