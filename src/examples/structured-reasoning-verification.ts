import assert from 'node:assert/strict'
import {
  applySemanticRules,
  applyWorkingMemoryOperations,
  deriveActionEffects,
  formatLogicContextAsText,
  getLogicContext,
  MemorySpaceStore,
  simulateActionEffects,
  type LogicContext,
  type PredicateAtom,
} from '../index.js'

// Rules-only verification of the car-wash choice task, calling the kernel
// directly (no HTTP server). Proves that walking moves the user but not the
// car, while driving moves the car to the wash shop and satisfies the goal.

const store = new MemorySpaceStore()
const space = store.createSpace({
  id: 'space:structured-car-wash',
  title: 'Decide whether to drive or walk to wash a car',
  scopes: ['verify:structured-task', 'case:car-wash'],
})

applyWorkingMemoryOperations(store, space.id, [
  {
    op: 'declare_goal',
    id: 'G1',
    label: 'Car can receive wash service',
    summary: 'Find the travel option that lets the car receive the wash service.',
    desired: [
      { predicate: 'can_receive_service', args: { service: 'wash', object: 'car' } },
    ],
  },
  {
    op: 'add_axiom',
    id: 'AX1',
    label: 'Service requires object at service location',
    when: [
      {
        predicate: 'service_on',
        args: { service: '?service', object: '?object', location: '?location' },
      },
    ],
    then: [
      {
        predicate: 'service_requires_location',
        args: { service: '?service', object: '?object', location: '?location' },
      },
    ],
  },
  {
    op: 'add_axiom',
    id: 'AX2',
    label: 'Object at required location can receive service',
    when: [
      {
        predicate: 'service_requires_location',
        args: { service: '?service', object: '?object', location: '?location' },
      },
      { predicate: 'at', args: { object: '?object', location: '?location' } },
    ],
    then: [
      {
        predicate: 'can_receive_service',
        args: { service: '?service', object: '?object' },
      },
    ],
  },
  {
    op: 'assert_fact',
    id: 'F1',
    label: 'Wash service is for the car at the wash shop',
    predicate: 'service_on',
    args: { service: 'wash', object: 'car', location: 'car_wash' },
  },
  {
    op: 'assert_fact',
    id: 'F_WRONG',
    label: 'Mistaken claim: car is already at the wash shop',
    predicate: 'at',
    args: { object: 'car', location: 'car_wash' },
  },
])

// The mistaken fact lets the closure derive goal satisfaction too early.
assert.equal(hasActiveFact(store, space.id, {
  predicate: 'can_receive_service',
  args: { service: 'wash', object: 'car' },
}), true)

// Truth maintenance: retract the wrong fact; the derived conclusion must
// disappear with it.
applyWorkingMemoryOperations(store, space.id, [
  {
    op: 'retract_node',
    nodeId: 'F_WRONG',
    reason: 'The car is not already at the wash shop; the model asserted this too early.',
  },
  {
    op: 'assert_fact',
    id: 'F2',
    label: 'Car starts at home',
    predicate: 'at',
    args: { object: 'car', location: 'home' },
  },
  {
    op: 'assert_fact',
    id: 'F3',
    label: 'User starts at home',
    predicate: 'at',
    args: { object: 'user', location: 'home' },
  },
  {
    op: 'assert_fact',
    id: 'F4',
    label: 'The wash shop is 100 meters away',
    predicate: 'distance',
    args: { from: 'home', to: 'car_wash', meters: 100 },
  },
  {
    op: 'define_action',
    id: 'A_WALK',
    label: 'Walk to the wash shop',
    action: 'walk_to_car_wash',
    preconditions: [{ predicate: 'at', args: { object: 'user', location: 'home' } }],
    effects: [
      { predicate: 'at', args: { object: 'user', location: 'car_wash' } },
      { predicate: 'at', args: { object: 'user', location: 'home' }, negated: true },
    ],
  },
  {
    op: 'define_action',
    id: 'A_DRIVE',
    label: 'Drive the car to the wash shop',
    action: 'drive_car_to_car_wash',
    preconditions: [{ predicate: 'at', args: { object: 'car', location: 'home' } }],
    effects: [
      { predicate: 'at', args: { object: 'car', location: 'car_wash' } },
      { predicate: 'at', args: { object: 'car', location: 'home' }, negated: true },
    ],
  },
])
assert.equal(hasActiveFact(store, space.id, {
  predicate: 'can_receive_service',
  args: { service: 'wash', object: 'car' },
}), false)

