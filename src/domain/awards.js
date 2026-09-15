// The points ledger: awarding, voiding ("sztornó") and correcting entries.
//
// Nothing is ever edited in place (Rulebook §3.5): a storno marks an entry void,
// a correction voids the old entry and records a new one pointing back to it,
// and every step lands in the event log. A class's score is simply the sum of
// its active entries, so the history always adds up.

import { randomUUID } from 'node:crypto';
import { transaction } from '../db/database.js';
import { HttpError, ValidationError } from '../http/errors.js';
import { audit } from './audit.js';
import { getProgram, getReason, SYSTEM_VARIABLES } from './catalog.js';
import { compileFormula, FormulaError, roundHalfAway } from './formula.js';
import { cleanName, nameKey } from './names.js';
import { AWARD_ACCESS_RULES, AWARD_ROW_RULES, finishRules, mayModifyEntry, runRules } from './rules/index.js';
import { parseInteger, parseText } from './validate.js';

export const MAX_NOTE_LENGTH = 200;

/** Variables of a reason's formula that the organizer has to type in. */
export function formulaInputs(reason) {
  if (!['formula', 'minutes'].includes(reason.kind)) return [];
  try {
    const system = SYSTEM_VARIABLES[reason.kind] ?? [];
    return compileFormula(reason.formula).variables.filter((v) => !(v in reason.params) && !system.includes(v));
  } catch {
    return [];
  }
}

/** Evaluates a reason's formula with its parameters; the result is rounded to whole points. */
export function evaluateReason(reason, values) {
  try {
    return roundHalfAway(compileFormula(reason.formula).evaluate({ ...reason.params, ...values }));
  } catch (err) {
    if (err instanceof FormulaError) throw new ValidationError('error.formula', { message: err.message });
    throw err;
  }
}

export function parseClassId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,15}$/.test(text)) throw new ValidationError('error.classInvalid');
  return Number(text);
}

function person(nameInput) {
  const personName = cleanName(nameInput);
  return { personName, personKey: nameKey(personName) };
}

function parseInput(name, value) {
  try {
    return parseInteger(value, { min: 0 });
  } catch {
    throw new ValidationError('error.inputInvalid', { name });
  }
}

/** Turns raw form input into ledger rows, depending on the reason kind. */
function buildRows(reason, input) {
  if (reason.kind === 'pool') {
    const filled = (input.rows ?? []).filter((row) => cleanName(row.name) !== '');
    const participants = filled.length;
    const rows = filled.map((row) => ({
      classId: parseClassId(row.classId),
      ...person(row.name),
      amount: parseInteger(row.amount),
      inputs: { participants },
    }));
    return { rows, poolSize: participants ? evaluateReason(reason, { participants }) : 0 };
  }

  const row = { classId: parseClassId(input.classId), ...person(input.name), inputs: {} };
  if (reason.kind === 'manual' || reason.kind === 'style') {
    row.amount = parseInteger(input.amount);
  } else if (reason.kind === 'formula' || reason.kind === 'minutes') {
    for (const name of formulaInputs(reason)) row.inputs[name] = parseInput(name, input.inputs?.[name]);
    row.amount = evaluateReason(reason, row.inputs);
  } else {
    throw new ValidationError('error.reasonNotAwardable');
  }
  return { rows: [row] };
}

export function insertEntry(db, entry) {
  return db
    .prepare(`
      INSERT INTO entries (program_id, reason_id, class_id, person_name, person_key, amount, inputs, source,
                           batch, corrects_id, cashout_id, note, created_by, created_at, nonce)
      VALUES ($program_id, $reason_id, $class_id, $person_name, $person_key, $amount, $inputs, $source,
              $batch, $corrects_id, $cashout_id, $note, $created_by, $created_at, $nonce)`)
    .run({ batch: null, corrects_id: null, cashout_id: null, nonce: null, note: '', person_name: '', person_key: '', inputs: '{}', ...entry })
    .lastInsertRowid;
}

/**
 * Records an award. Throws ValidationError/HttpError when a rule is broken and
 * NeedsConfirmation when a soft rule wants the organizer to double-check.
 * Replaying the same form (same nonce) returns the original result instead of
 * creating a duplicate (Rulebook §3.8).
 */
