// Suspicion score (Rulebook §8.3).
//
// After a program, every record (point entry, casino cash-out, casino round)
// gets a score from 1 to 100. A score is NOT a verdict: it tells the log admins
// where to look first. Each detector reports a strength between 0 and 1 with
// a human-readable explanation; strengths are weighted (the weights are
// settings the superadmin can tune) and combined with a "noisy-OR":
//
//     score = 1 + 99 · (1 − Π (1 − weight_d · strength_d))
//
// so one strong signal is enough for a high score, several weak independent
// signals add up, and the result can never exceed 100. Within one detector
// only the strongest signal counts, so a single fact isn't counted twice.

import { detectBehaviour } from './behaviour.js';
import { detectCasino } from './casino.js';
import { loadData } from './data.js';
import { detectFavoritism } from './favoritism.js';
import { detectLimits } from './limits.js';
import { detectMagnitude } from './magnitude.js';
import { detectNames } from './names.js';
import { clamp01 } from './stats.js';
import { detectTiming } from './timing.js';

export const DETECTORS = [detectLimits, detectMagnitude, detectFavoritism, detectBehaviour, detectTiming, detectNames, detectCasino];

export function combineScore(factors, weightOf) {
  const strongest = new Map();
  for (const f of factors) strongest.set(f.detector, Math.max(strongest.get(f.detector) ?? 0, f.strength));
  let innocent = 1;
  for (const [detector, strength] of strongest) innocent *= 1 - clamp01(weightOf(detector) * strength);
  return 1 + Math.round(99 * (1 - innocent));
}

export function analyze(db, settings, { programId = null } = {}) {
  const data = loadData(db, settings, programId);
  const items = new Map();
  const add = (type, row) => items.set(`${type}:${row.id}`, { type, id: row.id, row, factors: [] });
  data.entries.forEach((e) => add('entry', e));
  data.cashouts.forEach((c) => add('cashout', c));
  data.rounds.forEach((r) => add('round', r));

  const flag = (type, id, detector, strength, key, vars = {}) => {
    const item = items.get(`${type}:${id}`);
    if (item && strength > 0) item.factors.push({ detector, strength: clamp01(strength), key, vars });
  };
  for (const detect of DETECTORS) detect(data, flag);

  const weightOf = (detector) => settings.get(`suspicion.weight.${detector}`) / 100;
  return [...items.values()]
    .map((item) => ({ ...item, score: combineScore(item.factors, weightOf) }))
    .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type) || b.id - a.id);
}
