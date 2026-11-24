import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import * as notesPlugin from '../lib/index.js'

const runtime = process.env.DSH_NOTE_TEST_RUNTIME

test('DSH alpha.2 admits four complete schemas after the note bundle reloads', { skip: !runtime }, async t => {
  const require = createRequire(resolve(runtime, 'package.json'))
  assert.equal(require('@deepseek-ai/dsh-tools/package.json').version, '0.2.3-alpha.2')
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  const { ToolsService, assertSupportedJsonSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('systemPrompt', { tools() {} })
  await ctx.plugin(ToolsService)
  const oldAgent = { id: 'open-session' }
  const names = ['note_create', 'note_edit', 'note_read', 'note_search']
  async function schemas(agent) {
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: {}, signal: new AbortController().signal })
    try { return ctx.tools.schemas(agent, toolSet) } finally { toolSet.dispose() }
  }

  const bundle = ctx.plugin(notesPlugin)
  await bundle
  const initial = await schemas(oldAgent)
  assert.deepEqual(initial.map(({ name }) => name).sort(), names)
  await bundle.dispose()
  assert.deepEqual(await schemas(oldAgent), [])
  await ctx.plugin(notesPlugin)
  for (const agent of [oldAgent, { id: 'fresh-session', session: { header: {} } }]) {
    const current = await schemas(agent)
    assert.deepEqual(current, initial)
    for (const { name, description, parameters } of current) {
      assert.equal(current.filter(tool => tool.name === name).length, 1)
      assert.ok(description)
      assertSupportedJsonSchema(parameters)
      assertSupportedJsonSchema(ctx.tools.executable(name, agent).output.schema)
    }
    await assert.rejects(ctx.tools.executable('note_search', agent).execute({ query: 'note' }, { agent }), /真实工作区/)
  }
})
