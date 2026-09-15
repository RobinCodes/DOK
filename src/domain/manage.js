// Superadmin control over every value on the site (Rulebook §2.4).
//
// Every changeable value is addressed by a target string, e.g.
//   setting:casino.start_chips      budget:<userId>:<programId>
//   class_points:<classId>          reason:<id>:max_points
//   param:<reasonId>:stamp_points   user:<id>:role
// and changed with one of three operations: set, adjust (±n) or toggle.
// One code path validates the change, applies it atomically and logs the
// before/after values, so "the superadmin can change anything" never means
// "the superadmin can change anything without a trace".

import { ROLES } from '../auth/roles.js';
import { destroyUserSessions } from '../auth/sessions.js';
import { transaction } from '../db/database.js';
import { HttpError, ValidationError } from '../http/errors.js';
import { adjustClassPoints, classTotal } from './awards.js';
import { audit } from './audit.js';
import { setAllotted, styleBudget } from './budget.js';
import { REASON_KINDS, SYSTEM_VARIABLES } from './catalog.js';
import { compileFormula, FormulaError } from './formula.js';
import { createSettings, SETTINGS } from './settings.js';
import { budapestLocalToIso } from './time.js';
import { parseBool, parseDecimal, parseInteger, parseText } from './validate.js';

const text = (max, required = false) => ({ type: 'text', max, required });
const int = (min, max) => ({ type: 'int', min, max });
const bool = { type: 'bool' };
const choice = (options) => ({ type: 'choice', options });
const SORT = int(-10_000, 10_000);

/** Kinds whose points come from a formula. */
const FORMULA_KINDS = ['formula', 'minutes', 'pool', 'casino'];

function checkReason(db, row) {
  if (row.min_points > row.max_points) throw new ValidationError('error.minAboveMax');
  if (!FORMULA_KINDS.includes(row.kind) || !row.formula) return;
  let variables;
  try {
    variables = compileFormula(row.formula).variables;
  } catch (err) {
    if (err instanceof FormulaError) throw new ValidationError('error.formula', { message: err.message });
    throw err;
  }
  const params = db.prepare('SELECT name FROM reason_params WHERE reason_id = ?').all(row.id).map((p) => p.name);
  const system = SYSTEM_VARIABLES[row.kind];
  const unknown = system ? variables.filter((v) => !params.includes(v) && !system.includes(v)) : [];
  if (unknown.length) throw new ValidationError('error.formulaUnknown', { names: unknown.join(', ') });
  if (row.kind === 'minutes' && !variables.includes('minutes')) throw new ValidationError('error.formulaNeedsMinutes');
}

function checkUser(db, row, actor) {
  if (row.id === actor.id && (row.role !== 'superadmin' || !row.active)) throw new ValidationError('error.cannotLockSelf');
}

/** Column-backed targets: target "<name>:<id>:<column>". */
export const TABLES = {
  program: {
    table: 'programs',
    fields: {
      name_hu: text(80, true),
      name_en: text(80, true),
      description_hu: text(2000),
      description_en: text(2000),
      when_hu: text(80),
      when_en: text(80),
      starts_at: { type: 'datetime' },
      ends_at: { type: 'datetime' },
      status: choice(['upcoming', 'open', 'closed']),
      style_budget: int(0, 1_000_000),
      public: bool,
      sort: SORT,
    },
  },
  reason: {
    table: 'reasons',
    check: checkReason,
    fields: {
      name_hu: text(120, true),
      name_en: text(120, true),
      kind: choice(REASON_KINDS),
      needs_person: bool,
      min_points: int(-1_000_000, 1_000_000),
      max_points: int(-1_000_000, 1_000_000),
      formula: text(200),
      active: bool,
      sort: SORT,
    },
  },
  class: { table: 'classes', fields: { name: text(20, true), active: bool, sort: SORT } },
  user: {
    table: 'users',
    check: checkUser,
    fields: {
      display_name: text(80, true),
      role: choice(ROLES),
      is_casino: bool,
      class_id: { type: 'class' },
      use_timer: bool,
      active: bool,
    },
  },
  game: { table: 'casino_games', fields: { name_hu: text(80, true), name_en: text(80, true), kind: choice(['house', 'pvp']), active: bool, sort: SORT } },
  snapshot: { table: 'snapshots', fields: { label: text(80), hidden: bool } },
};

