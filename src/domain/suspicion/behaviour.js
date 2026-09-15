// Detectors: how organizers behave over time.
//
//  - Concentration: an organizer pouring a large share of their points into one
//    student, or awarding the same student again and again. Rulebook §4.2.
//  - Velocity: bursts of entries far faster than the organizer's own normal
//    pace (Poisson tail probability), and forms "filled in" faster than a human
//    can type. Scripted or pre-arranged entries look like this. Rulebook §8.1.
//  - Voids: an unusually high storno rate (shrunk towards the global rate, so
//    one storno out of two entries isn't "50%"), corrections that raise the
//    amount, and void-then-re-enter-higher without using the correction
//    function. Rulebook §3.5.
//  - Manual minutes: typed minutes while the timer is available, minutes exactly
//    at the cap, and suspiciously round numbers. Rulebook §4.3.

import { groupBy, pStrength, poissonUpperTail, ramp, sumBy } from './stats.js';

// Only discretionary awards: measured minutes and formula results aren't the organizer's choice.
const personLevel = (e) => e.person_key && ['style', 'manual', 'pool'].includes(e.kind);

function concentration(data, flag) {
  for (const mine of groupBy(data.active.filter(personLevel), (e) => e.created_by).values()) {
    const total = sumBy(mine, (e) => Math.max(e.amount, 0));
    for (const list of groupBy(mine, (e) => e.person_key).values()) {
      const share = sumBy(list, (e) => Math.max(e.amount, 0)) / Math.max(total, 1);
      const shareStrength = total >= 20 ? ramp(share, 0.34, 0.8) : 0;
      const repeatStrength = ramp(list.length, 2, 5);
      for (const e of list) {
        if (shareStrength > 0) flag('entry', e.id, 'concentration', shareStrength, 'sus.concentration.share', { share: Math.round(share * 100), creator: e.creator });
        if (repeatStrength > 0) flag('entry', e.id, 'concentration', repeatStrength, 'sus.concentration.repeat', { count: list.length });
      }
    }
  }
}

function velocity(data, flag) {
  const typed = data.active.filter((e) => e.source === 'form');
  for (const mine of groupBy(typed, (e) => e.created_by).values()) {
    const times = mine.map((e) => Date.parse(e.created_at));
    const spanSeconds = Math.max((Math.max(...times) - Math.min(...times)) / 1000, 600);
    const expectedIn2Min = (mine.length / spanSeconds) * 120;
    mine.forEach((e, i) => {
      const nearby = times.filter((t) => Math.abs(t - times[i]) <= 60_000).length;
      if (nearby >= 4) {
        const strength = pStrength(poissonUpperTail(nearby, expectedIn2Min));
        flag('entry', e.id, 'velocity', strength, 'sus.velocity.burst', { count: nearby });
      }
      const gap = i > 0 ? (times[i] - times[i - 1]) / 1000 : Infinity;
      if (gap < 3) flag('entry', e.id, 'velocity', 0.6, 'sus.velocity.fast', { seconds: gap.toFixed(1) });
    });
  }
}

function voids(data, flag) {
  const counted = data.entries.filter((e) => e.source !== 'adjustment' && e.source !== 'casino');
  const globalRate = counted.filter((e) => e.voided_at).length / Math.max(counted.length, 1);
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  const corrected = new Set(data.entries.map((e) => e.corrects_id).filter(Boolean));

  for (const mine of groupBy(counted, (e) => e.created_by).values()) {
    const voided = mine.filter((e) => e.voided_at).length;
    const shrunk = (voided + 10 * globalRate) / (mine.length + 10);
    const strength = ramp(shrunk - globalRate, 0.1, 0.4);
    if (strength === 0) continue;
    for (const e of mine) {
      if (e.voided_at || e.corrects_id) flag('entry', e.id, 'voids', strength, 'sus.voids.rate', { rate: Math.round((voided / mine.length) * 100) });
    }
  }

  for (const e of data.active) {
    const old = e.corrects_id && byId.get(e.corrects_id);
    if (old && e.amount > old.amount) {
      flag('entry', e.id, 'voids', ramp((e.amount - old.amount) / Math.max(Math.abs(old.amount), 1), 0.2, 2), 'sus.voids.inflation', { from: old.amount, to: e.amount });
    }
  }

  // Voided (not via correction), then re-entered higher by the same organizer within 10 minutes.
  for (const v of data.entries.filter((e) => e.voided_at && !corrected.has(e.id))) {
    const voidedAt = Date.parse(v.voided_at);
    for (const e of data.active) {
      const sameTarget = e.created_by === v.created_by && e.reason_id === v.reason_id && e.class_id === v.class_id && e.person_key === v.person_key;
      const soon = Date.parse(e.created_at) >= voidedAt && Date.parse(e.created_at) - voidedAt <= 600_000;
      if (sameTarget && soon && e.amount > v.amount) flag('entry', e.id, 'voids', 0.5, 'sus.voids.recreate', { from: v.amount, to: e.amount });
    }
  }
}

function manualMinutes(data, flag) {
  for (const e of data.active.filter((x) => x.kind === 'minutes' && x.source === 'form')) {
    const minutes = JSON.parse(e.inputs).minutes;
    const cap = data.params.get(e.reason_id)?.max_minutes;
    if (data.timerFeatureOn) flag('entry', e.id, 'manual_minutes', 0.6, 'sus.manual.timerOn');
    if (cap !== undefined && minutes === cap) flag('entry', e.id, 'manual_minutes', 0.4, 'sus.manual.atCap');
    if (minutes >= 60 && minutes % 30 === 0) flag('entry', e.id, 'manual_minutes', 0.25, 'sus.manual.round', { minutes });
  }
}

export function detectBehaviour(data, flag) {
  concentration(data, flag);
  velocity(data, flag);
  voids(data, flag);
  manualMinutes(data, flag);
}
