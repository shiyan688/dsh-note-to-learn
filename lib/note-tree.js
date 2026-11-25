import { t } from './i18n.js'

export function recordsById(records) {
  return new Map(records.filter(record => typeof record?.id === 'string').map(record => [record.id, record]))
}

export function isVisible(record, byId, belongs = () => true) {
  const visited = new Set()
  while (record) {
    if (record.deletedAt || visited.has(record.id) || !belongs(record)) return false
    if (!record.parentId) return true
    visited.add(record.id)
    record = byId.get(record.parentId)
  }
  return false
}

function pageBranch(root, pages, includeDeleted = true) {
  const children = new Map()
  for (const page of pages) {
    if (!page.parentId || (!includeDeleted && page.deletedAt)) continue
    if (!children.has(page.parentId)) children.set(page.parentId, [])
    children.get(page.parentId).push(page)
  }
  const result = []
  const visited = new Set()
  const pending = [root]
  while (pending.length) {
    const page = pending.pop()
    if (visited.has(page.id)) continue
    visited.add(page.id)
    result.push(page)
    const subpages = children.get(page.id) ?? []
    for (let index = subpages.length - 1; index >= 0; index--) pending.push(subpages[index])
  }
  return result
}

function checkDestination(state, { sectionId, parentId, beforeId }) {
  const sections = recordsById(state.sections)
  const pages = recordsById(state.pages)
  const section = sections.get(sectionId)
  const notebook = state.notebooks.find(({ id }) => id === section?.notebookId)
  if (!notebook || notebook.deletedAt || !isVisible(section, sections) || section.kind === 'group') {
    throw new Error(t('请选择可用的分区。'))
  }
  const parent = pages.get(parentId)
  if (parentId && (parent?.sectionId !== sectionId || !isVisible(parent, pages))) {
    throw new Error(t('目标父页必须位于所选分区。'))
  }
  const before = pages.get(beforeId)
  if (beforeId && (before?.sectionId !== sectionId || (before.parentId ?? null) !== parentId ||
      !isVisible(before, pages))) {
    throw new Error(t('请选择目标层级中的插入位置。'))
  }
}

function insertionIndex(pages, { sectionId, parentId, beforeId }) {
  if (beforeId) return pages.findIndex(page => page.id === beforeId)
  const siblings = pages.filter(page => page.sectionId === sectionId && (page.parentId ?? null) === parentId)
  const lastSibling = siblings.at(-1)
  if (lastSibling) {
    const lastBranch = new Set(pageBranch(lastSibling, pages).map(page => page.id))
    return pages.findLastIndex(page => lastBranch.has(page.id)) + 1
  }
  if (parentId) return pages.findIndex(page => page.id === parentId) + 1
  return pages.length
}

export function movePage(state, pageId, { sectionId, parentId = null, beforeId = null }) {
  const page = state.pages.find(item => item.id === pageId)
  if (!page || !isVisible(page, recordsById(state.pages))) throw new Error(t('找不到要移动的页面。'))
  const destination = { sectionId, parentId, beforeId }
  checkDestination(state, destination)
  if (beforeId === pageId) return state

  const branch = pageBranch(page, state.pages)
  const branchIds = new Set(branch.map(item => item.id))
  if (branchIds.has(parentId) || branchIds.has(beforeId)) {
    throw new Error(t('页面不能移动到自己的子页中。'))
  }
  const pages = state.pages.filter(item => !branchIds.has(item.id))
  const moved = branch.map(item => ({
    ...item,
    sectionId,
    parentId: item.id === pageId ? parentId : item.parentId,
  }))
  pages.splice(insertionIndex(pages, destination), 0, ...moved)
  return { ...state, pages }
}

function defaultPageId() {
  return globalThis.crypto.randomUUID()
}

export function copyPage(state, pageId, { sectionId, parentId = null, beforeId = null }, makeId = defaultPageId) {
  const page = state.pages.find(item => item.id === pageId)
  if (!page || !isVisible(page, recordsById(state.pages))) throw new Error(t('找不到要复制的页面。'))
  const destination = { sectionId, parentId, beforeId }
  checkDestination(state, destination)

  const branch = pageBranch(page, state.pages, false)
  const existingIds = new Set(state.pages.map(item => item.id))
  const newIds = new Map()
  for (const item of branch) {
    const id = makeId()
    if (typeof id !== 'string' || !id || existingIds.has(id)) throw new Error(t('无法为复制的页面生成唯一 ID。'))
    newIds.set(item.id, id)
    existingIds.add(id)
  }
  const copied = branch.map(item => ({
    ...structuredClone(item),
    id: newIds.get(item.id),
    sectionId,
    parentId: item.id === pageId ? parentId : newIds.get(item.parentId),
  }))
  const pages = state.pages.slice()
  pages.splice(insertionIndex(pages, destination), 0, ...copied)
  return { state: { ...state, pages }, pageId: newIds.get(pageId) }
}
