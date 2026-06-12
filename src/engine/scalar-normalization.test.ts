import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { applyWorkingMemoryOperations } from './working-memory.js'
import { getLogicContext } from './logic-context.js'
import { deriveActionEffects } from './semantic-derivation.js'

/**
 * Scalar identity used to be split three ways: atomKey said amount(mol=5)
 * and amount(mol="5") were the SAME fact (String coercion), the matcher
 * said the bindings were DIFFERENT (strict equality), arithmetic coerced
 * strings (mul("5",3) worked) while comparisons required numbers
 * (gte("5",2) silently false). A model writing numbers as JSON strings -
 * a high-frequency accident - got "action not applicable" with no clue.
 * Normalizing canonical numeric strings at the working-memory boundary
 * makes all layers agree.
 */

function freshSpace() {
  const store = new MemorySpaceStore()
  const space = store.createSpace({ title: 'scalar-normalization' })
  return { store, spaceId: space.id }
}

describe('numeric-string normalization at the working-memory boundary', () => {
  it('normalizes canonical numeric strings in asserted facts so guards work', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      // Model wrote the number as a JSON string - the classic accident.
      { op: 'assert_fact', id: 'h2', predicate: 'amount', args: { species: 'H2', mol: '5' } },
      {
        op: 'add_axiom',
        id: 'ax',
        label: 'enough H2',
        when: [
          { predicate: 'amount', args: { species: 'H2', mol: '?m' } },
          { predicate: 'gte', args: { left: '?m', right: 2 } },
        ],
        then: [{ predicate: 'enough', args: { species: 'H2' } }],
      },
    ])
    const facts = getLogicContext(store, spaceId).facts
    const amount = facts.find((f) => f.atom.predicate === 'amount')
    assert.equal(amount?.atom.args?.mol, 5, 'mol should be stored as a number')
    assert.ok(
      facts.some((f) => f.atom.predicate === 'enough'),
      'gte guard should fire over the normalized number',
    )
  })

  it('normalizes inside action preconditions/effects and rule constants', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'h2', predicate: 'amount', args: { species: 'H2', mol: 5 } },
      {
        op: 'define_action',
        id: 'consume',
        label: 'consume 2',
        action: 'consume',
        preconditions: [
          { predicate: 'amount', args: { species: 'H2', mol: '?m' } },
          // "2" as strings - must still bind and compute.
          { predicate: 'gte', args: { left: '?m', right: '2' } },
          { predicate: 'sub', args: { left: '?m', right: '2', result: '?m2' } },
        ],
        effects: [
          { predicate: 'amount', args: { species: 'H2', mol: '?m' }, negated: true },
          { predicate: 'amount', args: { species: 'H2', mol: '?m2' } },
        ],
      },
    ])
    const result = deriveActionEffects(store, spaceId, 'consume')
    assert.equal(result.unsatisfiedPreconditions.length, 0)
    const amount = getLogicContext(store, spaceId)
      .facts.find((f) => f.atom.predicate === 'amount')
    assert.equal(amount?.atom.args?.mol, 3)
  })

  it('leaves non-canonical numeric strings alone (identity preserved)', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'b1', predicate: 'badge', args: { code: '007' } },
      { op: 'assert_fact', id: 'v1', predicate: 'version', args: { v: '5.0' } },
    ])
    const facts = getLogicContext(store, spaceId).facts
    assert.equal(facts.find((f) => f.atom.predicate === 'badge')?.atom.args?.code, '007')
    assert.equal(facts.find((f) => f.atom.predicate === 'version')?.atom.args?.v, '5.0')
  })

  it('makes "5" and 5 the same fact for idempotent re-assertion', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'a1', predicate: 'amount', args: { mol: '5' } },
    ])
    const second = applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'a2', predicate: 'amount', args: { mol: 5 } },
    ])
    assert.ok(
      second.warnings.some((w) => w.includes('already on the board')),
      'identical fact (after normalization) should be reused, not duplicated',
    )
    assert.equal(
      getLogicContext(store, spaceId).facts.filter((f) => f.atom.predicate === 'amount').length,
      1,
    )
  })
})
