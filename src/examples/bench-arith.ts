/**
 * bench-arith — A/B benchmark for the board's exact-arithmetic value.
 *
 * GSM-Hard-style big-number invoice problems (7-digit unit prices ×
 * 3-digit quantities, 2–4 lines, exact grand total) solved by the SAME
 * local model two ways:
 *
 *   baseline  plain chat, model computes mentally, answers "ANSWER: <n>"
 *   board     board-driven task loop; costs and total must end as
 *             closure-DERIVED facts (mul/add built-ins do the arithmetic)
 *
 * Scoring is from ground truth (exact integers, all within 2^53 so the
 * kernel's exact-or-fail contract applies). The board arm is scored from
 * the BOARD, not from prose: a problem counts as solved only if every
 * per-line cost AND the grand total appear as [derived] facts with the
 * exact values. This measures the claim that matters: not "the model
 * said a number" but "the closure stands behind the number".
 *
 * Usage:
 *   tsx src/examples/bench-arith.ts --selftest     # scripted model, no LLM needed
 *   tsx src/examples/bench-arith.ts                # both arms, real local model
 *   GALAXY_BENCH_ARM=baseline|board|both           # default both
 *   GALAXY_BENCH_N=20 GALAXY_BENCH_SEED=7          # problem count / seed
 *   GALAXY_LLM_BASE_URL / GALAXY_LLM_MODEL         # as in the other fixtures
 *
 * Results: console summary + JSONL per-problem log under logs/.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MemorySpaceStore } from '../storage/memory-space-store.js'
import { getLogicContext } from '../engine/logic-context.js'
import { runAgentTask, type ChatModel } from '../agent/task-loop.js'
import { ToolRegistry } from '../agent/tools.js'
import { LlmClient, type ChatMessage } from '../agent/llm.js'

// ---------------------------------------------------------------- problems

type Line = { item: string; unit: number; qty: number }
type Problem = { id: number; lines: Line[]; costs: number[]; total: number; text: string }

/** Deterministic PRNG so runs are reproducible and arms see identical problems. */
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

const ITEM_POOL = [
  'turbine', 'gasket', 'manifold', 'sensor', 'actuator', 'bearing',
  'compressor', 'valve', 'rotor', 'flange', 'coupling', 'injector',
]

/**
 * Difficulty knobs (mental arithmetic cost explodes with digit width and
 * line count; the kernel is indifferent as long as every product and the
 * total stay within 2^53 — guarded below):
 *   GALAXY_BENCH_UNIT_DIGITS  unit price digits, 2..8 (default 7)
 *   GALAXY_BENCH_QTY_DIGITS   quantity digits, 1..5 (default 3)
 *   GALAXY_BENCH_LINES        line-count range, e.g. "5-8" (default "2-4")
 */
const UNIT_DIGITS = Math.min(8, Math.max(2, Number(process.env.GALAXY_BENCH_UNIT_DIGITS ?? 7)))
const QTY_DIGITS = Math.min(5, Math.max(1, Number(process.env.GALAXY_BENCH_QTY_DIGITS ?? 3)))
const LINE_RANGE = /^(\d+)-(\d+)$/.exec(process.env.GALAXY_BENCH_LINES ?? '2-4')
const MIN_LINES = Math.max(1, Number(LINE_RANGE?.[1] ?? 2))
const MAX_LINES = Math.min(ITEM_POOL.length, Math.max(MIN_LINES, Number(LINE_RANGE?.[2] ?? 4)))

function randomWithDigits(rng: () => number, digits: number): number {
  const lo = 10 ** (digits - 1)
  return lo + Math.floor(rng() * (9 * lo - 2)) + 1
}

function generateProblem(rng: () => number, id: number): Problem {
  const lineCount = MIN_LINES + Math.floor(rng() * (MAX_LINES - MIN_LINES + 1))
  const names = [...ITEM_POOL].sort(() => rng() - 0.5).slice(0, lineCount)
  const lines: Line[] = names.map((item) => ({
    item,
    unit: randomWithDigits(rng, UNIT_DIGITS),
    qty: randomWithDigits(rng, QTY_DIGITS),
  }))
  const costs = lines.map((l) => l.unit * l.qty)
  const total = costs.reduce((a, b) => a + b, 0)
  // Exactness guard: the kernel's contract is exact-or-fail within 2^53;
  // problems must never leave that range or the board arm would (rightly)
  // refuse. Max with 8-digit unit × 5-digit qty × 12 lines ≈ 1.2e14, safe.
  if (!Number.isSafeInteger(total)) {
    throw new Error(`generated total ${total} exceeds 2^53; lower the difficulty knobs`)
  }
  const text =
    `An invoice has ${lineCount} line items: ` +
    lines.map((l) => `${l.qty} units of "${l.item}" at ${l.unit} cents each`).join('; ') +
    `. Compute the EXACT cost of each line in cents and the EXACT grand total in cents.`
  return { id, lines, costs, total, text }
}

