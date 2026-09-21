/**
 * One-command development setup:  npm run setup
 *  1. checks Node's version (the database uses node:sqlite, built in from Node 22.13)
 *  2. writes .env with freshly generated secrets, if there is none
 *  3. installs dependencies, if needed
 *  4. creates and seeds the demo database, if there is none
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) { console.error(`Node 22.13 or newer is required (you have ${process.versions.node}).`); process.exit(1); }

const envFile = path.join(root, '.env');
if (!fs.existsSync(envFile)) {
  const rnd = () => crypto.randomBytes(32).toString('hex');
  let t = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const k of ['JWT_SECRET', 'LICENCE_CODE_KEY', 'MOMO_WEBHOOK_SECRET']) t = t.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${rnd()}`);
  fs.writeFileSync(envFile, t, { mode: 0o600 });
  console.log('Wrote .env with new secrets.');
}
if (!fs.existsSync(path.join(root, 'node_modules', 'express'))) { console.log('Installing dependencies…'); execSync('npm install', { cwd: root, stdio: 'inherit' }); }
const db = path.join(root, 'apps/api/data/streetcode.sqlite');
if (!fs.existsSync(db)) execSync('node apps/api/scripts/seed.js', { cwd: root, stdio: 'inherit' });
console.log('\nReady. Start it with:  npm run dev\n  Website  http://localhost:3000/\n  App      http://localhost:3000/app/\n  Command  http://localhost:3000/command/\n');
