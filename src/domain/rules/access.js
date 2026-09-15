// Access rules: who may record what, and when.

import { canAwardPoints, featureOn, isSuperadmin } from '../../auth/roles.js';
import { HttpError, ValidationError } from '../../http/errors.js';

/**
 * Only organizer accounts award points, and casino staff never do: they handle
 * chips, and chips become points only through the superadmin's conversion.
 * Keeping the two money flows apart means nobody can both run a table and
 * top up a class. Rulebook §2.2, §5.8.
 */
export function actorMayAward(ctx) {
  if (!canAwardPoints(ctx.actor)) throw new HttpError(403, 'error.casinoCannotAward');
  if (!featureOn(ctx.settings, ctx.actor, 'features.points')) throw new HttpError(403, 'error.featureOff');
}

/**
 * Points can only be recorded while a program is open. Closing a program
 * freezes its results, so nobody can "top up" a class after the standings
 * were announced. The superadmin can still fix mistakes (logged). Rulebook §3.6.
 */
export function programIsOpen(ctx) {
  if (isSuperadmin(ctx.actor)) return;
  if (!ctx.program || ctx.program.status !== 'open') throw new ValidationError('error.programNotOpen');
}

/**
 * Optional stricter version of the above: if the program has a start and end
 * time and the switch is on, entries outside that window are refused.
 * Rulebook §3.6.
 */
export function withinTimeWindow(ctx) {
  if (isSuperadmin(ctx.actor) || !ctx.settings.get('rules.enforce_time_window')) return;
  const { starts_at: start, ends_at: end } = ctx.program;
  if ((start && ctx.now < start) || (end && ctx.now > end)) throw new ValidationError('error.outsideTimeWindow');
}

/**
 * The reason must come from the program's active list (an organizer can't
 * invent a justification), and the module behind it must be switched on.
 * Timer entries are not re-checked against the timer switch when stopped:
 * switching the timer off mid-event must not destroy minutes already played.
 * Rulebook §3.2, §4.2, §4.3, §4.6.
 */
export function reasonIsUsable(ctx) {
  const { reason, program, actor, settings, source } = ctx;
  if (!reason.active || reason.program_id !== program.id) throw new ValidationError('error.reasonUnavailable');
  if (reason.kind === 'casino') throw new ValidationError('error.reasonNotAwardable');
  const switchFor = {
    style: 'features.style_points',
    pool: 'features.pool',
    minutes: source === 'timer' ? null : 'features.manual_minutes',
  }[reason.kind];
  if (switchFor && !featureOn(settings, actor, switchFor)) throw new HttpError(403, 'error.featureOff');
}

/**
 * Storno and correction (Rulebook §3.5):
 *  - organizers may undo or fix only their OWN entries, only while the program
 *    is open, and only if the storno/correction switch is on;
 *  - group awards can't be "corrected" row by row (the pool limit applies to
 *    the whole group), only voided and recorded again;
 *  - superadmin adjustments and casino conversions are superadmin-only;
 *  - the superadmin may void anything at any time; it is all logged.
 */
export function mayModifyEntry({ actor, settings, entry, program, action }) {
  if (entry.voided_at) throw new ValidationError('error.alreadyVoided');
  if (action === 'correct' && (entry.batch || !entry.reason_id)) throw new ValidationError('error.cannotCorrect');
  if (isSuperadmin(actor)) return;
  if (entry.source === 'adjustment' || entry.source === 'casino') throw new HttpError(403);
  if (entry.created_by !== actor.id) throw new HttpError(403, 'error.notYourEntry');
  if (!canAwardPoints(actor)) throw new HttpError(403, 'error.casinoCannotAward');
  const key = action === 'correct' ? 'features.corrections' : 'features.storno';
  if (!settings.get(key)) throw new HttpError(403, 'error.featureOff');
  if (!program || program.status !== 'open') throw new ValidationError('error.programNotOpen');
}
