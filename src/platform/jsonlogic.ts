/**
 * Safe JSON-logic evaluator (F-167). No eval / Function / dynamic code: only the operators below, with
 * depth and operation budgets so hostile rule definitions cannot burn CPU.
 */
export type Logic = unknown;

const MAX_DEPTH = 20;
const MAX_OPS = 1000;

export class LogicError extends Error {}

const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : !!v);
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) throw new LogicError('Not a number');
  return n;
};

function getVar(data: unknown, path: unknown): unknown {
  if (path === '' || path === null || path === undefined) return data;
  let cur: unknown = data;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function evaluate(logic: Logic, data: unknown): unknown {
  const budget = { ops: 0 };
  const run = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new LogicError('Rule too deeply nested');
    if (++budget.ops > MAX_OPS) throw new LogicError('Rule too complex');
    if (Array.isArray(node)) return node.map((n) => run(n, depth + 1));
    if (node === null || typeof node !== 'object') return node;
    const entries = Object.entries(node as Record<string, unknown>);
    if (entries.length !== 1) throw new LogicError('Each operation must have exactly one operator');
    const [op, rawArgs] = entries[0] as [string, unknown];
    const args = Array.isArray(rawArgs) ? rawArgs : [rawArgs];

    switch (op) {
      case 'var': {
        const path = run(args[0], depth + 1);
        const v = getVar(data, path);
        return v === undefined ? (args.length > 1 ? run(args[1], depth + 1) : null) : v;
      }
      case 'and': {
        let last: unknown = true;
        for (const a of args) { last = run(a, depth + 1); if (!truthy(last)) return last; }
        return last;
      }
      case 'or': {
        let last: unknown = false;
        for (const a of args) { last = run(a, depth + 1); if (truthy(last)) return last; }
        return last;
      }
      case 'if': {
        for (let i = 0; i + 1 < args.length; i += 2) if (truthy(run(args[i], depth + 1))) return run(args[i + 1], depth + 1);
        return args.length % 2 === 1 ? run(args[args.length - 1], depth + 1) : null;
      }
      default:
    }
    const v = args.map((a) => run(a, depth + 1));
    switch (op) {
      case '==': return v[0] == v[1];
      case '!=': return v[0] != v[1];
      case '===': return v[0] === v[1];
      case '!==': return v[0] !== v[1];
      case '!': return !truthy(v[0]);
      case '!!': return truthy(v[0]);
      case '>': return num(v[0]) > num(v[1]);
      case '>=': return num(v[0]) >= num(v[1]);
      case '<': return v.length === 3 ? num(v[0]) < num(v[1]) && num(v[1]) < num(v[2]) : num(v[0]) < num(v[1]);
      case '<=': return v.length === 3 ? num(v[0]) <= num(v[1]) && num(v[1]) <= num(v[2]) : num(v[0]) <= num(v[1]);
      case 'in':
        if (typeof v[1] === 'string') return v[1].includes(String(v[0]));
        return Array.isArray(v[1]) ? v[1].includes(v[0]) : false;
      case '+': return v.reduce<number>((a, b) => a + num(b), 0);
      case '-': return v.length === 1 ? -num(v[0]) : num(v[0]) - num(v[1]);
      case '*': return v.reduce<number>((a, b) => a * num(b), 1);
      case '/': { const d = num(v[1]); if (d === 0) throw new LogicError('Division by zero'); return num(v[0]) / d; }
      case '%': { const d = num(v[1]); if (d === 0) throw new LogicError('Division by zero'); return num(v[0]) % d; }
      case 'min': return Math.min(...v.map(num));
      case 'max': return Math.max(...v.map(num));
      case 'cat': return v.map((x) => (x === null || x === undefined ? '' : String(x))).join('');
      default:
        throw new LogicError(`Unsupported operation "${op}"`);
    }
  };
  return run(logic, 0);
}

export const evaluateBool = (logic: Logic, data: unknown): boolean => truthy(evaluate(logic, data));

/** Structural validation without data (unknown operators / shape) — used when publishing definitions. */
export function validateLogic(logic: Logic): void {
  evaluate(logic, {});
}
