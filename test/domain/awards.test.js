import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { adjustClassPoints, classTotal, correctEntry, createAward, evaluateReason, formulaInputs, listEntries, voidEntry } from '../../src/domain/awards.js';
import { verifyAuditChain } from '../../src/domain/audit.js';
import { styleBudget } from '../../src/domain/budget.js';
import { getReason } from '../../src/domain/catalog.js';
import { NeedsConfirmation } from '../../src/domain/rules/index.js';
import { HttpError, ValidationError } from '../../src/http/errors.js';
import { createWorld } from '../helpers.js';

/** Awards through the domain layer with sensible defaults; the clock moves 3 minutes so no duplicate warnings. */
function award(world, actor, reasonKey, input, extra = {}) {
  world.clock.advance(180);
  return createAward(world.db, world.settings, { actor: world.user(actor), reasonId: world.reasons[reasonKey] ?? reasonKey, input, now: world.clock.now(), ...extra });
}

const style = (world, classKey, name, amount, actor = 'org', extra) => award(world, actor, 'style', { classId: world.classes[classKey], name, amount: String(amount) }, extra);

const rejects = (fn, key) => assert.throws(fn, (err) => err instanceof HttpError && err.messageKey === key, key);

describe('awarding: reason kinds', () => {
  test('style points use the typed amount and come out of the allowance', async () => {
    const world = await createWorld();
    const { ids, total } = style(world, '9.B', 'Kiss Anna', 30);
    assert.equal(total, 30);
    const entry = world.db.prepare('SELECT * FROM entries WHERE id = ?').get(ids[0]);
    assert.equal(entry.person_name, 'Kiss Anna');
    assert.equal(entry.person_key, 'anna kiss');
    assert.equal(entry.source, 'form');
    assert.deepEqual(styleBudget(world.db, world.users.org.id, world.program.id), { allotted: 90, spent: 30, remaining: 60, custom: false });
  });

  test('menetlevél: 5 points per stamp + 2 per person, recorded for the class', async () => {
    const world = await createWorld();
    const { total, ids } = award(world, 'org', 'menetlevel', { classId: world.classes['10.A'], inputs: { stamps: '40', people: '10' } });
    assert.equal(total, 220);
    const entry = world.db.prepare('SELECT * FROM entries WHERE id = ?').get(ids[0]);
    assert.deepEqual(JSON.parse(entry.inputs), { stamps: 40, people: 10 });
    assert.equal(entry.person_name, '');
  });

  test('per-minute participation typed by hand', async () => {
    const world = await createWorld();
    assert.equal(award(world, 'org', 'minutes', { classId: world.classes['9.B'], name: 'Nagy Péter', inputs: { minutes: '45' } }).total, 45);
  });

  test('mini championship formula rounds half away from zero', async () => {
    const world = await createWorld();
    // 3 participants × 2 + 5 minutes × 0.5 = 8.5 → 9
    assert.equal(award(world, 'org', 'mini', { classId: world.classes['9.B'], name: 'Győztes Gergő', inputs: { participants: '3', minutes: '5' } }).total, 9);
  });

  test('pool: performers × 10 shared freely, empty rows ignored, one batch', async () => {
    const world = await createWorld();
    const rows = [
      { name: 'Első Előadó', classId: world.classes['9.B'], amount: '8' },
      { name: '', classId: '', amount: '' },
      { name: 'Második Előadó', classId: world.classes['10.A'], amount: '9' },
      { name: 'Harmadik Előadó', classId: world.classes['11.A'], amount: '13' },
    ];
    const { ids, total } = award(world, 'org', 'pool', { rows });
    assert.equal(ids.length, 3);
    assert.equal(total, 30);
    const batches = world.db.prepare('SELECT DISTINCT batch, source FROM entries').all();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].source, 'pool');
    assert.match(batches[0].batch, /^pool:/);
  });

  test('casino reasons cannot be awarded by hand', async () => {
    const world = await createWorld();
    rejects(() => award(world, 'boss', 'casino', { classId: world.classes['9.A'], name: 'X Y', amount: '10' }), 'error.reasonNotAwardable');
  });

  test('formula helpers list only typed inputs', async () => {
    const world = await createWorld();
    assert.deepEqual(formulaInputs(getReason(world.db, world.reasons.menetlevel)).sort(), ['people', 'stamps']);
    assert.deepEqual(formulaInputs(getReason(world.db, world.reasons.style)), []);
    assert.deepEqual(formulaInputs({ kind: 'formula', formula: '(((', params: {} }), []);
    assert.throws(() => evaluateReason({ formula: 'x / 0', params: { x: 1 } }, {}), (err) => err.messageKey === 'error.formula');
  });
});

