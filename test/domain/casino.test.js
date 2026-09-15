import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classTotal, voidEntry } from '../../src/domain/awards.js';
import {
  casinoPrograms,
  conversionPreview,
  convertCashouts,
  listVisits,
  reconciliation,
  recordCashout,
  recordCount,
  recordRound,
  recordVisit,
  visitBalance,
  voidCasinoRecord,
} from '../../src/domain/casino.js';
import { NeedsConfirmation } from '../../src/domain/rules/index.js';
import { createWorld } from '../helpers.js';

function casinoWorld(options) {
  return createWorld(options).then((world) => {
    const gameId = (kind) => world.db.prepare('SELECT id FROM casino_games WHERE kind = ? LIMIT 1').get(kind).id;
    const base = (actor = 'dealer') => ({ actor: world.user(actor), programId: world.program.id, now: world.clock.now() });
    return {
      ...world,
      house: gameId('house'),
      pvp: gameId('pvp'),
      visit: (name, cls = '9.B', actor, extra = {}) => recordVisit(world.db, world.settings, { ...base(actor), classId: world.classes[cls], name, ...extra }),
      cashout: (args, actor) => recordCashout(world.db, world.settings, { ...base(actor), ...args }),
      round: (gameIdValue, results, actor, extra = {}) =>
        recordRound(world.db, world.settings, { ...base(actor), gameId: gameIdValue, results: results.map(([visitId, delta]) => ({ visitId, delta: String(delta) })), ...extra }),
      voidRecord: (kind, id, actor = 'dealer') => voidCasinoRecord(world.db, world.settings, { actor: world.user(actor), kind, id, reason: 'mistake', now: world.clock.now() }),
    };
  });
}

describe('casino access (Rulebook §5.8)', () => {
  test('only casino staff and the superadmin handle chips; the module can be switched off', async () => {
    const c = await casinoWorld();
    assert.throws(() => c.visit('Játékos Jani', '9.B', 'org'), { messageKey: 'error.casinoStaffOnly' });
    assert.throws(() => c.visit('Játékos Jani', '9.B', 'logan'), { messageKey: 'error.casinoStaffOnly' });
    assert.ok(c.visit('Játékos Jani', '9.B', 'boss').id);
    c.settings.set('casino.enabled', false);
    assert.throws(() => c.visit('Másik Mari'), { messageKey: 'error.featureOff' });
    assert.ok(c.visit('Másik Mari', '9.B', 'boss').id);
  });

  test('the program must be open and have a casino', async () => {
    const c = await casinoWorld();
    const halloween = c.programBySlug('halloween');
    c.db.prepare("UPDATE programs SET status = 'open' WHERE id = ?").run(halloween.id);
    assert.throws(() => recordVisit(c.db, c.settings, { actor: c.users.dealer, programId: halloween.id, classId: c.classes['9.B'], name: 'X Y', now: c.clock.now() }), { messageKey: 'error.noCasinoHere' });
    assert.throws(() => recordVisit(c.db, c.settings, { actor: c.users.dealer, programId: 999, classId: c.classes['9.B'], name: 'X Y', now: c.clock.now() }), (err) => err.status === 404);
    c.db.prepare("UPDATE programs SET status = 'closed' WHERE id = ?").run(c.program.id);
    assert.throws(() => c.visit('X Y'), { messageKey: 'error.programNotOpen' });
    assert.deepEqual(casinoPrograms(c.db).map((p) => p.slug), ['nyitobuli']);
  });
});

