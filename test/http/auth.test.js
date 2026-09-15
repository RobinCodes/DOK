import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createWorld, notice, PASSWORD, startServer } from '../helpers.js';

describe('login and sessions (Rulebook §2.1)', () => {
  let world;
  let server;
  before(async () => {
    world = await createWorld();
    server = await startServer(world);
  });
  after(() => server.close());

  test('successful login sets a hardened session cookie and is logged', async () => {
    const client = server.client();
    const res = await client.login('org');
    assert.equal(res.status, 303);
    assert.equal(res.location, '/admin');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('sid='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=86400/);
    const dashboard = await client.get('/admin');
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.text, /Szia, Tornai Bence!/);
    assert.ok(world.db.prepare("SELECT 1 FROM audit_log WHERE action = 'auth.login' AND actor = 'org'").get());
  });

  test('secure cookies in production mode', async () => {
    const prodServer = await startServer(world, { cookieSecure: true });
    try {
      const res = await prodServer.client().login('org');
      assert.match(res.headers.getSetCookie().find((c) => c.startsWith('sid=')), /; Secure/);
    } finally {
      await prodServer.close();
    }
  });

  test('wrong password and unknown user get the same generic answer', async () => {
    const wrong = await server.client().login('org2', 'not-the-password');
    const unknown = await server.client().login('nobody', PASSWORD);
    for (const res of [wrong, unknown]) {
      assert.equal(res.status, 401);
      assert.equal(notice(res.text, 'error'), 'Hibás felhasználónév vagy jelszó.');
    }
    assert.match(wrong.text, /value="org2"/, 'the typed username is kept');
    assert.ok(world.db.prepare("SELECT 1 FROM audit_log WHERE action = 'auth.failed'").get());
  });

  test('usernames are case-insensitive; passwords are not', async () => {
    assert.equal((await server.client().login('ORG')).status, 303);
    assert.equal((await server.client().login('org', PASSWORD.toUpperCase())).status, 401);
  });

  test('repeated failures lock the username for a while, without locking out the shared Wi-Fi', async () => {
    const lockWorld = await createWorld();
    const lockServer = await startServer(lockWorld);
    try {
      lockWorld.settings.set('auth.max_failures', '3');
      for (let i = 0; i < 3; i++) assert.equal((await lockServer.client().login('org', 'wrong-wrong')).status, 401);
      const locked = await lockServer.client().login('org');
      assert.equal(locked.status, 429, 'even the right password is refused while locked');
      assert.equal(notice(locked.text, 'error'), 'Túl sok sikertelen próbálkozás. Próbáld újra később.');
      assert.equal((await lockServer.client().login('org2')).status, 303, 'another organizer from the same address is fine');
      assert.ok(lockWorld.db.prepare("SELECT 1 FROM audit_log WHERE action = 'auth.blocked'").get());
      lockWorld.clock.advance(16 * 60);
      assert.equal((await lockServer.client().login('org')).status, 303, 'the lock expires');
    } finally {
      await lockServer.close();
    }
  });

  test('an address guessing many usernames gets locked out', async () => {
    const lockWorld = await createWorld();
    const lockServer = await startServer(lockWorld);
    try {
      lockWorld.settings.set('auth.max_failures', '2');
      for (let i = 0; i < 10; i++) await lockServer.client().login(`guess${i}`, 'wrong-wrong');
      assert.equal((await lockServer.client().login('logan')).status, 429);
    } finally {
      await lockServer.close();
    }
  });

  test('deactivated accounts cannot log in, and lose existing sessions at once', async () => {
    const client = server.client();
    await client.login('org2');
    world.db.prepare('UPDATE users SET active = 0 WHERE username = ?').run('org2');
    assert.equal((await client.get('/admin')).status, 303);
    assert.equal((await server.client().login('org2')).status, 401);
    world.db.prepare('UPDATE users SET active = 1 WHERE username = ?').run('org2');
  });

  test('logins can be switched off for everyone but the superadmin', async () => {
    world.settings.set('features.logins', false);
    try {
      const res = await server.client().login('logan');
      assert.equal(res.status, 403);
      assert.equal(notice(res.text, 'error'), 'A bejelentkezés jelenleg ki van kapcsolva.');
      assert.equal((await server.client().login('boss')).status, 303);
    } finally {
      world.settings.set('features.logins', true);
    }
  });

  test('sessions expire after the configured hours', async () => {
    const client = server.client();
    await client.login('logan');
    world.clock.advance(23 * 3600);
    assert.equal((await client.get('/admin')).status, 200);
    world.clock.advance(2 * 3600);
    const res = await client.get('/admin/log');
    assert.equal(res.status, 303);
    assert.equal(res.location, '/admin/login?next=%2Fadmin%2Flog');
  });

  test('after login the user returns to the page they wanted, but never outside the admin area', async () => {
    const client = server.client();
    const page = await client.get('/admin/login?next=%2Fadmin%2Fentries');
    assert.match(page.text, /name="next" value="\/admin\/entries"/);
    const res = await client.post('/admin/login', { username: 'org', password: PASSWORD, next: '/admin/entries' });
    assert.equal(res.location, '/admin/entries');
    for (const next of ['https://evil.example', '//evil.example', '/privacy', '/admin/login']) {
      const other = server.client();
      await other.get('/admin/login');
      assert.equal((await other.post('/admin/login', { username: 'org', password: PASSWORD, next })).location, '/admin', next);
    }
  });

  test('logged-in users visiting the login page go to the dashboard; casino staff land in the casino', async () => {
    const client = server.client();
    await client.login('org');
    assert.equal((await client.get('/admin/login')).location, '/admin');
    const dealer = server.client();
    await dealer.login('dealer');
    assert.equal((await dealer.get('/admin')).location, '/admin/casino');
  });

  test('logout ends the session on the server', async () => {
    const client = server.client();
    await client.login('org');
    const stolen = client.cookies.get('sid');
    const res = await client.post('/admin/logout', {});
    assert.equal(res.location, '/');
    assert.equal(client.cookies.has('sid'), false);
    const replay = await server.client().get('/admin', { headers: { cookie: `sid=${stolen}` } });
    assert.equal(replay.status, 303, 'a copied cookie is worthless after logout');
    assert.equal((await server.client().post('/admin/logout', {})).status, 303, 'logging out twice is harmless');
  });

  test('a role change applies on the next request', async () => {
    const client = server.client();
    await client.login('org');
    assert.equal((await client.get('/admin/log')).status, 403);
    world.db.prepare("UPDATE users SET role = 'logadmin' WHERE username = 'org'").run();
    assert.equal((await client.get('/admin/log')).status, 200);
    world.db.prepare("UPDATE users SET role = 'admin' WHERE username = 'org'").run();
  });
});