describe('awarding: access rules (Rulebook §2.2, §3.2, §3.6, §5.8)', () => {
  test('casino staff can never award points', async () => {
    const world = await createWorld();
    rejects(() => style(world, '9.B', 'Kiss Anna', 5, 'dealer'), 'error.casinoCannotAward');
  });

  test('the points switch stops organizers but not the superadmin', async () => {
    const world = await createWorld();
    world.settings.set('features.points', false);
    rejects(() => style(world, '9.B', 'Kiss Anna', 5), 'error.featureOff');
    assert.ok(style(world, '9.B', 'Kiss Anna', 5, 'boss').ids.length);
  });

  test('closed and upcoming programs are frozen for organizers', async () => {
    const world = await createWorld();
    for (const status of ['closed', 'upcoming']) {
      world.db.prepare('UPDATE programs SET status = ? WHERE id = ?').run(status, world.program.id);
      rejects(() => style(world, '9.B', 'Kiss Anna', 5), 'error.programNotOpen');
      rejects(() => style(world, '9.B', 'Kiss Anna', 5, 'logan'), 'error.programNotOpen');
    }
    assert.ok(style(world, '9.B', 'Kiss Anna', 5, 'boss').ids.length, 'the superadmin can still fix things');
  });

  test('optional time window', async () => {
    const world = await createWorld();
    const now = world.clock.peek();
    world.db.prepare('UPDATE programs SET starts_at = ?, ends_at = ? WHERE id = ?').run('2026-09-18T14:00:00.000Z', '2026-09-18T20:00:00.000Z', world.program.id);
    assert.ok(now < '2026-09-18T14:00:00.000Z');
    assert.ok(style(world, '9.B', 'Early Bird', 5).ids.length, 'switch off by default');
    world.settings.set('rules.enforce_time_window', true);
    rejects(() => style(world, '9.B', 'Early Bird', 5), 'error.outsideTimeWindow');
    world.clock.advance(3 * 3600);
    assert.ok(style(world, '9.B', 'On Time', 5).ids.length);
    world.clock.advance(10 * 3600);
    rejects(() => style(world, '9.B', 'Late Comer', 5), 'error.outsideTimeWindow');
    assert.ok(style(world, '9.B', 'Late Comer', 5, 'boss').ids.length);
  });

  test('reasons must be active, belong to the program and have their module on', async () => {
    const world = await createWorld();
    world.db.prepare('UPDATE reasons SET active = 0 WHERE id = ?').run(world.reasons.style);
    rejects(() => style(world, '9.B', 'Kiss Anna', 5), 'error.reasonUnavailable');
    const halloweenReason = world.db.prepare("SELECT r.id FROM reasons r JOIN programs p ON p.id = r.program_id WHERE p.slug = 'halloween'").get().id;
    assert.throws(() => award(world, 'org', halloweenReason, { classId: world.classes['9.B'], amount: '5' }), (err) => ['error.programNotOpen', 'error.reasonUnavailable'].includes(err.messageKey));
    world.settings.set('features.style_points', false);
    rejects(() => award(world, 'org', 'style2', { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '5' }), 'error.featureOff');
    world.settings.set('features.pool', false);
    rejects(() => award(world, 'org', 'pool', { rows: [{ name: 'A B', classId: world.classes['9.B'], amount: '5' }] }), 'error.featureOff');
    world.settings.set('features.manual_minutes', false);
    rejects(() => award(world, 'org', 'minutes', { classId: world.classes['9.B'], name: 'A B', inputs: { minutes: '5' } }), 'error.featureOff');
    assert.throws(() => award(world, 'org', 999_999, {}), (err) => err.status === 404);
  });
});

