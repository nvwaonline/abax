import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { abduceProducingActions } from './abduction.js'
import { applyWorkingMemoryOperations } from './working-memory.js'

/**
 * Actions in goal hints (first step toward planning): an unproven goal
 * atom used to suggest only rules ("needs via ...") or bare assertion -
 * for a transformation product the honest move is apply_action, and the
 * old fallback ("assert the fact directly") actively taught the
 * launder-by-assertion anti-pattern that the derivation gate exists to
 * block. An open goal must now also say which defined action's positive
 * effect could produce the missing atom, and whether that action could
 * fire right now (same matcher as simulate/apply, so the hint and the
 * commit never disagree).
 */

function freshSpace() {
  const store = new MemorySpaceStore()
  const space = store.createSpace({ title: 'action-hints' })
  return { store, spaceId: space.id }
}

describe('abduceProducingActions', () => {
  it('suggests an action whose positive effect unifies with the target', () => {
    const hints = abduceProducingActions(
      { predicate: 'have', args: { species: 'H2O' } },
      [
        {
          id: 'make',
          action: 'combust',
          preconditions: [{ predicate: 'have', args: { species: 'H2' } }],
          effects: [
            { predicate: 'have', args: { species: 'H2' }, negated: true },
            { predicate: 'have', args: { species: 'H2O' } },
          ],
        },
      ],
      [{ id: 'f1', atom: { predicate: 'have', args: { species: 'H2' } } }],
    )

    assert.equal(hints.length, 1)
    assert.equal(hints[0]?.actionNodeId, 'make')
    assert.equal(hints[0]?.applicable, true)
    assert.deepEqual(hints[0]?.produces, { predicate: 'have', args: { species: 'H2O' } })
  })

  it('a negated effect (consumption) never counts as producing', () => {
    const hints = abduceProducingActions(
      { predicate: 'have', args: { species: 'H2' } },
      [
        {
          id: 'make',
          action: 'combust',
          preconditions: [{ predicate: 'have', args: { species: 'H2' } }],
          effects: [
            { predicate: 'have', args: { species: 'H2' }, negated: true },
            { predicate: 'have', args: { species: 'H2O' } },
          ],
        },
      ],
      [{ id: 'f1', atom: { predicate: 'have', args: { species: 'H2' } } }],
    )
    assert.deepEqual(hints, [])
  })

  it('reports a blocked action with the failing guard substituted (the #26 stop shape)', () => {
    const hints = abduceProducingActions(
      { predicate: 'produced', args: { species: 'H2O' } },
      [
        {
          id: 'burn1',
          action: 'combust_once',
          preconditions: [
            { predicate: 'amount', args: { species: 'H2', mol: '?h' } },
            { predicate: 'gte', args: { left: '?h', right: 2 } },
            { predicate: 'sub', args: { left: '?h', right: 2, result: '?h2' } },
          ],
          effects: [
            { predicate: 'amount', args: { species: 'H2', mol: '?h' }, negated: true },
            { predicate: 'amount', args: { species: 'H2', mol: '?h2' } },
            { predicate: 'produced', args: { species: 'H2O' } },
          ],
        },
      ],
      [{ id: 'f1', atom: { predicate: 'amount', args: { species: 'H2', mol: 1 } } }],
    )

    assert.equal(hints.length, 1)
    assert.equal(hints[0]?.applicable, false)
    assert.deepEqual(hints[0]?.blockedOn, { predicate: 'gte', args: { left: 1, right: 2 } })
  })

  it('orders applicable actions before blocked ones', () => {
    const target = { predicate: 'lit', args: {} }
    const candle = {
      id: 'light_candle',
      action: 'light',
      preconditions: [{ predicate: 'match', args: {} }],
      effects: [{ predicate: 'lit', args: {} }],
    }
    const torch = {
      id: 'light_torch',
      action: 'light',
      preconditions: [{ predicate: 'torch', args: {} }],
      effects: [{ predicate: 'lit', args: {} }],
    }
    const hints = abduceProducingActions(target, [torch, candle], [
      { id: 'f1', atom: { predicate: 'match', args: {} } },
    ])
    assert.deepEqual(
      hints.map((hint) => `${hint.actionNodeId}:${hint.applicable}`),
      ['light_candle:true', 'light_torch:false'],
    )
  })
})

