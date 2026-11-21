import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const BACKUP_FORMAT = 'dsh-note-to-learn-backup'

function storeError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function documentView({ revision, state }) {
  return { revision, state }
}

function checkState(state) {
  if (!state || !Array.isArray(state.notebooks) || !Array.isArray(state.sections) || !Array.isArray(state.pages)) {
    throw storeError(400, 'invalid_state', 'Expected a document with notebooks, sections, and pages arrays.')
  }
  const pageIds = new Set()
  for (const page of state.pages) {
    if (typeof page?.id !== 'string' || !page.id || pageIds.has(page.id)) {
      throw storeError(400, 'invalid_state', 'Every page needs a unique nonempty string ID.')
    }
    pageIds.add(page.id)
  }
}

async function latestRevision(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  let latest = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue
    const revision = Number(entry.name)
    if (Number.isSafeInteger(revision) && revision > latest) latest = revision
  }
  return latest
}

async function readRecord(directory, knownRevision) {
  let revision = knownRevision ?? await latestRevision(directory)
  while (revision) {
    try {
      return JSON.parse(await readFile(join(directory, String(revision), 'state.json'), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // Another process can publish newer revisions and remove this state file mid-read.
      const newerRevision = await latestRevision(directory)
      if (newerRevision <= revision) {
        throw storeError(500, 'store_corrupt', 'The latest note document is missing from disk.')
      }
      revision = newerRevision
    }
  }
  return { revision: 0, state: { notebooks: [], sections: [], pages: [] }, pageHistory: {} }
}

async function writeSynced(path, contents) {
  const file = await open(path, 'wx')
  try {
    await file.writeFile(contents)
    await file.sync()
  } finally {
    await file.close()
  }
}

function revisionConflict() {
  return storeError(409, 'revision_conflict', 'The note document changed. Read the current revision before saving.')
}

async function publish(directory, current, state) {
  checkState(state)
  if (JSON.stringify(state) === JSON.stringify(current.state)) return documentView(current)

  const revision = current.revision + 1
  const savedAt = new Date().toISOString()
  const previousPages = new Map(current.state.pages.map(page => [page.id, page]))
  const pageHistory = { ...current.pageHistory }
  const changedPages = []
  for (const page of state.pages) {
    const snapshot = JSON.stringify(page)
    if (snapshot === JSON.stringify(previousPages.get(page.id))) continue
    const pageKey = hash(page.id)
    const version = { id: String(revision), revision, savedAt }
    pageHistory[pageKey] = [version, ...(pageHistory[pageKey] ?? [])]
    changedPages.push({ pageKey, snapshot })
  }

  await mkdir(directory, { recursive: true })
  const stage = join(directory, `.pending-${randomUUID()}`)
  const stagedPages = join(stage, 'pages')
  await mkdir(stagedPages, { recursive: true })
  const record = { revision, state, pageHistory }
  try {
    for (const { pageKey, snapshot } of changedPages) {
      await writeSynced(join(stagedPages, `${pageKey}.json.gz`), await compress(snapshot))
    }
    await writeSynced(join(stage, 'state.json'), JSON.stringify(record))
    try {
      // The destination is always a nonempty directory once published. Two
      // writers based on the same revision cannot both claim its successor.
      await rename(stage, join(directory, String(revision)))
    } catch (error) {
      if (await latestRevision(directory) >= revision) throw revisionConflict()
      throw error
    }
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
  }

  // Keep the two latest complete documents. Page versions are separate files
  // and remain reachable after old copies of the workspace document are removed.
  if (revision > 2) {
    await rm(join(directory, String(revision - 2), 'state.json'), { force: true }).catch(() => {})
  }
  return documentView(record)
}

export function createStore({ dataDir }) {
  const root = resolve(dataDir, 'workspaces')

  function workspaceDirectory(workspace) {
    if (typeof workspace !== 'string' || !workspace) {
      throw storeError(400, 'invalid_workspace', 'A workspace ID is required.')
    }
    return join(root, hash(workspace))
  }

  async function update(workspace, expectedRevision, makeState) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw storeError(400, 'invalid_revision', 'An expected document revision is required.')
    }
    const directory = workspaceDirectory(workspace)
    const current = await readRecord(directory)
    if (current.revision !== expectedRevision) throw revisionConflict()
    return publish(directory, current, await makeState(current, directory))
  }

  return {
    async read(workspace, { since } = {}) {
      const directory = workspaceDirectory(workspace)
      const revision = await latestRevision(directory)
      return revision === since ? { revision } : documentView(await readRecord(directory, revision))
    },

    async write(workspace, { expectedRevision, state } = {}) {
      return update(workspace, expectedRevision, () => state)
    },

    async history(workspace, pageId) {
      if (typeof pageId !== 'string' || !pageId) {
        throw storeError(400, 'invalid_page', 'A page ID is required.')
      }
      const { pageHistory } = await readRecord(workspaceDirectory(workspace))
      return pageHistory[hash(pageId)] ?? []
    },

    async restore(workspace, { expectedRevision, pageId, versionId } = {}) {
      if (typeof pageId !== 'string' || !pageId || typeof versionId !== 'string' || !versionId) {
        throw storeError(400, 'invalid_page_version', 'A page ID and version ID are required.')
      }
      return update(workspace, expectedRevision, async ({ state, pageHistory }, directory) => {
        const pageKey = hash(pageId)
        const version = pageHistory[pageKey]?.find(entry => entry.id === versionId)
        if (!version) throw storeError(404, 'page_version_missing', 'This page version could not be found.')
        const path = join(directory, String(version.revision), 'pages', `${pageKey}.json.gz`)
        const page = JSON.parse((await decompress(await readFile(path))).toString())
        const currentIndex = state.pages.findIndex(entry => entry.id === pageId)
        const pages = state.pages.slice()
        if (currentIndex === -1) pages.push(page)
        else pages[currentIndex] = page
        return { ...state, pages }
      })
    },

    async backup(workspace) {
      const { state } = await readRecord(workspaceDirectory(workspace))
      return { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), state }
    },

    async restoreBackup(workspace, { expectedRevision, backup } = {}) {
      if (backup?.format !== BACKUP_FORMAT || backup.version !== 1) {
        throw storeError(400, 'invalid_backup', 'This file is not a supported note backup.')
      }
      return update(workspace, expectedRevision, () => backup.state)
    },
  }
}
