// calculator — evaluate a simple math expression safely.
//
// SECURITY: we DO NOT use eval(). Only +-*/% () digits and decimal points
// allowed. Expression length capped. Math functions limited to a small allowlist.

export const schema = {
  name: 'calculator',
  description: 'Evaluate a math expression. Supports +, -, *, /, %, parentheses, decimals, and functions: sqrt, abs, pow, min, max, round, floor, ceil. Use for any arithmetic the user asks about.',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Math expression, e.g. "(2+3)*4", "sqrt(16)+pow(2,10)"',
      },
    },
    required: ['expression'],
  },
};

const ALLOWED_FNS = ['sqrt', 'abs', 'pow', 'min', 'max', 'round', 'floor', 'ceil', 'log', 'sin', 'cos', 'tan', 'PI', 'E'];
const SAFE_RE = /^[\d+\-*/%.()\s,]+$/;

export async function execute({ expression }) {
  if (typeof expression !== 'string' || expression.length === 0) {
    return { error: 'expression required (string)' };
  }
  if (expression.length > 200) {
    return { error: 'expression too long (max 200 chars)' };
  }

  // Strip function names, validate remainder is safe arithmetic
  let probe = expression;
  for (const fn of ALLOWED_FNS) {
    probe = probe.replace(new RegExp(`\\b${fn}\\b`, 'g'), '');
  }
  if (!SAFE_RE.test(probe)) {
    return { error: 'expression contains disallowed characters' };
  }

  // Replace bare function names with Math.<fn> for execution
  let safe = expression;
  for (const fn of ALLOWED_FNS) {
    safe = safe.replace(new RegExp(`\\b${fn}\\b`, 'g'), `Math.${fn}`);
  }

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('Math', `"use strict"; return (${safe});`);
    const value = fn(Math);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { error: 'expression did not evaluate to a finite number' };
    }
    return { expression, result: value };
  } catch (err) {
    return { error: `Failed to evaluate: ${err.message}` };
  }
}
