import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerNoteRoutes } from '../lib/index.js'

test('registers read-only routes without streaming GET bodies', async () => {
  const routes = new Map()
  const calls = []
  registerNoteRoutes({ register(route) { routes.set(route.path, route) } }, {
    read: async workspace => ({ workspace, revision: 0 }),
    write: async (workspace, document) => { calls.push([workspace, document]); return { revision: 1 } },
  })
  const read = routes.get('/api/dsh-note-to-learn/state')
  assert.deepEqual(read.methods, ['GET'])
  assert.equal(read.requestBody, 'buffered')
  const readResponse = await read.fetch(new Request(`http://localhost${read.path}?workspace=notes`))
  assert.deepEqual(await readResponse.json(), { workspace: 'notes', revision: 0 })
  assert.equal((await read.fetch(new Request(`http://localhost${read.path}`))).status, 400)
  const write = routes.get('/api/dsh-note-to-learn/write')
  assert.equal(write.requestBody, 'streaming')
  const body = { expectedRevision: 0, state: { notebooks: [], sections: [], pages: [] } }
  const response = await write.fetch(new Request(`http://localhost${write.path}?workspace=notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  assert.deepEqual(calls, [['notes', body]])
  assert.deepEqual(await response.json(), { revision: 1 })
})
