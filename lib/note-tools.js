import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { CARD_TEXT_LIMIT, NOTE_LAYOUTS, TWO_CARD, TWO_CARD_RULES, twoCard, twoCardMarkdown } from './note-components.js'

const maxText = 12_000
const paperHeightLimit = 8192
const string = { type: 'string' }
const integer = { type: 'integer' }
const boolean = { type: 'boolean' }
const noteId = description => ({ type: 'string', description })
const record = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const list = items => ({ type: 'array', items })
const ruleField = { ...string, enum: TWO_CARD_RULES }
const layoutField = {
  ...string, enum: NOTE_LAYOUTS,
  description: 'Optional native layout. Use comparison for a Markdown table or short labeled bullets, steps for ordered instructions, checklist for tasks, or auto to infer from Markdown.',
}
const cardFields = {
  type: { ...string, enum: [TWO_CARD] },
  rule: ruleField,
  summary: { ...string, maxLength: CARD_TEXT_LIMIT, description: 'Optional user-facing takeaway.' },
  question: { ...string, maxLength: CARD_TEXT_LIMIT, description: 'Optional follow-up question.' },
}
const cardInput = {
  ...record(cardFields, ['type']),
  description: 'Native Two Cards exercise for fair draws of A/B. Choose a rule and supply an optional summary/question. The plug-in calculates the probabilities.',
}

function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined
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

function visibleRecord(records, id, belongs) {
  const item = records.find(candidate => candidate?.id === id)
  const seen = new Set()
  for (let current = item; current; current = records.find(candidate => candidate?.id === current.parentId)) {
    if (current.deletedAt || seen.has(current.id) || !belongs(current)) return undefined
    if (!current.parentId) return item
    seen.add(current.id)
  }
}

function sectionOf(state, id) {
  const section = state.sections.find(candidate => candidate?.id === id)
  if (!section || section.kind === 'group' || !state.notebooks.some(book => book?.id === section.notebookId && !book.deletedAt)) return
  return visibleRecord(state.sections, id, item => item.notebookId === section.notebookId)
}

