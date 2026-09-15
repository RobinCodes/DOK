// The casino (Rulebook §5). Inside the casino only chips exist; chips turn into
// points once, after the program, through the superadmin's conversion.
//
// The method isn't final, so the module is assembled from switches (§5.2):
//   light mode    – staff only record cash-outs (who handed in how many chips);
//   visit mode    – entries and starting stacks are recorded as well;
//   detailed mode – every game result is recorded and balances are tracked.
// Whatever the mode, the suspicion score analyses whatever was recorded.

import { isCasinoStaff, isSuperadmin } from '../auth/roles.js';
import { transaction } from '../db/database.js';
import { HttpError, ValidationError } from '../http/errors.js';
import { audit } from './audit.js';
import { evaluateReason, insertEntry, parseClassId } from './awards.js';
import { getGame, getProgram } from './catalog.js';
import { cleanName, nameKey } from './names.js';
import { finishRules, runRules } from './rules/index.js';
import { programIsOpen, withinTimeWindow } from './rules/access.js';
import {
  actorIsCasinoStaff,
  balanceNeverNegative,
  cashoutMatchesBalance,
  requireCasinoMode,
  roundIsBalanced,
  visitQuota,
} from './rules/casino.js';
import { classIsValid, notSelfAward, personIsValid } from './rules/input.js';
import { nameClassConsistency, ownClassPolicy } from './rules/integrity.js';
import { minutesBetween } from './time.js';
import { parseId, parseInteger, parseText } from './validate.js';

export function casinoPrograms(db) {
  return db
    .prepare(`
      SELECT p.* FROM programs p
      WHERE EXISTS (SELECT 1 FROM reasons r WHERE r.program_id = p.id AND r.kind = 'casino' AND r.active = 1)
      ORDER BY p.sort, p.id`)
    .all();
}

export function casinoReason(db, programId) {
  const reason = db.prepare(`SELECT id FROM reasons WHERE program_id = ? AND kind = 'casino' AND active = 1 ORDER BY sort, id LIMIT 1`).get(programId);
  if (!reason) return null;
  const params = {};
  for (const p of db.prepare('SELECT name, value FROM reason_params WHERE reason_id = ?').all(reason.id)) params[p.name] = p.value;
  return { ...db.prepare('SELECT * FROM reasons WHERE id = ?').get(reason.id), params };
}

const ACTIVE_ROUND_RESULTS = `
  SELECT res.delta FROM casino_results res JOIN casino_rounds r ON r.id = res.round_id
  WHERE res.visit_id = ? AND r.voided_at IS NULL`;

export function visitBalance(db, visitId) {
  const visit = db.prepare('SELECT start_chips FROM casino_visits WHERE id = ?').get(visitId);
  const { total } = db.prepare(`SELECT COALESCE(SUM(delta), 0) AS total FROM (${ACTIVE_ROUND_RESULTS})`).get(visitId);
  return visit.start_chips + total;
}

export function listVisits(db, programId, { openOnly = false } = {}) {
  return db
    .prepare(`
      SELECT v.*, c.name AS class_name, u.username AS creator,
             co.id AS cashout_id, co.chips AS cashout_chips, co.created_at AS cashout_at
      FROM casino_visits v
      JOIN classes c ON c.id = v.class_id
      JOIN users u ON u.id = v.created_by
      LEFT JOIN casino_cashouts co ON co.visit_id = v.id AND co.voided_at IS NULL
      WHERE v.program_id = ? AND v.voided_at IS NULL ${openOnly ? 'AND co.id IS NULL' : ''}
      ORDER BY v.id DESC`)
    .all(programId)
    .map((v) => ({ ...v, balance: visitBalance(db, v.id) }));
}

function casinoContext(db, settings, { actor, programId, now, confirmed = false }) {
  const program = getProgram(db, programId);
  if (!program) throw new HttpError(404);
  const reason = casinoReason(db, programId);
  const ctx = { db, settings, actor, program, reason: { ...reason, needs_person: 1 }, now, confirmed, warnings: [], source: 'casino' };
  actorIsCasinoStaff(ctx);
  if (!reason) throw new ValidationError('error.noCasinoHere');
  programIsOpen(ctx);
  withinTimeWindow(ctx);
  return ctx;
}