export function createAward(db, settings, { actor, reasonId, input, confirmed = false, nonce = null, correctsId = null, source = 'form', now, ip = '' }) {
  return transaction(db, () => {
    if (nonce) {
      const existing = db.prepare('SELECT id FROM entries WHERE nonce = ?').get(nonce);
      if (existing) return { ids: [existing.id], total: null, replayed: true };
    }
    const reason = getReason(db, reasonId);
    if (!reason) throw new HttpError(404);
    const ctx = { db, settings, actor, reason, program: getProgram(db, reason.program_id), source, now, confirmed, correctsId, warnings: [] };

    runRules(AWARD_ACCESS_RULES, ctx);
    const built = buildRows(reason, input);
    ctx.rows = built.rows;
    ctx.poolSize = built.poolSize;
    runRules(AWARD_ROW_RULES, ctx);
    finishRules(ctx);

    const note = parseText(input.note, { max: MAX_NOTE_LENGTH });
    const batch = reason.kind === 'pool' ? `pool:${randomUUID()}` : null;
    const ids = ctx.rows.map((row, i) =>
      insertEntry(db, {
        program_id: reason.program_id,
        reason_id: reason.id,
        class_id: row.classId,
        person_name: row.personName,
        person_key: row.personKey,
        amount: row.amount,
        inputs: JSON.stringify(row.inputs),
        source: reason.kind === 'pool' ? 'pool' : source,
        batch,
        corrects_id: correctsId,
        note,
        created_by: actor.id,
        created_at: now,
        nonce: i === 0 ? nonce : null,
      }),
    );

    audit(db, {
      actor,
      action: correctsId ? 'entry.correct' : 'entry.create',
      subject: `entry:${ids.join(',')}`,
      details: {
        program: reason.program_id,
        reason: reason.id,
        kind: reason.kind,
        source,
        corrects: correctsId,
        rows: ctx.rows.map((r) => ({ class: r.class.name, name: r.personName, amount: r.amount, inputs: r.inputs })),
        confirmedWarnings: ctx.warnings.map((w) => w.key),
        note,
      },
      ip,
      at: now,
    });
    return { ids, total: ctx.rows.reduce((sum, r) => sum + r.amount, 0) };
  });
}

function loadEntry(db, entryId) {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) throw new HttpError(404);
  return { entry, program: entry.program_id ? getProgram(db, entry.program_id) : null };
}

/** Marks an entry void. Group (pool) awards are voided as a whole, because their limit applied to the group. */
function voidRows(db, { actor, entry, reason, now, ip, correction = false }) {
  const voidReason = parseText(reason, { max: MAX_NOTE_LENGTH, required: true });
  const ids = entry.batch
    ? db.prepare('SELECT id FROM entries WHERE batch = ? AND voided_at IS NULL').all(entry.batch).map((r) => r.id)
    : [entry.id];
  const update = db.prepare('UPDATE entries SET voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ?');
  for (const id of ids) update.run(actor.id, now, voidReason, id);
  audit(db, { actor, action: 'entry.void', subject: `entry:${ids.join(',')}`, details: { reason: voidReason, amount: entry.amount, correction }, ip, at: now });
  return ids;
}

export function voidEntry(db, settings, { actor, entryId, reason, now, ip = '' }) {
  return transaction(db, () => {
    const { entry, program } = loadEntry(db, entryId);
    mayModifyEntry({ actor, settings, entry, program, action: 'storno' });
    return { ids: voidRows(db, { actor, entry, reason, now, ip }) };
  });
}

/**
 * Correction = void the old entry + record the new version, atomically.
 * The new version is typed by hand, so it counts as a form entry even if the
 * original came from a timer.
 */
export function correctEntry(db, settings, { actor, entryId, input, confirmed = false, nonce = null, now, ip = '' }) {
  return transaction(db, () => {
    // A replayed form must not fail on "already voided": return the original result.
    const replay = nonce && db.prepare('SELECT id FROM entries WHERE nonce = ?').get(nonce);
    if (replay) return { ids: [replay.id], total: null, replayed: true };
    const { entry, program } = loadEntry(db, entryId);
    mayModifyEntry({ actor, settings, entry, program, action: 'correct' });
    voidRows(db, { actor, entry, reason: input.correctionReason, now, ip, correction: true });
    return createAward(db, settings, { actor, reasonId: entry.reason_id, input, confirmed, nonce, correctsId: entry.id, now, ip });
  });
}

/**
 * Superadmin adjustment of a class's score (Rulebook §2.4): stored as an ordinary
 * ledger entry, so "set this class to 500 points" stays visible and reversible
 * instead of silently overwriting a number.
 */
export function adjustClassPoints(db, { actor, classId, delta, note = '', now, ip = '' }) {
  return transaction(db, () => {
    if (actor.role !== 'superadmin') throw new HttpError(403);
    const cls = db.prepare('SELECT id FROM classes WHERE id = ?').get(classId);
    if (!cls) throw new HttpError(404);
    if (!Number.isSafeInteger(delta) || delta === 0) throw new ValidationError('error.nothingToChange');
    const cleanNote = parseText(note, { max: MAX_NOTE_LENGTH });
    const id = insertEntry(db, { program_id: null, reason_id: null, class_id: classId, amount: delta, source: 'adjustment', note: cleanNote, created_by: actor.id, created_at: now });
    audit(db, { actor, action: 'entry.adjust', subject: `entry:${id}`, details: { class: classId, delta, note: cleanNote }, ip, at: now });
    return { id };
  });
}

export function classTotal(db, classId) {
  return db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM entries WHERE class_id = ? AND voided_at IS NULL').get(classId).total;
}

export function listEntries(db, { createdBy, programId, limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (createdBy) {
    where.push('e.created_by = ?');
    params.push(createdBy);
  }
  if (programId) {
    where.push('e.program_id = ?');
    params.push(programId);
  }
  return db
    .prepare(`
      SELECT e.*, c.name AS class_name, u.username AS creator, r.name_hu AS reason_hu, r.name_en AS reason_en, r.kind AS reason_kind
      FROM entries e
      JOIN classes c ON c.id = e.class_id
      JOIN users u ON u.id = e.created_by
      LEFT JOIN reasons r ON r.id = e.reason_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
}
