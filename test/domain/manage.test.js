import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classTotal, createAward } from '../../src/domain/awards.js';
import { styleBudget } from '../../src/domain/budget.js';
import { getReason, listClasses } from '../../src/domain/catalog.js';
import { addParam, applyChange, createClasses, createGame, createProgram, createReason, removeParam } from '../../src/domain/manage.js';
import { latestPublicSnapshot, liveStandings, publishSnapshot, rankRows } from '../../src/domain/standings.js';
import { createSession, findSession } from '../../src/auth/sessions.js';
import { createWorld } from '../helpers.js';

function changer(world) {
  return (target, op, value, actor = 'boss') => applyChange(world.db, { actor: world.user(actor), target, op, value, now: world.clock.now() });
}

const lastLog = (world) => {
  const row = world.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return { ...row, details: JSON.parse(row.details) };
};

describe('superadmin changes: set, adjust, toggle (Rulebook §2.4)', () => {
  test('only the superadmin can change values', async () => {
    const world = await createWorld();
    const change = changer(world);
    for (const actor of ['logan', 'org', 'dealer']) assert.throws(() => change('setting:casino.start_chips', 'set', '1', actor), (err) => err.status === 403);
  });

  test('settings: set, adjust within bounds, toggle booleans, choices', async () => {
    const world = await createWorld();
    const change = changer(world);
    assert.deepEqual(change('setting:casino.start_chips', 'set', '200'), { before: 100, after: 200 });
    assert.deepEqual(change('setting:casino.start_chips', 'adjust', '-50'), { before: 200, after: 150 });
    assert.throws(() => change('setting:casino.start_chips', 'adjust', '-151'), { messageKey: 'error.outOfRange' });
    assert.deepEqual(change('setting:features.timer', 'toggle'), { before: 1, after: 0 });
    assert.equal(world.settings.get('features.timer'), false);
    assert.deepEqual(change('setting:features.timer', 'set', '1'), { before: 0, after: 1 });
    assert.deepEqual(change('setting:rules.own_class', 'set', 'block'), { before: 'flag', after: 'block' });
    assert.throws(() => change('setting:rules.own_class', 'set', 'nope'), { messageKey: 'error.invalidChoice' });
    assert.throws(() => change('setting:rules.own_class', 'toggle'), { messageKey: 'error.cannotToggle' });
    assert.throws(() => change('setting:rules.own_class', 'adjust', '1'), { messageKey: 'error.cannotAdjust' });
    assert.throws(() => change('setting:casino.start_chips', 'explode', '1'), { messageKey: 'error.invalidChoice' });
    assert.throws(() => change('setting:nope', 'set', '1'), (err) => err.status === 404);
  });

  test('every change is logged with before and after; a no-op is not', async () => {
    const world = await createWorld();
    const change = changer(world);
    change('setting:casino.max_visits', 'set', '3');
    assert.deepEqual([lastLog(world).action, lastLog(world).subject, lastLog(world).details.before, lastLog(world).details.after], ['value.set', 'setting:casino.max_visits', 1, 3]);
    const count = world.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    change('setting:casino.max_visits', 'set', '3');
    assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, count);
  });

  test('class points: set to a target or change by ±n, both as visible adjustments', async () => {
    const world = await createWorld();
    const change = changer(world);
    const target = `class_points:${world.classes['9.B']}`;
    assert.deepEqual(change(target, 'set', '500'), { before: 0, after: 500 });
    assert.deepEqual(change(target, 'adjust', '-120'), { before: 500, after: 380 });
    assert.equal(classTotal(world.db, world.classes['9.B']), 380);
    assert.deepEqual(world.db.prepare("SELECT amount FROM entries WHERE source = 'adjustment' ORDER BY id").all().map((e) => e.amount), [500, -120]);
    assert.throws(() => change(target, 'toggle'), { messageKey: 'error.cannotToggle' });
    assert.throws(() => change('class_points:99999', 'set', '5'), (err) => err.status === 404);
  });

  test('style budgets: the remaining amount is what the superadmin sets', async () => {
    const world = await createWorld();
    const change = changer(world);
    createAward(world.db, world.settings, { actor: world.users.org, reasonId: world.reasons.style, input: { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '30' }, now: world.clock.now() });
    const target = `budget:${world.users.org.id}:${world.program.id}`;
    assert.deepEqual(change(target, 'set', '100'), { before: 60, after: 100 });
    assert.deepEqual(styleBudget(world.db, world.users.org.id, world.program.id), { allotted: 130, spent: 30, remaining: 100, custom: true });
    assert.deepEqual(change(target, 'adjust', '-40'), { before: 100, after: 60 });
    assert.throws(() => change(target, 'adjust', '-61'), { messageKey: 'error.outOfRange' });
    assert.throws(() => change(target, 'set', '-1'), { messageKey: 'error.outOfRange' });
    assert.throws(() => change(`budget:999:${world.program.id}`, 'set', '1'), (err) => err.status === 404);
  });

  test('programs: status, dates in Budapest time, texts, budgets', async () => {
    const world = await createWorld();
    const change = changer(world);
    const p = world.program.id;
    change(`program:${p}:status`, 'set', 'closed');
    change(`program:${p}:starts_at`, 'set', '2026-09-18T14:00');
    assert.equal(world.db.prepare('SELECT starts_at FROM programs WHERE id = ?').get(p).starts_at, '2026-09-18T12:00:00.000Z');
    change(`program:${p}:starts_at`, 'set', '');
    assert.equal(world.db.prepare('SELECT starts_at FROM programs WHERE id = ?').get(p).starts_at, null);
    assert.throws(() => change(`program:${p}:starts_at`, 'set', '2026-02-30T10:00'), { messageKey: 'error.invalidDate' });
    assert.deepEqual(change(`program:${p}:style_budget`, 'adjust', '10'), { before: 90, after: 100 });
    assert.throws(() => change(`program:${p}:name_hu`, 'set', ''), { messageKey: 'error.required' });
    change(`program:${p}:description_en`, 'set', '<b>bold</b> text');
    assert.equal(world.db.prepare('SELECT description_en FROM programs WHERE id = ?').get(p).description_en, '<b>bold</b> text', 'stored as text, escaped on output');
    assert.throws(() => change(`program:${p}:slug`, 'set', 'x'), (err) => err.status === 404, 'not an editable column');
    assert.throws(() => change(`program:999:status`, 'set', 'open'), (err) => err.status === 404);
    assert.throws(() => change(`hacker:1:x`, 'set', 'open'), (err) => err.status === 404);
  });

  test('reasons: limits stay consistent and formulas are validated', async () => {
    const world = await createWorld();
    const change = changer(world);
    const r = world.reasons.style;
    assert.throws(() => change(`reason:${r}:min_points`, 'set', '100'), { messageKey: 'error.minAboveMax' });
    change(`reason:${r}:max_points`, 'set', '150');
    change(`reason:${r}:min_points`, 'set', '100');
    const m = world.reasons.menetlevel;
    assert.throws(() => change(`reason:${m}:formula`, 'set', 'stamps *'), { messageKey: 'error.formula' });
    change(`reason:${m}:formula`, 'set', 'stamps * stamp_points + people * 3');
    const pool = world.reasons.pool;
    assert.throws(() => change(`reason:${pool}:formula`, 'set', 'participants * bonus'), { messageKey: 'error.formulaUnknown' });
    const casino = world.reasons.casino;
    change(`reason:${casino}:formula`, 'set', 'max(0, net) / chips_per_point + minutes / 10');
    assert.throws(() => change(`reason:${world.reasons.minutes}:formula`, 'set', 'points_per_minute * 60'), { messageKey: 'error.formulaNeedsMinutes' });
    assert.throws(() => change(`reason:${r}:kind`, 'set', 'lottery'), { messageKey: 'error.invalidChoice' });
    change(`reason:${r}:active`, 'toggle');
    assert.equal(getReason(world.db, r).active, 0);
  });

  test('parameters: change by any decimal, add and remove', async () => {
    const world = await createWorld();
    const change = changer(world);
    const m = world.reasons.menetlevel;
    assert.deepEqual(change(`param:${m}:stamp_points`, 'adjust', '0.5'), { before: 5, after: 5.5 });
    assert.deepEqual(change(`param:${m}:stamp_points`, 'set', '4'), { before: 5.5, after: 4 });
    assert.throws(() => change(`param:${m}:nope`, 'set', '1'), (err) => err.status === 404);
    const actor = world.users.boss;
    addParam(world.db, { actor, reasonId: m, name: 'max_stamps', value: '200', now: world.clock.now() });
    assert.equal(getReason(world.db, m).params.max_stamps, 200);
    assert.throws(() => addParam(world.db, { actor, reasonId: m, name: 'max_stamps', value: '1', now: 'x' }), { messageKey: 'error.duplicateName' });
    for (const bad of ['Max', '1x', '_x', 'a-b', '']) assert.throws(() => addParam(world.db, { actor, reasonId: m, name: bad, value: '1', now: 'x' }), { messageKey: 'error.paramName' }, bad);
    assert.throws(() => addParam(world.db, { actor, reasonId: m, name: 'ok', value: 'abc', now: 'x' }), { messageKey: 'error.notNumber' });
    removeParam(world.db, { actor, reasonId: m, name: 'max_stamps', now: world.clock.now() });
    assert.equal(getReason(world.db, m).params.max_stamps, undefined);
    assert.throws(() => removeParam(world.db, { actor, reasonId: m, name: 'max_stamps', now: 'x' }), (err) => err.status === 404);
    assert.throws(() => addParam(world.db, { actor: world.users.logan, reasonId: m, name: 'x', value: '1', now: 'x' }), (err) => err.status === 403);
  });

  test('users: roles and flags change immediately, but the superadmin cannot lock themselves out', async () => {
    const world = await createWorld();
    const change = changer(world);
    const { token } = createSession(world.db, world.users.org.id, { hours: 1, now: 0 });
    change(`user:${world.users.org.id}:role`, 'set', 'logadmin');
    assert.equal(findSession(world.db, token, 1), null, 'a role change logs the user out');
    change(`user:${world.users.org.id}:is_casino`, 'toggle');
    change(`user:${world.users.org.id}:class_id`, 'set', String(world.classes['7.A']));
    change(`user:${world.users.org.id}:class_id`, 'set', '');
    assert.throws(() => change(`user:${world.users.org.id}:class_id`, 'set', '999'), { messageKey: 'error.classInvalid' });
    const org = world.user('org');
    assert.deepEqual([org.role, org.is_casino, org.class_id], ['logadmin', 1, null]);
    assert.throws(() => change(`user:${world.users.boss.id}:role`, 'set', 'admin'), { messageKey: 'error.cannotLockSelf' });
    assert.throws(() => change(`user:${world.users.boss.id}:active`, 'toggle'), { messageKey: 'error.cannotLockSelf' });
    assert.throws(() => change(`user:${world.users.boss.id}:password_hash`, 'set', 'x'), (err) => err.status === 404, 'passwords are console-only');
  });

  test('classes and snapshots', async () => {
    const world = await createWorld();
    const change = changer(world);
    assert.throws(() => change(`class:${world.classes['9.B']}:name`, 'set', '9.a'), { messageKey: 'error.duplicateName' });
    change(`class:${world.classes['9.B']}:name`, 'set', '9.C');
    change(`class:${world.classes['9.B']}:active`, 'toggle');
    const snapshot = publishSnapshot(world.db, { actor: world.users.boss, label: 'x', now: world.clock.now() });
    change(`snapshot:${snapshot.id}:hidden`, 'toggle');
    assert.equal(latestPublicSnapshot(world.db, 10), null);
  });
});

