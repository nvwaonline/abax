import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { abduceMissingFacts } from './abduction.js'
import { getLogicContext } from './logic-context.js'
import { applyWorkingMemoryOperations } from './working-memory.js'

describe('abduceMissingFacts', () => {
  it('reports which body literals are missing to derive a target atom', () => {
    const hints = abduceMissingFacts(
      { predicate: 'finding', args: { kind: 'npe', function: 'render' } },
      [
        {
          id: 'AX1',
          when: [
            { predicate: 'nullable', args: { function: '?f' } },
            { predicate: 'deref_without_guard', args: { function: '?f' } },
          ],
          then: [{ predicate: 'finding', args: { kind: 'npe', function: '?f' } }],
        },
      ],
      [{ id: 'OBS1', atom: { predicate: 'nullable', args: { function: 'render' } } }],
    )

    assert.equal(hints.length, 1)
    assert.equal(hints[0]?.ruleId, 'AX1')
    assert.deepEqual(hints[0]?.missing, [
      { predicate: 'deref_without_guard', args: { function: 'render' } },
    ])
    assert.deepEqual(hints[0]?.satisfied, [
      { predicate: 'nullable', args: { function: 'render' } },
    ])
  })

  it('threads bindings across body literals when judging missing facts', () => {
    // service_on binds ?l to car_wash; the at literal must then be judged
    // under l=car_wash, so at(car, home) must NOT count as satisfying it.
    const hints = abduceMissingFacts(
      { predicate: 'can_receive_service', args: { service: 'wash', object: 'car' } },
      [
        {
          id: 'AX1',
          when: [
            { predicate: 'service_on', args: { service: '?s', object: '?o', location: '?l' } },
            { predicate: 'at', args: { object: '?o', location: '?l' } },
          ],
          then: [{ predicate: 'can_receive_service', args: { service: '?s', object: '?o' } }],
        },
      ],
      [
        {
          id: 'F1',
          atom: { predicate: 'service_on', args: { service: 'wash', object: 'car', location: 'car_wash' } },
        },
        { id: 'F2', atom: { predicate: 'at', args: { object: 'car', location: 'home' } } },
      ],
    )

    assert.equal(hints.length, 1)
    assert.deepEqual(hints[0]?.missing, [
      { predicate: 'at', args: { object: 'car', location: 'car_wash' } },
    ])
  })

  it('prefers rules that are closest to completion', () => {
    const hints = abduceMissingFacts(
      { predicate: 'goal_atom', args: { item: 'x' } },
      [
        {
          id: 'R_FAR',
          when: [
            { predicate: 'a', args: { item: '?i' } },
            { predicate: 'b', args: { item: '?i' } },
          ],
          then: [{ predicate: 'goal_atom', args: { item: '?i' } }],
        },
        {
          id: 'R_NEAR',
          when: [
            { predicate: 'c', args: { item: '?i' } },
            { predicate: 'd', args: { item: '?i' } },
          ],
          then: [{ predicate: 'goal_atom', args: { item: '?i' } }],
        },
      ],
      [{ id: 'F1', atom: { predicate: 'c', args: { item: 'x' } } }],
    )

    assert.deepEqual(
      hints.map((hint) => hint.ruleId),
      ['R_NEAR', 'R_FAR'],
    )
  })
})

describe('logic context investigation hints', () => {
  it('surfaces missing facts for open hypotheses and unsatisfied goals', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Investigation' })
    const result = applyWorkingMemoryOperations(
      store,
      space.id,
      [
        {
          op: 'declare_goal',
          id: 'G1',
          label: 'Find the finding',
          desired: [{ predicate: 'finding', args: { kind: 'npe', function: 'render' } }],
        },
        {
          op: 'declare_hypothesis',
          id: 'H1',
          predicate: 'finding',
          args: { kind: 'npe', function: 'render' },
        },
        {
          op: 'add_axiom',
          id: 'AX1',
          label: 'Nullable deref is a finding',
          when: [
            { predicate: 'nullable', args: { function: '?f' } },
            { predicate: 'deref_without_guard', args: { function: '?f' } },
          ],
          then: [{ predicate: 'finding', args: { kind: 'npe', function: '?f' } }],
        },
        { op: 'assert_fact', id: 'OBS1', predicate: 'nullable', args: { function: 'render' } },
      ],
      { format: 'text' },
    )

    const hypothesis = result.workingMemory.hypotheses[0]
    assert.equal(hypothesis?.status, 'open')
    assert.equal(hypothesis?.hints[0]?.ruleId, 'AX1')
    assert.deepEqual(hypothesis?.hints[0]?.missing, [
      { predicate: 'deref_without_guard', args: { function: 'render' } },
    ])

    const goal = result.workingMemory.goals[0]
    assert.equal(goal?.satisfied, false)
    assert.equal(goal?.hints[0]?.ruleId, 'AX1')

    assert.match(result.workingMemoryText ?? '', /needs via AX1: deref_without_guard\(function=render\)/)

    // Once the missing observation arrives, hints disappear and the goal closes.
    const closed = applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'OBS2', predicate: 'deref_without_guard', args: { function: 'render' } },
    ])
    assert.equal(closed.workingMemory.goals[0]?.satisfied, true)
    assert.deepEqual(closed.workingMemory.goals[0]?.hints, [])
    assert.equal(closed.workingMemory.hypotheses[0]?.status, 'supported')
  })
})
