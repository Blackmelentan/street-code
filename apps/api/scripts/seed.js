import fs from 'node:fs';
import { config } from '../src/config.js';
import { openDb, closeDb, one } from '../src/db/database.js';
import { seed, DEMO_PASSWORD } from '../src/db/seed.js';

if (process.argv.includes('--reset')) {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(config.dbFile + suffix); } catch { /* not there */ } }
  console.log('Database reset.');
}
openDb();
if (one('SELECT COUNT(*) AS n FROM users').n > 0) {
  console.log('The database already has data. Run "npm run reset" to wipe it and re-seed.');
  process.exit(0);
}
seed({ log: console.log });
console.log(`\nDone. Sign in with any demo phone number and the password "${DEMO_PASSWORD}".\nList them at GET /api/dev/accounts.`);
