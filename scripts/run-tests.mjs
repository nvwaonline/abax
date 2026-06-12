#!/usr/bin/env node
// Shell-free test runner. Passing a test glob to `node --test` depends
// on WHO expands it: POSIX shells do, Windows cmd does not, and Node
// 20's test runner cannot glob by itself (Node 22 can) - which made CI
// green or red depending on the os x node cell. (Bonus trap: the glob
// literal cannot even live in a block comment - its star-slash sequence
// terminates the comment.) Walking the tree and passing explicit file
// paths removes the shell from the equation entirely.
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function collectTests(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectTests(full, out)
    else if (entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const files = collectTests(join(root, 'src')).sort()
if (files.length === 0) {
  console.error('no test files found under src/')
  process.exit(1)
}
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit', cwd: root },
)
process.exit(result.status ?? 1)
