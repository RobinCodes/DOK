// End-to-end journeys through the real forms, as organizers use them on their phones.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createWorld, decode, notice, startServer } from '../helpers.js';

async function session(username, options) {
  const world = options?.world ?? (await createWorld());
  const server = options?.server ?? (await startServer(world));
  const client = server.client(options?.clientOptions);
  await client.login(username);
  return { world, server, client };
}

const nonceOf = (html) => html.match(/name="nonce" value="([^"]+)"/)[1];
const count = (world, sql) => world.db.prepare(sql).get().n;
const flashText = (html) => notice(html, 'ok');

describe('awarding points through the form', () => {
  test('style points: record, see the flash message and the remaining allowance', async () => {
    const { world, server, client } = await session('org');
    try {
      const form = await client.get(`/admin/award/${world.reasons.style}`);
      assert.match(form.text, /Stíluspontjaid: még 90 \/ 90/);
      const res = await client.post(`/admin/award/${world.reasons.style}`, { classId: String(world.classes['9.B']), name: 'Kiss Anna', amount: '10', nonce: nonceOf(form.text) });
      assert.equal(res.status, 303);
      assert.match(res.location, new RegExp(`^/admin/award/${world.reasons.style}\\?ok=saved&n=10$`));
      const after = await client.get(res.location);
      assert.equal(flashText(after.text), 'Rögzítve: 10 pont.');
      assert.match(after.text, /Stíluspontjaid: még 80 \/ 90/);
    } finally {
      await server.close();
    }
  });

  test('a broken rule shows the message and keeps what was typed', async () => {
    const { world, server, client } = await session('org');
    try {
      const res = await client.post(`/admin/award/${world.reasons.style}`, { classId: String(world.classes['9.B']), name: 'Kiss Anna', amount: '95', note: 'megjegyzés' });
      assert.equal(res.status, 400);
      assert.equal(notice(res.text, 'error'), 'A pontszám 1 és 90 között lehet (most: 95).');
      assert.match(res.text, /name="name" value="Kiss Anna"/);
      assert.match(res.text, /name="amount" value="95"/);
      assert.match(res.text, new RegExp(`<option value="${world.classes['9.B']}" selected>`));
      assert.equal(count(world, 'SELECT COUNT(*) AS n FROM entries'), 0);
    } finally {
      await server.close();
    }
  });

  test('soft warnings ask for confirmation; confirming with the same form records once', async () => {
    const { world, server, client } = await session('org');
    try {
      const url = `/admin/award/${world.reasons.style}`;
      await client.post(url, { classId: String(world.classes['9.B']), name: 'Kiss Anna', amount: '5', nonce: '11111111-1111-4111-8111-111111111111' });
      world.clock.advance(600);
      const nonce = '22222222-2222-4222-8222-222222222222';
      const warned = await client.post(url, { classId: String(world.classes['10.A']), name: 'Kiss Anna', amount: '5', nonce });
      assert.equal(warned.status, 200);
      assert.match(decode(warned.text), /Kiss Anna már szerepel a\(z\) 9\.B osztályban/);
      assert.match(warned.text, /name="confirmed" value="1" required/);
      assert.equal(nonceOf(warned.text), nonce, 'the same form keeps its idempotency key');
      const confirmed = await client.post(url, { classId: String(world.classes['10.A']), name: 'Kiss Anna', amount: '5', nonce, confirmed: '1' });
      assert.equal(confirmed.status, 303);
      const replay = await client.post(url, { classId: String(world.classes['10.A']), name: 'Kiss Anna', amount: '5', nonce, confirmed: '1' });
      assert.match(replay.location, /ok=replayed/);
      assert.equal(count(world, 'SELECT COUNT(*) AS n FROM entries'), 2);
    } finally {
      await server.close();
    }
  });

  test('formula and pool forms', async () => {
    const { world, server, client } = await session('org');
    try {
      const sheet = await client.get(`/admin/award/${world.reasons.menetlevel}`);
      assert.match(sheet.text, /name="inputs\[stamps\]"/);
      assert.match(sheet.text, /name="inputs\[people\]"/);
      const saved = await client.post(`/admin/award/${world.reasons.menetlevel}`, { classId: String(world.classes['10.A']), 'inputs[stamps]': '40', 'inputs[people]': '10' });
      assert.match(saved.location, /n=220$/);

      const rows = {
        'rows[0][name]': 'Első Előadó',
        'rows[0][classId]': String(world.classes['9.B']),
        'rows[0][amount]': '8',
        'rows[1][name]': 'Második Előadó',
        'rows[1][classId]': String(world.classes['10.A']),
        'rows[1][amount]': '9',
        'rows[2][name]': 'Harmadik Előadó',
        'rows[2][classId]': String(world.classes['11.A']),
        'rows[2][amount]': '13',
      };
      assert.match((await client.post(`/admin/award/${world.reasons.pool}`, rows)).location, /n=30$/);
      const tooMuch = await client.post(`/admin/award/${world.reasons.pool}`, { ...rows, 'rows[2][amount]': '14' });
      assert.equal(notice(tooMuch.text, 'error'), 'A kiosztott 31 pont több a 30 pontos keretnél.');
    } finally {
      await server.close();
    }
  });

  test('when typed minutes are switched off the form points to the timer instead', async () => {
    const { world, server, client } = await session('org');
    try {
      world.settings.set('features.manual_minutes', false);
      const form = await client.get(`/admin/award/${world.reasons.minutes}`);
      assert.match(form.text, /A percek kézi beírása ki van kapcsolva/);
      assert.doesNotMatch(form.text, /type="submit">Rögzítés/);
      const res = await client.post(`/admin/award/${world.reasons.minutes}`, { classId: String(world.classes['9.B']), name: 'X Y', 'inputs[minutes]': '30' });
      assert.equal(res.status, 403);
    } finally {
      await server.close();
    }
  });

  test('closed programs: the form says so and refuses', async () => {
    const { world, server, client } = await session('org');
    try {
      world.db.prepare("UPDATE programs SET status = 'closed' WHERE id = ?").run(world.program.id);
      assert.equal(notice((await client.get(`/admin/award/${world.reasons.style}`)).text, 'error'), 'Ez a program most nincs nyitva, ezért nem lehet rá rögzíteni.');
      assert.doesNotMatch((await client.get('/admin/award')).text, /Stíluspont – ivóverseny/);
    } finally {
      await server.close();
    }
  });
});

