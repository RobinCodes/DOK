import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyPassword } from '../../src/auth/passwords.js';
import { createSession, findSession } from '../../src/auth/sessions.js';
import { CliError, runUsers, USAGE } from '../../src/cli/users.js';
import { openDatabase } from '../../src/db/database.js';
import { verifyAuditChain } from '../../src/domain/audit.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function capture() {
  const lines = [];
  return { lines, print: (line) => lines.push(line) };
}

function answers(...values) {
  return async () => values.shift() ?? '';
}

async function run(db, args, passwords = []) {
  const out = capture();
  await runUsers(db, args, { readPassword: answers(...passwords), print: out.print, cost: 1024 });
  return out.lines;
}

describe('users command', () => {
  test('create accounts of every kind', async () => {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO classes (name) VALUES ('9.A')").run();
    assert.deepEqual(await run(db, ['create', 'bence', '--name', 'Tornai  Bence', '--role', 'admin', '--class', '9.A'], ['long-password-1', 'long-password-1']), ['Created admin: bence (Tornai Bence)']);
    assert.deepEqual(await run(db, ['create', 'dani', '--name', 'Császár Domonkos', '--casino'], ['long-password-2', 'long-password-2']), ['Created admin (casino staff): dani (Császár Domonkos)']);
    await run(db, ['create', 'robin', '--name', 'Rovenszky Robin', '--role', 'superadmin'], ['long-password-3', 'long-password-3']);
    const bence = db.prepare("SELECT * FROM users WHERE username = 'bence'").get();
    assert.equal(bence.display_name, 'Tornai Bence');
    assert.equal(bence.class_id, 1);
    assert.equal(await verifyPassword('long-password-1', bence.password_hash), true);
    assert.equal(db.prepare("SELECT is_casino FROM users WHERE username = 'dani'").get().is_casino, 1);
    assert.equal(db.prepare("SELECT role FROM users WHERE username = 'robin'").get().role, 'superadmin');
    const log = db.prepare("SELECT actor, details FROM audit_log WHERE action = 'user.create'").all();
    assert.equal(log.length, 3);
    assert.equal(log[0].actor, 'console');
    assert.doesNotMatch(log.map((l) => l.details).join(), /long-password/, 'passwords never reach the log');
    assert.equal(verifyAuditChain(db).ok, true);
  });

  test('refuses bad input with a clear message and changes nothing', async () => {
    const db = openDatabase(':memory:');
    await run(db, ['create', 'taken', '--name', 'A B'], ['long-password-1', 'long-password-1']);
    const cases = [
      [['create', 'taken', '--name', 'X'], ['long-password-1', 'long-password-1'], /already exists/],
      [['create', 'TAKEN', '--name', 'X'], ['long-password-1', 'long-password-1'], /already exists/],
      [['create', 'a', '--name', 'X'], [], /Username/],
      [['create', 'bad name!', '--name', 'X'], [], /Username/],
      [['create', 'newbie', '--name', 'X', '--role', 'god'], [], /Role must be one of/],
      [['create', 'newbie'], [], /--name/],
      [['create', 'newbie', '--name', 'X', '--class', '99.Z'], [], /No such class/],
      [['create', 'newbie', '--name', 'X'], ['short', 'short'], /at least 10 characters/],
      [['create', 'newbie', '--name', 'X'], ['long-password-1', 'long-password-2'], /do not match/],
      [['create', 'newbie', '--name', 'X', '--nope'], [], /Unknown option/],
      [['passwd', 'ghost'], [], /No such user/],
      [['role', 'taken', 'emperor'], [], /Role must be one of/],
      [['casino', 'taken', 'maybe'], [], /on\|off/],
      [['explode'], [], /Usage/],
      [[], [], /Usage/],
    ];
    for (const [args, passwords, message] of cases) {
      await assert.rejects(run(db, args, passwords), (err) => err instanceof CliError && message.test(err.message), args.join(' '));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.match(USAGE, /users create/);
  });

  test('password change, role change and disabling all log the user out everywhere', async () => {
    const db = openDatabase(':memory:');
    await run(db, ['create', 'org', '--name', 'Org Anna'], ['long-password-1', 'long-password-1']);
    const id = db.prepare("SELECT id FROM users WHERE username = 'org'").get().id;
    const login = () => createSession(db, id, { hours: 1, now: 0 }).token;

    let token = login();
    assert.deepEqual(await run(db, ['passwd', 'org'], ['brand-new-password', 'brand-new-password']), ['Password changed for org; their sessions were logged out.']);
    assert.equal(findSession(db, token, 1), null);
    assert.equal(await verifyPassword('brand-new-password', db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash), true);

    token = login();
    await run(db, ['role', 'org', 'logadmin']);
    assert.equal(findSession(db, token, 1), null);

    await run(db, ['casino', 'org', 'on']);
    assert.equal(db.prepare('SELECT is_casino FROM users WHERE id = ?').get(id).is_casino, 1);
    await run(db, ['casino', 'org', 'off']);

    token = login();
    assert.deepEqual(await run(db, ['disable', 'org']), ['org disabled.']);
    assert.equal(findSession(db, token, 1), null);
    assert.equal(db.prepare('SELECT active FROM users WHERE id = ?').get(id).active, 0);
    await run(db, ['enable', 'org']);
    assert.equal(db.prepare('SELECT active FROM users WHERE id = ?').get(id).active, 1);
    const actions = db.prepare('SELECT action FROM audit_log ORDER BY id').all().map((r) => r.action);
    assert.deepEqual(actions, ['user.create', 'user.passwd', 'user.role', 'user.casino', 'user.casino', 'user.disable', 'user.enable']);
  });

  test('list shows roles, casino staff, classes and disabled accounts', async () => {
    const db = openDatabase(':memory:');
    assert.deepEqual(await run(db, ['list']), ['No users yet.']);
    db.prepare("INSERT INTO classes (name) VALUES ('10.B')").run();
    await run(db, ['create', 'zsofi', '--name', 'Nagy Zsófi', '--role', 'logadmin', '--class', '10.B', '--casino'], ['long-password-1', 'long-password-1']);
    await run(db, ['disable', 'zsofi']);
    const [line] = await run(db, ['list']);
    assert.match(line, /^zsofi\s+Nagy Zsófi \[logadmin, casino, 10\.B, DISABLED\]$/);
  });
});

function spawnNode(script, args, { input, env }) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, script), ...args], { env: { ...process.env, ...env }, cwd: ROOT }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

