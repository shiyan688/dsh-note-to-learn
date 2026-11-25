import { t } from './i18n.js'
import MarkdownIt from 'markdown-it'
import { TWO_CARD, twoCardMarkdown } from './note-components.js'
import { escapeMarkdown, markdownFromHtml, safeLink as safeUrl, sanitizePaperHtml } from './paper-html.js'
import { isVisible, recordsById } from './note-tree.js'

export { copyPage, movePage } from './note-tree.js'

function tagNames(page) {
  return Array.isArray(page.tags) ? page.tags
    .map(tag => typeof tag === 'string' ? tag : tag?.name ?? tag?.label)
    .filter(tag => typeof tag === 'string' && tag.trim()) : []
}

function sourceLabel(source) {
  if (typeof source === 'string') return source
  if (!source) return ''
  const title = source.title || source.fileName || source.name || source.path || source.url || ''
  const start = source.pageNumber ?? source.page
  if (!start) return title
  const pages = source.endPage && source.endPage !== start ? `${start}–${source.endPage}` : String(start)
  return [title, t('第 {0} 页', pages)].filter(Boolean).join(' · ')
}

function searchKey(text) {
  return String(text ?? '').normalize('NFKC').toLocaleLowerCase()
}

export function searchPages(state, query, { notebookId, sectionId, tag } = {}) {
  const words = searchKey(query).split(/\s+/).filter(Boolean)
  const tagFilter = tag ? searchKey(tag).trim().replace(/^#/, '') : ''
  const pages = recordsById(state.pages)
  const sections = recordsById(state.sections)
  const notebooks = recordsById(state.notebooks)
  const results = []
  for (const page of state.pages) {
    const section = sections.get(page.sectionId)
    const notebook = notebooks.get(section?.notebookId)
    if (!isVisible(page, pages) || !isVisible(section, sections) || !notebook || notebook.deletedAt) continue
    if ((notebookId && notebook.id !== notebookId) || (sectionId && section.id !== sectionId)) continue
    const tags = tagNames(page)
    if (tagFilter && !tags.some(name => searchKey(name).trim().replace(/^#/, '') === tagFilter)) continue

    const parts = [page.text, page.ocrText, page.ocr?.text, page.background?.text, page.background?.ocrText]
    for (const block of page.blocks ?? []) {
      parts.push(block.text, block.markdown, block.ocrText, block.ocr?.text, block.name, sourceLabel(block.source))
      if (block.kind === 'card' && block.card?.type === TWO_CARD) parts.push(twoCardMarkdown(block.card, t))
    }
    const plain = parts.filter(value => typeof value === 'string' && value.trim()).join(' ').replace(/\s+/g, ' ').trim()
    const searchable = searchKey([page.title, ...tags, plain].join(' '))
    if (words.some(word => !searchable.includes(word.replace(/^#/, '')))) continue

    const plainKey = searchKey(plain)
    const positions = words.map(word => plainKey.indexOf(word)).filter(position => position >= 0)
    const start = positions.length ? Math.max(0, Math.min(...positions) - 28) : 0
    const end = start + 145
    const snippet = (start > 0 ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '')
    results.push({ page, section, notebook, snippet })
  }
  return results
}

function label(text) {
  return escapeMarkdown(String(text ?? '').replace(/[\r\n]+/g, ' '))
}

function sourceMarkdown(source) {
  const title = label(sourceLabel(source))
  const url = safeUrl(typeof source === 'string' ? source : source?.url)
  if (!title && !url) return ''
  return t('> 来源 ') + (url ? `[${title || label(url)}](<${url}>)` : title)
}

const mimeExtensions = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
  ['image/avif', 'avif'], ['image/bmp', 'bmp'], ['application/pdf', 'pdf'],
  ['application/zip', 'zip'], ['text/plain', 'txt'], ['audio/mpeg', 'mp3'], ['video/mp4', 'mp4'],
])

function attachmentName(name, mime, index) {
  const base = String(name ?? '').split(/[\\/]/).at(-1).replace(/[^a-z0-9._-]/gi, '_')
    .slice(0, 72).replace(/^[._-]+|[. ]+$/g, '')
  const stem = base || 'file'
  const extension = /\.[a-z0-9]{1,12}$/i.test(stem) ? '' : `.${mimeExtensions.get(mime) ?? 'bin'}`
  return `assets/${index}-${stem}${extension}`
}

function exportText(block, doc) {
  if (block.markdown && safeMarkdownSource(block.markdown)) return block.markdown
  if (doc && block.markdown) return markdownFromHtml(markdownParser.render(block.markdown), doc)
  if (doc && block.html) return markdownFromHtml(block.html, doc)
  if (doc) return markdownFromHtml('', doc, block.text ?? '')
  return escapeMarkdown(block.text).trim()
}

export function exportPageMarkdown(page, { pageImage, document: doc = globalThis.document } = {}) {
  const attachments = []
  const rows = [`# ${label(page.title || t('无标题'))}`]
  const tags = tagNames(page)
  if (tags.length) rows.push(t('标签 {0}', tags.map(label).join('、')))

  function attach(dataUrl, name, image) {
    const mime = typeof dataUrl === 'string' && /^data:([a-z0-9/+.-]+);base64,/i.exec(dataUrl)?.[1]?.toLowerCase()
    if (!mime) return name ? label(name) : ''
    const path = attachmentName(name, mime, attachments.length + 1)
    attachments.push({ path, dataUrl })
    const isImage = image && mime.startsWith('image/') && mimeExtensions.has(mime)
    return `${isImage ? '!' : ''}[${label(name || t('附件'))}](${path})`
  }

  if (pageImage) rows.push(attach(pageImage, 'page-preview.png', true))
  else if (page.background?.dataUrl) rows.push(attach(page.background.dataUrl, t('PDF 页底图'), true))
  if (page.background) rows.push(sourceMarkdown(page.background.source ?? page.background))
  if (page.strokes?.length && !pageImage) rows.push(t('纸面包含手写笔迹，可在 PDF 或可编辑备份中查看。'))

  const blocks = [...(page.blocks ?? [])].sort((left, right) => (left.y ?? 0) - (right.y ?? 0) ||
    (left.x ?? 0) - (right.x ?? 0))
  for (const block of blocks) {
    if (block.kind === 'text') rows.push(exportText(block, doc))
    else if (block.kind === 'card' && block.card?.type === TWO_CARD) rows.push(twoCardMarkdown(block.card, t))
    else if (block.kind === 'file' || block.kind === 'image') {
      rows.push(attach(block.dataUrl, block.name || (block.kind === 'image' ? t('图片') : t('附件')), block.kind === 'image'))
    }
    rows.push(sourceMarkdown(block.source))
  }
  return { markdown: rows.filter(Boolean).join('\n\n') + '\n', attachments }
}

const markdownParser = new MarkdownIt({ html: false, linkify: false })
markdownParser.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]
  const title = markdownParser.utils.escapeHtml(token.content || t('图片'))
  const url = safeUrl(token.attrGet('src'))
  return url ? `<a href="${markdownParser.utils.escapeHtml(url)}">${title}</a>` : title
}
markdownParser.renderer.rules.link_open = (tokens, index) => {
  const href = safeUrl(tokens[index].attrGet('href'))
  return href ? `<a href="${markdownParser.utils.escapeHtml(href)}">` : '<a>'
}
markdownParser.renderer.rules.heading_open = (tokens, index) =>
  Number(tokens[index].tag.slice(1)) < 3 ? '<h2>' : '<h3>'
markdownParser.renderer.rules.heading_close = (tokens, index) =>
  Number(tokens[index].tag.slice(1)) < 3 ? '</h2>\n' : '</h3>\n'

// This parser only inspects the source. It never renders user HTML.
const inspectMarkdown = new MarkdownIt({ html: true, linkify: false })
inspectMarkdown.validateLink = () => true

function safeMarkdownSource(source) {
  function safeToken(token) {
    if (token.type === 'html_block' || token.type === 'html_inline' || token.type === 'image') return false
    if (token.type === 'link_open') {
      const href = token.attrGet('href')
      return Boolean(safeUrl(href) || href?.startsWith('#'))
    }
    return !token.children || token.children.every(safeToken)
  }
  return inspectMarkdown.parse(source, {}).every(safeToken)
}

export function importPageMarkdown(markdown, { id, title, sectionId, parentId = null, document: doc = globalThis.document }) {
  const text = String(markdown ?? '').replace(/^\uFEFF/, '').trim()
  const environment = {}
  const tokens = markdownParser.parse(text, environment)
  const heading = tokens[0]?.type === 'heading_open' && tokens[0].tag === 'h1' ? tokens[0] : null
  const inline = heading ? tokens[1] : null
  if (heading) tokens.splice(0, 3)
  const html = markdownParser.renderer.render(tokens, markdownParser.options, environment)
  const headingText = inline?.children?.map(child => child.content).join('') || inline?.content
  const body = heading ? text.split(/\r?\n/).slice(heading.map[1]).join('\n').trim() : text
  const lines = body.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 64)), 0)
  const height = Math.max(60, Math.min(8000, lines * 24 + 24))
  return {
    id, sectionId, parentId, title: headingText || title || t('导入笔记'),
    width: 820, height: Math.max(1120, height + 76), strokes: [],
    blocks: body ? [{
      id: `${id}-markdown`, kind: 'text', x: 38, y: 38, width: 744, height,
      text: body, markdown: body, html: doc ? sanitizePaperHtml(doc, html) : html,
    }] : [],
  }
}
