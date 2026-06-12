import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ToolRegistry, type ToolContext } from './tools.js'
import { writeTools, type WriteConfig } from './write-tools.js'

function ctxFor(rootDir: string): ToolContext {
  return { rootDir, mode: 'task', evidenceLog: new Map(), metrics: {} }
}

function setup(config: Partial<WriteConfig> = {}): { dir: string; reg: ToolRegistry; facts: Array<[string, Record<string, string>]> } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-write-'))
  writeFileSync(join(dir, 'a.txt'), 'line one\nline two\nline three\n')
  const facts: Array<[string, Record<string, string>]> = []
  const reg = new ToolRegistry()
  for (const tool of writeTools({ allowWrite: true, onProcessFact: (k, a) => facts.push([k, a]), ...config })) {
    reg.register(tool)
  }
  return { dir, reg, facts }
}

describe('edit_file', () => {
  it('rejects when writes disabled', async () => {
    const { dir, reg } = setup({ allowWrite: false })
    assert.match(await reg.invoke('edit_file', { path: 'a.txt', find: 'line one', replace: 'X' }, ctxFor(dir)), /writes are disabled/)
  })

  it('replaces a unique snippet and attests edited(file,line)', async () => {
    const { dir, reg, facts } = setup()
    const out = await reg.invoke('edit_file', { path: 'a.txt', find: 'line two', replace: 'LINE 2' }, ctxFor(dir))
    assert.match(out, /edited a\.txt at ~line 2/)
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8').split('\n')[1], 'LINE 2')
    assert.deepEqual(facts[0], ['edited', { file: 'a.txt', line: '2' }])
  })

  it('rejects non-unique and not-found snippets with reality echo', async () => {
    const { dir, reg } = setup()
    writeFileSync(join(dir, 'a.txt'), 'dup\ndup\n')
    const ctx = ctxFor(dir)
    assert.match(await reg.invoke('edit_file', { path: 'a.txt', find: 'dup', replace: 'x' }, ctx), /occurs 2 times/)
    assert.match(await reg.invoke('edit_file', { path: 'a.txt', find: 'nope', replace: 'x' }, ctx), /not found/)
    assert.equal(ctx.metrics.editRejections, 2)
  })

  it('fences path escapes', async () => {
    const { dir, reg } = setup()
    assert.match(await reg.invoke('edit_file', { path: '../x', find: 'a', replace: 'b' }, ctxFor(dir)), /escapes/)
  })
})

describe('run_check', () => {
  it('runs the configured command and attests build_status', async () => {
    const { dir, reg, facts } = setup({
      checkCmd: 'true',
      spawnImpl: (() => ({ status: 0, stdout: 'BUILD OK', stderr: '' })) as never,
    })
    const out = await reg.invoke('run_check', {}, ctxFor(dir))
    assert.match(out, /check PASS/)
    assert.deepEqual(facts.at(-1), ['build_status', { state: 'pass' }])
  })

  it('reports FAIL and attests fail state', async () => {
    const { dir, reg, facts } = setup({
      checkCmd: 'false',
      spawnImpl: (() => ({ status: 1, stdout: '', stderr: 'compile error' })) as never,
    })
    const ctx = ctxFor(dir)
    const out = await reg.invoke('run_check', {}, ctx)
    assert.match(out, /check FAIL/)
    assert.equal(ctx.metrics.checkFailures, 1)
    assert.deepEqual(facts.at(-1), ['build_status', { state: 'fail' }])
  })

  it('deep:true uses the deep command', async () => {
    const calls: string[] = []
    const { dir, reg } = setup({
      checkCmd: 'compile',
      checkDeepCmd: 'test',
      spawnImpl: ((cmd: string) => { calls.push(cmd); return { status: 0, stdout: '', stderr: '' } }) as never,
    })
    await reg.invoke('run_check', { deep: true }, ctxFor(dir))
    assert.equal(calls[0], 'test')
  })
})

describe('run_shell', () => {
  it('is disabled unless allowShell, then allowlist-gated', async () => {
    const { dir, reg } = setup({ checkCmd: 'x' })
    assert.match(await reg.invoke('run_shell', { command: 'ls' }, ctxFor(dir)), /shell is disabled/)

    const reg2 = new ToolRegistry()
    for (const tool of writeTools({
      allowShell: true,
      shellAllowlist: ['git status', 'ls'],
      spawnImpl: (() => ({ status: 0, stdout: 'output', stderr: '' })) as never,
    })) reg2.register(tool)
    const ctx = ctxFor(dir)
    assert.match(await reg2.invoke('run_shell', { command: 'rm -rf /' }, ctx), /not on the allowlist/)
    assert.match(await reg2.invoke('run_shell', { command: 'git status --short' }, ctx), /output/)
    assert.equal(ctx.metrics.shellRuns, 1)
  })
})
