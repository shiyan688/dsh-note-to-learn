import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { CARD_TEXT_LIMIT, NOTE_FIGURE_FENCE, NOTE_LAYOUTS, TWO_CARD, TWO_CARD_RULES, twoCard, twoCardMarkdown } from './note-components.js'
import { copyPage, isVisible, movePage, recordsById } from './note-tree.js'

const maxText = 12_000
const paperHeightLimit = 8192
const string = { type: 'string' }
const integer = { type: 'integer' }
const boolean = { type: 'boolean' }
const noteId = description => ({ type: 'string', description })
const record = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const list = items => ({ type: 'array', items })
const noteCollections = { notebook: 'notebooks', section: 'sections', page: 'pages' }
const entryKind = { ...string, enum: Object.keys(noteCollections) }
const sectionKind = { ...string, enum: ['section', 'group'] }
const ruleField = { ...string, enum: TWO_CARD_RULES }
const figureFence = '```' + NOTE_FIGURE_FENCE
const writingGuidance = 'Write in the user’s language. Give the takeaway first. For each major sticking point in a difficult topic, prefer a small labeled figure next to the explanation. Use a clickable flow for a sequence, a switchable bar chart for numeric comparisons across conditions, or a short table for qualitative comparisons. Add a concrete example or one sentence that tells the reader what to look for.'
const markdownField = {
  ...string,
  description: [
    `Raw Markdown body, up to ${maxText} characters. One block can mix headings, prose, lists, pipe tables, and LaTeX.`,
    'Typeset mathematical expressions in KaTeX-compatible LaTeX. Use $...$ for inline math with no space inside the delimiters, including in table cells. Put each $$ delimiter on its own line for display math. Use \\begin{aligned} and \\end{aligned} inside display math for multiline derivations. Keep equations outside code spans and code fences. Define new symbols, state assumptions and units, and verify that the derivation matches the explanation.',
    'Use a header separator row and a blank line before a pipe table. In cell formulas, use \\mid for a conditional probability bar.',
    '',
    'Example:',
    '## Two draws',
    '',
    'When the draws are independent, $P(AA)=P(A)^2$.',
    '',
    '| Rule | Probability of AA |',
    '| --- | --- |',
    '| Independent | $\\frac{1}{4}$ |',
    '',
    '$$',
    'P(AA)=\\frac{1}{2}\\times\\frac{1}{2}=\\frac{1}{4}',
    '$$',
    '',
    'An interactive figure uses a fenced note-figure block containing one JSON object. Labels and captions are plain text. The first step or scenario appears by default. Use the figures for relationships relevant to the explanation.',
    'A flow has 2–8 steps, each with a label and explanation.',
    figureFence,
    '{"type":"flow","title":"Two draws","steps":[{"label":"First draw","explanation":"Pick A or B with equal probability."},{"label":"Second draw","explanation":"Under independent draws, the first result does not change these probabilities."}]}',
    '```',
    'A bar chart has 1–8 category labels and up to 4 scenarios. Supply one nonnegative value per label in every scenario, a unit where applicable, and an optional shared max. Explain what changes when the reader switches conditions.',
    figureFence,
    '{"type":"bar","title":"Probability of AA and AB","labels":["AA","AB"],"unit":"%","max":100,"scenarios":[{"label":"Without replacement","values":[0,50]},{"label":"Independent draws","values":[25,25],"explanation":"AA becomes possible because the first card is available again."}]}',
    '```',
  ].join('\n'),
}
const layoutField = {
  ...string, enum: NOTE_LAYOUTS,
  description: 'Omit when creating or appending a block that should render as standard Markdown. Use comparison for tables or labeled bullets, steps for ordered instructions, checklist for tasks, or auto to infer a native layout. On replace_text, omitting layout keeps the existing block layout.',
}
const cardFields = {
  type: { ...string, enum: [TWO_CARD] },
  rule: ruleField,
  summary: { ...string, description: 'Optional user-facing takeaway, up to 2000 characters.' },
  question: { ...string, description: 'Optional follow-up question, up to 2000 characters.' },
}
const cardInput = {
  ...record(cardFields, ['type']),
  description: 'Native Two Cards exercise for fair draws of A/B. Choose a rule and supply an optional summary/question. The plug-in calculates the probabilities.',
}

