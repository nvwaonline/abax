import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlSpaceStore } from './jsonl-space-store.js'
import { applyWorkingMemoryOperations } from '../engine/working-memory.js'
import { getLogicContext } from '../engine/logic-context.js'

describe('JsonlSpaceStore', () => {
  it('replays the log into the same state across instances', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'galaxy-core-')), 'wm.jsonl')

    const first = new JsonlSpaceStore(path)
    const space = first.createSpace({ id: 'space:persist', title: 'Persistence check' })
    applyWorkingMemoryOperations(first, space.id, [
      {
        op: 'add_axiom',
        id: 'AX1',
        label: 'A implies B',
        when: [{ predicate: 'a', args: { item: '?x' } }],
        then: [{ predicate: 'b', args: { item: '?x' } }],
      },
      { op: 'assert_fact', id: 'F1', predicate: 'a', args: { item: 'one' } },
      { op: 'declare_hypothesis', id: 'H1', predicate: 'b', args: { item: 'one' } },
    ])
    applyWorkingMemoryOperations(first, space.id, [
      { op: 'retract_node', nodeId: 'F1', reason: 'wrong observation' },
      { op: 'assert_fact', id: 'F2', predicate: 'a', args: { item: 'two' } },
    ])

    const second = new JsonlSpaceStore(path)
    const reloaded = getLogicContext(second, 'space:persist')

    assert.deepEqual(
      reloaded.facts.map((fact) => `${fact.atom.predicate}:${fact.atom.args?.item}`).sort(),
      ['a:two', 'b:two'],
    )
    // The hypothesis about b(one) lost its support when F1 was retracted.
    assert.equal(reloaded.hypotheses[0]?.status, 'open')

    // The reloaded store keeps working: new ops continue from the state.
    const next = applyWorkingMemoryOperations(second, 'space:persist', [
      { op: 'assert_fact', id: 'F3', predicate: 'a', args: { item: 'one' } },
    ])
    assert.equal(next.workingMemory.hypotheses[0]?.status, 'supported')
  })
})
