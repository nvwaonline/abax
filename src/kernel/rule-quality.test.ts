import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectVacuousRule } from './rule-quality.js'

describe('detectVacuousRule', () => {
  it('flags the name-echo passthrough seen in real runs', () => {
    const warning = detectVacuousRule({
      id: 'ax_resource_leak',
      when: [{ predicate: 'suspected_resource_leak', args: { file: '?f' } }],
      then: [{ predicate: 'finding', args: { type: 'resource_leak', file: '?f' } }],
    })
    assert.match(warning ?? '', /vacuous/)
    assert.match(warning ?? '', /renames the conclusion/)
  })

  it('flags an identity rule (same predicate and args)', () => {
    const warning = detectVacuousRule({
      id: 'ax_id',
      when: [{ predicate: 'leak', args: { file: '?f' } }],
      then: [{ predicate: 'leak', args: { file: '?f' } }],
    })
    assert.match(warning ?? '', /same predicate/)
  })

  it('does NOT flag a genuine derivation from a primitive observation', () => {
    const warning = detectVacuousRule({
      id: 'ax_swallow',
      when: [{ predicate: 'empty_catch', args: { file: '?f', line: '?l' } }],
      then: [{ predicate: 'finding', args: { type: 'swallowed_exception', file: '?f', line: '?l' } }],
    })
    assert.equal(warning, undefined)
  })

  it('does NOT flag a multi-literal conjunctive rule', () => {
    const warning = detectVacuousRule({
      id: 'ax_npe',
      when: [
        { predicate: 'nullable', args: { function: '?f' } },
        { predicate: 'deref_without_guard', args: { function: '?f' } },
      ],
      then: [{ predicate: 'finding', args: { kind: 'npe', function: '?f' } }],
    })
    assert.equal(warning, undefined)
  })

  it('does NOT flag a single-literal rule whose body is more primitive', () => {
    // "service_on" does not echo "must_be_at" — real inference.
    const warning = detectVacuousRule({
      id: 'ax_service',
      when: [{ predicate: 'service_on', args: { service: '?s', object: '?o', location: '?l' } }],
      then: [{ predicate: 'must_be_at', args: { object: '?o', location: '?l' } }],
    })
    assert.equal(warning, undefined)
  })

  it('does NOT flag a partial single-token overlap (real-run false positive)', () => {
    // Body shares "unsynchronized" with the head constant but not "access":
    // a genuine observation naturally related to its conclusion.
    const warning = detectVacuousRule({
      id: 'ax_unsync',
      when: [{ predicate: 'mutable_static_field_unsynchronized', args: { file: '?f', line: '?l' } }],
      then: [{ predicate: 'finding', args: { type: 'unsynchronized_access', file: '?f', line: '?l' } }],
    })
    assert.equal(warning, undefined)
  })

  it('still flags a full-coverage echo with reordered tokens', () => {
    const warning = detectVacuousRule({
      id: 'ax_leak_re',
      when: [{ predicate: 'leak_of_resource_detected', args: { file: '?f' } }],
      then: [{ predicate: 'finding', args: { type: 'resource_leak', file: '?f' } }],
    })
    assert.match(warning ?? '', /vacuous/)
  })
})