function replayed(db, table, nonce) {
  return nonce ? db.prepare(`SELECT id FROM ${table} WHERE nonce = ?`).get(nonce) : null;
}

function personRow(classId, name) {
  const personName = cleanName(name);
  return { classId: parseClassId(classId), personName, personKey: nameKey(personName) };
}

function insertVisit(db, ctx, row, { recorded, nonce }) {
  const startChips = ctx.settings.get('casino.start_chips');
  const { lastInsertRowid: id } = db
    .prepare(`
      INSERT INTO casino_visits (program_id, class_id, person_name, person_key, start_chips, recorded, created_by, created_at, nonce)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ctx.program.id, row.classId, row.personName, row.personKey, startChips, recorded ? 1 : 0, ctx.actor.id, ctx.now, nonce);
  return { id, startChips };
}

/** A player enters and receives the starting stack (visit mode). */
export function recordVisit(db, settings, { actor, programId, classId, name, confirmed = false, nonce = null, now, ip = '' }) {
  return transaction(db, () => {
    const existing = replayed(db, 'casino_visits', nonce);
    if (existing) return { id: existing.id, replayed: true };
    const ctx = casinoContext(db, settings, { actor, programId, now, confirmed });
    requireCasinoMode(ctx, 'casino.record_visits');
    ctx.rows = [personRow(classId, name)];
    runRules([classIsValid, personIsValid, notSelfAward, ownClassPolicy, visitQuota, nameClassConsistency], ctx);
    if (openVisitFor(db, ctx.program.id, ctx.rows[0].personKey)) throw new ValidationError('error.visitOpen');
    finishRules(ctx);
    const visit = insertVisit(db, ctx, ctx.rows[0], { recorded: true, nonce });
    audit(db, { actor, action: 'casino.visit', subject: `visit:${visit.id}`, details: { class: ctx.rows[0].class.name, name: ctx.rows[0].personName, startChips: visit.startChips }, ip, at: now });
    return visit;
  });
}

function openVisitFor(db, programId, personKey, classId = null) {
  return db
    .prepare(`
      SELECT v.* FROM casino_visits v
      WHERE v.program_id = ? AND v.person_key = ? AND (? IS NULL OR v.class_id = ?) AND v.voided_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM casino_cashouts co WHERE co.visit_id = v.id AND co.voided_at IS NULL)
      ORDER BY v.id LIMIT 1`)
    .get(programId, personKey, classId, classId);
}

/**
 * A player hands chips to the House. In visit mode the cash-out closes a
 * recorded visit; in light mode it is the only record, and implies the visit.
 */
export function recordCashout(db, settings, { actor, programId, visitId, classId, name, chips, confirmed = false, nonce = null, now, ip = '' }) {
  return transaction(db, () => {
    const existing = replayed(db, 'casino_cashouts', nonce);
    if (existing) return { id: existing.id, replayed: true };
    const ctx = casinoContext(db, settings, { actor, programId, now, confirmed });
    const count = parseInteger(chips, { min: 0, max: settings.get('casino.max_cashout') });

    let visit;
    if (settings.get('casino.record_visits')) {
      visit = db.prepare('SELECT * FROM casino_visits WHERE id = ? AND program_id = ? AND voided_at IS NULL').get(parseId(visitId), programId);
      if (!visit) throw new HttpError(404);
      if (db.prepare('SELECT 1 FROM casino_cashouts WHERE visit_id = ? AND voided_at IS NULL').get(visit.id)) {
        throw new ValidationError('error.alreadyCashedOut');
      }
      ctx.rows = [{ classId: visit.class_id, personName: visit.person_name, personKey: visit.person_key }];
      runRules([classIsValid, notSelfAward, ownClassPolicy], ctx);
      if (settings.get('casino.record_games') && settings.get('casino.enforce_balance')) {
        cashoutMatchesBalance(count, visitBalance(db, visit.id));
      }
    } else {
      ctx.rows = [personRow(classId, name)];
      runRules([classIsValid, personIsValid, notSelfAward, ownClassPolicy], ctx);
      // A visit recorded before switching to light mode is closed, not duplicated
      // (only if it is the same person in the same class).
      visit = openVisitFor(db, ctx.program.id, ctx.rows[0].personKey, ctx.rows[0].classId);
      if (!visit) runRules([visitQuota, nameClassConsistency], ctx);
      finishRules(ctx);
      visit ??= insertVisit(db, ctx, ctx.rows[0], { recorded: false, nonce: null });
    }

    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO casino_cashouts (visit_id, chips, created_by, created_at, nonce) VALUES (?, ?, ?, ?, ?)')
      .run(visit.id, count, actor.id, now, nonce);
    audit(db, { actor, action: 'casino.cashout', subject: `cashout:${id}`, details: { visit: visit.id, chips: count, class: ctx.rows[0].class.name, name: ctx.rows[0].personName }, ip, at: now });
    return { id, visitId: visit.id };
  });
}

/** Detailed mode: one game with the chip change of every player involved. */
export function recordRound(db, settings, { actor, programId, gameId, results, nonce = null, now, ip = '' }) {
  return transaction(db, () => {
    const existing = replayed(db, 'casino_rounds', nonce);
    if (existing) return { id: existing.id, replayed: true };
    const ctx = casinoContext(db, settings, { actor, programId, now });
    requireCasinoMode(ctx, 'casino.record_games');
    const game = getGame(db, parseId(gameId));
    if (!game || !game.active) throw new ValidationError('error.gameInvalid');

    const maxDelta = settings.get('casino.max_delta');
    const parsed = results
      .filter((r) => String(r.visitId ?? '').trim() && String(r.delta ?? '').trim())
      .map((r) => ({ visitId: parseId(r.visitId), delta: parseInteger(r.delta, { min: -maxDelta, max: maxDelta }) }))
      .filter((r) => r.delta !== 0);
    roundIsBalanced(game, parsed);

    const visits = parsed.map(({ visitId, delta }) => {
      const visit = openVisitById(db, visitId, programId);
      balanceNeverNegative(visitBalance(db, visit.id), [delta]);
      return visit;
    });
    ctx.rows = visits.map((v) => ({ classId: v.class_id, personName: v.person_name, personKey: v.person_key }));
    runRules([classIsValid, notSelfAward, ownClassPolicy], ctx);

    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO casino_rounds (program_id, game_id, created_by, created_at, nonce) VALUES (?, ?, ?, ?, ?)')
      .run(programId, game.id, actor.id, now, nonce);
    const insert = db.prepare('INSERT INTO casino_results (round_id, visit_id, delta) VALUES (?, ?, ?)');
    for (const r of parsed) insert.run(id, r.visitId, r.delta);
    audit(db, { actor, action: 'casino.round', subject: `round:${id}`, details: { game: game.id, kind: game.kind, results: parsed }, ip, at: now });
    return { id };
  });
}

function openVisitById(db, visitId, programId) {
  const visit = db.prepare('SELECT * FROM casino_visits WHERE id = ? AND program_id = ? AND voided_at IS NULL').get(visitId, programId);
  if (!visit) throw new ValidationError('error.visitInvalid');
  if (db.prepare('SELECT 1 FROM casino_cashouts WHERE visit_id = ? AND voided_at IS NULL').get(visitId)) {
    throw new ValidationError('error.alreadyCashedOut');
  }
  return visit;
}

const VOIDABLE = { visit: 'casino_visits', cashout: 'casino_cashouts', round: 'casino_rounds' };

function programOfRecord(db, kind, row) {
  if (kind === 'cashout') return db.prepare('SELECT program_id FROM casino_visits WHERE id = ?').get(row.visit_id).program_id;
  return row.program_id;
}

/**
 * Storno of casino records (Rulebook §5.5, §3.5). Staff may void their own
 * records while the program is open; the superadmin anything. Voiding must
 * never leave the books inconsistent, so dependent records have to go first.
 */
export function voidCasinoRecord(db, settings, { actor, kind, id, reason, now, ip = '' }) {
  return transaction(db, () => {
    const table = VOIDABLE[kind];
    if (!table) throw new HttpError(404);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404);
    if (row.voided_at) throw new ValidationError('error.alreadyVoided');
    const program = getProgram(db, programOfRecord(db, kind, row));
    if (!isSuperadmin(actor)) {
      if (!isCasinoStaff(actor) || row.created_by !== actor.id) throw new HttpError(403, 'error.notYourEntry');
      if (!settings.get('features.storno')) throw new HttpError(403, 'error.featureOff');
      if (program.status !== 'open') throw new ValidationError('error.programNotOpen');
    }
    const voidReason = parseText(reason, { max: 200, required: true });
    const markVoid = (t, recordId) => db.prepare(`UPDATE ${t} SET voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ?`).run(actor.id, now, voidReason, recordId);

    if (kind === 'cashout') {
      if (db.prepare('SELECT 1 FROM entries WHERE cashout_id = ? AND voided_at IS NULL').get(id)) throw new ValidationError('error.alreadyConverted');
      markVoid('casino_cashouts', id);
      const visit = db.prepare('SELECT * FROM casino_visits WHERE id = ?').get(row.visit_id);
      if (!visit.recorded) markVoid('casino_visits', visit.id); // a light-mode cash-out was its own visit
    } else if (kind === 'visit') {
      const hasCashout = db.prepare('SELECT 1 FROM casino_cashouts WHERE visit_id = ? AND voided_at IS NULL').get(id);
      const hasResults = db.prepare(`SELECT 1 FROM (${ACTIVE_ROUND_RESULTS})`).get(id);
      if (hasCashout || hasResults) throw new ValidationError('error.visitHasRecords');
      markVoid('casino_visits', id);
    } else {
      const visitIds = db.prepare('SELECT visit_id FROM casino_results WHERE round_id = ?').all(id).map((r) => r.visit_id);
      for (const visitId of visitIds) {
        if (db.prepare('SELECT 1 FROM casino_cashouts WHERE visit_id = ? AND voided_at IS NULL').get(visitId)) {
          throw new ValidationError('error.roundAfterCashout');
        }
        const remaining = db
          .prepare(`SELECT res.delta FROM casino_results res JOIN casino_rounds r ON r.id = res.round_id
                    WHERE res.visit_id = ? AND r.voided_at IS NULL AND r.id <> ? ORDER BY r.id`)
          .all(visitId, id)
          .map((r) => r.delta);
        const start = db.prepare('SELECT start_chips FROM casino_visits WHERE id = ?').get(visitId).start_chips;
        balanceNeverNegative(start, remaining);
      }
      markVoid('casino_rounds', id);
    }
    audit(db, { actor, action: 'casino.void', subject: `${kind}:${id}`, details: { reason: voidReason }, ip, at: now });
    return { id };
  });
}

/** Physical chip count for one staff member's cash-out box (Rulebook §5.6). */
export function recordCount(db, settings, { actor, programId, staffId, chips, now, ip = '' }) {
  return transaction(db, () => {
    if (!isSuperadmin(actor)) throw new HttpError(403);
    if (!settings.get('casino.reconciliation')) throw new HttpError(403, 'error.featureOff');
    const staff = db.prepare('SELECT id FROM users WHERE id = ?').get(parseId(staffId));
    if (!staff || !getProgram(db, programId)) throw new HttpError(404);
    const count = parseInteger(chips, { min: 0, max: 100_000_000 });
    db.prepare('INSERT INTO casino_counts (program_id, staff_id, chips, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(programId, staff.id, count, actor.id, now);
    audit(db, { actor, action: 'casino.count', subject: `user:${staff.id}`, details: { program: programId, chips: count }, ip, at: now });
  });
}

/** Recorded cash-outs vs. the latest physical count, per staff member. */
export function reconciliation(db, programId) {
  return db
    .prepare(`
      SELECT u.id AS staff_id, u.username,
        (SELECT COALESCE(SUM(co.chips), 0) FROM casino_cashouts co JOIN casino_visits v ON v.id = co.visit_id
          WHERE co.created_by = u.id AND v.program_id = $program AND co.voided_at IS NULL) AS recorded,
        (SELECT cc.chips FROM casino_counts cc WHERE cc.staff_id = u.id AND cc.program_id = $program ORDER BY cc.id DESC LIMIT 1) AS counted
      FROM users u
      WHERE u.is_casino = 1 OR EXISTS (
        SELECT 1 FROM casino_cashouts co JOIN casino_visits v ON v.id = co.visit_id WHERE co.created_by = u.id AND v.program_id = $program)
      ORDER BY u.username`)
    .all({ program: programId })
    .map((r) => ({ ...r, difference: r.counted === null ? null : r.counted - r.recorded }));
}

/** Cash-outs not yet converted, with the points each would give (Rulebook §5.7). */
export function conversionPreview(db, programId) {
  const reason = casinoReason(db, programId);
  if (!reason) return { reason: null, rows: [], openVisits: 0 };
  const rows = db
    .prepare(`
      SELECT co.id AS cashout_id, co.chips, co.created_at AS cashout_at, v.id AS visit_id, v.class_id, v.person_name,
             v.person_key, v.start_chips, v.recorded, v.created_at AS visit_at, c.name AS class_name
      FROM casino_cashouts co JOIN casino_visits v ON v.id = co.visit_id JOIN classes c ON c.id = v.class_id
      WHERE v.program_id = ? AND co.voided_at IS NULL AND v.voided_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.cashout_id = co.id AND e.voided_at IS NULL)
      ORDER BY co.id`)
    .all(programId)
    .map((row) => {
      const values = {
        chips: row.chips,
        start: row.start_chips,
        net: row.chips - row.start_chips,
        minutes: row.recorded ? Math.max(0, minutesBetween(row.visit_at, row.cashout_at)) : 0,
      };
      try {
        const points = evaluateReason(reason, values);
        const inRange = points >= reason.min_points && points <= reason.max_points;
        return { ...row, values, points, error: inRange ? null : 'error.amountOutOfRange' };
      } catch (err) {
        return { ...row, values, points: null, error: err.messageKey ?? 'error.formula' };
      }
    });
  const { n: openVisits } = db
    .prepare(`SELECT COUNT(*) AS n FROM casino_visits v WHERE v.program_id = ? AND v.voided_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM casino_cashouts co WHERE co.visit_id = v.id AND co.voided_at IS NULL)`)
    .get(programId);
  return { reason, rows, openVisits };
}

/** Converts every pending cash-out into a points entry for the player's class, all or nothing. */
export function convertCashouts(db, { actor, programId, now, ip = '' }) {
  return transaction(db, () => {
    if (!isSuperadmin(actor)) throw new HttpError(403);
    const { reason, rows } = conversionPreview(db, programId);
    if (!reason) throw new ValidationError('error.noCasinoHere');
    if (rows.length === 0) throw new ValidationError('error.nothingToConvert');
    if (rows.some((r) => r.error)) throw new ValidationError('error.conversionBlocked');
    const batch = `casino:${programId}:${now}`;
    for (const row of rows) {
      insertEntry(db, {
        program_id: programId,
        reason_id: reason.id,
        class_id: row.class_id,
        person_name: row.person_name,
        person_key: row.person_key,
        amount: row.points,
        inputs: JSON.stringify(row.values),
        source: 'casino',
        batch,
        cashout_id: row.cashout_id,
        created_by: actor.id,
        created_at: now,
      });
    }
    const total = rows.reduce((sum, r) => sum + r.points, 0);
    audit(db, { actor, action: 'casino.convert', subject: `program:${programId}`, details: { count: rows.length, total, batch }, ip, at: now });
    return { count: rows.length, total };
  });
}
