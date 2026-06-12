import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve, sep } from 'node:path'
import { JsonlSpaceStore } from '../storage/jsonl-space-store.js'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import {
  applyWorkingMemoryOperations,
  type WorkingMemoryOperation,
} from '../engine/working-memory.js'
import { simulateActionEffects } from '../engine/simulate.js'
import { deriveActionEffects } from '../engine/semantic-derivation.js'
import { formatLogicContextAsText, getLogicContext } from '../engine/logic-context.js'
import { formatAtom } from '../kernel/predicate.js'

// Real-task harness for local models (LM Studio or any OpenAI-compatible
// endpoint). A local model drives the reasoning board through the same
// operations the MCP tools expose, investigating real source files. The
// harness records every turn plus friction metrics (warnings, errors,
// vocabulary size) so different models can be compared.
//
//   $env:GALAXY_LLM_BASE_URL = "http://127.0.0.1:1234"   # default
//   $env:GALAXY_LLM_MODEL    = "qwen3.6-35b-a3b"
//   $env:GALAXY_TASK_DIR     = "D:\\Work\\galaxy\\src\\server"   # audit target
//   npm run verify:local-model
//
// GALAXY_LLM_MOCK=1 runs a scripted model to validate the harness itself.

const BASE_URL = process.env.GALAXY_LLM_BASE_URL ?? 'http://127.0.0.1:1234'
const MODEL = process.env.GALAXY_LLM_MODEL ?? 'local-model'
const TASK_DIR = resolve(process.env.GALAXY_TASK_DIR ?? 'src/server')
const MAX_TURNS = Number(process.env.GALAXY_MAX_TURNS ?? 30)
const MAX_TOKENS = Number(process.env.GALAXY_MAX_TOKENS ?? 6000)
const TASK_EXTS = (process.env.GALAXY_TASK_EXTS ?? '.ts').split(',').map((ext) => ext.trim())
/** Keep this many recent exchanges verbatim; older turns are dropped and
 * replaced by the current board state — history dies, the board persists. */
// History compaction watermarks, in exchanges (assistant+user pairs).
// Low = how much recent history survives a compaction (GALAXY_HISTORY_WINDOW
// kept for backwards compatibility); high = when to compact (default 2x low).
// On a large-context backend set GALAXY_HISTORY_WINDOW >= GALAXY_MAX_TURNS:
// compaction never fires, the prompt stays append-only for the whole run,
// and every turn's prefill is just the new tokens (full prefix-cache reuse).
const HISTORY_LOW = Number(process.env.GALAXY_HISTORY_WINDOW ?? 10)
const HISTORY_HIGH = Math.max(
  HISTORY_LOW + 2,
  Number(process.env.GALAXY_HISTORY_HIGH ?? HISTORY_LOW * 2),
)
// Per-tool-result size cap and per-read_file line cap. The small defaults
// suit small contexts but force re-reads (one run read FactState.java 8
// times in 120-line pages); with a large context, raise both so a file is
// seen once and stays in the cached prefix instead of being re-paged.
const OBS_LIMIT = Number(process.env.GALAXY_OBS_LIMIT ?? 6000)
const READ_LINES = Number(process.env.GALAXY_READ_LINES ?? 120)
// A/B ablation: GALAXY_BASELINE=1 removes the reasoning board entirely -
// same task, same file tools, same turn budget, same model parameters.
// The report must still cite file:line + a one-line quote per claim, so
// baseline conclusions can be machine-checked afterwards the same way.
const BASELINE = process.env.GALAXY_BASELINE === '1'
// Repair mode (v1 of the coding-agent line): write tools are opt-in and
// fenced - GALAXY_ALLOW_WRITE=1 enables them (point GALAXY_TASK_DIR at a
// snapshot copy); run_check executes ONLY the operator-configured
// GALAXY_CHECK_CMD - the model cannot inject commands, it can only ask
// for the configured build/test to be run.
const ALLOW_WRITE = process.env.GALAXY_ALLOW_WRITE === '1'
const CHECK_CMD = process.env.GALAXY_CHECK_CMD ?? ''
// Two-tier oracle: fast check (compile) after every edit, deep check
// (full tests) before concluding. Falls back to CHECK_CMD when unset.
const CHECK_DEEP_CMD = process.env.GALAXY_CHECK_DEEP_CMD ?? ''
const CHECK_TIMEOUT_MS = Number(process.env.GALAXY_CHECK_TIMEOUT_MS ?? 300000)
const WRITE_TOOLS_DOC = ALLOW_WRITE
  ? `\n- edit_file {path, find, replace}            // replace an EXACT unique snippet; copy "find" verbatim from read_file (whitespace matters)\n- write_file {path, content}                 // create/overwrite one file (small files only)\n- run_check {deep?}                          // fast check: ${CHECK_CMD || 'NOT CONFIGURED'}; deep:true runs the full test command${CHECK_DEEP_CMD ? ` (${CHECK_DEEP_CMD})` : ' (falls back to the fast check)'} - run deep once before finishing`
  : ''
const REPAIR_PROTOCOL_DOC = ALLOW_WRITE
  ? `\nRepair protocol: read the exact lines BEFORE editing; "find" must match the file verbatim and be unique (add surrounding lines if needed); after EVERY edit call run_check (fast) and fix any regression before the next edit; line numbers shift after edits - re-read before citing or editing again; before finishing run run_check {"deep":true} once and record results citing its outcome.
The harness itself puts machine-attested process facts on the board: edited(file, line) after each successful edit, and build_status(state=pass|fail) maintained after each run_check. Do NOT assert fixed(...) yourself - derive it: add_axiom IF edited(file=?f, line=?l) AND build_status(state=pass) THEN fixed(file=?f, line=?l). Your goal must be the conjunction of fixed(...) atoms - finding(...) atoms describe problems existing, never use them as a repair goal.
For multi-file tasks: plan FIRST - assert one planned(step, file, what) fact per sub-change before editing anything, work strictly one step at a time, and keep the goal as the full fixed(...) conjunction so the board shows remaining work.
Line numbers given in the task may be STALE: locate each target first (search_files/read_file), THEN declare the goal - never with placeholder lines like 0. Goal atoms must match the machine-fact conventions exactly: file = basename only (e.g. Util.java, not the full path), line = the verified current line; if your own edit shifts lines, revise the goal atoms accordingly.
Run run_check {"deep":true} ONCE BEFORE any edit to record the pre-existing baseline: later deep checks PASS if they introduce no NEW failures relative to that baseline (pre-existing failures are not yours to fix unless the task says so - report them).`
  : ''

const LOG_DIR = 'logs'
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', '.git', 'logs'])

const BASELINE_PROMPT = `You are a code auditor working WITHOUT any external reasoning board (baseline mode).
You MUST reply with exactly one JSON object per turn, no prose outside it:
  {"tool": "<name>", "args": {...}, "note": "<one short sentence why>"}

Tools:
- list_files {}                              // list auditable files with line counts
- search_files {pattern, isRegex?}           // grep across all files -> file:line matches
- read_file {path, fromLine?, toLine?}       // read source; max ${READ_LINES} lines per call${WRITE_TOOLS_DOC}
- done {summary}                             // finish with your complete audit report

There is no persistent store: keep your working notes in your head or the "note" field.
Older conversation turns get trimmed, so anything not repeated may be lost.
Finish with done{summary}: report EVERY issue as "<file>:<line> - <problem>" plus the exact
one-line code quote you saw there, and state which areas you checked and found clean.${REPAIR_PROTOCOL_DOC}

Task: ${process.env.GALAXY_TASK_PROMPT ?? 'audit the given source files for error-handling robustness issues. Record one result with your conclusions.'}`