// A guarded built-in: short distances are walkable. The closure derives
// walkable(home, car_wash) from distance(meters=100) and lte.
applyWorkingMemoryOperations(store, space.id, [
  {
    op: 'add_axiom',
    id: 'AX3',
    label: 'Short distances are walkable',
    when: [
      { predicate: 'distance', args: { from: '?f', to: '?t', meters: '?m' } },
      { predicate: 'lte', args: { left: '?m', right: 500 } },
    ],
    then: [{ predicate: 'walkable', args: { from: '?f', to: '?t' } }],
  },
])
assert.equal(hasActiveFact(store, space.id, {
  predicate: 'walkable',
  args: { from: 'home', to: 'car_wash' },
}), true)

// Compare both candidate actions by simulation — neither commits, so the
// trial moves do not pollute the world.
const walkSim = simulateActionEffects(store, space.id, 'A_WALK')
const driveSim = simulateActionEffects(store, space.id, 'A_DRIVE')
assert.deepEqual(walkSim.wouldSatisfyGoalIds, [])
assert.deepEqual(driveSim.wouldSatisfyGoalIds, ['G1'])
// The simulation did not move anyone: the user is still at home.
assert.equal(hasActiveFact(store, space.id, {
  predicate: 'at',
  args: { object: 'user', location: 'home' },
}), true)

// Commit only the chosen action. The delete effect removes at(car, home),
// so the car is in exactly one place, and AX2 derives goal satisfaction.
const driveDerivation = deriveActionEffects(store, space.id, 'A_DRIVE')
const ruleApplication = applySemanticRules(store, space.id)
assert.equal(driveDerivation.addedFactNodeIds.length, 1)
assert.equal(driveDerivation.removedFactNodeIds.length, 1)
assert.equal(hasActiveFact(store, space.id, {
  predicate: 'at',
  args: { object: 'car', location: 'home' },
}), false)
// The user never walked: still at home after the commit.
assert.equal(hasActiveFact(store, space.id, {
  predicate: 'at',
  args: { object: 'user', location: 'home' },
}), true)
assert.equal(ruleApplication.appliedRuleNodeIds.includes('AX2'), true)

const goalFact = findActiveFact(store, space.id, {
  predicate: 'can_receive_service',
  args: { service: 'wash', object: 'car' },
})
assert.notEqual(goalFact, undefined)

// Record the conflict and the final result, then ground them in the graph.
store.addNode(space.id, {
  id: 'C1',
  type: 'conflict',
  label: 'Walking moves the user but not the car',
  summary:
    'Walking can move the user to the shop, but the wash service needs the car at the shop.',
  status: 'verified',
  confidence: 0.95,
  createdBy: 'agent',
})
store.addNode(space.id, {
  id: 'R1',
  type: 'result',
  label: 'Drive, not walk',
  summary:
    'The structured facts show that walking only moves the user, while driving moves the car to the wash shop and enables the car to receive the wash service.',
  status: 'verified',
  confidence: 0.98,
  evidenceRefs: ['A_DRIVE', goalFact?.nodeId ?? ''],
  createdBy: 'agent',
})

const logic = getLogicContext(store, space.id)
assert.equal(logic.results.some((result) => result.nodeId === 'R1'), true)
assert.equal(logic.facts.some((fact) => fact.atom.predicate === 'can_receive_service'), true)
assert.equal(logic.conflicts.some((conflict) => conflict.nodeId === 'C1'), true)

console.log('Structured reasoning verification passed.')
console.log('Answer: drive the car to the wash shop; walking does not move the car.')
console.log(formatLogicContextAsText(logic))

function hasActiveFact(s: MemorySpaceStore, spaceId: string, atom: PredicateAtom): boolean {
  return findActiveFact(s, spaceId, atom) !== undefined
}

function findActiveFact(
  s: MemorySpaceStore,
  spaceId: string,
  atom: PredicateAtom,
): LogicContext['facts'][number] | undefined {
  return getLogicContext(s, spaceId).facts.find(
    (fact) =>
      fact.atom.predicate === atom.predicate &&
      JSON.stringify(sortRecord(fact.atom.args ?? {})) ===
        JSON.stringify(sortRecord(atom.args ?? {})),
  )
}

function sortRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  )
}