describe('light mode: cash-outs only (Rulebook §5.2, §5.5)', () => {
  test('a cash-out implies the visit with the configured starting stack', async () => {
    const c = await casinoWorld();
    c.settings.set('casino.record_visits', false);
    c.settings.set('casino.start_chips', '150');
    const { id, visitId } = c.cashout({ classId: c.classes['10.A'], name: 'Szerencsés Szilvi', chips: '420' });
    const visit = c.db.prepare('SELECT * FROM casino_visits WHERE id = ?').get(visitId);
    assert.deepEqual([visit.recorded, visit.start_chips, visit.class_id], [0, 150, c.classes['10.A']]);
    assert.equal(c.db.prepare('SELECT chips FROM casino_cashouts WHERE id = ?').get(id).chips, 420);
    assert.throws(() => c.visit('Valaki'), { messageKey: 'error.featureOff' }, 'no visit recording in light mode');
  });

  test('the same person cannot cash out more stacks than allowed', async () => {
    const c = await casinoWorld();
    c.settings.set('casino.record_visits', false);
    c.cashout({ classId: c.classes['10.A'], name: 'Visszatérő Viktor', chips: '100' });
    assert.throws(() => c.cashout({ classId: c.classes['10.A'], name: 'viktor visszatérő', chips: '100' }), { messageKey: 'error.visitLimit' });
    c.settings.set('casino.max_visits', '2');
    assert.ok(c.cashout({ classId: c.classes['10.A'], name: 'viktor visszatérő', chips: '100' }).id);
  });

  test('chip amounts are whole, non-negative and under the ceiling', async () => {
    const c = await casinoWorld();
    c.settings.set('casino.record_visits', false);
    for (const bad of ['-1', '1.5', '', 'sok']) assert.throws(() => c.cashout({ classId: c.classes['9.B'], name: `Hibás ${bad}`, chips: bad }), (err) => err.status === 400, bad);
    c.settings.set('casino.max_cashout', '1000');
    assert.throws(() => c.cashout({ classId: c.classes['9.B'], name: 'Mohó Márk', chips: '1001' }), { messageKey: 'error.outOfRange' });
    assert.ok(c.cashout({ classId: c.classes['9.B'], name: 'Nulla Nándor', chips: '0' }).id, 'losing everything is allowed');
  });

  test('identity rules: self, own class, name in another class', async () => {
    const c = await casinoWorld();
    c.settings.set('casino.record_visits', false);
    assert.throws(() => c.cashout({ classId: c.classes['11.A'], name: 'Császár Domonkos', chips: '100' }), { messageKey: 'error.selfAward' });
    c.settings.set('rules.own_class', 'block');
    assert.throws(() => c.cashout({ classId: c.classes['11.A'], name: 'Osztálytárs Olivér', chips: '100' }), { messageKey: 'error.ownClassBlocked' });
    c.cashout({ classId: c.classes['9.B'], name: 'Kétszínű Kristóf', chips: '100' });
    c.settings.set('casino.max_visits', '5');
    assert.throws(() => c.cashout({ classId: c.classes['10.A'], name: 'Kétszínű Kristóf', chips: '100' }), NeedsConfirmation);
  });

  test('switching to light mode closes an already recorded visit instead of duplicating it', async () => {
    const c = await casinoWorld();
    const v = c.visit('Váltó Vera');
    c.settings.set('casino.record_visits', false);
    const { visitId } = c.cashout({ classId: c.classes['9.B'], name: 'Váltó Vera', chips: '130' });
    assert.equal(visitId, v.id);
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM casino_visits').get().n, 1);
  });
});

describe('visit mode (Rulebook §5.3)', () => {
  test('entry hands out the starting stack once; cash-out closes the visit', async () => {
    const c = await casinoWorld();
    const v = c.visit('Belépő Béla');
    assert.equal(v.startChips, 100);
    assert.throws(() => c.visit('béla belépő'), { messageKey: 'error.visitLimit' });
    c.settings.set('casino.max_visits', '3');
    assert.throws(() => c.visit('béla belépő'), { messageKey: 'error.visitOpen' }, 'no second open visit');
    assert.equal(listVisits(c.db, c.program.id, { openOnly: true }).length, 1);
    c.cashout({ visitId: String(v.id), chips: '75' });
    assert.throws(() => c.cashout({ visitId: String(v.id), chips: '75' }), { messageKey: 'error.alreadyCashedOut' });
    assert.equal(listVisits(c.db, c.program.id, { openOnly: true }).length, 0);
    assert.equal(listVisits(c.db, c.program.id)[0].cashout_chips, 75);
    assert.ok(c.visit('béla belépő').id, 're-entry allowed when max_visits > 1');
  });

  test('cash-out needs a real visit of this program', async () => {
    const c = await casinoWorld();
    assert.throws(() => c.cashout({ visitId: '9999', chips: '10' }), (err) => err.status === 404);
    assert.throws(() => c.cashout({ visitId: '', chips: '10' }), (err) => err.status === 400);
  });

  test('replayed forms are idempotent', async () => {
    const c = await casinoWorld();
    const nonce = 'c4f2a8a4-3a2b-4e8e-9f53-0d7e2f1b9a11';
    const first = c.visit('Dupla Dóra', '9.B', 'dealer', { nonce });
    assert.equal(c.visit('Dupla Dóra', '9.B', 'dealer', { nonce }).replayed, true);
    const cashNonce = 'd4f2a8a4-3a2b-4e8e-9f53-0d7e2f1b9a11';
    c.cashout({ visitId: String(first.id), chips: '10', nonce: cashNonce });
    assert.equal(c.cashout({ visitId: String(first.id), chips: '10', nonce: cashNonce }).replayed, true);
  });
});

