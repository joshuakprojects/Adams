// Adds sample trucks, drivers and one job of each work order type for today, so you can try the board.
// Uses DATABASE_URL (PostgreSQL) if set, otherwise the local SQLite file.
const config = require('../src/config');
const { openDb } = require('../src/db');
const { createDispatch } = require('../src/dispatch');
const { seedDemo } = require('../src/demo');

(async () => {
  const db = await openDb(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : config.dbPath);
  const d = createDispatch(db);
  if (await seedDemo(d)) console.log('Seeded sample trucks, drivers and jobs starting', d.today());
  else console.log('Database already has drivers — not seeding.');
  await db.close();
})();
