/**
 * Publishes the versioned e-mail templates in templates/email/<tbConfig Name>.html to tbConfig.Value.
 * The EmailAPI layout adds the logo, footer and year; these files carry only the content rows.
 *
 * Usage (env as the ContractAPI container: HOST, SQL_PORT, DB, USER, PASSWORD):
 *   bun scripts/sync-email-templates.js            # apply
 *   bun scripts/sync-email-templates.js --dry-run  # report only
 */
const fs = require('fs');
const path = require('path');
const { Sequelize, QueryTypes } = require('sequelize');

const dry = process.argv.includes('--dry-run');
const dir = path.join(__dirname, '..', 'templates', 'email');

(async () => {
  const db = new Sequelize({
    dialect: 'mssql',
    host: process.env.HOST || 'localhost',
    port: parseInt(process.env.SQL_PORT || '1433', 10),
    database: process.env.DB || 'Hipnoticus',
    username: process.env.USER || 'sa',
    password: process.env.PASSWORD || '',
    logging: false,
    dialectOptions: { options: { encrypt: false, trustServerCertificate: true } },
  });

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort()) {
    const name = file.replace(/\.html$/, '');
    const value = fs.readFileSync(path.join(dir, file), 'utf8');
    if (/[^\x00-\x7F]/.test(value)) throw new Error(`${file}: use HTML entities, tbConfig.Value is Latin1 text`);
    const rows = await db.query('SELECT ID FROM tbConfig WHERE Name = :name', { replacements: { name }, type: QueryTypes.SELECT });
    if (!rows.length) { console.log(`skip ${name}: not in tbConfig`); continue; }
    console.log(`${dry ? '[dry] ' : ''}#${rows[0].ID} ${name} <- ${value.length} chars`);
    if (!dry) await db.query('UPDATE tbConfig SET Value = :value WHERE Name = :name', { replacements: { name, value } });
  }
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
