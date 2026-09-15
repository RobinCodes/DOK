// Standings (Rulebook §7.2).
//
// Live totals are only visible inside the admin area. The public sees a
// snapshot the superadmin publishes after a program, so nobody can watch the
// scores move in real time and time their "last-minute" points tactically.

import { transaction } from '../db/database.js';
import { HttpError } from '../http/errors.js';
import { audit } from './audit.js';
import { parseText } from './validate.js';

/** Competition ranking: equal points share a rank and the next rank is skipped (1, 2, 2, 4). */
export function rankRows(rows) {
  // Ties are listed in natural class order (7.A before 10.A), not plain text order.
  const sorted = [...rows].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'hu', { numeric: true }));
  let rank = 0;
  return sorted.map((row, i) => {
    if (i === 0 || sorted[i - 1].points !== row.points) rank = i + 1;
    return { ...row, rank };
  });
}

export function liveStandings(db) {
  const rows = db
    .prepare(`
      SELECT c.id AS class_id, c.name, COALESCE(SUM(e.amount), 0) AS points
      FROM classes c LEFT JOIN entries e ON e.class_id = c.id AND e.voided_at IS NULL
      WHERE c.active = 1
      GROUP BY c.id`)
    .all();
  return rankRows(rows);
}

export function publishSnapshot(db, { actor, label, now, ip = '' }) {
  return transaction(db, () => {
    if (actor.role !== 'superadmin') throw new HttpError(403);
    const cleanLabel = parseText(label, { max: 80 });
    const { lastInsertRowid: id } = db.prepare('INSERT INTO snapshots (label, created_by, created_at) VALUES (?, ?, ?)').run(cleanLabel, actor.id, now);
    const rows = liveStandings(db);
    const insert = db.prepare('INSERT INTO snapshot_rows (snapshot_id, class_id, points, rank) VALUES (?, ?, ?, ?)');
    for (const row of rows) insert.run(id, row.class_id, row.points, row.rank);
    audit(db, { actor, action: 'snapshot.publish', subject: `snapshot:${id}`, details: { label: cleanLabel, rows: rows.map((r) => [r.name, r.points]) }, ip, at: now });
    return { id };
  });
}

export function latestPublicSnapshot(db, top) {
  const snapshot = db.prepare('SELECT * FROM snapshots WHERE hidden = 0 ORDER BY id DESC LIMIT 1').get();
  if (!snapshot) return null;
  const rows = db
    .prepare(`
      SELECT s.rank, s.points, c.name FROM snapshot_rows s JOIN classes c ON c.id = s.class_id
      WHERE s.snapshot_id = ? AND s.rank <= ? ORDER BY s.rank, c.sort, c.name`)
    .all(snapshot.id, top);
  return { ...snapshot, rows };
}

export function listSnapshots(db) {
  return db.prepare('SELECT s.*, u.username AS creator FROM snapshots s JOIN users u ON u.id = s.created_by ORDER BY s.id DESC').all();
}
