// Rendering of the less common page states.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { recordCashout, recordRound, recordVisit } from '../../src/domain/casino.js';
import { publishSnapshot } from '../../src/domain/standings.js';
import { createWorld, decode, startServer } from '../helpers.js';

async function withServer(fn) {
  const world = await createWorld();
  const server = await startServer(world);
  try {
    await fn(world, server);
  } finally {
    await server.close();
  }
}

describe('page states', () => {
  test('privacy notice in both languages', () =>
    withServer(async (world, server) => {
      const hu = await server.client().get('/privacy');
      assert.equal(hu.status, 200);
      for (const heading of ['Ki kezeli az adatokat?', 'Milyen adatokat tárolunk?', 'Ki látja?', 'Hol tároljuk?', 'Meddig?', 'Milyen jogaid vannak?']) assert.match(hu.text, new RegExp(heading.replace('?', '\\?')));
      assert.match(hu.text, /nevek soha/);
      const en = await server.client({ language: 'en' }).get('/privacy');
      assert.match(en.text, /never names/);
    }));

  test('dashboard hints: no classes yet, no open program, quick links per role', () =>
    withServer(async (world, server) => {
      world.db.exec('UPDATE users SET class_id = NULL; DELETE FROM classes;');
      world.db.prepare("UPDATE programs SET status = 'upcoming'").run();
      const boss = server.client();
      await boss.login('boss');
      const page = decode((await boss.get('/admin')).text);
      assert.match(page, /Még nincs egy osztály sem felvéve\./);
      assert.match(page, /href="\/admin\/super\?tab=classes"/);
      assert.match(page, /Kaszinó/);
      const logan = server.client();
      await logan.login('logan');
      const loganPage = decode((await logan.get('/admin')).text);
      assert.match(loganPage, /Jelenleg nincs nyitott program\./);
      assert.match(loganPage, /href="\/admin\/suspicion"/);
      assert.doesNotMatch(loganPage, /Még nincs egy osztály/, 'only the superadmin can fix it, so only they see it');
    }));

  test('casino page without any casino program, and with several', () =>
    withServer(async (world, server) => {
      const dealer = server.client();
      await dealer.login('dealer');
      world.db.prepare('UPDATE reasons SET active = 0 WHERE id = ?').run(world.reasons.casino);
      assert.match((await dealer.get('/admin/casino')).text, /Nincs olyan program, amelyhez kaszinó tartozik\./);
      world.db.prepare('UPDATE reasons SET active = 1 WHERE id = ?').run(world.reasons.casino);
      const halloween = world.programBySlug('halloween');
      world.db.prepare("INSERT INTO reasons (program_id, name_hu, name_en, kind, min_points, max_points, formula) VALUES (?, 'Kaszinó', 'Casino', 'casino', 0, 100, 'chips / 10')").run(halloween.id);
      const page = await dealer.get('/admin/casino');
      assert.match(page.text, new RegExp(`href="/admin/casino\\?program=${halloween.id}"`));
      assert.doesNotMatch(page.text, /Ez a program most nincs nyitva/, 'by default the open program is chosen');
      const upcoming = await dealer.get(`/admin/casino?program=${halloween.id}`);
      assert.match(upcoming.text, /Ez a program most nincs nyitva/);
      assert.match((await dealer.get('/admin/casino?program=424242')).text, /Nincs olyan program/);
    }));

  test('superadmin snapshot list with hidden publications', () =>
    withServer(async (world, server) => {
      const { id } = publishSnapshot(world.db, { actor: world.users.boss, label: 'Első közzététel', now: world.clock.now() });
      world.db.prepare('UPDATE snapshots SET hidden = 1 WHERE id = ?').run(id);
      const boss = server.client();
      await boss.login('boss');
      const page = await boss.get('/admin/super?tab=snapshots');
      assert.match(page.text, /Első közzététel/);
      assert.match(page.text, /badge danger">rejtett/);
      assert.match(page.text, new RegExp(`id="snapshot-${id}"`));
    }));

  test('the suspicion report lists casino cash-outs and games too', () =>
    withServer(async (world, server) => {
      world.settings.set('casino.record_games', true);
      const base = { actor: world.users.dealer, programId: world.program.id, now: world.clock.now() };
      const a = recordVisit(world.db, world.settings, { ...base, classId: world.classes['9.B'], name: 'Kártyás Kata' });
      const b = recordVisit(world.db, world.settings, { ...base, classId: world.classes['10.A'], name: 'Pókeres Pál' });
      const pvp = world.db.prepare("SELECT id FROM casino_games WHERE kind = 'pvp' LIMIT 1").get().id;
      recordRound(world.db, world.settings, { ...base, gameId: String(pvp), results: [{ visitId: String(a.id), delta: '40' }, { visitId: String(b.id), delta: '-40' }] });
      recordCashout(world.db, world.settings, { ...base, visitId: String(a.id), chips: '140' });
      const logan = server.client();
      await logan.login('logan');
      const page = decode((await logan.get('/admin/suspicion')).text);
      assert.match(page, /Kifizetés #1/);
      assert.match(page, /Kártyás Kata · 9\.B/);
      assert.match(page, /Játék #1/);
      assert.match(page, /Póker/);
    }));

  test('an error inside the admin area keeps the admin navigation', () =>
    withServer(async (world, server) => {
      const org = server.client();
      await org.login('org');
      const res = await org.get('/admin/super');
      assert.equal(res.status, 403);
      assert.match(res.text, /class="admin-nav"/);
      assert.match(res.text, /Ehhez nincs jogosultságod\./);
      assert.match(res.text, /href="\/admin">Vissza/);
    }));
});