describe('open goals surface producible-via-action hints on the board', () => {
  it('an applicable producing action is suggested with apply_action teaching', () => {
    const { store, spaceId } = freshSpace()
    const result = applyWorkingMemoryOperations(
      store,
      spaceId,
      [
        { op: 'assert_fact', id: 'h2', predicate: 'have', args: { species: 'H2' } },
        {
          op: 'define_action',
          id: 'make',
          label: 'make water',
          action: 'combust',
          preconditions: [{ predicate: 'have', args: { species: 'H2' } }],
          effects: [
            { predicate: 'have', args: { species: 'H2' }, negated: true },
            { predicate: 'have', args: { species: 'H2O' } },
          ],
        },
        {
          op: 'declare_goal',
          id: 'g1',
          label: 'obtain water',
          desired: [{ predicate: 'have', args: { species: 'H2O' } }],
        },
      ],
      { format: 'text' },
    )

    const goal = result.workingMemory.goals[0]
    assert.equal(goal?.satisfied, false)
    assert.equal(goal?.actionHints[0]?.actionNodeId, 'make')
    assert.equal(goal?.actionHints[0]?.applicable, true)

    const text = result.workingMemoryText ?? ''
    assert.match(
      text,
      /producible via action make: have\(species=H2O\) \[preconditions hold - apply_action\]/,
    )
    // The old fallback taught exactly the laundering move the derivation
    // gate blocks; with a producing action on the board it must not appear.
    assert.doesNotMatch(text, /assert the fact directly/)
  })

  it('a blocked producing action names the failing guard with values', () => {
    const { store, spaceId } = freshSpace()
    const result = applyWorkingMemoryOperations(
      store,
      spaceId,
      [
        { op: 'assert_fact', id: 'h2', predicate: 'amount', args: { species: 'H2', mol: 1 } },
        {
          op: 'define_action',
          id: 'burn1',
          label: 'consume 2 mol H2',
          action: 'combust_once',
          preconditions: [
            { predicate: 'amount', args: { species: 'H2', mol: '?h' } },
            { predicate: 'gte', args: { left: '?h', right: 2 } },
            { predicate: 'sub', args: { left: '?h', right: 2, result: '?h2' } },
          ],
          effects: [
            { predicate: 'amount', args: { species: 'H2', mol: '?h' }, negated: true },
            { predicate: 'amount', args: { species: 'H2', mol: '?h2' } },
            { predicate: 'produced', args: { species: 'H2O' } },
          ],
        },
        {
          op: 'declare_goal',
          id: 'g1',
          label: 'react',
          desired: [{ predicate: 'produced', args: { species: 'H2O' } }],
        },
      ],
      { format: 'text' },
    )

    const goal = result.workingMemory.goals[0]
    assert.equal(goal?.actionHints[0]?.applicable, false)
    assert.match(
      result.workingMemoryText ?? '',
      /producible via action burn1: produced\(species=H2O\) \[blocked on gte\(left=1, right=2\)\]/,
    )
  })

  it('rule hints and action hints coexist on the same open goal', () => {
    const { store, spaceId } = freshSpace()
    const result = applyWorkingMemoryOperations(
      store,
      spaceId,
      [
        {
          op: 'add_axiom',
          id: 'ax1',
          label: 'wet means water',
          when: [{ predicate: 'wet', args: {} }],
          then: [{ predicate: 'have', args: { species: 'H2O' } }],
        },
        {
          op: 'define_action',
          id: 'make',
          label: 'make water',
          action: 'combust',
          preconditions: [{ predicate: 'have', args: { species: 'H2' } }],
          effects: [{ predicate: 'have', args: { species: 'H2O' } }],
        },
        {
          op: 'declare_goal',
          id: 'g1',
          label: 'obtain water',
          desired: [{ predicate: 'have', args: { species: 'H2O' } }],
        },
      ],
      { format: 'text' },
    )

    const text = result.workingMemoryText ?? ''
    assert.match(text, /needs via ax1: wet\(\)/)
    assert.match(text, /producible via action make: have\(species=H2O\)/)
  })

  it('keeps the old fallback when neither a rule nor an action can produce the atom', () => {
    const { store, spaceId } = freshSpace()
    const result = applyWorkingMemoryOperations(
      store,
      spaceId,
      [
        {
          op: 'declare_goal',
          id: 'g1',
          label: 'unreachable',
          desired: [{ predicate: 'answered', args: { q: '42' } }],
        },
      ],
      { format: 'text' },
    )
    assert.match(result.workingMemoryText ?? '', /no rule derives this yet/)
  })

  it('a satisfied goal carries no action hints', () => {
    const { store, spaceId } = freshSpace()
    const result = applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'w', predicate: 'have', args: { species: 'H2O' } },
      {
        op: 'define_action',
        id: 'make',
        label: 'make water',
        action: 'combust',
        preconditions: [{ predicate: 'have', args: { species: 'H2' } }],
        effects: [{ predicate: 'have', args: { species: 'H2O' } }],
      },
      {
        op: 'declare_goal',
        id: 'g1',
        label: 'obtain water',
        desired: [{ predicate: 'have', args: { species: 'H2O' } }],
      },
    ])
    const goal = result.workingMemory.goals[0]
    assert.equal(goal?.satisfied, true)
    assert.deepEqual(goal?.actionHints, [])
  })
})
