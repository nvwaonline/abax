import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { deriveActionEffects } from './semantic-derivation.js'
import { applyWorkingMemoryOperations } from './working-memory.js'
import { getLogicContext } from './logic-context.js'

describe('deriveActionEffects', () => {
  it('derives action effects only when preconditions are satisfied', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Semantic wash car' })
    store.addNode(space.id, {
      id: 'G1',
      type: 'goal',
      label: 'Car at wash shop',
      semantic: {
        kind: 'goal',
        desired: [
          {
            predicate: 'at',
            args: { object: 'car', location: 'car_wash' },
          },
        ],
      },
    })
    store.addNode(space.id, {
      id: 'F1',
      type: 'fact',
      label: 'Car starts at home',
      semantic: {
        kind: 'predicate',
        predicate: 'at',
        args: { object: 'car', location: 'home' },
      },
    })
    store.addNode(space.id, {
      id: 'A1',
      type: 'action',
      label: 'Drive to car wash',
      semantic: {
        kind: 'action',
        action: 'drive',
        preconditions: [
          {
            predicate: 'at',
            args: { object: 'car', location: 'home' },
          },
        ],
        effects: [
          {
            predicate: 'at',
            args: { object: 'car', location: 'car_wash' },
          },
        ],
      },
    })

    const result = deriveActionEffects(store, space.id, 'A1')
    const fact = store.listNodes(space.id).find((node) => node.id === result.addedFactNodeIds[0])

    assert.deepEqual(result.unsatisfiedPreconditions, [])
    assert.equal(result.satisfiedGoalNodeIds.includes('G1'), true)
    assert.equal(fact?.semantic?.kind, 'predicate')
    assert.equal(fact?.semantic?.predicate, 'at')
    assert.equal(fact?.semantic?.args?.object, 'car')
    assert.equal(fact?.semantic?.args?.location, 'car_wash')
    // Provenance: the effect fact rests on the action that produced it.
    assert.deepEqual(fact?.evidenceRefs, ['A1'])
  })

  it('applies delete effects: negated effects remove the matching asserted facts', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Move with delete effect' })
    store.addNode(space.id, {
      id: 'F1',
      type: 'fact',
      label: 'Car starts at home',
      semantic: {
        kind: 'predicate',
        predicate: 'at',
        args: { object: 'car', location: 'home' },
      },
    })
    store.addNode(space.id, {
      id: 'A1',
      type: 'action',
      label: 'Drive to car wash',
      semantic: {
        kind: 'action',
        action: 'drive',
        preconditions: [{ predicate: 'at', args: { object: 'car', location: 'home' } }],
        effects: [
          { predicate: 'at', args: { object: 'car', location: 'car_wash' } },
          { predicate: 'at', args: { object: 'car', location: 'home' }, negated: true },
        ],
      },
    })

    const result = deriveActionEffects(store, space.id, 'A1')
    const nodes = store.listNodes(space.id)

    assert.deepEqual(result.removedFactNodeIds, ['F1'])
    // Consumption ARCHIVES the fact (history kept), it does not destroy it.
    const consumed = nodes.find((node) => node.id === 'F1')
    assert.equal(consumed?.status, 'archived')
    assert.equal(
      nodes.some(
        (node) =>
          node.semantic?.kind === 'predicate' &&
          node.semantic.predicate === 'at' &&
          node.semantic.args?.location === 'car_wash',
      ),
      true,
    )
    // The car is in exactly one ACTIVE place: at(car, home) left the active set.
    assert.equal(
      nodes.some(
        (node) =>
          node.status !== 'archived' &&
          node.semantic?.kind === 'predicate' &&
          node.semantic.predicate === 'at' &&
          node.semantic.args?.object === 'car' &&
          node.semantic.args?.location === 'home',
      ),
      false,
    )
    // ... and the board (active view) agrees: car_wash only.
    const activeAt = getLogicContext(store, space.id)
      .facts.filter((f) => f.atom.predicate === 'at')
      .map((f) => f.atom.args?.location)
    assert.deepEqual(activeAt, ['car_wash'])
    // The transformation left a process trail: an event result citing the action.
    const event = store.getNode(space.id, result.eventNodeId ?? '')
    assert.equal(event.type, 'result')
    assert.ok(event.evidenceRefs?.includes('A1'))
  })

  it('blocks effects when an action precondition is missing', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Blocked action' })
    store.addNode(space.id, {
      id: 'A1',
      type: 'action',
      label: 'Drive to car wash',
      semantic: {
        kind: 'action',
        action: 'drive',
        preconditions: [
          {
            predicate: 'at',
            args: { object: 'car', location: 'home' },
          },
        ],
        effects: [
          {
            predicate: 'at',
            args: { object: 'car', location: 'car_wash' },
          },
        ],
      },
    })

    const result = deriveActionEffects(store, space.id, 'A1')

    assert.equal(result.unsatisfiedPreconditions.length, 1)
    assert.deepEqual(result.addedFactNodeIds, [])
    assert.equal(store.listNodes(space.id).length, 1)
  })

  it('does not satisfy preconditions with rejected facts', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Rejected precondition' })
    store.addNode(space.id, {
      id: 'F1',
      type: 'fact',
      label: 'Car starts at home',
      status: 'rejected',
      semantic: {
        kind: 'predicate',
        predicate: 'at',
        args: { object: 'car', location: 'home' },
      },
    })
    store.addNode(space.id, {
      id: 'A1',
      type: 'action',
      label: 'Drive to car wash',
      semantic: {
        kind: 'action',
        action: 'drive',
        preconditions: [
          {
            predicate: 'at',
            args: { object: 'car', location: 'home' },
          },
        ],
        effects: [
          {
            predicate: 'at',
            args: { object: 'car', location: 'car_wash' },
          },
        ],
      },
    })

    const result = deriveActionEffects(store, space.id, 'A1')

    assert.equal(result.unsatisfiedPreconditions.length, 1)
    assert.deepEqual(result.addedFactNodeIds, [])
  })
})

