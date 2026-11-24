import katex from 'katex'
import { t } from './i18n.js'

const delimiters = [
  ['\\(', '\\)', false], ['\\[', '\\]', true], ['$$', '$$', true], ['$', '$', false],
]
export const PAPER_FORMULA = '[data-nl-math]'

export function readMath(source, start, limit = source.length, multiline = false) {
  const delimiter = delimiters.find(([open]) => source.startsWith(open, start))
  if (!delimiter) return null
  const [open, close, display] = delimiter
  const contentStart = start + open.length
  for (let end = contentStart; end < limit; end += source[end] === '\\' ? 2 : 1) {
    if (source[end] === '\n' && !(display && multiline)) return null
    if (close === '$' && source[end] === '`') return null
    if (!source.startsWith(close, end) || end + close.length > limit) continue
    if (close === '$' && (/\s/.test(source[end - 1]) || /\d/.test(source[end + 1] ?? ''))) return null
    const latex = source.slice(contentStart, end)
    if (!latex.trim() || (!(display && multiline) && latex.includes('\n')) ||
        (open === '$' && latex.trim() !== latex)) return null
    return { start, end: end + close.length, latex, display, open, close }
  }
  return null
}

export function renderMath(latex, display, throwOnError = false) {
  return katex.renderToString(latex, {
    displayMode: display, output: 'mathml', throwOnError, strict: 'ignore', trust: false,
  })
}

