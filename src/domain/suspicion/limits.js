// Detector: hard violations, measured against the CURRENT configuration, and
// records that bypassed the application.
//
// The write-time rules already refuse these, so a hit here means one of:
//  - the limits were changed after the fact (e.g. an allowance was lowered),
//  - the superadmin did something unusual, or
//  - someone edited the database file directly.
// All three deserve a human look, so every hit scores the maximum.
// Rulebook §3.4, §3.7, §4.2, §4.3, §4.6, §8.2.

import { evaluateReason } from '../awards.js';
import { nameKey } from '../names.js';
import { groupBy, sumBy } from './stats.js';

export function detectLimits(data, flag) {
  for (const e of data.entries) {
    // Every entry the app writes is logged in the same transaction. An entry
    // without its log line (or a casino conversion outside a logged batch) was
    // inserted around the application.
    const logged = e.source === 'casino' ? data.conversionBatches.has(e.batch) : data.audited.has(e.id);
    if (!logged) flag('entry', e.id, 'limits', 1, 'sus.limits.noAudit');
    if (e.voided_at) continue;

    if (e.reason_id && (e.amount < e.min_points || e.amount > e.max_points)) {
      flag('entry', e.id, 'limits', 1, 'sus.limits.amount', { amount: e.amount, min: e.min_points, max: e.max_points });
    }
    // Casino staff never award points (their chips are converted by the superadmin). Rulebook §5.8.
    if (e.creator_casino && e.creator_role !== 'superadmin' && e.source !== 'casino') {
      flag('entry', e.id, 'limits', 1, 'sus.limits.casinoStaff');
    }
    // Nobody awards themselves. Rulebook §2.3.
    if (e.person_key && e.person_key === nameKey(e.creator_name) && e.source !== 'casino') {
      flag('entry', e.id, 'limits', 1, 'sus.limits.selfAward');
    }
    // Inputs above their max_<input> cap, e.g. more minutes than allowed. Rulebook §4.3.
    const params = data.params.get(e.reason_id) ?? {};
    for (const [name, value] of Object.entries(JSON.parse(e.inputs))) {
      const cap = params[`max_${name}`];
      if (cap !== undefined && value > cap) flag('entry', e.id, 'limits', 1, 'sus.limits.inputCap', { name, value, max: cap });
    }
  }

  // Style points beyond the organizer's allowance, flagged from the entry that crossed the line. Rulebook §4.2.
  const style = data.active.filter((e) => e.kind === 'style');
  for (const list of groupBy(style, (e) => `${e.created_by}:${e.program_id}`).values()) {
    const { created_by: userId, program_id: programId } = list[0];
    const custom = data.budgets.find((b) => b.user_id === userId && b.program_id === programId);
    const allotted = custom ? custom.amount : (data.programs.get(programId)?.style_budget ?? 0);
    let spent = 0;
    for (const e of list) {
      spent += e.amount;
      if (spent > allotted) flag('entry', e.id, 'limits', 1, 'sus.limits.budget', { allotted, spent });
    }
  }

  // More entries of a reason per class or per person than max_entries_per_class/person allow,
  // flagged from the first entry over the quota. Rulebook §4.1, §3.8.
  for (const [param, column, key] of [['max_entries_per_class', 'class_id', 'sus.limits.perClass'], ['max_entries_per_person', 'person_key', 'sus.limits.perPerson']]) {
    const limited = data.active.filter((e) => e.reason_id && data.params.get(e.reason_id)?.[param] !== undefined && e[column] !== '');
    for (const list of groupBy(limited, (e) => `${e.reason_id}:${e[column]}`).values()) {
      const max = data.params.get(list[0].reason_id)[param];
      list.slice(max).forEach((e) => flag('entry', e.id, 'limits', 1, key, { max }));
    }
  }

  // Group awards bigger than their pool under the current formula. Rulebook §4.6.
  for (const list of groupBy(data.active.filter((e) => e.source === 'pool'), (e) => e.batch).values()) {
    const participants = JSON.parse(list[0].inputs).participants ?? list.length;
    let pool;
    try {
      pool = evaluateReason({ formula: list[0].formula, params: data.params.get(list[0].reason_id) ?? {} }, { participants });
    } catch {
      continue;
    }
    const total = sumBy(list, (e) => e.amount);
    if (total > pool) for (const e of list) flag('entry', e.id, 'limits', 1, 'sus.limits.pool', { total, pool });
  }
}
