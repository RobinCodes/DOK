// Anti-cheat rules, "baked into the fabric" of every write.
//
// Each rule is a small function that receives a context object and either
// returns (OK), throws (hard violation: the write is refused), or pushes a
// warning (soft violation: the organizer must confirm, and the confirmation
// itself is written to the event log). Every rule documents WHY it exists and
// which section of the detailed rulebook it enforces.
//
// Rules only prevent what is provably against the rules. Patterns that are
// merely unusual are left to the suspicion score (domain/suspicion).

import { actorMayAward, programIsOpen, reasonIsUsable, withinTimeWindow } from './access.js';
import { amountWithinLimits, classIsValid, inputsWithinLimits, notSelfAward, personIsValid } from './input.js';
import { nameClassConsistency, ownClassPolicy, recentDuplicate } from './integrity.js';
import { entryCountLimits, poolFits, styleBudgetSuffices, styleRecipientCap } from './limits.js';

export { mayModifyEntry } from './access.js';

export class NeedsConfirmation extends Error {
  constructor(warnings) {
    super('confirmation required');
    this.warnings = warnings;
  }
}

/** Checked before the form input is even parsed: who, when, and for what. */
export const AWARD_ACCESS_RULES = [actorMayAward, programIsOpen, withinTimeWindow, reasonIsUsable];

/** Checked on the parsed rows, cheapest and most fundamental first; inputs before the amount computed from them. */
export const AWARD_ROW_RULES = [
  classIsValid,
  personIsValid,
  notSelfAward,
  inputsWithinLimits,
  amountWithinLimits,
  ownClassPolicy,
  styleBudgetSuffices,
  styleRecipientCap,
  poolFits,
  entryCountLimits,
  nameClassConsistency,
  recentDuplicate,
];

export function runRules(rules, ctx) {
  for (const rule of rules) rule(ctx);
}

/** Soft warnings stop the write until the organizer explicitly confirms. */
export function finishRules(ctx) {
  if (ctx.warnings.length && !ctx.confirmed) throw new NeedsConfirmation(ctx.warnings);
}
