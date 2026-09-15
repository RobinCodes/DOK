// Detectors: favoritism, own-class awards and reciprocal collusion.
//
// Game theory view: every organizer is an agent handing out a scarce resource
// (points) on behalf of the DÖK, with private information about who "deserved"
// them. Honest behaviour is enforced by making biased behaviour visible:
//
//  - Favoritism: if an organizer's awards go to one class far more often than
//    the other organizers' awards do, a binomial test measures how unlikely
//    that is by chance. Station effects (e.g. one grade crowds the karaoke)
//    produce mild deviations; only very small p-values count.
//  - Own class: organizers may award their own class (Rulebook §2.3), but it is
//    the classic conflict of interest, so in "flag" mode it adds a fixed weight.
//  - Reciprocity: two organizers can't openly favour their own classes, but they
//    can favour EACH OTHER's ("you scratch my back, I scratch yours") — the
//    cooperative equilibrium of a repeated game. We look for pairs where A
//    over-rewards B's class and B over-rewards A's class at the same time.
// Rulebook §2.3, §8.1, §8.3.

import { binomialUpperTail, groupBy, pStrength, ramp, sumBy } from './stats.js';

const pct = (x) => Math.round(x * 100);

export function detectFavoritism(data, flag) {
  const awards = data.active.filter((e) => e.source !== 'adjustment' && e.source !== 'casino');
  const total = awards.length;
  const classCounts = new Map([...groupBy(awards, (e) => e.class_id)].map(([id, list]) => [id, list.length]));
  const classesSeen = Math.max(classCounts.size, 1);
  const byCreator = groupBy(awards, (e) => e.created_by);

  for (const mine of byCreator.values()) {
    const n = mine.length;
    if (n < 5) continue;
    const others = total - n;
    for (const toClass of groupBy(mine, (e) => e.class_id).values()) {
      const k = toClass.length;
      // Laplace smoothing keeps the baseline sensible when the others gave that class nothing.
      const baseline = ((classCounts.get(toClass[0].class_id) ?? 0) - k + 1) / (others + classesSeen);
      if (k / n <= baseline) continue;
      const strength = pStrength(binomialUpperTail(k, n, baseline));
      const vars = { creator: toClass[0].creator, className: toClass[0].class_name, share: pct(k / n), baseline: pct(baseline) };
      for (const e of toClass) flag('entry', e.id, 'favoritism', strength, 'sus.favoritism', vars);
    }
  }

  if (data.ownClassMode === 'flag') {
    for (const e of awards) {
      if (e.creator_class && e.creator_class === e.class_id) flag('entry', e.id, 'own_class', 1, 'sus.ownClass');
    }
  }

  // Reciprocity, on points. The baseline is how the OTHER organizers share their
  // points out: the pair's own points are left out, so heavy collusion can't hide
  // by inflating the very average it is compared with.
  const points = (list) => sumBy(list, (e) => Math.max(e.amount, 0));
  const organizers = [...byCreator.entries()]
    .map(([id, list]) => ({ id, classId: list[0].creator_class, name: list[0].creator, list, points: points(list) }))
    .filter((o) => o.classId && o.points > 0);
  const toward = (from, to) => from.list.filter((e) => e.class_id === to.classId);

  for (let i = 0; i < organizers.length; i++) {
    for (let j = i + 1; j < organizers.length; j++) {
      const [a, b] = [organizers[i], organizers[j]];
      if (a.classId === b.classId) continue;
      const givenAB = points(toward(a, b));
      const givenBA = points(toward(b, a));
      if (givenAB < 10 || givenBA < 10) continue;
      const others = awards.filter((e) => e.created_by !== a.id && e.created_by !== b.id);
      const baseline = (classId) => (points(others.filter((e) => e.class_id === classId)) + 1) / (points(others) + classesSeen);
      // Normalized excess share: 0 = like everyone else, 1 = every point to that class.
      const excess = (given, from, classId) => (given / from.points - baseline(classId)) / (1 - baseline(classId));
      const strength = ramp(Math.min(excess(givenAB, a, b.classId), excess(givenBA, b, a.classId)), 0.3, 0.8);
      if (strength === 0) continue;
      for (const e of [...toward(a, b), ...toward(b, a)]) flag('entry', e.id, 'reciprocity', strength, 'sus.reciprocity', { a: a.name, b: b.name });
    }
  }
}
