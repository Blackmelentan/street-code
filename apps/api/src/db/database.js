import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let db = null;
const stmtCache = new Map();

/** node:sqlite rejects undefined and booleans; normalise so callers can stay tidy. */
const norm = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export function openDb(file = config.dbFile) {
  if (db) closeDb();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate();
  return db;
}

export function closeDb() {
  if (db) { try { db.close(); } catch { /* already closed */ } }
  db = null;
  stmtCache.clear();
}

export function getDb() {
  if (!db) openDb();
  return db;
}

/** Apply any migrations/*.sql not yet recorded. Files run in name order, each in a transaction. */
function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  const dir = path.join(here, 'migrations');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${e.message}`);
    }
  }
}

function stmt(sql) {
  const d = getDb();
  let s = stmtCache.get(sql);
  if (!s) { s = d.prepare(sql); stmtCache.set(sql, s); }
  return s;
}

export const all = (sql, params = []) => stmt(sql).all(...norm(params));
export const one = (sql, params = []) => stmt(sql).get(...norm(params)) ?? null;
export const run = (sql, params = []) => stmt(sql).run(...norm(params));

/** Run fn inside a transaction. Nested calls join the outer transaction. */
let depth = 0;
export function tx(fn) {
  const d = getDb();
  if (depth > 0) return fn();
  d.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

export const nowIso = () => new Date().toISOString();
