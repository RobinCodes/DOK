// Safe arithmetic formulas for point rules, e.g. "stamps * stamp_points + people * person_points".
//
// Formulas are edited by the superadmin at runtime (Rulebook §3.4), so they
// must never run as code: there is no eval() here, only a small parser that
// understands numbers, names, + - * / ( ) and a few whitelisted functions.

export const MAX_FORMULA_LENGTH = 200;

export class FormulaError extends Error {}

/** Rounds half away from zero (2.5 → 3, −2.5 → −3), after removing float noise like 2.4999999999. */
export function roundHalfAway(x) {
  const cleaned = Math.round(x * 1e9) / 1e9;
  return Math.sign(cleaned) * Math.round(Math.abs(cleaned)) + 0;
}

const FUNCTIONS = {
  min: { fn: Math.min, arity: [1, 20] },
  max: { fn: Math.max, arity: [1, 20] },
  round: { fn: roundHalfAway, arity: [1, 1] },
  floor: { fn: Math.floor, arity: [1, 1] },
  ceil: { fn: Math.ceil, arity: [1, 1] },
  abs: { fn: Math.abs, arity: [1, 1] },
};

function tokenize(source) {
  const tokens = [];
  // Names must start with a letter (like reason parameter names), which also
  // keeps prototype keys such as "__proto__" out of evaluation scopes.
  const pattern = /\s+|(\d+(?:\.\d+)?)|([a-z][a-z0-9_]*)|([-+*/(),])/iy;
  pattern.lastIndex = 0;
  while (pattern.lastIndex < source.length) {
    const start = pattern.lastIndex;
    const m = pattern.exec(source);
    if (!m) throw new FormulaError(`Unexpected character "${source[start]}" at position ${start + 1}`);
    if (m[1]) tokens.push({ type: 'num', value: Number(m[1]) });
    else if (m[2]) tokens.push({ type: 'name', value: m[2].toLowerCase() });
    else if (m[3]) tokens.push({ type: m[3] });
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const peek = (type) => tokens[pos]?.type === type;
  const expect = (type) => {
    if (!peek(type)) throw new FormulaError(`Expected "${type}"`);
    pos++;
  };

  const binary = (next, ops) => () => {
    let node = next();
    while (ops.some(peek)) {
      const op = tokens[pos++].type;
      node = { op, left: node, right: next() };
    }
    return node;
  };

  function primary() {
    const token = tokens[pos++];
    if (!token) throw new FormulaError('Unexpected end of formula');
    if (token.type === 'num') return { num: token.value };
    if (token.type === '(') {
      const node = expression();
      expect(')');
      return node;
    }
    if (token.type === 'name' && peek('(')) {
      const def = FUNCTIONS[token.value];
      if (!Object.hasOwn(FUNCTIONS, token.value)) throw new FormulaError(`Unknown function "${token.value}"`);
      pos++;
      const args = [expression()];
      while (peek(',')) {
        pos++;
        args.push(expression());
      }
      expect(')');
      if (args.length < def.arity[0] || args.length > def.arity[1]) {
        throw new FormulaError(`Wrong number of arguments for "${token.value}"`);
      }
      return { fn: token.value, args };
    }
    if (token.type === 'name') return { name: token.value };
    throw new FormulaError(`Unexpected "${token.type}"`);
  }

  function unary() {
    if (peek('-')) {
      pos++;
      return { op: 'neg', operand: unary() };
    }
    if (peek('+')) {
      pos++;
      return unary();
    }
    return primary();
  }

  const term = binary(unary, ['*', '/']);
  const expression = binary(term, ['+', '-']);

  const ast = expression();
  if (pos !== tokens.length) throw new FormulaError(`Unexpected "${tokens[pos].type}"`);
  return ast;
}

function evaluate(node, scope) {
  if ('num' in node) return node.num;
  if ('name' in node) {
    if (!Object.hasOwn(scope, node.name)) throw new FormulaError(`Missing value for "${node.name}"`);
    return scope[node.name];
  }
  if ('fn' in node) return FUNCTIONS[node.fn].fn(...node.args.map((arg) => evaluate(arg, scope)));
  if (node.op === 'neg') return -evaluate(node.operand, scope);
  const left = evaluate(node.left, scope);
  const right = evaluate(node.right, scope);
  if (node.op === '+') return left + right;
  if (node.op === '-') return left - right;
  if (node.op === '*') return left * right;
  if (right === 0) throw new FormulaError('Division by zero');
  return left / right;
}

function collectNames(node, names) {
  if ('name' in node) names.add(node.name);
  for (const child of [node.left, node.right, node.operand, ...(node.args || [])]) {
    if (child) collectNames(child, names);
  }
  return names;
}

/** Parses a formula once; returns its variable names and an evaluate(scope) function. */
export function compileFormula(source) {
  if (typeof source !== 'string' || !source.trim()) throw new FormulaError('Empty formula');
  if (source.length > MAX_FORMULA_LENGTH) throw new FormulaError(`Formula longer than ${MAX_FORMULA_LENGTH} characters`);
  const ast = parse(tokenize(source));
  return {
    variables: [...collectNames(ast, new Set())],
    evaluate(scope) {
      const value = evaluate(ast, scope);
      if (!Number.isFinite(value)) throw new FormulaError('Result is not a finite number');
      return value;
    },
  };
}