// ---------------------------------------------------------------- baseline arm

function baselineMessages(p: Problem): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a precise accountant. Work step by step, then give the grand total ' +
        'on the last line in exactly this form: ANSWER: <integer>',
    },
    { role: 'user', content: p.text },
  ]
}

export function parseBaselineAnswer(reply: string): number | undefined {
  const tagged = [...reply.matchAll(/ANSWER:\s*(-?[\d,]+)/gi)].pop()
  const raw = tagged?.[1] ?? [...reply.matchAll(/-?\d[\d,]{2,}/g)].pop()?.[0]
  if (!raw) return undefined
  const n = Number(raw.replaceAll(',', ''))
  return Number.isFinite(n) ? n : undefined
}

// ---------------------------------------------------------------- board arm

function boardGoal(p: Problem): string {
  return (
    `${p.text} Assert one line(item, unit, qty) fact per line item, then make the BOARD ` +
    `do all arithmetic with the mul/add built-ins in rule bodies (do NOT compute any ` +
    `product or sum yourself): derive cost(item, total) for every line and a single ` +
    `grand_total(value) fact. The costs and grand_total must be DERIVED facts (closure-` +
    `computed), then record the result.`
  )
}

type BoardScore = {
  ok: boolean
  lineHits: number
  lineCount: number
  totalDerived: boolean
  /** A fact with the right number exists but only as a bare assertion. */
  totalAssertedOnly: boolean
}

