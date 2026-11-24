import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { registerNoteTools } from '../lib/note-tools.js'
import { createStore } from '../lib/store.js'

async function setup(t) {
  const directory = await mkdtemp(fileURLToPath(new URL('../.note-tools-', import.meta.url)))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createStore({ dataDir: directory })
  const cwd = join(directory, 'project')
  const other = join(directory, 'other')
  const registered = new Map()
  registerNoteTools({ register(tool, options) { registered.set(tool.name, { tool, ...options }) } }, store)
  function call(name, args, workspace = cwd) {
    return registered.get(name).tool.execute(args, {
      agent: { session: { header: { cwd: workspace } } },
      signal: new AbortController().signal,
    })
  }
  return { store, cwd, other, call, registered }
}

test('agent-created pages appear in the same local store and may become subpages', async t => {
  const { store, cwd, call } = await setup(t)
  const page = await call('note_create', { title: 'Physics', markdown: 'Euler equation $e^{iπ}=-1$' })
  const child = await call('note_create', { title: 'Derivation', parentPageId: page.pageId })
  assert.equal(child.sectionId, page.sectionId)
  const { revision, state } = await store.read(cwd)
  assert.equal(revision, 2)
  assert.equal(state.notebooks[0].title, '学习笔记')
  assert.equal(state.pages[1].parentId, page.pageId)
  const found = await call('note_search', { query: 'euler' })
  assert.deepEqual(found.pages.map(result => result.pageId), [page.pageId])
  const read = await call('note_read', { pageId: page.pageId })
  assert.equal(read.blocks[0].blockId, page.blockId)
  assert.match(read.blocks[0].text, /Euler equation/)
})

test('agent boundaries exclude foreign workspaces, trashed ancestors, and image payloads', async t => {
  const { store, cwd, other, call, registered } = await setup(t)
  const created = await call('note_create', { title: 'Private OCR', markdown: 'Workspace phrase' })
  const trash = await call('note_create', { title: 'Deleted parent' })
  const hidden = await call('note_create', { title: 'Hidden child', parentPageId: trash.pageId, markdown: 'hidden marker' })
  const { revision, state } = await store.read(cwd)
  state.pages[0].blocks.push({
    id: 'picture', kind: 'image', dataUrl: 'data:image/png;base64,privatepayload', ocrText: 'Image OCR target',
    source: { title: 'Scanned file', path: 'C:\\private\\secret.pdf', page: 2 },
  })
  state.pages[1].deletedAt = 'today'
  await store.write(cwd, { expectedRevision: revision, state })
  assert.equal((await call('note_search', { query: 'ocr target' })).pages.length, 1)
  assert.deepEqual(await call('note_search', { query: 'workspace phrase' }, other), { pages: [], sections: [] })
  await assert.rejects(call('note_read', { pageId: created.pageId }, other), /找不到/)
  await assert.rejects(call('note_read', { pageId: hidden.pageId }), /找不到/)
  await assert.rejects(call('note_read', { pageId: created.pageId, workspace: cwd }, other), /未知参数/)
  await assert.rejects(call('note_search', { query: '  ' }), /必须包含内容/)
  assert.equal(registered.get('note_read').when({ agent: { session: { header: { cwd: 'relative' } } } }), false)
  const image = (await call('note_read', { pageId: created.pageId, blockId: 'picture' })).blocks[0]
  assert.equal(image.text, 'Image OCR target')
  assert.equal(image.sourcePage, 2)
  assert.doesNotMatch(JSON.stringify(image), /privatepayload|secret\.pdf/)
})

test('targeted editing preserves images, strokes and other text and refuses stale versions', async t => {
  const { store, cwd, call } = await setup(t)
  const created = await call('note_create', { title: 'Paper', markdown: 'Version before edit' })
  let { revision, state } = await store.read(cwd)
  const paper = state.pages[0]
  const stroke = { id: 'ink', kind: 'pen', points: [{ x: 100, y: 30, pressure: 0.5 }] }
  const picture = { id: 'image', kind: 'image', dataUrl: 'data:image/png;base64,AA==' }
  paper.strokes.push(stroke)
  paper.blocks.push(picture)
  await store.write(cwd, { expectedRevision: revision, state })

  const [block] = (await call('note_read', { pageId: created.pageId })).blocks
  const edited = await call('note_edit', {
    pageId: created.pageId, blockId: block.blockId, expectedBlockVersion: block.blockVersion,
    mode: 'replace_text', markdown: 'Version after edit',
  })
  assert.equal(edited.blockId, block.blockId)
  await assert.rejects(call('note_edit', {
    pageId: created.pageId, blockId: block.blockId, expectedBlockVersion: block.blockVersion,
    mode: 'replace_text', markdown: 'Stale overwrite',
  }), /文字块已变化/)
  await call('note_edit', { pageId: created.pageId, mode: 'append', markdown: 'Question to revisit' })
  ;({ state } = await store.read(cwd))
  assert.deepEqual(state.pages[0].strokes, [stroke])
  assert.deepEqual(state.pages[0].blocks[1], picture)
  assert.equal(state.pages[0].blocks[0].text, 'Version after edit')
  assert.equal(state.pages[0].blocks[2].text, 'Question to revisit')
})

test('an Agent can choose a native layout and update a real, versioned card', async t => {
  const { call } = await setup(t)
  const newPage = await call('note_create', {
    title: 'Two cards', layout: 'steps', markdown: '- Pick first\n- Pick second',
    card: { type: 'two-card', summary: 'Second draw depends on the first.' },
  })
  const { pageId, blockId, cardBlockId } = newPage
  assert.ok(cardBlockId && cardBlockId !== blockId)
  const [text, card] = (await call('note_read', { pageId })).blocks
  assert.equal(text.layout, 'steps')
  assert.deepEqual(card.card.probabilities, { AB: 0.5, BA: 0.5, AA: 0, BB: 0 })
  const update = {
    pageId, mode: 'replace_card', blockId: cardBlockId, expectedBlockVersion: card.blockVersion,
    card: { type: 'two-card', rule: 'independent', question: 'Why is AA possible?' },
  }
  await call('note_edit', update)
  const [after] = (await call('note_read', { pageId, blockId: cardBlockId })).blocks
  assert.deepEqual(after.card.probabilities, { AB: 0.25, BA: 0.25, AA: 0.25, BB: 0.25 })
  assert.equal(after.card.summary, card.card.summary)
  assert.equal(after.card.question, 'Why is AA possible?')
  assert.match(after.text, /\| AA \| 25% \|/)
  assert.equal((await call('note_search', { query: 'aa possible' })).pages[0].pageId, pageId)
  await assert.rejects(call('note_edit', update), /卡片已变化/)
  await assert.rejects(call('note_edit', { pageId, mode: 'append_card', card: { type: 'two-card', probabilities: { AA: 1 } } }), /未知参数/)
  await assert.rejects(call('note_edit', { pageId, mode: 'append_card', card: { type: 'two-card', rule: 'unknown' } }), /无效/)
})
