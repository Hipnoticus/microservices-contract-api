const { Sequelize } = require('sequelize');
const s = new Sequelize({
  dialect: 'mssql', host: process.env.HOST, port: parseInt(process.env.SQL_PORT || '1433'),
  database: process.env.DB, username: process.env.USER, password: process.env.PASSWORD,
  logging: false, dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
});
(async () => {
  // Upcoming available slots (not blocked, no client assigned)
  const [slots] = await s.query(
    "SELECT TOP 20 ID, Name, DateBegins, DateEnds, Status, Blocked, ClientID FROM tbSchedule WHERE DateBegins > GETDATE() AND (Blocked = 0 OR Blocked IS NULL) AND (ClientID = 0 OR ClientID IS NULL) ORDER BY DateBegins"
  );
  console.log('=== UPCOMING AVAILABLE SLOTS ===');
  slots.forEach(r => {
    const db = new Date(r.DateBegins);
    const de = new Date(r.DateEnds);
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    console.log(`  ${dayNames[db.getDay()]} ${db.toISOString().substr(0,16)} - ${de.toISOString().substr(11,5)} Status=${r.Status} Client=${r.ClientID}`);
  });

  // Available slots by day of week
  const [byDay] = await s.query(
    "SELECT DATEPART(dw, DateBegins) as DayOfWeek, DATEPART(hh, DateBegins) as Hour, COUNT(*) as Total FROM tbSchedule WHERE DateBegins > GETDATE() AND (Blocked = 0 OR Blocked IS NULL) AND (ClientID = 0 OR ClientID IS NULL) GROUP BY DATEPART(dw, DateBegins), DATEPART(hh, DateBegins) ORDER BY DayOfWeek, Hour"
  );
  console.log('\n=== AVAILABLE SLOTS BY DAY+HOUR ===');
  const days = ['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  byDay.forEach(r => console.log(`  ${days[r.DayOfWeek]} ${r.Hour}:00 = ${r.Total} slots`));

  // Total available by day
  const [totals] = await s.query(
    "SELECT DATEPART(dw, DateBegins) as DayOfWeek, COUNT(*) as Total FROM tbSchedule WHERE DateBegins > GETDATE() AND (Blocked = 0 OR Blocked IS NULL) AND (ClientID = 0 OR ClientID IS NULL) GROUP BY DATEPART(dw, DateBegins) ORDER BY DayOfWeek"
  );
  console.log('\n=== TOTAL AVAILABLE BY DAY ===');
  totals.forEach(r => console.log(`  ${days[r.DayOfWeek]}: ${r.Total} slots`));

  await s.close();
})();
