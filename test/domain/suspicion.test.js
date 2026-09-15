import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { adjustClassPoints, createAward, insertEntry } from '../../src/domain/awards.js';
import { audit } from '../../src/domain/audit.js';
import { applyChange } from '../../src/domain/manage.js';
import { nameKey } from '../../src/domain/names.js';
import { publishSnapshot } from '../../src/domain/standings.js';
import { analyze, combineScore } from '../../src/domain/suspicion/index.js';
import { createWorld } from '../helpers.js';

// ---- fixtures --------------------------------------------------------------

/** Deterministic pseudo-random numbers (mulberry32), so every run sees the same data. */
function random(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const minute = (m) => new Date(Date.parse('2026-09-18T13:00:00.000Z') + m * 60_000).toISOString();

/** Writes an entry exactly like the app does (ledger row + event log line), at a chosen time. */
function entry(world, { by = 'org', reason = 'style', cls = '9.B', name = 'Diák Dénes', amount = 5, at = minute(0), source = 'form', inputs = {}, batch = null, corrects = null }) {
  const reasonId = reason === null ? null : (world.reasons[reason] ?? reason);
  const id = insertEntry(world.db, {
    program_id: reasonId ? world.program.id : null,
    reason_id: reasonId,
    class_id: world.classes[cls],
    person_name: name,
    person_key: nameKey(name),
    amount,
    inputs: JSON.stringify(inputs),
    source,
    batch,
    corrects_id: corrects,
    created_by: world.user(by).id,
    created_at: at,
  });
  audit(world.db, { actor: world.user(by), action: 'entry.create', subject: `entry:${id}`, at });
  return id;
}

function voidIt(world, id, at, by = 'org') {
  world.db.prepare('UPDATE entries SET voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ?').run(world.user(by).id, at, 'x', id);
}

function visit(world, { by = 'dealer', cls = '9.B', name, start = 100, at = minute(0), recorded = 1 }) {
  return world.db
    .prepare('INSERT INTO casino_visits (program_id, class_id, person_name, person_key, start_chips, recorded, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(world.program.id, world.classes[cls], name, nameKey(name), start, recorded, world.user(by).id, at).lastInsertRowid;
}

function cashout(world, { visitId, by = 'dealer', chips, at = minute(30) }) {
  return world.db.prepare('INSERT INTO casino_cashouts (visit_id, chips, created_by, created_at) VALUES (?, ?, ?, ?)').run(visitId, chips, world.user(by).id, at).lastInsertRowid;
}

function round(world, { by = 'dealer', kind = 'house', results, at = minute(10) }) {
  const gameId = world.db.prepare('SELECT id FROM casino_games WHERE kind = ? ORDER BY id LIMIT 1').get(kind).id;
  const id = world.db.prepare('INSERT INTO casino_rounds (program_id, game_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(world.program.id, gameId, world.user(by).id, at).lastInsertRowid;
  for (const [visitId, delta] of results) world.db.prepare('INSERT INTO casino_results (round_id, visit_id, delta) VALUES (?, ?, ?)').run(id, visitId, delta);
  return id;
}

async function worldWithOrganizers() {
  const world = await createWorld();
  const hash = world.user('org').password_hash;
  for (const [username, name, cls] of [['org3', 'Fülöp Barni', '10.A'], ['org4', 'Balogh Benedek', '7.A']]) {
    world.db.prepare("INSERT INTO users (username, display_name, password_hash, role, class_id, created_at) VALUES (?, ?, ?, 'admin', ?, 'x')").run(username, name, hash, world.classes[cls]);
  }
  return world;
}

const report = (world, options) => analyze(world.db, world.settings, options);
const itemOf = (items, type, id) => items.find((i) => i.type === type && i.id === id);
const keysOf = (item) => item.factors.map((f) => f.key);

const FIRST = ['Anna', 'Bence', 'Csenge', 'Dávid', 'Emma', 'Ferenc', 'Gréta', 'Hunor', 'Ilona', 'János', 'Kinga', 'Levente', 'Míra', 'Noel', 'Orsolya', 'Pál', 'Réka', 'Sámuel', 'Tünde', 'Vilmos'];
const LAST = ['Kovács', 'Szabó', 'Horváth', 'Varga', 'Molnár', 'Farkas', 'Papp', 'Takács', 'Juhász', 'Mészáros'];

// ---- tests -----------------------------------------------------------------

describe('combining detector signals into a 1–100 score', () => {
  const weight = () => 1;

  test('no signal scores 1, a full-strength signal scores 100', () => {
    assert.equal(combineScore([], weight), 1);
    assert.equal(combineScore([{ detector: 'limits', strength: 1 }], weight), 100);
  });

  test('independent signals add up (noisy-OR) but never exceed 100', () => {
    assert.equal(combineScore([{ detector: 'a', strength: 0.5 }, { detector: 'b', strength: 0.5 }], weight), 75);
    const many = Array.from({ length: 50 }, (_, i) => ({ detector: `d${i}`, strength: 0.9 }));
    assert.equal(combineScore(many, weight), 100);
  });

  test('within one detector only the strongest signal counts', () => {
    // 1 + 99 · 0.5 = 50.5, rounded to 51; a second identical signal adds nothing.
    assert.equal(combineScore([{ detector: 'names', strength: 0.5 }, { detector: 'names', strength: 0.5 }], weight), 51);
    assert.equal(combineScore([{ detector: 'names', strength: 0.5 }], weight), 51);
  });

  test('weights scale detectors and zero switches one off', () => {
    const factors = [{ detector: 'magnitude', strength: 1 }];
    assert.equal(combineScore(factors, () => 0.7), 70);
    assert.equal(combineScore(factors, () => 0), 1);
  });

  test('adding a signal never lowers the score', () => {
    const rand = random(7);
    for (let trial = 0; trial < 200; trial++) {
      const factors = Array.from({ length: Math.floor(rand() * 6) }, () => ({ detector: `d${Math.floor(rand() * 4)}`, strength: rand() }));
      const extra = { detector: `d${Math.floor(rand() * 6)}`, strength: rand() };
      const w = (d) => (Number(d.slice(1)) + 1) / 7;
      assert.ok(combineScore([...factors, extra], w) >= combineScore(factors, w));
    }
  });
});

describe('calibration: an honest Opening party raises no alarms', () => {
  test('realistic data from five organizers stays below the threshold', async () => {
    const world = await worldWithOrganizers();
    const rand = random(2026);
    const classNames = Object.keys(world.classes);
    const students = [];
    for (let i = 0; i < 40; i++) students.push({ name: `${LAST[i % 10]} ${FIRST[(i * 7) % 20]}`, cls: classNames[i % 5] });

    let clock = 0;
    const tick = () => minute((clock += 1 + rand() * 4));
    for (const by of ['org', 'org2', 'org3', 'org4', 'logan']) {
      let spent = 0;
      for (let i = 0; i < 15; i++) {
        const student = students[Math.floor(rand() * students.length)];
        const amount = [2, 3, 4, 5, 5, 6, 8][Math.floor(rand() * 7)];
        if (spent + amount > 90) break;
        spent += amount;
        entry(world, { by, reason: rand() < 0.5 ? 'style' : 'style2', cls: student.cls, name: student.name, amount, at: tick() });
      }
    }
    for (let i = 0; i < 20; i++) {
      const student = students[Math.floor(rand() * students.length)];
      const minutes = 10 + Math.floor(rand() * 50);
      entry(world, { by: ['org', 'org2', 'org3'][i % 3], reason: 'minutes', source: 'timer', cls: student.cls, name: student.name, amount: minutes, inputs: { minutes }, at: tick() });
    }
    for (const cls of classNames) {
      const people = 5 + Math.floor(rand() * 10);
      const stamps = people * (2 + Math.floor(rand() * 4));
      entry(world, { by: 'org4', reason: 'menetlevel', cls, name: '', amount: stamps * 5 + people * 2, inputs: { stamps, people }, at: tick() });
    }

    const items = report(world, { programId: world.program.id });
    const worst = items[0];
    assert.ok(items.length > 90);
    assert.ok(worst.score < world.settings.get('suspicion.threshold'), `false alarm: ${worst.score} ${JSON.stringify(worst.factors)}`);
    const median = items.map((i) => i.score).sort((a, b) => a - b)[items.length >> 1];
    assert.ok(median <= 5, `median score ${median}`);
  });

  test('an empty program analyses cleanly', async () => {
    const world = await createWorld();
    assert.deepEqual(report(world, { programId: world.program.id }), []);
  });
});

describe('detector: hard limits (Rulebook §8.2)', () => {
  test('a million points scores 100', async () => {
    const world = await createWorld();
    for (let i = 0; i < 10; i++) entry(world, { amount: 4 + (i % 3), name: `Diák ${LAST[i]}`, at: minute(i) });
    const { id } = adjustClassPoints(world.db, { actor: world.users.boss, classId: world.classes['7.A'], delta: 1_000_000, now: minute(20) });
    const item = itemOf(report(world), 'entry', id);
    assert.equal(item.score, 100);
    assert.ok(keysOf(item).includes('sus.limits.implausible'));
    assert.ok(keysOf(item).includes('sus.limits.ceiling'));
  });

  test('a huge entry is caught even when it is the only one (no peers to compare with)', async () => {
    const world = await createWorld();
    const { id } = adjustClassPoints(world.db, { actor: world.users.boss, classId: world.classes['7.A'], delta: -60_000, now: minute(1) });
    const item = itemOf(report(world), 'entry', id);
    assert.equal(item.score, 100);
    assert.deepEqual(item.factors.find((f) => f.key === 'sus.limits.ceiling').vars, { amount: -60_000, limit: 5000 });
  });

  test('ordinary superadmin imports stay below the ceiling', async () => {
    const world = await createWorld();
    for (let i = 0; i < 10; i++) entry(world, { amount: 150 + i * 20, reason: 'menetlevel', name: '', cls: Object.keys(world.classes)[i % 5], at: minute(i) });
    const { id } = adjustClassPoints(world.db, { actor: world.users.boss, classId: world.classes['7.A'], delta: 2000, now: minute(20) });
    assert.ok(itemOf(report(world), 'entry', id).score < 60);
  });

  test('an entry without its event log line (edited into the database) scores 100', async () => {
    const world = await createWorld();
    const id = insertEntry(world.db, { program_id: world.program.id, reason_id: world.reasons.style, class_id: world.classes['9.B'], amount: 5, source: 'form', created_by: world.users.org.id, created_at: minute(1) });
    const conversion = insertEntry(world.db, { program_id: world.program.id, reason_id: world.reasons.casino, class_id: world.classes['9.B'], amount: 5, source: 'casino', batch: 'casino:fake', created_by: world.users.boss.id, created_at: minute(2) });
    const items = report(world);
    assert.equal(itemOf(items, 'entry', id).score, 100);
    assert.ok(keysOf(itemOf(items, 'entry', conversion)).includes('sus.limits.noAudit'));
  });

  test('entries that no longer fit lowered limits, allowances, caps or pools', async () => {
    const world = await createWorld();
    const big = entry(world, { amount: 80, name: 'Nagy Nándor', at: minute(1) });
    const second = entry(world, { amount: 10, name: 'Kis Katalin', at: minute(2) });
    const minutes = entry(world, { reason: 'minutes', source: 'form', amount: 200, inputs: { minutes: 200 }, name: 'Sokáig Soma', at: minute(3) });
    const batch = 'pool:test';
    const poolA = entry(world, { reason: 'pool', source: 'pool', amount: 15, batch, inputs: { participants: 2 }, name: 'Első Előadó', at: minute(4) });
    entry(world, { reason: 'pool', source: 'pool', amount: 5, batch, inputs: { participants: 2 }, name: 'Második Előadó', at: minute(4) });
    world.db.prepare('UPDATE reasons SET max_points = 50 WHERE id = ?').run(world.reasons.style);
    world.db.prepare('UPDATE programs SET style_budget = 85 WHERE id = ?').run(world.program.id);
    world.db.prepare("UPDATE reason_params SET value = 120 WHERE reason_id = ? AND name = 'max_minutes'").run(world.reasons.minutes);
    world.db.prepare("UPDATE reason_params SET value = 5 WHERE reason_id = ? AND name = 'per_participant'").run(world.reasons.pool);
    const items = report(world);
    assert.ok(keysOf(itemOf(items, 'entry', big)).includes('sus.limits.amount'));
    assert.ok(keysOf(itemOf(items, 'entry', second)).includes('sus.limits.budget'), 'the entry that crossed the allowance');
    assert.ok(!keysOf(itemOf(items, 'entry', big)).includes('sus.limits.budget'));
    assert.ok(keysOf(itemOf(items, 'entry', minutes)).includes('sus.limits.inputCap'));
    assert.ok(keysOf(itemOf(items, 'entry', poolA)).includes('sus.limits.pool'));
    for (const id of [big, second, minutes, poolA]) assert.equal(itemOf(items, 'entry', id).score, 100);
  });

  test('more entries per class or per person than the reason allows', async () => {
    const world = await createWorld();
    const first = entry(world, { reason: 'menetlevel', cls: '10.A', name: '', amount: 100, inputs: { stamps: 20, people: 0 }, at: minute(1) });
    const second = entry(world, { reason: 'menetlevel', cls: '10.A', name: '', amount: 50, inputs: { stamps: 10, people: 0 }, at: minute(2) });
    const otherClass = entry(world, { reason: 'menetlevel', cls: '7.A', name: '', amount: 50, inputs: { stamps: 10, people: 0 }, at: minute(3) });
    world.db.prepare("INSERT INTO reason_params (reason_id, name, value) VALUES (?, 'max_entries_per_person', 1)").run(world.reasons.style);
    entry(world, { name: 'Egyszeri Egon', at: minute(4) });
    const twice = entry(world, { by: 'org2', name: 'egon egyszeri', at: minute(9) });
    const items = report(world);
    assert.ok(!keysOf(itemOf(items, 'entry', first)).includes('sus.limits.perClass'));
    assert.ok(keysOf(itemOf(items, 'entry', second)).includes('sus.limits.perClass'));
    assert.ok(!keysOf(itemOf(items, 'entry', otherClass)).includes('sus.limits.perClass'));
    assert.ok(keysOf(itemOf(items, 'entry', twice)).includes('sus.limits.perPerson'));
  });

  test('points recorded by casino staff, or for oneself', async () => {
    const world = await createWorld();
    const byDealer = entry(world, { by: 'dealer', amount: 5, name: 'Barát Béla', at: minute(1) });
    const self = entry(world, { by: 'org', cls: '9.A', amount: 5, name: 'Tornai Bence', at: minute(2) });
    const items = report(world);
    assert.ok(keysOf(itemOf(items, 'entry', byDealer)).includes('sus.limits.casinoStaff'));
    assert.ok(keysOf(itemOf(items, 'entry', self)).includes('sus.limits.selfAward'));
  });
});

describe('detector: magnitude', () => {
  test('an amount far above its peers is flagged, the ordinary ones are not', async () => {
    const world = await createWorld();
    const ordinary = [];
    for (let i = 0; i < 12; i++) ordinary.push(entry(world, { by: i % 2 ? 'org' : 'org2', amount: 3 + (i % 4), name: `Átlag ${LAST[i % 10]} ${FIRST[i]}`, at: minute(i * 3) }));
    const outlier = entry(world, { by: 'org2', amount: 85, name: 'Kiugró Kálmán', at: minute(50) });
    const items = report(world);
    assert.ok(keysOf(itemOf(items, 'entry', outlier)).includes('sus.magnitude.peer'));
    assert.ok(itemOf(items, 'entry', outlier).score >= 40);
    for (const id of ordinary) assert.ok(!itemOf(items, 'entry', id).factors.some((f) => f.detector === 'magnitude'));
  });
});

describe('detector: magnitude only compares like with like', () => {
  test('large class-level entries are not "suspicious" just for being bigger than style awards', async () => {
    const world = await createWorld();
    for (let i = 0; i < 12; i++) entry(world, { amount: 3 + (i % 4), name: `Stílus ${FIRST[i]}`, at: minute(i) });
    const sheet = entry(world, { reason: 'menetlevel', cls: '10.A', name: '', amount: 299, inputs: { stamps: 55, people: 12 }, at: minute(20) });
    const item = itemOf(report(world), 'entry', sheet);
    assert.ok(!item.factors.some((f) => f.detector === 'magnitude'), JSON.stringify(item.factors));
    assert.equal(item.score, 1);
  });
});

describe('detector: favoritism, own class, reciprocity (Rulebook §2.3)', () => {
  test('an organizer sending nearly everything to one class', async () => {
    const world = await worldWithOrganizers();
    const classes = Object.keys(world.classes);
    let t = 0;
    for (const by of ['org2', 'org3', 'org4']) {
      for (let i = 0; i < 20; i++) entry(world, { by, cls: classes[i % 5], amount: 3, name: `${by} ${LAST[i % 10]} ${FIRST[i]}`, at: minute((t += 2)) });
    }
    const biased = [];
    for (let i = 0; i < 20; i++) biased.push(entry(world, { by: 'org', cls: i < 18 ? '10.A' : '7.A', amount: 3, name: `Kedvenc ${FIRST[i]} ${LAST[i % 10]}`, at: minute((t += 2)) }));
    const items = report(world);
    const flagged = itemOf(items, 'entry', biased[0]);
    const factor = flagged.factors.find((f) => f.key === 'sus.favoritism');
    assert.ok(factor && factor.strength > 0.9, JSON.stringify(flagged.factors));
    assert.equal(factor.vars.className, '10.A');
    assert.ok(!keysOf(itemOf(items, 'entry', biased[19])).includes('sus.favoritism'), 'the class the organizer did not favour');
  });

  test('own-class awards carry a fixed weight in "flag" mode only', async () => {
    const world = await createWorld();
    const own = entry(world, { by: 'org', cls: '9.A', name: 'Osztálytárs Olga', at: minute(1) });
    const other = entry(world, { by: 'org', cls: '9.B', name: 'Idegen Ivó', at: minute(5) });
    let items = report(world);
    assert.ok(keysOf(itemOf(items, 'entry', own)).includes('sus.ownClass'));
    assert.equal(itemOf(items, 'entry', own).score, 36);
    assert.ok(!keysOf(itemOf(items, 'entry', other)).includes('sus.ownClass'));
    world.settings.set('rules.own_class', 'allow');
    items = report(world);
    assert.equal(itemOf(items, 'entry', own).score, 1);
  });

  test('two organizers favouring each other’s classes', async () => {
    const world = await worldWithOrganizers();
    const classes = Object.keys(world.classes);
    let t = 0;
    for (const by of ['org3', 'org4', 'logan']) {
      for (let i = 0; i < 15; i++) entry(world, { by, cls: classes[i % 5], amount: 4, name: `${by} ${FIRST[i]}`, at: minute((t += 2)) });
    }
    const ab = [];
    const ba = [];
    for (let i = 0; i < 6; i++) {
      ab.push(entry(world, { by: 'org', cls: '9.B', amount: 10, name: `Cseh Barátja ${FIRST[i]}`, at: minute((t += 2)) }));
      ba.push(entry(world, { by: 'org2', cls: '9.A', amount: 10, name: `Tornai Barátja ${FIRST[i]}`, at: minute((t += 2)) }));
    }
    entry(world, { by: 'org', cls: '7.A', amount: 2, name: 'Álca Ádám', at: minute((t += 2)) });
    entry(world, { by: 'org2', cls: '11.A', amount: 2, name: 'Álca Éva', at: minute((t += 2)) });
    const items = report(world);
    for (const id of [...ab, ...ba]) assert.ok(keysOf(itemOf(items, 'entry', id)).includes('sus.reciprocity'), String(id));
    assert.ok(itemOf(items, 'entry', ab[0]).score >= 60, String(itemOf(items, 'entry', ab[0]).score));
  });
});

describe('detector: organizer behaviour', () => {
  test('pouring points into one student, repeatedly', async () => {
    const world = await createWorld();
    const favourite = [];
    for (let i = 0; i < 5; i++) favourite.push(entry(world, { amount: 12, name: 'Kedvenc Kornél', at: minute(i * 10) }));
    const others = [entry(world, { amount: 3, name: 'Más Márta', at: minute(60) }), entry(world, { amount: 3, name: 'Más Mátyás', at: minute(70) })];
    const items = report(world);
    const keys = keysOf(itemOf(items, 'entry', favourite[0]));
    assert.ok(keys.includes('sus.concentration.share') && keys.includes('sus.concentration.repeat'), keys.join());
    assert.ok(!keysOf(itemOf(items, 'entry', others[0])).includes('sus.concentration.repeat'));
  });

  test('bursts far above the organizer’s pace, and humanly impossible speed', async () => {
    const world = await createWorld();
    for (let i = 0; i < 10; i++) entry(world, { amount: 3, name: `Lassú ${FIRST[i]} ${LAST[i]}`, at: minute(i * 15) });
    const burst = [];
    for (let i = 0; i < 8; i++) burst.push(entry(world, { amount: 3, name: `Gyors ${FIRST[i]} ${LAST[(i + 3) % 10]}`, at: new Date(Date.parse(minute(200)) + i * 2000).toISOString() }));
    const items = report(world);
    const keys = keysOf(itemOf(items, 'entry', burst[4]));
    assert.ok(keys.includes('sus.velocity.burst'), keys.join());
    assert.ok(keys.includes('sus.velocity.fast'));
    assert.ok(!keysOf(itemOf(items, 'entry', burst[0])).includes('sus.velocity.fast'), 'the first of the burst had a normal gap');
  });

  test('frequent stornos, inflated corrections, void-and-re-enter-higher', async () => {
    const world = await createWorld();
    for (let i = 0; i < 12; i++) entry(world, { by: 'org2', amount: 4, name: `Rendes ${FIRST[i]}`, at: minute(i * 5) });
    const voided = [];
    for (let i = 0; i < 8; i++) {
      const id = entry(world, { by: 'org', amount: 4, name: `Sztornós ${FIRST[i]}`, at: minute(i * 6) });
      if (i < 6) {
        voidIt(world, id, minute(i * 6 + 1));
        voided.push(id);
      }
    }
    const original = entry(world, { by: 'org', amount: 5, name: 'Javított János', at: minute(100) });
    voidIt(world, original, minute(101));
    const inflated = entry(world, { by: 'org', amount: 40, name: 'Javított János', corrects: original, at: minute(101) });
    const plain = entry(world, { by: 'org2', amount: 5, name: 'Újra Ubul', at: minute(110) });
    voidIt(world, plain, minute(111), 'org2');
    const recreated = entry(world, { by: 'org2', amount: 30, name: 'Újra Ubul', at: minute(115) });
    const items = report(world);
    assert.ok(keysOf(itemOf(items, 'entry', voided[0])).includes('sus.voids.rate'));
    assert.ok(keysOf(itemOf(items, 'entry', inflated)).includes('sus.voids.inflation'));
    assert.ok(keysOf(itemOf(items, 'entry', recreated)).includes('sus.voids.recreate'));
    assert.ok(!itemOf(items, 'entry', recreated).factors.some((f) => f.key === 'sus.voids.rate'), 'org2 voids rarely');
  });

  test('typed minutes while the timer exists, at the cap, suspiciously round', async () => {
    const world = await createWorld();
    const typed = entry(world, { reason: 'minutes', source: 'form', amount: 240, inputs: { minutes: 240 }, name: 'Kerek Kristóf', at: minute(1) });
    const timed = entry(world, { reason: 'minutes', source: 'timer', amount: 240, inputs: { minutes: 240 }, name: 'Mért Márk', at: minute(2) });
    let items = report(world);
    assert.deepEqual(keysOf(itemOf(items, 'entry', typed)).filter((k) => k.startsWith('sus.manual')).sort(), ['sus.manual.atCap', 'sus.manual.round', 'sus.manual.timerOn']);
    assert.ok(!keysOf(itemOf(items, 'entry', timed)).some((k) => k.startsWith('sus.manual')));
    world.settings.set('features.timer', false);
    items = report(world);
    assert.ok(!keysOf(itemOf(items, 'entry', typed)).includes('sus.manual.timerOn'));
  });
});

describe('detector: timing (Rulebook §3.6, §7.2)', () => {
  test('outside the time window and while the program was closed', async () => {
    const world = await createWorld();
    world.db.prepare('UPDATE programs SET starts_at = ?, ends_at = ? WHERE id = ?').run(minute(0), minute(300), world.program.id);
    const early = entry(world, { name: 'Korán Kelő', at: minute(-30) });
    const fine = entry(world, { name: 'Időben Ida', at: minute(30) });
    applyChange(world.db, { actor: world.users.boss, target: `program:${world.program.id}:status`, op: 'set', value: 'closed', now: minute(100) });
    const whileClosed = entry(world, { by: 'boss', name: 'Zárás Után', at: minute(120) });
    applyChange(world.db, { actor: world.users.boss, target: `program:${world.program.id}:status`, op: 'set', value: 'open', now: minute(130) });
    const reopened = entry(world, { name: 'Újranyitás Után', at: minute(140) });
    const items = report(world);
    assert.ok(keysOf(itemOf(items, 'entry', early)).includes('sus.timing.window'));
    assert.ok(keysOf(itemOf(items, 'entry', whileClosed)).includes('sus.timing.closed'));
    for (const id of [fine, reopened]) assert.ok(!itemOf(items, 'entry', id).factors.some((f) => f.detector === 'timing'));
  });

  test('a rush of entries right before standings are published', async () => {
    const world = await createWorld();
    const rush = [];
    for (let i = 0; i < 7; i++) rush.push(entry(world, { name: `Hajrá ${FIRST[i]}`, amount: 3, at: minute(55 + i) }));
    const earlier = entry(world, { name: 'Korábbi Kornélia', at: minute(10) });
    publishSnapshot(world.db, { actor: world.users.boss, label: '', now: minute(62.5) });
    const items = report(world);
    assert.ok(keysOf(itemOf(items, 'entry', rush[3])).includes('sus.timing.lastMinute'));
    assert.ok(!keysOf(itemOf(items, 'entry', earlier)).includes('sus.timing.lastMinute'));
  });
});

describe('detector: names and classes (Rulebook §3.3)', () => {
  test('the same student in two classes: the minority class is the likely wrong one', async () => {
    const world = await createWorld();
    const right = [entry(world, { cls: '9.B', name: 'Kettős Kata', at: minute(1) }), entry(world, { by: 'org2', cls: '9.B', name: 'kata kettős', at: minute(10) })];
    const wrong = entry(world, { by: 'org', cls: '10.A', name: 'Kettős Kata', at: minute(20) });
    const items = report(world);
    const strength = (id) => itemOf(items, 'entry', id).factors.find((f) => f.key === 'sus.names.multiClass').strength;
    assert.equal(strength(wrong), 0.9);
    assert.equal(strength(right[0]), 0.4);
  });

  test('near-identical names in different classes, organizers as recipients, odd names', async () => {
    const world = await createWorld();
    const a = entry(world, { cls: '9.B', name: 'Kovács Péter', at: minute(1) });
    const b = entry(world, { cls: '10.A', name: 'Kovács Pétr', at: minute(5) });
    const sameClassTypo = entry(world, { cls: '9.B', name: 'Kovács Pétter', at: minute(6) });
    const organizer = entry(world, { by: 'org', cls: '9.B', name: 'Cseh Benedek', at: minute(10) });
    const digits = entry(world, { name: 'Diák 123', at: minute(20) });
    const tiny = entry(world, { name: 'Xy', at: minute(30) });
    const items = report(world);
    assert.ok(keysOf(itemOf(items, 'entry', a)).includes('sus.names.similar'));
    assert.ok(keysOf(itemOf(items, 'entry', b)).includes('sus.names.similar'));
    assert.ok(keysOf(itemOf(items, 'entry', organizer)).includes('sus.names.organizer'));
    assert.ok(keysOf(itemOf(items, 'entry', digits)).includes('sus.names.odd'));
    assert.ok(keysOf(itemOf(items, 'entry', tiny)).includes('sus.names.odd'));
    assert.ok(itemOf(items, 'entry', sameClassTypo), 'typos inside one class are not steering points to another class');
  });
});

describe('detector: casino (Rulebook §5, §8.3)', () => {
  test('a cash-out far above everyone else’s', async () => {
    const world = await createWorld();
    const normal = [];
    for (let i = 0; i < 9; i++) normal.push(cashout(world, { visitId: visit(world, { name: `Játékos ${FIRST[i]}`, cls: '9.B', recorded: 0 }), chips: 70 + i * 7 }));
    const lucky = cashout(world, { visitId: visit(world, { name: 'Szerencse Szilárd', recorded: 0 }), chips: 2400 });
    const items = report(world);
    assert.ok(keysOf(itemOf(items, 'cashout', lucky)).includes('sus.casino.return'));
    assert.ok(!keysOf(itemOf(items, 'cashout', normal[4])).includes('sus.casino.return'));
  });

  test('one staff member’s cash-outs are systematically higher (Mann–Whitney)', async () => {
    const world = await createWorld();
    const generous = [];
    for (let i = 0; i < 10; i++) {
      generous.push(cashout(world, { by: 'dealer', visitId: visit(world, { by: 'dealer', name: `Bőkezű ${FIRST[i]}`, recorded: 0 }), chips: 160 + i * 6 }));
      cashout(world, { by: 'dealer2', visitId: visit(world, { by: 'dealer2', name: `Szigorú ${FIRST[i]}`, recorded: 0 }), chips: 60 + i * 6 });
    }
    const items = report(world);
    assert.ok(keysOf(itemOf(items, 'cashout', generous[9])).includes('sus.casino.staffLift'));
  });

  test('bookkeeping: own class, repeat visits, counted less than recorded, balance mismatch', async () => {
    const world = await createWorld();
    const own = cashout(world, { visitId: visit(world, { name: 'Osztálytárs Oszkár', cls: '11.A', recorded: 0 }), chips: 100 });
    visit(world, { name: 'Visszajáró Vazul', at: minute(0) });
    const repeat = cashout(world, { visitId: visit(world, { name: 'Visszajáró Vazul', at: minute(40) }), chips: 90, at: minute(50) });
    const detailed = visit(world, { name: 'Részletes Rozi' });
    round(world, { results: [[detailed, 20]] });
    const mismatch = cashout(world, { visitId: detailed, chips: 300 });
    world.db.prepare("INSERT INTO casino_counts (program_id, staff_id, chips, created_by, created_at) VALUES (?, ?, 200, ?, 'x')").run(world.program.id, world.users.dealer.id, world.users.boss.id);
    const items = report(world);
    assert.ok(keysOf(itemOf(items, 'cashout', own)).includes('sus.casino.ownClass'));
    assert.ok(keysOf(itemOf(items, 'cashout', repeat)).includes('sus.casino.repeat'));
    assert.ok(keysOf(itemOf(items, 'cashout', mismatch)).includes('sus.casino.mismatch'));
    const reconciliation = itemOf(items, 'cashout', mismatch).factors.find((f) => f.key === 'sus.casino.reconciliation');
    assert.equal(reconciliation.vars.diff, 290, 'recorded 490 chips, counted 200');
    assert.equal(reconciliation.strength, 1);
  });

  test('a dealer whose players win far more often than at other tables', async () => {
    const world = await createWorld();
    const lucky = [];
    for (let i = 0; i < 16; i++) {
      const v1 = visit(world, { by: 'dealer', name: `Asztal Egy ${FIRST[i]}` });
      const v2 = visit(world, { by: 'dealer2', name: `Asztal Kettő ${FIRST[i]}` });
      const r = round(world, { by: 'dealer', results: [[v1, i < 15 ? 10 : -10]], at: minute(i) });
      if (i < 15) lucky.push(r);
      round(world, { by: 'dealer2', results: [[v2, i < 5 ? 10 : -10]], at: minute(i) });
    }
    const items = report(world);
    assert.ok(keysOf(itemOf(items, 'round', lucky[0])).includes('sus.casino.winRate'));
  });

  test('chip dumping between two players across rounds, and a freak win', async () => {
    const world = await createWorld();
    const giver = visit(world, { name: 'Adakozó Aladár' });
    const taker = visit(world, { name: 'Gyűjtő Gyula', cls: '10.A' });
    const dump1 = round(world, { kind: 'pvp', results: [[giver, -50], [taker, 50]], at: minute(5) });
    const dump2 = round(world, { kind: 'pvp', results: [[giver, -45], [taker, 45]], at: minute(6) });
    const wins = [];
    for (let i = 0; i < 8; i++) wins.push(round(world, { results: [[visit(world, { name: `Nyerő ${FIRST[i]}` }), 8 + (i % 4)]], at: minute(10 + i) }));
    const freak = round(world, { results: [[visit(world, { name: 'Főnyeremény Ferkó' }), 400]], at: minute(30) });
    const items = report(world);
    for (const id of [dump1, dump2]) assert.ok(keysOf(itemOf(items, 'round', id)).includes('sus.casino.dumping'));
    assert.ok(keysOf(itemOf(items, 'round', freak)).includes('sus.casino.bigWin'));
    assert.ok(!keysOf(itemOf(items, 'round', wins[0])).includes('sus.casino.bigWin'));
  });
});

describe('analysis scope and ordering', () => {
  test('a program filter excludes other programs and adjustments; results are sorted by score', async () => {
    const world = await createWorld();
    const halloween = world.programBySlug('halloween');
    world.db.prepare("UPDATE programs SET status = 'open' WHERE id = ?").run(halloween.id);
    const halloweenReason = world.db.prepare('SELECT id FROM reasons WHERE program_id = ? LIMIT 1').get(halloween.id).id;
    createAward(world.db, world.settings, { actor: world.users.org, reasonId: halloweenReason, input: { classId: world.classes['9.B'], amount: '50' }, now: minute(1) });
    const own = entry(world, { by: 'org', cls: '9.A', name: 'Osztálytárs Olga', at: minute(2) });
    entry(world, { by: 'org', cls: '9.B', name: 'Más Márton', at: minute(9) });
    adjustClassPoints(world.db, { actor: world.users.boss, classId: world.classes['9.B'], delta: 5, now: minute(3) });
    const nyitobuli = report(world, { programId: world.program.id });
    assert.equal(nyitobuli.length, 2);
    assert.equal(nyitobuli[0].id, own, 'the flagged entry comes first');
    assert.equal(report(world).length, 4);
  });
});
