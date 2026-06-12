import { MemorySpaceStore } from './storage/memory-space-store.js'
import { JsonlSpaceStore } from './storage/jsonl-space-store.js'
import { distillSpace, seedSpace } from './engine/distill.js'
import { applyWorkingMemoryOperations, type WorkingMemoryOperation } from './engine/working-memory.js'
import { deriveActionEffects } from './engine/semantic-derivation.js'
import { simulateActionEffects } from './engine/simulate.js'
import { formatLogicContextAsText, getLogicContext } from './engine/logic-context.js'
import { formatAtom } from './kernel/predicate.js'
import type { SpaceStore } from './storage/space-store.js'

// Minimal command-line driver around the kernel, mainly for scripted use
// and real-task verification. Persistent when GALAXY_CORE_DB is set.
//
//   node cli.ts create-space <spaceId> <title>
//   node cli.ts wm <spaceId> '<operations json array>'
//   node cli.ts simulate <spaceId> <actionNodeId>
//   node cli.ts apply <spaceId> <actionNodeId>
//   node cli.ts context <spaceId>

const store: SpaceStore = process.env.GALAXY_CORE_DB
  ? new JsonlSpaceStore(process.env.GALAXY_CORE_DB)
  : new MemorySpaceStore()

const [command, spaceId, ...rest] = process.argv.slice(2)

try {
  switch (command) {
    case 'create-space': {
      const space = store.createSpace({ id: spaceId, title: rest.join(' ') || spaceId })
      console.log(`created space ${space.id}: ${space.title}`)
      break
    }
    case 'wm': {
      const operations = JSON.parse(rest.join(' ')) as WorkingMemoryOperation[]
      const result = applyWorkingMemoryOperations(store, requireSpace(spaceId), operations, {
        format: 'text',
      })
      for (const warning of result.warnings) console.log(`warning: ${warning}`)
      console.log(result.workingMemoryText)
      break
    }
    case 'simulate': {
      const result = simulateActionEffects(store, requireSpace(spaceId), requireArg(rest[0]))
      if (!result.applicable) {
        console.log(
          `NOT applicable; ${
            result.failedPrecondition
              ? `first failing precondition: ${formatAtom(result.failedPrecondition)}`
              : `unsatisfied: ${result.unsatisfiedPreconditions.map(formatAtom).join(' AND ')}`
          }`,
        )
        break
      }
      console.log(`would assert: ${result.addedAtoms.map(formatAtom).join(', ') || 'none'}`)
      console.log(`would delete: ${result.removedAtoms.map(formatAtom).join(', ') || 'none'}`)
      console.log(`new derived: ${result.newDerivedAtoms.map(formatAtom).join(', ') || 'none'}`)
      console.log(`lost derived: ${result.lostDerivedAtoms.map(formatAtom).join(', ') || 'none'}`)
      console.log(`would satisfy goals: ${result.wouldSatisfyGoalIds.join(', ') || 'none'}`)
      break
    }
    case 'apply': {
      const result = deriveActionEffects(store, requireSpace(spaceId), requireArg(rest[0]))
      if (!result.applied) {
        console.log(
          `NOT applied; ${
            result.failedPrecondition
              ? `first failing precondition: ${formatAtom(result.failedPrecondition)}`
              : `unsatisfied: ${result.unsatisfiedPreconditions.map(formatAtom).join(' AND ')}`
          }`,
        )
        break
      }
      console.log(
        `applied; +${result.addedFactNodeIds.length}/-${result.removedFactNodeIds.length} facts; satisfied goals: ${result.satisfiedGoalNodeIds.join(', ') || 'none'}`,
      )
      break
    }
    case 'context': {
      console.log(formatLogicContextAsText(getLogicContext(store, requireSpace(spaceId))))
      break
    }
    case 'seed': {
      const seeded = seedSpace(
        store,
        requireSpace(spaceId),
        distillSpace(store, requireArg(rest[0])),
      )
      console.log(`seeded ${seeded.seededAxiomIds.length} rule(s): ${seeded.seededAxiomIds.join(', ') || 'none'}`)
      console.log(`inherited vocabulary: ${seeded.vocabulary.join(', ') || 'none'}`)
      break
    }
    default:
      console.error('usage: cli.ts create-space|wm|simulate|apply|context|seed <spaceId> [...]')
      process.exitCode = 2
  }
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

function requireSpace(value: string | undefined): string {
  if (!value) throw new Error('spaceId is required')
  return value
}

function requireArg(value: string | undefined): string {
  if (!value) throw new Error('missing argument')
  return value
}