describe('own entries: storno and correction', () => {
  test('void with a reason, then correct another entry', async () => {
    const { world, server, client } = await session('org');
    try {
      const url = `/admin/award/${world.reasons.style}`;
      await client.post(url, { classId: String(world.classes['9.B']), name: 'Első Emese', amount: '10' });
      world.clock.advance(300);
      await client.post(url, { classId: String(world.classes['9.B']), name: 'Második Márk', amount: '20' });
      const [second, first] = world.db.prepare('SELECT id FROM entries ORDER BY id DESC').all().map((r) => r.id);

      const list = await client.get('/admin/entries');
      assert.match(list.text, /Első Emese/);
      assert.match(list.text, new RegExp(`action="/admin/entries/${first}/void"`));

      const voided = await client.post(`/admin/entries/${first}/void`, { reason: 'rossz osztály', back: '/admin/entries' });
      assert.equal(voided.location, '/admin/entries?ok=voided');
      assert.match((await client.get('/admin/entries')).text, /sztornó oka: rossz osztály/);

      const form = await client.get(`/admin/award/${world.reasons.style}?corrects=${second}`);
      assert.match(decode(form.text), new RegExp(`A\\(z\\) #${second} bejegyzést javítod`));
      assert.match(form.text, /name="amount" value="20"/);
      const corrected = await client.post(`/admin/award/${world.reasons.style}?corrects=${second}`, { classId: String(world.classes['10.A']), name: 'Második Márk', amount: '25', correctionReason: 'elírás', confirmed: '1' });
      assert.equal(corrected.location, '/admin/entries?ok=corrected');
      assert.ok(world.db.prepare('SELECT voided_at FROM entries WHERE id = ?').get(second).voided_at);
      assert.equal(world.db.prepare('SELECT corrects_id FROM entries ORDER BY id DESC LIMIT 1').get().corrects_id, second);
    } finally {
      await server.close();
    }
  });

  test('other organizers’ entries cannot be opened for correction or voided', async () => {
    const world = await createWorld();
    const server = await startServer(world);
    try {
      const { client: author } = await session('org', { world, server });
      await author.post(`/admin/award/${world.reasons.style}`, { classId: String(world.classes['9.B']), name: 'Kiss Anna', amount: '10' });
      const id = world.db.prepare('SELECT id FROM entries').get().id;
      const { client: other } = await session('org2', { world, server });
      assert.equal((await other.get(`/admin/award/${world.reasons.style}?corrects=${id}`)).status, 403);
      assert.equal((await other.post(`/admin/entries/${id}/void`, { reason: 'x' })).status, 403);
      assert.equal((await other.get(`/admin/award/${world.reasons.menetlevel}?corrects=${id}`)).status, 404, 'reason mismatch');
      const { client: logan } = await session('logan', { world, server });
      assert.match((await logan.get('/admin/entries?all=1')).text, /Kiss Anna/);
      assert.doesNotMatch((await other.get('/admin/entries?all=1')).text, /Kiss Anna/, 'normal admins only ever see their own');
    } finally {
      await server.close();
    }
  });
});

