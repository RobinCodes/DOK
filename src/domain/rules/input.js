// Input rules: every recorded row must describe a real class, a real person
// and a number inside the configured limits.

import { ValidationError } from '../../http/errors.js';
import { getClass } from '../catalog.js';
import { isPlausibleName, nameKey } from '../names.js';

/**
 * Points go to an existing, active class picked from the list; a mistyped or
 * made-up class can never receive points. Rulebook §3.2, §3.3.
 */
export function classIsValid(ctx) {
  for (const row of ctx.rows) {
    const cls = getClass(ctx.db, row.classId);
    if (!cls || !cls.active) throw new ValidationError('error.classInvalid');
    row.class = cls;
  }
}

/**
 * Person-level reasons need the student's name, so every point can be traced
 * to someone who can be asked about it. Names must contain letters and fit the
 * length limit. Rulebook §3.2.
 */
export function personIsValid(ctx) {
  for (const row of ctx.rows) {
    if (!row.personName) {
      if (ctx.reason.needs_person) throw new ValidationError('error.nameRequired');
      continue;
    }
    if (!isPlausibleName(row.personName)) throw new ValidationError('error.nameInvalid');
  }
}

/**
 * Conflict of interest: nobody may award points to themselves. A namesake in
 * another class is still allowed when the organizer's own class is known.
 * Rulebook §2.3.
 */
export function notSelfAward(ctx) {
  const own = nameKey(ctx.actor.display_name);
  const self = ctx.rows.some((row) => row.personKey === own && (!ctx.actor.class_id || ctx.actor.class_id === row.classId));
  if (own && self) throw new ValidationError('error.selfAward');
}

/**
 * Every amount is a whole number between the reason's minimum and maximum
 * (e.g. the Golden Snitch is exactly 60). This alone stops "a million points"
 * typos and fantasies. Rulebook §3.4.
 */
export function amountWithinLimits(ctx) {
  const { min_points: min, max_points: max } = ctx.reason;
  for (const row of ctx.rows) {
    if (!Number.isSafeInteger(row.amount) || row.amount < min || row.amount > max) {
      throw new ValidationError('error.amountOutOfRange', { min, max, amount: row.amount });
    }
  }
}

/**
 * Formula inputs (stamps, people, minutes, participants, ...) are non-negative
 * whole numbers. A reason parameter named max_<input> caps that input, e.g.
 * max_minutes = 240 means nobody can claim a 1000-minute darts session; a
 * global ceiling applies to every input. Rulebook §3.4, §4.1, §4.3.
 */
export function inputsWithinLimits(ctx) {
  const globalMax = ctx.settings.get('rules.max_input');
  for (const row of ctx.rows) {
    for (const [name, value] of Object.entries(row.inputs)) {
      const max = Math.min(ctx.reason.params[`max_${name}`] ?? globalMax, globalMax);
      if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new ValidationError('error.inputOutOfRange', { name, max });
    }
  }
}
