// Opens the SQLite database, applies migrations and provides a transaction helper.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './schema.js';
import { seed } from './seed.js';

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  if (migrate(db).fresh) seed(db);
  return db;
}

const depths = new WeakMap();

/**
 * Runs fn atomically. Nested calls become savepoints, so domain operations
 * compose (a correction = void + create, all or nothing).
 *
 * fn must be synchronous: node:sqlite is synchronous and Node runs one
 * request's JavaScript at a time, so a check-then-insert inside fn can never
 * interleave with another request. That is what makes budgets race-free.
 */
export function transaction(db, fn) {
  const depth = depths.get(db) ?? 0;
  const savepoint = `sp${depth}`;
  db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  depths.set(db, depth + 1);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('transaction callbacks must be synchronous');
    db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (err) {
    db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
    throw err;
  } finally {
    depths.set(db, depth);
  }
}

export const nowIso = (clock = Date.now) => new Date(clock()).toISOString();
