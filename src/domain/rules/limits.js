// Limit rules: budgets, caps and per-program quotas.

import { ValidationError } from '../../http/errors.js';
import { styleBudget } from '../budget.js';

const sum = (rows) => rows.reduce((total, row) => total + row.amount, 0);

/**
 * Style points come out of the organizer's personal allowance (90 per organizer
 * at the Opening party). The check and the insert run in one synchronous
 * transaction, so two quick submissions can't both spend the last points.
 * A correction voids the old entry first, so its points count as returned.
 * Rulebook §4.2.
 */
export function styleBudgetSuffices(ctx) {
  if (ctx.reason.kind !== 'style') return;
  const { remaining } = styleBudget(ctx.db, ctx.actor.id, ctx.program.id);
  if (sum(ctx.rows) > remaining) throw new ValidationError('error.budgetExceeded', { remaining: Math.max(remaining, 0) });
}

/**
 * Optional cap on how many style points one organizer can give one student in a
 * program, against dumping a whole allowance on a friend. 0 switches it off.
 * Rulebook §4.2.
 */
export function styleRecipientCap(ctx) {
  const cap = ctx.settings.get('rules.style_per_recipient');
  if (ctx.reason.kind !== 'style' || cap === 0) return;
  const given = ctx.db.prepare(`
    SELECT COALESCE(SUM(e.amount), 0) AS total FROM entries e JOIN reasons r ON r.id = e.reason_id
    WHERE e.created_by = ? AND e.program_id = ? AND e.person_key = ? AND r.kind = 'style' AND e.voided_at IS NULL`);
  for (const row of ctx.rows) {
    if (!row.personKey) continue;
    const { total } = given.get(ctx.actor.id, ctx.program.id, row.personKey);
    if (total + row.amount > cap) throw new ValidationError('error.recipientCap', { cap, given: total });
  }
}

/**
 * Group awards such as "TB barátnőt keres": the pool is computed from the
 * number of performers (performers × 10) and may be split freely, but never
 * exceeded, and each performer appears once. Rulebook §4.6.
 */
export function poolFits(ctx) {
  if (ctx.reason.kind !== 'pool') return;
  if (ctx.rows.length === 0) throw new ValidationError('error.poolEmpty');
  const keys = ctx.rows.map((row) => row.personKey);
  if (new Set(keys).size !== keys.length) throw new ValidationError('error.poolDuplicatePerson');
  const total = sum(ctx.rows);
  if (total > ctx.poolSize) throw new ValidationError('error.poolExceeded', { pool: ctx.poolSize, total });
}

/**
 * Reason parameters max_entries_per_class and max_entries_per_person limit how
 * often a reason may be recorded in a program: route sheets are counted once
 * per class, so a second route sheet entry for the same class is refused.
 * Rulebook §4.1, §3.8.
 */
export function entryCountLimits(ctx) {
  const { max_entries_per_class: perClass, max_entries_per_person: perPerson } = ctx.reason.params;
  const count = (column, value) =>
    ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM entries WHERE reason_id = ? AND ${column} = ? AND voided_at IS NULL`)
      .get(ctx.reason.id, value).n;
  ctx.rows.forEach((row, i) => {
    const earlier = ctx.rows.slice(0, i);
    if (perClass !== undefined) {
      const n = count('class_id', row.classId) + earlier.filter((r) => r.classId === row.classId).length;
      if (n + 1 > perClass) throw new ValidationError('error.perClassLimit', { max: perClass });
    }
    if (perPerson !== undefined && row.personKey) {
      const n = count('person_key', row.personKey) + earlier.filter((r) => r.personKey === row.personKey).length;
      if (n + 1 > perPerson) throw new ValidationError('error.perPersonLimit', { max: perPerson });
    }
  });
}
