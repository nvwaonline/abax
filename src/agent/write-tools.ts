import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { insideRoot, type ToolSpec, type ToolContext } from './tools.js'

/**
 * Write + shell tools (v0.2). Carries over the fences proven across
 * verification #16-#22: writes are opt-in (ALLOW_WRITE), edit_file needs a
 * verbatim unique snippet (editing analogue of quote attestation - you
 * can't change what you can't quote), run_check/run_shell execute only
 * operator-configured commands (zero injection surface). On a successful
 * edit the harness attests edited(file,line); run_check maintains
 * build_status(state) - the model derives fixed(...) rather than claiming it.
 */

export interface WriteConfig {
  allowWrite?: boolean
  allowShell?: boolean
  /** Fast check (compile). */
  checkCmd?: string
  /** Deep check (tests); falls back to checkCmd. */
  checkDeepCmd?: string
  checkTimeoutMs?: number
  /** Shell command prefixes the model may run (e.g. ["git status", "ls"]). */
  shellAllowlist?: string[]
  shellTimeoutMs?: number
  /** Test hook to assert machine facts onto the board. */
  onProcessFact?: (
    kind: 'edited' | 'build_status',
    args: Record<string, string>,
  ) => void
  /** UI hook: a file edit with its diff stat + an id for undo, for edit cards. */
  onEdit?: (edit: { editId: string; path: string; line: number; added: number; removed: number }) => void
  /** Undo journal: called BEFORE a write with the prior content so it can be reverted. */
  onSnapshot?: (snapshot: { editId: string; path: string; fullPath: string; before: string }) => void
  /** UI hook: a check run with its verdict. */
  onCheck?: (check: { deep: boolean; passed: boolean; output: string }) => void
  spawnImpl?: typeof spawnSync
}

