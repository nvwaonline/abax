import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Tool registry for galaxy-agent (v0.1). The validated fixture
 * (examples/local-model-task.ts) keeps its inline dispatcher untouched;
 * the interactive agent runs on this registry instead, so the system
 * prompt is generated from tool specs (no "added a tool, forgot the
 * prompt" drift) and fences are first-class.
 */

export type AgentMode = 'chat' | 'task'

export interface ToolContext {
  /** Root directory tools may read; paths must not escape it. */
  rootDir: string
  /** Current agent mode (some tools are task-only). */
  mode: AgentMode
  /** Searches/fetches run this session, for absence-claim attestation. */
  evidenceLog: Map<string, number>
  /** Per-tool counters surfaced as friction metrics. */
  metrics: Record<string, number>
}

export interface ToolSpec {
  name: string
  /** One-line description; concatenated into the system prompt. */
  description: string
  /** Modes in which the tool is offered. */
  modes: AgentMode[]
  /** Return an error string to reject before run (the fence). */
  fence?: (args: Record<string, unknown>, ctx: ToolContext) => string | undefined
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>()

  register(spec: ToolSpec): this {
    if (this.tools.has(spec.name)) throw new Error(`duplicate tool: ${spec.name}`)
    this.tools.set(spec.name, spec)
    return this
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name)
  }

  forMode(mode: AgentMode): ToolSpec[] {
    return [...this.tools.values()].filter((tool) => tool.modes.includes(mode))
  }

  /** Auto-generated tool section of the system prompt for a mode. */
  promptSection(mode: AgentMode): string {
    return this.forMode(mode)
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join('\n')
  }

  /** Shallow copy so per-task tools can be added without mutating the base. */
  clone(): ToolRegistry {
    const copy = new ToolRegistry()
    for (const spec of this.tools.values()) copy.register(spec)
    return copy
  }

  async invoke(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) {
      ctx.metrics.toolErrors = (ctx.metrics.toolErrors ?? 0) + 1
      return `error: unknown tool "${name}"; available: ${this.forMode(ctx.mode).map((t) => t.name).join(', ')}`
    }
    if (!tool.modes.includes(ctx.mode)) {
      return `error: tool "${name}" is not available in ${ctx.mode} mode`
    }
    const problem = tool.fence?.(args, ctx)
    if (problem) {
      ctx.metrics.fenceRejections = (ctx.metrics.fenceRejections ?? 0) + 1
      return `error: ${problem}`
    }
    try {
      return await tool.run(args, ctx)
    } catch (error) {
      ctx.metrics.toolErrors = (ctx.metrics.toolErrors ?? 0) + 1
      return `error: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/** Shared fence: the resolved path must stay inside ctx.rootDir. */
export function insideRoot(path: string, ctx: ToolContext): string | undefined {
  // Containment via path.relative on a RESOLVED root - comparing a resolved
  // path against the raw rootDir string (the old startsWith check) broke on
  // Windows whenever the root was spelled differently than resolve() output
  // (forward slashes, trailing separator, relative root, drive-letter case):
  // every path then "escaped". relative() also handles cross-drive paths
  // (it returns an absolute path, rejected here) and is case-correct per
  // platform.
  const root = resolve(ctx.rootDir)
  const full = resolve(root, path)
  const rel = relative(root, full)
  if (rel === '') return undefined // the root itself
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return `path "${path}" escapes the working directory`
  }
  return undefined
}

const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', '.git', '.svn'])

function collectFiles(
  root: string,
  exts: string[],
): Array<{ path: string; lines: number }> {
  const out: Array<{ path: string; lines: number }> = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name)
      const stat = statSync(full, { throwIfNoEntry: false })
      if (stat?.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full)
        continue
      }
      if (!stat?.isFile()) continue
      if (exts.length > 0 && !exts.some((ext) => name.endsWith(ext))) continue
      const lines = readFileSync(full, 'utf8').split('\n').length
      out.push({ path: relative(root, full).split(sep).join('/'), lines })
    }
  }
  walk(root)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Exact calculator (both modes). The model offloads arithmetic it would
 * mis-compute mentally to a deterministic evaluator - the same "route to a
 * trusted oracle, record the attested result" principle as run_check and
 * the kernel's arithmetic built-ins, applied to free-form expressions.
 * Safe-evaluated over a tiny numeric grammar (no JS eval, no identifiers).
 */
export function calcTool(): ToolSpec {
  return {
    name: 'calc',
    description: 'evaluate an exact arithmetic expression {expr} (e.g. "123456 * 789012 + 7")',
    modes: ['chat', 'task'],
    run: (args) => {
      const expr = String(args.expr ?? '').trim()
      if (!expr) return 'error: expr is required'
      try {
        const value = safeEvalArithmetic(expr)
        return `${expr} = ${value}`
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }
}

/** Recursive-descent evaluator over +,-,*,/,%,**, parens, and numbers only. */
export function safeEvalArithmetic(input: string): number {
  let i = 0
  const s = input.replace(/\s+/g, '')
  if (!/^[-+*/%.()0-9eE]*$/.test(s)) throw new Error('only numbers and + - * / % ** ( ) are allowed')
  const peek = (): string => s[i] ?? ''
  function parseExpr(): number { // + -
    let v = parseTerm()
    while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = parseTerm(); v = op === '+' ? v + r : v - r }
    return v
  }
  function parseTerm(): number { // * / %
    let v = parsePow()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      if (s[i] === '*' && s[i + 1] === '*') break // ** handled in parsePow
      const op = s[i++]; const r = parsePow()
      if ((op === '/' || op === '%') && r === 0) throw new Error('division by zero')
      v = op === '*' ? v * r : op === '/' ? v / r : v % r
    }
    return v
  }
  function parsePow(): number { // ** (right-assoc)
    const base = parseUnary()
    if (peek() === '*' && s[i + 1] === '*') { i += 2; return base ** parsePow() }
    return base
  }
  function parseUnary(): number {
    if (peek() === '-') { i++; return -parseUnary() }
    if (peek() === '+') { i++; return parseUnary() }
    return parseAtom()
  }
  function parseAtom(): number {
    if (peek() === '(') { i++; const v = parseExpr(); if (s[i++] !== ')') throw new Error('unbalanced parens'); return v }
    const m = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/.exec(s.slice(i))
    if (!m) throw new Error(`unexpected token at "${s.slice(i, i + 8)}"`)
    i += m[0].length
    return Number(m[0])
  }
  const result = parseExpr()
  if (i !== s.length) throw new Error(`unexpected trailing input "${s.slice(i)}"`)
  if (!Number.isFinite(result)) throw new Error('result is not finite')
  return result
}

/** Read-only file tools (available in both chat and task modes). */
export function fileTools(options: { exts?: string[]; readLines?: number } = {}): ToolSpec[] {
  const exts = options.exts ?? []
  const readLines = options.readLines ?? 200
  return [
    {
      name: 'list_files',
      description: 'list readable files under the working directory with line counts',
      modes: ['chat', 'task'],
      run: (_args, ctx) =>
        collectFiles(ctx.rootDir, exts)
          .map((file) => `${file.path} (${file.lines} lines)`)
          .join('\n') || '(no files)',
    },
    {
      name: 'search_files',
      description: 'grep across files -> file:line matches {pattern, isRegex?}',
      modes: ['chat', 'task'],
      run: (args, ctx) => {
        const pattern = String(args.pattern ?? '')
        if (!pattern) return 'error: pattern is required'
        const isRegex = args.isRegex === true
        let matcher: (line: string) => boolean
        try {
          const regex = isRegex ? new RegExp(pattern) : undefined
          matcher = regex ? (line) => regex.test(line) : (line) => line.includes(pattern)
        } catch (error) {
          return `error: bad regex: ${error instanceof Error ? error.message : String(error)}`
        }
        const matches: string[] = []
        for (const { path } of collectFiles(ctx.rootDir, exts)) {
          const lines = readFileSync(resolve(ctx.rootDir, path), 'utf8').split('\n')
          for (let i = 0; i < lines.length; i += 1) {
            if (!matcher(lines[i] ?? '')) continue
            matches.push(`${path}:${i + 1}: ${(lines[i] ?? '').trim().slice(0, 160)}`)
            if (matches.length >= 80) {
              matches.push('...[truncated at 80; narrow the pattern]')
              ctx.evidenceLog.set(pattern, 80)
              return matches.join('\n')
            }
          }
        }
        ctx.evidenceLog.set(pattern, matches.length)
        const hint =
          matches.length === 0 && !isRegex && /[|\\()[\]+*?{}^$]/.test(pattern)
            ? '\n[hint: pattern has regex metacharacters but isRegex is false - matched literally; retry with isRegex:true]'
            : ''
        return (matches.length > 0 ? matches.join('\n') : 'no matches') + hint
      },
    },
    {
      name: 'read_file',
      description: `read source {path, fromLine?, toLine?}; max ${readLines} lines per call`,
      modes: ['chat', 'task'],
      fence: (args, ctx) => insideRoot(String(args.path ?? ''), ctx),
      run: (args, ctx) => {
        const path = String(args.path ?? '')
        const full = resolve(ctx.rootDir, path)
        if (!statSync(full, { throwIfNoEntry: false })?.isFile()) return `error: not a file: ${path}`
        const lines = readFileSync(full, 'utf8').split('\n')
        const from = Math.max(1, Number(args.fromLine ?? 1))
        const to = Math.min(lines.length, Number(args.toLine ?? from + readLines - 1), from + readLines - 1)
        return lines
          .slice(from - 1, to)
          .map((line, i) => `${from + i}\t${line}`)
          .join('\n')
      },
    },
  ]
}
