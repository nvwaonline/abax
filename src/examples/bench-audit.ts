/**
 * bench-audit — A/B benchmark for the board's ERROR-FINDING value.
 *
 * Synthetic ledgers where some rows carry a wrong claimed total
 * (unit × qty ≠ claimed). The task: flag EXACTLY the bad rows — find
 * every seeded error, raise no false alarms. Some problems contain ZERO
 * errors: saying "all clean" when it is clean is part of the discipline
 * being measured (a hallucinated finding is precisely the failure mode
 * the board's derivation gate exists to kill).
 *
 *   baseline  plain chat; model checks mentally, answers
 *             "ANSWER: r2,r5" or "ANSWER: NONE"
 *   board     board-driven; a guard rule (mul + neq) DERIVES bad(row)
 *             for mismatching rows; scored from [derived] bad facts only
 *
 * Metrics per arm: exact-set solve rate, plus row-level precision /
 * recall aggregated over all problems (false positives = hallucinated
 * errors, false negatives = missed errors).
 *
 * Usage mirrors bench-arith:
 *   tsx src/examples/bench-audit.ts --selftest
 *   GALAXY_BENCH_N=20 GALAXY_BENCH_SEED=7 GALAXY_BENCH_ARM=both|baseline|board
 *   GALAXY_BENCH_ROWS=6-10   rows per ledger (default)
 *   GALAXY_LLM_BASE_URL / GALAXY_LLM_MODEL / GALAXY_LLM_TIMEOUT_MS
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { getLogicContext } from '../engine/logic-context.js'
import { runAgentTask, type ChatModel } from '../agent/task-loop.js'
import { ToolRegistry } from '../agent/tools.js'
import { LlmClient, type ChatMessage } from '../agent/llm.js'

// ---------------------------------------------------------------- problems

type Row = { id: string; unit: number; qty: number; claimed: number }
type Problem = { id: number; rows: Row[]; badIds: string[]; text: string }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ROW_RANGE = /^(\d+)-(\d+)$/.exec(process.env.GALAXY_BENCH_ROWS ?? '6-10')
const MIN_ROWS = Math.max(2, Number(ROW_RANGE?.[1] ?? 6))
const MAX_ROWS = Math.max(MIN_ROWS, Number(ROW_RANGE?.[2] ?? 10))

function generateProblem(rng: () => number, id: number): Problem {
  const rowCount = MIN_ROWS + Math.floor(rng() * (MAX_ROWS - MIN_ROWS + 1))
  // 0..3 seeded errors; ~1 in 5 ledgers is fully clean (tests false-alarm discipline).
  const errorCount = rng() < 0.2 ? 0 : 1 + Math.floor(rng() * 3)
  const badIndices = new Set<number>()
  while (badIndices.size < Math.min(errorCount, rowCount)) {
    badIndices.add(Math.floor(rng() * rowCount))
  }
  const rows: Row[] = []
  for (let i = 0; i < rowCount; i += 1) {
    const unit = 10_007 + Math.floor(rng() * 89_000) // 5-digit price
    const qty = 11 + Math.floor(rng() * 880) // 2-3 digit quantity
    const trueTotal = unit * qty
    let claimed = trueTotal
    if (badIndices.has(i)) {
      // Plausible corruption: small offset or a swapped digit pair - the
      // kind a skimming eye accepts and exact recomputation catches.
      const mode = rng()
      if (mode < 0.5) {
        claimed = trueTotal + (1 + Math.floor(rng() * 90)) * (rng() < 0.5 ? -1 : 1)
      } else {
        const s = String(trueTotal).split('')
        const k = Math.floor(rng() * (s.length - 1))
        if (s[k] !== s[k + 1]) {
          ;[s[k], s[k + 1]] = [s[k + 1]!, s[k]!]
          claimed = Number(s.join(''))
        } else {
          claimed = trueTotal + 10
        }
      }
    }
    rows.push({ id: `r${i + 1}`, unit, qty, claimed })
  }
  const badIds = rows.filter((_, i) => badIndices.has(i)).map((r) => r.id)
  const text =
    `A ledger claims these line totals: ` +
    rows.map((r) => `${r.id}: ${r.qty} x ${r.unit} = ${r.claimed}`).join('; ') +
    `. Some claimed totals may be WRONG. Identify exactly which rows are wrong ` +
    `(it is possible that none are).`
  return { id, rows, badIds, text }
}

// ---------------------------------------------------------------- baseline arm

function baselineMessages(p: Problem): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a meticulous auditor. Recompute every row exactly, then give your ' +
        'verdict on the last line as: ANSWER: <comma-separated wrong row ids> ' +
        'or ANSWER: NONE if every row is correct.',
    },
    { role: 'user', content: p.text },
  ]
}

export function parseBaselineAnswer(reply: string): string[] | undefined {
  const tagged = [...reply.matchAll(/ANSWER:\s*([^\n]+)/gi)].pop()?.[1]
  if (!tagged) return undefined
  if (/\bnone\b/i.test(tagged)) return []
  const ids = tagged.match(/r\d+/gi)
  return ids ? [...new Set(ids.map((s) => s.toLowerCase()))] : undefined
}

// ---------------------------------------------------------------- board arm

function boardGoal(p: Problem): string {
  return (
    `${p.text} Assert one row(id, unit, qty, claimed) fact per row, then add ONE rule ` +
    `that recomputes each row with the mul built-in and derives bad(id) ONLY for rows ` +
    `whose claimed total differs (use neq on the recomputed vs claimed value - do NOT ` +
    `check any arithmetic yourself). The bad(...) facts must be DERIVED. Then record ` +
    `the result listing the bad rows (or that none are bad).`
  )
}

type BoardScore = {
  ok: boolean
  flagged: string[]
  falsePositives: number
  falseNegatives: number
  /** bad(...) facts that were asserted rather than derived (laundering attempt). */
  assertedBad: number
}

