const { Sequelize } = require('sequelize');
const s = new Sequelize({
  dialect: 'mssql', host: process.env.HOST, port: parseInt(process.env.SQL_PORT || '1433'),
  database: process.env.DB, username: process.env.USER, password: process.env.PASSWORD,
  logging: false, dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});
(async () => {
  // Check the SessaoSlot table structure - these are the available time slots
  const [cols] = await s.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%Slot%' OR TABLE_NAME LIKE '%slot%' ORDER BY TABLE_NAME"
  );
  console.log('=== SLOT TABLES ===');
  cols.forEach(c => console.log(c.TABLE_NAME));

  // Check tbConfig for scheduling-related settings
  const [config] = await s.query(
    "SELECT TOP 20 * FROM tbConfig WHERE Name LIKE '%schedule%' OR Name LIKE '%session%' OR Name LIKE '%horario%' OR Name LIKE '%appointment%' OR Name LIKE '%slot%' OR Name LIKE '%days%' ORDER BY Name"
  );
  console.log('\n=== SCHEDULING CONFIG ===');
  config.forEach(c => console.log(`  ${c.Name} = ${String(c.Value || c.Description || '').substring(0, 100)}`));

  // Check the actual schedule data pattern - what days/hours are used
  const [pattern] = await s.query(
    "SELECT DATENAME(dw, DateBegins) as DayName, DATEPART(hh, DateBegins) as Hour, DATEPART(mi, DateBegins) as Minute, COUNT(*) as Total FROM tbSchedule WHERE ClientID IS NOT NULL AND ClientID > 0 GROUP BY DATENAME(dw, DateBegins), DATEPART(hh, DateBegins), DATEPART(mi, DateBegins) ORDER BY Total DESC"
  );
  console.log('\n=== MOST COMMON BOOKING PATTERNS ===');
  pattern.slice(0, 15).forEach(p => console.log(`  ${p.DayName} ${p.Hour}:${String(p.Minute).padStart(2,'0')} = ${p.Total} bookings`));

  // Check SessaoSlot table if it exists
  try {
    const [slotCols] = await s.query(
      "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='tbSessoesSlots' ORDER BY ORDINAL_POSITION"
    );
    if (slotCols.length > 0) {
      console.log('\n=== tbSessoesSlots COLUMNS ===');
      slotCols.forEach(c => console.log(`  ${c.COLUMN_NAME} ${c.DATA_TYPE}`));
      const [slots] = await s.query("SELECT TOP 10 * FROM tbSessoesSlots ORDER BY ID DESC");
      console.log('\n=== tbSessoesSlots SAMPLE ===');
      slots.forEach(sl => console.log(JSON.stringify(sl)));
    }
  } catch(e) {}

  await s.close();
})();