const SYSTEM_PROMPT = BASELINE ? BASELINE_PROMPT : `You are an investigator using an external reasoning board (working memory with a rule engine).
You MUST reply with exactly one JSON object per turn, no prose outside it:
  {"tool": "<name>", "args": {...}, "note": "<one short sentence why>"}

Tools:
- update_working_memory {operations: [...]}  // ops: declare_goal{id,label,desired:[atom]}, declare_hypothesis{id,predicate,args}, assert_fact{id,predicate,args,negated?,evidenceRefs?,quote?}, add_axiom{id,label,when:[atom],then:[atom]}, record_result{id,label,summary,evidenceRefs}, record_conflict{...}, retract_node{nodeId,reason}, revise_fact{nodeId,predicate,args}
- list_files {}                              // list auditable files with line counts
- search_files {pattern, isRegex?}           // grep across all files -> file:line matches; use this to scout before reading
- read_file {path, fromLine?, toLine?}       // read source (observations!); max ${READ_LINES} lines per call${WRITE_TOOLS_DOC}
- get_logic_context {}                       // re-read the board
- done {summary}                             // finish the task

Atom format: {"predicate":"p","args":{"key":"value"},"negated":false,"naf":false}. Variables are "?x" strings (rules only). naf only in rule bodies.
Board protocol: keep predicate names and argument keys consistent (see the vocabulary section); facts must cite evidenceRefs like ["file.ts:12-20"]; to fix mistakes use retract_node/revise_fact, never assert a contradicting fact; hypotheses are judged automatically; "needs via <rule>: ..." hints tell you what to observe next; finish with record_result citing the findings, then call done.

Observations are ATTESTED: every assert_fact citing file:line evidence MUST include "quote" - the exact source line(s) you saw (copy them from read_file/search output; quoting the single cited line is enough, keep quotes short). The harness mechanically checks the quote against the cited lines and REJECTS the batch on mismatch, echoing what the lines really say. You therefore cannot assert observations about lines you have not actually read. Keep batches small (max ~8 operations) so one problem does not force a big resubmission. A negated fact backed by an exhaustive scan cites ["search:<pattern>"] - allowed only after you ran search_files with exactly that pattern and it returned zero matches.

Findings must be DERIVED, not asserted. Do NOT assert finding(...) directly - that is an unverified claim. Instead, for each suspicion, in one update_working_memory batch:
  1. assert the concrete code observation as its own fact, e.g. {"op":"assert_fact","id":"o1","predicate":"empty_catch","args":{"file":"Foo.java","line":296},"evidenceRefs":["Foo.java:296"],"quote":"}catch (Exception ex){}"}
  2. add the rule that turns that observation into a finding, e.g. {"op":"add_axiom","id":"ax_swallow","label":"empty catch is a swallowed exception","when":[{"predicate":"empty_catch","args":{"file":"?f","line":"?l"}}],"then":[{"predicate":"finding","args":{"type":"swallowed_exception","file":"?f","line":"?l"}}]}
The closure then DERIVES finding(type=swallowed_exception, file=Foo.java, line=296) and marks it [derived]. One rule per category is reused across all its observations. Forcing observation->rule->finding also catches your own false positives: if you must first assert "no close() call exists" but the code has close(), the observation fails and the finding never fires.
Do NOT write a vacuous rule like IF suspected_resource_leak(file=?f) THEN finding(type=resource_leak,...) - the body just renames the conclusion and has no filtering power (the kernel warns about this). The body predicate must be a concrete, primitive code fact you could be wrong about (empty_catch, no_close_in_finally, mutable_static_field_unsynchronized, getAdmin_not_in_try_with_resources), never "suspected_X".
This is enforced: record_result is REJECTED while any positive finding(...) fact is asserted rather than derived. You cannot close the task on bare claims - convert each one to observation+rule (or retract it) first.
Older conversation turns get trimmed; the board is your only durable memory, so write everything that matters into it.${REPAIR_PROTOCOL_DOC}

Task: ${process.env.GALAXY_TASK_PROMPT ?? 'audit the given source files for error-handling robustness issues. Model each suspicion as a hypothesis with a rule that derives finding(...) from concrete code observations, then read the code to assert or refute the observations. Record one result with your conclusions.'}`

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
type ModelAction = { tool: string; args?: Record<string, unknown>; note?: string }

const store = process.env.GALAXY_CORE_DB
  ? new JsonlSpaceStore(process.env.GALAXY_CORE_DB)
  : new MemorySpaceStore()
const space = store.createSpace({
  id: `space:local-model-task-${Date.now()}`,
  title: 'Local-model audit task',
})

const metrics = {
  turns: 0,
  wmBatches: 0,
  operations: 0,
  signatureWarnings: 0,
  toolErrors: 0,
  invalidReplies: 0,
  filesRead: 0,
  searches: 0,
  quoteRejections: 0,
  edits: 0,
  editRejections: 0,
  writes: 0,
  checks: 0,
  checkFailures: 0,
}

/** Searches actually run this session: exact pattern -> match count. */
const searchLog = new Map<string, number>()

/** Machine-attested process facts (repair mode): sequence + build_status lifecycle. */
let editFactSeq = 0
let buildStatusOnBoard = false
/** First deep-check failure set = pre-existing baseline; later deep runs
 * pass if they add no NEW failures (run #17: an unrelated pre-existing
 * test failure made deep-green unreachable for a correct fix). */
let baselineDeepFailures: Set<string> | undefined

function recordProcessFacts(operations: WorkingMemoryOperation[]): void {
  if (BASELINE) return
  try {
    applyWorkingMemoryOperations(store, space.id, operations)
  } catch {
    // bookkeeping must never block the tool result
  }
}

mkdirSync(LOG_DIR, { recursive: true })
const logPath = join(LOG_DIR, `local-model-${BASELINE ? 'baseline-' : ''}${MODEL.replace(/[^a-zA-Z0-9.-]/g, '_')}-${Date.now()}.log`)

const messages: ChatMessage[] = [
  { role: 'system', content: SYSTEM_PROMPT },
  {
    role: 'user',
    content: `Audit target files:\n${listAuditFiles()
      .map((file) => `- ${file}`)
      .join('\n')}\nStart by declaring a goal and your hypotheses. Reply with one JSON tool call.`,
  },
]

// Ctrl+C must still flush the final board and metrics: an interrupted
// run with a summary beats a clean-looking log that just stops mid-turn.
let flushed = false
process.on('SIGINT', () => {
  if (!flushed) {
    flushed = true
    try {
      const board = formatLogicContextAsText(getLogicContext(store, space.id))
      log(`\n=== INTERRUPTED (SIGINT) ===\n=== final working memory ===\n${board}\n=== metrics ===\n${JSON.stringify(metrics, null, 2)}`)
      console.error(`\nINTERRUPTED: final board and metrics flushed to ${logPath}`)
    } catch {
      // never block exit on flush problems
    }
  }
  process.exit(130)
})

