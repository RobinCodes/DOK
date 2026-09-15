import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../../src/db/database.js';
import { migrate, SCHEMA_VERSION } from '../../src/db/schema.js';
import { ANONYMOUS, audit, CONSOLE, verifyAuditChain } from '../../src/domain/audit.js';
import { createWorld } from '../helpers.js';

describe('schema and seed', () => {
  test('a fresh database is migrated and seeded from the rulebook', () => {
    const db = openDatabase(':memory:');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const slugs = db.prepare('SELECT slug FROM programs ORDER BY sort').all().map((p) => p.slug);
    assert.deepEqual(slugs, ['nyitobuli', 'halloween', 'sutivasar', 'sleepover', 'suliga', 'temanapok', 'istvan-nap', 'arany-cikesz']);
    const nyitobuli = db.prepare("SELECT * FROM programs WHERE slug = 'nyitobuli'").get();
    assert.equal(nyitobuli.style_budget, 90);
    assert.equal(nyitobuli.status, 'upcoming', 'programs start closed until the superadmin opens them');
    const snitch = db.prepare("SELECT r.* FROM reasons r JOIN programs p ON p.id = r.program_id WHERE p.slug = 'arany-cikesz'").get();
    assert.deepEqual([snitch.min_points, snitch.max_points], [60, 60]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM casino_games').get().n, 7);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM classes').get().n, 0, 'classes are not invented');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, 'accounts are created on the console');
  });

  test('reopening an existing database neither re-migrates nor re-seeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'szigzug-'));
    try {
      const path = join(dir, 'nested', 'test.db');
      const first = openDatabase(path);
      first.prepare("UPDATE programs SET name_hu = 'Átnevezve' WHERE slug = 'nyitobuli'").run();
      assert.equal(first.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      first.close();
      const second = openDatabase(path);
      assert.equal(second.prepare('SELECT COUNT(*) AS n FROM programs').get().n, 8);
      assert.equal(second.prepare("SELECT name_hu FROM programs WHERE slug = 'nyitobuli'").get().name_hu, 'Átnevezve');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a database from a newer version of the code', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    assert.throws(() => migrate(db), /newer than this code/);
  });

  test('a failing migration is rolled back completely', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE classes (x)'); // collides with the first migration
    assert.throws(() => migrate(db));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'users'").get().n, 0);
  });
});