describe('derived-fact evidence refresh (external review P1)', () => {
  it('keeps a derived fact alive via an alternative derivation after its first source is consumed', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'alt support' })
    applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'Fa', predicate: 'a', args: { k: 'x' } },
      { op: 'assert_fact', id: 'Falt', predicate: 'alt', args: { k: 'x' } },
      {
        op: 'add_axiom',
        id: 'ra',
        label: 'a -> b',
        when: [{ predicate: 'a', args: { k: '?k' } }],
        then: [{ predicate: 'b', args: { k: '?k' } }],
      },
      {
        op: 'add_axiom',
        id: 'rb',
        label: 'alt -> b',
        when: [{ predicate: 'alt', args: { k: '?k' } }],
        then: [{ predicate: 'b', args: { k: '?k' } }],
      },
      {
        op: 'define_action',
        id: 'eat',
        label: 'consume a',
        action: 'consume_a',
        preconditions: [{ predicate: 'a', args: { k: '?k' } }],
        effects: [{ predicate: 'a', args: { k: '?k' }, negated: true }],
      },
    ])
    const before = getLogicContext(store, space.id)
    assert.ok(before.facts.some((f) => f.atom.predicate === 'b' && f.derived))

    const result = deriveActionEffects(store, space.id, 'eat')
    assert.equal(result.applied, true)

    // b still holds: alt -> b is untouched. Stale evidence pointing at the
    // archived Fa must not hide it (usability cascades along evidenceRefs).
    const after = getLogicContext(store, space.id)
    assert.ok(
      after.facts.some((f) => f.atom.predicate === 'b' && f.derived),
      'b must survive via rb/Falt after a is consumed',
    )
    const bNode = store
      .listNodes(space.id)
      .find((n) => n.id.startsWith('derived:b'))
    assert.ok(bNode, 'derived b node must still exist')
    assert.ok(
      bNode!.evidenceRefs.includes('rb') && bNode!.evidenceRefs.includes('Falt'),
      `evidence must be refreshed to the live derivation (got ${JSON.stringify(bNode!.evidenceRefs)})`,
    )
  })
})