let finished = false
let turnsSinceBoardWrite = 0
// Stuck-loop breaker: with low temperature and a CONSTANT correction
// message, an unparseable reply tends to repeat deterministically (run
// #11/#12 burned 57 turns on one identical reply). Vary the nudge with
// the attempt count to perturb the prompt, and bail out early when the
// model is clearly wedged - a diagnosed half-run beats a wasted full one.
let lastInvalidReply = ''
let invalidRepeat = 0
let lastFailedActionKey = ''
let failedActionRepeat = 0
try {
for (let turn = 0; turn < MAX_TURNS && !finished; turn += 1) {
  metrics.turns = turn + 1
  trimHistory()
  const reply = await chat(messages)
  log(`\n=== turn ${turn + 1} model reply ===\n${reply}`)
  messages.push({ role: 'assistant', content: reply })

  const action = parseAction(reply)
  if (!action) {
    metrics.invalidReplies += 1
    invalidRepeat = reply === lastInvalidReply ? invalidRepeat + 1 : 1
    lastInvalidReply = reply
    if (invalidRepeat >= 8) {
      log('\n=== ABORT: the model repeated the same unparseable reply 8 times ===')
      console.error('ABORT: model wedged on one unparseable reply; ending the run early (state and metrics below).')
      break
    }
    messages.push({
      role: 'user',
      content:
        `[attempt ${invalidRepeat}] Your reply contained no valid JSON tool call (it may have been empty or truncated). ` +
        'Output ONLY one JSON object, no thinking text: {"tool": ..., "args": ...}. ' +
        'If your previous reply was long it was probably cut by the token limit: resubmit as a SMALLER batch (max 8 operations; a single-line quote per fact is enough). ' +
        (invalidRepeat >= 2
          ? `You have now sent the SAME failing reply ${invalidRepeat} times - repeating it again will fail again. CHANGE the reply: split the batch in half, or first send {"tool":"get_logic_context","args":{}} to resync.`
          : ''),
    })
    continue
  }
  invalidRepeat = 0
  lastInvalidReply = ''

  turnsSinceBoardWrite = action.tool === 'update_working_memory' ? 0 : turnsSinceBoardWrite + 1
  let observation = await runTool(action)
  // Stuck-ACTION breaker (repair run #1: the same failing edit_file was
  // retried ~25 turns; error-string results never hit the reply breaker).
  const actionKey = JSON.stringify(action)
  if (observation.startsWith('error:')) {
    failedActionRepeat = actionKey === lastFailedActionKey ? failedActionRepeat + 1 : 1
    lastFailedActionKey = actionKey
    if (failedActionRepeat >= 8) {
      log('\n=== ABORT: the same tool call failed identically 8 times ===')
      console.error('ABORT: model wedged on one failing tool call; ending the run early (state and metrics below).')
      break
    }
    if (failedActionRepeat >= 2) {
      observation += `\n[attempt ${failedActionRepeat} of this EXACT call - it will keep failing. CHANGE something: re-read the target region with read_file first, then retry with corrected arguments.]`
    }
  } else {
    failedActionRepeat = 0
    lastFailedActionKey = ''
  }
  log(`--- tool result ---\n${observation}`)
  messages.push({
    role: 'user',
    content: `[turn ${turn + 1}/${MAX_TURNS}]\n${truncate(observation, OBS_LIMIT)}${turnEconomyNudge(turn, turnsSinceBoardWrite)}${deductionNudge(action)}`,
  })
}

} catch (error) {
  // Never lose the run summary: a fatal LLM/tool error still flushes the
  // final board state and metrics below.
  const message = error instanceof Error ? error.message : String(error)
  log(`\n=== FATAL ===\n${message}`)
  console.error(`FATAL: ${message}`)
}

const finalBoard = getLogicContext(store, space.id)
const finalContext = formatLogicContextAsText(finalBoard)
const deductionMetrics = {
  ...metrics,
  derivedFindings: finalBoard.findings.filter((finding) => finding.derived).length,
  assertedFindings: finalBoard.findings.filter((finding) => !finding.derived).length,
  rules: finalBoard.axioms.length,
}
log(`\n=== final working memory ===\n${finalContext}`)
log(`\n=== metrics ===\n${JSON.stringify(deductionMetrics, null, 2)}`)
console.log(finalContext)
console.log(`\nmetrics: ${JSON.stringify(deductionMetrics)}`)
console.log(`\nfull transcript: ${logPath}`)
if (!finished) console.log('NOTE: max turns reached before the model called done.')

async function runTool(action: ModelAction): Promise<string> {
  try {
    switch (action.tool) {
      case 'update_working_memory': {
        if (BASELINE) {
          metrics.toolErrors += 1
          return 'error: baseline mode has NO reasoning board; investigate with list_files/search_files/read_file and finish with done{summary}'
        }
        const operations = (action.args?.operations ?? []) as WorkingMemoryOperation[]
        metrics.wmBatches += 1
        const evidenceProblem = verifyObservationEvidence(operations)
        if (evidenceProblem) {
          metrics.quoteRejections += 1
          return `error: ${evidenceProblem}`
        }
        // Count only operations that actually reach the kernel, so the
        // metric is not inflated by rejected-batch resubmissions.
        metrics.operations += operations.length
        attachVerifiedQuotes(operations)
        const result = applyWorkingMemoryOperations(store, space.id, operations, { format: 'text' })
        metrics.signatureWarnings += result.warnings.length
        const smuggled = detectResultSmuggling(operations, result.workingMemory.findings)
        const nonLocal = nonLocalPredicateWarnings(operations)
        const warnings = [
          ...result.warnings.map((warning) => `warning: ${warning}`),
          ...smuggled.map((warning) => `warning: ${warning}`),
          ...nonLocal.map((warning) => `warning: ${warning}`),
        ].join('\n')
        return [warnings, result.workingMemoryText ?? ''].filter(Boolean).join('\n')
      }
      case 'simulate_action': {
        const result = simulateActionEffects(store, space.id, String(action.args?.actionNodeId ?? ''))
        return JSON.stringify(result, null, 2)
      }
      case 'apply_action': {
        const result = deriveActionEffects(store, space.id, String(action.args?.actionNodeId ?? ''))
        if (!result.applied) {
          return `NOT applied; ${
            result.failedPrecondition
              ? `first failing precondition: ${formatAtom(result.failedPrecondition)}`
              : `unsatisfied: ${result.unsatisfiedPreconditions.map(formatAtom).join(' AND ')}`
          }`
        }
        return `applied; +${result.addedFactNodeIds.length}/-${result.removedFactNodeIds.length} facts (consumed facts archived under event ${result.eventNodeId ?? '?'})`
      }
      case 'list_files':
        return listAuditFiles().join('\n')
      case 'search_files': {
        metrics.searches += 1
        const pattern = String(action.args?.pattern ?? '')
        const isRegex = action.args?.isRegex === true
        const output = searchAuditFiles(pattern, isRegex)
        if (pattern && !output.startsWith('error:')) {
          searchLog.set(pattern, output === 'no matches' ? 0 : output.split('\n').length)
        }
        // A confident false negative is worse than no search: a literal
        // search for "A|B" matches nothing and reads like "neither exists"
        // (run #14's baseline reported "no ExecutorService" off exactly this).
        if (output === 'no matches' && !isRegex && /[|\\()[\]+*?{}^$]/.test(pattern)) {
          return (
            'no matches\n[hint: the pattern contains regex metacharacters (e.g. "|", "\\") but isRegex is false, ' +
            'so it was matched as a LITERAL string. If you meant a regex, retry with "isRegex": true.]'
          )
        }
        return output
      }
      case 'read_file': {
        metrics.filesRead += 1
        return readAuditFile(
          String(action.args?.path ?? ''),
          numberOrUndefined(action.args?.fromLine),
          numberOrUndefined(action.args?.toLine),
        )
      }
      case 'edit_file':
        return editAuditFile(
          String(action.args?.path ?? ''),
          String(action.args?.find ?? ''),
          String(action.args?.replace ?? ''),
        )
      case 'write_file':
        return writeAuditFile(String(action.args?.path ?? ''), String(action.args?.content ?? ''))
      case 'run_check':
        return runConfiguredCheck(action.args?.deep === true)
      case 'get_logic_context':
        return formatLogicContextAsText(getLogicContext(store, space.id))
      case 'done':
        finished = true
        return `done: ${String(action.args?.summary ?? '')}`
      default: {
        // Models often confuse the two levels and call a working-memory
        // operation as a top-level tool; auto-wrap instead of failing.
        const WM_OPS = new Set([
          'declare_goal',
          'assert_fact',
          'declare_hypothesis',
          'add_axiom',
          'define_action',
          'record_result',
          'record_conflict',
          'retract_node',
          'revise_fact',
        ])
        if (WM_OPS.has(action.tool)) {
          return runTool({
            tool: 'update_working_memory',
            args: { operations: [{ op: action.tool, ...(action.args ?? {}) }] },
          })
        }
        metrics.toolErrors += 1
        return `error: unknown tool "${action.tool}"; working-memory operations (record_result etc.) go inside update_working_memory.operations; finish with the "done" tool`
      }
    }
  } catch (error) {
    metrics.toolErrors += 1
    return `error: ${error instanceof Error ? error.message : String(error)}`
  }
}

