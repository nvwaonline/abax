import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { applyWorkingMemoryOperations } from './working-memory.js'
import { simulateActionEffects } from './simulate.js'

function carWashSpace() {
  const store = new MemorySpaceStore()
  const space = store.createSpace({ title: 'Simulated car wash' })
  applyWorkingMemoryOperations(store, space.id, [
    {
      op: 'declare_goal',
      id: 'G1',
      label: 'Car can receive wash service',
      desired: [{ predicate: 'can_receive_service', args: { service: 'wash', object: 'car' } }],
    },
    {
      op: 'add_axiom',
      id: 'AX1',
      label: 'Object at service location can receive service',
      when: [
        { predicate: 'service_on', args: { service: '?s', object: '?o', location: '?l' } },
        { predicate: 'at', args: { object: '?o', location: '?l' } },
      ],
      then: [{ predicate: 'can_receive_service', args: { service: '?s', object: '?o' } }],
    },
    {
      op: 'assert_fact',
      id: 'F1',
      predicate: 'service_on',
      args: { service: 'wash', object: 'car', location: 'car_wash' },
    },
    { op: 'assert_fact', id: 'F2', predicate: 'at', args: { object: 'car', location: 'home' } },
    { op: 'assert_fact', id: 'F3', predicate: 'at', args: { object: 'user', location: 'home' } },
    {
      op: 'define_action',
      id: 'A_WALK',
      label: 'Walk',
      action: 'walk',
      preconditions: [{ predicate: 'at', args: { object: 'user', location: 'home' } }],
      effects: [
        { predicate: 'at', args: { object: 'user', location: 'car_wash' } },
        { predicate: 'at', args: { object: 'user', location: 'home' }, negated: true },
      ],
    },
    {
      op: 'define_action',
      id: 'A_DRIVE',
      label: 'Drive',
      action: 'drive',
      preconditions: [{ predicate: 'at', args: { object: 'car', location: 'home' } }],
      effects: [
        { predicate: 'at', args: { object: 'car', location: 'car_wash' } },
        { predicate: 'at', args: { object: 'car', location: 'home' }, negated: true },
      ],
    },
  ])
  return { store, spaceId: space.id }
}

describe('simulateActionEffects', () => {
  it('compares candidate actions side by side without polluting the world', () => {
    const { store, spaceId } = carWashSpace()
    const nodesBefore = store.listNodes(spaceId).map((node) => node.id).sort()

    const walk = simulateActionEffects(store, spaceId, 'A_WALK')
    const drive = simulateActionEffects(store, spaceId, 'A_DRIVE')

    // Walking does not satisfy the goal; driving would.
    assert.deepEqual(walk.wouldSatisfyGoalIds, [])
    assert.deepEqual(drive.wouldSatisfyGoalIds, ['G1'])
    assert.equal(
      drive.newDerivedAtoms.some((atom) => atom.predicate === 'can_receive_service'),
      true,
    )
    assert.equal(drive.removedAtoms.length, 1)

    // Neither simulation touched the space.
    const nodesAfter = store.listNodes(spaceId).map((node) => node.id).sort()
    assert.deepEqual(nodesAfter, nodesBefore)
    assert.equal(
      store
        .listNodes(spaceId)
        .some(
          (node) =>
            node.semantic?.kind === 'predicate' &&
            node.semantic.args?.object === 'user' &&
            node.semantic.args?.location === 'car_wash',
        ),
      false,
    )
  })

  it('reports unsatisfied preconditions without simulating effects', () => {
    const { store, spaceId } = carWashSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'retract_node', nodeId: 'F2', reason: 'car is actually elsewhere' },
    ])

    const drive = simulateActionEffects(store, spaceId, 'A_DRIVE')
    assert.equal(drive.applicable, false)
    assert.equal(drive.unsatisfiedPreconditions.length, 1)
    assert.deepEqual(drive.addedAtoms, [])
  })

  it('reports derived atoms that would be lost when a supporting fact is deleted', () => {
    const { store, spaceId } = carWashSpace()
    // Commit-free thought experiment: driving away from the wash shop.
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'retract_node', nodeId: 'F2', reason: 'replace start state' },
      { op: 'assert_fact', id: 'F2B', predicate: 'at', args: { object: 'car', location: 'car_wash' } },
      {
        op: 'define_action',
        id: 'A_HOME',
        label: 'Drive home',
        action: 'drive_home',
        preconditions: [{ predicate: 'at', args: { object: 'car', location: 'car_wash' } }],
        effects: [
          { predicate: 'at', args: { object: 'car', location: 'home' } },
          { predicate: 'at', args: { object: 'car', location: 'car_wash' }, negated: true },
        ],
      },
    ])

    const home = simulateActionEffects(store, spaceId, 'A_HOME')
    assert.equal(
      home.lostDerivedAtoms.some((atom) => atom.predicate === 'can_receive_service'),
      true,
    )
  })
})
