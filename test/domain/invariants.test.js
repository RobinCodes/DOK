// Property-based tests: thousands of random operations — valid and invalid, by
// every kind of account — must never break the guarantees the competition relies on.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { adjustClassPoints, correctEntry, createAward, voidEntry } from '../../src/domain/awards.js';
import { verifyAuditChain } from '../../src/domain/audit.js';
import { styleBudget } from '../../src/domain/budget.js';
import { convertCashouts, recordCashout, recordRound, recordVisit, visitBalance, voidCasinoRecord } from '../../src/domain/casino.js';
import { getReason } from '../../src/domain/catalog.js';
import { evaluateReason } from '../../src/domain/awards.js';
import { applyChange } from '../../src/domain/manage.js';
import { NeedsConfirmation } from '../../src/domain/rules/index.js';
import { liveStandings } from '../../src/domain/standings.js';
import { analyze } from '../../src/domain/suspicion/index.js';
import { cancelTimer, startTimer, stopTimer } from '../../src/domain/timers.js';
import { HttpError } from '../../src/http/errors.js';
import { createWorld } from '../helpers.js';

function random(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mostly valid values, so real state builds up, mixed with hostile ones.
const VALID_AMOUNTS = ['2', '3', '5', '8', '10', '20'];
const HOSTILE_AMOUNTS = ['0', '-5', '91', '999999999', '2.5', '1e3', '', 'abc', ' 7 ', '+3', '0x10', null];
const VALID_NAMES = ['Kiss Anna', 'Nagy Péter', 'Szabó Máté', 'Varga Emma', 'Molnár Dávid', 'Farkas Zoé', 'Papp Hanna', 'Lakatos Ádám', 'Kovács Pál', 'Tóth Lili'];
const HOSTILE_NAMES = ['anna kiss', 'Tornai Bence', 'Cseh Benedek', '', '12345', '<script>alert(1)</script>', 'x'.repeat(90), 'Kovacs Pal', null];
const REASONS = ['style', 'style2', 'minutes', 'menetlevel', 'mini', 'pool', 'casino'];

function scenario(seed) {
  return createWorld().then((world) => {
    const rand = random(seed);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const mostly = (valid, hostile) => (rand() < 0.75 ? pick(valid) : pick(hostile));
    const amount = () => mostly(VALID_AMOUNTS, HOSTILE_AMOUNTS);
    const name = () => mostly(VALID_NAMES, HOSTILE_NAMES);
    const classIds = () => mostly(Object.values(world.classes).map(String), ['999', '', 'x']);
    const organizer = () => world.user(mostly(['org', 'org2', 'logan', 'boss'], ['dealer', 'dealer2']));
    const staff = () => world.user(mostly(['dealer', 'dealer2', 'boss'], ['org', 'logan']));
    const reasonId = () => (rand() < 0.9 ? world.reasons[pick(REASONS)] : Math.floor(rand() * 40));
    const anyId = (table) => {
      const row = world.db.prepare(`SELECT id FROM ${table} ORDER BY RANDOM() LIMIT 1`).get();
      return rand() < 0.9 && row ? row.id : Math.floor(rand() * 50) + 1;
    };
    // Usually an entry that the operation can apply to, usually acted on by its creator; sometimes anything.
    const targetEntry = (where) => {
      const row = rand() < 0.85 ? world.db.prepare(`SELECT id, created_by FROM entries WHERE ${where} ORDER BY RANDOM() LIMIT 1`).get() : null;
      const actor = row && rand() < 0.7 ? world.db.prepare('SELECT * FROM users WHERE id = ?').get(row.created_by) : organizer();
      return { entryId: row?.id ?? anyId('entries'), actor };
    };
    world.db.prepare("UPDATE programs SET status = 'open' WHERE slug = 'halloween'").run();
    world.settings.set('rules.duplicate_seconds', '30');
    world.settings.set('casino.record_games', true);
    world.settings.set('casino.max_visits', '3');

    const at = () => ({ now: world.clock.now(), ip: '127.0.0.1' });
    const operations = {
      award: () =>
        createAward(world.db, world.settings, {
          ...at(),
          actor: organizer(),
          reasonId: reasonId(),
          confirmed: rand() < 0.7,
          input: { classId: classIds(), name: name(), amount: amount(), inputs: { stamps: amount(), people: amount(), minutes: amount(), participants: amount() }, note: rand() < 0.05 ? 'x'.repeat(250) : 'ok' },
        }),
      pool: () =>
        createAward(world.db, world.settings, {
          ...at(),
          actor: organizer(),
          reasonId: world.reasons.pool,
          confirmed: true,
          input: { rows: Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({ name: name(), classId: classIds(), amount: pick(['0', '3', '5', '8', '-1']) })) },
        }),
      void: () => {
        const { entryId, actor } = targetEntry('voided_at IS NULL');
        return voidEntry(world.db, world.settings, { ...at(), actor, entryId, reason: mostly(['typo', 'wrong class'], ['', 'x'.repeat(300)]) });
      },
      correct: () => {
        const { entryId, actor } = targetEntry('voided_at IS NULL AND reason_id IS NOT NULL AND batch IS NULL');
        return correctEntry(world.db, world.settings, {
          ...at(),
          actor,
          entryId,
          confirmed: rand() < 0.7,
          input: { classId: classIds(), name: name(), amount: amount(), inputs: { stamps: '3', people: '2', minutes: amount(), participants: '4' }, correctionReason: mostly(['fix'], ['']) },
        });
      },
      startTimer: () => startTimer(world.db, world.settings, { ...at(), actor: organizer(), reasonId: rand() < 0.85 ? world.reasons.minutes : reasonId(), classId: classIds(), name: name(), confirmed: rand() < 0.7 }),
      stopTimer: () => {
        world.clock.advance(Math.floor(rand() * 900));
        return stopTimer(world.db, world.settings, { ...at(), actor: organizer(), timerId: anyId('timers') });
      },
      cancelTimer: () => cancelTimer(world.db, { ...at(), actor: organizer(), timerId: anyId('timers') }),
      visit: () => recordVisit(world.db, world.settings, { ...at(), actor: staff(), programId: world.program.id, classId: classIds(), name: name(), confirmed: rand() < 0.7 }),
      round: () => {
        const visits = world.db
          .prepare('SELECT v.id FROM casino_visits v WHERE v.voided_at IS NULL AND NOT EXISTS (SELECT 1 FROM casino_cashouts c WHERE c.visit_id = v.id AND c.voided_at IS NULL) ORDER BY RANDOM() LIMIT 3')
          .all();
        const kind = pick(['house', 'pvp']);
        const game = world.db.prepare('SELECT id FROM casino_games WHERE kind = ? LIMIT 1').get(kind).id;
        const delta = Math.floor(rand() * 60) - 30;
        const results =
          kind === 'pvp' && visits.length >= 2
            ? [{ visitId: String(visits[0].id), delta: String(delta) }, { visitId: String(visits[1].id), delta: String(-delta) }]
            : visits.map((v) => ({ visitId: String(v.id), delta: mostly(['10', '-10', '25', '-5'], ['150', '-150', '0', 'x']) }));
        return recordRound(world.db, world.settings, { ...at(), actor: staff(), programId: world.program.id, gameId: String(game), results });
      },
      cashout: () => {
        const visitId = anyId('casino_visits');
        const exists = world.db.prepare('SELECT 1 FROM casino_visits WHERE id = ?').get(visitId);
        const chips = rand() < 0.8 && exists ? String(visitBalance(world.db, visitId)) : amount();
        return recordCashout(world.db, world.settings, { ...at(), actor: staff(), programId: world.program.id, visitId: String(visitId), chips });
      },
      voidCasino: () => voidCasinoRecord(world.db, world.settings, { ...at(), actor: staff(), kind: pick(['visit', 'cashout', 'round']), id: Math.floor(rand() * 30) + 1, reason: mostly(['oops'], ['']) }),
      convert: () => convertCashouts(world.db, { ...at(), actor: world.user(mostly(['boss'], ['org'])), programId: world.program.id }),
      adjust: () => adjustClassPoints(world.db, { ...at(), actor: world.user(mostly(['boss'], ['logan'])), classId: Number(pick(Object.values(world.classes))), delta: Math.floor(rand() * 200) - 100 }),
      budget: () =>
        applyChange(world.db, { ...at(), actor: world.users.boss, target: `budget:${world.users[pick(['org', 'org2'])].id}:${world.program.id}`, op: pick(['set', 'adjust']), value: pick(['-20', '10', '0', '500', 'x']) }),
      setting: () =>
        applyChange(world.db, {
          ...at(),
          actor: world.users.boss,
          target: pick(['setting:features.storno', 'setting:features.corrections', 'setting:features.style_points', 'setting:rules.own_class', 'setting:casino.max_visits']),
          op: pick(['toggle', 'set']),
          value: pick(['1', '0', 'block', 'flag', '3']),
        }),
    };

    const counts = () =>
      world.db.prepare(`SELECT (SELECT COUNT(*) FROM entries) + (SELECT COUNT(*) FROM audit_log) + (SELECT COUNT(*) FROM casino_visits)
                        + (SELECT COUNT(*) FROM casino_cashouts) + (SELECT COUNT(*) FROM casino_rounds) + (SELECT COUNT(*) FROM timers) AS n`).get().n;

    return { world, rand, operations, pick, counts };
  });
}