describe('awarding: input rules (Rulebook §2.3, §3.2–3.4)', () => {
  test('class must exist and be active', async () => {
    const world = await createWorld();
    rejects(() => award(world, 'org', 'style', { classId: '', name: 'Kiss Anna', amount: '5' }), 'error.classInvalid');
    rejects(() => award(world, 'org', 'style', { classId: '999', name: 'Kiss Anna', amount: '5' }), 'error.classInvalid');
    rejects(() => award(world, 'org', 'style', { classId: '9.A', name: 'Kiss Anna', amount: '5' }), 'error.classInvalid');
    world.db.prepare('UPDATE classes SET active = 0 WHERE id = ?').run(world.classes['7.A']);
    rejects(() => style(world, '7.A', 'Kiss Anna', 5), 'error.classInvalid');
  });

  test('names: required for person reasons, must look like a name', async () => {
    const world = await createWorld();
    rejects(() => style(world, '9.B', '   ', 5), 'error.nameRequired');
    rejects(() => style(world, '9.B', '12345', 5), 'error.nameInvalid');
    rejects(() => style(world, '9.B', 'x'.repeat(81), 5), 'error.nameInvalid');
    assert.ok(award(world, 'org', 'menetlevel', { classId: world.classes['9.B'], name: '', inputs: { stamps: '1', people: '1' } }).ids.length);
  });

  test('nobody awards themselves, however the name is typed', async () => {
    const world = await createWorld();
    rejects(() => style(world, '9.A', 'bence  TORNAI', 5), 'error.selfAward');
    rejects(() => style(world, '9.A', 'Rovenszky Robin', 5, 'boss'), 'error.selfAward');
    assert.ok(style(world, '10.A', 'Tornai Bence', 5).ids.length, 'a namesake in another class is fine when the organizer’s class is known');
  });

  test('amounts must be whole numbers within the reason limits', async () => {
    const world = await createWorld();
    for (const bad of ['0', '91', '-5', '1000000']) rejects(() => style(world, '9.B', 'Kiss Anna', bad), 'error.amountOutOfRange');
    for (const bad of ['5.5', '1e2', 'five', '']) rejects(() => style(world, '9.B', 'Kiss Anna', bad), 'error.notInteger');
    const snitch = world.db.prepare("SELECT r.id, r.program_id FROM reasons r JOIN programs p ON p.id = r.program_id WHERE p.slug = 'arany-cikesz'").get();
    world.db.prepare("UPDATE programs SET status = 'open' WHERE id = ?").run(snitch.program_id);
    rejects(() => award(world, 'org', snitch.id, { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '59' }), 'error.amountOutOfRange');
    assert.equal(award(world, 'org', snitch.id, { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '60' }).total, 60);
  });

  test('formula inputs are non-negative integers under their max_<input> caps', async () => {
    const world = await createWorld();
    const minutes = (value) => award(world, 'org', 'minutes', { classId: world.classes['9.B'], name: 'Nagy Péter', inputs: { minutes: value } });
    rejects(() => minutes('241'), 'error.inputOutOfRange');
    rejects(() => minutes('-1'), 'error.inputInvalid');
    rejects(() => minutes('1.5'), 'error.inputInvalid');
    rejects(() => minutes(undefined), 'error.inputInvalid');
    world.settings.set('rules.max_input', '100');
    rejects(() => minutes('150'), 'error.inputOutOfRange');
    rejects(() => award(world, 'org', 'menetlevel', { classId: world.classes['9.B'], inputs: { stamps: '101', people: '1' } }), 'error.inputOutOfRange');
    assert.equal(minutes('100').total, 100);
    rejects(() => minutes('0'), 'error.amountOutOfRange');
  });
});

