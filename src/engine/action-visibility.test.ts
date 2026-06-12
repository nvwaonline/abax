import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { applyWorkingMemoryOperations } from './working-memory.js'
import { getLogicContext } from './logic-context.js'
import { deriveActionEffects } from './semantic-derivation.js'
import { simulateActionEffects } from './simulate.js'

/**
 * Action observability: which instance an action binds, whether the choice
 * was ambiguous, what an application actually did (event trail), and WHY a
 * blocked action is blocked. The transformation itself was already correct;
 * what was missing was the ability to SEE it - the board kept end states
 * only, and failure diagnostics drowned the real cause in built-in noise.
 */

function freshSpace() {
  const store = new MemorySpaceStore()
  const space = store.createSpace({ title: 'action-visibility' })
  return { store, spaceId: space.id }
}

describe('binding visibility and ambiguity', () => {
  it('simulate and apply expose the chosen binding and candidate count', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'a1', predicate: 'item', args: { name: 'apple' } },
      { op: 'assert_fact', id: 'a2', predicate: 'item', args: { name: 'banana' } },
      {
        op: 'define_action',
        id: 'eat',
        label: 'eat one item',
        action: 'eat',
        preconditions: [{ predicate: 'item', args: { name: '?n' } }],
        effects: [
          { predicate: 'item', args: { name: '?n' }, negated: true },
          { predicate: 'ate', args: { name: '?n' } },
        ],
      },
    ])

    const sim = simulateActionEffects(store, spaceId, 'eat')
    assert.equal(sim.applicable, true)
    assert.equal(typeof sim.binding.n, 'string')
    assert.equal(sim.bindingCandidates, 2, 'two items match - the choice is ambiguous')

    const applied = deriveActionEffects(store, spaceId, 'eat')
    assert.equal(applied.applied, true)
    assert.equal(applied.bindingCandidates, 2)
    // What apply consumed is exactly what it said it bound.
    const ate = getLogicContext(store, spaceId).facts.find((f) => f.atom.predicate === 'ate')
    assert.equal(ate?.atom.args?.name, applied.binding.n)
  })

  it('simulate agrees with apply on the chosen binding (same matcher, same order)', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'a1', predicate: 'item', args: { name: 'apple' } },
      { op: 'assert_fact', id: 'a2', predicate: 'item', args: { name: 'banana' } },
      {
        op: 'define_action',
        id: 'eat',
        label: 'eat one item',
        action: 'eat',
        preconditions: [{ predicate: 'item', args: { name: '?n' } }],
        effects: [{ predicate: 'item', args: { name: '?n' }, negated: true }],
      },
    ])
    const sim = simulateActionEffects(store, spaceId, 'eat')
    const applied = deriveActionEffects(store, spaceId, 'eat')
    assert.deepEqual(applied.binding, sim.binding)
  })
})

