// Check-in/check-out timers for participation points (Rulebook §4.3).
//
// Instead of trusting a typed number of minutes, the organizer taps "start"
// when a student sits down and "stop" when they leave. The server measures
// the time, so minutes can't be inflated, and a unique database index makes
// it impossible for one student to be "playing" at two stations at once.

import { featureOn, isSuperadmin } from '../auth/roles.js';
import { transaction } from '../db/database.js';
import { HttpError, ValidationError } from '../http/errors.js';
import { audit } from './audit.js';
import { createAward, parseClassId } from './awards.js';
import { getProgram, getReason } from './catalog.js';
import { cleanName, nameKey } from './names.js';
import { AWARD_ACCESS_RULES, finishRules, runRules } from './rules/index.js';
import { classIsValid, notSelfAward, personIsValid } from './rules/input.js';
import { nameClassConsistency, ownClassPolicy } from './rules/integrity.js';
import { minutesBetween } from './time.js';

export function listRunningTimers(db) {
  return db
    .prepare(`
      SELECT t.*, c.name AS class_name, r.name_hu AS reason_hu, r.name_en AS reason_en, u.username AS starter
      FROM timers t JOIN classes c ON c.id = t.class_id JOIN reasons r ON r.id = t.reason_id JOIN users u ON u.id = t.started_by
      WHERE t.ended_at IS NULL ORDER BY t.started_at`)
    .all();
}

export function startTimer(db, settings, { actor, reasonId, classId, name, confirmed = false, now, ip = '' }) {
  return transaction(db, () => {
    const reason = getReason(db, reasonId);
    if (!reason || reason.kind !== 'minutes') throw new HttpError(404);
    // The timer module must be on, and the organizer must not have switched it off for themselves.
    if (!featureOn(settings, actor, 'features.timer') || (!isSuperadmin(actor) && !actor.use_timer)) {
      throw new HttpError(403, 'error.featureOff');
    }
    const personName = cleanName(name);
    const ctx = {
      db,
      settings,
      actor,
      reason: { ...reason, needs_person: 1 },
      program: getProgram(db, reason.program_id),
      source: 'timer',
      now,
      confirmed,
      warnings: [],
      rows: [{ classId: parseClassId(classId), personName, personKey: nameKey(personName), inputs: {} }],
    };
    runRules(AWARD_ACCESS_RULES, ctx);
    runRules([classIsValid, personIsValid, notSelfAward, ownClassPolicy, nameClassConsistency], ctx);
    const [row] = ctx.rows;
    if (db.prepare('SELECT 1 FROM timers WHERE person_key = ? AND ended_at IS NULL').get(row.personKey)) {
      throw new ValidationError('error.timerRunning', { name: row.personName });
    }
    finishRules(ctx);

    const { lastInsertRowid: id } = db
      .prepare(`INSERT INTO timers (reason_id, class_id, person_name, person_key, started_by, started_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(reason.id, row.classId, row.personName, row.personKey, actor.id, now);
    audit(db, { actor, action: 'timer.start', subject: `timer:${id}`, details: { reason: reason.id, class: row.class.name, name: row.personName }, ip, at: now });
    return { id };
  });
}

function runningTimer(db, timerId) {
  const timer = db.prepare('SELECT * FROM timers WHERE id = ?').get(timerId);
  if (!timer) throw new HttpError(404);
  if (timer.ended_at) throw new ValidationError('error.timerNotRunning');
  return timer;
}

/**
 * Stops a timer and records the measured minutes. Any organizer at the station
 * may stop it (people take turns), because the time is measured by the server,
 * not claimed by whoever presses the button. A forgotten timer is capped at the
 * reason's max_minutes rather than refused, and the cap is noted for review.
 */
export function stopTimer(db, settings, { actor, timerId, now, ip = '' }) {
  return transaction(db, () => {
    const timer = runningTimer(db, timerId);
    const reason = getReason(db, timer.reason_id);
    const measured = minutesBetween(timer.started_at, now);
    const cap = reason.params.max_minutes;
    const minutes = cap !== undefined ? Math.min(measured, cap) : measured;
    if (minutes < 1) throw new ValidationError('error.timerTooShort');

    const result = createAward(db, settings, {
      actor,
      reasonId: reason.id,
      input: { classId: timer.class_id, name: timer.person_name, inputs: { minutes }, note: minutes < measured ? `⏱ ${measured} → ${minutes} min` : '' },
      confirmed: true, // warnings were already confirmed when the timer started
      source: 'timer',
      now,
      ip,
    });
    db.prepare(`UPDATE timers SET ended_by = ?, ended_at = ?, outcome = 'stopped', entry_id = ? WHERE id = ?`).run(actor.id, now, result.ids[0], timer.id);
    audit(db, { actor, action: 'timer.stop', subject: `timer:${timer.id}`, details: { measured, minutes, entry: result.ids[0] }, ip, at: now });
    return { minutes, measured, entryId: result.ids[0], amount: result.total };
  });
}

/** Cancelling awards nothing, so only the organizer who started the timer (or the superadmin) may do it. */
export function cancelTimer(db, { actor, timerId, now, ip = '' }) {
  return transaction(db, () => {
    const timer = runningTimer(db, timerId);
    if (timer.started_by !== actor.id && !isSuperadmin(actor)) throw new HttpError(403, 'error.notYourTimer');
    db.prepare(`UPDATE timers SET ended_by = ?, ended_at = ?, outcome = 'cancelled' WHERE id = ?`).run(actor.id, now, timer.id);
    audit(db, { actor, action: 'timer.cancel', subject: `timer:${timer.id}`, details: { minutes: minutesBetween(timer.started_at, now) }, ip, at: now });
    return { id: timer.id };
  });
}
