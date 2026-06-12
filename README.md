# abax

**An external reasoning board for LLM agents. Derived or it didn't happen.**

abax (Greek ἄβαξ, *counting board* — the ancestor of the abacus) gives an
agent a working memory with a rule engine. The agent proposes **facts**,
**rules**, and **actions**; the board computes deductive closures, does
exact arithmetic, tracks consumption/production, and keeps an evidence
chain for every conclusion. The agent cannot launder a guess into a
result: every claim on the board is **derived** (closure-backed), an
**effect** (action product), or **asserted** (bare claim) — and results
that rest on bare claims are rejected.

> First run through the published package, a 27B local model driving the
> board from Claude Code: the frontier model supervising the release
> (Claude Fable 5 Max) had mentally computed `9381274 × 6473` and
> confidently repeated the wrong answer three times. The board derived the right one. That incident is
> [validation round #27](docs/real-task-log.md) — the product demoing
> itself on its own author.

## Why

LLMs assert; they do not prove. For tasks where a wrong number or an
unverified claim is expensive — audits, invoices, inventory, multi-step
analysis — the fix is not a smarter model but a surface the model must
show its work on:

- **Exact-or-fail arithmetic** — integer math is exact within ±2^53;
  overflow, NaN, and silent precision loss fail loudly instead of
  rounding. The model never does arithmetic in its head.
- **Derivation gate** — `finding(...)` facts must be derived by the rule
  closure from primitive observations. Asserted findings block
  `record_result`. There is no way to claim without showing.
- **Actions with history** — consume/produce transformations archive what
  they consume and record an event (binding, consumed, produced). The
  board keeps the process, not just the end state.
- **Truth maintenance** — retract an input and everything resting on it
  falls; contradictions taint downstream conclusions as disputed.
- **Teaching errors** — every rejection explains how to fix the call.
  Validated to keep 27B-class local models productive.
- **No model, no GPU, no network** — abax never calls an LLM. It is a
  pure local kernel (Node ≥ 20, two pure-JS dependencies) that the agent
  drives over MCP stdio.

## Install

As a Claude Code / Cowork plugin (MCP server + skill in one step):

```
/plugin marketplace add nvwaonline/abax
/plugin install abax@abax
```

As a bare MCP server in Claude Code:

```bash
claude mcp add abax -- npx -y abax-mcp
```

Or in any MCP host, project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "abax": { "command": "npx", "args": ["-y", "abax-mcp"] }
  }
}
```

Optional persistence across sessions: set env `ABAX_DB` to a `.jsonl`
file path. Without it, the board lives and dies with the session.

## Tools

`create_space`, `update_working_memory` (declare_goal / assert_fact /
add_axiom / define_action / declare_hypothesis / record_result /
retract_node / revise_fact), `simulate_action`, `apply_action`,
`get_logic_context`, `distill_space`, `list_spaces`.

Open goals come back with teaching hints: which rule is missing which
facts (`needs via ...`), and which defined action could produce the
missing atom (`producible via action ...`).

## Validated, not vibe-coded

This kernel was built against a discipline of red-tests-first and
real-model validation: [27 logged rounds](docs/real-task-log.md) of
local models (gemma/qwen, 27B–35B class) driving the board through real
tasks — judgment, diagnosis-and-repair, open-ended audit, stoichiometric
reactions — each round documented with board evidence, each kernel gap
found by a real run, exposed by a failing test, then fixed. 170+ unit
tests; CI on Linux and Windows. A/B benchmark fixtures (exact
arithmetic, error-finding audits) ship in `src/examples/`.

The lab notes and agent runtime around the kernel live in this repo too:
see [docs/galaxy-lab.md](docs/galaxy-lab.md) (Chinese) for the REPL, web
board visualizer, and verification fixtures.

## License

MIT
