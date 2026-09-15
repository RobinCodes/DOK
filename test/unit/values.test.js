import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cleanName, isPlausibleName, MAX_NAME_LENGTH, nameKey } from '../../src/domain/names.js';
import { createSettings, parseSettingValue, SETTINGS } from '../../src/domain/settings.js';
import { budapestLocalToIso, formatDateTime, formatTime, isoToBudapestLocal, minutesBetween } from '../../src/domain/time.js';
import { parseBool, parseChoice, parseDecimal, parseId, parseInteger, parseText } from '../../src/domain/validate.js';
import { openDatabase } from '../../src/db/database.js';

describe('student names', () => {
  test('same student typed differently gets the same key', () => {
    const key = nameKey('Kovács Péter');
    for (const variant of ['kovacs peter', '  KOVÁCS   PÉTER ', 'Péter Kovács', 'Kovács-Péter', 'Kovács Péter']) {
      assert.equal(nameKey(variant), key, variant);
    }
  });

  test('different students keep different keys', () => {
    assert.notEqual(nameKey('Kovács Péter'), nameKey('Kovács Pál'));
    assert.notEqual(nameKey('Szőke Anna'), nameKey('Szőke Annamária'));
  });

  test('Hungarian double-acute letters fold to their base letter', () => {
    assert.equal(nameKey('Őri Ünige Űrhajós'), nameKey('ori unige urhajos'));
  });

  test('cleanName normalizes whitespace and Unicode form but keeps the spelling', () => {
    assert.equal(cleanName('  Kiss\t\nAnna  '), 'Kiss Anna');
    assert.equal(cleanName('Kovács'), 'Kovács');
    assert.equal(cleanName(null), '');
  });

  test('plausible names need a letter and a sane length', () => {
    assert.equal(isPlausibleName('Kiss Anna'), true);
    assert.equal(isPlausibleName('李小龍'), true);
    assert.equal(isPlausibleName('12345'), false);
    assert.equal(isPlausibleName('!!!'), false);
    assert.equal(isPlausibleName(''), false);
    assert.equal(isPlausibleName('a'.repeat(MAX_NAME_LENGTH + 1)), false);
  });
});

describe('strict input parsing', () => {
  test('integers', () => {
    assert.equal(parseInteger(' 42 '), 42);
    assert.equal(parseInteger('-7'), -7);
    assert.equal(parseInteger('+7'), 7);
    assert.ok(Object.is(parseInteger('-0'), 0));
    for (const bad of ['', '1.0', '1e3', '0x10', '1 000', '١٢', 'NaN', 'Infinity', '12345678901234567', null, undefined]) {
      assert.throws(() => parseInteger(bad), { messageKey: 'error.notInteger' }, String(bad));
    }
    assert.throws(() => parseInteger('11', { min: 0, max: 10 }), { messageKey: 'error.outOfRange', vars: { min: 0, max: 10 } });
  });

  test('decimals', () => {
    assert.equal(parseDecimal('0.5'), 0.5);
    assert.equal(parseDecimal('-12'), -12);
    for (const bad of ['1,5', '.5', '5.', '1e2', '', '0.1234567']) assert.throws(() => parseDecimal(bad), { messageKey: 'error.notNumber' }, bad);
    assert.throws(() => parseDecimal('5', { min: 0, max: 1 }), { messageKey: 'error.outOfRange' });
  });

  test('ids, text, choices and booleans', () => {
    assert.equal(parseId('15'), 15);
    for (const bad of ['0', '-1', 'x', '', '1.5']) assert.throws(() => parseId(bad), { messageKey: 'error.notFound' });
    assert.equal(parseText('  hello '), 'hello');
    assert.throws(() => parseText(' ', { required: true }), { messageKey: 'error.required' });
    assert.throws(() => parseText('abcd', { max: 3 }), { messageKey: 'error.tooLong' });
    assert.equal(parseChoice('a', ['a', 'b']), 'a');
    assert.throws(() => parseChoice('c', ['a', 'b']), { messageKey: 'error.invalidChoice' });
    assert.equal(parseBool('on'), true);
    assert.equal(parseBool('0'), false);
    assert.equal(parseBool('yes'), null);
  });
});