function listAuditFiles(): string[] {
  const files = collectFiles(TASK_DIR)
  return files.map(({ path, lines }) => `${path} (${lines} lines)`)
}

function collectFiles(root: string): Array<{ path: string; lines: number }> {
  const out: Array<{ path: string; lines: number }> = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const stat = statSync(full, { throwIfNoEntry: false })
      if (stat?.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full)
        continue
      }
      if (!stat?.isFile()) continue
      if (!TASK_EXTS.some((ext) => name.endsWith(ext)) || name.endsWith('.test.ts')) continue
      const lines = readFileSync(full, 'utf8').split('\n').length
      out.push({ path: relative(TASK_DIR, full).split(sep).join('/'), lines })
    }
  }
  walk(root)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

function searchAuditFiles(pattern: string, isRegex: boolean): string {
  if (!pattern) return 'error: pattern is required'
  let matcher: (line: string) => boolean
  try {
    const regex = isRegex ? new RegExp(pattern) : undefined
    matcher = regex ? (line) => regex.test(line) : (line) => line.includes(pattern)
  } catch (error) {
    return `error: bad regex: ${error instanceof Error ? error.message : String(error)}`
  }

  const matches: string[] = []
  for (const { path } of collectFiles(TASK_DIR)) {
    const lines = readFileSync(resolve(TASK_DIR, path), 'utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (!matcher(line)) continue
      matches.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`)
      if (matches.length >= 80) {
        matches.push('...[truncated at 80 matches; narrow the pattern]')
        return matches.join('\n')
      }
    }
  }
  return matches.length > 0 ? matches.join('\n') : 'no matches'
}

/**
 * Prefix-cache-friendly history compaction (high/low watermark).
 *
 * Local backends (LM Studio / llama.cpp) reuse the KV cache for the
 * longest common PREFIX between consecutive requests, so an append-only
 * prompt costs only the new tokens each turn. The previous sliding
 * window was the exact anti-pattern: every turn it rewrote message #3
 * (an ever-changing board snapshot) and shifted the window by one
 * exchange, invalidating the cache from position 3 onward - a near-full
 * re-prefill EVERY turn once the window filled.
 *
 * Now: let history grow append-only until HISTORY_HIGH exchanges, then
 * compact ONCE down to HISTORY_LOW exchanges, snapshotting the board at
 * the cut (the durable state of everything dropped). Between compactions
 * the prompt strictly extends the previous request - full prefix reuse;
 * each compaction costs one full re-prefill instead of every turn.
 */
function trimHistory(): void {
  const head = 2 // system + initial task message
  if (messages.length <= head + HISTORY_HIGH * 2 + 1) return
  const tail = messages.slice(messages.length - HISTORY_LOW * 2)
  const board = BASELINE ? '' : formatLogicContextAsText(getLogicContext(store, space.id))
  messages.length = head
  messages.push({
    role: 'user',
    content: BASELINE
      ? '[older turns compacted]\n(baseline mode has no persistent board - anything you did not repeat below is gone)'
      : `[older turns compacted]\nBoard state at compaction (your durable memory - everything since is in the turns below):\n${truncate(board, 8000)}`,
  })
  messages.push(...tail)
}

function readAuditFile(path: string, fromLine?: number, toLine?: number): string {
  const full = resolve(TASK_DIR, path)
  if (!full.startsWith(TASK_DIR + sep) && full !== TASK_DIR) {
    return 'error: path escapes the audit directory'
  }
  if (!statSync(full, { throwIfNoEntry: false })?.isFile()) {
    return `error: not a file: ${path}`
  }
  const lines = readFileSync(full, 'utf8').split('\n')
  const from = Math.max(1, fromLine ?? 1)
  const to = Math.min(lines.length, toLine ?? from + READ_LINES - 1, from + READ_LINES - 1)
  return lines
    .slice(from - 1, to)
    .map((line, index) => `${from + index}\t${line}`)
    .join('\n')
}

/**
 * Improvement 16: observation attestation. Run #8 proved the deduction
 * pipeline sound but its inputs unreliable: the model asserted empty_catch
 * for catch blocks it had read (which plainly handle the exception), and
 * cited file:line evidence for lines it never read (line numbers
 * extrapolated by analogy, whose real content was something else).
 * The kernel trusts asserted observations axiomatically, so the harness -
 * which can read the audit tree - upgrades evidenceRefs from a formatting
 * convention into a machine-checked promise:
 * - a fact citing file:line evidence must carry a `quote` of the cited
 *   line(s), verified (whitespace-insensitive) against the actual file
 *   content in a +-2 line window;
 * - a fact citing search:<pattern> evidence must cite a search actually
 *   run this session; negated facts additionally require zero matches.
 * A failed check rejects the whole batch and echoes the REAL content of
 * the cited lines, so the model corrects against reality, not memory.
 */
function verifyObservationEvidence(operations: WorkingMemoryOperation[]): string | undefined {
  // Collect ALL evidence problems before reporting: the whole batch is
  // rejected as a unit, so reporting only the first problem forces the
  // model into a fix-one-resubmit-all loop (seen in run #10: 14 rejected
  // batches, most repeating already-fixed operations).
  const problems: string[] = []
  for (const operation of operations) {
    if (operation.op !== 'assert_fact' && operation.op !== 'revise_fact') continue
    const refs = operation.evidenceRefs ?? []
    const quote = typeof (operation as { quote?: unknown }).quote === 'string'
      ? ((operation as { quote?: string }).quote as string)
      : undefined
    const fileRefs = refs.flatMap((ref) => {
      const parsed = parseFileRef(ref)
      return parsed ? [parsed] : []
    })
    const searchRefs = refs
      .filter((ref) => ref.startsWith('search:'))
      .map((ref) => ref.slice('search:'.length))

    for (const pattern of searchRefs) {
      const hits = searchLog.get(pattern)
      if (hits === undefined) {
        problems.push(
          `${opLabel(operation)} cites search:"${pattern}" but no search_files call with exactly ` +
            `that pattern was run this session; run the search first, then cite it`,
        )
      } else if (operation.negated === true && hits > 0) {
        problems.push(
          `${opLabel(operation)} is a negated fact citing search:"${pattern}", but that search had ` +
            `${hits} match(es); a negative observation needs a zero-match scan`,
        )
      }
    }

    if (fileRefs.length === 0) continue
    if (!quote) {
      problems.push(
        `${opLabel(operation)} cites file:line evidence (${fileRefs.map((ref) => ref.raw).join(', ')}) ` +
          `but has no "quote" field. Copy the exact source line(s) you saw into "quote" ` +
          `(the single cited line is enough). If you have not read those lines, read them first.`,
      )
      continue
    }
    const failures: string[] = []
    let verified = false
    for (const ref of fileRefs) {
      const outcome = quoteMatchesFile(ref, quote)
      if (outcome.ok) {
        verified = true
        break
      }
      failures.push(outcome.problem)
    }
    if (!verified) {
      problems.push(`${opLabel(operation)}: ${failures[0]}`)
    }
  }
  if (problems.length === 0) return undefined
  const shown = problems.slice(0, 4)
  const rest = problems.length - shown.length
  return (
    `${problems.length} evidence problem(s); the whole batch was rejected - fix ALL of them and resubmit ONCE ` +
    `(operations that had no problem listed below were fine; include them unchanged):\n- ` +
    shown.join('\n- ') +
    (rest > 0 ? `\n- ... and ${rest} more problem(s) of the same kinds` : '')
  )
}

/**
 * Persist the verified quote into the fact's summary: the board (and its
 * jsonl persistence) then carries the primary evidence itself, so a
 * reviewer - or the model re-reading the board - can spot a mislabeled
 * observation (predicate empty_catch over a quote that plainly handles
 * the exception) without replaying the transcript. Class-1 distortion
 * (read-but-mislabeled) survives quote checking; keeping the quote on
 * the board is the cheap second line against it.
 */
function attachVerifiedQuotes(operations: WorkingMemoryOperation[]): void {
  for (const operation of operations) {
    if (operation.op !== 'assert_fact' && operation.op !== 'revise_fact') continue
    const quote = (operation as { quote?: unknown }).quote
    if (typeof quote !== 'string' || quote.trim().length === 0) continue
    if (!operation.summary) {
      operation.summary = `Quote: ${quote.trim().slice(0, 200)}`
    }
  }
}

/**
 * Result-text smuggling check (run #13): the derivation gate polices the
 * BOARD, but a record_result summary is free prose - the model cited a
 * file:line "finding" whose observation had been quote-rejected, smuggling
 * an unverified claim into the conclusion. Flag any file:line the summary
 * cites that has no finding on the board.
 */
function detectResultSmuggling(
  operations: WorkingMemoryOperation[],
  findings: Array<{ atom: { args?: Record<string, unknown> } }>,
): string[] {
  const cited = new Set<string>()
  for (const operation of operations) {
    if (operation.op !== 'record_result') continue
    const text = `${operation.label ?? ''} ${operation.summary ?? ''}`
    for (const match of text.matchAll(/([A-Za-z_$][\w$.-]*\.(?:java|ts|tsx|js|jsx|py|go|cs|cpp|cc|c|h|rb|kt|scala)):(\d+)/g)) {
      cited.add(`${match[1]}:${match[2]}`)
    }
  }
  if (cited.size === 0) return []
  const backed = new Set(
    findings.map(
      (finding) => `${String(finding.atom.args?.file ?? '')}:${String(finding.atom.args?.line ?? '')}`,
    ),
  )
  return [...cited]
    .filter((ref) => !backed.has(ref))
    .map(
      (ref) =>
        `the result cites ${ref}, but there is no finding at that location on the board - ` +
        `results must not introduce claims the board does not back. Assert the observation ` +
        `(with quote) and derive the finding, or drop it from the summary.`,
    )
}

/**
 * Non-local predicate check (run #15): quote attestation guarantees the
 * cited LINE is real, but predicates like unsynchronized_mutable_static
 * claim a WHOLE-FILE property (no access site synchronizes this field) -
 * a declaration-line quote cannot prove an absence. Six race_condition
 * findings passed attestation this way while the file's accessors were
 * all `synchronized static` (one flagged field was even volatile).
 * Warn when an absence-claiming predicate is backed only by line quotes.
 */
function nonLocalPredicateWarnings(operations: WorkingMemoryOperation[]): string[] {
  // Declared inside the function: module top-level code (the main loop)
  // runs before trailing const statements initialize (TDZ).
  const NON_LOCAL_STEMS = [
    'unsynchronized',
    'unclosed',
    'unguarded',
    'unprotected',
    'unchecked',
    'unhandled',
    'unreleased',
    'no_',
    'non_',
    'never_',
    'missing_',
    'without_',
    'lacks_',
    'not_',
  ]
  const warnings: string[] = []
  for (const operation of operations) {
    if (operation.op !== 'assert_fact' && operation.op !== 'revise_fact') continue
    const predicate = operation.predicate.toLowerCase()
    if (!NON_LOCAL_STEMS.some((stem) => predicate.startsWith(stem))) continue
    const refs = operation.evidenceRefs ?? []
    const hasSearchRef = refs.some((ref) => ref.startsWith('search:'))
    const hasFileRef = refs.some((ref) => parseFileRef(ref) !== undefined)
    if (hasSearchRef || !hasFileRef) continue
    warnings.push(
      `${opLabel(operation)}: predicate "${operation.predicate}" claims an absence/whole-file property, ` +
        `but its evidence is a line quote - a declaration line cannot prove "no/never/un-". ` +
        `Verify the claim: search_files for the access/usage pattern and add ["search:<pattern>"] to evidenceRefs ` +
        `(zero matches proves absence), or cite the specific sites you checked.`,
    )
  }
  return warnings
}

type FileRef = { path: string; from: number; to: number; raw: string }

function parseFileRef(ref: string): FileRef | undefined {
  const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(ref)
  if (!match) return undefined
  const path = match[1] ?? ''
  const looksLikeSource = TASK_EXTS.some((ext) => path.endsWith(ext))
  const exists = statSync(resolve(TASK_DIR, path), { throwIfNoEntry: false })?.isFile() === true
  if (!looksLikeSource && !exists) return undefined
  const from = Number(match[2])
  return { path, from, to: match[3] ? Number(match[3]) : from, raw: ref }
}

/**
 * Locate the quote anywhere in the cited file (whitespace-insensitive)
 * and require its line span to overlap the cited line +-2. A fixed +-2
 * WINDOW around the cited line was run #10's biggest friction: a model
 * quoting lines 174-177 verbatim while citing :174 was rejected 12 times
 * in a row because the quote extended past the window's edge - and the
 * error told it to "re-read the file" it had quoted correctly.
 */
function quoteMatchesFile(ref: FileRef, quote: string): { ok: true } | { ok: false; problem: string } {
  const full = resolve(TASK_DIR, ref.path)
  if (!full.startsWith(TASK_DIR + sep) && full !== TASK_DIR) {
    return { ok: false, problem: `The cited path ${ref.path} escapes the audit directory.` }
  }
  if (!statSync(full, { throwIfNoEntry: false })?.isFile()) {
    return { ok: false, problem: `The cited file ${ref.path} does not exist under the audit directory.` }
  }
  // Tolerate read_file "NNN<tab>" line-number prefixes copied into the quote.
  const variants = [
    normalizeForMatch(quote),
    normalizeForMatch(quote.split('\n').map((line) => line.replace(/^\s*\d+\t/, '')).join('\n')),
  ].filter((variant, index, all) => variant.length >= 6 && all.indexOf(variant) === index)
  if (variants.length === 0) {
    return { ok: false, problem: `the quote "${quote}" is too short to verify; quote the full line.` }
  }

  // Normalized full-file text with a char -> line-number map.
  const lines = readFileSync(full, 'utf8').split('\n')
  let fileNorm = ''
  const lineOfChar: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const norm = normalizeForMatch(lines[index] ?? '')
    fileNorm += norm
    for (let k = 0; k < norm.length; k += 1) lineOfChar.push(index + 1)
  }

  let foundElsewhere: { from: number; to: number } | undefined
  for (const variant of variants) {
    for (let at = fileNorm.indexOf(variant); at >= 0; at = fileNorm.indexOf(variant, at + 1)) {
      const span = {
        from: lineOfChar[at] ?? 1,
        to: lineOfChar[at + variant.length - 1] ?? lineOfChar[at] ?? 1,
      }
      if (span.from <= ref.to + 2 && span.to >= ref.from - 2) return { ok: true }
      foundElsewhere = foundElsewhere ?? span
    }
  }

  if (foundElsewhere) {
    const where =
      foundElsewhere.from === foundElsewhere.to
        ? `line ${foundElsewhere.from}`
        : `lines ${foundElsewhere.from}-${foundElsewhere.to}`
    return {
      ok: false,
      problem:
        `the quote IS in ${ref.path}, but at ${where}, not at the cited line ${ref.from}` +
        `${ref.to !== ref.from ? `-${ref.to}` : ''}. Fix the line number in args/evidenceRefs.`,
    }
  }

  const from = Math.max(1, ref.from - 2)
  const to = Math.min(lines.length, ref.to + 2)
  return {
    ok: false,
    problem:
      `the quote does not appear in ${ref.path}. ${ref.raw} actually reads:\n` +
      lines
        .slice(from - 1, to)
        .map((line, index) => `${from + index}\t${line}`)
        .join('\n') +
      '\nRe-read the file and quote what is actually there.',
  }
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, '')
}

function opLabel(operation: WorkingMemoryOperation & { op: 'assert_fact' | 'revise_fact' }): string {
  return `${operation.op}${operation.id ? ` ${operation.id}` : ''} (${operation.predicate})`
}

/**
 * Repair tools (coding-agent line, v1). Fences:
 * - disabled unless GALAXY_ALLOW_WRITE=1 (run on a snapshot copy);
 * - paths must stay inside TASK_DIR;
 * - edit_file requires a verbatim, UNIQUE "find" snippet - the editing
 *   analogue of quote attestation: you can only change lines you can
 *   quote exactly, so you cannot edit what you have not read;
 * - run_check executes only the operator-configured command.
 */
function editAuditFile(path: string, find: string, replace: string): string {
  if (!ALLOW_WRITE) {
    return 'error: write tools are disabled; the operator must set GALAXY_ALLOW_WRITE=1 (and point GALAXY_TASK_DIR at a disposable snapshot copy)'
  }
  const full = resolve(TASK_DIR, path)
  if (!full.startsWith(TASK_DIR + sep) && full !== TASK_DIR) {
    return 'error: path escapes the audit directory'
  }
  if (!statSync(full, { throwIfNoEntry: false })?.isFile()) return `error: not a file: ${path}`
  if (!find) return 'error: "find" is required: the exact snippet to replace, copied verbatim from read_file output'
  const text = readFileSync(full, 'utf8')
  const count = text.split(find).length - 1
  if (count === 0) {
    metrics.editRejections += 1
    // Echo reality (run #1 of repair mode: the model retried the same
    // mismatched find for ~25 turns blind). Locate the closest anchor
    // line of the attempted snippet and show what the file ACTUALLY says
    // there, the same teaching pattern as the quote verifier.
    const lines = text.split('\n')
    const anchor = find.split('\n').find((part) => normalizeForMatch(part).length >= 6) ?? ''
    const anchorNorm = normalizeForMatch(anchor)
    const anchorIndex =
      anchorNorm.length >= 6
        ? lines.findIndex((part) => {
            const norm = normalizeForMatch(part)
            return norm.length >= 6 && (norm.includes(anchorNorm) || anchorNorm.includes(norm))
          })
        : -1
    const reality =
      anchorIndex >= 0
        ? `\nThe closest match for your snippet's anchor line is at line ${anchorIndex + 1}; the file ACTUALLY reads:\n` +
          lines
            .slice(Math.max(0, anchorIndex - 2), Math.min(lines.length, anchorIndex + 9))
            .map((part, offset) => `${Math.max(0, anchorIndex - 2) + offset + 1}\t${part}`)
            .join('\n') +
          '\nCopy "find" verbatim from these lines.'
        : ' Re-read the target region with read_file first.'
    return `error: the "find" snippet was not found in ${path} (whitespace and line breaks matter).${reality}`
  }
  if (count > 1) {
    metrics.editRejections += 1
    return `error: the "find" snippet occurs ${count} times in ${path}; include more surrounding lines to make it unique`
  }
  const line = text.slice(0, text.indexOf(find)).split('\n').length
  writeFileSync(full, text.replace(find, replace), 'utf8')
  metrics.edits += 1
  editFactSeq += 1
  recordProcessFacts([
    {
      op: 'assert_fact',
      id: `me_edit_${editFactSeq}`,
      predicate: 'edited',
      args: { file: path.split('/').pop() ?? path, line: String(line) },
      evidenceRefs: [`${path}:${line}`],
      summary: 'Harness-attested: edit applied',
    },
  ])
  return (
    `edited ${path} at ~line ${line}: ${find.split('\n').length} line(s) -> ${replace.split('\n').length} line(s). ` +
    `Line numbers after this point shifted - re-read before further edits or citations. Run run_check to validate.` +
    (BASELINE ? '' : ` [board: edited(file=${path.split('/').pop()}, line=${line}) recorded]`)
  )
}

function writeAuditFile(path: string, content: string): string {
  if (!ALLOW_WRITE) {
    return 'error: write tools are disabled; the operator must set GALAXY_ALLOW_WRITE=1 (and point GALAXY_TASK_DIR at a disposable snapshot copy)'
  }
  const full = resolve(TASK_DIR, path)
  if (!full.startsWith(TASK_DIR + sep) && full !== TASK_DIR) {
    return 'error: path escapes the audit directory'
  }
  if (content.length > 200_000) return 'error: content too large (200KB cap); split the file or use edit_file'
  const existed = statSync(full, { throwIfNoEntry: false })?.isFile() === true
  writeFileSync(full, content, 'utf8')
  metrics.writes += 1
  return `${existed ? 'overwrote' : 'created'} ${path} (${content.split('\n').length} lines). Run run_check to validate.`
}

function runConfiguredCheck(deep: boolean): string {
  if (!ALLOW_WRITE) {
    return 'error: run_check is part of the write toolset; the operator must set GALAXY_ALLOW_WRITE=1'
  }
  const command = deep ? CHECK_DEEP_CMD || CHECK_CMD : CHECK_CMD
  if (!command) {
    return 'error: no check command configured; the operator must set GALAXY_CHECK_CMD (e.g. "mvn -q -DskipTests compile")'
  }
  metrics.checks += 1
  const result = spawnSync(command, {
    shell: true,
    cwd: TASK_DIR,
    timeout: CHECK_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  const rawPassed = result.status === 0
  // Baseline-aware deep verdict: the first deep run records pre-existing
  // test failures; later deep runs count as PASS when they add no NEW
  // failures (a correct fix must not be hostage to unrelated red tests).
  let passed = rawPassed
  let baselineNote = ''
  if (deep) {
    const failures = extractTestFailures(output)
    const testsRan = /Tests run:/i.test(output)
    if (baselineDeepFailures === undefined) {
      baselineDeepFailures = failures
      if (!rawPassed && failures.size > 0) {
        baselineNote = ` [baseline recorded: ${countFailureClasses(failures)} pre-existing failing test(s); later deep checks PASS when no NEW failures appear]`
      }
    } else if (!rawPassed && testsRan && failures.size > 0) {
      const fresh = [...failures].filter((name) => !baselineDeepFailures?.has(name))
      if (fresh.length === 0) {
        passed = true
        baselineNote = ` [no NEW failures vs baseline; ${countFailureClasses(failures)} pre-existing remain]`
      } else {
        baselineNote = ` [NEW failures vs baseline: ${fresh.slice(0, 5).join(', ')}]`
      }
    }
  }
  if (!passed) metrics.checkFailures += 1
  const status = (passed
    ? rawPassed
      ? 'PASS'
      : 'PASS (no regression)'
    : `FAIL (${result.status === null ? 'timeout or spawn error' : `exit ${result.status}`})`) + baselineNote
  const state = passed ? 'pass' : 'fail'
  recordProcessFacts([
    buildStatusOnBoard
      ? {
          op: 'revise_fact',
          nodeId: 'build_status',
          id: 'build_status',
          predicate: 'build_status',
          args: { state },
          summary: `Harness-attested: latest ${deep ? 'deep ' : ''}run_check`,
        }
      : {
          op: 'assert_fact',
          id: 'build_status',
          predicate: 'build_status',
          args: { state },
          summary: `Harness-attested: latest ${deep ? 'deep ' : ''}run_check`,
        },
  ])
  buildStatusOnBoard = true
  return (
    `check${deep ? ' (deep)' : ''} ${status}\n${distillCheckOutput(output) || '(no output)'}` +
    (BASELINE ? '' : ` \n[board: build_status(state=${state}) recorded]`)
  )
}

/** Distinct failing test classes (method+class ids double-count one failure). */
function countFailureClasses(failures: Set<string>): number {
  const classes = new Set<string>()
  for (const id of failures) {
    // Both "pkg.FooTest" and "FooTest.method" forms key on the *Test token.
    const token = id.split(/[.:]/).reverse().find((part) => /Test$/.test(part))
    classes.add(token ?? id)
  }
  return Math.max(1, classes.size)
}

/** Failing test identifiers from surefire-style output. */
function extractTestFailures(output: string): Set<string> {
  const failures = new Set<string>()
  for (const match of output.matchAll(/<<< (?:FAILURE|ERROR)! - in (\S+)/g)) {
    if (match[1]) failures.add(match[1])
  }
  for (const match of output.matchAll(/^\[ERROR\]\s{3}(\S+?)(?::\d+)?(?:\s|$)/gm)) {
    if (match[1] && /[A-Za-z]Test/.test(match[1])) failures.add(match[1].split(':')[0] ?? match[1])
  }
  return failures
}

/**
 * Long build/test output keeps the signal lines (errors, failures, test
 * summaries) plus the tail; mvn test output otherwise overflows the cap
 * with passing-module noise and pushes the actual failure out of view.
 */
function distillCheckOutput(output: string): string {
  if (output.length <= 4000) return output
  const lines = output.split('\n')
  const signal = lines.filter((line) => /error|fail|exception|tests run|build/i.test(line)).slice(0, 50)
  const tail = lines.slice(-15)
  return truncate(
    `[output distilled: ${lines.length} lines -> signal + tail]\n${signal.join('\n')}\n--- tail ---\n${tail.join('\n')}`,
    4000,
  )
}

function parseAction(reply: string): ModelAction | undefined {
  // Tolerate code fences, <think> blocks, and surrounding prose: take
  // the first balanced JSON object that has a "tool" key.
  // The brace scanner MUST be string-aware: braces inside string values
  // (regex search patterns like "} catch \\{\\}") are data, not structure.
  // A naive character count cut such JSON mid-string and declared the
  // reply invalid - run #11 lost 24 turns to this (the model was told
  // "no valid JSON" about perfectly valid JSON and retried in a loop).
  const text = reply
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```(?:json)?/g, '')
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const ch = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth += 1
      if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, index + 1)) as ModelAction
            if (typeof parsed.tool === 'string') return parsed
          } catch {
            // keep scanning
          }
          break
        }
      }
    }
  }
  return undefined
}

async function chat(history: ChatMessage[]): Promise<string> {
  if (process.env.GALAXY_LLM_MOCK === '1') {
    return mockModel(history)
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await chatOnce(history)
    } catch (error) {
      lastError = error
      log(`\n[chat attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}]`)
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)))
    }
  }
  throw lastError
}

async function chatOnce(history: ChatMessage[]): Promise<string> {
  // A wedged backend must fail loudly, not freeze the run: without a
  // timeout, one hung completion call silently stops the harness mid-run
  // with no final board/metrics block (observed after run #12).
  const timeoutMs = Number(process.env.GALAXY_LLM_TIMEOUT_MS ?? 600000)
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: history,
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${await response.text()}`)
  }
  const data = (await response.json()) as {
    choices: Array<{ message: { content?: string; reasoning_content?: string; reasoning?: string } }>
  }
  const message = data.choices[0]?.message
  // Reasoning models may put everything in the reasoning channel and
  // leave content empty; fall back so the JSON can still be extracted.
  const content = message?.content?.trim()
  return content && content.length > 0
    ? content
    : (message?.reasoning_content ?? message?.reasoning ?? '')
}

