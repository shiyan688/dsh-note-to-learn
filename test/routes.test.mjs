import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerNoteRoutes } from '../lib/index.js'
import { createNotePreviews } from '../lib/note-previews.js'

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

test('a preview job can be claimed and completed only in its originating session', async () => {
  const previews = createNotePreviews()
  const routes = new Map()
  registerNoteRoutes({ register(route) { routes.set(route.path, route) } }, {}, undefined, previews)
  function request(route, query, options) {
    const path = '/api/dsh-note-to-learn/' + route
    return routes.get(path).fetch(new Request('http://localhost' + path + '?' + new URLSearchParams(query), options))
  }
  const page = { id: 'target', blocks: [{ id: 'first', text: 'Private page' }] }
  const pending = previews.request('author', page)
  assert.equal(await (await request('preview-job', { session: 'other' })).json(), null)
  const job = await (await request('preview-job', { session: 'author' })).json()
  assert.deepEqual(job.page, page)
  assert.equal(await (await request('preview-job', { session: 'author' })).json(), null)
  const body = Buffer.from([137, 80, 78, 71])
  const submit = { method: 'POST', headers: { 'content-type': 'image/png' }, body }
  assert.equal((await request('preview-result', { session: 'other', id: job.id }, submit)).status, 404)
  assert.equal((await request('preview-result', { session: 'author', id: job.id }, submit)).status, 200)
  assert.deepEqual(await pending, body)
  assert.equal((await request('preview-result', { session: 'author', id: job.id }, submit)).status, 404)
  const cancel = new AbortController()
  const cancelled = previews.request('author', page, cancel.signal)
  cancel.abort()
  assert.equal(await cancelled, undefined)
  assert.equal(previews.take('author'), null)
})
