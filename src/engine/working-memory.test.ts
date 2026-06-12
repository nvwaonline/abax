import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { applyWorkingMemoryOperations } from './working-memory.js'

describe('applyWorkingMemoryOperations', () => {
  it('applies a batch of operations and returns the updated working memory', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Working memory batch' })

    const result = applyWorkingMemoryOperations(
      store,
      space.id,
      [
        {
          op: 'declare_goal',
          id: 'G1',
          label: 'Car must be at wash shop',
          desired: [
            { predicate: 'must_be_at', args: { object: 'car', location: 'car_wash' } },
          ],
        },
        {
          op: 'add_axiom',
          id: 'AX1',
          label: 'Service requires object at location',
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
        {
          op: 'assert_fact',
          id: 'F1',
          predicate: 'service_on',
          args: { service: 'wash', object: 'car', location: 'car_wash' },
        },
      ],
      { format: 'text' },
    )

    assert.equal(result.operationResults.length, 3)
    assert.equal(
      result.workingMemory.facts.some(
        (fact) => fact.atom.predicate === 'must_be_at',
      ),
      true,
    )
    assert.match(result.workingMemoryText ?? '', /must_be_at/)
  })

  it('retracts and replaces facts inside a batch before rule closure', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Working memory revision' })

    applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'add_axiom',
        id: 'AX1',
        label: 'A implies B',
        when: [{ predicate: 'a', args: { item: '?x' } }],
        then: [{ predicate: 'b', args: { item: '?x' } }],
      },
      { op: 'assert_fact', id: 'F1', predicate: 'a', args: { item: 'wrong' } },
    ])

    const result = applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'revise_fact',
        nodeId: 'F1',
        id: 'F2',
        predicate: 'a',
        args: { item: 'right' },
      },
    ])

    assert.equal(
      result.workingMemory.facts.some(
        (fact) => fact.atom.predicate === 'b' && fact.atom.args?.item === 'wrong',
      ),
      false,
    )
    assert.equal(
      result.workingMemory.facts.some(
        (fact) => fact.atom.predicate === 'b' && fact.atom.args?.item === 'right',
      ),
      true,
    )
  })

  it('physically removes retracted nodes and dependents, then re-derives what is still supported', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Working memory rebalance' })

    applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'add_axiom',
        id: 'AX_A',
        label: 'A implies B',
        when: [{ predicate: 'a', args: { item: '?x' } }],
        then: [{ predicate: 'b', args: { item: '?x' } }],
      },
      { op: 'assert_fact', id: 'F_A', predicate: 'a', args: { item: 'one' } },
      {
        op: 'add_axiom',
        id: 'AX_C',
        label: 'C implies B',
        when: [{ predicate: 'c', args: { item: '?x' } }],
        then: [{ predicate: 'b', args: { item: '?x' } }],
      },
      { op: 'assert_fact', id: 'F_C', predicate: 'c', args: { item: 'one' } },
    ])

    // b(one) was derived once (from a). Retracting a removes the node and the
    // derived b(one) physically, then the closure re-derives b(one) from c.
    const afterRetractA = applyWorkingMemoryOperations(store, space.id, [
      { op: 'retract_node', nodeId: 'F_A', reason: 'a was wrong' },
    ])
    assert.equal(afterRetractA.operationResults[0]?.retractedNodeIds.includes('F_A'), true)
    assert.equal(store.listNodes(space.id).some((node) => node.id === 'F_A'), false)
    assert.equal(
      afterRetractA.workingMemory.facts.some(
        (fact) => fact.atom.predicate === 'b' && fact.atom.args?.item === 'one',
      ),
      true,
    )

    // Retracting c as well removes the last support; b(one) disappears for good.
    const afterRetractC = applyWorkingMemoryOperations(store, space.id, [
      { op: 'retract_node', nodeId: 'F_C', reason: 'c was wrong too' },
    ])
    assert.equal(
      afterRetractC.workingMemory.facts.some((fact) => fact.atom.predicate === 'b'),
      false,
    )
    assert.equal(
      store.listNodes(space.id).every((node) => node.type === 'axiom'),
      true,
    )
  })

  it('judges hypotheses automatically after each closure', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Hypothesis lifecycle' })

    // Open while nothing supports it.
    const opened = applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'declare_hypothesis',
        id: 'H1',
        predicate: 'finding',
        args: { kind: 'possible_null_deref', function: 'renderUserName' },
      },
      {
        op: 'add_axiom',
        id: 'AX1',
        label: 'Nullable deref is a finding',
        when: [{ predicate: 'nullable', args: { function: '?f' } }],
        then: [{ predicate: 'finding', args: { kind: 'possible_null_deref', function: '?f' } }],
      },
    ])
    assert.deepEqual(
      opened.workingMemory.hypotheses.map((h) => h.status),
      ['open'],
    )

    // Supported once the closure derives the hypothesized atom.
    const supported = applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'OBS1', predicate: 'nullable', args: { function: 'renderUserName' } },
    ])
    assert.deepEqual(
      supported.workingMemory.hypotheses.map((h) => h.status),
      ['supported'],
    )

    // Refuted when the negated atom enters the working memory.
    applyWorkingMemoryOperations(store, space.id, [
      { op: 'retract_node', nodeId: 'OBS1', reason: 'observation was wrong' },
      {
        op: 'assert_fact',
        id: 'OBS2',
        predicate: 'finding',
        args: { kind: 'possible_null_deref', function: 'renderUserName' },
        negated: true,
      },
    ])
    const refuted = applyWorkingMemoryOperations(store, space.id, [])
    assert.deepEqual(
      refuted.workingMemory.hypotheses.map((h) => h.status),
      ['refuted'],
    )
  })

  it('warns when an atom deviates from the registered predicate signature', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Vocabulary drift' })

    const result = applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'F1', predicate: 'at', args: { object: 'car', location: 'home' } },
      { op: 'assert_fact', id: 'F2', predicate: 'at', args: { object: 'user', place: 'home' } },
    ])

    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0] ?? '', /signature mismatch/)
    assert.match(result.warnings[0] ?? '', /at\(location, object\)/)
    assert.equal(result.workingMemory.vocabulary.includes('at(location, object)'), true)
  })

  it('records results and conflicts, and rejects unknown operations clearly', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Conclusions' })

    const result = applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'F1', predicate: 'observed', args: { item: 'x' } },
      {
        op: 'record_result',
        id: 'R1',
        label: 'Conclusion',
        summary: 'Based on F1.',
        evidenceRefs: ['F1'],
      },
      { op: 'record_conflict', id: 'C1', label: 'Tension', summary: 'F1 is surprising.' },
    ])
    assert.equal(result.workingMemory.results.some((note) => note.nodeId === 'R1'), true)
    assert.equal(result.workingMemory.conflicts.some((note) => note.nodeId === 'C1'), true)

    // Retracting the evidence removes the conclusion that rested on it.
    const afterRetract = applyWorkingMemoryOperations(store, space.id, [
      { op: 'retract_node', nodeId: 'F1', reason: 'observation was wrong' },
    ])
    assert.equal(afterRetract.workingMemory.results.length, 0)

    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, space.id, [
          { op: 'bogus_op' } as unknown as Parameters<typeof applyWorkingMemoryOperations>[2][number],
        ]),
      /unknown op "bogus_op"; valid ops/,
    )
  })

  it('reports predicate conflicts as working-memory state', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Working memory conflict' })

    const result = applyWorkingMemoryOperations(
      store,
      space.id,
      [
        {
          op: 'assert_fact',
          id: 'F_POS',
          predicate: 'at',
          args: { object: 'car', location: 'home' },
        },
        {
          op: 'assert_fact',
          id: 'F_NEG',
          predicate: 'at',
          args: { location: 'home', object: 'car' },
          negated: true,
        },
      ],
      { format: 'text' },
    )

    assert.deepEqual(result.workingMemory.predicateConflicts, [
      {
        atom: { predicate: 'at', args: { object: 'car', location: 'home' } },
        positiveFactId: 'F_POS',
        negativeFactId: 'F_NEG',
      },
    ])
    assert.match(result.workingMemoryText ?? '', /predicate contradiction/)
    assert.match(result.workingMemoryText ?? '', /not at\(location=home, object=car\)/)
  })
})