/**
 * Turn-economics teaching: models cannot count turns and tend to read
 * forever without writing back. Surface the budget and nag when too
 * many observation turns pass without a board write.
 */
function turnEconomyNudge(turn: number, turnsSinceBoardWrite: number): string {
  const remaining = MAX_TURNS - (turn + 1)
  if (BASELINE) {
    return remaining <= 5 && remaining > 0
      ? `\n[only ${remaining} turn(s) left: call done with your COMPLETE report now or the investigation is lost]`
      : ''
  }
  if (remaining <= 5 && remaining > 0) {
    return `\n[only ${remaining} turn(s) left: assert your observations as facts NOW and record_result, or your investigation is lost]`
  }
  if (turnsSinceBoardWrite >= 5) {
    return `\n[you have not written to the board for ${turnsSinceBoardWrite} turns; assert what you have learned as facts (with evidenceRefs) before reading more - unwritten observations do not count]`
  }
  return ''
}

/**
 * Deduction-layer teaching: the cheapest path is to assert a suspicion
 * straight into a finding(...) fact, but an asserted finding is an
 * unproven claim, not a derived conclusion. When the board accumulates
 * asserted findings, nudge the model to do it properly: split the claim
 * into a concrete observation fact + a rule whose head is the finding,
 * so the closure derives (and thus vouches for) it.
 */
