#!/usr/bin/env node
// Consistent backup of the live database (safe while the server runs), plus an
// event log integrity check. Prints the latest log hash: writing it down
// somewhere else makes even a rewrite of the whole log detectable later.
//
//   node --disable-warning=ExperimentalWarning bin/backup.js [targetDir]
//   env: DB_PATH (database), BACKUP_DIR (default ./backups), BACKUP_KEEP (default 30)
//
// The database is opened as it is, never migrated: a backup taken right before a
// deploy must stay readable by the previous version of the code.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { verifyAuditChain } from '../src/domain/audit.js';

const { dbPath } = loadConfig();
if (!existsSync(dbPath)) {
  console.log(`No database at ${dbPath} yet, nothing to back up.`);
  process.exit(0);
}

const dir = resolve(process.argv[2] || process.env.BACKUP_DIR || 'backups');
const keep = Math.max(1, Number(process.env.BACKUP_KEEP || 30));
mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(dir, `szigzug-${stamp}.db`);
db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
const hasLog = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get();
const chain = hasLog ? verifyAuditChain(db) : { ok: true, count: 0, lastHash: '-' };
db.close();

const backups = readdirSync(dir).filter((name) => /^szigzug-.*\.db$/.test(name)).sort();
for (const old of backups.slice(0, Math.max(0, backups.length - keep))) rmSync(join(dir, old));

console.log(`Backup written: ${file}`);
console.log(chain.ok ? `Event log OK: ${chain.count} entries, last hash ${chain.lastHash}` : `EVENT LOG BROKEN at entry #${chain.brokenAt}`);
if (!chain.ok) process.exitCode = 2;
