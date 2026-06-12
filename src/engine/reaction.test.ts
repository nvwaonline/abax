import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { applyWorkingMemoryOperations } from './working-memory.js'
import { getLogicContext } from './logic-context.js'
import { deriveActionEffects } from './semantic-derivation.js'
import { simulateActionEffects } from './simulate.js'

/**
 * The user's chemical-equation insight: production rules are MONOTONIC
 * (premises persist), but a reaction CONSUMES reactants and PRODUCES
 * products. That is the action layer (STRIPS delete/add effects) - dormant
 * across 23 validation rounds. These tests exercise it, boolean and
 * quantitative, the latter composing the action layer with arithmetic.
 */

describe('reaction as a transformation (action layer)', () => {
  it('boolean: consumes reactants, produces product (2H2 + O2 -> 2H2O)', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'combustion-boolean' })
    applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'h2', predicate: 'have', args: { species: 'H2' } },
      { op: 'assert_fact', id: 'o2', predicate: 'have', args: { species: 'O2' } },
      {
        op: 'define_action',
        id: 'burn',
        label: '2H2 + O2 -> 2H2O',
        action: 'combust',
        preconditions: [
          { predicate: 'have', args: { species: 'H2' } },
          { predicate: 'have', args: { species: 'O2' } },
        ],
        effects: [
          { predicate: 'have', args: { species: 'H2' }, negated: true }, // consume
          { predicate: 'have', args: { species: 'O2' }, negated: true }, // consume
          { predicate: 'have', args: { species: 'H2O' } }, // produce
        ],
      },
    ])
    deriveActionEffects(store, space.id, 'burn')
    const facts = getLogicContext(store, space.id).facts.map((f) => String(f.atom.args?.species))
    assert.ok(facts.includes('H2O'), 'product H2O should appear')
    assert.ok(!facts.includes('H2') && !facts.includes('O2'), 'reactants should be consumed')
  })

  it('quantitative: stoichiometry via arithmetic in preconditions (5 mol H2, consume 2 -> 3)', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'combustion-counted' })
    applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'h2', predicate: 'amount', args: { species: 'H2', mol: 5 } },
      { op: 'assert_fact', id: 'o2', predicate: 'amount', args: { species: 'O2', mol: 3 } },
      { op: 'assert_fact', id: 'w', predicate: 'amount', args: { species: 'H2O', mol: 0 } },
      {
        op: 'define_action',
        id: 'burn1',
        label: 'one mole of reaction: -2 H2, -1 O2, +2 H2O',
        action: 'combust_once',
        // Preconditions bind current amounts, require enough, and COMPUTE the
        // post-reaction amounts with arithmetic built-ins.
        preconditions: [
          { predicate: 'amount', args: { species: 'H2', mol: '?h' } },
          { predicate: 'gte', args: { left: '?h', right: 2 } },
          { predicate: 'amount', args: { species: 'O2', mol: '?o' } },
          { predicate: 'gte', args: { left: '?o', right: 1 } },
          { predicate: 'amount', args: { species: 'H2O', mol: '?w' } },
          { predicate: 'sub', args: { left: '?h', right: 2, result: '?h2' } },
          { predicate: 'sub', args: { left: '?o', right: 1, result: '?o2' } },
          { predicate: 'add', args: { left: '?w', right: 2, result: '?w2' } },
        ],
        // Effects revise the amounts to the computed values.
        effects: [
          { predicate: 'amount', args: { species: 'H2', mol: '?h' }, negated: true },
          { predicate: 'amount', args: { species: 'H2', mol: '?h2' } },
          { predicate: 'amount', args: { species: 'O2', mol: '?o' }, negated: true },
          { predicate: 'amount', args: { species: 'O2', mol: '?o2' } },
          { predicate: 'amount', args: { species: 'H2O', mol: '?w' }, negated: true },
          { predicate: 'amount', args: { species: 'H2O', mol: '?w2' } },
        ],
      },
    ])

    // Simulate first (the kernel's "try before commit"): it should preview the new amounts.
    const sim = simulateActionEffects(store, space.id, 'burn1')
    assert.equal(sim.applicable, true)

    deriveActionEffects(store, space.id, 'burn1')
    const amounts = Object.fromEntries(
      getLogicContext(store, space.id).facts
        .filter((f) => f.atom.predicate === 'amount')
        .map((f) => [String(f.atom.args?.species), Number(f.atom.args?.mol)]),
    )
    assert.equal(amounts.H2, 3) // 5 - 2
    assert.equal(amounts.O2, 2) // 3 - 1
    assert.equal(amounts.H2O, 2) // 0 + 2
  })

  it('refuses to react when a reactant is insufficient (gte guard fails)', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'insufficient' })
    applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'h2', predicate: 'amount', args: { species: 'H2', mol: 1 } }, // < 2
      {
        op: 'define_action',
        id: 'burn',
        label: 'needs >=2 H2',
        action: 'combust',
        preconditions: [
          { predicate: 'amount', args: { species: 'H2', mol: '?h' } },
          { predicate: 'gte', args: { left: '?h', right: 2 } },
        ],
        effects: [{ predicate: 'reacted', args: {} }],
      },
    ])
    const result = deriveActionEffects(store, space.id, 'burn')
    assert.equal(result.applied, false)
    // The diagnostic names the ACTUAL failing literal - the gte guard with
    // the bound amount substituted in - instead of listing every
    // arithmetic/guard literal as "unsatisfied" noise.
    assert.equal(result.failedPrecondition?.predicate, 'gte')
    assert.equal(result.failedPrecondition?.args?.left, 1)
    assert.equal(
      getLogicContext(store, space.id).facts.some((f) => f.atom.predicate === 'reacted'),
      false,
    )
  })
})
