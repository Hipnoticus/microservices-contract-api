const { Sequelize } = require('sequelize');
const s = new Sequelize({
  dialect: 'mssql', host: process.env.HOST || 'mssql2.hipnoterapia.org',
  port: parseInt(process.env.SQL_PORT || '1433'),
  database: process.env.DB || 'hipnoticus',
  username: process.env.USER || 'hipnoticus',
  password: process.env.PASSWORD || 'hipno8991',
  logging: false, dialectOptions: { options: { encrypt: true, trustServerCertificate: true } },
});
(async () => {
  // Check for Calendar/Schedule/Session tables
  const [tables] = await s.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%Calendar%' OR TABLE_NAME LIKE '%Schedule%' OR TABLE_NAME LIKE '%Session%' ORDER BY TABLE_NAME"
  );
  console.log('=== TABLES ===');
  tables.forEach(r => console.log(' ', r.TABLE_NAME));

  // Check tbSchedule structure
  const [cols] = await s.query(
    "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbSchedule' ORDER BY ORDINAL_POSITION"
  );
  console.log('\n=== tbSchedule COLUMNS ===');
  cols.forEach(r => console.log(`  ${r.COLUMN_NAME} (${r.DATA_TYPE})`));

  // Check tbSessions structure
  const [cols2] = await s.query(
    "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbSessions' ORDER BY ORDINAL_POSITION"
  );
  console.log('\n=== tbSessions COLUMNS ===');
  cols2.forEach(r => console.log(`  ${r.COLUMN_NAME} (${r.DATA_TYPE})`));

  // Check if tbCalendar exists
  const [cal] = await s.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%Calendar%'"
  );
  console.log('\n=== tbCalendar exists? ===', cal.length > 0 ? 'YES' : 'NO');

  // Sample data from tbSchedule
  const [sched] = await s.query(
    "SELECT TOP 5 ID, Name, DateBegins, DateEnds, ClientID, Treatment, Status, Blocked, FirstSession FROM tbSchedule WHERE DateBegins > GETDATE() ORDER BY DateBegins"
  );
  console.log('\n=== tbSchedule SAMPLE (future) ===');
  sched.forEach(r => console.log(' ', JSON.stringify(r)));

  // Sample data from tbSessions
  const [sess] = await s.query(
    "SELECT TOP 5 ID, Name, DateBegins, DateEnds, ClientID, Treatment, Status, Blocked, FirstSession FROM tbSessions ORDER BY DateBegins DESC"
  );
  console.log('\n=== tbSessions SAMPLE (recent) ===');
  sess.forEach(r => console.log(' ', JSON.stringify(r)));

  await s.close();
})();