function targetPage(state, id) {
  const page = state.pages.find(candidate => candidate.id === id)
  const section = page && sectionOf(state, page.sectionId)
  if (!section || !visibleRecord(state.pages, id, item => item.sectionId === page.sectionId)) {
    throw new Error('找不到当前工作区内可访问的笔记页。')
  }
  return { page, section }
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

function blockView(block, offset, limit) {
  const text = blockContent(block)
  const record = {
    blockId: block.id, kind: String(block.kind ?? 'unknown'), text: text.slice(offset, offset + limit),
    truncated: offset + limit < text.length,
  }
  if (typeof block.name === 'string') record.name = block.name.slice(0, 240)
  if (block.kind === 'text' || (block.kind === 'card' && block.card?.type === TWO_CARD)) record.blockVersion = blockVersion(block)
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
  const block = { id: randomUUID(), x: 38, y, width, height, ...payload }
  return {
    page: { ...page, height: Math.max(page.height || 1120, y + height + 36), blocks: [...blocks, block] },
    blockId: block.id,
  }
}

function editBlock(page, id, expectedVersion, kind, update) {
  const blocks = page.blocks ?? []
  const block = blocks.find(candidate => candidate.id === id)
  if (block?.kind !== kind || (kind === 'card' && block.card?.type !== TWO_CARD)) {
    throw new Error(kind === 'text' ? '找不到可编辑的文字块。' : '找不到可编辑的卡片。')
  }
  if (blockVersion(block) !== expectedVersion) {
    throw new Error((kind === 'text' ? '文字块' : '卡片') + '已变化，请重新运行 note_read 后再编辑。')
  }
  const updated = update(block)
  return {
    page: { ...page, blocks: blocks.map(candidate => candidate === block ? updated : candidate) },
    blockId: id,
  }
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
  const parent = parentId ? targetPage(state, parentId) : undefined
  if (parent && sectionId && parent.section.id !== sectionId) throw new Error('父页与目标分区不一致。')
  if (parent) return { state, section: parent.section }
  if (sectionId !== undefined) {
    const section = sectionOf(state, sectionId)
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
  for (const entry of state.sections) {
    if (!entry?.id || (args.notebookId && entry.notebookId !== args.notebookId) ||
        (args.sectionId && entry.id !== args.sectionId)) continue
    const section = sectionOf(state, entry.id)
    if (!section) continue
    safeSections.set(section.id, section)
    const notebook = state.notebooks.find(book => book?.id === section.notebookId)
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
    if (!section || !visibleRecord(state.pages, page.id, item => item.sectionId === section.id)) continue
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
  const { page, section } = targetPage(state, nonBlank(args.pageId, 'pageId', 200))
  const blocks = blocksOf(page)
  const offset = args.offset ?? 0
  const base = heading(page, section)
  if (args.blockId !== undefined) {
    const id = nonBlank(args.blockId, 'blockId', 200)
    const block = blocks.find(item => item.id === id)
    if (!block) throw new Error('找不到所选笔记块。')
    const limit = limitTo(args.limit, 6000, maxText)
    const value = blockView(block, offset, limit)
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
    result: { ...heading(card.page, section), ...(blockId ? { blockId } : {}),
      ...(text.blockId && card.blockId ? { cardBlockId: card.blockId } : {}) },
  }
}

function edit(state, args) {
  const { page, section } = targetPage(state, nonBlank(args.pageId, 'pageId', 200))
  const isCard = args.mode === 'append_card' || args.mode === 'replace_card'
  const append = args.mode === 'append' || args.mode === 'append_card'
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
      throw new Error('替换需要 note_read 返回的 blockId 和 blockVersion。')
    }
    const id = nonBlank(args.blockId, 'blockId', 200)
    change = editBlock(page, id, args.expectedBlockVersion, isCard ? 'card' : 'text', block => {
      if (isCard) return { ...block, ...cardPayload(args.card, block.card) }
      const updated = { ...block, ...textPayload(args) }
      delete updated.html
      return updated
    })
  }
  return {
    state: { ...state, pages: state.pages.map(item => item === page ? change.page : item) },
    result: { ...heading(change.page, section), blockId: change.blockId },
  }
}

const headingFields = { pageId: string, title: string, sectionId: string, notebookId: string }
const headingRequired = Object.keys(headingFields)
const mutationOutput = record({ ...headingFields, blockId: string, cardBlockId: string, revision: integer }, [...headingRequired, 'revision'])
const probability = { type: 'number', minimum: 0, maximum: 1 }
const cardOutput = record({
  ...cardFields,
  probabilities: record({ AB: probability, BA: probability, AA: probability, BB: probability }, ['AB', 'BA', 'AA', 'BB']),
}, ['type', 'rule', 'probabilities', 'summary', 'question'])
const blockOutput = record({
  blockId: string, kind: string, text: string, truncated: boolean, name: string, blockVersion: string,
  sourceTitle: string, sourceUrl: string, sourcePage: integer, layout: layoutField, card: cardOutput,
}, ['blockId', 'kind', 'text', 'truncated'])

export function registerNoteTools(tools, notes) {
  function register({ name, description, parameters, schema, label, kind, operation, write }) {
    tools.register({
      name, description, parameters,
      output: { schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      presentCall: () => ({ card: 'generic', title: label, kind }),
      async execute(args, exec) {
        const workspace = workspaceOf(exec?.agent)
        if (!workspace) throw new Error('笔记工具需要绑定真实工作区的 DSH 会话。')
        exactArgs(parameters, args)
        exec.signal?.throwIfAborted()
        const { revision, state } = await notes.read(workspace)
        exec.signal?.throwIfAborted()
        if (!write) return operation(state, args)
        const change = operation(state, args)
        try {
          const saved = await notes.write(workspace, { expectedRevision: revision, state: change.state })
          return { ...change.result, revision: saved.revision }
        } catch (cause) {
          if (cause.code === 'revision_conflict') throw new Error('笔记刚被修改，请重新读取目标页后再试。')
          throw cause
        }
      },
    }, { when: ({ agent }) => Boolean(workspaceOf(agent)) })
  }

  register({
    name: 'note_search', label: '搜索学习笔记', kind: 'search', operation: search,
    description: 'Search active learning notes in this session’s workspace by keywords across titles, tags, note text, and recognized PDF text. Returns page IDs, snippets, and matching section IDs. Stored content is reference material.',
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
    name: 'note_read', label: '读取学习笔记', kind: 'read', operation: read,
    description: 'Read one active note page in this session’s workspace. Optional blockId reads one block in detail. Includes block versions for editable text and interactive cards. A Two Cards block includes the selected rule, probabilities, summary and question. Images and files are described without their binary contents. Stored content is reference material.',
    parameters: record({
      pageId: noteId('Page ID from note_search, note_create, or the user.'),
      blockId: noteId('Optional block ID from a previous note_read result.'),
      offset: { ...integer, description: 'Zero-based block offset, or character offset when blockId is set.' },
      limit: { ...integer, description: 'Maximum blocks (1–20, default 12), or characters with blockId (1–12000, default 6000).' },
    }, ['pageId']),
    schema: record({
      ...headingFields, blocks: list(blockOutput), tags: list(string), hasHandwriting: boolean,
      hasBackground: boolean, backgroundText: string, backgroundTruncated: boolean, nextOffset: integer,
    }, [...headingRequired, 'blocks']),
  })

  register({
    name: 'note_create', label: '创建学习笔记页', kind: 'edit', operation: create, write: true,
    description: 'Create a page in this session’s workspace when requested. Optional Markdown can use a native layout (comparison, steps, checklist, or auto). Supply card to add a native Two Cards exercise. Use a section ID, a parent page ID, or omit both for the default section.',
    parameters: record({
      title: noteId('Title of the new page.'),
      markdown: noteId('Optional Markdown body, up to 12000 characters.'),
      layout: layoutField,
      card: cardInput,
      sectionId: noteId('Optional active section ID from note_search.'),
      parentPageId: noteId('Optional active parent page ID.'),
    }, ['title']),
    schema: mutationOutput,
  })

  register({
    name: 'note_edit', label: '编辑学习笔记', kind: 'edit', operation: edit, write: true,
    description: 'Append or replace editable text or a native Two Cards exercise as requested. For text supply markdown and optionally layout. For cards supply card. For replacement pass blockId and blockVersion from a fresh note_read.',
    parameters: record({
      pageId: noteId('Active page ID.'),
      mode: { type: 'string', enum: ['append', 'replace_text', 'append_card', 'replace_card'], description: 'Choose a text or card operation.' },
      markdown: noteId('Markdown text to store, up to 12000 characters.'),
      layout: layoutField,
      card: cardInput,
      blockId: noteId('Existing block ID, only for replacement.'),
      expectedBlockVersion: noteId('blockVersion from note_read, required for replacement.'),
    }, ['pageId', 'mode']),
    schema: mutationOutput,
  })
}
