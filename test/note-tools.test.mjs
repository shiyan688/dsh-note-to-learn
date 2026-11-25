import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { apply } from '../lib/index.js'
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
  await assert.rejects(call('note_read', { pageId: created.pageId }, 'relative'), /真实工作区/)
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
  await assert.rejects(call('note_edit', { pageId, mode: 'append_card', card: { type: 'two-card', summary: 'x'.repeat(2001) } }), /2000/)
})

test('an Agent can organize and save a notebook tree shared with the sidebar', async t => {
  const { store, cwd, call } = await setup(t)
  const book = await call('note_manage', { action: 'create_notebook', title: 'Research' })
  const defaultSectionId = book.defaultSectionId
  assert.equal(book.revision, 1)
  const notebookId = book.entry.id
  const group = await call('note_manage', { action: 'create_section', notebookId, title: 'Courses', sectionKind: 'group' })
  const section = await call('note_manage', { action: 'create_section', notebookId, parentId: group.entry.id, title: 'Statistics' })
  assert.equal(section.entry.parentId, group.entry.id)
  const page = await call('note_create', { title: 'Sampling', sectionId: section.entry.id, markdown: 'Sampling notes' })
  const child = await call('note_create', { title: 'Exercise', parentPageId: page.pageId, markdown: 'Exercise details' })
  await assert.rejects(call('note_manage', {
    action: 'move_page', id: page.pageId, sectionId: section.entry.id, parentId: child.pageId,
  }), /子页/)
  await call('note_manage', { action: 'move_page', id: page.pageId, sectionId: defaultSectionId })
  const moved = await call('note_list', { kind: 'page', sectionId: defaultSectionId })
  assert.deepEqual(moved.entries.map(item => item.id), [page.pageId, child.pageId])
  assert.equal(moved.entries[1].parentId, page.pageId)
  const copy = await call('note_manage', { action: 'copy_page', id: page.pageId, sectionId: section.entry.id })
  assert.notEqual(copy.entry.id, page.pageId)
  const copied = await call('note_list', { kind: 'page', parentId: copy.entry.id })
  assert.equal(copied.entries.length, 1)
  assert.notEqual(copied.entries[0].id, child.pageId)
  const renamed = await call('note_manage', { action: 'rename', kind: 'page', id: copy.entry.id, title: 'Sampling copy' })
  const { revision, state } = await store.read(cwd)
  assert.equal(revision, renamed.revision)
  assert.equal(state.pages.find(item => item.id === copy.entry.id).title, 'Sampling copy')
  assert.equal((await call('note_read', { pageId: copy.entry.id })).blocks[0].text, 'Sampling notes')
  const first = await call('note_list', { kind: 'section', notebookId, limit: 1 })
  assert.equal(first.entries[0].id, defaultSectionId)
  assert.equal(first.nextOffset, 1)
  const remaining = await call('note_list', { kind: 'section', notebookId, offset: first.nextOffset })
  assert.deepEqual(remaining.entries.map(item => item.id), [group.entry.id, section.entry.id])
})

test('trash and restore preserve note contents and respect workspace and ancestor boundaries', async t => {
  const { store, cwd, other, call } = await setup(t)
  const parent = await call('note_create', { title: 'Parent', markdown: 'Keep this note' })
  const child = await call('note_create', { title: 'Child', parentPageId: parent.pageId, markdown: 'Keep this child' })
  const childTarget = { kind: 'page', id: child.pageId }
  const parentTarget = { kind: 'page', id: parent.pageId }
  await call('note_manage', { action: 'trash', ...childTarget })
  const trashed = await call('note_manage', { action: 'trash', ...parentTarget })
  assert.ok(trashed.entry.deletedAt)
  assert.equal((await call('note_manage', { action: 'trash', ...parentTarget })).revision, trashed.revision)
  assert.equal((await call('note_list', { kind: 'page' })).entries.length, 0)
  assert.equal((await call('note_search', { query: 'Keep' })).pages.length, 0)
  const recycled = await call('note_list', { kind: 'page', view: 'trash' })
  assert.deepEqual(recycled.entries.map(item => item.id), [parent.pageId, child.pageId])
  assert.equal((await store.backup(cwd)).state.pages[0].blocks[0].text, 'Keep this note')
  await assert.rejects(call('note_manage', { action: 'restore', ...childTarget }), /请先恢复/)
  await assert.rejects(call('note_manage', { action: 'restore', ...parentTarget }, other), /找不到/)
  await assert.rejects(call('note_manage', { action: 'trash', ...parentTarget, title: 'Ambiguous' }), /不接受参数/)
  await call('note_manage', { action: 'restore', ...parentTarget })
  assert.deepEqual((await call('note_list', { kind: 'page' })).entries.map(item => item.id), [parent.pageId])
  await call('note_manage', { action: 'restore', ...childTarget })
  assert.equal((await call('note_read', { pageId: child.pageId })).blocks[0].text, 'Keep this child')
})

