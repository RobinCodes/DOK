import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createAward } from '../../src/domain/awards.js';
import { publishSnapshot } from '../../src/domain/standings.js';
import { createWorld, notice, startServer } from '../helpers.js';

describe('HTTP basics and security', () => {
  let world;
  let server;
  before(async () => {
    world = await createWorld();
    server = await startServer(world);
  });
  after(() => server.close());

  test('every response carries the security headers', async () => {
    for (const path of ['/', '/admin/login', '/nope', '/static/style.css']) {
      const res = await server.client().get(path);
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'/, path);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    }
  });

  test('the homepage shows the event in Hungarian for Hungarian browsers and in English for others', async () => {
    const hu = await server.client().get('/');
    assert.equal(hu.status, 200);
    assert.match(hu.text, /<html lang="hu"/);
    assert.match(hu.text, /Éves jubileumi pontverseny/);
    assert.match(hu.text, /2026\. szeptember 18\./);
    assert.match(hu.text, /7–11\. évfolyam/);
    assert.match(hu.text, /Arany cikesz/);
    const en = await server.client({ language: 'de-DE,de;q=0.9' }).get('/');
    assert.match(en.text, /<html lang="en"/);
    assert.match(en.text, /Jubilee points competition/);
    assert.match(en.text, /Golden Snitch/);
  });

  test('language and theme choices are remembered in cookies, and only local redirects are allowed', async () => {
    const client = server.client();
    const res = await client.get('/lang/en?back=%2Fprivacy');
    assert.equal(res.status, 303);
    assert.equal(res.location, '/privacy');
    assert.match((await client.get('/')).text, /<html lang="en"/);
    for (const evil of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      assert.equal((await client.get(`/lang/hu?back=${encodeURIComponent(evil)}`)).location, '/');
    }
    await client.get('/theme/dark');
    assert.match((await client.get('/')).text, /<html lang="hu" data-theme="dark">/);
    assert.equal((await client.get('/theme/purple')).status, 404);
    assert.equal((await client.get('/lang/de')).status, 404);
  });

  test('a forged theme cookie cannot inject markup', async () => {
    const res = await server.client().get('/', { headers: { cookie: 'theme="><script>alert(1)</script>' } });
    assert.doesNotMatch(res.text, /<script>alert/);
    assert.match(res.text, /<html lang="hu">/);
  });

  test('static files, robots.txt and the health check', async () => {
    const css = await server.client().get('/static/style.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.equal((await server.client().get('/static/app.js')).status, 200);
    assert.equal((await server.client().get('/static/favicon.svg')).status, 200);
    for (const bad of ['/static/..%2Fsrc%2Fapp.js', '/static/nope.css', '/static/', '/static/%2e%2e%2fpackage.json']) {
      assert.equal((await server.client().get(bad)).status, 404, bad);
    }
    // Pages link static files with a content hash, so browsers never keep a stale copy after a deploy.
    const page = (await server.client().get('/')).text;
    const cssUrl = page.match(/href="(\/static\/style\.css\?v=[0-9a-f]{10})"/)[1];
    assert.match(page, /src="\/static\/app\.js\?v=[0-9a-f]{10}"/);
    const versioned = await server.client().get(cssUrl);
    assert.equal(versioned.status, 200);
    assert.equal(versioned.text, css.text);
    const { createHash } = await import('node:crypto');
    assert.equal(cssUrl.split('v=')[1], createHash('sha256').update(css.text).digest('hex').slice(0, 10));
    assert.match((await server.client().get('/robots.txt')).text, /Disallow: \/admin/);
    const health = await server.client().get('/healthz');
    assert.deepEqual([health.status, health.text], [200, 'ok']);
  });

  test('unknown paths, wrong methods and HEAD', async () => {
    const missing = await server.client().get('/does/not/exist');
    assert.equal(missing.status, 404);
    assert.match(missing.text, /nem található/);
    assert.equal((await server.client().post('/', { a: '1' })).status, 405);
    const head = await fetch(`${server.base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
  });

  test('POST requests must come from this site (CSRF layer 1)', async () => {
    const client = server.client();
    for (const origin of [null, 'https://evil.example', 'null']) {
      const res = await client.post('/admin/login', { username: 'org', password: 'x' }, { origin });
      assert.equal(res.status, 403, String(origin));
    }
    const viaReferer = await client.post('/admin/login', { username: 'org', password: 'wrong-password' }, { origin: null, headers: { referer: `${server.base}/admin/login` } });
    assert.equal(viaReferer.status, 401, 'a same-site Referer is enough when Origin is missing');
  });

  test('logged-in POSTs need the session token (CSRF layer 2)', async () => {
    const client = server.client();
    await client.login('boss');
    const body = (csrf) => new URLSearchParams({ csrf, names: '12.X' });
    for (const token of ['', 'wrong-token', `${client.csrf}x`]) {
      const res = await client.post('/admin/super/classes', body(token));
      assert.equal(res.status, 403, token);
      assert.match(res.text, /nem erről az oldalról/);
    }
    assert.equal((await client.post('/admin/super/classes', body(client.csrf))).status, 303);
  });

  test('bodies must be url-encoded forms of reasonable size', async () => {
    const client = server.client();
    const json = await client.post('/admin/login', null, { headers: { 'content-type': 'application/json' } });
    assert.equal(json.status, 415);
    const huge = await fetch(`${server.base}/admin/login`, {
      method: 'POST',
      headers: { origin: server.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: `username=${'x'.repeat(70_000)}`,
    });
    assert.equal(huge.status, 413);
  });

  test('user-supplied text is always escaped on output', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const snitch = world.db.prepare("SELECT r.id, r.program_id FROM reasons r JOIN programs p ON p.id = r.program_id WHERE p.slug = 'nyitobuli' AND r.kind = 'style'").get();
    createAward(world.db, world.settings, {
      actor: world.users.org,
      reasonId: snitch.id,
      input: { classId: world.classes['9.B'], name: `Hacker ${payload}`, amount: '5', note: payload },
      now: world.clock.now(),
    });
    world.db.prepare('UPDATE programs SET description_hu = ? WHERE id = ?').run(payload, snitch.program_id);
    const client = server.client();
    await client.login('org');
    for (const page of [(await client.get('/admin/entries')).text, (await server.client().get('/')).text]) {
      assert.doesNotMatch(page, /<img src=x/);
      assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
    }
  });

  test('the public top list shows only the published snapshot, with names never exposed', async () => {
    const localWorld = await createWorld();
    const localServer = await startServer(localWorld);
    try {
      assert.doesNotMatch((await localServer.client().get('/')).text, /class="standings"/, 'nothing published yet');
      createAward(localWorld.db, localWorld.settings, { actor: localWorld.users.org, reasonId: localWorld.reasons.style, input: { classId: localWorld.classes['10.A'], name: 'Titkos Tamás', amount: '30' }, now: localWorld.clock.now() });
      publishSnapshot(localWorld.db, { actor: localWorld.users.boss, label: 'Nyitóbuli után', now: localWorld.clock.now() });
      createAward(localWorld.db, localWorld.settings, { actor: localWorld.users.org2, reasonId: localWorld.reasons.style, input: { classId: localWorld.classes['7.A'], name: 'Későn Kata', amount: '50' }, now: localWorld.clock.now() });
      const page = (await localServer.client().get('/')).text;
      assert.match(page, /Nyitóbuli után/);
      assert.match(page, /<span class="class-name">10\.A<\/span>\s*<span class="points">30 pont<\/span>/);
      assert.doesNotMatch(page, /50 pont/, 'points after publishing stay hidden');
      assert.doesNotMatch(page, /Titkos Tamás/);
      localWorld.settings.set('site.show_standings', false);
      assert.doesNotMatch((await localServer.client().get('/')).text, /Nyitóbuli után/);
      localWorld.settings.set('site.show_programs', false);
      assert.doesNotMatch((await localServer.client().get('/')).text, /Pontszerzési lehetőségek/);
      localWorld.settings.set('site.show_privacy', false);
      assert.equal((await localServer.client().get('/privacy')).status, 404);
    } finally {
      await localServer.close();
    }
  });

  test('unexpected errors are reported without leaking internals', async () => {
    const brokenWorld = await createWorld();
    const brokenServer = await startServer(brokenWorld);
    const originalError = console.error;
    console.error = () => {};
    try {
      brokenWorld.db.prepare("INSERT INTO snapshots (label, created_by, created_at) VALUES ('x', ?, 'x')").run(brokenWorld.users.boss.id);
      brokenWorld.db.exec('DROP TABLE snapshot_rows');
      const res = await brokenServer.client().get('/');
      assert.equal(res.status, 500);
      assert.match(res.text, /Váratlan hiba/);
      assert.doesNotMatch(res.text, /snapshot_rows|SQLITE|at .*\.js/);
    } finally {
      console.error = originalError;
      await brokenServer.close();
    }
  });

  test('notice helper finds messages', () => {
    assert.equal(notice('<p class="notice error" role="alert">A &amp; B</p>', 'error'), 'A & B');
    assert.equal(notice('<p>none</p>', 'error'), null);
  });
});