export function writeTools(config: WriteConfig): ToolSpec[] {
  const spawn = config.spawnImpl ?? spawnSync
  const checkTimeout = config.checkTimeoutMs ?? 300000
  const shellTimeout = config.shellTimeoutMs ?? 60000
  const shellAllowlist = config.shellAllowlist ?? []
  const tools: ToolSpec[] = []

  tools.push({
    name: 'edit_file',
    description: 'replace an EXACT unique snippet {path, find, replace}; copy find verbatim from read_file',
    modes: ['task'],
    fence: (args, ctx) => {
      if (!config.allowWrite) return 'writes are disabled; operator must enable write access (and use a snapshot copy)'
      return insideRoot(String(args.path ?? ''), ctx)
    },
    run: (args, ctx) => {
      const path = String(args.path ?? '')
      const find = String(args.find ?? '')
      const replace = String(args.replace ?? '')
      const full = resolve(ctx.rootDir, path)
      if (!statSync(full, { throwIfNoEntry: false })?.isFile()) return `error: not a file: ${path}`
      if (!find) return 'error: "find" is required: the exact snippet to replace'
      const text = readFileSync(full, 'utf8')
      const count = text.split(find).length - 1
      if (count === 0) {
        ctx.metrics.editRejections = (ctx.metrics.editRejections ?? 0) + 1
        const lines = text.split('\n')
        const anchor = find.split('\n').find((p) => p.trim().length >= 6) ?? ''
        const idx = lines.findIndex((p) => anchor.trim().length >= 6 && p.includes(anchor.trim().slice(0, 24)))
        const reality =
          idx >= 0
            ? `\nClosest anchor at line ${idx + 1}; file actually reads:\n` +
              lines.slice(Math.max(0, idx - 1), idx + 6).map((p, i) => `${Math.max(0, idx - 1) + i + 1}\t${p}`).join('\n')
            : ' Re-read the target region first.'
        return `error: "find" snippet not found in ${path} (whitespace matters).${reality}`
      }
      if (count > 1) {
        ctx.metrics.editRejections = (ctx.metrics.editRejections ?? 0) + 1
        return `error: "find" occurs ${count} times in ${path}; add surrounding lines to make it unique`
      }
      const line = text.slice(0, text.indexOf(find)).split('\n').length
      const editId = `e${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
      config.onSnapshot?.({ editId, path, fullPath: full, before: text })
      writeFileSync(full, text.replace(find, replace), 'utf8')
      ctx.metrics.edits = (ctx.metrics.edits ?? 0) + 1
      const removed = find.split('\n').length
      const added = replace.split('\n').length
      config.onProcessFact?.('edited', { file: path.split('/').pop() ?? path, line: String(line) })
      config.onEdit?.({ editId, path, line, added, removed })
      return `edited ${path} at ~line ${line} (+${added} -${removed}). Line numbers below shifted - re-read before further edits. Run run_check to validate.`
    },
  })

  tools.push({
    name: 'write_file',
    description: 'create or overwrite a file {path, content} (small files)',
    modes: ['task'],
    fence: (args, ctx) => {
      if (!config.allowWrite) return 'writes are disabled; operator must enable write access'
      return insideRoot(String(args.path ?? ''), ctx)
    },
    run: (args, ctx) => {
      const path = String(args.path ?? '')
      const content = String(args.content ?? '')
      if (content.length > 200_000) return 'error: content too large (200KB cap); use edit_file'
      const full = resolve(ctx.rootDir, path)
      const existed = statSync(full, { throwIfNoEntry: false })?.isFile() === true
      const editId = `w${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
      config.onSnapshot?.({ editId, path, fullPath: full, before: existed ? readFileSync(full, 'utf8') : '\0NEW' })
      writeFileSync(full, content, 'utf8')
      ctx.metrics.writes = (ctx.metrics.writes ?? 0) + 1
      return `${existed ? 'overwrote' : 'created'} ${path} (${content.split('\n').length} lines)`
    },
  })

  tools.push({
    name: 'run_check',
    description: `run the configured build/test {deep?}; deep:true runs full tests${config.checkCmd ? '' : ' (NOT CONFIGURED)'}`,
    modes: ['task'],
    fence: () => (config.allowWrite ? undefined : 'run_check is part of the write toolset; enable write access'),
    run: (args, ctx) => {
      const deep = args.deep === true
      const command = deep ? config.checkDeepCmd || config.checkCmd : config.checkCmd
      if (!command) return 'error: no check command configured'
      ctx.metrics.checks = (ctx.metrics.checks ?? 0) + 1
      const out = spawn(command, { shell: true, cwd: ctx.rootDir, timeout: checkTimeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      const passed = out.status === 0
      if (!passed) ctx.metrics.checkFailures = (ctx.metrics.checkFailures ?? 0) + 1
      config.onProcessFact?.('build_status', { state: passed ? 'pass' : 'fail' })
      const text = `${out.stdout ?? ''}\n${out.stderr ?? ''}`.trim()
      config.onCheck?.({ deep, passed, output: text.slice(0, 4000) })
      return `check${deep ? ' (deep)' : ''} ${passed ? 'PASS' : `FAIL (exit ${out.status ?? 'spawn error'})`}\n${text.slice(0, 4000) || '(no output)'}`
    },
  })

  tools.push({
    name: 'run_shell',
    description: `run an allowlisted shell command {command}; allowed: ${shellAllowlist.join(' | ') || '(none configured)'}`,
    modes: ['task'],
    fence: (args) => {
      if (!config.allowShell) return 'shell is disabled; operator must enable it'
      const command = String(args.command ?? '').trim()
      if (!command) return 'command is required'
      if (!shellAllowlist.some((prefix) => command === prefix || command.startsWith(`${prefix} `))) {
        return `command not on the allowlist; allowed prefixes: ${shellAllowlist.join(', ') || '(none)'}`
      }
      return undefined
    },
    run: (args, ctx) => {
      const command = String(args.command ?? '').trim()
      ctx.metrics.shellRuns = (ctx.metrics.shellRuns ?? 0) + 1
      const out = spawn(command, { shell: true, cwd: ctx.rootDir, timeout: shellTimeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      const text = `${out.stdout ?? ''}\n${out.stderr ?? ''}`.trim()
      return `$ ${command}\n(exit ${out.status ?? 'error'})\n${text.slice(0, 4000) || '(no output)'}`
    },
  })

  return tools
}