describe('event trail (process, not just state)', () => {
  it('apply records an event result with consumed/produced/binding and provenance', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'h2', predicate: 'amount', args: { species: 'H2', mol: 5 } },
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
        ],
      },
    ])
    const applied = deriveActionEffects(store, spaceId, 'burn1')
    assert.equal(applied.applied, true)
    assert.ok(applied.eventNodeId)

    const event = store.getNode(spaceId, applied.eventNodeId!)
    assert.equal(event.type, 'result')
    assert.match(event.summary ?? '', /consumed: amount\(species=H2, mol=5\)/)
    assert.match(event.summary ?? '', /produced: amount\(species=H2, mol=3\)/)
    assert.match(event.summary ?? '', /\?h=5/)
    // Provenance: event cites the action; consumed node ids live in the
    // summary (citing archived facts would make the event itself unusable).
    assert.deepEqual(event.evidenceRefs, ['burn1'])
    assert.match(event.summary ?? '', /archived: h2/)

    // The consumed fact is archived - inspectable history, not on the active board.
    assert.equal(store.getNode(spaceId, 'h2').status, 'archived')
    const active = getLogicContext(store, spaceId).facts.filter(
      (f) => f.atom.predicate === 'amount',
    )
    assert.deepEqual(active.map((f) => f.atom.args?.mol), [3])
  })

  it('re-asserting a consumed fact later works (archive does not block re-production)', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'h2', predicate: 'have', args: { species: 'H2' } },
      {
        op: 'define_action',
        id: 'use',
        label: 'use H2',
        action: 'use',
        preconditions: [{ predicate: 'have', args: { species: 'H2' } }],
        effects: [{ predicate: 'have', args: { species: 'H2' }, negated: true }],
      },
    ])
    deriveActionEffects(store, spaceId, 'use')
    assert.equal(
      getLogicContext(store, spaceId).facts.some((f) => f.atom.predicate === 'have'),
      false,
    )
    // Produce H2 again - no idempotence collision with the archived copy.
    const result = applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'h2b', predicate: 'have', args: { species: 'H2' } },
    ])
    assert.equal(result.warnings.length, 0)
    assert.equal(
      getLogicContext(store, spaceId).facts.some((f) => f.atom.predicate === 'have'),
      true,
    )
  })

  it('double-apply does not re-consume archived facts', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'h2', predicate: 'have', args: { species: 'H2' } },
      {
        op: 'define_action',
        id: 'use',
        label: 'use H2',
        action: 'use',
        preconditions: [{ predicate: 'have', args: { species: 'H2' } }],
        effects: [{ predicate: 'have', args: { species: 'H2' }, negated: true }],
      },
    ])
    const first = deriveActionEffects(store, spaceId, 'use')
    assert.equal(first.applied, true)
    assert.deepEqual(first.removedFactNodeIds, ['h2'])
    const second = deriveActionEffects(store, spaceId, 'use')
    assert.equal(second.applied, false, 'precondition gone - blocked, nothing re-consumed')
    assert.deepEqual(second.removedFactNodeIds, [])
  })
})

describe('event visibility on the board', () => {
  it('the apply event is VISIBLE in the board results, not just stored', () => {
    // The event used to cite the consumed (archived) facts in evidenceRefs;
    // logical usability is recursive over evidence, so the event itself
    // became unusable and vanished from the board - stored but invisible.
    // A consumption event documents that the fact WAS there; its validity
    // must not rest on the consumed fact staying active.
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'h2', predicate: 'have', args: { species: 'H2' } },
      {
        op: 'define_action',
        id: 'use',
        label: 'use H2',
        action: 'use',
        preconditions: [{ predicate: 'have', args: { species: 'H2' } }],
        effects: [{ predicate: 'have', args: { species: 'H2' }, negated: true }],
      },
    ])
    const applied = deriveActionEffects(store, spaceId, 'use')
    const results = getLogicContext(store, spaceId).results
    assert.ok(
      results.some((r) => r.nodeId === applied.eventNodeId),
      `event ${applied.eventNodeId} should appear in board results (got: ${results.map((r) => r.label).join(', ') || 'none'})`,
    )
  })

  it('earlier events stay visible after later applies consume their products (#26 failure mode)', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'h2', predicate: 'amount', args: { species: 'H2', mol: 5 } },
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
        ],
      },
    ])
    const first = deriveActionEffects(store, spaceId, 'burn1') // 5 -> 3
    const second = deriveActionEffects(store, spaceId, 'burn1') // 3 -> 1, consumes first's product
    const results = getLogicContext(store, spaceId).results
    assert.ok(results.some((r) => r.nodeId === first.eventNodeId), 'first event visible')
    assert.ok(results.some((r) => r.nodeId === second.eventNodeId), 'second event visible')
  })

  it('action-effect facts are tagged [effect], closure facts stay [derived]', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'h2', predicate: 'have', args: { species: 'H2' } },
      {
        op: 'define_action',
        id: 'make',
        label: 'make water',
        action: 'make',
        preconditions: [{ predicate: 'have', args: { species: 'H2' } }],
        effects: [{ predicate: 'have', args: { species: 'H2O' } }],
      },
      {
        op: 'add_axiom',
        id: 'ax',
        label: 'water means wet',
        when: [{ predicate: 'have', args: { species: 'H2O' } }],
        then: [{ predicate: 'wet', args: {} }],
      },
    ])
    deriveActionEffects(store, spaceId, 'make')
    const facts = getLogicContext(store, spaceId).facts
    const effectFact = facts.find((f) => f.atom.args?.species === 'H2O')
    const closureFact = facts.find((f) => f.atom.predicate === 'wet')
    const assertedFact = facts.find((f) => f.atom.args?.species === 'H2')
    assert.equal(effectFact?.effect, true, 'action product is an effect fact')
    assert.equal(effectFact?.derived, false, 'action product is NOT closure-derived')
    assert.equal(closureFact?.derived, true, 'rule conclusion stays derived')
    assert.equal(assertedFact?.derived, false)
    assert.equal(assertedFact?.effect ?? false, false)
  })
})