describe('timers through the web', () => {
  test('start, watch, stop and cancel', async () => {
    const { world, server, client } = await session('org');
    try {
      const page = await client.get('/admin/timers');
      assert.match(page.text, /Részvétel – csocsó/);
      const started = await client.post('/admin/timers', { reasonId: String(world.reasons.minutes), classId: String(world.classes['9.B']), name: 'Nagy Péter' });
      assert.equal(started.location, '/admin/timers?ok=timerStarted');
      const timer = world.db.prepare('SELECT * FROM timers').get();
      assert.match((await client.get('/admin/timers')).text, new RegExp(`data-since="${timer.started_at}"`));
      const again = await client.post('/admin/timers', { reasonId: String(world.reasons.minutes), classId: String(world.classes['9.B']), name: 'Nagy Péter' });
      assert.equal(notice(again.text, 'error'), 'Nagy Péter időmérője már fut.');
      world.clock.advance(25 * 60);
      const stopped = await client.post(`/admin/timers/${timer.id}/stop`, {});
      assert.equal(stopped.location, '/admin/timers?ok=timerStopped&n=25');
      assert.equal(flashText((await client.get(stopped.location)).text), 'Az időmérő leállt: 25 perc rögzítve.');

      await client.post('/admin/timers', { reasonId: String(world.reasons.minutes), classId: String(world.classes['9.B']), name: 'Rövid Réka' });
      const short = world.db.prepare('SELECT id FROM timers ORDER BY id DESC').get().id;
      const tooShort = await client.post(`/admin/timers/${short}/stop`, {});
      assert.equal(notice(tooShort.text, 'error'), 'Még egy perc sem telt el. Ha tévedés volt, töröld az időmérőt.');
      assert.equal((await client.post(`/admin/timers/${short}/cancel`, {})).location, '/admin/timers?ok=timerCancelled');
    } finally {
      await server.close();
    }
  });

  test('an organizer can switch the timer off for themselves', async () => {
    const { world, server, client } = await session('org');
    try {
      assert.match((await client.get('/admin')).text, /Időmérő használata: Be/);
      assert.equal((await client.post('/admin/account/timer', {})).location, '/admin?ok=preferenceSaved');
      assert.equal(world.user('org').use_timer, 0);
      assert.match((await client.get('/admin/timers')).text, /Az időmérő ki van kapcsolva/);
      world.settings.set('features.timer', false);
      assert.equal((await client.post('/admin/account/timer', {})).status, 403);
    } finally {
      await server.close();
    }
  });
});

