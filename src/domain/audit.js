// The event log ("eseménynapló"), Rulebook §3.7.
//
// Every meaningful action (award, storno, correction, login, setting change,
// casino record, ...) is appended here. Two protections make it trustworthy:
//  1. SQLite triggers reject any UPDATE or DELETE on audit_log (see db/schema.js),
//     so not even the superadmin can rewrite it through the app.
//  2. Each row stores the SHA-256 hash of its content plus the previous row's
//     hash. Editing the database file by hand breaks the chain, and
//     verifyAuditChain() pinpoints the first tampered row.

import { createHash } from 'node:crypto';

const GENESIS = '0'.repeat(64);
export const CONSOLE = { id: null, username: 'console' };
export const ANONYMOUS = { id: null, username: '-' };

function hashRow(row) {
  const fields = [row.prev_hash, row.created_at, row.actor_id ?? '', row.actor, row.action, row.subject, row.details, row.ip];
  return createHash('sha256').update(fields.join('')).digest('hex');
}

export function audit(db, { actor, action, subject = '', details = {}, ip = '', at = new Date().toISOString() }) {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  const row = {
    created_at: at,
    actor_id: actor.id ?? null,
    actor: actor.username,
    action,
    subject,
    details: JSON.stringify(details),
    ip,
    prev_hash: last ? last.hash : GENESIS,
  };
  row.hash = hashRow(row);
  db.prepare(`
    INSERT INTO audit_log (created_at, actor_id, actor, action, subject, details, ip, prev_hash, hash)
    VALUES ($created_at, $actor_id, $actor, $action, $subject, $details, $ip, $prev_hash, $hash)`).run(row);
}

export function verifyAuditChain(db) {
  let prev = GENESIS;
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
  for (const row of rows) {
    if (row.prev_hash !== prev || hashRow(row) !== row.hash) return { ok: false, count: rows.length, brokenAt: row.id };
    prev = row.hash;
  }
  return { ok: true, count: rows.length, lastHash: prev };
}
