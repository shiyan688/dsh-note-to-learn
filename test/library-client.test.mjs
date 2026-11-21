import assert from 'node:assert/strict'
import test from 'node:test'
import { createLibrary } from '../lib/library-client.js'

function createFixture() {
  let revision = 1
  let state = {
    notebooks: [{ id: 'book', title: 'Notebook' }],
    sections: [{ id: 'section', notebookId: 'book' }],
    pages: [
      { id: 'page', sectionId: 'section', title: 'Page', blocks: [{ id: 'block', text: 'Original' }], strokes: [] },
      { id: 'other', sectionId: 'section', title: 'Other', blocks: [], strokes: [] },
    ],
  }
  let stateRequest = signal => signal
  let writes = 0
  const library = createLibrary('workspace', async (_workspace, route, { query, json } = {}) => {
    if (route === 'state') {
      const view = query?.since === revision ? { revision } : { revision, state: structuredClone(state) }
      return stateRequest(view)
    }
    assert.equal(route, 'write')
    if (json.expectedRevision !== revision) throw Object.assign(new Error('Revision conflict'), { status: 409 })
    writes++
    state = structuredClone(json.state)
    return { revision: ++revision, state }
  })
  return {
    library,
    external(change) { state = change(state); revision++ },
    onRead(read) { stateRequest = read },
    get state() { return state },
    get writes() { return writes },
  }
}

const changePage = (target, edit) => state => ({
  ...state, pages: state.pages.map(row => row.id === target ? edit(row) : row),
})

test('refresh waits for every view and keeps an unchanged open page by reference', async () => {
  const { library, external } = createFixture()
  await library.load()
  const active = library.data.pages[0]
  let drawing = true
  const unsubscribe = library.subscribe(() => {}, { canRefresh: () => !drawing })
  external(changePage('other', page => ({ ...page, title: 'Agent title' })))
  assert.equal(await library.refresh(), false)
  assert.equal(library.data.pages[1].title, 'Other')
  drawing = false
  assert.equal(await library.refresh(), true)
  assert.equal(library.data.pages[0], active)
  assert.equal(library.data.pages[1].title, 'Agent title')
  assert.equal(await library.refresh(), false)
  unsubscribe()
})

test('refresh discards a remote snapshot when a user begins drawing during the request', async () => {
  const fixture = createFixture()
  const { library, external } = fixture
  await library.load()
  external(changePage('other', page => ({ ...page, title: 'Agent title' })))
  let complete
  fixture.onRead(view => new Promise(resolve => { complete = () => resolve(view) }))
  let drawing = false
  const unsubscribe = library.subscribe(() => {}, { canRefresh: () => !drawing })
  const refresh = library.refresh()
  drawing = true
  complete()
  assert.equal(await refresh, false)
  assert.equal(library.data.pages[1].title, 'Other')
  unsubscribe()
})

test('CAS retry preserves an Agent text append and a user stroke on the same page', async () => {
  const fixture = createFixture()
  const { library, external } = fixture
  await library.load()
  const stroke = { id: 'pen', type: 'pen', points: [{ x: 14, y: 20, pressure: 0.5 }] }
  const draft = { id: 'draft', text: 'User note' }
  external(changePage('page', page => ({ ...page, blocks: [...page.blocks, { id: 'agent', text: 'Agent note' }] })))
  library.edit(changePage('page', page => ({ ...page, blocks: [...page.blocks, draft], strokes: [stroke] })))
  await library.save()
  assert.deepEqual(fixture.state.pages[0].blocks.map(block => block.id), ['block', 'agent', 'draft'])
  assert.deepEqual(fixture.state.pages[0].strokes, [stroke])
  assert.equal(fixture.writes, 1)
  assert.equal(library.error, undefined)
})

test('concurrent edits to a single block leave the local draft and disk history separate', async () => {
  const fixture = createFixture()
  const { library, external } = fixture
  await library.load()
  external(changePage('page', page => ({ ...page, blocks: [{ id: 'block', text: 'Agent edit' }] })))
  library.edit(changePage('page', page => ({ ...page, blocks: [{ id: 'block', text: 'User edit' }] })))
  await assert.rejects(library.save(), { status: 409 })
  assert.equal(library.data.pages[0].blocks[0].text, 'User edit')
  assert.equal(fixture.state.pages[0].blocks[0].text, 'Agent edit')
  assert.equal(await library.refresh(), false)
  assert.equal(fixture.writes, 0)
})

test('save retries after the editing surface finishes an in-progress gesture', async () => {
  const fixture = createFixture()
  const { library, external } = fixture
  await library.load()
  let drawing = true
  const unsubscribe = library.subscribe(() => {}, { canRefresh: () => !drawing })
  external(changePage('other', page => ({ ...page, title: 'Agent title' })))
  library.edit(changePage('page', page => ({ ...page, title: 'User title' })))
  await assert.rejects(library.save(), { status: 409 })
  assert.equal(await library.refresh(), false)
  drawing = false
  assert.equal(await library.refresh(), true)
  assert.deepEqual(fixture.state.pages.map(page => page.title), ['User title', 'Agent title'])
  assert.equal(fixture.writes, 1)
  unsubscribe()
})

test('two inserts that occupy the same paper location require review', async () => {
  const fixture = createFixture()
  const { library, external } = fixture
  await library.load()
  const at = { x: 20, y: 220, width: 150, height: 35 }
  external(changePage('page', page => ({ ...page, blocks: [...page.blocks, { id: 'agent', ...at }] })))
  library.edit(changePage('page', page => ({ ...page, blocks: [...page.blocks, { id: 'user', ...at }] })))
  await assert.rejects(library.save(), { status: 409 })
  assert.equal(library.data.pages[0].blocks.at(-1).id, 'user')
  assert.equal(fixture.state.pages[0].blocks.at(-1).id, 'agent')
})
