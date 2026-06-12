import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// End-to-end verification of the MCP tool surface: spawns the stdio
// server, runs the investigation loop (goal + hypothesis + axiom +
// observations), compares actions by simulation, commits one, and checks
// the returned working memory at every step.

const client = new Client({ name: 'galaxy-core-mcp-smoke', version: '0.1.0' })

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [...process.execArgv, 'src/mcp/run.ts'],
  cwd: process.cwd(),
  stderr: 'pipe',
})

try {
  await client.connect(transport)

  const tools = await client.listTools()
  const toolNames = new Set(tools.tools.map((tool) => tool.name))
  for (const name of [
    'create_space',
    'list_spaces',
    'update_working_memory',
    'simulate_action',
    'apply_action',
    'get_logic_context',
    'distill_space',
  ]) {
    assert.equal(toolNames.has(name), true, `missing tool: ${name}`)
  }
  assert.equal(tools.tools.length, 7)

  await callTool('create_space', { id: 'space:mcp', title: 'MCP smoke: car wash' })

  const setup = await callTool('update_working_memory', {
    spaceId: 'space:mcp',
    operations: [
      {
        op: 'declare_goal',
        id: 'G1',
        label: 'Car can receive wash service',
        desired: [{ predicate: 'can_receive_service', args: { service: 'wash', object: 'car' } }],
      },
      {
        op: 'add_axiom',
        id: 'AX1',
        label: 'Object at service location can receive service',
        when: [
          { predicate: 'service_on', args: { service: '?s', object: '?o', location: '?l' } },
          { predicate: 'at', args: { object: '?o', location: '?l' } },
        ],
        then: [{ predicate: 'can_receive_service', args: { service: '?s', object: '?o' } }],
      },
      {
        op: 'assert_fact',
        id: 'F1',
        predicate: 'service_on',
        args: { service: 'wash', object: 'car', location: 'car_wash' },
      },
      { op: 'assert_fact', id: 'F2', predicate: 'at', args: { object: 'car', location: 'home' } },
      { op: 'assert_fact', id: 'F3', predicate: 'at', args: { object: 'user', location: 'home' } },
      {
        op: 'define_action',
        id: 'A_WALK',
        label: 'Walk to the wash shop',
        action: 'walk',
        preconditions: [{ predicate: 'at', args: { object: 'user', location: 'home' } }],
        effects: [
          { predicate: 'at', args: { object: 'user', location: 'car_wash' } },
          { predicate: 'at', args: { object: 'user', location: 'home' }, negated: true },
        ],
      },
      {
        op: 'define_action',
        id: 'A_DRIVE',
        label: 'Drive the car to the wash shop',
        action: 'drive',
        preconditions: [{ predicate: 'at', args: { object: 'car', location: 'home' } }],
        effects: [
          { predicate: 'at', args: { object: 'car', location: 'car_wash' } },
          { predicate: 'at', args: { object: 'car', location: 'home' }, negated: true },
        ],
      },
    ],
  })
  // The goal is open and the abduction hint points at the missing fact.
  assert.match(setup, /G1: .* \[open\]/)
  assert.match(setup, /needs via AX1: at\(object=car, location=car_wash\)/)

  // Compare candidates by simulation.
  const walk = await callTool('simulate_action', { spaceId: 'space:mcp', actionNodeId: 'A_WALK' })
  const drive = await callTool('simulate_action', { spaceId: 'space:mcp', actionNodeId: 'A_DRIVE' })
  assert.match(walk, /would satisfy goals: none/)
  assert.match(drive, /would satisfy goals: G1/)

  // Commit the chosen action; the returned context shows the goal closed.
  const applied = await callTool('apply_action', { spaceId: 'space:mcp', actionNodeId: 'A_DRIVE' })
  assert.match(applied, /applied A_DRIVE: \+1\/-1 fact\(s\); satisfied goals: G1/)
  assert.match(applied, /G1: .* \[satisfied\]/)

  // Rule safety errors surface as readable tool results, not crashes.
  const unsafe = await callTool('update_working_memory', {
    spaceId: 'space:mcp',
    operations: [
      {
        op: 'add_axiom',
        id: 'AX_BAD',
        label: 'Unsafe rule',
        when: [{ predicate: 'a', args: { item: '?x' } }],
        then: [{ predicate: 'b', args: { item: '?x', other: '?y' } }],
      },
    ],
  })
  assert.match(unsafe, /error: .*unsafe/)

  const context = await callTool('get_logic_context', { spaceId: 'space:mcp' })
  assert.match(context, /vocabulary:/)
  assert.doesNotMatch(context, /AX_BAD/)

  // Distill the finished bubble and seed a new task with its rules.
  const capsule = await callTool('distill_space', { spaceId: 'space:mcp' })
  assert.match(capsule, /"axioms"/)
  assert.match(capsule, /can_receive_service/)
  const seeded = await callTool('create_space', {
    id: 'space:mcp-next',
    title: 'Next task',
    seedFromSpaceId: 'space:mcp',
  })
  assert.match(seeded, /seeded 1 rule\(s\) from space:mcp/)
  assert.match(seeded, /inherited vocabulary/)

  console.log('MCP smoke verification passed.')
  console.log(applied)
} finally {
  await client.close()
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args })
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>
  const text = content
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n')
  return text
}
