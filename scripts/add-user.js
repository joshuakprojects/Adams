// Usage: npm run add-user -- email@adamsbros.ca "Full Name" password [office|dispatcher|admin]
// Creates the login, or resets the password of an existing one. Default role: admin.
// Uses DATABASE_URL (PostgreSQL) if set, otherwise the local SQLite file.
const config = require('../src/config');
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');

const [email, name, password, role = 'admin'] = process.argv.slice(2);
if (!email || !password) {
  console.log('Usage: npm run add-user -- josh@adamsbros.ca "Josh" "a-good-password" [office|dispatcher|admin]');
  process.exit(1);
}
(async () => {
  const db = await openDb(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : config.dbPath);
  await createUser(db, { email, name, password, role });
  console.log(`Login ready for ${email} (${role})`);
  await db.close();
})().catch((err) => { console.error(err.message); process.exit(1); });