function parseFieldValue(db, spec, raw) {
  const value = String(raw ?? '');
  switch (spec.type) {
    case 'int':
      return parseInteger(value, spec);
    case 'decimal':
      return parseDecimal(value, spec);
    case 'bool': {
      const parsed = parseBool(value);
      if (parsed === null) throw new ValidationError('error.invalidChoice');
      return parsed ? 1 : 0;
    }
    case 'choice':
      if (!spec.options.includes(value)) throw new ValidationError('error.invalidChoice');
      return value;
    case 'datetime': {
      if (value.trim() === '') return null;
      const iso = budapestLocalToIso(value);
      if (!iso) throw new ValidationError('error.invalidDate');
      return iso;
    }
    case 'class': {
      if (value.trim() === '') return null;
      const id = parseInteger(value, { min: 1 });
      if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(id)) throw new ValidationError('error.classInvalid');
      return id;
    }
    default:
      return parseText(value, spec);
  }
}

function numericDelta(spec, raw) {
  if (spec.type === 'int') return parseInteger(raw, { min: -1e12, max: 1e12 });
  if (spec.type === 'decimal') return parseDecimal(raw);
  throw new ValidationError('error.cannotAdjust');
}

/**
 * Resolves a target into { spec, get(), put(value) }. Virtual targets
 * (class points, budgets, params, settings) translate the change into the
 * right storage operation.
 */
function resolve(db, target, { actor, now, ip, note }) {
  const [kind, ...ids] = String(target).split(':');

  if (kind === 'setting') {
    const key = ids.join(':');
    const def = SETTINGS[key];
    if (!def) throw new HttpError(404);
    const settings = createSettings(db);
    const spec = def.type === 'choice' ? choice(def.options) : def.type === 'int' ? int(def.min, def.max) : bool;
    return {
      spec,
      get: () => (def.type === 'bool' ? (settings.get(key) ? 1 : 0) : settings.get(key)),
      put: (value) => settings.set(key, def.type === 'bool' ? Boolean(value) : value),
    };
  }

  if (kind === 'class_points') {
    const classId = parseInteger(ids[0], { min: 1 });
    return {
      spec: int(-1e9, 1e9),
      get: () => classTotal(db, classId),
      put: (value, before) => adjustClassPoints(db, { actor, classId, delta: value - before, note, now, ip }),
    };
  }

  if (kind === 'budget') {
    const [userId, programId] = ids.map((id) => parseInteger(id, { min: 1 }));
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId) || !db.prepare('SELECT 1 FROM programs WHERE id = ?').get(programId)) {
      throw new HttpError(404);
    }
    return {
      spec: int(0, 1_000_000),
      get: () => styleBudget(db, userId, programId).remaining,
      put: (remaining) => setAllotted(db, userId, programId, remaining + styleBudget(db, userId, programId).spent),
    };
  }

  if (kind === 'param') {
    const reasonId = parseInteger(ids[0], { min: 1 });
    const name = ids[1];
    const row = db.prepare('SELECT value FROM reason_params WHERE reason_id = ? AND name = ?').get(reasonId, name);
    if (!row) throw new HttpError(404);
    return {
      spec: { type: 'decimal', min: -1e9, max: 1e9 },
      get: () => row.value,
      put: (value) => db.prepare('UPDATE reason_params SET value = ? WHERE reason_id = ? AND name = ?').run(value, reasonId, name),
    };
  }

  const def = TABLES[kind];
  const [id, field] = ids;
  const spec = def?.fields[field];
  if (!spec) throw new HttpError(404);
  const rowId = parseInteger(id, { min: 1 });
  const row = db.prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(rowId);
  if (!row) throw new HttpError(404);
  return {
    spec,
    get: () => row[field],
    put: (value) => {
      def.check?.(db, { ...row, [field]: value }, actor);
      try {
        db.prepare(`UPDATE ${def.table} SET ${field} = ? WHERE id = ?`).run(value, rowId);
      } catch (err) {
        if (/UNIQUE/.test(err.message)) throw new ValidationError('error.duplicateName');
        throw err;
      }
      if (kind === 'user' && (field === 'active' || field === 'role') ) destroyUserSessions(db, rowId);
    },
  };
}

