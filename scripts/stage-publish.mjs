#!/usr/bin/env node
/**
 * Assemble the publishable `abax` package in ./staging without touching
 * the lab repo's package.json (which stays galaxy-core + private so it
 * can never be published by accident).
 *
 *   node scripts/stage-publish.mjs        # build + assemble + verify
 *   cd staging && npm publish             # the real thing
 *
 * The stager: clean-builds the publishable subset (tsconfig.build.json)
 * straight into staging/dist, refuses to proceed if any *.test.* files
 * slipped in, copies the abax skill + README + LICENSE, and writes a
 * publish-ready package.json (name=abax, official registry pinned).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const staging = join(root, 'staging')

const ABAX_VERSION = process.env.ABAX_VERSION ?? '0.1.0'

console.log('1/5 clean staging/ ...')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

console.log('2/5 clean build -> staging/dist ...')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const build = spawnSync(
  process.execPath,
  [tsc, '-p', join(root, 'tsconfig.build.json'), '--outDir', join(staging, 'dist')],
  { stdio: 'inherit', cwd: root },
)
if (build.status !== 0) {
  console.error('build failed - staging aborted')
  process.exit(1)
}

console.log('3/5 verify no test/example files in the tarball ...')
const offenders = globSync('**/*.test.*', { cwd: join(staging, 'dist') })
  .concat(globSync('examples/**', { cwd: join(staging, 'dist') }))
  .concat(globSync('agent/**', { cwd: join(staging, 'dist') }))
if (offenders.length > 0) {
  console.error(`refusing to stage: lab files leaked into dist:\n  ${offenders.join('\n  ')}`)
  process.exit(1)
}

console.log('4/5 copy skill, README, LICENSE ...')
cpSync(join(root, 'skills', 'abax'), join(staging, 'skills', 'abax'), { recursive: true })
cpSync(join(root, 'README.md'), join(staging, 'README.md'))
cpSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))

console.log('5/5 write package.json ...')
const lab = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pkg = {
  name: 'abax-mcp',
  version: ABAX_VERSION,
  description:
    'An external reasoning board for LLM agents: exact arithmetic, rule-derived conclusions with provenance, consume/produce actions with history. Derived or it didn\'t happen.',
  keywords: [
    'mcp', 'mcp-server', 'reasoning', 'verification', 'datalog',
    'working-memory', 'provenance', 'audit', 'agent', 'neurosymbolic',
  ],
  license: 'MIT',
  author: 'ff <jiqun.qi@gmail.com>',
  type: 'module',
  bin: { abax: 'dist/mcp/run.js' },
  main: 'dist/index.js',
  types: 'dist/index.d.ts',
  files: ['dist', 'skills', 'README.md', 'LICENSE'],
  engines: { node: '>=20' },
  publishConfig: { registry: 'https://registry.npmjs.org/', access: 'public' },
  dependencies: lab.dependencies,
}
writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

if (!existsSync(join(staging, 'dist', 'mcp', 'run.js'))) {
  console.error('staging/dist/mcp/run.js missing - bin would be broken')
  process.exit(1)
}

console.log(`
staged abax-mcp@${ABAX_VERSION} in ./staging
next:
  cd staging
  npm publish --dry-run    # inspect the tarball one last time
  npm publish              # occupy the name for real
`)