describe('settings registry', () => {
  test('every definition is well-formed and its default passes its own validation', () => {
    for (const [key, def] of Object.entries(SETTINGS)) {
      assert.match(key, /^[a-z]+(\.[a-z_]+)+$/);
      assert.ok(['bool', 'int', 'choice'].includes(def.type), key);
      assert.equal(parseSettingValue(key, def.value).ok, true, key);
      if (def.type === 'int') assert.ok(def.min <= def.value && def.value <= def.max, key);
    }
  });

  test('suspicion weights exist for every detector', () => {
    for (const detector of ['limits', 'magnitude', 'favoritism', 'own_class', 'concentration', 'reciprocity', 'velocity', 'voids', 'timing', 'names', 'manual_minutes', 'casino']) {
      assert.ok(SETTINGS[`suspicion.weight.${detector}`], detector);
    }
  });

  test('defaults, overrides and validation', () => {
    const db = openDatabase(':memory:');
    const settings = createSettings(db);
    assert.equal(settings.get('casino.start_chips'), 100);
    assert.equal(settings.set('casino.start_chips', '250'), 250);
    assert.equal(settings.get('casino.start_chips'), 250);
    settings.set('features.timer', false);
    assert.equal(settings.get('features.timer'), false);
    settings.set('rules.own_class', 'block');
    assert.equal(settings.get('rules.own_class'), 'block');
    assert.throws(() => settings.set('casino.start_chips', '-1'));
    assert.throws(() => settings.set('rules.own_class', 'maybe'));
    assert.throws(() => settings.set('features.timer', 'yes'));
    assert.throws(() => settings.get('no.such.setting'));
    assert.throws(() => settings.set('no.such.setting', 1));
  });

  test('a corrupted stored value falls back to the default', () => {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO settings (key, value) VALUES ('casino.start_chips', 'lots'), ('rules.own_class', 'whatever')").run();
    const settings = createSettings(db);
    assert.equal(settings.get('casino.start_chips'), 100);
    assert.equal(settings.get('rules.own_class'), 'flag');
  });

  test('parseSettingValue reports bounds and unknown keys', () => {
    assert.deepEqual(parseSettingValue('site.standings_top', '0'), { ok: false, min: 1, max: 100 });
    assert.deepEqual(parseSettingValue('nope', '1'), { ok: false });
    assert.deepEqual(parseSettingValue('site.standings_top', '5.5'), { ok: false });
  });
});

describe('Budapest time', () => {
  test('summer (CEST, UTC+2) and winter (CET, UTC+1)', () => {
    assert.equal(budapestLocalToIso('2026-09-18T14:00'), '2026-09-18T12:00:00.000Z');
    assert.equal(budapestLocalToIso('2027-01-10T08:30'), '2027-01-10T07:30:00.000Z');
    assert.equal(isoToBudapestLocal('2026-09-18T12:00:00.000Z'), '2026-09-18T14:00');
    assert.equal(isoToBudapestLocal('2027-01-10T07:30:00.000Z'), '2027-01-10T08:30');
  });

  test('round-trips across the daylight saving changes', () => {
    for (const local of ['2026-10-25T01:59', '2026-10-25T04:00', '2027-03-28T01:00', '2027-03-28T04:00', '2026-12-31T23:59']) {
      assert.equal(isoToBudapestLocal(budapestLocalToIso(local)), local, local);
    }
  });

  test('rejects malformed and impossible dates', () => {
    for (const bad of ['2026-02-30T10:00', '2026-13-01T10:00', '2026-01-01T24:00', '2026-01-01T10:60', '2026-01-01', 'x', '']) {
      assert.equal(budapestLocalToIso(bad), null, bad);
    }
    assert.equal(isoToBudapestLocal(null), '');
  });

  test('formatting and minute differences', () => {
    assert.match(formatDateTime('2026-09-18T12:00:00.000Z', 'hu'), /2026.*14:00/);
    assert.match(formatDateTime('2026-09-18T12:00:00.000Z', 'en'), /2026.*14:00/);
    assert.equal(formatTime('2026-09-18T12:05:00.000Z', 'hu'), '14:05');
    assert.equal(formatDateTime('', 'hu'), '');
    assert.equal(formatTime(null, 'en'), '');
    assert.equal(minutesBetween('2026-09-18T12:00:00.000Z', '2026-09-18T12:59:59.999Z'), 59);
  });
});
