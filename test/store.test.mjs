import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'

const document = title => ({
  notebooks: [{ id: 'n', title: 'Research' }],
  sections: [{ id: 's', notebookId: 'n', title: 'Reading' }],
  pages: [{
    id: 'p',
    sectionId: 's',
    title,
    blocks: [{ type: 'image', src: 'data:image/png;base64,AA==' }],
    strokes: [{ points: [{ x: 25, y: 25, pressure: 0.4 }] }],
  }],
})

async function isolatedStore(t) {
  const dataDir = await mkdtemp(fileURLToPath(new URL('../.note-store-', import.meta.url)))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  return { dataDir, store: createStore({ dataDir }) }
}

test('persists page versions, protects revisions, and restores an old snapshot', async t => {
  const { dataDir, store } = await isolatedStore(t)
  assert.deepEqual(await store.read('project'), {
    revision: 0,
    state: { notebooks: [], sections: [], pages: [] },
  })
  assert.equal((await store.write('project', { expectedRevision: 0, state: document('First') })).revision, 1)
  assert.equal((await store.write('project', { expectedRevision: 1, state: document('First') })).revision, 1)
  await assert.rejects(store.write('project', { expectedRevision: 0, state: document('Lost') }), {
    status: 409,
    code: 'revision_conflict',
  })
  await store.write('project', { expectedRevision: 1, state: document('Second') })
  await store.write('project', { expectedRevision: 2, state: document('Third') })

  const reopened = createStore({ dataDir })
  assert.deepEqual((await reopened.read('project')).state, document('Third'))
  assert.deepEqual((await reopened.history('project', 'p')).map(item => item.revision), [3, 2, 1])
  await assert.rejects(reopened.restore('project', {
    expectedRevision: 3, pageId: 'p', versionId: '404',
  }), { status: 404, code: 'page_version_missing' })
  const restored = await reopened.restore('project', {
    expectedRevision: 3, pageId: 'p', versionId: '1',
  })
  assert.deepEqual(restored, { revision: 4, state: document('First') })
  assert.deepEqual((await reopened.history('project', 'p')).map(item => item.revision), [4, 3, 2, 1])
})

test('concurrent stores cannot both save against the same revision', async t => {
  const { dataDir, store } = await isolatedStore(t)
  const other = createStore({ dataDir })
  const results = await Promise.allSettled([
    store.write('project', { expectedRevision: 0, state: document('First writer') }),
    other.write('project', { expectedRevision: 0, state: document('Second writer') }),
  ])
  const saved = results.filter(result => result.status === 'fulfilled')
  const conflicts = results.filter(result => result.status === 'rejected')
  assert.equal(saved.length, 1)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].reason.code, 'revision_conflict')
  assert.deepEqual(await store.read('project'), saved[0].value)
  assert.equal((await store.history('project', 'p')).length, 1)
})

test('backs up workspace state including trash and attachments and imports as a new revision', async t => {
  const { store } = await isolatedStore(t)
  const state = document('Deleted note')
  state.pages[0].deletedAt = '2026-11-18T00:00:00.000Z'
  await store.write('project', { expectedRevision: 0, state })
  const backup = JSON.parse(JSON.stringify(await store.backup('project')))
  assert.equal(backup.format, 'dsh-note-to-learn-backup')
  assert.equal((await store.read('another-project')).revision, 0)
  await assert.rejects(store.restoreBackup('another-project', {
    expectedRevision: 0, backup: { ...backup, version: 9 },
  }), { status: 400, code: 'invalid_backup' })
  const restored = await store.restoreBackup('another-project', { expectedRevision: 0, backup })
  assert.deepEqual(restored, { revision: 1, state })
  assert.deepEqual((await store.history('another-project', 'p')).map(item => item.revision), [1])
})
