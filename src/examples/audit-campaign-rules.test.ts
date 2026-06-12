/**
 * Fixture for the audit-campaign's load-bearing rules (docs/audit-campaign.md).
 * If these stop deriving, the campaign doc promises something the board no
 * longer does - so they are pinned here. Written after a dry-run caught a
 * range-restriction bug in the original verdict rule.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { applyWorkingMemoryOperations, type WorkingMemoryOperation } from '../engine/working-memory.js'
import { getLogicContext } from '../engine/logic-context.js'

describe('audit-campaign rules', () => {
  it('dismisses an authz suspicion under the single-tenant premise', () => {
    const store = new MemorySpaceStore()
    const s = store.createSpace({ title: 'dismiss' })
    applyWorkingMemoryOperations(store, s.id, [
      { op: 'assert_fact', id: 'pm', predicate: 'runtime_model', args: { value: 'single_tenant_in_process' } },
      { op: 'assert_fact', id: 'sus', predicate: 'suspicion', args: { file: 'simulate.ts', dim: 'trust_forgery', needs: 'authorization' } },
      {
        op: 'add_axiom', id: 'ax_dismiss', label: 'authz NA single-tenant',
        when: [
          { predicate: 'runtime_model', args: { value: 'single_tenant_in_process' } },
          { predicate: 'suspicion', args: { file: '?f', dim: 'trust_forgery', needs: 'authorization' } },
        ],
        then: [{ predicate: 'dismissed', args: { file: '?f', dim: 'trust_forgery', reason: 'single_tenant' } }],
      },
    ])
    const d = getLogicContext(store, s.id).facts.filter((f) => f.atom.predicate === 'dismissed' && f.derived)
    assert.equal(d.length, 1)
  })

  it('derives a cross-file finding when simulate and apply take different routes', () => {
    const store = new MemorySpaceStore()
    const s = store.createSpace({ title: 'divergence' })
    applyWorkingMemoryOperations(store, s.id, [
      { op: 'assert_fact', id: 'p1', predicate: 'path', args: { op: 'simulate', state: 'board', route: 'recompute' } },
      { op: 'assert_fact', id: 'p2', predicate: 'path', args: { op: 'apply', state: 'board', route: 'mutate' } },
      {
        op: 'add_axiom', id: 'ax_div', label: 'different routes to same state',
        when: [
          { predicate: 'path', args: { op: 'simulate', state: '?s', route: '?r1' } },
          { predicate: 'path', args: { op: 'apply', state: '?s', route: '?r2' } },
          { predicate: 'neq', args: { left: '?r1', right: '?r2' } },
        ],
        then: [{ predicate: 'finding', args: { file: 'cross:simulate+apply', kind: 'path_divergence' } }],
      },
    ])
    // Findings live under .findings, not .facts - they are task outputs.
    const fnd = getLogicContext(store, s.id).findings.filter((f) => f.derived && f.atom.predicate === 'finding')
    assert.equal(fnd.length, 1)
  })

  it('stays quiet when simulate and apply agree (no false positive)', () => {
    const store = new MemorySpaceStore()
    const s = store.createSpace({ title: 'agreement' })
    applyWorkingMemoryOperations(store, s.id, [
      { op: 'assert_fact', id: 'p1', predicate: 'path', args: { op: 'simulate', state: 'board', route: 'same' } },
      { op: 'assert_fact', id: 'p2', predicate: 'path', args: { op: 'apply', state: 'board', route: 'same' } },
      {
        op: 'add_axiom', id: 'ax_div', label: 'different routes',
        when: [
          { predicate: 'path', args: { op: 'simulate', state: '?s', route: '?r1' } },
          { predicate: 'path', args: { op: 'apply', state: '?s', route: '?r2' } },
          { predicate: 'neq', args: { left: '?r1', right: '?r2' } },
        ],
        then: [{ predicate: 'finding', args: { file: 'cross:simulate+apply', kind: 'path_divergence' } }],
      },
    ])
    assert.equal(getLogicContext(store, s.id).findings.filter((f) => f.derived).length, 0)
  })

  it('verdict rule is range-safe and blocks while a finding stands, derives when clean', () => {
    const verdictOps: WorkingMemoryOperation[] = [
      {
        op: 'add_axiom' as const, id: 'ax_flag', label: 'finding flips ground flag',
        when: [{ predicate: 'finding', args: { file: '?f', kind: '?k' } }],
        then: [{ predicate: 'has_open_finding', args: { flag: true } }],
      },
      {
        op: 'add_axiom' as const, id: 'ax_sound', label: 'sound iff swept and no open flag',
        when: [
          { predicate: 'all_files_swept', args: { value: true } },
          { predicate: 'has_open_finding', args: { flag: true }, naf: true },
        ],
        then: [{ predicate: 'project_sound', args: { scope: 'audited' } }],
      },
    ]

    // blocked while a finding stands (and the rule must not throw on safety)
    const blocked = new MemorySpaceStore()
    const b = blocked.createSpace({ title: 'blocked' })
    const r = applyWorkingMemoryOperations(blocked, b.id, [
      { op: 'assert_fact', id: 'sw', predicate: 'all_files_swept', args: { value: true } },
      { op: 'assert_fact', id: 'fd', predicate: 'finding', args: { file: 'x', kind: 'real' } },
      ...verdictOps,
    ])
    assert.deepEqual(r.warnings, [])
    assert.equal(getLogicContext(blocked, b.id).facts.filter((f) => f.atom.predicate === 'project_sound').length, 0)

    // derives when the board carries no finding
    const clean = new MemorySpaceStore()
    const c = clean.createSpace({ title: 'clean' })
    applyWorkingMemoryOperations(clean, c.id, [
      { op: 'assert_fact', id: 'sw', predicate: 'all_files_swept', args: { value: true } },
      ...verdictOps,
    ])
    assert.equal(
      getLogicContext(clean, c.id).facts.filter((f) => f.atom.predicate === 'project_sound' && f.derived).length,
      1,
    )
  })
})
