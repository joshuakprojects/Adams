// Put a backup back into the database.
//
//   npm run restore -- list                     show the stored backups (nightly and hourly)
//   npm run restore -- latest                   restore the newest stored backup
//   npm run restore -- 2026-11-09               restore that night's backup
//   npm run restore -- 2026-11-09-14            restore the 2 PM hourly backup from that day
//   npm run restore -- path/to/backup.zip       restore a "Download a copy" zip: database AND photos (e.g. from the office hard drive)
//   npm run restore -- path/to/file.json.gz     restore a database-only file (photos come from the backup store if it has them)
//   add --from server                           use your own server instead of Replit App Storage
//
// It only restores into an EMPTY database (no drivers, no jobs). Add --force to wipe the current data first.
// Uses DATABASE_URL (PostgreSQL) if set, otherwise the local SQLite file — the same database the app uses.
const fs = require('node:fs');
const config = require('../src/config');
const { openDb } = require('../src/db');
const { restore, gunzipJson, chooseStorage, loadZipBackup, DB_PREFIX, HOURLY_PREFIX, PHOTO_PREFIX } = require('../src/backup');
const { serverTarget } = require('../src/backupTargets');

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const fromServer = args.includes('server') && args[args.indexOf('server') - 1] === '--from';
  const what = args.find((a, i) => !a.startsWith('--') && !(a === 'server' && args[i - 1] === '--from'));
  if (!what) {
    console.log('Usage: npm run restore -- list | latest | YYYY-MM-DD | YYYY-MM-DD-HH | <backup.zip> | <file.json.gz> [--from server] [--force]');
    process.exit(1);
  }
  const storage = fromServer ? serverTarget() : chooseStorage();
  if (fromServer && !storage) throw new Error('BACKUP_SERVER_URL is not set');
  // Stored copies, oldest first: a nightly copy counts as 02:00 that day.
  const stamp = (n) => (/(\d{4}-\d{2}-\d{2}-\d{2})\.json\.gz$/.exec(n)?.[1]) || `${/(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(n)?.[1]}-02`;
  const stored = storage && !fs.existsSync(what)
    ? [...await storage.list(DB_PREFIX), ...await storage.list(HOURLY_PREFIX)].sort((a, b) => stamp(a).localeCompare(stamp(b)))
    : [];
  if (what === 'list') {
    console.log(storage ? `Backups in ${storage.label}:` : 'Backups are off.');
    for (const n of stored) console.log(`  ${n.startsWith(HOURLY_PREFIX) ? 'hourly ' : 'nightly'}  ${stamp(n).replace(/-(\d\d)$/, ' $1:00').replace(/ 02:00$/, '')}  (${n})`);
    return;
  }
  let backup;
  let photoFor = null;
  let zip = null;
  if (fs.existsSync(what) && /\.zip$/i.test(what)) {
    zip = loadZipBackup(what);
    backup = zip.backup;
    photoFor = zip.photoFor;
    console.log(`Reading ${what}: database and ${zip.photoCount} photos`);
  } else {
    let buf;
    if (fs.existsSync(what)) buf = fs.readFileSync(what);
    else {
      const name = what === 'latest' ? stored.at(-1)
        : /^\d{4}-\d{2}-\d{2}-\d{2}$/.test(what) ? `${HOURLY_PREFIX}${what}.json.gz` : `${DB_PREFIX}${what}.json.gz`;
      if (!name || !stored.includes(name)) throw new Error(`No stored backup "${what}". Try: npm run restore -- list`);
      console.log('Reading', name, 'from', storage.label);
      buf = await storage.get(name);
    }
    backup = gunzipJson(buf);
    if (storage) photoFor = async (id) => ((await storage.exists(PHOTO_PREFIX + id)) ? storage.get(PHOTO_PREFIX + id) : null);
  }
  const db = await openDb(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : config.dbPath);
  try {
    const out = await restore(db, backup, { photoFor, force });
    console.log(`Restored the backup made ${backup.created_at}:`);
    for (const [t, n] of Object.entries(out.counts)) console.log(`  ${t}: ${n}`);
    console.log(`  ticket photos: ${out.photos}`);
    console.log('Log in with the office logins from the backup. Restart / republish the app.');
  } finally {
    zip?.close();
    await db.close();
  }
})().catch((err) => {
  console.error('Restore failed:', err.message);
  process.exit(1);
});