describe('detailed mode: every game recorded (Rulebook §5.4)', () => {
  test('balances follow the recorded games and cash-out must match', async () => {
    const c = await casinoWorld();
    c.settings.set('casino.record_games', true);
    const a = c.visit('Aladár Adorján');
    const b = c.visit('Bori Bernadett', '10.A');
    c.round(c.house, [[a.id, 50]]);
    c.round(c.pvp, [[a.id, -30], [b.id, 30]]);
    assert.equal(visitBalance(c.db, a.id), 120);
    assert.equal(visitBalance(c.db, b.id), 130);
    assert.throws(() => c.cashout({ visitId: String(a.id), chips: '121' }), { messageKey: 'error.cashoutMismatch', vars: { balance: 120 } });
    c.cashout({ visitId: String(a.id), chips: '120' });
    c.settings.set('casino.enforce_balance', false);
    assert.ok(c.cashout({ visitId: String(b.id), chips: '999' }).id, 'enforcement can be switched off (the suspicion score still sees it)');
  });

  test('player-vs-player rounds must be zero-sum with at least two distinct players', async () => {
    const c = await casinoWorld();
    c.settings.set('casino.record_games', true);
    const a = c.visit('Aladár Adorján');
    const b = c.visit('Bori Bernadett', '10.A');
    assert.throws(() => c.round(c.pvp, [[a.id, 10], [b.id, -9]]), { messageKey: 'error.roundNotZeroSum' });
    assert.throws(() => c.round(c.pvp, [[a.id, 10]]), { messageKey: 'error.roundNeedsPlayers' });
    assert.throws(() => c.round(c.pvp, [[a.id, 10], [a.id, -10]]), { messageKey: 'error.roundDuplicatePlayer' });
    assert.throws(() => c.round(c.house, []), { messageKey: 'error.roundNeedsPlayers' });
    assert.throws(() => c.round(c.house, [[a.id, 0]]), { messageKey: 'error.roundNeedsPlayers' }, 'zero rows are ignored');
  });

  test('no one can lose chips they do not have; results are capped', async () => {
    const c = await casinoWorld();
    c.settings.set('casino.record_games', true);
    const a = c.visit('Aladár Adorján');
    assert.throws(() => c.round(c.house, [[a.id, -101]]), { messageKey: 'error.balanceNegative' });
    c.round(c.house, [[a.id, -100]]);
    c.settings.set('casino.max_delta', '500');
    assert.throws(() => c.round(c.house, [[a.id, 501]]), { messageKey: 'error.outOfRange' });
  });

  test('games need the mode, an active game, open visits of this program', async () => {
    const c = await casinoWorld();
    const a = c.visit('Aladár Adorján');
    assert.throws(() => c.round(c.house, [[a.id, 10]]), { messageKey: 'error.featureOff' });
    c.settings.set('casino.record_games', true);
    assert.throws(() => c.round(9999, [[a.id, 10]]), { messageKey: 'error.gameInvalid' });
    c.db.prepare('UPDATE casino_games SET active = 0 WHERE id = ?').run(c.house);
    assert.throws(() => c.round(c.house, [[a.id, 10]]), { messageKey: 'error.gameInvalid' });
    assert.throws(() => c.round(c.pvp, [[a.id, 10], [9999, -10]]), { messageKey: 'error.visitInvalid' });
    c.cashout({ visitId: String(a.id), chips: '100' });
    const b = c.visit('Bori Bernadett', '10.A');
    assert.throws(() => c.round(c.pvp, [[a.id, 10], [b.id, -10]]), { messageKey: 'error.alreadyCashedOut' });
  });
});