function scoreBoard(store: MemorySpaceStore, spaceId: string, p: Problem): BoardScore {
  const facts = getLogicContext(store, spaceId).facts
  const badFacts = facts.filter((f) => f.atom.predicate === 'bad')
  const flagged = [
    ...new Set(
      badFacts
        .filter((f) => f.derived)
        .flatMap((f) => Object.values(f.atom.args ?? {}).map(String))
        .filter((v) => /^r\d+$/i.test(v))
        .map((v) => v.toLowerCase()),
    ),
  ]
  const assertedBad = badFacts.filter((f) => !f.derived).length
  const truth = new Set(p.badIds)
  const falsePositives = flagged.filter((id) => !truth.has(id)).length
  const falseNegatives = p.badIds.filter((id) => !flagged.includes(id)).length
  return {
    ok: falsePositives === 0 && falseNegatives === 0 && assertedBad === 0,
    flagged,
    falsePositives,
    falseNegatives,
    assertedBad,
  }
}

async function runBoardArm(
  llm: ChatModel,
  p: Problem,
  maxTurns: number,
): Promise<BoardScore & { turns: number }> {
  const store = new MemorySpaceStore()
  let spaceId = ''
  let turns = 0
  await runAgentTask({
    store,
    llm,
    reg: new ToolRegistry(),
    rootDir: process.cwd(),
    goal: boardGoal(p),
    maxTurns,
    onContext: (info) => {
      spaceId = info.spaceId
    },
    onTurn: () => {
      turns += 1
    },
  })
  return { ...scoreBoard(store, spaceId, p), turns }
}

function scoreBaseline(answer: string[] | undefined, p: Problem): {
  ok: boolean
  falsePositives: number
  falseNegatives: number
} {
  if (answer === undefined) {
    return { ok: false, falsePositives: 0, falseNegatives: p.badIds.length }
  }
  const truth = new Set(p.badIds)
  const falsePositives = answer.filter((id) => !truth.has(id)).length
  const falseNegatives = p.badIds.filter((id) => !answer.includes(id)).length
  return { ok: falsePositives === 0 && falseNegatives === 0, falsePositives, falseNegatives }
}

// ---------------------------------------------------------------- selftest

/** Scripted model: asserts the rows, writes the neq guard rule, records, done. */
class ScriptedAuditModel implements ChatModel {
  private step = 0
  constructor(private readonly p: Problem) {}

  async chat(_messages: ChatMessage[]): Promise<string> {
    this.step += 1
    if (this.step === 1) {
      const ops: unknown[] = this.p.rows.map((r) => ({
        op: 'assert_fact',
        id: `F_${r.id}`,
        predicate: 'row',
        args: { id: r.id, unit: r.unit, qty: r.qty, claimed: r.claimed },
      }))
      ops.push({
        op: 'add_axiom',
        id: 'ax_bad',
        label: 'bad row: recomputed total differs from claimed',
        when: [
          { predicate: 'row', args: { id: '?r', unit: '?u', qty: '?q', claimed: '?c' } },
          { predicate: 'mul', args: { left: '?u', right: '?q', result: '?t' } },
          { predicate: 'neq', args: { left: '?t', right: '?c' } },
        ],
        then: [{ predicate: 'bad', args: { id: '?r' } }],
      })
      return JSON.stringify({ tool: 'update_working_memory', args: { operations: ops }, note: 'recompute all rows' })
    }
    if (this.step === 2) {
      return JSON.stringify({
        tool: 'update_working_memory',
        args: {
          operations: [
            { op: 'record_result', id: 'res', label: 'audit done', summary: 'bad rows derived by guard rule' },
          ],
        },
        note: 'record',
      })
    }
    return JSON.stringify({ tool: 'done', args: { summary: 'audit complete' } })
  }
}