describe('console scripts (real processes)', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'szigzug-cli-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('bin/users.js reads piped passwords and writes to DB_PATH', async () => {
    const dbPath = join(dir, 'data', 'cli.db');
    const created = await spawnNode('bin/users.js', ['create', 'robin', '--name', 'Rovenszky Robin', '--role', 'superadmin'], { input: 'piped-password-123\npiped-password-123\n', env: { DB_PATH: dbPath } });
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /Created superadmin: robin/);
    const listed = await spawnNode('bin/users.js', ['list'], { input: '', env: { DB_PATH: dbPath } });
    assert.match(listed.stdout, /robin\s+Rovenszky Robin \[superadmin\]/);
    const failed = await spawnNode('bin/users.js', ['role', 'nobody', 'admin'], { input: '', env: { DB_PATH: dbPath } });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /No such user: nobody/);
    const db = openDatabase(dbPath);
    try {
      assert.equal(await verifyPassword('piped-password-123', db.prepare('SELECT password_hash FROM users').get().password_hash), true);
    } finally {
      db.close();
    }
  });

  test('bin/backup.js makes a consistent copy, verifies the log and keeps only the newest backups', async () => {
    const dbPath = join(dir, 'backup-source.db');
    const backups = join(dir, 'backups');
    const setup = await spawnNode('bin/users.js', ['create', 'robin', '--name', 'R R', '--role', 'superadmin'], { input: 'piped-password-123\npiped-password-123\n', env: { DB_PATH: dbPath } });
    assert.equal(setup.code, 0, setup.stderr);
    for (let i = 0; i < 3; i++) {
      const res = await spawnNode('bin/backup.js', [backups], { env: { DB_PATH: dbPath, BACKUP_KEEP: '2' } });
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /Backup written: .*szigzug-.*\.db/);
      assert.match(res.stdout, /Event log OK: 1 entries, last hash [0-9a-f]{64}/);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const files = readdirSync(backups);
    assert.equal(files.length, 2);
    const copy = openDatabase(join(backups, files[1]));
    try {
      assert.equal(copy.prepare('SELECT username FROM users').get().username, 'robin');
    } finally {
      copy.close();
    }

    const missing = await spawnNode('bin/backup.js', [backups], { env: { DB_PATH: join(dir, 'does-not-exist.db') } });
    assert.equal(missing.code, 0);
    assert.match(missing.stdout, /nothing to back up/);
    assert.equal(existsSync(join(dir, 'does-not-exist.db')), false, 'a backup never creates a database');

    const legacyPath = join(dir, 'legacy.db');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec('CREATE TABLE old_stuff (x); PRAGMA user_version = 0;');
    legacy.close();
    const legacyBackup = await spawnNode('bin/backup.js', [join(dir, 'legacy-backups')], { env: { DB_PATH: legacyPath } });
    assert.equal(legacyBackup.code, 0, legacyBackup.stderr);
    const reopened = new DatabaseSync(legacyPath);
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 0, 'a backup never migrates the database');
    reopened.close();

    const tampered = openDatabase(dbPath);
    tampered.exec("DROP TRIGGER audit_log_no_update; UPDATE audit_log SET action = 'forged'");
    tampered.close();
    const broken = await spawnNode('bin/backup.js', [backups], { env: { DB_PATH: dbPath, BACKUP_KEEP: '5' } });
    assert.equal(broken.code, 2);
    assert.match(broken.stdout, /EVENT LOG BROKEN at entry #1/);
    assert.ok(existsSync(backups));
  });
});