describe('casino storno keeps the books consistent', () => {
  test('staff void their own records while open; the superadmin anything', async () => {
    const c = await casinoWorld();
    const v = c.visit('Aladár Adorján');
    assert.throws(() => c.voidRecord('visit', v.id, 'dealer2'), { messageKey: 'error.notYourEntry' });
    assert.throws(() => c.voidRecord('visit', v.id, 'org'), { messageKey: 'error.notYourEntry' });
    c.settings.set('features.storno', false);
    assert.throws(() => c.voidRecord('visit', v.id), { messageKey: 'error.featureOff' });
    c.settings.set('features.storno', true);
    c.db.prepare("UPDATE programs SET status = 'closed' WHERE id = ?").run(c.program.id);
    assert.throws(() => c.voidRecord('visit', v.id), { messageKey: 'error.programNotOpen' });
    c.voidRecord('visit', v.id, 'boss');
    assert.throws(() => c.voidRecord('visit', v.id, 'boss'), { messageKey: 'error.alreadyVoided' });
    assert.throws(() => c.voidRecord('nope', 1, 'boss'), (err) => err.status === 404);
    assert.throws(() => c.voidRecord('round', 999, 'boss'), (err) => err.status === 404);
  });

  test('dependencies must be voided first', async () => {
    const c = await casinoWorld();
    c.settings.set('casino.record_games', true);
    const a = c.visit('Aladár Adorján');
    const b = c.visit('Bori Bernadett', '10.A');
    const win = c.round(c.house, [[a.id, 50]]);
    const loss = c.round(c.house, [[a.id, -140]]);
    assert.throws(() => c.voidRecord('visit', a.id), { messageKey: 'error.visitHasRecords' });
    assert.throws(() => c.voidRecord('round', win.id), { messageKey: 'error.balanceNegative' }, 'without the win the later loss would overdraw');
    const cash = c.cashout({ visitId: String(b.id), chips: '100' });
    const extra = c.round(c.house, [[a.id, 5]]);
    assert.throws(() => c.voidRecord('visit', b.id), { messageKey: 'error.visitHasRecords' });
    c.voidRecord('round', loss.id);
    c.voidRecord('round', win.id);
    c.voidRecord('round', extra.id);
    c.voidRecord('visit', a.id);
    c.voidRecord('cashout', cash.id);
    assert.equal(listVisits(c.db, c.program.id, { openOnly: true }).length, 1, 'voiding a cash-out reopens the visit');
  });

  test('a round involving a cashed-out player cannot be voided; a light cash-out takes its visit with it', async () => {
    const c = await casinoWorld();
    c.settings.set('casino.record_games', true);
    const a = c.visit('Aladár Adorján');
    const r = c.round(c.house, [[a.id, 10]]);
    c.cashout({ visitId: String(a.id), chips: '110' });
    assert.throws(() => c.voidRecord('round', r.id), { messageKey: 'error.roundAfterCashout' });
    c.settings.set('casino.record_visits', false);
    const light = c.cashout({ classId: c.classes['10.A'], name: 'Könnyű Kinga', chips: '90' });
    c.voidRecord('cashout', light.id);
    assert.ok(c.db.prepare('SELECT voided_at FROM casino_visits WHERE id = ?').get(light.visitId).voided_at);
  });
});