describe('awarding: limits (Rulebook §4.1, §4.2, §4.6)', () => {
  test('the style allowance can be used exactly, never exceeded', async () => {
    const world = await createWorld();
    style(world, '9.B', 'Egy Diák', 50);
    rejects(() => style(world, '10.A', 'Két Diák', 41), 'error.budgetExceeded');
    assert.ok(style(world, '10.A', 'Két Diák', 40).ids.length);
    rejects(() => style(world, '11.A', 'Három Diák', 1), 'error.budgetExceeded');
  });

  test('allowances are per organizer and per program, and personal amounts override the default', async () => {
    const world = await createWorld();
    style(world, '9.B', 'Egy Diák', 90);
    assert.ok(style(world, '9.B', 'Egy Diák', 90, 'org2').ids.length, 'another organizer has their own 90');
    world.db.prepare('INSERT INTO budgets (user_id, program_id, amount) VALUES (?, ?, 100)').run(world.users.org.id, world.program.id);
    assert.ok(style(world, '9.B', 'Másik Diák', 10).ids.length);
    rejects(() => style(world, '9.B', 'Harmadik Diák', 1), 'error.budgetExceeded');
  });

  test('voiding a style award gives the points back', async () => {
    const world = await createWorld();
    const { ids } = style(world, '9.B', 'Egy Diák', 90);
    voidEntry(world.db, world.settings, { actor: world.users.org, entryId: ids[0], reason: 'mistake', now: world.clock.now() });
    assert.equal(styleBudget(world.db, world.users.org.id, world.program.id).remaining, 90);
  });

  test('optional per-recipient cap', async () => {
    const world = await createWorld();
    world.settings.set('rules.style_per_recipient', '20');
    style(world, '9.B', 'Kedvenc Diák', 15);
    rejects(() => style(world, '9.B', 'diák kedvenc', 6), 'error.recipientCap');
    assert.ok(style(world, '9.B', 'Kedvenc Diák', 5).ids.length);
    assert.ok(style(world, '9.B', 'Kedvenc Diák', 20, 'org2').ids.length, 'the cap is per organizer');
  });

  test('pools: never above performers × 10, no duplicate performer, not empty', async () => {
    const world = await createWorld();
    const row = (name, amount, cls = '9.B') => ({ name, classId: world.classes[cls], amount: String(amount) });
    rejects(() => award(world, 'org', 'pool', { rows: [row('A B', 11)] }), 'error.poolExceeded');
    rejects(() => award(world, 'org', 'pool', { rows: [row('A B', 5), row('b a', 5, '10.A')] }), 'error.poolDuplicatePerson');
    rejects(() => award(world, 'org', 'pool', { rows: [row('', 5)] }), 'error.poolEmpty');
    rejects(() => award(world, 'org', 'pool', {}), 'error.poolEmpty');
    rejects(() => award(world, 'org', 'pool', { rows: [row('A B', 5), { name: 'C D', classId: '', amount: '5' }] }), 'error.classInvalid');
    assert.equal(award(world, 'org', 'pool', { rows: [row('A B', 20), row('C D', 0, '10.A')] }).total, 20, 'zero-point performers still count');
  });

  test('route sheets are counted once per class (max_entries_per_class)', async () => {
    const world = await createWorld();
    const sheet = (cls) => award(world, 'org', 'menetlevel', { classId: world.classes[cls], inputs: { stamps: '1', people: '1' } });
    const { ids } = sheet('9.B');
    rejects(() => sheet('9.B'), 'error.perClassLimit');
    rejects(() => award(world, 'org2', 'menetlevel', { classId: world.classes['9.B'], inputs: { stamps: '1', people: '1' } }), 'error.perClassLimit');
    assert.ok(sheet('10.A').ids.length);
    voidEntry(world.db, world.settings, { actor: world.users.org, entryId: ids[0], reason: 'recount', now: world.clock.now() });
    assert.ok(sheet('9.B').ids.length, 'after a storno it can be recorded again');
  });

  test('max_entries_per_person, also inside one pool', async () => {
    const world = await createWorld();
    world.db.prepare("INSERT INTO reason_params (reason_id, name, value) VALUES (?, 'max_entries_per_person', 1)").run(world.reasons.style);
    style(world, '9.B', 'Egyszer Kaphat', 5);
    rejects(() => style(world, '9.B', 'Egyszer Kaphat', 5, 'org2'), 'error.perPersonLimit');
    world.db.prepare("INSERT INTO reason_params (reason_id, name, value) VALUES (?, 'max_entries_per_class', 1)").run(world.reasons.pool);
    rejects(
      () => award(world, 'org', 'pool', { rows: [{ name: 'A B', classId: world.classes['10.A'], amount: '5' }, { name: 'C D', classId: world.classes['10.A'], amount: '5' }] }),
      'error.perClassLimit',
    );
  });
});