export function applyChange(db, { actor, target, op, value, note = '', now, ip = '' }) {
  return transaction(db, () => {
    if (actor.role !== 'superadmin') throw new HttpError(403);
    const cleanNote = parseText(note, { max: 200 });
    const { spec, get, put } = resolve(db, target, { actor, now, ip, note: cleanNote });
    const before = get();
    let after;
    if (op === 'toggle') {
      if (spec.type !== 'bool') throw new ValidationError('error.cannotToggle');
      after = before ? 0 : 1;
    } else if (op === 'adjust') {
      after = before + numericDelta(spec, value);
      if (spec.min !== undefined && (after < spec.min || after > spec.max)) throw new ValidationError('error.outOfRange', spec);
    } else if (op === 'set') {
      after = parseFieldValue(db, spec, value);
    } else {
      throw new ValidationError('error.invalidChoice');
    }
    if (after === before) return { before, after };
    put(after, before);
    audit(db, { actor, action: `value.${op}`, subject: target, details: { before, after, note: cleanNote }, ip, at: now });
    return { before, after };
  });
}

// ---- Creating things ------------------------------------------------------

function created(db, actor, now, ip, action, subject, details) {
  audit(db, { actor, action, subject, details, ip, at: now });
}

function requireSuper(actor) {
  if (actor.role !== 'superadmin') throw new HttpError(403);
}

/** Adds classes from text, one name per line; existing names are skipped. */
export function createClasses(db, { actor, names, now, ip = '' }) {
  return transaction(db, () => {
    requireSuper(actor);
    const list = String(names ?? '')
      .split(/[\n,;]+/)
      .map((n) => n.normalize('NFC').trim().replace(/\s+/g, ''))
      .filter(Boolean);
    const insert = db.prepare('INSERT OR IGNORE INTO classes (name, sort) VALUES (?, ?)');
    const added = [];
    for (const name of list) {
      if (name.length > 20) throw new ValidationError('error.tooLong', { max: 20 });
      // Sort by grade number so 7.A comes before 10.A (plain text order would not).
      const grade = Number.parseInt(name, 10);
      if (insert.run(name, Number.isNaN(grade) ? 0 : grade).changes) added.push(name);
    }
    if (added.length) created(db, actor, now, ip, 'class.create', 'classes', { added });
    return { added };
  });
}

export function createProgram(db, { actor, nameHu, nameEn, now, ip = '' }) {
  return transaction(db, () => {
    requireSuper(actor);
    const name_hu = parseText(nameHu, { max: 80, required: true });
    const name_en = parseText(nameEn, { max: 80 }) || name_hu;
    const base = name_hu.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'program';
    let slug = base;
    for (let i = 2; db.prepare('SELECT 1 FROM programs WHERE slug = ?').get(slug); i++) slug = `${base}-${i}`;
    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO programs (slug, name_hu, name_en, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM programs))')
      .run(slug, name_hu, name_en);
    created(db, actor, now, ip, 'program.create', `program:${id}`, { name_hu, name_en });
    return { id };
  });
}

