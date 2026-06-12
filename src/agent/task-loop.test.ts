import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { getLogicContext } from '../engine/logic-context.js'
import { ToolRegistry, fileTools } from './tools.js'
import { runAgentTask, type ChatModel } from './task-loop.js'
import type { ChatMessage } from './llm.js'

/** Scripted model that replays a fixed list of JSON tool calls. */
function scripted(script: object[]): ChatModel {
  let turn = 0
  return {
    chat: async (_messages: ChatMessage[]) =>
      JSON.stringify(script[Math.min(turn++, script.length - 1)]),
  }
}

function setup(): { store: MemorySpaceStore; reg: ToolRegistry; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-task-'))
  writeFileSync(join(dir, 'app.js', ), 'try { risky() } catch (e) {}\n')
  const reg = new ToolRegistry()
  for (const tool of fileTools()) reg.register(tool)
  return { store: new MemorySpaceStore(), reg, dir }
}

describe('runAgentTask', () => {
  it('drives the board to a recorded result and returns its summary', async () => {
    const { store, reg, dir } = setup()
    const llm = scripted([
      { tool: 'read_file', args: { path: 'app.js', fromLine: 1, toLine: 1 }, note: 'read' },
      {
        tool: 'update_working_memory',
        args: {
          operations: [
            { op: 'assert_fact', id: 'o1', predicate: 'empty_catch', args: { file: 'app.js', line: '1' }, evidenceRefs: ['app.js:1'] },
            {
              op: 'add_axiom',
              id: 'ax1',
              label: 'empty catch is swallow',
              when: [{ predicate: 'empty_catch', args: { file: '?f', line: '?l' } }],
              then: [{ predicate: 'finding', args: { type: 'swallowed_exception', file: '?f', line: '?l' } }],
            },
          ],
        },
        note: 'observe + rule',
      },
      {
        tool: 'update_working_memory',
        args: {
          operations: [
            { op: 'record_result', id: 'r1', label: 'Audit done', summary: 'one swallowed exception in app.js', evidenceRefs: ['o1'] },
          ],
        },
        note: 'conclude',
      },
      { tool: 'done', args: { summary: 'finished' }, note: 'end' },
    ])

    const seen: string[] = []
    const summary = await runAgentTask({
      store,
      llm,
      reg,
      rootDir: dir,
      goal: 'audit app.js for swallowed exceptions',
      maxTurns: 10,
      onTurn: (_t, tool) => seen.push(tool),
    })

    assert.deepEqual(seen, ['read_file', 'update_working_memory', 'update_working_memory', 'done'])
    assert.match(summary, /Audit done: one swallowed exception/)
  })

  it('aborts when the model wedges on one failing call', async () => {
    const { store, reg, dir } = setup()
    const llm = scripted([{ tool: 'read_file', args: { path: 'nope.js' }, note: 'bad' }])
    const summary = await runAgentTask({
      store,
      llm,
      reg,
      rootDir: dir,
      goal: 'x',
      maxTurns: 20,
    })
    assert.match(summary, /aborted: model wedged/)
  })

  it('handles the arithmetic + reaction formats end to end (discoverability check)', async () => {
    const { store, reg, dir } = setup()
    const llm = scripted([
      // 1. Arithmetic in a rule: derive an exact product.
      {
        tool: 'update_working_memory',
        args: {
          operations: [
            { op: 'add_axiom', id: 'ax_cost', label: 'cost=unit*qty',
              when: [{ predicate: 'line', args: { item: '?i', unit: '?u', qty: '?q' } },
                     { predicate: 'mul', args: { left: '?u', right: '?q', result: '?t' } }],
              then: [{ predicate: 'cost', args: { item: '?i', total: '?t' } }] },
            { op: 'assert_fact', id: 'L1', predicate: 'line', args: { item: 'w', unit: 1299, qty: 37 } },
          ],
        },
        note: 'arithmetic rule',
      },
      // 2. A reaction action, then apply it.
      {
        tool: 'update_working_memory',
        args: {
          operations: [
            { op: 'assert_fact', id: 'h2', predicate: 'have', args: { species: 'H2' } },
            { op: 'assert_fact', id: 'o2', predicate: 'have', args: { species: 'O2' } },
            { op: 'define_action', id: 'burn', label: '2H2+O2->2H2O', action: 'combust',
              preconditions: [{ predicate: 'have', args: { species: 'H2' } }, { predicate: 'have', args: { species: 'O2' } }],
              effects: [{ predicate: 'have', args: { species: 'H2' }, negated: true },
                        { predicate: 'have', args: { species: 'O2' }, negated: true },
                        { predicate: 'have', args: { species: 'H2O' } }] },
          ],
        },
        note: 'define reaction',
      },
      { tool: 'apply_action', args: { actionNodeId: 'burn' }, note: 'react' },
      { tool: 'done', args: { summary: 'computed and reacted' }, note: 'end' },
    ])
    const seen: Array<[string, string]> = []
    await runAgentTask({
      store, llm, reg, rootDir: dir, goal: 'compute + react', maxTurns: 10,
      onTurn: (_t, tool, result) => seen.push([tool, result]),
    })
    // Arithmetic produced an exact derived fact.
    const board = getLogicContext(store, store.listSpaces()[0]!.id)
    const cost = board.facts.find((f) => f.atom.predicate === 'cost')
    assert.equal(cost?.atom.args?.total, 1299 * 37)
    // The reaction consumed reactants and produced the product.
    const species = board.facts.filter((f) => f.atom.predicate === 'have').map((f) => String(f.atom.args?.species))
    assert.ok(species.includes('H2O') && !species.includes('H2') && !species.includes('O2'))
    assert.ok(seen.some(([t]) => t === 'apply_action'))
  })

  it('surfaces kernel invariants - a bare asserted finding blocks record_result', async () => {
    const { store, reg, dir } = setup()
    const llm = scripted([
      {
        tool: 'update_working_memory',
        args: {
          operations: [
            { op: 'assert_fact', id: 'f1', predicate: 'finding', args: { type: 'race' } },
            { op: 'record_result', id: 'r1', label: 'done', summary: 'x' },
          ],
        },
        note: 'try to smuggle',
      },
      { tool: 'done', args: { summary: 'end' }, note: 'end' },
    ])
    let firstResult = ''
    await runAgentTask({
      store,
      llm,
      reg,
      rootDir: dir,
      goal: 'x',
      maxTurns: 5,
      onTurn: (t, _tool, result) => {
        if (t === 0) firstResult = result
      },
    })
    // The derivation gate rejected the batch (kernel invariant intact through the registry path).
    assert.match(firstResult, /record_result blocked/)
  })
it('teaches naf when a strong-negated precondition matches nothing', async () => {
    // The #27 misdiagnosis shape: the model writes negated:true meaning
    // "this fact is absent" (which is naf), gets NOT applicable, and
    // concludes the action layer is inconsistent. The failure message must
    // teach the distinction at the moment of failure.
    const { store, reg, dir } = setup()
    const llm = scripted([
      {
        tool: 'update_working_memory',
        args: {
          operations: [
            { op: 'assert_fact', id: 'f1', predicate: 'have', args: { species: 'H2' } },
            {
              op: 'define_action',
              id: 'act',
              label: 'guarded go',
              action: 'go',
              preconditions: [
                { predicate: 'have', args: { species: 'H2' } },
                { predicate: 'done', args: {}, negated: true },
              ],
              effects: [{ predicate: 'went', args: {} }],
            },
          ],
        },
        note: 'set up',
      },
      { tool: 'simulate_action', args: { actionNodeId: 'act' }, note: 'preview' },
      { tool: 'apply_action', args: { actionNodeId: 'act' }, note: 'commit anyway' },
      { tool: 'done', args: { summary: 'end' }, note: 'end' },
    ])
    const results: Record<string, string> = {}
    await runAgentTask({
      store,
      llm,
      reg,
      rootDir: dir,
      goal: 'x',
      maxTurns: 8,
      onTurn: (_t, tool, result) => {
        results[tool] = result
      },
    })
    assert.match(results.simulate_action ?? '', /NOT applicable/)
    assert.match(results.simulate_action ?? '', /naf/)
    assert.match(results.apply_action ?? '', /naf/)
  })
})
