// Usage: npm run add-user -- email@adamsbros.ca "Full Name" password
// Uses DATABASE_URL (PostgreSQL) if set, otherwise the local SQLite file.
const config = require('../src/config');
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');

const [email, name, password] = process.argv.slice(2);
if (!email || !password) {
  console.log('Usage: npm run add-user -- office@adamsbros.ca "Office Name" "a-good-password"');
  process.exit(1);
}
(async () => {
  const db = await openDb(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : config.dbPath);
  await createUser(db, { email, name, password });
  console.log(`Login ready for ${email}`);
  await db.close();
})();
