import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { applySemanticRules } from './semantic-rules.js'

describe('applySemanticRules', () => {
  it('applies an axiom to matching predicate facts and derives new facts', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Rule closure' })
    store.addNode(space.id, {
      id: 'G1',
      type: 'goal',
      label: 'Car available at wash shop',
      semantic: {
        kind: 'goal',
        desired: [
          {
            predicate: 'must_be_at',
            args: { object: 'car', location: 'car_wash' },
          },
        ],
      },
    })
    store.addNode(space.id, {
      id: 'AX1',
      type: 'axiom',
      label: 'Service object must be at service location',
      semantic: {
        kind: 'axiom',
        when: [
          {
            predicate: 'service_on',
            args: { service: '?service', object: '?object', location: '?location' },
          },
        ],
        then: [
          {
            predicate: 'must_be_at',
            args: { object: '?object', location: '?location' },
          },
        ],
      },
    })
    store.addNode(space.id, {
      id: 'F1',
      type: 'fact',
      label: 'Wash car at shop',
      semantic: {
        kind: 'predicate',
        predicate: 'service_on',
        args: { service: 'wash', object: 'car', location: 'car_wash' },
      },
    })

    const result = applySemanticRules(store, space.id)
    const derivedFact = store.listNodes(space.id).find((node) => result.addedFactNodeIds.includes(node.id))

    assert.equal(result.appliedRuleNodeIds.includes('AX1'), true)
    assert.equal(result.addedFactNodeIds.length, 1)
    assert.equal(derivedFact?.semantic?.kind, 'predicate')
    assert.equal(derivedFact?.semantic?.predicate, 'must_be_at')
    assert.equal(derivedFact?.semantic?.args?.object, 'car')
    assert.equal(derivedFact?.semantic?.args?.location, 'car_wash')
    // Provenance lives in evidenceRefs: rule id first, then source facts.
    assert.deepEqual(derivedFact?.evidenceRefs, ['AX1', 'F1'])
    assert.deepEqual(result.satisfiedGoalNodeIds, ['G1'])
  })

  it('runs rule closure across multiple iterations without duplicating facts', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Rule chain' })
    store.addNode(space.id, {
      id: 'AX1',
      type: 'axiom',
      label: 'A implies B',
      semantic: {
        kind: 'axiom',
        when: [{ predicate: 'a', args: { item: '?x' } }],
        then: [{ predicate: 'b', args: { item: '?x' } }],
      },
    })
    store.addNode(space.id, {
      id: 'AX2',
      type: 'axiom',
      label: 'B implies C',
      semantic: {
        kind: 'axiom',
        when: [{ predicate: 'b', args: { item: '?x' } }],
        then: [{ predicate: 'c', args: { item: '?x' } }],
      },
    })
    store.addNode(space.id, {
      id: 'F1',
      type: 'fact',
      label: 'A holds',
      semantic: {
        kind: 'predicate',
        predicate: 'a',
        args: { item: 'thing' },
      },
    })

    const first = applySemanticRules(store, space.id)
    const second = applySemanticRules(store, space.id)
    const predicates = store
      .listNodes(space.id)
      .filter((node) => node.semantic?.kind === 'predicate')
      .map((node) => node.semantic?.predicate)
      .sort()

    assert.deepEqual(predicates, ['a', 'b', 'c'])
    assert.equal(first.addedFactNodeIds.length, 2)
    assert.equal(second.addedFactNodeIds.length, 0)
  })

  it('ignores rejected facts and invalidates derived facts that depend on them', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Rejected fact' })
    store.addNode(space.id, {
      id: 'AX1',
      type: 'axiom',
      label: 'A implies B',
      semantic: {
        kind: 'axiom',
        when: [{ predicate: 'a', args: { item: '?x' } }],
        then: [{ predicate: 'b', args: { item: '?x' } }],
      },
    })
    store.addNode(space.id, {
      id: 'F1',
      type: 'fact',
      label: 'A holds',
      semantic: {
        kind: 'predicate',
        predicate: 'a',
        args: { item: 'thing' },
      },
    })

    const first = applySemanticRules(store, space.id)
    assert.equal(first.addedFactNodeIds.length, 1)

    store.updateNode(space.id, 'F1', { status: 'rejected' })
    store.addNode(space.id, {
      id: 'AX2',
      type: 'axiom',
      label: 'B implies C',
      semantic: {
        kind: 'axiom',
        when: [{ predicate: 'b', args: { item: '?x' } }],
        then: [{ predicate: 'c', args: { item: '?x' } }],
      },
    })
    const second = applySemanticRules(store, space.id)

    assert.equal(second.addedFactNodeIds.length, 0)
    assert.equal(
      store.listNodes(space.id).some((node) => node.semantic?.kind === 'predicate' && node.semantic.predicate === 'c'),
      false,
    )
  })
})
