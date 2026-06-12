import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { applyWorkingMemoryOperations } from '../engine/working-memory.js'
import { deriveActionEffects } from '../engine/semantic-derivation.js'
import { getLogicContext } from '../engine/logic-context.js'
import { evaluateStratifiedClosure } from './stratify.js'

/**
 * Action safety (the define_action analogue of rule safety). Before this,
 * define_action accepted anything: an effect variable not bound by any
 * precondition silently fell back to the raw atom on apply, asserting a
 * fact with a literal "?x" string — a silent wrong answer, the exact
 * failure mode the kernel's fail-visibly discipline exists to prevent.
 */

function freshSpace() {
  const store = new MemorySpaceStore()
  const space = store.createSpace({ title: 'action-safety' })
  return { store, spaceId: space.id }
}

describe('define_action safety validation', () => {
  it('rejects an effect variable not bound by any precondition', () => {
    const { store, spaceId } = freshSpace()
    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, spaceId, [
          {
            op: 'define_action',
            id: 'bad',
            label: 'unbound effect var',
            action: 'make',
            preconditions: [{ predicate: 'have', args: { x: 'a' } }],
            effects: [{ predicate: 'made', args: { v: '?unbound' } }],
          },
        ]),
      /\?unbound/,
    )
    // Nothing applied: the batch was rejected atomically.
    assert.equal(getLogicContext(store, spaceId).actions.length, 0)
  })

  it('accepts effect variables bound by preconditions (incl. arithmetic results)', () => {
    const { store, spaceId } = freshSpace()
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'a1', predicate: 'amount', args: { mol: 5 } },
      {
        op: 'define_action',
        id: 'ok',
        label: 'computed effect',
        action: 'consume2',
        preconditions: [
          { predicate: 'amount', args: { mol: '?m' } },
          { predicate: 'sub', args: { left: '?m', right: 2, result: '?m2' } },
        ],
        effects: [
          { predicate: 'amount', args: { mol: '?m' }, negated: true },
          { predicate: 'amount', args: { mol: '?m2' } },
        ],
      },
    ])
    assert.equal(getLogicContext(store, spaceId).actions.length, 1)
  })

  it('rejects built-in predicates in effects', () => {
    const { store, spaceId } = freshSpace()
    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, spaceId, [
          {
            op: 'define_action',
            id: 'bad2',
            label: 'builtin effect',
            action: 'cheat',
            preconditions: [{ predicate: 'have', args: { x: '?x' } }],
            effects: [{ predicate: 'mul', args: { left: '?x', right: 2, result: 4 } }],
          },
        ]),
      /built-in/,
    )
  })

  it('rejects arithmetic preconditions whose inputs are unbound', () => {
    const { store, spaceId } = freshSpace()
    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, spaceId, [
          {
            op: 'define_action',
            id: 'bad3',
            label: 'unbound arithmetic input',
            action: 'compute',
            preconditions: [{ predicate: 'mul', args: { left: '?u', right: '?q', result: '?t' } }],
            effects: [{ predicate: 'r', args: { t: '?t' } }],
          },
        ]),
      /not bound/,
    )
  })

  it('rejects naf preconditions with unbound variables', () => {
    const { store, spaceId } = freshSpace()
    assert.throws(
      () =>
        applyWorkingMemoryOperations(store, spaceId, [
          {
            op: 'define_action',
            id: 'bad4',
            label: 'unbound naf',
            action: 'check',
            preconditions: [{ predicate: 'blocked', args: { who: '?w' }, naf: true }],
            effects: [{ predicate: 'clear', args: {} }],
          },
        ]),
      /naf/,
    )
  })

  it('apply refuses loudly (not silently) if a stored action still has unbound effect vars', () => {
    // Defense in depth: actions created before validation existed (or via
    // direct kernel APIs) must fail loudly at apply, never assert "?x".
    const { store, spaceId } = freshSpace()
    store.addNode(spaceId, {
      id: 'legacy',
      type: 'action',
      label: 'legacy bad action',
      semantic: {
        kind: 'action',
        action: 'make',
        preconditions: [{ predicate: 'have', args: { x: 'a' } }],
        effects: [{ predicate: 'made', args: { v: '?unbound' } }],
      },
      createdBy: 'agent',
    })
    applyWorkingMemoryOperations(store, spaceId, [
      { op: 'assert_fact', id: 'f1', predicate: 'have', args: { x: 'a' } },
    ])
    assert.throws(() => deriveActionEffects(store, spaceId, 'legacy'), /\?unbound/)
    // No fact with a literal "?unbound" arg was asserted.
    const facts = getLogicContext(store, spaceId).facts
    assert.equal(facts.some((f) => Object.values(f.atom.args ?? {}).includes('?unbound')), false)
  })
})

describe('chained arithmetic literal ordering', () => {
  it('derives through arithmetic chains written out of dependency order', () => {
    // total = (a+b)*c, but the mul literal is written BEFORE the add that
    // binds its input. The matcher must order arithmetic by data
    // dependency, not source order — models cannot be expected to
    // topologically sort their own rule bodies.
    const result = evaluateStratifiedClosure({
      rules: [
        {
          id: 'chain',
          when: [
            { predicate: 'pair', args: { a: '?a', b: '?b', c: '?c' } },
            { predicate: 'mul', args: { left: '?s', right: '?c', result: '?t' } },
            { predicate: 'add', args: { left: '?a', right: '?b', result: '?s' } },
          ],
          then: [{ predicate: 'total', args: { value: '?t' } }],
        },
      ],
      facts: [{ id: 'p1', atom: { predicate: 'pair', args: { a: 2, b: 3, c: 10 } } }],
    })
    assert.deepEqual(
      result.derivations.map((d) => d.atom),
      [{ predicate: 'total', args: { value: 50 }, negated: undefined }],
    )
  })

  it('comparison guards over arithmetic results work regardless of order', () => {
    const result = evaluateStratifiedClosure({
      rules: [
        {
          id: 'guarded',
          when: [
            { predicate: 'lt', args: { left: '?double', right: 100 } },
            { predicate: 'mul', args: { left: '?x', right: 2, result: '?double' } },
            { predicate: 'value', args: { x: '?x' } },
          ],
          then: [{ predicate: 'small_double', args: { d: '?double' } }],
        },
      ],
      facts: [
        { id: 'v1', atom: { predicate: 'value', args: { x: 30 } } },
        { id: 'v2', atom: { predicate: 'value', args: { x: 60 } } },
      ],
    })
    assert.deepEqual(
      result.derivations.map((d) => d.atom.args?.d),
      [60],
    )
  })
})
