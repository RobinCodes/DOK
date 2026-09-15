import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../../src/auth/roles.js';
import { REASON_KINDS } from '../../src/domain/catalog.js';
import { TABLES } from '../../src/domain/manage.js';
import { SETTINGS } from '../../src/domain/settings.js';
import en from '../../src/i18n/en.js';
import hu from '../../src/i18n/hu.js';
import { detectLanguage, translator } from '../../src/i18n/index.js';
import { TABS } from '../../src/views/admin/super.js';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.js') && !path.includes('i18n') ? [path] : [];
  });
}

describe('language detection', () => {
  test('Hungarian browsers get Hungarian', () => {
    assert.equal(detectLanguage(undefined, 'hu-HU,hu;q=0.9,en-US;q=0.8'), 'hu');
    assert.equal(detectLanguage(undefined, 'hu'), 'hu');
  });

  test('any other primary language gets English', () => {
    assert.equal(detectLanguage(undefined, 'en-US,en;q=0.9'), 'en');
    assert.equal(detectLanguage(undefined, 'de-DE,de;q=0.9,hu;q=0.8'), 'en');
    assert.equal(detectLanguage(undefined, 'sk'), 'en');
  });

  test('quality values decide, not the order', () => {
    assert.equal(detectLanguage(undefined, 'en;q=0.5, hu;q=0.9'), 'hu');
    assert.equal(detectLanguage(undefined, 'hu;q=0.1, de;q=0.2'), 'en');
    assert.equal(detectLanguage(undefined, 'hu;q=0, en'), 'en');
  });

  test('wildcards, junk and a missing header fall back sensibly', () => {
    assert.equal(detectLanguage(undefined, '*'), 'hu');
    assert.equal(detectLanguage(undefined, ''), 'hu');
    assert.equal(detectLanguage(undefined, undefined), 'hu');
    assert.equal(detectLanguage(undefined, ';;;,,,q=abc'), 'hu');
  });

  test('an explicit choice (cookie) always wins', () => {
    assert.equal(detectLanguage('en', 'hu-HU'), 'en');
    assert.equal(detectLanguage('hu', 'en-US'), 'hu');
    assert.equal(detectLanguage('fr', 'hu-HU'), 'hu');
  });
});

describe('translator', () => {
  test('fills placeholders and leaves unknown ones visible', () => {
    const t = translator('en');
    assert.equal(t('flash.saved', { n: 5 }), 'Saved: 5 points.');
    assert.equal(t('flash.saved'), 'Saved: {n} points.');
    assert.equal(t('home.standingsTitle', { n: 0 }), 'Top 0 classes');
  });

  test('missing keys fall back to Hungarian, then to the key itself', () => {
    assert.equal(translator('xx')('login.title'), hu['login.title']);
    assert.equal(translator('en')('no.such.key'), 'no.such.key');
    assert.equal(translator('en').has('no.such.key'), false);
  });

  test('placeholder values cannot inject template syntax recursively', () => {
    assert.equal(translator('en')('error.inputInvalid', { name: '{name}' }), 'Enter a whole number for “{name}”.');
  });
});

describe('dictionaries', () => {
  test('Hungarian and English have exactly the same keys', () => {
    assert.deepEqual(Object.keys(en).sort(), Object.keys(hu).sort());
  });

  test('both languages use the same placeholders for every key', () => {
    const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(hu)) assert.deepEqual(placeholders(en[key]), placeholders(hu[key]), key);
  });

  test('no text is empty', () => {
    for (const [key, value] of [...Object.entries(hu), ...Object.entries(en)]) assert.ok(value.trim(), key);
  });

  test('every literal translation key used in the code exists', () => {
    const pattern = /['"`]((?:error|warning|flash|sus|nav|home|login|dashboard|award|entries|timers|casino|log|suspicion|standings|super|privacy|form|value|account|footer|site)\.[a-zA-Z0-9_.]+)['"`]/g;
    const files = sourceFiles(SRC).map((file) => ({ file, code: readFileSync(file, 'utf8') }));
    // Settings keys and event log action names share some prefixes but aren't texts.
    const auditActions = new Set(files.flatMap(({ code }) => [...code.matchAll(/action: '([a-z_.]+)'/g)].map((m) => m[1])));
    const missing = [];
    for (const { file, code } of files) {
      for (const [, key] of code.matchAll(pattern)) {
        if (key in SETTINGS || auditActions.has(key)) continue;
        if (!(key in hu)) missing.push(`${key} (${file.slice(SRC.length)})`);
      }
    }
    assert.ok(auditActions.has('casino.visit'), 'the action scan works');
    assert.deepEqual(missing, []);
  });

  test('dynamic key families are complete', () => {
    const required = [
      ...Object.keys(SETTINGS).map((k) => `setting.${k}`),
      ...[...new Set(Object.keys(SETTINGS).map((k) => k.split('.')[0]))].map((g) => `settingGroup.${g}`),
      ...REASON_KINDS.flatMap((k) => [`kind.${k}`, `choice.${k}`]),
      ...['upcoming', 'open', 'closed'].flatMap((s) => [`status.${s}`, `choice.${s}`]),
      ...ROLES.flatMap((r) => [`role.${r}`, `choice.${r}`]),
      ...['house', 'pvp'].flatMap((k) => [`choice.${k}`, `casino.gameKind.${k}`]),
      ...['allow', 'flag', 'block', 'confirm'].map((c) => `choice.${c}`),
      ...Object.values(TABLES).flatMap((t) => Object.keys(t.fields).map((f) => `field.${f}`)),
      ...TABS.map((tab) => `super.tab.${tab}`),
      ...['form', 'timer', 'pool', 'casino', 'adjustment'].map((s) => `source.${s}`),
      ...['light', 'visits', 'games'].map((m) => `casino.mode.${m}`),
      ...['visit', 'cashout', 'round'].map((k) => `casino.record.${k}`),
      ...['visit', 'cashout', 'round'].map((k) => `flash.casino_${k}`),
      ...['limits', 'magnitude', 'favoritism', 'own_class', 'concentration', 'reciprocity', 'velocity', 'voids', 'timing', 'names', 'manual_minutes', 'casino'].map((d) => `detector.${d}`),
      ...['who', 'what', 'why', 'visibility', 'where', 'retention', 'rights'].flatMap((s) => [`privacy.${s}.title`, `privacy.${s}.text`]),
      ...[400, 401, 403, 404, 405, 413, 415, 429, 500].map((s) => `error.${s}`),
      'input.stamps',
      'input.people',
      'input.minutes',
      'input.participants',
    ];
    assert.deepEqual(required.filter((key) => !(key in hu)), []);
  });
});