describe('awarding: integrity rules (Rulebook §2.3, §3.3, §3.8)', () => {
  test('own class: allowed by default, blockable, never for the superadmin', async () => {
    const world = await createWorld();
    assert.ok(style(world, '9.A', 'Osztálytárs Olga', 5).ids.length);
    world.settings.set('rules.own_class', 'block');
    rejects(() => style(world, '9.A', 'Osztálytárs Olga', 5), 'error.ownClassBlocked');
    rejects(() => award(world, 'org', 'pool', { rows: [{ name: 'X Y', classId: world.classes['10.A'], amount: '5' }, { name: 'Z W', classId: world.classes['9.A'], amount: '5' }] }), 'error.ownClassBlocked');
    assert.ok(style(world, '9.B', 'Más Osztály', 5).ids.length);
    world.db.prepare('UPDATE users SET class_id = ? WHERE username = ?').run(world.classes['9.A'], 'boss');
    assert.ok(style(world, '9.A', 'Osztálytárs Olga', 5, 'boss').ids.length);
  });

  test('same student in another class: confirm (default), block or allow', async () => {
    const world = await createWorld();
    style(world, '9.B', 'Kiss Anna', 5);
    assert.throws(() => style(world, '10.A', 'anna kiss', 5), (err) => err instanceof NeedsConfirmation && err.warnings[0].key === 'warning.nameClassConflict' && err.warnings[0].vars.className === '9.B');
    const { ids } = style(world, '10.A', 'anna kiss', 5, 'org', { confirmed: true });
    const log = world.db.prepare("SELECT details FROM audit_log WHERE action = 'entry.create' ORDER BY id DESC").get();
    assert.deepEqual(JSON.parse(log.details).confirmedWarnings, ['warning.nameClassConflict'], 'the confirmation is logged');
    world.settings.set('rules.name_class_conflict', 'block');
    rejects(() => style(world, '11.A', 'Kiss Anna', 5), 'error.nameClassConflict');
    world.settings.set('rules.name_class_conflict', 'allow');
    assert.ok(style(world, '11.A', 'Kiss Anna', 5).ids.length);
    assert.ok(ids.length);
  });

  test('the conflict check also sees running timers and casino visits', async () => {
    const world = await createWorld();
    world.db.prepare("INSERT INTO timers (reason_id, class_id, person_name, person_key, started_by, started_at) VALUES (?, ?, 'Időmérős Ida', 'ida idomeros', ?, 'x')").run(world.reasons.minutes, world.classes['7.A'], world.users.org.id);
    world.db.prepare("INSERT INTO casino_visits (program_id, class_id, person_name, person_key, start_chips, created_by, created_at) VALUES (?, ?, 'Kártyás Kata', 'kartyas kata', 100, ?, 'x')").run(world.program.id, world.classes['7.A'], world.users.dealer.id);
    assert.throws(() => style(world, '9.B', 'Időmérős Ida', 5), NeedsConfirmation);
    assert.throws(() => style(world, '9.B', 'Kártyás Kata', 5), NeedsConfirmation);
  });

  test('a quick repeat by the same organizer needs confirmation', async () => {
    const world = await createWorld();
    const args = { actor: world.users.org, reasonId: world.reasons.style, input: { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '5' } };
    createAward(world.db, world.settings, { ...args, now: '2026-09-18T12:00:00.000Z' });
    assert.throws(() => createAward(world.db, world.settings, { ...args, now: '2026-09-18T12:01:59.000Z' }), (err) => err instanceof NeedsConfirmation && err.warnings[0].key === 'warning.recentDuplicate');
    assert.ok(createAward(world.db, world.settings, { ...args, now: '2026-09-18T12:02:01.000Z' }).ids.length, 'outside the window');
    assert.ok(createAward(world.db, world.settings, { ...args, actor: world.users.org2, now: '2026-09-18T12:02:02.000Z' }).ids.length, 'another organizer');
    world.settings.set('rules.duplicate_seconds', '0');
    assert.ok(createAward(world.db, world.settings, { ...args, now: '2026-09-18T12:02:03.000Z' }).ids.length, 'switched off');
  });

  test('replaying the same form (same nonce) never records twice', async () => {
    const world = await createWorld();
    const nonce = '8a6e0804-2bd0-4672-b79a-d97b17e0f1e1';
    const first = style(world, '9.B', 'Kiss Anna', 5, 'org', { nonce });
    const again = style(world, '9.B', 'Kiss Anna', 5, 'org', { nonce });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.ids, first.ids);
    assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM entries').get().n, 1);
  });

  test('a rejected award writes nothing at all', async () => {
    const world = await createWorld();
    const before = world.db.prepare('SELECT (SELECT COUNT(*) FROM entries) + (SELECT COUNT(*) FROM audit_log) AS n').get().n;
    assert.throws(() => style(world, '9.B', 'Kiss Anna', 500));
    assert.throws(() => award(world, 'org', 'pool', { rows: [{ name: 'A B', classId: world.classes['9.B'], amount: '5' }, { name: 'C D', classId: world.classes['9.B'], amount: '50' }] }));
    assert.equal(world.db.prepare('SELECT (SELECT COUNT(*) FROM entries) + (SELECT COUNT(*) FROM audit_log) AS n').get().n, before);
  });

  test('notes are optional and length-limited', async () => {
    const world = await createWorld();
    rejects(() => award(world, 'org', 'style', { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '5', note: 'x'.repeat(201) }), 'error.tooLong');
    const { ids } = award(world, 'org', 'style', { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '5', note: ' ivóverseny győztese ' });
    assert.equal(world.db.prepare('SELECT note FROM entries WHERE id = ?').get(ids[0]).note, 'ivóverseny győztese');
  });
});

