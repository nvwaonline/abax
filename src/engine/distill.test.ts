import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { applyWorkingMemoryOperations } from './working-memory.js'
import { distillSpace, seedSpace } from './distill.js'
import { projectGraph } from './project-graph.js'

describe('distillSpace / seedSpace', () => {
  it('distills portable rules and conclusions, then seeds a new space with them', () => {
    const store = new MemorySpaceStore()
    const done = store.createSpace({ id: 'space:done', title: 'Finished investigation' })
    applyWorkingMemoryOperations(store, done.id, [
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
      { op: 'assert_fact', id: 'OBS2', predicate: 'deref_without_guard', args: { function: 'render' } },
      { op: 'record_result', id: 'R1', label: 'render has an NPE risk', summary: 'Derived.' },
    ])

    const capsule = distillSpace(store, done.id)
    // Rules and conclusions survive; task-specific facts do not.
    assert.deepEqual(capsule.axioms.map((axiom) => axiom.id), ['AX1'])
    assert.deepEqual(capsule.results.map((result) => result.label), ['render has an NPE risk'])
    assert.equal(capsule.vocabulary.some((entry) => entry.startsWith('nullable(')), true)

    const next = store.createSpace({ id: 'space:next', title: 'New code review' })
    const seeded = seedSpace(store, next.id, capsule)
    // Ids are scoped per space, so the natural id carries over unchanged.
    assert.deepEqual(seeded.seededAxiomIds, ['AX1'])
    const seededId = seeded.seededAxiomIds[0] ?? ''

    // The seeded rule fires immediately on new observations.
    const result = applyWorkingMemoryOperations(store, next.id, [
      { op: 'assert_fact', id: 'N1', predicate: 'nullable', args: { function: 'parse' } },
      { op: 'assert_fact', id: 'N2', predicate: 'deref_without_guard', args: { function: 'parse' } },
    ])
    assert.equal(
      result.workingMemory.findings.some((finding) => finding.atom.args?.function === 'parse'),
      true,
    )

    // The projection shows the seed provenance and derivation edges.
    const graph = projectGraph(store, next.id)
    assert.equal(graph.edges.some((edge) => edge.kind === 'seed' && edge.to === seededId), true)
    assert.equal(
      graph.edges.some((edge) => edge.kind === 'derive' && edge.from === seededId),
      true,
    )
    assert.equal(
      graph.edges.some((edge) => edge.kind === 'supports' && edge.from === 'N1'),
      true,
    )
  })
})

describe('seedSpace boundary (self-audit #29 finding)', () => {
  it('skips unsafe and provenance-forging capsule axioms instead of planting them', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'seed target' })
    const capsule = {
      sourceSpaceId: 'src-1',
      title: 'poisoned',
      axioms: [
        {
          id: 'ok_rule',
          label: 'good',
          summary: 'fine',
          when: [{ predicate: 'a', args: { k: '?k' } }],
          then: [{ predicate: 'b', args: { k: '?k' } }],
        },
        {
          id: 'unsafe_rule',
          label: 'unbound head',
          summary: 'bad',
          when: [{ predicate: 'a', args: { k: '?k' } }],
          then: [{ predicate: 'b', args: { k: '?other' } }],
        },
        {
          id: 'derived:b|k:"x"',
          label: 'forged id',
          summary: 'bad',
          when: [{ predicate: 'a', args: { k: '?k' } }],
          then: [{ predicate: 'c', args: { k: '?k' } }],
        },
      ],
      results: [],
      vocabulary: [],
    }
    const seeded = seedSpace(store, space.id, capsule)
    assert.deepEqual(seeded.seededAxiomIds, ['ok_rule'])
    assert.equal(seeded.skipped?.length, 2)
    assert.ok(seeded.skipped?.some((s) => /unsafe_rule/.test(s)))
    assert.ok(seeded.skipped?.some((s) => /derived:/.test(s)))
    // The poisoned space must still be USABLE: closure runs clean.
    applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'F1', predicate: 'a', args: { k: 'x' } },
    ])
  })
})