describe('creating things', () => {
  test('classes from text: trimmed, deduplicated, sorted by grade, logged', async () => {
    const world = await createWorld();
    const { added } = createClasses(world.db, { actor: world.users.boss, names: ' 12.B\n8. C ; 9.A, 12.B\n\n', now: world.clock.now() });
    assert.deepEqual(added, ['12.B', '8.C']);
    assert.deepEqual(listClasses(world.db).map((c) => c.name), ['7.A', '8.C', '9.A', '9.B', '10.A', '11.A', '12.B']);
    assert.throws(() => createClasses(world.db, { actor: world.users.boss, names: 'x'.repeat(21), now: 'x' }), { messageKey: 'error.tooLong' });
    assert.throws(() => createClasses(world.db, { actor: world.users.logan, names: '5.A', now: 'x' }), (err) => err.status === 403);
    assert.deepEqual(createClasses(world.db, { actor: world.users.boss, names: '', now: 'x' }), { added: [] });
  });

  test('programs get unique slugs', async () => {
    const world = await createWorld();
    const a = createProgram(world.db, { actor: world.users.boss, nameHu: 'Farsang', nameEn: '', now: world.clock.now() });
    const b = createProgram(world.db, { actor: world.users.boss, nameHu: 'Farsang', nameEn: 'Carnival', now: world.clock.now() });
    const slugs = world.db.prepare('SELECT slug, name_en FROM programs WHERE id IN (?, ?) ORDER BY id').all(a.id, b.id).map((row) => ({ ...row }));
    assert.deepEqual(slugs, [{ slug: 'farsang', name_en: 'Farsang' }, { slug: 'farsang-2', name_en: 'Carnival' }]);
    const c = createProgram(world.db, { actor: world.users.boss, nameHu: '!!!', now: world.clock.now() });
    assert.equal(world.db.prepare('SELECT slug FROM programs WHERE id = ?').get(c.id).slug, 'program');
    assert.throws(() => createProgram(world.db, { actor: world.users.boss, nameHu: ' ', now: 'x' }), { messageKey: 'error.required' });
  });

  test('reasons get kind-specific defaults that work right away', async () => {
    const world = await createWorld();
    const actor = world.users.boss;
    const { id } = createReason(world.db, { actor, programId: world.program.id, nameHu: 'Részvétel – csocsó 2', nameEn: '', kind: 'minutes', now: world.clock.now() });
    const reason = getReason(world.db, id);
    assert.deepEqual(reason.params, { max_minutes: 240, points_per_minute: 1 });
    const result = createAward(world.db, world.settings, { actor: world.users.org, reasonId: id, input: { classId: world.classes['9.B'], name: 'Új Diák', inputs: { minutes: '12' } }, now: world.clock.now() });
    assert.equal(result.total, 12);
    assert.throws(() => createReason(world.db, { actor, programId: world.program.id, nameHu: 'X', kind: 'lottery', now: 'x' }), { messageKey: 'error.invalidChoice' });
    assert.throws(() => createReason(world.db, { actor, programId: 999, nameHu: 'X', kind: 'manual', now: 'x' }), (err) => err.status === 404);
  });

  test('casino games', async () => {
    const world = await createWorld();
    const { id } = createGame(world.db, { actor: world.users.boss, nameHu: 'Craps', nameEn: '', kind: 'house', now: world.clock.now() });
    assert.equal(world.db.prepare('SELECT name_en FROM casino_games WHERE id = ?').get(id).name_en, 'Craps');
    assert.throws(() => createGame(world.db, { actor: world.users.boss, nameHu: 'X', kind: 'both', now: 'x' }), { messageKey: 'error.invalidChoice' });
    assert.throws(() => createGame(world.db, { actor: world.users.dealer, nameHu: 'X', kind: 'house', now: 'x' }), (err) => err.status === 403);
  });
});

