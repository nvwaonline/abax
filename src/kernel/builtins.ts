import type { PredicateAtom, SemanticScalar } from '../model/types.js'

/**
 * Guarded comparison built-ins. They are evaluated against bindings, not
 * against facts, and they never bind variables — rule safety requires
 * every variable in a built-in literal to be bound by a positive body
 * literal first. Because they cannot appear in rule heads and never
 * create new constants, they preserve termination of the closure.
 */
export const COMPARISON_BUILTINS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte'])

/**
 * Arithmetic built-ins — value PRODUCERS, not just guards. They evaluate
 * `left ∘ right` (or `left` for unary) against bound inputs and bind the
 * `result` arg. This is function evaluation, categorically different from
 * predicate derivation: the board computes an exact value the model would
 * mis-compute mentally — an external evaluator, the same role the compiler
 * plays for the repair agent.
 *
 * Discipline that keeps the kernel's guarantees: inputs must be bound by
 * positive body literals (range restriction), the literal cannot appear in
 * a rule head or be negated, and a single firing produces one value per
 * binding (the function is single-valued). The one footgun is RECURSIVE
 * arithmetic (feeding a result back as an input across iterations), which
 * can be unbounded — the closure evaluator caps iterations and fails loudly
 * rather than diverging. Non-recursive arithmetic always terminates.
 */
export const ARITHMETIC_BUILTINS = new Set([
  'add', 'sub', 'mul', 'div', 'mod', 'pow', // binary: left, right -> result
  'min', 'max',                              // binary
  'neg', 'abs',                              // unary: left -> result
])

const UNARY_ARITHMETIC = new Set(['neg', 'abs'])

export const BUILTIN_PREDICATES = new Set([...COMPARISON_BUILTINS, ...ARITHMETIC_BUILTINS])

export function isBuiltinPredicate(predicate: string): boolean {
  return BUILTIN_PREDICATES.has(predicate)
}

export function isComparisonBuiltin(predicate: string): boolean {
  return COMPARISON_BUILTINS.has(predicate)
}

export function isArithmeticBuiltin(predicate: string): boolean {
  return ARITHMETIC_BUILTINS.has(predicate)
}

/** The arg key an arithmetic built-in binds (its output). */
export const ARITHMETIC_RESULT_KEY = 'result'

/**
 * Evaluate a fully-ground comparison built-in. Expects `left`/`right`.
 * eq/neq use strict scalar equality; order comparisons require numbers.
 */
export function evaluateBuiltin(atom: PredicateAtom): boolean {
  const left = atom.args?.left
  const right = atom.args?.right
  if (left === undefined || right === undefined) return false

  switch (atom.predicate) {
    case 'eq':
      return left === right
    case 'neq':
      return left !== right
    case 'lt':
      return bothNumbers(left, right) && left < right
    case 'lte':
      return bothNumbers(left, right) && left <= right
    case 'gt':
      return bothNumbers(left, right) && left > right
    case 'gte':
      return bothNumbers(left, right) && left >= right
    default:
      return false
  }
}

/**
 * Compute an arithmetic built-in from its (already-bound) inputs. Returns
 * the numeric result, or undefined when inputs are not numbers / the
 * operation is undefined (e.g. divide by zero) — an undefined result makes
 * the literal fail, just like a false guard.
 *
 * Exactness contract: integer arithmetic is EXACT within ±2^53
 * (Number.MAX_SAFE_INTEGER). An integer result beyond that range would be
 * silently rounded by IEEE-754 — a wrong number presented as exact — so it
 * fails instead. Non-finite results (overflow to Infinity, NaN from e.g.
 * pow(-1, 0.5)) also fail: they must never become fact arguments. Float
 * arithmetic is IEEE best-effort by declaration (0.1+0.2 has the usual
 * representation error) and is allowed.
 */
export function computeArithmetic(predicate: string, left: SemanticScalar, right?: SemanticScalar): number | undefined {
  const a = typeof left === 'number' ? left : Number(left)
  if (Number.isNaN(a)) return undefined
  if (UNARY_ARITHMETIC.has(predicate)) {
    switch (predicate) {
      case 'neg': return guardResult(-a, a)
      case 'abs': return guardResult(Math.abs(a), a)
      default: return undefined
    }
  }
  const b = typeof right === 'number' ? right : Number(right)
  if (right === undefined || Number.isNaN(b)) return undefined
  switch (predicate) {
    case 'add': return guardResult(a + b, a, b)
    case 'sub': return guardResult(a - b, a, b)
    case 'mul': return guardResult(a * b, a, b)
    case 'div': return b === 0 ? undefined : guardResult(a / b, a, b)
    case 'mod': return b === 0 ? undefined : guardResult(a % b, a, b)
    case 'pow': return guardResult(a ** b, a, b)
    case 'min': return guardResult(Math.min(a, b), a, b)
    case 'max': return guardResult(Math.max(a, b), a, b)
    default: return undefined
  }
}

/** Reject non-finite results, and integer results that left exact range. */
function guardResult(result: number, ...inputs: number[]): number | undefined {
  if (!Number.isFinite(result)) return undefined
  if (
    inputs.every((value) => Number.isInteger(value)) &&
    Number.isInteger(result) &&
    !Number.isSafeInteger(result)
  ) {
    return undefined
  }
  return result
}

function bothNumbers(left: SemanticScalar, right: SemanticScalar): boolean {
  return typeof left === 'number' && typeof right === 'number'
}