describe('reconciliation and conversion (Rulebook §5.6, §5.7)', () => {
  test('recorded cash-outs are compared with physical counts per staff member', async () => {
    const c = await casinoWorld();
    c.settings.set('casino.record_visits', false);
    c.cashout({ classId: c.classes['9.B'], name: 'Egy Egon', chips: '300' });
    c.cashout({ classId: c.classes['10.A'], name: 'Két Kata', chips: '200' }, 'dealer2');
    assert.throws(() => recordCount(c.db, c.settings, { actor: c.users.dealer, programId: c.program.id, staffId: String(c.users.dealer.id), chips: '1', now: 'x' }), (err) => err.status === 403);
    recordCount(c.db, c.settings, { actor: c.users.boss, programId: c.program.id, staffId: String(c.users.dealer.id), chips: '250', now: c.clock.now() });
    recordCount(c.db, c.settings, { actor: c.users.boss, programId: c.program.id, staffId: String(c.users.dealer.id), chips: '280', now: c.clock.now() });
    const rows = Object.fromEntries(reconciliation(c.db, c.program.id).map((r) => [r.username, r]));
    assert.deepEqual([rows.dealer.recorded, rows.dealer.counted, rows.dealer.difference], [300, 280, -20], 'latest count wins');
    assert.deepEqual([rows.dealer2.recorded, rows.dealer2.counted, rows.dealer2.difference], [200, null, null]);
    c.settings.set('casino.reconciliation', false);
    assert.throws(() => recordCount(c.db, c.settings, { actor: c.users.boss, programId: c.program.id, staffId: String(c.users.dealer.id), chips: '1', now: 'x' }), { messageKey: 'error.featureOff' });
  });

  test('conversion turns each pending cash-out into class points exactly once', async () => {
    const c = await casinoWorld();
    const v1 = c.visit('Nyerő Nóra', '9.B');
    const v2 = c.visit('Vesztő Vince', '10.A');
    c.visit('Bent Maradt Benő', '11.A');
    c.clock.advance(30 * 60);
    c.cashout({ visitId: String(v1.id), chips: '255' });
    c.cashout({ visitId: String(v2.id), chips: '40' });

    const preview = conversionPreview(c.db, c.program.id);
    assert.deepEqual(preview.rows.map((r) => [r.person_name, r.points, r.error]), [['Nyerő Nóra', 26, null], ['Vesztő Vince', 4, null]]);
    assert.equal(preview.rows[0].values.net, 155);
    assert.ok(preview.rows[0].values.minutes >= 30);
    assert.equal(preview.openVisits, 1);

    assert.throws(() => convertCashouts(c.db, { actor: c.users.dealer, programId: c.program.id, now: 'x' }), (err) => err.status === 403);
    assert.deepEqual(convertCashouts(c.db, { actor: c.users.boss, programId: c.program.id, now: c.clock.now() }), { count: 2, total: 30 });
    assert.equal(classTotal(c.db, c.classes['9.B']), 26);
    assert.throws(() => convertCashouts(c.db, { actor: c.users.boss, programId: c.program.id, now: c.clock.now() }), { messageKey: 'error.nothingToConvert' });
    const cashout = c.db.prepare('SELECT id FROM casino_cashouts ORDER BY id LIMIT 1').get();
    assert.throws(() => c.voidRecord('cashout', cashout.id, 'boss'), { messageKey: 'error.alreadyConverted' });

    const entry = c.db.prepare("SELECT id FROM entries WHERE source = 'casino' LIMIT 1").get();
    assert.throws(() => voidEntry(c.db, c.settings, { actor: c.users.org, entryId: entry.id, reason: 'x', now: c.clock.now() }), (err) => err.status === 403);
    voidEntry(c.db, c.settings, { actor: c.users.boss, entryId: entry.id, reason: 'redo', now: c.clock.now() });
    assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE source = 'casino' AND voided_at IS NULL").get().n, 0, 'the whole conversion batch is voided');
    assert.equal(convertCashouts(c.db, { actor: c.users.boss, programId: c.program.id, now: c.clock.now() }).count, 2, 'and can be redone');
  });

  test('conversion is all-or-nothing when a formula result breaks the limits', async () => {
    const c = await casinoWorld();
    c.settings.set('casino.record_visits', false);
    c.db.prepare('UPDATE reasons SET max_points = 500 WHERE id = ?').run(c.reasons.casino);
    c.cashout({ classId: c.classes['9.B'], name: 'Óriás Ottó', chips: '10000' });
    c.cashout({ classId: c.classes['10.A'], name: 'Kicsi Kornél', chips: '10' });
    const preview = conversionPreview(c.db, c.program.id);
    assert.equal(preview.rows[0].error, 'error.amountOutOfRange');
    assert.throws(() => convertCashouts(c.db, { actor: c.users.boss, programId: c.program.id, now: c.clock.now() }), { messageKey: 'error.conversionBlocked' });
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM entries').get().n, 0);
    c.db.prepare("UPDATE reasons SET formula = 'chips / zero' WHERE id = ?").run(c.reasons.casino);
    assert.equal(conversionPreview(c.db, c.program.id).rows[0].error, 'error.formula');
  });

  test('programs without a casino reason have nothing to preview', async () => {
    const c = await casinoWorld();
    assert.deepEqual(conversionPreview(c.db, c.programBySlug('halloween').id), { reason: null, rows: [], openVisits: 0 });
    assert.throws(() => convertCashouts(c.db, { actor: c.users.boss, programId: c.programBySlug('halloween').id, now: 'x' }), { messageKey: 'error.noCasinoHere' });
  });
});