describe('pattern hypotheses and disputed taint', () => {
  it('supports non-ground hypotheses with instances and never refutes them', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Exists finding' })

    const open = applyWorkingMemoryOperations(store, space.id, [
      { op: 'declare_hypothesis', id: 'H1', predicate: 'finding', args: { kind: '?any' } },
      {
        op: 'assert_fact',
        id: 'F_NEG',
        predicate: 'finding',
        args: { kind: 'npe' },
        negated: true,
      },
    ])
    // A negative instance does not refute an existential pattern.
    assert.equal(open.workingMemory.hypotheses[0]?.status, 'open')

    const supported = applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'F1', predicate: 'finding', args: { kind: 'race_condition' } },
    ])
    assert.equal(supported.workingMemory.hypotheses[0]?.status, 'supported')
    assert.deepEqual(supported.workingMemory.hypotheses[0]?.instances, [
      { predicate: 'finding', args: { kind: 'race_condition' }, negated: undefined },
    ])

    // Pattern goals: "any finding" satisfies the goal.
    const goal = applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'declare_goal',
        id: 'G1',
        label: 'Find anything',
        desired: [{ predicate: 'finding', args: { kind: '?k' } }],
      },
    ])
    assert.equal(goal.workingMemory.goals[0]?.satisfied, true)
  })

  it('marks conclusions resting on contradicted facts as disputed', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Contradiction taint' })

    const result = applyWorkingMemoryOperations(
      store,
      space.id,
      [
        {
          op: 'add_axiom',
          id: 'AX1',
          label: 'A implies B',
          when: [{ predicate: 'a', args: { item: '?x' } }],
          then: [{ predicate: 'b', args: { item: '?x' } }],
        },
        { op: 'assert_fact', id: 'F_POS', predicate: 'a', args: { item: 'one' } },
        { op: 'assert_fact', id: 'F_NEG', predicate: 'a', args: { item: 'one' }, negated: true },
        { op: 'assert_fact', id: 'F_OK', predicate: 'a', args: { item: 'two' } },
        { op: 'record_result', id: 'R1', label: 'Rests on b(one)', summary: 'x', evidenceRefs: ['derived:b|item:one'] },
      ],
      { format: 'text' },
    )

    const byId = new Map(result.workingMemory.facts.map((fact) => [fact.nodeId, fact]))
    // Both sides of the contradiction and the derived b(one) are disputed.
    assert.equal(byId.get('F_POS')?.disputed, true)
    assert.equal(byId.get('F_NEG')?.disputed, true)
    assert.equal(byId.get('derived:b|item:one')?.disputed, true)
    // The untouched branch is clean.
    assert.equal(byId.get('F_OK')?.disputed, undefined)
    assert.equal(byId.get('derived:b|item:two')?.disputed, undefined)
    // The result resting on the disputed derivation is disputed too.
    assert.equal(result.workingMemory.results[0]?.disputed, true)
    assert.match(result.workingMemoryText ?? '', /b\(item=one\) \[derived\] \[disputed\]/)
  })
})

