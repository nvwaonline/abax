import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, it } from 'node:test'
import { ToolRegistry, fileTools, calcTool, safeEvalArithmetic, insideRoot, type ToolContext } from './tools.js'

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-tools-'))
  writeFileSync(join(dir, 'a.txt'), 'hello world\nsecond line\n}catch (e){}\n')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'b.txt'), 'nested file\n')
  return dir
}

function ctxFor(rootDir: string): ToolContext {
  return { rootDir, mode: 'task', evidenceLog: new Map(), metrics: {} }
}

describe('ToolRegistry', () => {
  it('registers, generates a prompt section, and invokes', async () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: 'echo back {text}',
      modes: ['chat', 'task'],
      run: (args) => `echoed: ${String(args.text ?? '')}`,
    })
    assert.match(reg.promptSection('chat'), /- echo: echo back/)
    const out = await reg.invoke('echo', { text: 'hi' }, ctxFor('/tmp'))
    assert.equal(out, 'echoed: hi')
  })

  it('rejects duplicate registration and unknown/wrong-mode invocation', async () => {
    const reg = new ToolRegistry()
    reg.register({ name: 't', description: 'd', modes: ['task'], run: () => 'ok' })
    assert.throws(() => reg.register({ name: 't', description: 'd2', modes: ['task'], run: () => 'x' }), /duplicate/)

    const ctx = ctxFor('/tmp')
    assert.match(await reg.invoke('missing', {}, ctx), /unknown tool/)
    const chatCtx: ToolContext = { ...ctx, mode: 'chat' }
    assert.match(await reg.invoke('t', {}, chatCtx), /not available in chat mode/)
  })

  it('applies fences and counts rejections', async () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'guarded',
      description: 'd',
      modes: ['task'],
      fence: (args) => (args.ok === true ? undefined : 'need ok:true'),
      run: () => 'ran',
    })
    const ctx = ctxFor('/tmp')
    assert.match(await reg.invoke('guarded', {}, ctx), /need ok:true/)
    assert.equal(ctx.metrics.fenceRejections, 1)
    assert.equal(await reg.invoke('guarded', { ok: true }, ctx), 'ran')
  })

  it('turns thrown errors into error strings and counts them', async () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'boom',
      description: 'd',
      modes: ['task'],
      run: () => {
        throw new Error('kaboom')
      },
    })
    const ctx = ctxFor('/tmp')
    assert.match(await reg.invoke('boom', {}, ctx), /error: kaboom/)
    assert.equal(ctx.metrics.toolErrors, 1)
  })
})

describe('calc tool / safeEvalArithmetic', () => {
  it('evaluates exact expressions with precedence and parens', () => {
    assert.equal(safeEvalArithmetic('123456 * 789012'), 97408265472)
    assert.equal(safeEvalArithmetic('2 + 3 * 4'), 14)
    assert.equal(safeEvalArithmetic('(2 + 3) * 4'), 20)
    assert.equal(safeEvalArithmetic('2 ** 10'), 1024)
    assert.equal(safeEvalArithmetic('-5 + 8'), 3)
    assert.equal(safeEvalArithmetic('17 % 5'), 2)
  })

  it('rejects non-arithmetic input and division by zero (no JS eval)', () => {
    assert.throws(() => safeEvalArithmetic('process.exit(1)'), /only numbers/)
    assert.throws(() => safeEvalArithmetic('1/0'), /division by zero/)
    assert.throws(() => safeEvalArithmetic('2 +'), /unexpected/)
  })

  it('runs as a registered tool', async () => {
    const reg = new ToolRegistry()
    reg.register(calcTool())
    const ctx = { rootDir: '/tmp', mode: 'chat' as const, evidenceLog: new Map(), metrics: {} }
    assert.match(await reg.invoke('calc', { expr: '999 * 999' }, ctx), /= 998001/)
    assert.match(await reg.invoke('calc', { expr: 'rm -rf' }, ctx), /error/)
  })
})

describe('insideRoot fence', () => {
  it('allows in-root and rejects escaping paths', () => {
    // resolve() makes the fixture root platform-correct (on Windows the old
    // literal '/work/proj' lacked a drive letter, so every resolved child
    // "escaped" it - this test only ever passed on POSIX).
    const root = resolve('/work/proj')
    const ctx = ctxFor(root)
    assert.equal(insideRoot('src/a.ts', ctx), undefined)
    assert.equal(insideRoot('.', ctx), undefined)
    assert.match(insideRoot('../secret', ctx) ?? '', /escapes/)
    assert.match(insideRoot('/etc/passwd', ctx) ?? '', /escapes/)
  })

  it('tolerates differently-spelled roots (trailing separator, forward slashes)', () => {
    const base = resolve('/work/proj')
    assert.equal(insideRoot('src/a.ts', ctxFor(base + sep)), undefined)
    assert.equal(insideRoot('src/a.ts', ctxFor(base.replaceAll('\\', '/'))), undefined)
    assert.match(insideRoot('../secret', ctxFor(base + sep)) ?? '', /escapes/)
  })
})

describe('fileTools', () => {
  it('lists, searches (logging evidence), and reads within root', async () => {
    const dir = fixtureDir()
    const reg = new ToolRegistry()
    for (const tool of fileTools()) reg.register(tool)
    const ctx = ctxFor(dir)

    const list = await reg.invoke('list_files', {}, ctx)
    assert.match(list, /a\.txt/)
    assert.match(list, /sub\/b\.txt/)

    const search = await reg.invoke('search_files', { pattern: 'second' }, ctx)
    assert.match(search, /a\.txt:2/)
    assert.equal(ctx.evidenceLog.get('second'), 1)

    // Brace literal with isRegex:false gets the metachar hint.
    const lit = await reg.invoke('search_files', { pattern: 'a|b' }, ctx)
    assert.match(lit, /isRegex/)

    const read = await reg.invoke('read_file', { path: 'a.txt', fromLine: 1, toLine: 1 }, ctx)
    assert.match(read, /1\thello world/)

    const escape = await reg.invoke('read_file', { path: '../x' }, ctx)
    assert.match(escape, /escapes/)
  })
})