function workspaceOf(agent) {
  const session = agent?.session
  const workspace = agent?.workspace
  return [session?.header?.cwd, session?.cwd, workspace?.path, workspace]
    .find(cwd => typeof cwd === 'string' && isAbsolute(cwd))
}

function exactArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('笔记工具需要对象参数。')
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new Error('笔记工具收到未知参数。')
  }
  for (const [key, field] of Object.entries(schema.properties)) {
    const value = args[key]
    if (value === undefined && !schema.required.includes(key)) continue
    if (field.type === 'string' && typeof value === 'string' && (!field.enum || field.enum.includes(value))) continue
    if (field.type === 'integer' && Number.isSafeInteger(value) && value >= 0) continue
    if (field.type === 'boolean' && typeof value === 'boolean') continue
    if (field.type === 'object' && value !== undefined) {
      exactArgs(field, value)
      continue
    }
    throw new Error(`无效的笔记参数 ${key}。`)
  }
}

function nonBlank(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} 必须包含内容且不超过 ${maxLength} 字符。`)
  }
  return value
}

function limitTo(value, defaultValue, maximum) {
  if (value === undefined) return defaultValue
  if (value < 1 || value > maximum) throw new Error(`limit 必须在 1 到 ${maximum} 之间。`)
  return value
}

function indexNotes(state) {
  const records = {
    notebook: recordsById(state.notebooks),
    section: recordsById(state.sections),
    page: recordsById(state.pages),
  }
  function notebook(id) {
    const entry = records.notebook.get(id)
    if (entry && !entry.deletedAt) return entry
  }
  function section(id) {
    const entry = records.section.get(id)
    if (notebook(entry?.notebookId) && isVisible(entry, records.section, item => item.notebookId === entry.notebookId)) {
      return entry
    }
  }
  function page(id) {
    const entry = records.page.get(id)
    const parentSection = section(entry?.sectionId)
    if (parentSection && parentSection.kind !== 'group' && isVisible(entry, records.page, item => item.sectionId === entry.sectionId)) {
      return entry
    }
  }
  return { records, visible: { notebook, section, page } }
}

function sectionOf(index, id) {
  const section = index.visible.section(id)
  if (section?.kind !== 'group') return section
}

function targetPage(index, id) {
  const page = index.visible.page(id)
  if (!page) throw new Error('找不到当前工作区内可访问的笔记页。')
  return { page, section: index.records.section.get(page.sectionId) }
}

function heading(page, section) {
  return {
    pageId: page.id, title: String(page.title ?? ''), sectionId: section.id, notebookId: section.notebookId,
  }
}

function blockContent(block) {
  if (block.kind === 'card' && block.card?.type === TWO_CARD) return twoCardMarkdown(block.card)
  return block.kind === 'text' ? String(block.markdown ?? block.text ?? '') : String(block.ocrText ?? block.ocr?.text ?? '')
}

function blockVersion(block) {
  return createHash('sha256').update(JSON.stringify(block)).digest('hex')
}

function blockView(block, offset, limit, includeVersion = false) {
  const text = blockContent(block)
  const record = {
    blockId: block.id, kind: String(block.kind ?? 'unknown'), text: text.slice(offset, offset + limit),
    truncated: offset + limit < text.length,
  }
  if (typeof block.name === 'string') record.name = block.name.slice(0, 240)
  if (includeVersion || block.kind === 'text' || (block.kind === 'card' && block.card?.type === TWO_CARD)) {
    record.blockVersion = blockVersion(block)
  }
  if (NOTE_LAYOUTS.includes(block.layout)) record.layout = block.layout
  if (block.kind === 'card' && block.card?.type === TWO_CARD) record.card = twoCard(block.card)
  if (block.source && typeof block.source === 'object') {
    const { title, url, pageNumber, page } = block.source
    if (typeof title === 'string') record.sourceTitle = title.slice(0, 240)
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) record.sourceUrl = url.slice(0, 2048)
    const number = pageNumber ?? page
    if (Number.isSafeInteger(number) && number > 0) record.sourcePage = number
  }
  return record
}

function textHeight(markdown, width) {
  const columns = Math.max(15, Math.floor(width / 13))
  const lines = markdown.split(/\r?\n/).reduce((count, row) => count + Math.max(1, Math.ceil(row.length / columns)), 0)
  return Math.max(44, lines * 24 + 26)
}

function addBlock(page, payload) {
  if (page.background) {
    throw new Error('PDF 底页使用固定版面。请用 note_create 创建此页的子页，或指定已有文字块进行编辑。')
  }
  const blocks = page.blocks ?? []
  const occupied = blocks.length || page.strokes?.length
  const width = Math.max(200, (page.width || 820) - 76)
  const bottom = blocks.reduce((max, block) => Math.max(max, (block.y || 0) + (block.height || 0)), page.height || 1120)
  const y = occupied ? bottom + 24 : 38
  const height = payload.kind === 'card' ? 395 : textHeight(payload.markdown, width)
  if (y + height + 36 > paperHeightLimit) {
    throw new Error('此页剩余空间不足。请缩短文本或用 note_create 新建子页。')
  }
  const block = { id: randomUUID(), x: 38, y, width, height, placement: 'flow', ...payload }
  return {
    page: { ...page, height: Math.max(page.height || 1120, y + height + 36), blocks: [...blocks, block] },
    blockId: block.id,
  }
}

function editBlock(page, id, expectedVersion, kind, update) {
  const blocks = (page.blocks ?? []).slice()
  const index = blocks.findIndex(candidate => candidate?.id === id)
  const block = blocks[index]
  const label = kind === 'text' ? '文字块' : kind === 'card' ? '卡片' : '笔记块'
  if (!block || (kind && block.kind !== kind) || (kind === 'card' && block.card?.type !== TWO_CARD)) {
    throw new Error('找不到可编辑的' + label + '。')
  }
  if (blockVersion(block) !== expectedVersion) {
    throw new Error(label + '已变化，请重新运行 note_read 后再编辑。')
  }
  const updated = update(block)
  blocks.splice(index, 1, ...(updated ? [updated] : []))
  return { page: { ...page, blocks }, blockId: id }
}

function textPayload(args) {
  const markdown = nonBlank(args.markdown, 'markdown', maxText)
  return { kind: 'text', text: markdown, markdown, ...(args.layout ? { layout: args.layout } : {}) }
}

function cardPayload(value, previous) {
  if (!value || value.type !== TWO_CARD) throw new Error('需要提供 two-card 类型的 card。')
  if ([value.summary, value.question].some(text => text?.length > CARD_TEXT_LIMIT)) {
    throw new Error('卡片的总结与疑问各限 2000 字符。')
  }
  const card = twoCard({ ...previous, ...value })
  return { kind: 'card', card, text: twoCardMarkdown(card) }
}

function destination(state, sectionId, parentId) {
  const index = indexNotes(state)
  const parent = parentId ? targetPage(index, parentId) : undefined
  if (parent && sectionId && parent.section.id !== sectionId) throw new Error('父页与目标分区不一致。')
  if (parent) return { state, section: parent.section }
  if (sectionId !== undefined) {
    const section = sectionOf(index, sectionId)
    if (!section) throw new Error('找不到当前工作区内可用的分区。')
    return { state, section }
  }
  const book = state.notebooks.find(item => ['学习笔记', 'Learn Notes'].includes(item?.title) && !item.deletedAt)
    ?? { id: randomUUID(), title: '学习笔记' }
  const existing = state.sections.find(item => item?.notebookId === book.id && ['常规', 'General'].includes(item.title) &&
    !item.parentId && !item.deletedAt && item.kind !== 'group')
  if (existing) return { state, section: existing }
  const section = { id: randomUUID(), notebookId: book.id, title: book.title === 'Learn Notes' ? 'General' : '常规', parentId: null, kind: 'section' }
  return {
    section,
    state: {
      ...state,
      notebooks: state.notebooks.includes(book) ? state.notebooks : [...state.notebooks, book],
      sections: [...state.sections, section],
    },
  }
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
}

function pageTags(page) {
  return Array.isArray(page.tags) ? page.tags
    .map(tag => typeof tag === 'string' ? tag : tag?.name ?? tag?.label)
    .filter(tag => typeof tag === 'string') : []
}

function blocksOf(page) {
  return Array.isArray(page.blocks) ? page.blocks.filter(block => typeof block?.id === 'string') : []
}

function backgroundText(page) {
  return String(page.background?.ocrText || page.background?.text || page.ocrText || '')
}

function search(state, args) {
  const words = normalized(nonBlank(args.query, 'query', 300)).trim().split(/\s+/)
  const limit = limitTo(args.limit, 8, 20)
  const safeSections = new Map()
  const sections = []
  const index = indexNotes(state)
  for (const entry of index.records.section.values()) {
    if (!entry?.id || (args.notebookId && entry.notebookId !== args.notebookId) ||
        (args.sectionId && entry.id !== args.sectionId)) continue
    const section = sectionOf(index, entry.id)
    if (!section) continue
    safeSections.set(section.id, section)
    const notebook = index.records.notebook.get(section.notebookId)
    const title = String(section.title ?? '')
    const notebookTitle = String(notebook.title ?? '')
    if (sections.length < limit && words.every(word => normalized(title + ' ' + notebookTitle).includes(word))) {
      sections.push({ sectionId: section.id, notebookId: section.notebookId, title, notebookTitle })
    }
  }

  const pages = []
  for (const page of state.pages) {
    if (pages.length === limit) break
    const section = safeSections.get(page.sectionId)
    if (!section || !index.visible.page(page.id)) continue
    const body = [backgroundText(page), ...blocksOf(page).map(blockContent)].join(' ').replace(/\s+/g, ' ').trim()
    const tags = pageTags(page)
    const searchable = normalized([page.title, ...tags, body].join(' '))
    if (!words.every(word => searchable.includes(word))) continue
    const position = Math.max(0, normalized(body).indexOf(words[0]) - 32)
    const snippet = (position ? '…' : '') + body.slice(position, position + 220) +
      (body.length > position + 220 ? '…' : '')
    pages.push({ ...heading(page, section), snippet })
  }
  return { pages, sections }
}

function read(state, args) {
  const { page, section } = targetPage(indexNotes(state), nonBlank(args.pageId, 'pageId', 200))
  const blocks = blocksOf(page)
  const offset = args.offset ?? 0
  const base = heading(page, section)
  if (args.blockId !== undefined) {
    const id = nonBlank(args.blockId, 'blockId', 200)
    const block = blocks.find(item => item.id === id)
    if (!block) throw new Error('找不到所选笔记块。')
    const limit = limitTo(args.limit, 6000, maxText)
    const value = blockView(block, offset, limit, true)
    return {
      ...base,
      blocks: [value],
      ...(value.truncated ? { nextOffset: offset + limit } : {}),
    }
  }
  const limit = limitTo(args.limit, 12, 20)
  const pdfText = backgroundText(page)
  return {
    ...base,
    blocks: blocks.slice(offset, offset + limit).map(block => blockView(block, 0, 650)),
    tags: pageTags(page).slice(0, 24).map(tag => tag.slice(0, 100)),
    hasHandwriting: Boolean(page.strokes?.length),
    hasBackground: Boolean(page.background),
    ...(pdfText ? { backgroundText: pdfText.slice(0, 3000), backgroundTruncated: pdfText.length > 3000 } : {}),
    ...(offset + limit < blocks.length ? { nextOffset: offset + limit } : {}),
  }
}

function create(snapshot, args) {
  const title = nonBlank(args.title, 'title', 200).trim()
  const parentId = args.parentPageId === undefined ? null : nonBlank(args.parentPageId, 'parentPageId', 200)
  const sectionId = args.sectionId === undefined ? undefined : nonBlank(args.sectionId, 'sectionId', 200)
  const { state, section } = destination(snapshot, sectionId, parentId)
  const blank = { id: randomUUID(), sectionId: section.id, parentId, title, tags: [], blocks: [], strokes: [] }
  if (args.layout && !args.markdown) throw new Error('指定 layout 时需要提供 markdown。')
  const text = args.markdown ? addBlock(blank, textPayload(args)) : { page: blank }
  const card = args.card ? addBlock(text.page, cardPayload(args.card)) : { page: text.page }
  const blockId = text.blockId ?? card.blockId
  return {
    state: { ...state, pages: [...state.pages, card.page] },
    result: { ...heading(card.page, section), nextStep: visualReview, ...(blockId ? { blockId } : {}),
      ...(text.blockId && card.blockId ? { cardBlockId: card.blockId } : {}) },
  }
}

function edit(state, args) {
  const { page, section } = targetPage(indexNotes(state), nonBlank(args.pageId, 'pageId', 200))
  const isCard = args.mode === 'append_card' || args.mode === 'replace_card'
  const append = args.mode === 'append' || args.mode === 'append_card'
  const remove = args.mode === 'remove_block'
  if (remove && [args.markdown, args.layout, args.card].some(value => value !== undefined)) {
    throw new Error('删除笔记块只需要 pageId、blockId 和 expectedBlockVersion。')
  }
  if (isCard && (args.markdown !== undefined || args.layout !== undefined)) throw new Error('编辑卡片时请使用 card 参数。')
  if (!isCard && args.card !== undefined) throw new Error('编辑文字时请使用 markdown 与可选的 layout。')
  let change
  if (append) {
    if (args.blockId !== undefined || args.expectedBlockVersion !== undefined) {
      throw new Error('新增笔记块时请省略 blockId 和 expectedBlockVersion。')
    }
    change = addBlock(page, isCard ? cardPayload(args.card) : textPayload(args))
  } else {
    if (!args.blockId || !args.expectedBlockVersion) {
      throw new Error('替换或删除需要 note_read 返回的 blockId 和 blockVersion。')
    }
    const id = nonBlank(args.blockId, 'blockId', 200)
    const kind = remove ? undefined : isCard ? 'card' : 'text'
    change = editBlock(page, id, args.expectedBlockVersion, kind, block => {
      if (remove) return null
      if (isCard) return { ...block, ...cardPayload(args.card, block.card) }
      const updated = { ...block, ...textPayload(args) }
      delete updated.html
      return updated
    })
  }
  return {
    state: { ...state, pages: state.pages.map(item => item === page ? change.page : item) },
    result: { ...heading(change.page, section), blockId: change.blockId, nextStep: visualReview },
  }
}

function entryView(index, kind, entry) {
  const sectionId = kind === 'page' ? entry.sectionId : kind === 'section' ? entry.id : undefined
  const notebookId = kind === 'notebook' ? entry.id : index.records.section.get(sectionId)?.notebookId
  return {
    id: entry.id, kind, title: String(entry.title ?? ''),
    ...(typeof notebookId === 'string' ? { notebookId } : {}),
    ...(typeof sectionId === 'string' ? { sectionId } : {}),
    ...(typeof entry.parentId === 'string' ? { parentId: entry.parentId } : {}),
    ...(kind === 'section' ? { sectionKind: entry.kind === 'group' ? 'group' : 'section' } : {}),
    ...(typeof entry.deletedAt === 'string' && entry.deletedAt ? { deletedAt: entry.deletedAt } : {}),
  }
}

function listEntries(state, args, _exec, revision) {
  const index = indexNotes(state)
  const limit = limitTo(args.limit, 20, 50)
  const offset = args.offset ?? 0
  const kinds = args.kind ? [args.kind] : Object.keys(noteCollections)
  const matches = []
  for (const kind of kinds) {
    for (const entry of index.records[kind].values()) {
      if (args.view === 'trash' ? !entry.deletedAt : !index.visible[kind](entry.id)) continue
      const value = entryView(index, kind, entry)
      if (args.notebookId !== undefined && value.notebookId !== args.notebookId) continue
      if (args.sectionId !== undefined && value.sectionId !== args.sectionId) continue
      if (args.parentId !== undefined && value.parentId !== args.parentId) continue
      matches.push(value)
    }
  }
  return {
    entries: matches.slice(offset, offset + limit), revision,
    ...(offset + limit < matches.length ? { nextOffset: offset + limit } : {}),
  }
}

const managementFields = {
  create_notebook: ['title'],
  create_section: ['title', 'notebookId', 'parentId', 'sectionKind'],
  rename: ['kind', 'id', 'title'],
  move_page: ['id', 'sectionId', 'parentId', 'beforeId'],
  copy_page: ['id', 'sectionId', 'parentId', 'beforeId'],
  trash: ['kind', 'id'],
  restore: ['kind', 'id'],
}

function managedResult(state, kind, id, details = {}) {
  const index = indexNotes(state)
  return { state, result: { entry: entryView(index, kind, index.records[kind].get(id)), ...details } }
}

function manage(state, args) {
  const { action } = args
  for (const key of Object.keys(args)) {
    if (key !== 'action' && !managementFields[action].includes(key)) {
      throw new Error('此管理操作不接受参数 ' + key + '。')
    }
  }
  if (action === 'create_notebook') {
    const book = { id: randomUUID(), title: nonBlank(args.title, 'title', 200).trim() }
    const section = { id: randomUUID(), notebookId: book.id, title: '常规', kind: 'section', parentId: null }
    const next = { ...state, notebooks: [...state.notebooks, book], sections: [...state.sections, section] }
    return managedResult(next, 'notebook', book.id, { defaultSectionId: section.id })
  }

  const index = indexNotes(state)
  if (action === 'create_section') {
    const notebookId = nonBlank(args.notebookId, 'notebookId', 200)
    if (!index.visible.notebook(notebookId)) throw new Error('找不到当前工作区内可访问的笔记本。')
    const parentId = args.parentId === undefined ? null : nonBlank(args.parentId, 'parentId', 200)
    if (parentId) {
      const parent = index.visible.section(parentId)
      if (parent?.kind !== 'group' || parent.notebookId !== notebookId) {
        throw new Error('请选择同一笔记本内可用的分区组。')
      }
    }
    const entry = {
      id: randomUUID(), notebookId, parentId, kind: args.sectionKind ?? 'section',
      title: nonBlank(args.title, 'title', 200).trim(),
    }
    return managedResult({ ...state, sections: [...state.sections, entry] }, 'section', entry.id)
  }

  const id = nonBlank(args.id, 'id', 200)
  if (action === 'move_page' || action === 'copy_page') {
    targetPage(index, id)
    const sectionId = nonBlank(args.sectionId, 'sectionId', 200)
    if (!sectionOf(index, sectionId)) throw new Error('找不到当前工作区内可用的分区。')
    const placement = {
      sectionId,
      parentId: args.parentId === undefined ? null : nonBlank(args.parentId, 'parentId', 200),
      beforeId: args.beforeId === undefined ? null : nonBlank(args.beforeId, 'beforeId', 200),
    }
    const moved = action === 'move_page'
      ? { pageId: id, state: movePage(state, id, placement) }
      : copyPage(state, id, placement)
    return managedResult(moved.state, 'page', moved.pageId)
  }

  const kind = nonBlank(args.kind, 'kind', 200)
  const entry = index.records[kind].get(id)
  if (!entry) throw new Error('找不到当前工作区内的目标。')
  if (action === 'trash' && entry.deletedAt) return managedResult(state, kind, id)
  if (action !== 'restore' && !index.visible[kind](id)) throw new Error('找不到当前工作区内可访问的目标。')
  if (action === 'restore' && index.visible[kind](id)) return managedResult(state, kind, id)
  const update = action === 'rename'
    ? { title: nonBlank(args.title, 'title', 200).trim() }
    : { deletedAt: action === 'trash' ? new Date().toISOString() : null }
  const collection = noteCollections[kind]
  const next = { ...state, [collection]: state[collection].map(item => item === entry ? { ...entry, ...update } : item) }
  if (action === 'restore' && !indexNotes(next).visible[kind](id)) {
    throw new Error('请先恢复所属的笔记本、分区或父页，再恢复该项目。')
  }
  return managedResult(next, kind, id)
}

const headingFields = { pageId: string, title: string, sectionId: string, notebookId: string }
const headingRequired = Object.keys(headingFields)
const visualReview = 'After completing the requested note edits, call note_read with preview: true for the edited page. Check that equations appear as rendered math and match the explanation. Inspect the default figure state, labels, units, tables, and text for errors, clipping, or overlap. Check that all scenario values agree with the example. Use note_read with blockId to review the Markdown if the page overview truncated it. Fix any issues with note_edit and request a new preview. If a visual preview is unavailable, review the saved Markdown and say that the layout could not be checked visually.'
const savedRevision = 'A successful write commits to the local notebook store for the current workspace and returns its saved revision. Sessions in that workspace share those notes.'
const mutationOutput = record({
  ...headingFields, blockId: string, cardBlockId: string, revision: integer, nextStep: string,
}, [...headingRequired, 'revision', 'nextStep'])
const probability = { type: 'number' }
const cardOutput = record({
  ...cardFields,
  probabilities: record({ AB: probability, BA: probability, AA: probability, BB: probability }, ['AB', 'BA', 'AA', 'BB']),
}, ['type', 'rule', 'probabilities', 'summary', 'question'])
const blockOutput = record({
  blockId: string, kind: string, text: string, truncated: boolean, name: string, blockVersion: string,
  sourceTitle: string, sourceUrl: string, sourcePage: integer, layout: layoutField, card: cardOutput,
}, ['blockId', 'kind', 'text', 'truncated'])
const entryOutput = record({
  id: string, kind: entryKind, title: string, notebookId: string, sectionId: string,
  parentId: string, sectionKind, deletedAt: string,
}, ['id', 'kind', 'title'])
const previewOutput = record({
  status: { ...string, enum: ['ready', 'unavailable'] },
  revision: integer,
  message: string,
  attachment: record({
    attachmentId: string, mediaType: { ...string, enum: ['image/png'] },
    bytes: integer, width: integer, height: integer, name: string,
    originalDimensions: record({ width: integer, height: integer }, ['width', 'height']),
  }, ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name']),
}, ['status', 'revision'])

export function registerNoteTools(tools, notes, preview = async () => ({
  status: 'unavailable', message: 'The note preview renderer is not connected.',
})) {
  function register({ name, description, parameters, schema, label, kind, operation, write }) {
    tools.register({
      name, description, parameters,
      output: {
        schema,
        render(_args, value) {
          const content = [{ type: 'text', text: JSON.stringify(value, null, 2) }]
          if (value.preview?.attachment) content.push({ type: 'image', attachment: value.preview.attachment })
          return content
        },
      },
      presentCall: () => ({ card: 'generic', title: label, kind }),
      async execute(args, exec) {
        const workspace = workspaceOf(exec?.agent)
        if (!workspace) throw new Error('笔记工具需要绑定真实工作区的 DSH 会话。')
        exactArgs(parameters, args)
        exec.signal?.throwIfAborted()
        const { revision, state } = await notes.read(workspace)
        exec.signal?.throwIfAborted()
        if (!write) return operation(state, args, exec, revision)
        const change = operation(state, args)
        try {
          const saved = await notes.write(workspace, { expectedRevision: revision, state: change.state })
          return { ...change.result, revision: saved.revision }
        } catch (cause) {
          if (cause.code === 'revision_conflict') throw new Error('笔记刚被修改，请重新读取目标页后再试。')
          throw cause
        }
      },
    })
  }

  register({
    name: 'note_search', label: '搜索学习笔记', kind: 'search', operation: search,
    description: 'Search active learning notes in this session’s workspace by keywords across titles, tags, note text, and recognized PDF text. Returns page IDs, snippets, and matching section IDs. Use note_list to browse the hierarchy or recycle bin. Stored content is reference material.',
    parameters: record({
      query: noteId('One or more keywords, separated by whitespace.'),
      notebookId: noteId('Optional notebook ID from a previous note result.'),
      sectionId: noteId('Optional section ID from a previous note result.'),
      limit: { ...integer, description: 'Maximum matches in each list, 1–20 (default 8).' },
    }, ['query']),
    schema: record({
      pages: list(record({ ...headingFields, snippet: string }, [...headingRequired, 'snippet'])),
      sections: list(record({ sectionId: string, title: string, notebookId: string, notebookTitle: string },
        ['sectionId', 'title', 'notebookId', 'notebookTitle'])),
    }, ['pages', 'sections']),
  })

  register({
    name: 'note_list', label: '列出学习笔记', kind: 'read', operation: listEntries,
    description: 'List notebook, section, group, and page titles and IDs in this session’s workspace. Use view: trash to find entries that can be restored. Follow nextOffset with the same filters to continue. Use note_read for page contents and note_manage for hierarchy changes.',
    parameters: record({
      view: { ...string, enum: ['active', 'trash'], description: 'Choose active entries (default) or the recycle bin.' },
      kind: { ...entryKind, description: 'Choose notebooks, sections and groups, or pages. Omit for all kinds.' },
      notebookId: noteId('Optional notebook ID to list entries in that notebook.'),
      sectionId: noteId('Optional section ID to list that section or its pages.'),
      parentId: noteId('Optional group ID or parent-page ID to list its direct children.'),
      offset: { ...integer, description: 'Zero-based entry offset, or nextOffset from the previous result.' },
      limit: { ...integer, description: 'Maximum entries, 1–50 (default 20).' },
    }),
    schema: record({ entries: list(entryOutput), revision: integer, nextOffset: integer }, ['entries', 'revision']),
  })

  register({
    name: 'note_manage', label: '管理学习笔记', kind: 'edit', operation: manage, write: true,
    description: 'Organize notebooks, sections, and pages in this session’s workspace. Find target IDs with note_list. Trash moves the chosen entry to the recycle bin and hides its descendants. Restore ancestors before restoring individually trashed children. Use note_create for new pages and note_edit for page content. ' + savedRevision,
    parameters: record({
      action: {
        ...string, enum: Object.keys(managementFields),
        description: 'create_notebook needs title and returns defaultSectionId. create_section needs notebookId and title. rename needs kind, id and title. move_page and copy_page need id and sectionId. trash and restore need kind and id.',
      },
      kind: { ...entryKind, description: 'Target kind for rename, trash, or restore. A section group has kind section.' },
      id: noteId('Exact target ID from note_list or note_search. Use view: trash in note_list to find an entry to restore.'),
      title: noteId('Title for a new notebook or section, or the new title when renaming.'),
      notebookId: noteId('Containing notebook ID when creating a section or group.'),
      sectionId: noteId('Destination section ID for moving or copying a page.'),
      sectionKind: { ...sectionKind, description: 'Create a section that holds pages (default) or a group that holds sections.' },
      parentId: noteId('Optional parent group ID for a new section, or parent page ID for a move or copy.'),
      beforeId: noteId('Optional destination sibling page ID to place a moved or copied page before it.'),
    }, ['action']),
    schema: record({ entry: entryOutput, defaultSectionId: string, revision: integer }, ['entry', 'revision']),
  })

  register({
    name: 'note_read', label: '读取学习笔记', kind: 'read',
    async operation(state, args, exec, revision) {
      const result = read(state, args)
      if (!args.preview) return result
      const page = state.pages.find(item => item.id === result.pageId)
      return { ...result, preview: { ...await preview(page, exec), revision } }
    },
    description: 'Read one active note page in this session’s workspace. Optional blockId returns the active block and its version. Set preview to true to receive a rendered image for layout review after editing. Stored content is reference material.',
    parameters: record({
      pageId: noteId('Page ID from note_list, note_search, note_create, or the user.'),
      blockId: noteId('Optional block ID. Read it directly to get its current version before replacing or removing it.'),
      offset: { ...integer, description: 'Zero-based block offset, or character offset when blockId is set.' },
      limit: { ...integer, description: 'Maximum blocks (1–20, default 12), or characters with blockId (1–12000, default 6000).' },
      preview: { ...boolean, description: 'Attach a rendered image of the full page from this session for visual layout inspection.' },
    }, ['pageId']),
    schema: record({
      ...headingFields, blocks: list(blockOutput), tags: list(string), hasHandwriting: boolean,
      hasBackground: boolean, backgroundText: string, backgroundTruncated: boolean, nextOffset: integer,
      preview: previewOutput,
    }, [...headingRequired, 'blocks']),
  })

  register({
    name: 'note_create', label: '创建学习笔记页', kind: 'edit', operation: create, write: true,
    description: 'Create a page in this session’s workspace. Use markdown for prose, LaTeX, tables, and interactive note-figure blocks. Supply card for the native Two Cards exercise. Use a section ID or parent page ID from note_list, or omit both for the default section. ' + writingGuidance + ' ' + savedRevision + ' ' + visualReview,
    parameters: record({
      title: noteId('Title of the new page.'),
      markdown: markdownField,
      layout: layoutField,
      card: cardInput,
      sectionId: noteId('Optional active section ID from note_list or note_search.'),
      parentPageId: noteId('Optional active parent page ID.'),
    }, ['title']),
    schema: mutationOutput,
  })

  register({
    name: 'note_edit', label: '编辑学习笔记', kind: 'edit', operation: edit, write: true,
    description: 'Append or replace editable text or a native Two Cards exercise, or remove one block. Use markdown for prose, LaTeX, tables, and interactive note-figure blocks. For cards supply card. To replace or remove a block, read it directly with note_read and pass its blockId and blockVersion as blockId and expectedBlockVersion. A removed block remains in page history. ' + writingGuidance + ' ' + savedRevision + ' ' + visualReview,
    parameters: record({
      pageId: noteId('Active page ID.'),
      mode: {
        type: 'string', enum: ['append', 'replace_text', 'append_card', 'replace_card', 'remove_block'],
        description: 'Append or replace text or a card, or delete a single versioned block with remove_block.',
      },
      markdown: markdownField,
      layout: layoutField,
      card: cardInput,
      blockId: noteId('Existing block ID, required for replacement or removal.'),
      expectedBlockVersion: noteId('blockVersion from note_read, required for replacement or removal.'),
    }, ['pageId', 'mode']),
    schema: mutationOutput,
  })
}