describe('vocabulary with pattern atoms', () => {
  it('does not flag full-signature atoms after an existential pattern registered first', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Provisional signatures' })

    const result = applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'declare_goal',
        id: 'G1',
        label: 'Find anything',
        desired: [{ predicate: 'finding', args: { kind: '?k' } }],
      },
      {
        op: 'add_axiom',
        id: 'AX1',
        label: 'Rule with the full signature',
        when: [{ predicate: 'observed', args: { file: '?f' } }],
        then: [{ predicate: 'finding', args: { kind: 'issue', file: '?f' } }],
      },
      { op: 'assert_fact', id: 'O1', predicate: 'observed', args: { file: 'a.ts' } },
    ])
    assert.deepEqual(result.warnings, [])

    // Ground facts firm the signature; a later deviating ground fact warns.
    const drift = applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'O2', predicate: 'observed', args: { path: 'b.ts' } },
    ])
    assert.equal(drift.warnings.length, 1)
  })
})

describe('model-input tolerance', () => {
  it('normalizes the {op_name: {...}} operation shape', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Shape tolerance' })

    const result = applyWorkingMemoryOperations(store, space.id, [
      {
        assert_fact: { id: 'F1', predicate: 'observed', args: { file: 'a.ts' } },
      } as unknown as Parameters<typeof applyWorkingMemoryOperations>[2][number],
    ])
    assert.equal(
      result.workingMemory.facts.some((fact) => fact.atom.predicate === 'observed'),
      true,
    )
  })

  it('rejects string atoms and missing predicates with a readable error', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Atom validation' })

    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, space.id, [
          {
            op: 'declare_goal',
            id: 'G1',
            label: 'Bad goal',
            desired: ['finding(robustness_issue)'],
          } as unknown as Parameters<typeof applyWorkingMemoryOperations>[2][number],
        ]),
      /invalid atom in declare_goal\.desired.*"predicate"/,
    )
    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, space.id, [
          {
            op: 'declare_goal',
            id: 'G2',
            label: 'Empty goal',
            desired: [],
          },
        ]),
      /non-empty atom array/,
    )
    // Nothing was applied from the rejected batches.
    assert.equal(store.listNodes(space.id).length, 0)
  })
})