const KIND_DEFAULTS = {
  manual: { min: 1, max: 100, formula: '', params: {} },
  style: { min: 1, max: 90, formula: '', params: {} },
  formula: { min: 1, max: 100, formula: '', params: {} },
  minutes: { min: 1, max: 240, formula: 'minutes * points_per_minute', params: { points_per_minute: 1, max_minutes: 240 } },
  pool: { min: 0, max: 100, formula: 'participants * per_participant', params: { per_participant: 10 } },
  casino: { min: 0, max: 1000, formula: 'chips / chips_per_point', params: { chips_per_point: 10 } },
};

export function createReason(db, { actor, programId, nameHu, nameEn, kind, now, ip = '' }) {
  return transaction(db, () => {
    requireSuper(actor);
    if (!db.prepare('SELECT 1 FROM programs WHERE id = ?').get(programId)) throw new HttpError(404);
    if (!REASON_KINDS.includes(kind)) throw new ValidationError('error.invalidChoice');
    const name_hu = parseText(nameHu, { max: 120, required: true });
    const name_en = parseText(nameEn, { max: 120 }) || name_hu;
    const d = KIND_DEFAULTS[kind];
    const { lastInsertRowid: id } = db
      .prepare(`
        INSERT INTO reasons (program_id, name_hu, name_en, kind, min_points, max_points, formula, sort)
        VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM reasons WHERE program_id = ?))`)
      .run(programId, name_hu, name_en, kind, d.min, d.max, d.formula, programId);
    for (const [name, value] of Object.entries(d.params)) {
      db.prepare('INSERT INTO reason_params (reason_id, name, value) VALUES (?, ?, ?)').run(id, name, value);
    }
    created(db, actor, now, ip, 'reason.create', `reason:${id}`, { programId, name_hu, kind });
    return { id };
  });
}

export const PARAM_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export function addParam(db, { actor, reasonId, name, value, now, ip = '' }) {
  return transaction(db, () => {
    requireSuper(actor);
    if (!db.prepare('SELECT 1 FROM reasons WHERE id = ?').get(reasonId)) throw new HttpError(404);
    const cleanName = String(name ?? '').trim();
    if (!PARAM_NAME.test(cleanName)) throw new ValidationError('error.paramName');
    const number = parseDecimal(value, { min: -1e9, max: 1e9 });
    try {
      db.prepare('INSERT INTO reason_params (reason_id, name, value) VALUES (?, ?, ?)').run(reasonId, cleanName, number);
    } catch (err) {
      if (/UNIQUE|PRIMARY KEY/.test(err.message)) throw new ValidationError('error.duplicateName');
      throw err;
    }
    created(db, actor, now, ip, 'param.create', `param:${reasonId}:${cleanName}`, { value: number });
  });
}

export function removeParam(db, { actor, reasonId, name, now, ip = '' }) {
  return transaction(db, () => {
    requireSuper(actor);
    const row = db.prepare('SELECT value FROM reason_params WHERE reason_id = ? AND name = ?').get(reasonId, name);
    if (!row) throw new HttpError(404);
    db.prepare('DELETE FROM reason_params WHERE reason_id = ? AND name = ?').run(reasonId, name);
    created(db, actor, now, ip, 'param.remove', `param:${reasonId}:${name}`, { before: row.value });
  });
}

export function createGame(db, { actor, nameHu, nameEn, kind, now, ip = '' }) {
  return transaction(db, () => {
    requireSuper(actor);
    if (!['house', 'pvp'].includes(kind)) throw new ValidationError('error.invalidChoice');
    const name_hu = parseText(nameHu, { max: 80, required: true });
    const name_en = parseText(nameEn, { max: 80 }) || name_hu;
    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO casino_games (name_hu, name_en, kind, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM casino_games))')
      .run(name_hu, name_en, kind);
    created(db, actor, now, ip, 'game.create', `game:${id}`, { name_hu, kind });
    return { id };
  });
}