function deductionNudge(action: ModelAction): string {
  if (BASELINE || action.tool !== 'update_working_memory') return ''
  const context = getLogicContext(store, space.id)
  const asserted = context.findings.filter((finding) => !finding.derived)
  const derived = context.findings.filter((finding) => finding.derived)
  if (asserted.length === 0) return ''
  const example = asserted[0]
  const subject = example?.atom.args
    ? Object.values(example.atom.args).find((value) => typeof value === 'string') ?? 'X'
    : 'X'
  return (
    `\n[${asserted.length} finding(s) are [asserted, not derived]` +
    `${derived.length > 0 ? ` and ${derived.length} are properly derived` : ''}: an asserted finding is an UNVERIFIED claim. ` +
    `Turn each into a derivation: assert the concrete code observation as a fact (e.g. empty_catch(file=${subject}) with evidenceRefs), ` +
    `add_axiom whose "then" is the finding and "when" is that observation, and let the closure derive it. ` +
    `Only derived findings count as audit conclusions.]`
  )
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`
}

function log(text: string): void {
  appendFileSync(logPath, `${text}\n`, 'utf8')
}

// Scripted model used to validate the harness machinery end to end:
// happy path (goal -> rule -> attested observation -> derived finding ->
// result) plus one deliberately wrong quote to exercise the rejection.
// (No module-level cache: top-level code runs before later let-bindings
// initialize, and the walk is cheap for a scripted run.)
function mockObservationTarget(): { path: string; line: number; quote: string; spanQuote: string } {
  const first = collectFiles(TASK_DIR)[0]
  if (!first) throw new Error('mock model: no auditable files under TASK_DIR')
  const lines = readFileSync(resolve(TASK_DIR, first.path), 'utf8').split('\n')
  const lineIndex = lines.findIndex((line) => line.trim().length >= 6)
  return {
    path: first.path,
    line: lineIndex + 1,
    quote: lines[lineIndex] ?? '',
    // A quote spanning 4+ lines anchored at a single-line ref: must pass
    // (run #10's fixed-window bug rejected exactly this shape 12 times).
    spanQuote: lines.slice(lineIndex, lineIndex + 4).join('\n'),
  }
}

function mockModel(history: ChatMessage[]): string {
  const turn = history.filter((message) => message.role === 'assistant').length
  const target = mockObservationTarget()
  if (BASELINE) {
    const baselineScript: ModelAction[] = [
      { tool: 'list_files', args: {}, note: 'survey' },
      {
        tool: 'update_working_memory',
        args: { operations: [] },
        note: 'board call in baseline mode must return a teaching error',
      },
      { tool: 'read_file', args: { path: target.path, fromLine: 1, toLine: 5 }, note: 'inspect' },
      {
        tool: 'done',
        args: { summary: `Baseline audit complete. ${target.path}:${target.line} - example; quote: ${target.quote.trim()}` },
        note: 'finish',
      },
    ]
    return JSON.stringify(baselineScript[Math.min(turn, baselineScript.length - 1)])
  }
  const script: ModelAction[] = [
    {
      tool: 'update_working_memory',
      args: {
        operations: [
          {
            op: 'declare_goal',
            id: 'G1',
            label: 'Find any robustness issue',
            desired: [{ predicate: 'finding', args: { kind: '?k' } }],
          },
          {
            op: 'add_axiom',
            id: 'AX1',
            label: 'Unguarded parse is a finding',
            when: [
              { predicate: 'parses_json', args: { file: '?f' } },
              { predicate: 'parse_guarded', args: { file: '?f' }, naf: true },
            ],
            then: [{ predicate: 'finding', args: { kind: 'unguarded_parse', file: '?f' } }],
          },
        ],
      },
      note: 'set up goal and rule',
    },
    { tool: 'list_files', args: {}, note: 'see what is auditable' },
    {
      // Brace-laden string args exercise the string-aware JSON scanner
      // (run #11: naive brace counting broke on regex patterns like this).
      tool: 'search_files',
      args: { pattern: '} catch (Exception e) {}', isRegex: false },
      note: 'brace-heavy pattern must parse as one valid tool call',
    },
    {
      tool: 'read_file',
      args: { path: target.path, fromLine: 1, toLine: target.line + 3 },
      note: 'inspect the file',
    },
    ...(ALLOW_WRITE
      ? ([
          {
            tool: 'edit_file',
            args: { path: target.path, find: 'not-a-real-snippet-anywhere', replace: 'x' },
            note: 'edit with a non-matching find (must be rejected by the fence)',
          },
          {
            tool: 'edit_file',
            args: { path: target.path, find: target.quote, replace: target.quote },
            note: 'verbatim unique edit (no-op replace, must succeed)',
          },
          { tool: 'run_check', args: {}, note: 'validate via the configured check' },
        ] as ModelAction[])
      : []),
    {
      tool: 'update_working_memory',
      args: {
        operations: [
          {
            op: 'assert_fact',
            id: 'O_BAD',
            predicate: 'parses_json',
            args: { file: target.path },
            evidenceRefs: [`${target.path}:${target.line}`],
            quote: 'this text is definitely not on that line',
          },
        ],
      },
      note: 'attempt an observation with a wrong quote (must be rejected)',
    },
    {
      tool: 'update_working_memory',
      args: {
        operations: [
          {
            op: 'assert_fact',
            id: 'O_WRONG_LINE',
            predicate: 'parses_json',
            args: { file: target.path },
            evidenceRefs: [`${target.path}:${target.line + 60}`],
            quote: target.quote,
          },
        ],
      },
      note: 'attempt a correct quote with a wrong line number (must be rejected with the located span)',
    },
    {
      tool: 'update_working_memory',
      args: {
        operations: [
          {
            op: 'assert_fact',
            id: 'O1',
            predicate: 'parses_json',
            args: { file: target.path },
            evidenceRefs: [`${target.path}:${target.line}`],
            quote: target.spanQuote,
          },
        ],
      },
      note: 'record the observation with a multi-line quote anchored at one line (must pass)',
    },
    {
      tool: 'update_working_memory',
      args: {
        operations: [
          {
            op: 'record_result',
            id: 'R1',
            label: 'Unguarded parse found',
            summary: `${target.path} parses input without a local guard.`,
            evidenceRefs: ['O1'],
          },
        ],
      },
      note: 'conclude',
    },
    { tool: 'done', args: { summary: 'One finding recorded.' }, note: 'finish' },
  ]
  return JSON.stringify(script[Math.min(turn, script.length - 1)])
}