describe('derivation gate for record_result', () => {
  it('blocks record_result while a positive asserted finding is on the board, applying nothing', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Gate: board' })

    applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'F1', predicate: 'finding', args: { type: 'resource_leak', file: 'A.java' } },
    ])
    const nodesBefore = store.listNodes(space.id).length

    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, space.id, [
          { op: 'record_result', id: 'R1', label: 'Done', summary: 'audit complete' },
        ]),
      (error: Error) =>
        error.name === 'DerivationGateError' &&
        /record_result blocked/.test(error.message) &&
        /F1/.test(error.message),
    )
    assert.equal(store.listNodes(space.id).length, nodesBefore)
  })

  it('blocks a batch that asserts a finding and records a result together', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Gate: same batch' })

    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, space.id, [
          { op: 'assert_fact', id: 'F1', predicate: 'finding', args: { type: 'race' } },
          { op: 'record_result', id: 'R1', label: 'Done', summary: 'x' },
        ]),
      /asserted in this same batch.*F1/,
    )
    assert.equal(store.listNodes(space.id).length, 0)
  })

  it('passes once findings are derived, and when retraction happens in the same batch', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Gate: derived ok' })

    applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'F_BAD', predicate: 'finding', args: { type: 'leak', file: 'A.java' } },
      {
        op: 'add_axiom',
        id: 'AX1',
        label: 'no close in finally leaks',
        when: [{ predicate: 'no_close_in_finally', args: { file: '?f' } }],
        then: [{ predicate: 'finding', args: { type: 'leak', file: '?f' } }],
      },
      { op: 'assert_fact', id: 'OBS1', predicate: 'no_close_in_finally', args: { file: 'A.java' } },
    ])

    // Retract the bare claim in the same batch as record_result: gate passes,
    // and the finding survives because the closure stands behind it.
    const result = applyWorkingMemoryOperations(store, space.id, [
      { op: 'retract_node', nodeId: 'F_BAD', reason: 'replaced by observation + rule' },
      { op: 'record_result', id: 'R1', label: 'Done', summary: 'leak in A.java', evidenceRefs: ['OBS1'] },
    ])
    assert.equal(result.workingMemory.results.length, 1)
    assert.equal(
      result.workingMemory.findings.some(
        (finding) => finding.derived && finding.atom.args?.file === 'A.java',
      ),
      true,
    )
  })

  it('does not gate negated findings, finding-free boards, or record_conflict', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Gate: exemptions' })

    const result = applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'F_NEG', predicate: 'finding', args: { type: 'npe' }, negated: true },
      { op: 'assert_fact', id: 'F_OBS', predicate: 'observed', args: { item: 'x' } },
      { op: 'record_result', id: 'R1', label: 'Nothing found', summary: 'clean' },
    ])
    assert.equal(result.workingMemory.results.length, 1)

    applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'F_CLAIM', predicate: 'finding', args: { type: 'race' } },
      { op: 'record_conflict', id: 'C1', label: 'Tension', summary: 'conflicting evidence' },
    ])
    assert.equal(store.listNodes(space.id).some((node) => node.id === 'C1'), true)
  })
})

