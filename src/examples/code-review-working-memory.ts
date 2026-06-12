import assert from 'node:assert/strict'
import { applyWorkingMemoryOperations, MemorySpaceStore } from '../index.js'

// Rules-only verification of the investigation loop: a hypothesis is
// declared, tool observations are asserted as structured facts, a rule
// combines them, the closure derives a finding(...) predicate, and the
// hypothesis is judged supported automatically.

const store = new MemorySpaceStore()
const space = store.createSpace({
  id: 'space:code-review-working-memory',
  title: 'Review nullable dereference',
  scopes: ['verify:code-review', 'project:galaxy-core'],
})

const update = applyWorkingMemoryOperations(
  store,
  space.id,
  [
    {
      op: 'declare_goal',
      id: 'G1',
      label: 'Find actionable code review findings',
      desired: [
        {
          predicate: 'finding',
          args: {
            kind: 'possible_null_deref',
            function: 'renderUserName',
            variable: 'user',
          },
        },
      ],
    },
    {
      op: 'declare_hypothesis',
      id: 'H1',
      label: 'renderUserName may dereference a null user',
      predicate: 'finding',
      args: {
        kind: 'possible_null_deref',
        function: 'renderUserName',
        variable: 'user',
      },
    },
    {
      op: 'add_axiom',
      id: 'AX_NULL_DEREF',
      label: 'Nullable value dereferenced without guard is a finding',
      when: [
        {
          predicate: 'nullable',
          args: { function: '?function', variable: '?variable' },
        },
        {
          predicate: 'dereference_without_guard',
          args: { function: '?function', variable: '?variable' },
        },
      ],
      then: [
        {
          predicate: 'finding',
          args: {
            kind: 'possible_null_deref',
            function: '?function',
            variable: '?variable',
          },
        },
      ],
    },
    {
      op: 'assert_fact',
      id: 'OBS1',
      label: 'Tool observation: user may be null',
      summary:
        'Static inspection found renderUserName(user) is called with a nullable user value.',
      predicate: 'nullable',
      args: { function: 'renderUserName', variable: 'user' },
      evidenceRefs: ['tool:inspect_call_sites'],
    },
    {
      op: 'assert_fact',
      id: 'OBS2',
      label: 'Tool observation: user.name is dereferenced without guard',
      summary:
        'File inspection found renderUserName reads user.name before a null guard.',
      predicate: 'dereference_without_guard',
      args: { function: 'renderUserName', variable: 'user' },
      evidenceRefs: ['tool:inspect_file'],
    },
  ],
  { format: 'text' },
)

assert.equal(
  update.workingMemory.findings.some(
    (finding) => finding.atom.args?.kind === 'possible_null_deref',
  ),
  true,
)
assert.deepEqual(
  update.workingMemory.hypotheses.map((hypothesis) => hypothesis.status),
  ['supported'],
)
assert.equal(update.warnings.length, 0)
assert.match(update.workingMemoryText ?? '', /possible_null_deref/)
assert.match(update.workingMemoryText ?? '', /\[supported\]/)

console.log('Code review working-memory verification passed.')
console.log(update.workingMemoryText)
