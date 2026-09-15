// Who may open which page: every admin route checked for every kind of account.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createWorld, startServer } from '../helpers.js';

describe('access control matrix (Rulebook §2.2)', () => {
  let world;
  let server;
  const clients = {};
  before(async () => {
    world = await createWorld();
    server = await startServer(world);
    clients.anon = server.client();
    for (const name of ['org', 'logan', 'boss', 'dealer']) {
      clients[name] = server.client();
      await clients[name].login(name);
    }
  });
  after(() => server.close());

  const LOGIN = 'login';
  const expectations = () => ({
    // path: [anonymous, admin, log admin, superadmin, casino staff]
    '/admin': [LOGIN, 200, 200, 200, 303],
    '/admin/award': [LOGIN, 200, 200, 200, 403],
    [`/admin/award/${world.reasons.style}`]: [LOGIN, 200, 200, 200, 403],
    [`/admin/award/${world.reasons.pool}`]: [LOGIN, 200, 200, 200, 403],
    [`/admin/award/${world.reasons.menetlevel}`]: [LOGIN, 200, 200, 200, 403],
    [`/admin/award/${world.reasons.casino}`]: [LOGIN, 404, 404, 404, 403],
    '/admin/award/999999': [LOGIN, 404, 404, 404, 403],
    '/admin/award/abc': [LOGIN, 404, 404, 404, 403],
    '/admin/entries': [LOGIN, 200, 200, 200, 403],
    '/admin/timers': [LOGIN, 200, 200, 200, 403],
    '/admin/casino': [LOGIN, 403, 403, 200, 200],
    '/admin/standings': [LOGIN, 403, 200, 200, 403],
    '/admin/log': [LOGIN, 403, 200, 200, 403],
    '/admin/suspicion': [LOGIN, 403, 200, 200, 403],
    '/admin/super': [LOGIN, 403, 403, 200, 403],
    '/admin/super?tab=reasons': [LOGIN, 403, 403, 200, 403],
  });

  test('every route answers each role as expected', async () => {
    const roles = ['anon', 'org', 'logan', 'boss', 'dealer'];
    for (const [path, expected] of Object.entries(expectations())) {
      for (const [i, role] of roles.entries()) {
        const res = await clients[role].get(path);
        if (expected[i] === LOGIN) {
          assert.equal(res.status, 303, `${role} ${path}`);
          assert.match(res.location, /^\/admin\/login\?next=/, `${role} ${path}`);
        } else {
          assert.equal(res.status, expected[i], `${role} ${path}`);
        }
      }
    }
  });

  test('every superadmin tab renders', async () => {
    for (const tab of ['settings', 'programs', 'reasons', 'classes', 'users', 'casino', 'snapshots', 'unknown']) {
      const res = await clients.boss.get(`/admin/super?tab=${tab}`);
      assert.equal(res.status, 200, tab);
    }
    assert.equal((await clients.boss.get(`/admin/super?tab=reasons&program=${world.program.id}`)).status, 200);
    assert.equal((await clients.boss.get('/admin/super?tab=reasons&program=999')).status, 200);
  });

  test('switches open and close pages', async () => {
    world.settings.set('features.live_standings', true);
    assert.equal((await clients.org.get('/admin/standings')).status, 200);
    assert.equal((await clients.dealer.get('/admin/standings')).status, 403, 'casino staff still cannot');
    world.settings.set('features.live_standings', false);
    world.settings.set('features.log', false);
    world.settings.set('features.suspicion', false);
    assert.equal((await clients.logan.get('/admin/log')).status, 403);
    assert.equal((await clients.logan.get('/admin/suspicion')).status, 403);
    assert.equal((await clients.boss.get('/admin/log')).status, 200, 'the superadmin is never locked out');
    world.settings.set('features.log', true);
    world.settings.set('features.suspicion', true);
    world.settings.set('casino.enabled', false);
    assert.equal((await clients.dealer.get('/admin/casino')).status, 403);
    world.settings.set('casino.enabled', true);
  });

  test('navigation only offers what the account can use', async () => {
    const nav = async (role) => (await clients[role].get(role === 'dealer' ? '/admin/casino' : '/admin')).text.match(/<nav class="admin-nav"[\s\S]*?<\/nav>/)[0];
    const org = await nav('org');
    assert.match(org, /Pontadás/);
    assert.doesNotMatch(org, /Eseménynapló|Szuperadmin|Kaszinó/);
    const logan = await nav('logan');
    assert.match(logan, /Eseménynapló/);
    assert.match(logan, /Gyanúpontszám/);
    assert.doesNotMatch(logan, /Szuperadmin/);
    const dealer = await nav('dealer');
    assert.match(dealer, /Kaszinó/);
    assert.doesNotMatch(dealer, /Pontadás|Időmérő/);
    assert.match(await nav('boss'), /Szuperadmin/);
  });

  test('write routes refuse the wrong accounts even with a valid token', async () => {
    const attempts = [
      ['org', '/admin/super/change', { target: 'setting:casino.start_chips', op: 'set', value: '1' }, 403],
      ['logan', '/admin/super/classes', { names: '5.Z' }, 403],
      ['org', `/admin/casino/${world.program.id}/visit`, { classId: String(world.classes['9.B']), name: 'X Y' }, 403],
      ['dealer', `/admin/award/${world.reasons.style}`, { classId: String(world.classes['9.B']), name: 'X Y', amount: '5' }, 403],
      ['dealer', '/admin/timers', { reasonId: String(world.reasons.minutes), classId: String(world.classes['9.B']), name: 'X Y' }, 403],
      ['anon', `/admin/award/${world.reasons.style}`, { amount: '5' }, 303],
      ['org', '/admin/super/snapshots', { label: 'x' }, 403],
      ['logan', `/admin/super/casino/${world.program.id}/convert`, {}, 403],
    ];
    for (const [role, path, form, status] of attempts) {
      const res = await clients[role].post(path, form);
      assert.equal(res.status, status, `${role} ${path}`);
    }
    assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM entries').get().n, 0);
    assert.equal(world.db.prepare("SELECT COUNT(*) AS n FROM classes WHERE name = '5.Z'").get().n, 0);
  });
});
