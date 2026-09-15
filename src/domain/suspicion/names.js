// Detector: who received it?
//
// Class points are the prize, so the cheapest cheat is attributing a student to
// the wrong class. Rulebook §3.3 says one student belongs to one class.
//  - The same (normalized) name under several classes: the minority class is
//    the likely wrong one.
//  - Near-identical names in different classes ("Kovacs Peter" vs "Kovács Pétr"),
//    i.e. a typo, or a deliberate variation to slip past the exact-match rule.
//  - Organizers receiving points from other organizers.
//  - Names that don't look like names (digits, 1–3 letters).

import { groupBy, levenshtein } from './stats.js';

export function detectNames(data, flag) {
  const records = [
    ...data.active.filter((e) => e.person_key).map((e) => ({ type: 'entry', id: e.id, key: e.person_key, name: e.person_name, classId: e.class_id, className: e.class_name, createdBy: e.created_by })),
    ...data.cashouts.map((c) => ({ type: 'cashout', id: c.id, key: c.person_key, name: c.person_name, classId: c.class_id, className: c.class_name, createdBy: c.created_by })),
  ];
  const byKey = groupBy(records, (r) => r.key);

  for (const list of byKey.values()) {
    const classes = groupBy(list, (r) => r.classId);
    if (classes.size < 2) continue;
    const largest = Math.max(...[...classes.values()].map((l) => l.length));
    const names = [...classes.values()].map((l) => l[0].className).join(', ');
    for (const group of classes.values()) {
      const strength = group.length < largest ? 0.9 : 0.4;
      for (const r of group) flag(r.type, r.id, 'names', strength, 'sus.names.multiClass', { classes: names });
    }
  }

  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const [a, b] = [keys[i], keys[j]];
      const allowed = Math.min(a.length, b.length) >= 12 ? 2 : Math.min(a.length, b.length) >= 6 ? 1 : 0;
      if (allowed === 0 || levenshtein(a, b, allowed) > allowed) continue;
      const classesA = new Set(byKey.get(a).map((r) => r.classId));
      const differentClass = byKey.get(b).some((r) => !classesA.has(r.classId));
      if (!differentClass) continue;
      for (const [own, other] of [[a, b], [b, a]]) {
        const otherRecord = byKey.get(other)[0];
        for (const r of byKey.get(own)) flag(r.type, r.id, 'names', 0.6, 'sus.names.similar', { other: otherRecord.name, className: otherRecord.className });
      }
    }
  }

  for (const r of records) {
    const organizer = data.organizerKeys.get(r.key);
    if (organizer && organizer.id !== r.createdBy) flag(r.type, r.id, 'names', 0.5, 'sus.names.organizer', { name: organizer.display_name });
    if (/\d/.test(r.name)) flag(r.type, r.id, 'names', 0.5, 'sus.names.odd');
    else if (r.key.replace(/ /g, '').length < 4) flag(r.type, r.id, 'names', 0.4, 'sus.names.odd');
  }
}