describe('storno and correction (Rulebook §3.5)', () => {
  test('organizers void their own entries with a reason; it is logged and can’t be repeated', async () => {
    const world = await createWorld();
    const { ids } = style(world, '9.B', 'Kiss Anna', 10);
    rejects(() => voidEntry(world.db, world.settings, { actor: world.users.org, entryId: ids[0], reason: '  ', now: world.clock.now() }), 'error.required');
    voidEntry(world.db, world.settings, { actor: world.users.org, entryId: ids[0], reason: 'wrong class', now: world.clock.now() });
    const entry = world.db.prepare('SELECT * FROM entries WHERE id = ?').get(ids[0]);
    assert.equal(entry.void_reason, 'wrong class');
    assert.equal(entry.voided_by, world.users.org.id);
    assert.equal(classTotal(world.db, world.classes['9.B']), 0);
    rejects(() => voidEntry(world.db, world.settings, { actor: world.users.org, entryId: ids[0], reason: 'again', now: world.clock.now() }), 'error.alreadyVoided');
    assert.ok(world.db.prepare("SELECT 1 FROM audit_log WHERE action = 'entry.void'").get());
  });

  test('permissions: own entries only, switch on, program open; superadmin anything', async () => {
    const world = await createWorld();
    const { ids } = style(world, '9.B', 'Kiss Anna', 10);
    const voidAs = (actor) => voidEntry(world.db, world.settings, { actor: world.users[actor], entryId: ids[0], reason: 'x', now: world.clock.now() });
    rejects(() => voidAs('org2'), 'error.notYourEntry');
    rejects(() => voidAs('logan'), 'error.notYourEntry');
    assert.throws(() => voidAs('dealer'), (err) => err.status === 403);
    world.settings.set('features.storno', false);
    rejects(() => voidAs('org'), 'error.featureOff');
    world.settings.set('features.storno', true);
    world.db.prepare("UPDATE programs SET status = 'closed' WHERE id = ?").run(world.program.id);
    rejects(() => voidAs('org'), 'error.programNotOpen');
    voidAs('boss');
    assert.throws(() => voidEntry(world.db, world.settings, { actor: world.users.boss, entryId: 12345, reason: 'x', now: world.clock.now() }), (err) => err.status === 404);
  });

  test('voiding one row of a pool voids the whole group', async () => {
    const world = await createWorld();
    const { ids } = award(world, 'org', 'pool', { rows: [{ name: 'A B', classId: world.classes['9.B'], amount: '10' }, { name: 'C D', classId: world.classes['10.A'], amount: '10' }] });
    const result = voidEntry(world.db, world.settings, { actor: world.users.org, entryId: ids[1], reason: 'wrong performers', now: world.clock.now() });
    assert.deepEqual(result.ids.sort(), [...ids].sort());
    assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM entries WHERE voided_at IS NULL').get().n, 0);
  });

  test('a correction voids the old entry and records a linked new one, atomically', async () => {
    const world = await createWorld();
    const { ids } = style(world, '9.B', 'Kiss Anna', 10);
    world.clock.advance(300);
    const fixed = correctEntry(world.db, world.settings, {
      actor: world.users.org,
      entryId: ids[0],
      input: { classId: world.classes['10.A'], name: 'Kiss Anna', amount: '12', correctionReason: 'wrong class' },
      confirmed: true,
      now: world.clock.now(),
    });
    const old = world.db.prepare('SELECT * FROM entries WHERE id = ?').get(ids[0]);
    const created = world.db.prepare('SELECT * FROM entries WHERE id = ?').get(fixed.ids[0]);
    assert.ok(old.voided_at);
    assert.equal(created.corrects_id, old.id);
    assert.equal(created.amount, 12);
    assert.equal(classTotal(world.db, world.classes['9.B']), 0);
    assert.equal(classTotal(world.db, world.classes['10.A']), 12);
    assert.deepEqual(world.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'entry.%' ORDER BY id").all().map((r) => r.action), ['entry.create', 'entry.void', 'entry.correct']);
  });

  test('the corrected amount may reuse the points the old entry released', async () => {
    const world = await createWorld();
    const { ids } = style(world, '9.B', 'Kiss Anna', 90);
    const fixed = correctEntry(world.db, world.settings, { actor: world.users.org, entryId: ids[0], input: { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '85', correctionReason: 'typo' }, confirmed: true, now: world.clock.now() });
    assert.equal(fixed.total, 85);
  });

  test('a correction that breaks a rule leaves the original untouched', async () => {
    const world = await createWorld();
    const { ids } = style(world, '9.B', 'Kiss Anna', 10);
    assert.throws(() => correctEntry(world.db, world.settings, { actor: world.users.org, entryId: ids[0], input: { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '95', correctionReason: 'x' }, now: world.clock.now() }));
    assert.throws(() => correctEntry(world.db, world.settings, { actor: world.users.org, entryId: ids[0], input: { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '5', correctionReason: '' }, now: world.clock.now() }));
    assert.equal(world.db.prepare('SELECT voided_at FROM entries WHERE id = ?').get(ids[0]).voided_at, null);
    assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM entries').get().n, 1);
  });

  test('corrections: switch, pools and adjustments', async () => {
    const world = await createWorld();
    const { ids } = style(world, '9.B', 'Kiss Anna', 10);
    const input = { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '11', correctionReason: 'x' };
    world.settings.set('features.corrections', false);
    rejects(() => correctEntry(world.db, world.settings, { actor: world.users.org, entryId: ids[0], input, confirmed: true, now: world.clock.now() }), 'error.featureOff');
    const pool = award(world, 'org', 'pool', { rows: [{ name: 'A B', classId: world.classes['9.B'], amount: '10' }] });
    rejects(() => correctEntry(world.db, world.settings, { actor: world.users.boss, entryId: pool.ids[0], input, now: world.clock.now() }), 'error.cannotCorrect');
    const adj = adjustClassPoints(world.db, { actor: world.users.boss, classId: world.classes['9.B'], delta: 5, now: world.clock.now() });
    rejects(() => correctEntry(world.db, world.settings, { actor: world.users.boss, entryId: adj.id, input, now: world.clock.now() }), 'error.cannotCorrect');
    assert.throws(() => voidEntry(world.db, world.settings, { actor: world.users.org, entryId: adj.id, reason: 'x', now: world.clock.now() }), (err) => err.status === 403);
  });

  test('a replayed correction returns the original result instead of failing', async () => {
    const world = await createWorld();
    const { ids } = style(world, '9.B', 'Kiss Anna', 10);
    const nonce = '0d6fd5e4-8a1e-4c5a-9d4b-8e0b1f7c6a55';
    const args = { actor: world.users.org, entryId: ids[0], input: { classId: world.classes['9.B'], name: 'Kiss Anna', amount: '11', correctionReason: 'x' }, confirmed: true, nonce };
    const first = correctEntry(world.db, world.settings, { ...args, now: world.clock.now() });
    const second = correctEntry(world.db, world.settings, { ...args, now: world.clock.now() });
    assert.equal(second.replayed, true);
    assert.deepEqual(second.ids, first.ids);
  });
});

describe('superadmin adjustments', () => {
  test('recorded as visible ledger entries', async () => {
    const world = await createWorld();
    adjustClassPoints(world.db, { actor: world.users.boss, classId: world.classes['7.A'], delta: 250, note: 'Su-liga import', now: world.clock.now() });
    adjustClassPoints(world.db, { actor: world.users.boss, classId: world.classes['7.A'], delta: -50, now: world.clock.now() });
    assert.equal(classTotal(world.db, world.classes['7.A']), 200);
    const rows = listEntries(world.db, {});
    assert.deepEqual(rows.map((r) => [r.source, r.amount]), [['adjustment', -50], ['adjustment', 250]]);
  });

  test('only the superadmin, only real classes, only non-zero changes', async () => {
    const world = await createWorld();
    assert.throws(() => adjustClassPoints(world.db, { actor: world.users.logan, classId: world.classes['7.A'], delta: 5, now: 'x' }), (err) => err.status === 403);
    assert.throws(() => adjustClassPoints(world.db, { actor: world.users.boss, classId: 999, delta: 5, now: 'x' }), (err) => err.status === 404);
    for (const delta of [0, 1.5, Number.NaN]) assert.throws(() => adjustClassPoints(world.db, { actor: world.users.boss, classId: world.classes['7.A'], delta, now: 'x' }), ValidationError);
  });
});

describe('listing entries', () => {
  test('filters by creator and program, newest first', async () => {
    const world = await createWorld();
    style(world, '9.B', 'Egy Diák', 5);
    style(world, '9.B', 'Két Diák', 6, 'org2');
    assert.deepEqual(listEntries(world.db, { createdBy: world.users.org2.id }).map((e) => e.amount), [6]);
    assert.deepEqual(listEntries(world.db, { programId: world.program.id }).map((e) => e.amount), [6, 5]);
    assert.equal(listEntries(world.db, { limit: 1, offset: 1 })[0].amount, 5);
    assert.equal(verifyAuditChain(world.db).ok, true);
  });
});
