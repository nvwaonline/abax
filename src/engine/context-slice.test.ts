import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { applyWorkingMemoryOperations } from './working-memory.js'
import { getLogicContext } from './logic-context.js'
import { sliceLogicContext } from './context-slice.js'
import type { WorkingMemoryOperation } from './working-memory.js'

function bigBoard(): MemorySpaceStore {
  const store = new MemorySpaceStore()
  const space = store.createSpace({ id: 'big', title: 'big' })
  const ops: WorkingMemoryOperation[] = [
    {
      op: 'declare_goal',
      id: 'g1',
      label: 'find leaks in Target.java',
      desired: [{ predicate: 'leak', args: { file: 'Target.java', line: '?l' } }],
    },
  ]
  // 50 relevant facts (predicate "leak" in Target.java) + 50 noise facts.
  for (let i = 0; i < 50; i += 1) {
    ops.push({ op: 'assert_fact', id: `rel${i}`, predicate: 'leak', args: { file: 'Target.java', line: String(i) } })
    ops.push({ op: 'assert_fact', id: `noise${i}`, predicate: 'style', args: { file: 'Other.java', rule: `r${i}` } })
  }
  applyWorkingMemoryOperations(store, space.id, ops)
  return store
}

describe('sliceLogicContext', () => {
  it('is a no-op when everything fits', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 's' })
    applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'f1', predicate: 'a', args: { x: '1' } },
    ])
    const full = getLogicContext(store, space.id)
    assert.strictEqual(sliceLogicContext(full, { maxFacts: 60 }), full)
  })

  it('keeps goal-relevant facts and drops noise under budget', () => {
    const full = getLogicContext(bigBoard(), 'big')
    assert.equal(full.facts.length, 100)

    const sliced = sliceLogicContext(full, { maxFacts: 40 })
    assert.equal(sliced.facts.length, 40)
    assert.equal(sliced.stats.facts, 40)
    // All kept facts should be the goal-relevant "leak"/Target.java ones.
    const relevantKept = sliced.facts.filter((f) => f.atom.predicate === 'leak').length
    assert.ok(relevantKept >= 38, `expected mostly relevant facts, got ${relevantKept}/40`)
    // Board order is preserved (ascending node creation order via line numbers).
    const lines = sliced.facts.map((f) => Number(f.atom.args?.line)).filter((n) => !Number.isNaN(n))
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b))
  })

  it('pins a predicate regardless of relevance', () => {
    const full = getLogicContext(bigBoard(), 'big')
    const sliced = sliceLogicContext(full, { maxFacts: 10, pinPredicates: ['style'] })
    // "style" facts are noise to the goal but pinned, so they dominate.
    assert.ok(sliced.facts.some((f) => f.atom.predicate === 'style'))
  })

  it('does not mutate the input context', () => {
    const full = getLogicContext(bigBoard(), 'big')
    const before = full.facts.length
    sliceLogicContext(full, { maxFacts: 5 })
    assert.equal(full.facts.length, before)
  })
})
