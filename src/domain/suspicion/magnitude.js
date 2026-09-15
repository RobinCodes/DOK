// Detector: how extreme is the amount?
//
// Two views, the stronger one counts:
//  1. Against peers: the modified z-score of the amount among entries of the
//     same reason. Style awards cluster (5, 10, 15...), so a 90 among 10s stands out.
//  2. Against the scale of the whole competition: the ratio to the typical
//     entry. Only for superadmin adjustments, which have no reason, no limits
//     and no peers; entries with a reason already have their own limits, and
//     comparing a 220-point route sheet with 5-point style awards is just noise.
// Two hard ceilings are reported as violations, because no legitimate rule
// produces such amounts: 10,000× the typical entry, or more than 10× the
// largest per-entry limit of any reason. The second one needs no peers, so it
// also works when a huge entry is the only one in the competition.
// Rulebook §3.4, §8.3.

import { groupBy, median, ramp, robustZ } from './stats.js';

export function detectMagnitude(data, flag) {
  const typical = Math.max(median(data.active.map((e) => Math.abs(e.amount))), 1);
  const ceiling = Math.max(10 * data.largestLimit, 1000);

  for (const list of groupBy(data.active.filter((e) => e.reason_id), (e) => e.reason_id).values()) {
    if (list.length < 5) continue; // too few peers to say what "normal" is
    const amounts = list.map((e) => e.amount);
    for (const e of list) {
      const z = robustZ(e.amount, amounts);
      if (z > 3.5) flag('entry', e.id, 'magnitude', ramp(z, 3.5, 10), 'sus.magnitude.peer', { z: z.toFixed(1) });
    }
  }

  for (const e of data.active) {
    const ratio = Math.abs(e.amount) / typical;
    if (!e.reason_id && ratio >= 30) flag('entry', e.id, 'magnitude', ramp(Math.log10(ratio), 1.5, 3), 'sus.magnitude.absolute', { ratio: Math.round(ratio) });
    if (ratio >= 10_000 && Math.abs(e.amount) >= 1000) flag('entry', e.id, 'limits', 1, 'sus.limits.implausible', { ratio: Math.round(ratio) });
    if (Math.abs(e.amount) > ceiling) flag('entry', e.id, 'limits', 1, 'sus.limits.ceiling', { amount: e.amount, limit: data.largestLimit });
  }
}