describe('placeholder and duplicate warnings', () => {
  it('hard-rejects unambiguous type-name placeholders in goals, applying nothing', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Strict placeholders' })

    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, space.id, [
          {
            op: 'declare_goal',
            id: 'G1',
            label: 'Find leaks',
            desired: [{ predicate: 'finding', args: { type: 'leak', file: 'string', line: 'number' } }],
          },
        ]),
      /file=string, line=number.*\?variable/s,
    )
    assert.equal(store.listNodes(space.id).length, 0)
  })

  it('hard-rejects alternation literals in goal args', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Pipe placeholder' })

    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, space.id, [
          {
            op: 'declare_goal',
            id: 'G1',
            label: 'Verdicts',
            desired: [{ predicate: 'verdict', args: { claim: '1', judgment: 'confirmed|refuted' } }],
          },
        ]),
      /judgment=confirmed\|refuted.*\?variable/s,
    )
  })

  it('warns (not errors) on fuzzy placeholder values', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Soft placeholders' })

    const result = applyWorkingMemoryOperations(store, space.id, [
      { op: 'declare_hypothesis', id: 'H1', predicate: 'issue', args: { kind: 'any' } },
    ])
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0] ?? '', /kind=any/)
  })

  it('does not warn on real constants or ?variables', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Real values' })

    const result = applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'declare_goal',
        id: 'G1',
        label: 'Car at wash',
        desired: [{ predicate: 'at', args: { object: 'car', location: 'car_wash' } }],
      },
      { op: 'declare_hypothesis', id: 'H1', predicate: 'finding', args: { kind: '?any' } },
    ])
    assert.deepEqual(result.warnings, [])
  })

  it('reuses the existing node when an identical fact is re-asserted (idempotent)', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Duplicates' })

    applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'O1', predicate: 'empty_catch', args: { file: 'A.java', line: '5' } },
    ])

    const acrossBatch = applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'O2', predicate: 'empty_catch', args: { line: '5', file: 'A.java' } },
    ])
    assert.equal(acrossBatch.warnings.length, 1)
    assert.match(acrossBatch.warnings[0] ?? '', /already on the board as O1/)
    // No duplicate node: the operation resolved to the existing one.
    assert.deepEqual(acrossBatch.operationResults[0]?.nodeIds, ['O1'])
    assert.equal(store.listNodes(space.id).some((node) => node.id === 'O2'), false)

    const withinBatch = applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'O3', predicate: 'empty_catch', args: { file: 'B.java', line: '9' } },
      { op: 'assert_fact', id: 'O4', predicate: 'empty_catch', args: { file: 'B.java', line: '9' } },
    ])
    assert.equal(withinBatch.warnings.length, 1)
    assert.match(withinBatch.warnings[0] ?? '', /already on the board as O3/)
    assert.equal(store.listNodes(space.id).some((node) => node.id === 'O4'), false)

    // Different args or different sign: distinct facts, no warning.
    const distinct = applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'O5', predicate: 'empty_catch', args: { file: 'A.java', line: '6' } },
      { op: 'assert_fact', id: 'O6', predicate: 'empty_catch', args: { file: 'A.java', line: '5' }, negated: true },
    ])
    assert.equal(distinct.warnings.length, 0)
  })
})