async function selftest(): Promise<void> {
  // Find a seeded problem WITH errors and one WITHOUT, prove exact scoring on both.
  const rng = mulberry32(7)
  const pool = Array.from({ length: 30 }, (_, i) => generateProblem(rng, i + 1))
  const withErrors = pool.find((p) => p.badIds.length > 0)
  const clean = pool.find((p) => p.badIds.length === 0)
  if (!withErrors || !clean) throw new Error('selftest: generator did not produce both kinds')

  for (const p of [withErrors, clean]) {
    const score = await runBoardArm(new ScriptedAuditModel(p), p, 6)
    if (!score.ok || score.falsePositives !== 0 || score.falseNegatives !== 0) {
      throw new Error(`selftest board failed on problem ${p.id}: ${JSON.stringify(score)}`)
    }
  }

  // Parser: ids, NONE, garbage.
  if (JSON.stringify(parseBaselineAnswer('blah\nANSWER: r2, R5')) !== JSON.stringify(['r2', 'r5'])) {
    throw new Error('selftest: id parse failed')
  }
  if (JSON.stringify(parseBaselineAnswer('ANSWER: NONE')) !== '[]') {
    throw new Error('selftest: NONE parse failed')
  }
  if (parseBaselineAnswer('no verdict given') !== undefined) {
    throw new Error('selftest: missing-answer parse failed')
  }

  // Baseline scorer: a false positive must fail the problem.
  const fp = scoreBaseline([...withErrors.badIds, 'r999'], withErrors)
  if (fp.ok || fp.falsePositives !== 1) throw new Error('selftest: FP scoring failed')

  console.log('bench-audit selftest PASSED (derived-only flags; FP/FN accounting sane)')
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  if (process.argv.includes('--selftest')) {
    await selftest()
    return
  }

  const N = Number(process.env.GALAXY_BENCH_N ?? 20)
  const seed = Number(process.env.GALAXY_BENCH_SEED ?? 7)
  const arm = process.env.GALAXY_BENCH_ARM ?? 'both'
  const maxTurns = Number(process.env.GALAXY_BENCH_TURNS ?? 10)
  const skip = Number(process.env.GALAXY_BENCH_SKIP ?? 0)
  const rng = mulberry32(seed)
  const problems = Array.from({ length: N }, (_, i) => generateProblem(rng, i + 1)).slice(skip)

  const llm = new LlmClient()
  mkdirSync('logs', { recursive: true })
  const logPath = join('logs', `bench-audit-${Date.now()}.jsonl`)
  const log = (entry: unknown): void => appendFileSync(logPath, `${JSON.stringify(entry)}\n`)

  const ran = problems.length
  let baseOk = 0
  let baseFp = 0
  let baseFn = 0
  let baseDnf = 0
  let boardOk = 0
  let boardFp = 0
  let boardFn = 0
  let boardLaundered = 0
  let boardDnf = 0

  for (const p of problems) {
    const row: Record<string, unknown> = { id: p.id, badIds: p.badIds }

    if (arm !== 'board') {
      const t0 = Date.now()
      try {
        const reply = await llm.chat(baselineMessages(p))
        const answer = parseBaselineAnswer(reply)
        const s = scoreBaseline(answer, p)
        if (s.ok) baseOk += 1
        baseFp += s.falsePositives
        baseFn += s.falseNegatives
        row.baseline = { ...s, answer, ms: Date.now() - t0 }
      } catch (error) {
        baseDnf += 1
        row.baseline = { ok: false, dnf: true, error: String(error).slice(0, 120), ms: Date.now() - t0 }
      }
    }

    if (arm !== 'baseline') {
      const t0 = Date.now()
      try {
        const s = await runBoardArm(llm, p, maxTurns)
        if (s.ok) boardOk += 1
        boardFp += s.falsePositives
        boardFn += s.falseNegatives
        boardLaundered += s.assertedBad
        row.board = { ...s, ms: Date.now() - t0 }
      } catch (error) {
        boardDnf += 1
        row.board = { ok: false, dnf: true, error: String(error).slice(0, 120), ms: Date.now() - t0 }
      }
    }

    log(row)
    console.log(JSON.stringify(row))
  }

  console.log('---')
  if (arm !== 'board') {
    console.log(`baseline: ${baseOk}/${ran} exact-set; false alarms ${baseFp}, missed ${baseFn} (${baseDnf} DNF)`)
  }
  if (arm !== 'baseline') {
    console.log(`board:    ${boardOk}/${ran} exact-set; false alarms ${boardFp}, missed ${boardFn} (${boardDnf} DNF)`)
    console.log(`board:    ${boardLaundered} bad(...) facts asserted instead of derived (counted as FAIL)`)
  }
  if (skip > 0) console.log(`(resumed at problem ${skip + 1})`)
  console.log(`log: ${logPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
