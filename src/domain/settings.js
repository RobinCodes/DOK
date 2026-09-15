// Runtime settings and feature switches.
//
// The superadmin can change every entry below at any moment (Rulebook §2.4),
// so no rule number or module switch is hardcoded anywhere else in the app.
// Defaults live here; the database only stores values that were changed.

import { parseBool } from './validate.js';

const bool = (value) => ({ type: 'bool', value });
const int = (value, min, max) => ({ type: 'int', value, min, max });
const choice = (value, options) => ({ type: 'choice', value, options });

export const SETTINGS = {
  // Public site sections
  'site.show_programs': bool(true),
  'site.show_standings': bool(true), // Rulebook §7.2: published top list
  'site.show_privacy': bool(true),
  'site.standings_top': int(10, 1, 100),

  // Point awarding modules (Rulebook §3, §4)
  'features.points': bool(true),
  'features.style_points': bool(true),
  'features.pool': bool(true),
  'features.timer': bool(true), // check-in/out timer (each admin may also switch it off for themselves)
  'features.manual_minutes': bool(true),
  'features.storno': bool(true),
  'features.corrections': bool(true),
  'features.live_standings': bool(false), // lets normal admins see live totals
  'features.log': bool(true), // log admins may read the event log (superadmin always can)
  'features.suspicion': bool(true),
  'features.logins': bool(true), // non-superadmin logins

  // Casino modules (Rulebook §5.2)
  'casino.enabled': bool(true),
  'casino.record_visits': bool(true), // entry + starting chips are recorded
  'casino.record_games': bool(false), // house records every game result
  'casino.enforce_balance': bool(true), // cash-out must equal the recorded balance (detailed mode)
  'casino.reconciliation': bool(true), // physical chip counts per staff member
  'casino.start_chips': int(100, 0, 1_000_000),
  'casino.max_visits': int(1, 1, 100), // starting stacks per person per program
  'casino.max_delta': int(1000, 1, 1_000_000), // biggest single game result
  'casino.max_cashout': int(10_000, 0, 10_000_000),

  // Anti-cheat rule switches (Rulebook §2.3, §3.3, §3.8)
  'rules.own_class': choice('flag', ['allow', 'flag', 'block']),
  'rules.name_class_conflict': choice('confirm', ['allow', 'confirm', 'block']),
  'rules.duplicate_seconds': int(120, 0, 86_400),
  'rules.enforce_time_window': bool(false),
  'rules.style_per_recipient': int(0, 0, 1_000_000), // 0 = no cap
  'rules.max_input': int(100_000, 1, 10_000_000), // upper bound for any formula input

  // Accounts
  'auth.session_hours': int(24, 1, 720),
  'auth.max_failures': int(8, 1, 1000),
  'auth.lockout_minutes': int(15, 1, 1440),

  // Suspicion scoring (Rulebook §8.3): detector weights in percent, and the highlight threshold
  'suspicion.threshold': int(60, 1, 100),
  'suspicion.weight.limits': int(100, 0, 100),
  'suspicion.weight.magnitude': int(70, 0, 100),
  'suspicion.weight.favoritism': int(60, 0, 100),
  'suspicion.weight.own_class': int(35, 0, 100),
  'suspicion.weight.concentration': int(45, 0, 100),
  'suspicion.weight.reciprocity': int(55, 0, 100),
  'suspicion.weight.velocity': int(40, 0, 100),
  'suspicion.weight.voids': int(45, 0, 100),
  'suspicion.weight.timing': int(50, 0, 100),
  'suspicion.weight.names': int(55, 0, 100),
  'suspicion.weight.manual_minutes': int(25, 0, 100),
  'suspicion.weight.casino': int(70, 0, 100),
};

export function parseSettingValue(key, input) {
  const def = SETTINGS[key];
  if (!def) return { ok: false };
  const text = String(input).trim();
  if (def.type === 'bool') {
    const value = parseBool(text);
    return value === null ? { ok: false } : { ok: true, value };
  }
  if (def.type === 'int') {
    if (!/^-?\d+$/.test(text)) return { ok: false };
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < def.min || value > def.max) return { ok: false, min: def.min, max: def.max };
    return { ok: true, value };
  }
  return def.options.includes(text) ? { ok: true, value: text } : { ok: false };
}

function decode(key, stored) {
  const def = SETTINGS[key];
  if (def.type === 'bool') return stored === 'true';
  if (def.type === 'int') return Number(stored);
  return stored;
}

/** Returns a reader bound to the database: settings.get('casino.start_chips'). */
export function createSettings(db) {
  const select = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );
  return {
    get(key) {
      if (!SETTINGS[key]) throw new Error(`Unknown setting: ${key}`);
      const row = select.get(key);
      const value = row ? decode(key, row.value) : SETTINGS[key].value;
      // A stored value that no longer fits the definition falls back to the default.
      return parseSettingValue(key, value).ok ? value : SETTINGS[key].value;
    },
    set(key, value) {
      const parsed = parseSettingValue(key, value);
      if (!parsed.ok) throw new Error(`Invalid value for ${key}`);
      upsert.run(key, String(parsed.value));
      return parsed.value;
    },
  };
}
