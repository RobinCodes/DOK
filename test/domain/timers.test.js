import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classTotal } from '../../src/domain/awards.js';
import { NeedsConfirmation } from '../../src/domain/rules/index.js';
import { cancelTimer, listRunningTimers, startTimer, stopTimer } from '../../src/domain/timers.js';
import { createWorld } from '../helpers.js';

const at = (minute) => new Date(Date.parse('2026-09-18T14:00:00.000Z') + minute * 60_000).toISOString();

function start(world, actor, name, cls = '9.B', now = at(0), extra = {}) {
  return startTimer(world.db, world.settings, { actor: world.user(actor), reasonId: world.reasons.minutes, classId: world.classes[cls], name, now, ...extra });
}

describe('check-in/check-out timers (Rulebook §4.3)', () => {
  test('the server measures the minutes and records participation points', async () => {
    const world = await createWorld();
    const { id } = start(world, 'org', 'Nagy Péter');
    assert.equal(listRunningTimers(world.db).length, 1);
    const result = stopTimer(world.db, world.settings, { actor: world.users.org, timerId: id, now: at(37.9) });
    assert.deepEqual([result.minutes, result.measured, result.amount], [37, 37, 37]);
    const entry = world.db.prepare('SELECT * FROM entries WHERE id = ?').get(result.entryId);
    assert.equal(entry.source, 'timer');
    assert.deepEqual(JSON.parse(entry.inputs), { minutes: 37 });
    assert.equal(classTotal(world.db, world.classes['9.B']), 37);
    const timer = world.db.prepare('SELECT * FROM timers WHERE id = ?').get(id);
    assert.deepEqual([timer.outcome, timer.entry_id], ['stopped', result.entryId]);
    assert.equal(listRunningTimers(world.db).length, 0);
  });

  test('one student cannot be at two stations at once', async () => {
    const world = await createWorld();
    start(world, 'org', 'Nagy Péter');
    assert.throws(() => start(world, 'org2', 'péter nagy', '9.B', at(1)), { messageKey: 'error.timerRunning' });
  });

  test('a forgotten timer is capped at max_minutes and the cap is noted', async () => {
    const world = await createWorld();
    const { id } = start(world, 'org', 'Elfelejtett Elek');
    const result = stopTimer(world.db, world.settings, { actor: world.users.org, timerId: id, now: at(600) });
    assert.deepEqual([result.minutes, result.measured], [240, 600]);
    assert.match(world.db.prepare('SELECT note FROM entries WHERE id = ?').get(result.entryId).note, /600 → 240/);
  });

  test('under a minute cannot be stopped, only cancelled (which awards nothing)', async () => {
    const world = await createWorld();
    const { id } = start(world, 'org', 'Gyors Gizi');
    assert.throws(() => stopTimer(world.db, world.settings, { actor: world.users.org, timerId: id, now: at(0.9) }), { messageKey: 'error.timerTooShort' });
    cancelTimer(world.db, { actor: world.users.org, timerId: id, now: at(1) });
    assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM entries').get().n, 0);
    assert.throws(() => stopTimer(world.db, world.settings, { actor: world.users.org, timerId: id, now: at(5) }), { messageKey: 'error.timerNotRunning' });
    assert.throws(() => cancelTimer(world.db, { actor: world.users.org, timerId: id, now: at(5) }), { messageKey: 'error.timerNotRunning' });
    assert.throws(() => stopTimer(world.db, world.settings, { actor: world.users.org, timerId: 999, now: at(5) }), (err) => err.status === 404);
  });

  test('any organizer may stop, only the starter (or superadmin) may cancel', async () => {
    const world = await createWorld();
    const a = start(world, 'org', 'Első Elemér');
    const b = start(world, 'org', 'Második Márta');
    assert.throws(() => cancelTimer(world.db, { actor: world.users.org2, timerId: a.id, now: at(2) }), { messageKey: 'error.notYourTimer' });
    assert.equal(stopTimer(world.db, world.settings, { actor: world.users.org2, timerId: a.id, now: at(10) }).minutes, 10);
    cancelTimer(world.db, { actor: world.users.boss, timerId: b.id, now: at(10) });
    const dealer = start(world, 'org', 'Harmadik Hanna');
    assert.throws(() => stopTimer(world.db, world.settings, { actor: world.users.dealer, timerId: dealer.id, now: at(10) }), { messageKey: 'error.casinoCannotAward' });
  });

  test('switches: global timer, personal preference, and stopping still works after switching off', async () => {
    const world = await createWorld();
    const running = start(world, 'org', 'Futó Ferenc');
    world.settings.set('features.timer', false);
    assert.throws(() => start(world, 'org', 'Új Ubul'), { messageKey: 'error.featureOff' });
    assert.ok(start(world, 'boss', 'Új Ubul'), 'the superadmin is never locked out');
    assert.equal(stopTimer(world.db, world.settings, { actor: world.users.org, timerId: running.id, now: at(20) }).minutes, 20, 'minutes already played are not lost');
    world.settings.set('features.timer', true);
    world.db.prepare('UPDATE users SET use_timer = 0 WHERE username = ?').run('org');
    assert.throws(() => start(world, 'org', 'Harmadik Hugó'), { messageKey: 'error.featureOff' });
  });

  test('starting applies the same identity rules as awarding', async () => {
    const world = await createWorld();
    assert.throws(() => start(world, 'org', 'Tornai Bence', '9.A'), { messageKey: 'error.selfAward' });
    assert.throws(() => start(world, 'org', '', '9.B'), { messageKey: 'error.nameRequired' });
    assert.throws(() => start(world, 'org', 'Valaki', 'nope'), { messageKey: 'error.classInvalid' });
    assert.throws(() => start(world, 'dealer', 'Valaki'), { messageKey: 'error.casinoCannotAward' });
    world.settings.set('rules.own_class', 'block');
    assert.throws(() => start(world, 'org', 'Osztálytárs', '9.A'), { messageKey: 'error.ownClassBlocked' });
    world.db.prepare("UPDATE programs SET status = 'closed' WHERE id = ?").run(world.program.id);
    assert.throws(() => start(world, 'org', 'Valaki'), { messageKey: 'error.programNotOpen' });
  });

  test('a student already known in another class needs confirmation to start, not again at stop', async () => {
    const world = await createWorld();
    const first = start(world, 'org', 'Vándor Vilma', '7.A');
    stopTimer(world.db, world.settings, { actor: world.users.org, timerId: first.id, now: at(10) });
    assert.throws(() => start(world, 'org', 'Vándor Vilma', '10.A', at(20)), NeedsConfirmation);
    const second = start(world, 'org', 'Vándor Vilma', '10.A', at(20), { confirmed: true });
    assert.equal(stopTimer(world.db, world.settings, { actor: world.users.org, timerId: second.id, now: at(30) }).minutes, 10);
  });

  test('only per-minute reasons can be timed', async () => {
    const world = await createWorld();
    assert.throws(() => startTimer(world.db, world.settings, { actor: world.users.org, reasonId: world.reasons.style, classId: world.classes['9.B'], name: 'X Y', now: at(0) }), (err) => err.status === 404);
  });
});