test('removing an attachment block checks its version and leaves it in page history', async t => {
  const { store, cwd, call } = await setup(t)
  const { pageId, blockId } = await call('note_create', { title: 'Source', markdown: 'Keep the explanation' })
  const before = await store.read(cwd)
  const attachment = { id: 'photo', kind: 'image', name: 'Photo', dataUrl: 'data:image/png;base64,AA==' }
  before.state.pages[0].blocks.push(attachment)
  await store.write(cwd, { expectedRevision: before.revision, state: before.state })
  const [versioned] = (await call('note_read', { pageId, blockId: attachment.id })).blocks
  const remove = { pageId, mode: 'remove_block', blockId: attachment.id }
  await assert.rejects(call('note_edit', { ...remove, expectedBlockVersion: 'stale' }), /笔记块已变化/)
  const result = await call('note_edit', { ...remove, expectedBlockVersion: versioned.blockVersion })
  assert.deepEqual((await call('note_read', { pageId })).blocks.map(item => item.blockId), [blockId])
  const [, prior] = await store.history(cwd, pageId)
  const restored = await store.restore(cwd, { expectedRevision: result.revision, pageId, versionId: prior.id })
  assert.deepEqual(restored.state.pages[0].blocks[1], attachment)
})

test('the installed tools return complete schemas after disposal and reinstallation, even for an id-only Agent', async () => {
  const registry = new Map()
  // DSH 0.2.3-alpha.2 refuses an installation scope when an output schema is unsupported.
  const supported = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description']
  function checkSchema(schema) {
    assert.equal(typeof schema.type, 'string')
    for (const key of Object.keys(schema)) assert.ok(supported.includes(key), `Unsupported schema keyword: ${key}`)
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false)
      assert.ok(Array.isArray(schema.required))
      for (const key of schema.required) assert.ok(Object.hasOwn(schema.properties, key))
      for (const property of Object.values(schema.properties)) checkSchema(property)
    } else if (schema.type === 'array') checkSchema(schema.items)
  }
  function install() {
    const disposers = []
    apply({
      effect(installEffect) { disposers.push(installEffect()) },
      inject([service], inject) {
        if (service !== 'tools') return
        inject({
          tools: { register(tool, options) {
            assert.equal(registry.has(tool.name), false)
            checkSchema(tool.output.schema)
            registry.set(tool.name, { tool, options })
            disposers.push(() => registry.delete(tool.name))
          } },
        })
      },
    })
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }
  function requestSchemas(agent) {
    return Array.from(registry.values()).filter(({ options }) => options?.when?.({ agent }) ?? true)
      .map(({ tool: { name, description, parameters } }) => ({ name, description, parameters }))
  }
  const oldAgent = { id: 'already-open' }
  const remove = install()
  const before = requestSchemas(oldAgent)
  remove()
  assert.deepEqual(requestSchemas(oldAgent), [])
  const cleanup = install()
  try {
    for (const agent of [oldAgent, { id: 'new-agent', session: { header: {} } }]) {
      const schemas = requestSchemas(agent)
      assert.deepEqual(schemas, before)
      assert.deepEqual(schemas.map(schema => schema.name).sort(),
        ['note_create', 'note_edit', 'note_list', 'note_manage', 'note_read', 'note_search'])
      for (const schema of schemas) {
        assert.ok(schema.description)
        assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema)
        checkSchema(schema.parameters)
      }
      await assert.rejects(registry.get('note_search').tool.execute({ query: 'test' }, { agent }), /真实工作区/)
    }
  } finally { cleanup() }
})

test('execution resolves the workspace lazily from the session and workspace fallbacks', async t => {
  const { cwd, call, registered } = await setup(t)
  const { pageId } = await call('note_create', { title: 'Fallback workspace', markdown: 'Observable note' })
  const search = registered.get('note_search').tool
  for (const agent of [
    { session: { header: {}, cwd } },
    { session: { header: { cwd: 'relative' } }, workspace: { path: cwd } },
    { workspace: cwd },
  ]) {
    const result = await search.execute({ query: 'Observable' }, { agent })
    assert.equal(result.pages[0].pageId, pageId)
  }
})