function scoreBoard(store: MemorySpaceStore, spaceId: string, p: Problem): BoardScore {
  const facts = getLogicContext(store, spaceId).facts
  const values = (args: Record<string, unknown> | undefined): unknown[] =>
    Object.values(args ?? {})
  let lineHits = 0
  for (let i = 0; i < p.lines.length; i += 1) {
    const line = p.lines[i]!
    const want = p.costs[i]!
    const hit = facts.some(
      (f) =>
        f.derived &&
        values(f.atom.args).includes(line.item) &&
        values(f.atom.args).includes(want),
    )
    if (hit) lineHits += 1
  }
  const totalDerived = facts.some((f) => f.derived && values(f.atom.args).includes(p.total))
  const totalAssertedOnly =
    !totalDerived && facts.some((f) => values(f.atom.args).includes(p.total))
  return {
    ok: lineHits === p.lines.length && totalDerived,
    lineHits,
    lineCount: p.lines.length,
    totalDerived,
    totalAssertedOnly,
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

// ---------------------------------------------------------------- selftest

/** Scripted model that drives the board correctly for any generated problem. */
class ScriptedBoardModel implements ChatModel {
  private step = 0
  constructor(private readonly p: Problem) {}

  async chat(_messages: ChatMessage[]): Promise<string> {
    this.step += 1
    if (this.step === 1) {
      const ops: unknown[] = this.p.lines.map((l, i) => ({
        op: 'assert_fact',
        id: `L${i}`,
        predicate: 'line',
        args: { item: l.item, unit: l.unit, qty: l.qty },
      }))
      ops.push({
        op: 'add_axiom',
        id: 'ax_cost',
        label: 'cost = unit*qty',
        when: [
          { predicate: 'line', args: { item: '?i', unit: '?u', qty: '?q' } },
          { predicate: 'mul', args: { left: '?u', right: '?q', result: '?t' } },
        ],
        then: [{ predicate: 'cost', args: { item: '?i', total: '?t' } }],
      })
      // Grand total: one rule chaining add over the per-line costs. Written
      // deliberately with the adds BEFORE some cost literals they depend on -
      // the matcher's dependency ordering must absorb that.
      const when: unknown[] = []
      const costVars = this.p.lines.map((l, i) => {
        when.push({ predicate: 'cost', args: { item: l.item, total: `?c${i}` } })
        return `?c${i}`
      })
      let acc = costVars[0]!
      for (let i = 1; i < costVars.length; i += 1) {
        const next = i === costVars.length - 1 ? '?sum' : `?s${i}`
        when.push({ predicate: 'add', args: { left: acc, right: costVars[i]!, result: next } })
        acc = next
      }
      const sumVar = costVars.length === 1 ? costVars[0]! : '?sum'
      ops.push({
        op: 'add_axiom',
        id: 'ax_total',
        label: 'grand total = sum of costs',
        when,
        then: [{ predicate: 'grand_total', args: { value: sumVar } }],
      })
      return JSON.stringify({ tool: 'update_working_memory', args: { operations: ops }, note: 'model the invoice' })
    }
    if (this.step === 2) {
      return JSON.stringify({
        tool: 'update_working_memory',
        args: {
          operations: [
            {
              op: 'record_result',
              id: 'res',
              label: 'totals derived',
              summary: 'all costs and the grand total are closure-derived',
            },
          ],
        },
        note: 'record',
      })
    }
    return JSON.stringify({ tool: 'done', args: { summary: 'derived exact totals' } })
  }
}

async function selftest(): Promise<void> {
  const rng = mulberry32(7)
  const p = generateProblem(rng, 1)

  // Board arm with a correct scripted model must score ok with all lines derived.
  const board = await runBoardArm(new ScriptedBoardModel(p), p, 6)
  if (!board.ok || !board.totalDerived || board.lineHits !== board.lineCount) {
    throw new Error(`selftest board arm failed: ${JSON.stringify(board)}`)
  }

  // Baseline parser: tagged answers, comma-grouped, and trailing-number fallback.
  if (parseBaselineAnswer('thinking...\nANSWER: 1,234,567') !== 1234567) {
    throw new Error('selftest: tagged parse failed')
  }
  if (parseBaselineAnswer('the total is 99887766 cents') !== 99887766) {
    throw new Error('selftest: fallback parse failed')
  }
  if (parseBaselineAnswer('no numbers here') !== undefined) {
    throw new Error('selftest: empty parse failed')
  }

  // Scoring guards: a wrong total must not pass.
  const wrong: Problem = { ...p, total: p.total + 1 }
  const store = new MemorySpaceStore()
  const space = store.createSpace({ title: 'wrong' })
  if (scoreBoard(store, space.id, wrong).ok) {
    throw new Error('selftest: empty board must not score ok')
  }

  console.log('bench-arith selftest PASSED (board arm scored from derived facts; parser + scorer sane)')
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
  // Resume support: skip the first K problems (same seed keeps ids aligned),
  // so a crashed or interrupted run can continue where it stopped.
  const skip = Number(process.env.GALAXY_BENCH_SKIP ?? 0)
  const rng = mulberry32(seed)
  const problems = Array.from({ length: N }, (_, i) => generateProblem(rng, i + 1)).slice(skip)

  const llm = new LlmClient()
  mkdirSync('logs', { recursive: true })
  const logPath = join('logs', `bench-arith-${Date.now()}.jsonl`)
  const log = (entry: unknown): void => appendFileSync(logPath, `${JSON.stringify(entry)}\n`)

  let baseOk = 0
  let baseDnf = 0
  let boardOk = 0
  let boardDnf = 0
  let boardAssertedOnly = 0
  const ran = problems.length

  for (const p of problems) {
    const row: Record<string, unknown> = { id: p.id, total: p.total }

    // A model that cannot produce an answer within the call budget is a
    // DNF (did not finish) - recorded as failure, never a crashed run.
    if (arm !== 'board') {
      const t0 = Date.now()
      try {
        const reply = await llm.chat(baselineMessages(p))
        const answer = parseBaselineAnswer(reply)
        const ok = answer === p.total
        if (ok) baseOk += 1
        row.baseline = { ok, answer, ms: Date.now() - t0 }
      } catch (error) {
        baseDnf += 1
        row.baseline = { ok: false, dnf: true, error: String(error).slice(0, 120), ms: Date.now() - t0 }
      }
    }

    if (arm !== 'baseline') {
      const t0 = Date.now()
      try {
        const score = await runBoardArm(llm, p, maxTurns)
        if (score.ok) boardOk += 1
        if (score.totalAssertedOnly) boardAssertedOnly += 1
        row.board = { ...score, ms: Date.now() - t0 }
      } catch (error) {
        boardDnf += 1
        row.board = { ok: false, dnf: true, error: String(error).slice(0, 120), ms: Date.now() - t0 }
      }
    }

    log(row)
    console.log(JSON.stringify(row))
  }

  console.log('---')
  if (arm !== 'board') console.log(`baseline: ${baseOk}/${ran} exact (${baseDnf} DNF/timeout)`)
  if (arm !== 'baseline') {
    console.log(`board:    ${boardOk}/${ran} exact AND closure-derived (${boardDnf} DNF/timeout)`)
    console.log(`board:    ${boardAssertedOnly}/${ran} had the right number but only as a bare assertion (counted as FAIL)`)
  }
  if (skip > 0) console.log(`(resumed at problem ${skip + 1}; merge with the earlier log for full totals)`)
  console.log(`log: ${logPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
