import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../../src/auth/passwords.js';
import { canAwardPoints, featureOn, hasRole, isCasinoStaff, isSuperadmin } from '../../src/auth/roles.js';
import { createSession, destroySession, destroyUserSessions, findSession } from '../../src/auth/sessions.js';
import { createThrottle } from '../../src/auth/throttle.js';
import { openDatabase } from '../../src/db/database.js';

describe('passwords', () => {
  test('hash format and verification', async () => {
    const hash = await hashPassword('jó jelszó 123', 1024);
    assert.match(hash, /^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(await verifyPassword('jó jelszó 123', hash), true);
    assert.equal(await verifyPassword('jó jelszó 124', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  test('the same password gets a different salt every time', async () => {
    assert.notEqual(await hashPassword('same-password', 1024), await hashPassword('same-password', 1024));
  });

  test('Unicode normalization: composed and decomposed accents match', async () => {
    const hash = await hashPassword('árvíztűrő', 1024);
    assert.equal(await verifyPassword('árvíztűrő', hash), true);
  });

  test('malformed or corrupted hashes never verify', async () => {
    const good = await hashPassword('secret-secret', 1024);
    const parts = good.split('$');
    const corrupted = [
      '',
      'plain',
      'bcrypt$10$abc',
      'scrypt$1024$8$1$c2FsdA==$',
      'scrypt$1024$8$1$c2FsdA==$!!!',
      `scrypt$abc$8$1$${parts[4]}$${parts[5]}`,
      `scrypt$1023$8$1$${parts[4]}$${parts[5]}`,
      `scrypt$1024$8$1$${parts[4]}$${Buffer.from('short').toString('base64')}`,
      null,
    ];
    for (const stored of corrupted) assert.equal(await verifyPassword('secret-secret', stored), false, String(stored));
  });

  test('dummy verification always fails', async () => {
    assert.equal(await verifyAgainstDummy('anything'), false);
  });
});

describe('sessions', () => {
  function setup() {
    const db = openDatabase(':memory:');
    const id = db
      .prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'A', 'x', 'admin', '2026-01-01')")
      .run().lastInsertRowid;
    return { db, id };
  }

  test('create, find, expire and destroy', () => {
    const { db, id } = setup();
    const now = Date.parse('2026-09-18T12:00:00Z');
    const { token, maxAge } = createSession(db, id, { hours: 2, now });
    assert.equal(maxAge, 7200);
    assert.equal(findSession(db, token, now + 1000).user.id, id);
    assert.equal(findSession(db, token, now + 2 * 3600_000), null, 'expired exactly at the limit');
    destroySession(db, token);
    assert.equal(findSession(db, token, now), null);
  });

  test('only a hash of the token is stored', () => {
    const { db, id } = setup();
    const { token } = createSession(db, id, { hours: 1, now: 0 });
    const row = db.prepare('SELECT token_hash FROM sessions').get();
    assert.notEqual(row.token_hash, token);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  });

  test('unknown, empty and oversized tokens find nothing', () => {
    const { db } = setup();
    for (const token of [undefined, '', 'nope', 'x'.repeat(500)]) assert.equal(findSession(db, token, 0), null);
  });

  test('deactivated users lose their sessions immediately', () => {
    const { db, id } = setup();
    const { token } = createSession(db, id, { hours: 1, now: 0 });
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
    assert.equal(findSession(db, token, 1), null);
  });

  test('destroyUserSessions logs out every device and expired sessions get pruned', () => {
    const { db, id } = setup();
    createSession(db, id, { hours: 1, now: 0 });
    createSession(db, id, { hours: 1, now: 0 });
    destroyUserSessions(db, id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    createSession(db, id, { hours: 1, now: 0 });
    createSession(db, id, { hours: 1, now: 10 * 3600_000 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  });
});

describe('login throttle', () => {
  const window = { windowMs: 60_000 };
  const limits = (user, ip) => [
    { key: `user:${user}`, max: 3 },
    { key: `ip:${ip}`, max: 15 },
  ];

  test('blocks a username after its maximum, until the window ends', () => {
    const throttle = createThrottle();
    for (let i = 0; i < 3; i++) {
      assert.equal(throttle.isBlocked(limits('a', 1), 1000), false);
      throttle.recordFailure(['user:a', 'ip:1'], { ...window, now: 1000 });
    }
    assert.equal(throttle.isBlocked(limits('a', 1), 2000), true);
    assert.equal(throttle.isBlocked(limits('a', 2), 2000), true, 'same user from another address');
    assert.equal(throttle.isBlocked(limits('b', 1), 2000), false, 'others on the same shared Wi-Fi can still log in');
    assert.equal(throttle.isBlocked(limits('a', 1), 61_001), false, 'window over');
  });

  test('an address is blocked only after many failures across usernames', () => {
    const throttle = createThrottle();
    for (let i = 0; i < 15; i++) throttle.recordFailure([`user:u${i}`, 'ip:9'], { ...window, now: 0 });
    assert.equal(throttle.isBlocked(limits('fresh', 9), 1), true);
    assert.equal(throttle.isBlocked(limits('fresh', 10), 1), false);
  });

  test('reset clears a key', () => {
    const throttle = createThrottle();
    for (let i = 0; i < 3; i++) throttle.recordFailure(['user:a'], { ...window, now: 0 });
    throttle.reset('user:a');
    assert.equal(throttle.isBlocked(limits('a', 1), 1), false);
  });

  test('memory is pruned when many keys pile up', () => {
    const throttle = createThrottle();
    for (let i = 0; i < 10_050; i++) throttle.recordFailure([`ip:${i}`], { ...window, now: 0 });
    throttle.recordFailure(['ip:new'], { ...window, now: 120_000 });
    assert.equal(throttle.isBlocked([{ key: 'ip:5', max: 1 }], 120_001), false);
  });
});

describe('roles', () => {
  const admin = { role: 'admin', is_casino: 0 };
  const logadmin = { role: 'logadmin', is_casino: 0 };
  const superadmin = { role: 'superadmin', is_casino: 1 };
  const casino = { role: 'admin', is_casino: 1 };

  test('roles are nested', () => {
    assert.equal(hasRole(admin, 'admin'), true);
    assert.equal(hasRole(admin, 'logadmin'), false);
    assert.equal(hasRole(logadmin, 'admin'), true);
    assert.equal(hasRole(logadmin, 'superadmin'), false);
    assert.equal(hasRole(superadmin, 'logadmin'), true);
    assert.equal(hasRole(null, 'admin'), false);
    assert.equal(hasRole({ role: 'hacker' }, 'admin'), false);
  });

  test('casino staff never award points, the superadmin always can', () => {
    assert.equal(canAwardPoints(admin), true);
    assert.equal(canAwardPoints(casino), false);
    assert.equal(canAwardPoints(superadmin), true);
    assert.equal(canAwardPoints(null), false);
    assert.equal(isCasinoStaff(casino), true);
    assert.equal(isSuperadmin(superadmin), true);
  });

  test('feature switches bind everyone except the superadmin', () => {
    const settings = { get: () => false };
    assert.equal(featureOn(settings, admin, 'features.points'), false);
    assert.equal(featureOn(settings, superadmin, 'features.points'), true);
    assert.equal(featureOn({ get: () => true }, admin, 'features.points'), true);
  });
});
