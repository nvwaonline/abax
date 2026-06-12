import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { applyWorkingMemoryOperations } from '../engine/working-memory.js'
import { getLogicContext } from '../engine/logic-context.js'
import { computeArithmetic } from './builtins.js'
import { validateRuleSafety } from './safety.js'

describe('computeArithmetic', () => {
  it('does exact arithmetic an LLM would mis-compute', () => {
    assert.equal(computeArithmetic('mul', 123456, 789012), 97408265472)
    assert.equal(computeArithmetic('add', 2, 3), 5)
    assert.equal(computeArithmetic('sub', 10, 4), 6)
    assert.equal(computeArithmetic('pow', 2, 10), 1024)
    assert.equal(computeArithmetic('mod', 17, 5), 2)
    assert.equal(computeArithmetic('neg', 7), -7)
    assert.equal(computeArithmetic('abs', -9), 9)
    assert.equal(computeArithmetic('max', 3, 8), 8)
  })

  it('fails (undefined) on divide-by-zero and non-numbers', () => {
    assert.equal(computeArithmetic('div', 1, 0), undefined)
    assert.equal(computeArithmetic('mod', 1, 0), undefined)
    assert.equal(computeArithmetic('mul', 'x' as never, 2), undefined)
  })

  it('fails (undefined) instead of producing Infinity or NaN', () => {
    assert.equal(computeArithmetic('pow', 10, 400), undefined) // Infinity
    assert.equal(computeArithmetic('pow', -1, 0.5), undefined) // NaN
  })

  it('fails (undefined) when integer arithmetic exceeds exact range instead of silently rounding', () => {
    // 123456789 * 987654321 = 121932631112635269, beyond 2^53 - the float
    // result would be silently WRONG, betraying the "exact arithmetic"
    // contract. Refusing is honest; a wrong number on the board is not.
    assert.equal(computeArithmetic('mul', 123456789, 987654321), undefined)
    assert.equal(computeArithmetic('pow', 2, 60), undefined)
    // Within 2^53 stays exact and allowed.
    assert.equal(computeArithmetic('mul', 94906265, 94906265), 9007199136250225)
    // Floats are IEEE best-effort by declaration, not exact - still allowed.
    assert.equal(computeArithmetic('add', 0.1, 0.2), 0.30000000000000004)
    assert.equal(computeArithmetic('div', 1, 3), 1 / 3)
  })
})

describe('arithmetic rule safety', () => {
  it('binds the result var; inputs must be pre-bound', () => {
    // result ?t is bound by mul, so the head using ?t is safe.
    assert.deepEqual(
      validateRuleSafety({
        id: 'cost',
        when: [
          { predicate: 'line', args: { item: '?i', unit: '?u', qty: '?q' } },
          { predicate: 'mul', args: { left: '?u', right: '?q', result: '?t' } },
        ],
        then: [{ predicate: 'cost', args: { item: '?i', total: '?t' } }],
      }),
      [],
    )
    // unbound input ?u -> unsafe.
    const bad = validateRuleSafety({
      id: 'bad',
      when: [{ predicate: 'mul', args: { left: '?u', right: '?q', result: '?t' } }],
      then: [{ predicate: 'r', args: { t: '?t' } }],
    })
    assert.ok(bad.some((v) => /not bound/.test(v)))
  })

  it('arithmetic cannot appear in a rule head', () => {
    const v = validateRuleSafety({
      id: 'h',
      when: [{ predicate: 'a', args: { x: '?x' } }],
      then: [{ predicate: 'add', args: { left: '?x', right: 1, result: '?y' } }],
    })
    assert.ok(v.some((s) => /cannot appear in a rule head/.test(s)))
  })
})

describe('arithmetic in the closure (end to end)', () => {
  it('derives an exact computed value through a rule', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'arith' })
    applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'add_axiom',
        id: 'ax_cost',
        label: 'cost = unit * qty',
        when: [
          { predicate: 'line', args: { item: '?i', unit: '?u', qty: '?q' } },
          { predicate: 'mul', args: { left: '?u', right: '?q', result: '?t' } },
        ],
        then: [{ predicate: 'cost', args: { item: '?i', total: '?t' } }],
      },
      { op: 'assert_fact', id: 'L1', predicate: 'line', args: { item: 'widget', unit: 1299, qty: 37 } },
    ])
    const board = getLogicContext(store, space.id)
    const cost = board.facts.find((f) => f.atom.predicate === 'cost')
    assert.ok(cost?.derived, 'cost should be a derived fact')
    assert.equal(cost?.atom.args?.total, 1299 * 37) // 48063, exact
  })

  it('acts as a guard when result is pre-bound (chained check)', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'guard' })
    applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'add_axiom',
        id: 'ax_check',
        label: 'flag rows whose total matches unit*qty',
        when: [
          { predicate: 'row', args: { id: '?r', unit: '?u', qty: '?q', total: '?t' } },
          { predicate: 'mul', args: { left: '?u', right: '?q', result: '?t' } },
        ],
        then: [{ predicate: 'consistent', args: { id: '?r' } }],
      },
      { op: 'assert_fact', id: 'OK', predicate: 'row', args: { id: 'a', unit: 6, qty: 7, total: 42 } },
      { op: 'assert_fact', id: 'BAD', predicate: 'row', args: { id: 'b', unit: 6, qty: 7, total: 41 } },
    ])
    const board = getLogicContext(store, space.id)
    const consistent = board.facts.filter((f) => f.atom.predicate === 'consistent').map((f) => f.atom.args?.id)
    assert.deepEqual(consistent, ['a']) // only the row whose total checks out
  })
})
