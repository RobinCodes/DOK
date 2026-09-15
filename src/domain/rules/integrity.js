// Integrity rules: conflicts of interest, identity consistency and duplicates.

import { isSuperadmin } from '../../auth/roles.js';
import { ValidationError } from '../../http/errors.js';

/**
 * Organizers are students too, so awarding their own class is allowed by
 * default and only weighs more in the suspicion score ("flag"). The superadmin
 * can forbid it outright ("block"). Rulebook §2.3.
 */
export function ownClassPolicy(ctx) {
  if (isSuperadmin(ctx.actor) || !ctx.actor.class_id) return;
  if (ctx.settings.get('rules.own_class') !== 'block') return;
  if (ctx.rows.some((row) => row.classId === ctx.actor.class_id)) throw new ValidationError('error.ownClassBlocked');
}

/** Finds the same student (by name key) already recorded in a different class, anywhere in the system. */
export function findPersonInOtherClass(db, personKey, classId) {
  return db
    .prepare(`
      SELECT c.name AS class_name FROM (
        SELECT class_id FROM entries WHERE person_key = $key AND voided_at IS NULL
        UNION SELECT class_id FROM timers WHERE person_key = $key AND outcome IS NOT 'cancelled'
        UNION SELECT class_id FROM casino_visits WHERE person_key = $key AND voided_at IS NULL
      ) seen JOIN classes c ON c.id = seen.class_id
      WHERE seen.class_id <> $classId
      LIMIT 1`)
    .get({ key: personKey, classId });
}

/**
 * One student belongs to one class. If the same name was already recorded in
 * a different class, it is either a namesake or someone steering points to the
 * wrong class. Depending on the setting it is blocked, needs a confirmation
 * (which is logged), or is allowed. Rulebook §3.3.
 */
export function nameClassConsistency(ctx) {
  const mode = ctx.settings.get('rules.name_class_conflict');
  if (mode === 'allow') return;
  for (const row of ctx.rows) {
    if (!row.personKey) continue;
    const other = findPersonInOtherClass(ctx.db, row.personKey, row.classId);
    if (!other) continue;
    const vars = { name: row.personName, className: other.class_name };
    if (mode === 'block') throw new ValidationError('error.nameClassConflict', vars);
    ctx.warnings.push({ key: 'warning.nameClassConflict', vars });
  }
}

/**
 * Double taps and "did it save?" retries create duplicates. The same organizer
 * recording the same reason for the same person (or class) within a short
 * time has to confirm it was intended. Rulebook §3.8.
 */
export function recentDuplicate(ctx) {
  const seconds = ctx.settings.get('rules.duplicate_seconds');
  if (seconds === 0 || ctx.source === 'timer') return;
  const since = new Date(Date.parse(ctx.now) - seconds * 1000).toISOString();
  const find = ctx.db.prepare(`
    SELECT id FROM entries
    WHERE created_by = ? AND reason_id = ? AND class_id = ? AND person_key = ? AND created_at >= ? AND voided_at IS NULL
    LIMIT 1`);
  if (ctx.rows.some((row) => find.get(ctx.actor.id, ctx.reason.id, row.classId, row.personKey, since))) {
    ctx.warnings.push({ key: 'warning.recentDuplicate', vars: { seconds } });
  }
}