function checkInvariants(world) {
  const { db } = world;

  // 1. Standings are exactly the sum of active ledger entries.
  for (const row of liveStandings(db)) {
    const { total } = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM entries WHERE class_id = ? AND voided_at IS NULL').get(row.class_id);
    assert.equal(row.points, total);
  }

  // 2. No organizer ever has a negative style allowance left.
  for (const user of db.prepare('SELECT id FROM users').all()) {
    assert.ok(styleBudget(db, user.id, world.program.id).remaining >= 0, `budget of user ${user.id}`);
  }

  // 3. Every active entry respects its reason's limits; every pool fits its pool.
  for (const e of db.prepare('SELECT e.*, r.min_points, r.max_points FROM entries e JOIN reasons r ON r.id = e.reason_id WHERE e.voided_at IS NULL').all()) {
    assert.ok(e.amount >= e.min_points && e.amount <= e.max_points, `entry ${e.id}: ${e.amount}`);
  }
  for (const pool of db.prepare("SELECT batch, reason_id, SUM(amount) AS total, COUNT(*) AS n FROM entries WHERE source = 'pool' AND voided_at IS NULL GROUP BY batch").all()) {
    assert.ok(pool.total <= evaluateReason(getReason(db, pool.reason_id), { participants: pool.n }), `pool ${pool.batch}`);
  }

  // 4. One running timer per person.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM (SELECT person_key FROM timers WHERE ended_at IS NULL GROUP BY person_key HAVING COUNT(*) > 1)').get().n, 0);

  // 5. Casino: no negative balances, one active cash-out per visit, cash-outs equal balances.
  for (const v of db.prepare('SELECT id FROM casino_visits WHERE voided_at IS NULL').all()) {
    assert.ok(visitBalance(db, v.id) >= 0, `visit ${v.id}`);
    const cashouts = db.prepare('SELECT chips FROM casino_cashouts WHERE visit_id = ? AND voided_at IS NULL').all(v.id);
    assert.ok(cashouts.length <= 1);
    if (cashouts.length) assert.equal(cashouts[0].chips, visitBalance(db, v.id), `cash-out of visit ${v.id}`);
  }
  // Conversions only for active cash-outs, at most once.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entries e JOIN casino_cashouts c ON c.id = e.cashout_id WHERE e.voided_at IS NULL AND c.voided_at IS NOT NULL").get().n, 0);

  // 6. The event log is intact and every entry was logged.
  assert.equal(verifyAuditChain(db).ok, true);
}