describe('casino through the web', () => {
  test('light mode: the staff member records what the player hands in', async () => {
    const { world, server, client } = await session('dealer');
    try {
      world.settings.set('casino.record_visits', false);
      const page = await client.get('/admin/casino');
      assert.match(page.text, /Egyszerű mód/);
      const url = `/admin/casino/${world.program.id}/cashout`;
      const bad = await client.post(url, { classId: String(world.classes['9.B']), name: 'Szerencsés Szilvi', chips: 'sok' });
      assert.equal(bad.status, 400);
      assert.equal(notice(bad.text, 'error'), 'Egész számot írj.');
      assert.match(bad.text, /name="name" value="Szerencsés Szilvi"/);
      const ok = await client.post(url, { classId: String(world.classes['9.B']), name: 'Szerencsés Szilvi', chips: '240' });
      assert.equal(ok.location, `/admin/casino?program=${world.program.id}&ok=casino_cashout`);
      assert.match((await client.get(ok.location)).text, /Szerencsés Szilvi \(9\.B\) kifizetés: 240 zseton/);
    } finally {
      await server.close();
    }
  });

  test('detailed mode: entry, games, balance-checked cash-out and storno', async () => {
    const { world, server, client } = await session('dealer');
    try {
      world.settings.set('casino.record_games', true);
      const base = `/admin/casino/${world.program.id}`;
      await client.post(`${base}/visit`, { classId: String(world.classes['9.B']), name: 'Aladár Adorján' });
      await client.post(`${base}/visit`, { classId: String(world.classes['10.A']), name: 'Bori Bernadett' });
      const [a, b] = world.db.prepare('SELECT id FROM casino_visits ORDER BY id').all().map((v) => v.id);
      const pvp = world.db.prepare("SELECT id FROM casino_games WHERE kind = 'pvp' LIMIT 1").get().id;
      const unbalanced = await client.post(`${base}/round`, { gameId: String(pvp), 'results[0][visitId]': String(a), 'results[0][delta]': '30', 'results[1][visitId]': String(b), 'results[1][delta]': '-20' });
      assert.equal(notice(unbalanced.text, 'error'), 'Játékosok közötti játékban a nyereségek és veszteségek összege 0 kell legyen.');
      await client.post(`${base}/round`, { gameId: String(pvp), 'results[0][visitId]': String(a), 'results[0][delta]': '30', 'results[1][visitId]': String(b), 'results[1][delta]': '-30' });
      const page = await client.get('/admin/casino');
      assert.match(page.text, /Egyenleg: 130/);
      assert.match(page.text, /name="chips"[^>]*value="130"/, 'the expected balance is prefilled');
      const wrong = await client.post(`${base}/cashout`, { visitId: String(a), chips: '150' });
      assert.equal(notice(wrong.text, 'error'), 'A kifizetésnek meg kell egyeznie a nyilvántartott egyenleggel: 130 zseton.');
      assert.equal((await client.post(`${base}/cashout`, { visitId: String(a), chips: '130' })).status, 303);
      const cashoutId = world.db.prepare('SELECT id FROM casino_cashouts').get().id;
      assert.equal((await client.post(`/admin/casino/void/cashout/${cashoutId}`, { reason: 'elírás' })).location, '/admin/casino?ok=voided');
      assert.equal((await client.post('/admin/casino/void/everything/1', { reason: 'x' })).status, 404);
    } finally {
      await server.close();
    }
  });
});

