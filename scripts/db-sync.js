#!/usr/bin/env node
/*
 * Bring the database this command can see up to date with the app (new tables and columns). Changes nothing else.
 *
 * Why: on Replit, Publish makes the live database match the editor's (development) database. If the app hasn't run
 * in the editor since an update, the editor's database is missing the new tables, and Publish offers to DELETE them
 * from the live database. Run this in the Shell after every update, before Republish:
 *
 *   git fetch origin main && git reset --hard FETCH_HEAD && npm run db:sync
 */
const { openDb } = require('../src/db');
const config = require('../src/config');

(async () => {
  const url = process.env.DATABASE_URL;
  const db = await openDb(url ? { url } : config.dbPath);
  const tables = db.kind === 'pg'
    ? (await db.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).map((r) => r.name)
    : (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY 1")).map((r) => r.name);
  console.log(`Database is up to date (${db.kind === 'pg' ? 'PostgreSQL' : 'SQLite'}, ${tables.length} tables).`);
  console.log('Now Republish. On the Publish screen, the database changes should only ADD things — never approve a DROP.');
  await db.close?.();
  process.exit(0);
})().catch((err) => {
  console.error('Could not update the database:', err.message);
  process.exit(1);
});