describe('invariants under random operations', () => {
  for (const seed of [1, 42, 2026, 777]) {
    test(`seed ${seed}: 600 random operations keep every guarantee`, async () => {
      const { world, rand, operations, counts } = await scenario(seed);
      const names = Object.keys(operations);
      const outcomes = Object.fromEntries(names.map((n) => [n, { ok: 0, refused: 0 }]));
      for (let step = 0; step < 600; step++) {
        world.clock.advance(Math.floor(rand() * 40));
        const op = names[Math.floor(rand() * names.length)];
        const before = counts();
        try {
          operations[op]();
          outcomes[op].ok++;
        } catch (err) {
          // Only deliberate refusals are acceptable, never a crash (TypeError, SQLite error, ...).
          if (!(err instanceof NeedsConfirmation) && !(err instanceof HttpError)) throw err;
          outcomes[op].refused++;
          const why = err.messageKey ?? 'needsConfirmation';
          outcomes[op].why = { ...outcomes[op].why, [why]: (outcomes[op].why?.[why] ?? 0) + 1 };
          assert.equal(counts(), before, `a refused operation left partial writes (step ${step}, ${op}: ${err.messageKey ?? err.message})`);
        }
        if (step % 25 === 0) checkInvariants(world);
        // Like a real operator, the superadmin eventually switches modules back on.
        if (step % 60 === 30) for (const key of ['features.storno', 'features.corrections', 'features.style_points']) world.settings.set(key, true);
      }
      checkInvariants(world);
      const total = (key) => names.reduce((sum, n) => sum + outcomes[n][key], 0);
      assert.ok(total('ok') > 150 && total('refused') > 100, JSON.stringify(outcomes));
      for (const op of ['award', 'pool', 'void', 'correct', 'startTimer', 'stopTimer', 'visit', 'round', 'cashout', 'adjust']) {
        assert.ok(outcomes[op].ok > 0, `"${op}" never succeeded: ${JSON.stringify(outcomes)}`);
      }
      const items = analyze(world.db, world.settings, {});
      assert.ok(items.every((i) => i.score >= 1 && i.score <= 100 && Number.isInteger(i.score)));
      assert.ok(!items.some((i) => i.factors.some((f) => f.key === 'sus.limits.noAudit')), 'every write went through the event log');
      assert.ok(items.every((i) => i.factors.every((f) => f.strength > 0 && f.strength <= 1)));
    });
  }
});