describe('database-level integrity (defence against bugs and hand edits)', () => {
  async function withEntry() {
    const world = await createWorld();
    const { db, users, classes, program, reasons } = world;
    db.prepare(`
      INSERT INTO entries (program_id, reason_id, class_id, amount, source, created_by, created_at)
      VALUES (?, ?, ?, 10, 'form', ?, '2026-09-18T12:00:00.000Z')`).run(program.id, reasons.style, classes['9.A'], users.org.id);
    return world;
  }

  test('ledger entries cannot be edited or deleted, only voided once', async () => {
    const { db, users } = await withEntry();
    assert.throws(() => db.prepare('UPDATE entries SET amount = 1000').run(), /immutable/);
    assert.throws(() => db.prepare('UPDATE entries SET class_id = class_id + 1').run(), /immutable/);
    assert.throws(() => db.prepare("UPDATE entries SET note = 'x'").run(), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM entries').run(), /cannot be deleted/);
    assert.throws(() => db.prepare("UPDATE entries SET void_reason = 'x'").run(), /immutable/, 'voiding needs voided_at');
    db.prepare("UPDATE entries SET voided_by = ?, voided_at = '2026-09-18T13:00:00.000Z', void_reason = 'mistake'").run(users.org.id);
    assert.throws(() => db.prepare('UPDATE entries SET voided_at = NULL').run(), /immutable/, 'a void is permanent');
    assert.throws(() => db.prepare("UPDATE entries SET void_reason = 'changed'").run(), /immutable/);
  });

  test('the event log is append-only', async () => {
    const { db } = await createWorld();
    audit(db, { actor: CONSOLE, action: 'test.one' });
    assert.throws(() => db.prepare("UPDATE audit_log SET action = 'x'").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
  });

  test('casino records are immutable except voiding, and results are fully immutable', async () => {
    const { db, users, classes, program } = await createWorld();
    const visit = db
      .prepare(`INSERT INTO casino_visits (program_id, class_id, person_name, person_key, start_chips, created_by, created_at)
                VALUES (?, ?, 'A B', 'a b', 100, ?, 'now')`)
      .run(program.id, classes['9.A'], users.dealer.id).lastInsertRowid;
    const round = db.prepare("INSERT INTO casino_rounds (program_id, game_id, created_by, created_at) VALUES (?, 1, ?, 'now')").run(program.id, users.dealer.id).lastInsertRowid;
    db.prepare('INSERT INTO casino_results (round_id, visit_id, delta) VALUES (?, ?, 5)').run(round, visit);
    const cashout = db.prepare("INSERT INTO casino_cashouts (visit_id, chips, created_by, created_at) VALUES (?, 105, ?, 'now')").run(visit, users.dealer.id).lastInsertRowid;
    assert.throws(() => db.prepare('UPDATE casino_visits SET start_chips = 1000').run(), /immutable/);
    assert.throws(() => db.prepare('UPDATE casino_cashouts SET chips = 1000').run(), /immutable/);
    assert.throws(() => db.prepare('UPDATE casino_rounds SET game_id = 2').run(), /immutable/);
    assert.throws(() => db.prepare('UPDATE casino_results SET delta = 500').run(), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM casino_results').run(), /cannot be deleted/);
    assert.throws(() => db.prepare('INSERT INTO casino_results (round_id, visit_id, delta) VALUES (?, ?, 0)').run(round, visit), /CHECK|UNIQUE|PRIMARY/);
    assert.throws(() => db.prepare("INSERT INTO casino_cashouts (visit_id, chips, created_by, created_at) VALUES (?, 1, ?, 'now')").run(visit, users.dealer.id), /UNIQUE/, 'one active cash-out per visit');
    db.prepare("UPDATE casino_cashouts SET voided_by = ?, voided_at = 'later', void_reason = 'x' WHERE id = ?").run(users.dealer.id, cashout);
    db.prepare("INSERT INTO casino_cashouts (visit_id, chips, created_by, created_at) VALUES (?, 1, ?, 'now')").run(visit, users.dealer.id);
  });

  test('one running timer per person, enforced by a unique index', async () => {
    const { db, users, classes, reasons } = await createWorld();
    const insert = db.prepare("INSERT INTO timers (reason_id, class_id, person_name, person_key, started_by, started_at) VALUES (?, ?, 'X Y', 'x y', ?, 'now')");
    insert.run(reasons.minutes, classes['9.A'], users.org.id);
    assert.throws(() => insert.run(reasons.minutes, classes['9.B'], users.org2.id), /UNIQUE/);
    db.prepare("UPDATE timers SET ended_at = 'later', outcome = 'cancelled'").run();
    insert.run(reasons.minutes, classes['9.A'], users.org.id);
  });

  test('a casino cash-out converts into at most one active entry', async () => {
    const { db, users, classes, program, reasons } = await createWorld();
    const visit = db.prepare("INSERT INTO casino_visits (program_id, class_id, person_name, person_key, start_chips, created_by, created_at) VALUES (?, ?, 'A', 'a', 100, ?, 'now')").run(program.id, classes['9.A'], users.dealer.id).lastInsertRowid;
    const cashout = db.prepare("INSERT INTO casino_cashouts (visit_id, chips, created_by, created_at) VALUES (?, 100, ?, 'now')").run(visit, users.dealer.id).lastInsertRowid;
    const insert = db.prepare("INSERT INTO entries (program_id, reason_id, class_id, amount, source, cashout_id, created_by, created_at) VALUES (?, ?, ?, 10, 'casino', ?, ?, 'now')");
    insert.run(program.id, reasons.casino, classes['9.A'], cashout, users.boss.id);
    assert.throws(() => insert.run(program.id, reasons.casino, classes['9.A'], cashout, users.boss.id), /UNIQUE/);
  });

  test('check constraints reject impossible values', async () => {
    const { db, users } = await createWorld();
    assert.throws(() => db.prepare("UPDATE users SET role = 'god' WHERE id = ?").run(users.org.id), /CHECK/);
    assert.throws(() => db.prepare("UPDATE programs SET status = 'maybe'").run(), /CHECK/);
    assert.throws(() => db.prepare('UPDATE programs SET style_budget = -1').run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO reason_params (reason_id, name, value) VALUES (1, 'Bad-Name', 1)").run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO reason_params (reason_id, name, value) VALUES (1, '_x', 1)").run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO classes (name) VALUES ('9.a')").run(), /UNIQUE/, 'class names are case-insensitive');
    assert.throws(() => db.prepare("INSERT INTO entries (class_id, amount, source, created_by, created_at) VALUES (999, 1, 'form', 1, 'x')").run(), /FOREIGN KEY/);
  });
});

describe('transactions', () => {
  test('commit, rollback and nested savepoints', async () => {
    const { db } = await createWorld();
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM classes').get().n;
    const before = count();
    transaction(db, () => db.prepare("INSERT INTO classes (name) VALUES ('X1')").run());
    assert.equal(count(), before + 1);
    assert.throws(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO classes (name) VALUES ('X2')").run();
        throw new Error('boom');
      }),
    );
    assert.equal(count(), before + 1);
    transaction(db, () => {
      db.prepare("INSERT INTO classes (name) VALUES ('X3')").run();
      assert.throws(() =>
        transaction(db, () => {
          db.prepare("INSERT INTO classes (name) VALUES ('X4')").run();
          throw new Error('inner');
        }),
      );
    });
    assert.deepEqual(db.prepare("SELECT name FROM classes WHERE name LIKE 'X%' ORDER BY name").all().map((r) => r.name), ['X1', 'X3']);
    assert.equal(db.isTransaction, false);
  });

  test('refuses async callbacks, which would commit too early', async () => {
    const { db } = await createWorld();
    assert.throws(() => transaction(db, async () => {}), /synchronous/);
    assert.equal(db.isTransaction, false);
  });
});

describe('event log hash chain', () => {
  test('verifies an intact chain and records actors', async () => {
    const { db, users } = await createWorld();
    audit(db, { actor: users.org, action: 'a', details: { x: 1 }, ip: '1.2.3.4', at: '2026-09-18T12:00:00.000Z' });
    audit(db, { actor: CONSOLE, action: 'b' });
    audit(db, { actor: ANONYMOUS, action: 'c' });
    const result = verifyAuditChain(db);
    assert.equal(result.ok, true);
    assert.equal(result.count, 3);
    assert.match(result.lastHash, /^[0-9a-f]{64}$/);
    const rows = db.prepare('SELECT actor, actor_id FROM audit_log ORDER BY id').all();
    assert.deepEqual(rows.map((r) => [r.actor, r.actor_id]), [['org', users.org.id], ['console', null], ['-', null]]);
  });

  test('pinpoints hand edits, deletions and insertions made around the triggers', async () => {
    const cases = [
      ['edited details', "UPDATE audit_log SET details = '{\"amount\":1}' WHERE id = 2", 2],
      ['edited time', "UPDATE audit_log SET created_at = '2020-01-01' WHERE id = 2", 2],
      ['deleted row', 'DELETE FROM audit_log WHERE id = 2', 3],
      ['forged row', "INSERT INTO audit_log (created_at, actor, action, prev_hash, hash) VALUES ('x', 'x', 'x', 'x', 'fake')", 4],
    ];
    for (const [label, sql, brokenAt] of cases) {
      const { db } = await createWorld();
      for (const action of ['one', 'two', 'three']) audit(db, { actor: CONSOLE, action });
      db.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
      db.exec(sql);
      const result = verifyAuditChain(db);
      assert.equal(result.ok, false, label);
      assert.equal(result.brokenAt, brokenAt, label);
    }
  });

  test('an empty log is valid', async () => {
    const { db } = await createWorld();
    assert.deepEqual(verifyAuditChain(db), { ok: true, count: 0, lastHash: '0'.repeat(64) });
  });
});