function* mathMatches(source) {
  const markers = /`+|[\\$]/g
  for (let marker; (marker = markers.exec(source));) {
    const { index } = marker
    if (source[index] === '`') {
      const fence = marker[0]
      const closing = source.indexOf(fence, markers.lastIndex)
      if (closing >= 0) markers.lastIndex = closing + fence.length
      continue
    }
    const match = readMath(source, index, source.length, true)
    if (match) {
      yield match
      markers.lastIndex = match.end
    } else if (source.startsWith('$$', index) || /^\\[\\$`]/.test(source.slice(index, index + 2))) {
      markers.lastIndex = index + 2
    }
  }
}

export function makePaperFormula(doc, source) {
  const match = readMath(source, 0, source.length, true)
  if (match?.end !== source.length) return null
  let rendered
  try {
    rendered = renderMath(match.latex, match.display, true)
  } catch (error) {
    if (error instanceof katex.ParseError) return null
    throw error
  }
  const node = doc.createElement('span')
  node.className = 'nl-paper-formula'
  node.dataset.nlMath = source
  if (match.display) node.dataset.display = 'block'
  node.contentEditable = 'false'
  node.tabIndex = 0
  node.title = t('编辑公式')
  node.innerHTML = rendered
  return node
}

// Divs and line breaks produced by contenteditable can be part of one
// display formula. Code, links, lists and table cells bound independent runs.
function textRuns(root) {
  const runs = []
  let text = ''
  let parts = []
  function finish() {
    if (parts.length) runs.push({ text, parts })
    text = ''
    parts = []
  }
  function lineBreak() {
    if (text && !text.endsWith('\n')) text += '\n'
  }
  function visit(node) {
    if (node.nodeType === 3) {
      if (node.length) parts.push({ node, start: text.length, end: text.length + node.length })
      text += node.data
      return
    }
    if (node.nodeType !== 1) return
    if (node.matches('pre, code, a, math, [contenteditable="false"], input, textarea')) {
      finish()
      return
    }
    if (node.matches('br')) { text += '\n'; return }
    const boundary = node.matches('blockquote, h2, h3, li, td, th')
    const line = node.matches('div, p')
    if (boundary) finish()
    else if (line) lineBreak()
    for (const child of node.childNodes) visit(child)
    if (boundary) finish()
    else if (line) lineBreak()
  }
  for (const node of root.childNodes) visit(node)
  finish()
  return runs
}

function sourceRange(doc, parts, start, end) {
  const first = parts.find(part => start >= part.start && start < part.end)
  const last = parts.find(part => end > part.start && end <= part.end)
  if (!first || !last) return null
  const range = doc.createRange()
  range.setStart(first.node, start - first.start)
  range.setEnd(last.node, end - last.start)
  return range
}

function moveCaretPastFormula(selection) {
  if (!selection?.isCollapsed) return
  const node = selection.anchorNode
  const formula = (node?.nodeType === 1 ? node : node?.parentElement)?.closest(PAPER_FORMULA)
  if (!formula) return
  placeCaretAfter(formula, selection)
}

export function placeCaretAfter(node, selection) {
  if (!selection) return
  const doc = node.ownerDocument
  const caret = doc.createRange()
  const next = node.nextSibling
  if (node.dataset?.display === 'block' && (!next || (next.nodeType === 3 && !next.data))) {
    const line = doc.createElement('div')
    line.append(doc.createElement('br'))
    node.after(line)
    caret.setStart(line, 0)
  } else caret.setStartAfter(node)
  caret.collapse(true)
  selection.removeAllRanges()
  selection.addRange(caret)
}

export function insertFormulaHtml(editor, selection, trailingSource, insert) {
  const earlier = trailingSource ? new Set(editor.querySelectorAll(PAPER_FORMULA)) : null
  if (!insert()) return false
  const inserted = earlier && Array.from(editor.querySelectorAll(PAPER_FORMULA)).findLast(node =>
    !earlier.has(node) && formulaSource(node) === trailingSource)
  if (inserted) placeCaretAfter(inserted, selection)
  else moveCaretPastFormula(selection)
  return true
}

/** Insert a closing delimiter and its rendered formula in one browser edit. */
export function completeTypedFormula(editor, selection, added, insert) {
  if (!selection?.isCollapsed || selection.anchorNode?.nodeType !== 3 || !/[$)\]]$/.test(added ?? '')) return false
  const current = selection.getRangeAt(0).cloneRange()
  for (const { text, parts } of textRuns(editor)) {
    const part = parts.find(item => item.node === selection.anchorNode)
    if (!part) continue
    const offset = part.start + selection.anchorOffset
    const source = text.slice(0, offset) + added + text.slice(offset)
    const match = Array.from(mathMatches(source)).find(item => item.start < offset && item.end === offset + added.length)
    if (!match) return false
    const doc = editor.ownerDocument
    const formula = makePaperFormula(doc, source.slice(match.start, match.end))
    const replacement = sourceRange(doc, parts, match.start, offset)
    if (!formula || !replacement) return false
    selection.removeAllRanges()
    selection.addRange(replacement)
    if (insertFormulaHtml(editor, selection, formulaSource(formula), () => insert(formula))) return true
    selection.removeAllRanges()
    selection.addRange(current)
    return false
  }
  return false
}

export function renderRichMath(root, selection) {
  const doc = root.ownerDocument
  let rendered = 0
  for (const { text, parts } of textRuns(root)) {
    for (const match of [...mathMatches(text)].reverse()) {
      const formula = makePaperFormula(doc, text.slice(match.start, match.end))
      if (!formula) continue
      const range = sourceRange(doc, parts, match.start, match.end)
      if (!range) continue
      const containsCaret = selection?.isCollapsed && root.contains(selection.anchorNode) &&
        range.comparePoint(selection.anchorNode, selection.anchorOffset) === 0
      range.deleteContents()
      range.insertNode(formula)
      if (containsCaret) placeCaretAfter(formula, selection)
      rendered++
    }
  }
  return rendered
}

export function standalonePaperFormula(doc, text) {
  const source = text.trim()
  // Recognize a whole pasted expression with a TeX command at its start.
  // Delimiters are still the unambiguous choice for formulas mixed with prose.
  if (!/^\\[A-Za-z]+(?=[{[_^]|$)/.test(source)) return null
  const display = source.includes('\n') || source.startsWith('\\begin{')
  return makePaperFormula(doc, display ? '$$\n' + source + '\n$$' : '\\(' + source + '\\)')
}

export function formulaSource(node) {
  const source = node.getAttribute?.('data-nl-math')
  return typeof source === 'string' && source ? source : null
}

/** Read the text and source of the rendered equations without MathML annotations. */
export function paperSourceText(root) {
  let text = ''
  let separate = false
  function append(value) {
    if (!value) return
    if (separate && text && !text.endsWith('\n')) text += '\n'
    separate = false
    text += value
  }
  function visit(node) {
    if (node.nodeType === 3) { append(node.data); return }
    if (node.nodeType !== 1) return
    const source = formulaSource(node)
    if (source !== null) { append(source); return }
    if (node.tagName === 'BR') { separate = false; text += '\n'; return }
    const block = node.matches('blockquote, div, h2, h3, li, p, pre, tr')
    if (block) separate = true
    for (const child of node.childNodes) visit(child)
    if (block) separate = true
  }
  for (const child of root.childNodes) visit(child)
  return text
}