describe('superadmin through the web', () => {
  test('set, change by ±n and toggle, returning to the same control', async () => {
    const { world, server, client } = await session('boss');
    try {
      const page = await client.get('/admin/super?tab=settings');
      assert.match(page.text, /id="setting-casino-start-chips"/);
      const back = '/admin/super?tab=settings#setting-casino-start-chips';
      const set = await client.post('/admin/super/change', { target: 'setting:casino.start_chips', op: 'set', value: '150', back });
      assert.equal(set.location, '/admin/super?tab=settings&ok=changed#setting-casino-start-chips');
      await client.post('/admin/super/change', { target: 'setting:casino.start_chips', op: 'adjust', value: '-25', back });
      assert.equal(world.settings.get('casino.start_chips'), 125);
      await client.post('/admin/super/change', { target: 'setting:features.timer', op: 'toggle', back });
      assert.equal(world.settings.get('features.timer'), false);
      const invalid = await client.post('/admin/super/change', { target: 'setting:casino.start_chips', op: 'set', value: '-1', back });
      assert.equal(invalid.status, 400);
      assert.equal(notice(invalid.text, 'error'), 'Az érték 0 és 1000000 között lehet.');
      const offsite = await client.post('/admin/super/change', { target: 'setting:casino.start_chips', op: 'set', value: '1', back: 'https://evil.example' });
      assert.equal(offsite.location, '/admin/super?ok=changed');
    } finally {
      await server.close();
    }
  });

  test('classes, programs, reasons, parameters and games can all be created and edited', async () => {
    const { world, server, client } = await session('boss');
    try {
      await client.post('/admin/super/classes', { names: '12.A\n12.B' });
      const classes = await client.get('/admin/super?tab=classes');
      assert.match(classes.text, /12\.A · 0 pont/);
      const classId = world.db.prepare("SELECT id FROM classes WHERE name = '12.A'").get().id;
      await client.post('/admin/super/change', { target: `class_points:${classId}`, op: 'set', value: '75', back: '/admin/super?tab=classes' });
      assert.match((await client.get('/admin/super?tab=classes')).text, /12\.A · 75 pont/);

      assert.equal((await client.post('/admin/super/programs', { nameHu: 'Farsang', nameEn: 'Carnival' })).location, '/admin/super?tab=programs&ok=created');
      const program = world.db.prepare("SELECT id FROM programs WHERE slug = 'farsang'").get().id;
      assert.equal((await client.post('/admin/super/reasons', { programId: String(program), nameHu: 'Jelmez', nameEn: 'Costume', kind: 'formula' })).location, `/admin/super?tab=reasons&program=${program}&ok=created`);
      const reason = world.db.prepare('SELECT id FROM reasons WHERE program_id = ?').get(program).id;
      const back = `/admin/super?tab=reasons&program=${program}`;
      await client.post('/admin/super/params', { reasonId: String(reason), name: 'per_costume', value: '3', back });
      const formula = await client.post('/admin/super/change', { target: `reason:${reason}:formula`, op: 'set', value: 'costumes * per_costume', back });
      assert.equal(formula.status, 303);
      const unknown = await client.post('/admin/super/change', { target: `reason:${reason}:formula`, op: 'set', value: 'costumes *', back });
      assert.match(notice(unknown.text, 'error'), /^Hibás képlet/);
      const tab = await client.get(back);
      assert.match(tab.text, /A szervező által beírt értékek: costumes/);
      await client.post('/admin/super/params/remove', { reasonId: String(reason), name: 'per_costume', back });
      assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM reason_params WHERE reason_id = ?').get(reason).n, 0);
      await client.post('/admin/super/games', { nameHu: 'Craps', nameEn: '', kind: 'house' });
      assert.match((await client.get('/admin/super?tab=casino')).text, /Craps/);
      const bad = await client.post('/admin/super/params', { reasonId: String(reason), name: 'Bad Name', value: '1', back });
      assert.equal(bad.status, 400);
    } finally {
      await server.close();
    }
  });

  test('publish standings, count chips and convert the casino', async () => {
    const world = await createWorld();
    const server = await startServer(world);
    try {
      const { client: dealer } = await session('dealer', { world, server });
      world.settings.set('casino.record_visits', false);
      await dealer.post(`/admin/casino/${world.program.id}/cashout`, { classId: String(world.classes['9.B']), name: 'Nyerő Nóra', chips: '250' });
      const { client: boss } = await session('boss', { world, server });
      const casinoTab = await boss.get('/admin/super?tab=casino');
      assert.match(casinoTab.text, /1 kifizetés átváltása pontokra/);
      await boss.post(`/admin/super/casino/${world.program.id}/count`, { staffId: String(world.users.dealer.id), chips: '200' });
      assert.match((await boss.get('/admin/super?tab=casino')).text, /<tr class="bad"><td>dealer<\/td><td>250<\/td><td>200<\/td><td>-50<\/td><\/tr>/);
      assert.equal((await boss.post(`/admin/super/casino/${world.program.id}/convert`, {})).location, `/admin/super?tab=casino&ok=converted#casino-${world.program.id}`);
      assert.equal(world.db.prepare("SELECT amount FROM entries WHERE source = 'casino'").get().amount, 25);
      assert.equal((await boss.post(`/admin/super/casino/${world.program.id}/convert`, {})).status, 400, 'nothing left to convert');

      const published = await boss.post('/admin/super/snapshots', { label: 'Nyitóbuli után' });
      assert.equal(published.location, '/admin/super?tab=snapshots&ok=published');
      assert.match((await server.client().get('/')).text, /Nyitóbuli után/);
      assert.match((await boss.get('/admin/standings')).text, /Közzététel most/);
    } finally {
      await server.close();
    }
  });
});

