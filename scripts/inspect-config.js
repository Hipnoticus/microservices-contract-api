const { Sequelize } = require('sequelize');
const s = new Sequelize({
  dialect: 'mssql', host: process.env.HOST, port: parseInt(process.env.SQL_PORT || '1433'),
  database: process.env.DB, username: process.env.USER, password: process.env.PASSWORD,
  logging: false, dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});
(async () => {
  const [config] = await s.query(
    "SELECT Name, Value FROM tbConfig WHERE Name LIKE 'schedule%' OR Name LIKE 'sessions%' ORDER BY Name"
  );
  config.forEach(c => {
    const val = (c.Value || '').replace(/<\/?p>/g, '').trim();
    console.log(`${c.Name} = ${val}`);
  });
  await s.close();
})();
