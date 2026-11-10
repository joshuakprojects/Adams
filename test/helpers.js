// A fresh, empty database for each test: in-memory SQLite by default, or a throwaway schema in
// PostgreSQL when TEST_DATABASE_URL is set (npm run test:pg), so both databases run the same tests.
const crypto = require('node:crypto');
const { openDb } = require('../src/db');

async function testDb(t) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openDb(':memory:');
  const pg = require('pg');
  const schema = 'test_' + crypto.randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const sep = url.includes('?') ? '&' : '?';
  const db = await openDb({ url: `${url}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}` });
  const cleanup = async () => {
    await db.close();
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`DROP SCHEMA ${schema} CASCADE`);
    await c.end();
  };
  if (t && t.after) t.after(cleanup);
  else process.on('beforeExit', () => {});
  db.cleanup = cleanup;
  return db;
}

module.exports = { testDb };
