// Detector: when was it recorded?
//
//  - Outside the program's start/end time (if set).
//  - While the program was not open, reconstructed from the event log (only the
//    superadmin can do this, which is exactly why it should be visible).
//  - Last-minute bursts: several entries by one organizer in the ten minutes
//    before standings were published. Knowing a snapshot is imminent is private
//    information; using it to push a class up the public list is the pattern
//    snapshots exist to prevent. Rulebook §3.6, §7.2.

import { groupBy, ramp } from './stats.js';

function statusAt(changes, programId, at) {
  let status = null;
  for (const change of changes) if (change.programId === programId && change.at <= at) status = change.status;
  return status;
}

export function detectTiming(data, flag) {
  const regular = data.active.filter((e) => e.program_id && e.source !== 'casino');
  for (const e of regular) {
    const program = data.programs.get(e.program_id);
    if ((program.starts_at && e.created_at < program.starts_at) || (program.ends_at && e.created_at > program.ends_at)) {
      flag('entry', e.id, 'timing', 1, 'sus.timing.window');
    }
    const status = statusAt(data.statusChanges, e.program_id, e.created_at);
    if (status && status !== 'open') flag('entry', e.id, 'timing', 0.8, 'sus.timing.closed', { status });
  }

  for (const publishedAt of data.snapshots) {
    const end = Date.parse(publishedAt);
    const before = regular.filter((e) => {
      const t = Date.parse(e.created_at);
      return t <= end && end - t <= 600_000;
    });
    for (const list of groupBy(before, (e) => e.created_by).values()) {
      const strength = ramp(list.length, 3, 8) * 0.7;
      if (strength > 0) for (const e of list) flag('entry', e.id, 'timing', strength, 'sus.timing.lastMinute', { count: list.length });
    }
  }
}
