import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbFile = process.env.DATABASE_PATH 
  ? path.resolve(process.cwd(), process.env.DATABASE_PATH)
  : path.join(__dirname, 'streetcode.sqlite');

fs.mkdirSync(path.dirname(dbFile), { recursive: true });

export const db = new DatabaseSync(dbFile);

// Enable WAL mode for high concurrency and Foreign Keys for relational integrity
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/**
 * Initialize schema if not already created
 */
export function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
}

/**
 * Execute a query that returns multiple rows
 * @param {string} sql 
 * @param {any[]} params 
 * @returns {any[]}
 */
export function query(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

/**
 * Execute a query that returns a single row or null
 * @param {string} sql 
 * @param {any[]} params 
 * @returns {any|null}
 */
export function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  const result = stmt.get(...params);
  return result !== undefined ? result : null;
}

/**
 * Execute an INSERT/UPDATE/DELETE query
 * @param {string} sql 
 * @param {any[]} params 
 * @returns {{ changes: number, lastInsertRowid: number|bigint }}
 */
export function run(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.run(...params);
}

/**
 * Run a transaction safely
 * @param {Function} fn 
 */
export function transaction(fn) {
  db.exec('BEGIN TRANSACTION;');
  try {
    const result = fn(db);
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}
