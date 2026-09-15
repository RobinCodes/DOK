import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compileFormula, FormulaError, MAX_FORMULA_LENGTH, roundHalfAway } from '../../src/domain/formula.js';

const run = (source, scope = {}) => compileFormula(source).evaluate(scope);

describe('formula evaluation', () => {
  test('the seeded rulebook formulas', () => {
    assert.equal(run('stamps * stamp_points + people * person_points', { stamps: 40, people: 10, stamp_points: 5, person_points: 2 }), 220);
    assert.equal(run('minutes * points_per_minute', { minutes: 60, points_per_minute: 1 }), 60);
    assert.equal(run('participants * per_participant', { participants: 3, per_participant: 10 }), 30);
    assert.equal(run('chips / chips_per_point', { chips: 250, chips_per_point: 10 }), 25);
  });

  test('operator precedence, associativity and parentheses', () => {
    assert.equal(run('2 + 3 * 4'), 14);
    assert.equal(run('(2 + 3) * 4'), 20);
    assert.equal(run('10 - 4 - 3'), 3);
    assert.equal(run('64 / 4 / 2'), 8);
    assert.equal(run('-2 * 3'), -6);
    assert.equal(run('2 - -3'), 5);
    assert.equal(run('+5 + --1'), 6);
    assert.equal(run(' 1.5*2 '), 3);
  });

  test('whitelisted functions with arity checks', () => {
    assert.equal(run('max(0, chips - start)', { chips: 80, start: 100 }), 0);
    assert.equal(run('min(3, 1, 2)'), 1);
    assert.equal(run('round(2.5) + floor(2.9) + ceil(2.1) + abs(-4)'), 3 + 2 + 3 + 4);
    assert.throws(() => compileFormula('round(1, 2)'), FormulaError);
    assert.throws(() => compileFormula('abs()'), FormulaError);
  });

  test('names are case-insensitive and reported as variables', () => {
    const f = compileFormula('Stamps * STAMP_POINTS + max(people, 1)');
    assert.deepEqual(f.variables.sort(), ['people', 'stamp_points', 'stamps']);
    assert.equal(f.evaluate({ stamps: 2, stamp_points: 5, people: 0 }), 11);
  });

  test('refuses anything that is not arithmetic', () => {
    const attacks = [
      'process.exit()',
      'constructor.constructor("return process")()',
      '__proto__',
      'a; b',
      '1 ** 2',
      '"text"',
      '`x`',
      'a[0]',
      'a.b',
      'eval(1)',
      'x = 1',
      '1 2',
      '()',
      '(1',
      '1)',
      '1 +',
      '* 2',
      '.5',
      '1.',
      '_x',
      'min(1,)',
    ];
    for (const source of attacks) assert.throws(() => compileFormula(source), FormulaError, source);
  });

  test('rejects empty, non-string and overlong formulas', () => {
    assert.throws(() => compileFormula(''), FormulaError);
    assert.throws(() => compileFormula('   '), FormulaError);
    assert.throws(() => compileFormula(null), FormulaError);
    assert.throws(() => compileFormula('1+'.repeat(MAX_FORMULA_LENGTH) + '1'), FormulaError);
  });

  test('evaluation errors: missing values, division by zero, non-finite results', () => {
    assert.throws(() => run('a + 1'), /Missing value for "a"/);
    assert.throws(() => run('1 / (a - a)', { a: 3 }), /Division by zero/);
    assert.throws(() => run('a * a', { a: 1e308 }), /finite/);
    assert.throws(() => run('toString', {}), /Missing value/);
  });

  test('deeply nested parentheses within the length limit still work', () => {
    const depth = 90;
    assert.equal(run(`${'('.repeat(depth)}7${')'.repeat(depth)}`), 7);
  });
});

describe('rounding to whole points', () => {
  test('rounds half away from zero', () => {
    assert.equal(roundHalfAway(2.5), 3);
    assert.equal(roundHalfAway(-2.5), -3);
    assert.equal(roundHalfAway(2.4999), 2);
    assert.equal(roundHalfAway(0.5), 1);
    assert.equal(roundHalfAway(-0.4), 0);
    assert.ok(Object.is(roundHalfAway(-0.4), 0), 'never returns negative zero');
  });

  test('ignores binary float noise', () => {
    assert.equal(roundHalfAway(1.005 * 1000), 1005);
    assert.equal(roundHalfAway(0.1 * 3 * 10), 3);
    assert.equal(roundHalfAway(22.499999999999996), 23);
  });
});