describe('node reference and id collision errors', () => {
  it('rejects retract_node without nodeId with a readable error', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Missing nodeId' })

    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, space.id, [
          { op: 'retract_node' } as unknown as Parameters<typeof applyWorkingMemoryOperations>[2][number],
        ]),
      /retract_node requires "nodeId"/,
    )
  })

  it('rejects a duplicate node id before applying anything (batch atomicity)', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Duplicate id' })

    applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'add_axiom',
        id: 'AX1',
        label: 'A implies B',
        when: [{ predicate: 'a', args: { item: '?x' } }],
        then: [{ predicate: 'b', args: { item: '?x' } }],
      },
    ])
    const nodesBefore = store.listNodes(space.id).length

    // The colliding op comes AFTER a valid one: nothing may be applied.
    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, space.id, [
          { op: 'assert_fact', id: 'F_NEW', predicate: 'a', args: { item: 'one' } },
          {
            op: 'add_axiom',
            id: 'AX1',
            label: 'Re-added axiom',
            when: [{ predicate: 'a', args: { item: '?x' } }],
            then: [{ predicate: 'b', args: { item: '?x' } }],
          },
        ]),
      /already exists on the board.*no action needed/,
    )
    assert.equal(store.listNodes(space.id).length, nodesBefore)

    // Same-batch duplicate ids are also caught.
    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, space.id, [
          { op: 'assert_fact', id: 'F1', predicate: 'a', args: { item: 'one' } },
          { op: 'assert_fact', id: 'F1', predicate: 'a', args: { item: 'two' } },
        ]),
      /already exists/,
    )
  })

  it('reuses the existing rule when an identical axiom is re-added (idempotent)', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Rule dedup' })

    applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'add_axiom',
        id: 'AX1',
        label: 'race rule',
        when: [
          { predicate: 'mutable_static_field', args: { file: '?f', line: '?l' } },
          { predicate: 'unsynchronized_mutable_static', args: { file: '?f', line: '?l' } },
        ],
        then: [{ predicate: 'finding', args: { type: 'race_condition', file: '?f', line: '?l' } }],
      },
    ])

    // Same rule, different id, body literals in a different order: reused.
    const redo = applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'add_axiom',
        id: 'AX_RACE_3',
        label: 'race rule again',
        when: [
          { predicate: 'unsynchronized_mutable_static', args: { file: '?f', line: '?l' } },
          { predicate: 'mutable_static_field', args: { file: '?f', line: '?l' } },
        ],
        then: [{ predicate: 'finding', args: { type: 'race_condition', file: '?f', line: '?l' } }],
      },
    ])
    assert.equal(redo.warnings.length, 1)
    assert.match(redo.warnings[0] ?? '', /identical rule.*AX1/)
    assert.deepEqual(redo.operationResults[0]?.nodeIds, ['AX1'])
    assert.equal(store.listNodes(space.id).some((node) => node.id === 'AX_RACE_3'), false)

    // A genuinely different rule still goes in without warnings.
    const different = applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'add_axiom',
        id: 'AX2',
        label: 'other rule',
        when: [{ predicate: 'empty_catch', args: { file: '?f', line: '?l' } }],
        then: [{ predicate: 'finding', args: { type: 'swallowed_exception', file: '?f', line: '?l' } }],
      },
    ])
    assert.deepEqual(different.warnings, [])
  })

  it('still allows retract-then-reuse of an id in one batch', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Id reuse' })

    applyWorkingMemoryOperations(store, space.id, [
      { op: 'assert_fact', id: 'O1', predicate: 'a', args: { item: 'wrong' } },
    ])
    const result = applyWorkingMemoryOperations(store, space.id, [
      { op: 'retract_node', nodeId: 'O1', reason: 'wrong' },
      { op: 'assert_fact', id: 'O1', predicate: 'a', args: { item: 'right' } },
    ])
    assert.equal(
      result.workingMemory.facts.some((fact) => fact.atom.args?.item === 'right'),
      true,
    )
  })
})

describe('vacuous rule warnings', () => {
  it('warns on a name-echo passthrough rule but still applies it', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Vacuous rule' })

    const result = applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'add_axiom',
        id: 'ax_leak',
        label: 'suspected leak is a leak',
        when: [{ predicate: 'suspected_resource_leak', args: { file: '?f' } }],
        then: [{ predicate: 'finding', args: { type: 'resource_leak', file: '?f' } }],
      },
      { op: 'assert_fact', id: 'S1', predicate: 'suspected_resource_leak', args: { file: 'A.java' } },
    ])

    assert.equal(result.warnings.some((w) => /vacuous/.test(w)), true)
    // The rule still fires — it is a warning, not a hard error.
    assert.equal(
      result.workingMemory.findings.some((f) => f.atom.args?.type === 'resource_leak'),
      true,
    )
  })

  it('does not warn on a genuine observation->finding rule', () => {
    const store = new MemorySpaceStore()
    const space = store.createSpace({ title: 'Genuine rule' })

    const result = applyWorkingMemoryOperations(store, space.id, [
      {
        op: 'add_axiom',
        id: 'ax_swallow',
        label: 'empty catch swallows',
        when: [{ predicate: 'empty_catch', args: { file: '?f', line: '?l' } }],
        then: [{ predicate: 'finding', args: { type: 'swallowed_exception', file: '?f', line: '?l' } }],
      },
    ])
    assert.equal(result.warnings.some((w) => /vacuous/.test(w)), false)
  })
})
