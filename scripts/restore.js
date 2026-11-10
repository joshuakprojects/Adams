// Put a backup back into the database.
//
//   npm run restore -- list                     show the backups that are stored
//   npm run restore -- latest                   restore the newest stored backup
//   npm run restore -- 2026-11-09               restore the backup from that night
//   npm run restore -- path/to/file.json.gz     restore a downloaded copy (photos come from the backup store if it has them)
//
// It only restores into an EMPTY database (no drivers, no jobs). Add --force to wipe the current data first.
// Uses DATABASE_URL (PostgreSQL) if set, otherwise the local SQLite file — the same database the app uses.
const fs = require('node:fs');
const config = require('../src/config');
const { openDb } = require('../src/db');
const { restore, gunzipJson, chooseStorage, DB_PREFIX, PHOTO_PREFIX } = require('../src/backup');

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const what = args.find((a) => !a.startsWith('--'));
  if (!what) {
    console.log('Usage: npm run restore -- list | latest | YYYY-MM-DD | <file.json.gz> [--force]');
    process.exit(1);
  }
  const storage = chooseStorage();
  const stored = storage ? (await storage.list(DB_PREFIX)).sort() : [];
  if (what === 'list') {
    console.log(storage ? `Backups in ${storage.label}:` : 'Backups are off.');
    for (const n of stored) console.log('  ' + n.slice(DB_PREFIX.length).replace('.json.gz', ''));
    return;
  }
  let buf;
  if (fs.existsSync(what)) buf = fs.readFileSync(what);
  else {
    const name = what === 'latest' ? stored.at(-1) : `${DB_PREFIX}${what}.json.gz`;
    if (!name || !stored.includes(name)) throw new Error(`No stored backup "${what}". Try: npm run restore -- list`);
    console.log('Reading', name, 'from', storage.label);
    buf = await storage.get(name);
  }
  const backup = gunzipJson(buf);
  const db = await openDb(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : config.dbPath);
  try {
    const photoFor = storage ? async (id) => ((await storage.exists(PHOTO_PREFIX + id)) ? storage.get(PHOTO_PREFIX + id) : null) : null;
    const out = await restore(db, backup, { photoFor, force });
    console.log(`Restored the backup made ${backup.created_at}:`);
    for (const [t, n] of Object.entries(out.counts)) console.log(`  ${t}: ${n}`);
    console.log(`  ticket photos: ${out.photos}`);
    console.log('Log in with the office logins from the backup. Restart / republish the app.');
  } finally {
    await db.close();
  }
})().catch((err) => {
  console.error('Restore failed:', err.message);
  process.exit(1);
});