describe('derivation gate cannot be laundered through actions', () => {
  it('a positive finding produced by an action effect still blocks record_result', () => {
    // finding(...) must be stood behind by the CLOSURE. An action effect is
    // the model's own construct - asserting a finding through apply_action
    // is the same bare claim as assert_fact, and the gate must say so.
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'h2', predicate: 'have', args: { species: 'H2' } },
      {
        op: 'define_action',
        id: 'launder',
        label: 'launder a finding',
        action: 'claim',
        preconditions: [{ predicate: 'have', args: { species: 'H2' } }],
        effects: [{ predicate: 'finding', args: { type: 'fake_issue' } }],
      },
    ])
    deriveActionEffects(store, spaceId, 'launder')
    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, spaceId, [
          { op: 'record_result', id: 'r1', label: 'done', summary: 'rests on a laundered finding' },
        ]),
      /finding/,
    )
  })
})

describe('blocked-action diagnostics name the real cause', () => {
  it('a failing guard is reported as the failing literal with values substituted', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'h2', predicate: 'amount', args: { species: 'H2', mol: 1 } },
      {
        op: 'define_action',
        id: 'burn1',
        label: 'needs 2 mol',
        action: 'combust_once',
        preconditions: [
          { predicate: 'amount', args: { species: 'H2', mol: '?h' } },
          { predicate: 'gte', args: { left: '?h', right: 2 } },
          { predicate: 'sub', args: { left: '?h', right: 2, result: '?h2' } },
        ],
        effects: [
          { predicate: 'amount', args: { species: 'H2', mol: '?h' }, negated: true },
          { predicate: 'amount', args: { species: 'H2', mol: '?h2' } },
        ],
      },
    ])
    const sim = simulateActionEffects(store, spaceId, 'burn1')
    assert.equal(sim.applicable, false)
    // The gte guard is the cause - with the bound value visible.
    assert.equal(sim.failedPrecondition?.predicate, 'gte')
    assert.equal(sim.failedPrecondition?.args?.left, 1)
    // No arithmetic-literal noise in the missing-facts list.
    assert.deepEqual(sim.unsatisfiedPreconditions, [])
  })

  it('a genuinely missing fact is reported in unsatisfied (not the guards)', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      {
        op: 'define_action',
        id: 'burn1',
        label: 'needs H2 amount',
        action: 'combust_once',
        preconditions: [
          { predicate: 'amount', args: { species: 'H2', mol: '?h' } },
          { predicate: 'gte', args: { left: '?h', right: 2 } },
        ],
        effects: [{ predicate: 'reacted', args: {} }],
      },
    ])
    const sim = simulateActionEffects(store, spaceId, 'burn1')
    assert.equal(sim.applicable, false)
    assert.equal(sim.failedPrecondition?.predicate, 'amount')
    assert.equal(sim.unsatisfiedPreconditions.length, 1)
    assert.equal(sim.unsatisfiedPreconditions[0]?.predicate, 'amount')
  })
})