describe('standings (Rulebook §7.2, §7.3)', () => {
  test('competition ranking: ties share a place and the next place is skipped', () => {
    const ranked = rankRows([
      { name: '9.B', points: 50 },
      { name: '7.A', points: 80 },
      { name: '10.A', points: 50 },
      { name: '11.A', points: 10 },
      { name: '9.A', points: 80 },
    ]);
    assert.deepEqual(ranked.map((r) => [r.rank, r.name]), [[1, '7.A'], [1, '9.A'], [3, '9.B'], [3, '10.A'], [5, '11.A']]);
    assert.deepEqual(rankRows([]), []);
  });

  test('live standings count active entries of active classes only', async () => {
    const world = await createWorld();
    const change = changer(world);
    change(`class_points:${world.classes['9.B']}`, 'set', '40');
    change(`class_points:${world.classes['7.A']}`, 'set', '40');
    change(`class_points:${world.classes['11.A']}`, 'set', '-5');
    change(`class:${world.classes['10.A']}:active`, 'toggle');
    const rows = liveStandings(world.db);
    assert.deepEqual(rows.map((r) => [r.rank, r.name, r.points]), [[1, '7.A', 40], [1, '9.B', 40], [3, '9.A', 0], [4, '11.A', -5]]);
  });

  test('publishing freezes a snapshot; later points don’t leak to the public list', async () => {
    const world = await createWorld();
    const change = changer(world);
    change(`class_points:${world.classes['9.B']}`, 'set', '40');
    assert.throws(() => publishSnapshot(world.db, { actor: world.users.logan, label: 'x', now: 'x' }), (err) => err.status === 403);
    publishSnapshot(world.db, { actor: world.users.boss, label: 'Nyitóbuli után', now: world.clock.now() });
    change(`class_points:${world.classes['7.A']}`, 'set', '999');
    const snapshot = latestPublicSnapshot(world.db, 2);
    assert.equal(snapshot.label, 'Nyitóbuli után');
    // Top 2 places: 9.B alone first, then everyone tied on 0 shares second place (ties are never cut off).
    assert.deepEqual(snapshot.rows.map((r) => [r.rank, r.name, r.points]), [[1, '9.B', 40], [2, '7.A', 0], [2, '9.A', 0], [2, '10.A', 0], [2, '11.A', 0]]);
    assert.equal(latestPublicSnapshot(world.db, 1).rows.length, 1);
    assert.throws(() => publishSnapshot(world.db, { actor: world.users.boss, label: 'x'.repeat(81), now: 'x' }), { messageKey: 'error.tooLong' });
  });
});
