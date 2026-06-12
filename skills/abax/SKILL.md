---
name: abax
description: Use the abax reasoning board for multi-step verification, exact arithmetic, audits, and consume/produce state tracking. Put facts, rules, and actions ON THE BOARD and let it derive conclusions - every claim ends up derived (closure-backed), an action effect, or rejected. Use whenever a wrong number or an unverified claim would be costly.
---

# abax — the reasoning board

abax (Greek ἄβαξ, "counting board") is an external working memory with a
rule engine. You propose **facts**, **rules**, and **actions**; the board
computes closures, does exact arithmetic, tracks consumption/production,
and keeps an evidence chain for everything. Its discipline in one line:
**derived or it didn't happen.**

## When to reach for the board

- Exact arithmetic at any size that matters (totals, balances,
  stoichiometry) — never compute products or sums in your head
- Audits and error-finding — findings must be DERIVED from observations,
  which kills hallucinated findings structurally
- Consume/produce state (inventory, budgets, reactions) — actions, with
  an event trail
- Any multi-step conclusion a human will need to check afterwards

## The three tags (read them, they are the epistemics)

- `[derived]` — the rule closure stands behind it; retract an input and
  it disappears
- `[effect]` — produced by applying an action you defined (the board
  vouches for the bookkeeping, not the truth of your action design)
- `[asserted]` — your bare claim; the weakest kind

`record_result` is REJECTED while any positive `finding(...)` is merely
asserted. Convert the claim: assert the primitive observation, add a rule
deriving the finding from it, let the closure produce it.

## Core workflow

1. `create_space` once per task
2. `update_working_memory` with batched operations (declare_goal,
   assert_fact, add_axiom, define_action, declare_hypothesis,
   record_result, retract_node, revise_fact)
3. Read the returned board; open goals carry teaching hints
   (`needs via <rule>: ...`, `producible via action <id>: ...`)
4. Finish with `record_result` citing evidence

## Copyable templates

Exact arithmetic in a rule body (compute, never guess — built-ins:
add/sub/mul/div/mod/pow/min/max{left,right,result}, neg/abs{left,result},
guards eq/neq/lt/lte/gt/gte{left,right}):

```json
{"op":"add_axiom","id":"ax_cost","label":"cost = unit*qty",
 "when":[{"predicate":"line","args":{"item":"?i","unit":"?u","qty":"?q"}},
         {"predicate":"mul","args":{"left":"?u","right":"?q","result":"?t"}}],
 "then":[{"predicate":"cost","args":{"item":"?i","total":"?t"}}]}
```

Error-finding guard (recompute and compare; derive `bad` ONLY on mismatch):

```json
{"op":"add_axiom","id":"ax_bad","label":"claimed total differs from recomputed",
 "when":[{"predicate":"row","args":{"id":"?r","unit":"?u","qty":"?q","claimed":"?c"}},
         {"predicate":"mul","args":{"left":"?u","right":"?q","result":"?t"}},
         {"predicate":"neq","args":{"left":"?t","right":"?c"}}],
 "then":[{"predicate":"bad","args":{"id":"?r"}}]}
```

Consume/produce (rules are monotonic and never delete; transformations
are ACTIONS — negated effect consumes, positive effect produces):

```json
{"op":"define_action","id":"burn","action":"combust",
 "preconditions":[{"predicate":"have","args":{"species":"H2"}},{"predicate":"have","args":{"species":"O2"}}],
 "effects":[{"predicate":"have","args":{"species":"H2"},"negated":true},
            {"predicate":"have","args":{"species":"H2O"}}]}
```

Counted amounts (bind current, guard with gte, COMPUTE the new amount in
preconditions, swap old for new in effects):

```json
{"op":"define_action","id":"burn1","action":"combust_once",
 "preconditions":[{"predicate":"amount","args":{"species":"H2","mol":"?h"}},
                  {"predicate":"gte","args":{"left":"?h","right":2}},
                  {"predicate":"sub","args":{"left":"?h","right":2,"result":"?h2"}}],
 "effects":[{"predicate":"amount","args":{"species":"H2","mol":"?h"},"negated":true},
            {"predicate":"amount","args":{"species":"H2","mol":"?h2"}}]}
```

Then `simulate_action` (preview: binding, diff, goals it would satisfy)
and `apply_action` (commit: consumed facts are archived and an event
result records consumed/produced/binding).

## Rules of the road

- Variables are `"?x"` strings, rules/preconditions only
- Built-ins go in rule BODIES, never heads or effects
- Numbers are exact within ±2^53; beyond that the literal FAILS rather
  than silently rounding (exact-or-fail)
- To correct a mistake: `retract_node` (it was never true — physical
  removal with evidence cascade) — never assert a contradiction on top.
  Consumption by actions is different: archived, history kept
- When an open goal says `producible via action X`, simulate/apply that
  action; do NOT assert the product yourself
- Keep predicate names and argument keys consistent (the vocabulary
  section warns on drift); keep batches small (~8 ops)