describe('review pages', () => {
  test('event log with chain status, filters and paging', async () => {
    const { world, server, client } = await session('logan');
    try {
      for (let i = 0; i < 120; i++) world.db.prepare("INSERT INTO classes (name) VALUES (?)").run(`C${i}`);
      const { audit, CONSOLE } = await import('../../src/domain/audit.js');
      for (let i = 0; i < 110; i++) audit(world.db, { actor: CONSOLE, action: 'test.bulk', subject: `n:${i}`, at: world.clock.now() });
      const page = await client.get('/admin/log');
      assert.match(page.text, /A napló sértetlen \(\d+ bejegyzés/);
      const older = page.text.match(/href="(\/admin\/log\?[^"]*before=\d+)"/);
      assert.ok(older, 'paging link');
      assert.equal((await client.get(decode(older[1]))).status, 200);
      const filtered = await client.get('/admin/log?action=auth.login');
      const records = filtered.text.match(/<ul class="records log">[\s\S]*?<\/ul>/)[0];
      assert.match(records, /auth\.login/);
      assert.doesNotMatch(records, /test\.bulk/, 'only matching records are listed (the filter menu still offers every action)');
      assert.equal((await client.get('/admin/log?before=abc')).status, 404);
    } finally {
      await server.close();
    }
  });

  test('suspicion report, per program or overall', async () => {
    const { world, server, client } = await session('logan');
    try {
      const { adjustClassPoints } = await import('../../src/domain/awards.js');
      adjustClassPoints(world.db, { actor: world.users.boss, classId: world.classes['9.B'], delta: 1_000_000, now: world.clock.now() });
      // The only entry in the whole competition: there are no peers to compare with.
      const overall = await client.get('/admin/suspicion');
      assert.match(overall.text, /<div class="score"[^>]*>100<\/div>/);
      assert.match(decode(overall.text), /1000000 pont: több mint tízszerese annak, amit bármelyik indoklás egy bejegyzésre enged/);
      const nyitobuli = await client.get(`/admin/suspicion?program=${world.program.id}`);
      assert.doesNotMatch(nyitobuli.text, /1000000 pont/, 'adjustments belong to no program');
      assert.equal((await client.get('/admin/suspicion?program=x')).status, 404);
    } finally {
      await server.close();
    }
  });

  test('the admin panel speaks English to English browsers', async () => {
    const { server, client } = await session('org', { clientOptions: { language: 'en-GB,en;q=0.9' } });
    try {
      const page = await client.get('/admin');
      assert.match(page.text, /Hi, Tornai Bence!/);
      assert.match(page.text, /Your style points to hand out/);
    } finally {
      await server.close();
    }
  });
});
