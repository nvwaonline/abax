import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateStratifiedClosure } from './stratify.js'
import { computeArithmetic } from './builtins.js'
import { validateRuleSafety } from './safety.js'

describe('guarded comparison built-ins', () => {
  it('evaluates comparisons against bound values during rule matching', () => {
    const result = evaluateStratifiedClosure({
      rules: [
        {
          id: 'R_WALKABLE',
          when: [
            { predicate: 'distance', args: { from: '?f', to: '?t', meters: '?m' } },
            { predicate: 'lte', args: { left: '?m', right: 500 } },
          ],
          then: [{ predicate: 'walkable', args: { from: '?f', to: '?t' } }],
        },
      ],
      facts: [
        { id: 'F1', atom: { predicate: 'distance', args: { from: 'home', to: 'car_wash', meters: 100 } } },
        { id: 'F2', atom: { predicate: 'distance', args: { from: 'home', to: 'airport', meters: 12000 } } },
      ],
    })

    assert.equal(result.derivations.length, 1)
    assert.deepEqual(result.derivations[0]?.atom, {
      predicate: 'walkable',
      args: { from: 'home', to: 'car_wash' },
      negated: undefined,
    })
  })

  it('rejects built-ins in rule heads and unbound built-in variables', () => {
    assert.match(
      validateRuleSafety({
        id: 'R_BAD_HEAD',
        when: [{ predicate: 'a', args: { item: '?x' } }],
        then: [{ predicate: 'lt', args: { left: '?x', right: 5 } }],
      }).join('; '),
      /reserved built-in/,
    )
    assert.match(
      validateRuleSafety({
        id: 'R_UNBOUND',
        when: [{ predicate: 'lt', args: { left: '?m', right: 5 } }],
        then: [{ predicate: 'small', args: { item: 'thing' } }],
      }).join('; '),
      /not bound/,
    )
    assert.match(
      validateRuleSafety({
        id: 'R_NEGATED_BUILTIN',
        when: [
          { predicate: 'a', args: { item: '?x' } },
          { predicate: 'lt', args: { left: '?x', right: 5 }, naf: true },
        ],
        then: [{ predicate: 'b', args: { item: '?x' } }],
      }).join('; '),
      /inverse comparison/,
    )
  })
})

describe('arithmetic input strictness (open-review #29 finding)', () => {
  it('refuses non-number inputs instead of coercing them to 0/1', () => {
    // Number('')===0, Number(null)===0, Number(true)===1, Number('  ')===0:
    // all slip past an isNaN-only check and come back looking exact -
    // found by the open-ended local-model review round.
    assert.equal(computeArithmetic('mul', '' as never, 5), undefined)
    assert.equal(computeArithmetic('add', true as never, 5), undefined)
    assert.equal(computeArithmetic('mul', '007' as never, 5), undefined)
    assert.equal(computeArithmetic('add', 2, '3' as never), undefined)
    assert.equal(computeArithmetic('neg', '' as never), undefined)
    assert.equal(computeArithmetic('min', 2, true as never), undefined)
    // and plain numbers still work exactly
    assert.equal(computeArithmetic('mul', 9381274, 6473), 60724986602)
  })
})
