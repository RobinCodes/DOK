// Casino rules (Rulebook §5). Inside the casino only chips exist, so these
// rules protect the chips: who may record them, how many a person can get,
// and that no chips appear out of nowhere.

import { featureOn, isCasinoStaff, isSuperadmin } from '../../auth/roles.js';
import { HttpError, ValidationError } from '../../http/errors.js';

/**
 * Only casino staff (and the superadmin) record chips. Staff physically take
 * the chips at cash-out, so the person typing the number is the person holding
 * them. Rulebook §5.8.
 */
export function actorIsCasinoStaff(ctx) {
  if (!isCasinoStaff(ctx.actor) && !isSuperadmin(ctx.actor)) throw new HttpError(403, 'error.casinoStaffOnly');
  if (!featureOn(ctx.settings, ctx.actor, 'casino.enabled')) throw new HttpError(403, 'error.featureOff');
}

/** The superadmin decides which casino method is in use; each mode has a switch. Rulebook §5.2. */
export function requireCasinoMode(ctx, key) {
  if (!ctx.settings.get(key)) throw new HttpError(403, 'error.featureOff');
}

/**
 * Everyone starts with the same starting stack, and gets it at most
 * casino.max_visits times per program; a person can't hold two open visits.
 * Without this, leaving and re-entering would print free chips. Rulebook §5.3.
 */
export function visitQuota(ctx) {
  const max = ctx.settings.get('casino.max_visits');
  for (const row of ctx.rows) {
    const { n } = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM casino_visits WHERE program_id = ? AND person_key = ? AND voided_at IS NULL')
      .get(ctx.program.id, row.personKey);
    if (n >= max) throw new ValidationError('error.visitLimit', { max });
  }
}

/**
 * Player-versus-player games only move chips between players, so every round
 * must add up to exactly zero. House games need at least one player result.
 * No zero results, no player twice. Rulebook §5.4.
 */
export function roundIsBalanced(game, results) {
  const ids = results.map((r) => r.visitId);
  if (new Set(ids).size !== ids.length) throw new ValidationError('error.roundDuplicatePlayer');
  if (game.kind === 'pvp') {
    if (results.length < 2) throw new ValidationError('error.roundNeedsPlayers');
    if (results.reduce((sum, r) => sum + r.delta, 0) !== 0) throw new ValidationError('error.roundNotZeroSum');
  } else if (results.length < 1) {
    throw new ValidationError('error.roundNeedsPlayers');
  }
}

/**
 * Nobody can lose chips they don't have: every balance stays at zero or above,
 * checked in the order the games happened. Rulebook §5.4.
 */
export function balanceNeverNegative(startChips, deltas) {
  let balance = startChips;
  for (const delta of deltas) {
    balance += delta;
    if (balance < 0) throw new ValidationError('error.balanceNegative');
  }
  return balance;
}

/**
 * In detailed mode the house knows every result, so the chips handed back at
 * cash-out must equal the recorded balance exactly; any difference means a
 * missing record or chips passed under the table. Rulebook §5.5.
 */
export function cashoutMatchesBalance(chips, balance) {
  if (chips !== balance) throw new ValidationError('error.cashoutMismatch', { balance });
}
