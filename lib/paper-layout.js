import MarkdownIt from 'markdown-it'
import { t } from './i18n.js'
import { NOTE_FIGURE_FENCE } from './note-components.js'
import { readMath, renderMath } from './paper-math.js'

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content)
function mathRule(display) {
  return (tokens, index, _options, env) => {
    const { content } = tokens[index]
    if (!env.mathSource) return renderMath(content, display)
    const latex = markdown.utils.escapeHtml(content)
    return display ? '<div>$$\n' + latex + '\n$$</div>' : '\\(' + latex + '\\)'
  }
}
markdown.renderer.rules.math_inline = mathRule(false)
markdown.renderer.rules.math_block = mathRule(true)
markdown.inline.ruler.before('escape', 'note_math', (state, silent) => {
  const match = readMath(state.src, state.pos, state.posMax)
  if (!match) return false
  if (!silent) state.push(match.display ? 'math_block' : 'math_inline', '', 0).content = match.latex
  state.pos = match.end
  return true
})
markdown.block.ruler.before('fence', 'note_math_block', (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  let line = startLine
  let text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
  const open = text.startsWith('$$') ? '$$' : text.startsWith('\\[') ? '\\[' : ''
  if (!open) return false
  const close = open === '$$' ? '$$' : '\\]'
  text = text.slice(open.length)
  while (!text.trimEnd().endsWith(close)) {
    line++
    if (line >= endLine) return false
    text += '\n' + state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
  }
  if (silent) return true
  const token = state.push('math_block', '', 0)
  token.block = true
  token.content = text.trimEnd().slice(0, -close.length).trim()
  state.line = line + 1
  return true
}, { alt: ['paragraph', 'reference', 'blockquote'] })

export function hasPaperFigures(source) {
  return source.includes(NOTE_FIGURE_FENCE) && markdown.parse(source, {}).some(token =>
    token.type === 'fence' && token.info.trim().split(/\s+/, 1)[0] === NOTE_FIGURE_FENCE)
}

export function renderPaperMarkdown(source, layout) {
  return markdown.render(source, { noteLayout: layout })
}

const comparisons = /对比|比较|异同|区别|差异|\bcompare\b|\bcomparison\b|\bversus\b/i
const taskLists = /待办|任务清单|行动清单|\bchecklist\b|\bto-?do\b/i
const steps = /步骤|推导|\bsteps\b|\bderivation\b/i
const taskMarker = /^\[([ xX])\][ \t]+/
const shortItem = ['list_item_open', 'paragraph_open', 'inline', 'paragraph_close', 'list_item_close']

function simpleList(tokens, start) {
  const items = []
  let end = start + 1
  while (shortItem.every((type, index) => tokens[end + index]?.type === type)) {
    items.push(tokens[end + 2])
    end += shortItem.length
  }
  return items.length && /_list_close$/.test(tokens[end]?.type) ? { items, end } : null
}

function comparisonRow(item) {
  const match = /^([^:：\n]{1,52})[:：]\s*(\S[\s\S]*)$/.exec(item.content.trim())
  if (!match) return null
  const label = match[1].trim().replace(/^\*\*|\*\*$/g, '')
  const explanation = match[1].startsWith('**') && !match[1].endsWith('**')
    ? match[2].replace(/^\*\*\s*/, '') : match[2]
  return label && explanation ? [label, explanation] : null
}

function addCheckbox(inline, Token, force) {
  const first = inline.children?.[0]
  const marker = first?.type === 'text' ? taskMarker.exec(first.content) : null
  if (!force && !marker) return
  if (marker) first.content = first.content.slice(marker[0].length)
  const token = new Token('note_checkbox', '', 0)
  token.meta = { checked: marker?.[1]?.toLowerCase() === 'x' }
  inline.children.unshift(token)
}

markdown.core.ruler.after('inline', 'note_layout', state => {
  const layout = state.env.noteLayout
  if (!layout) return
  const { tokens, Token } = state
  for (let index = 0; index < tokens.length; index++) {
    const start = tokens[index]
    if (!['bullet_list_open', 'ordered_list_open'].includes(start.type)) continue
    const list = simpleList(tokens, index)
    if (!list || list.items.some(item => taskMarker.test(item.content))) continue
    const context = (tokens[index - 2]?.type === 'inline' ? tokens[index - 2].content : '')
    if (layout === 'checklist' || (layout === 'auto' && taskLists.test(context))) {
      for (const item of list.items) addCheckbox(item, Token, true)
    } else if (layout === 'comparison' || (layout === 'auto' && comparisons.test(context))) {
      const rows = list.items.map(comparisonRow)
      if (rows.length < 2 || rows.some(row => !row) || new Set(rows.map(row => row[0])).size < 2) continue
      const table = new Token('note_comparison', 'table', 0)
      table.block = true
      table.meta = { rows }
      tokens.splice(index, list.end - index + 1, table)
    } else if (start.tag === 'ul' && (layout === 'steps' || (layout === 'auto' && steps.test(context)))) {
      start.tag = tokens[list.end].tag = 'ol'
      start.type = 'ordered_list_open'
      tokens[list.end].type = 'ordered_list_close'
    }
  }
  for (let index = 0; index < tokens.length - 2; index++) {
    if (tokens[index].type === 'list_item_open' && tokens[index + 1].type === 'paragraph_open' &&
        tokens[index + 2].type === 'inline') {
      addCheckbox(tokens[index + 2], Token, false)
    }
  }
})

markdown.renderer.rules.note_checkbox = (tokens, index) =>
  '<input type="checkbox"' + (tokens[index].meta.checked ? ' checked' : '') + '> '
markdown.renderer.rules.note_comparison = (tokens, index, _options, env) => {
  const headings = [t('项目'), t('说明')].map(value => '<th>' + markdown.utils.escapeHtml(value) + '</th>').join('')
  const rows = tokens[index].meta.rows.map(([label, explanation]) =>
    '<tr><td>' + markdown.renderInline(label, env) + '</td><td>' + markdown.renderInline(explanation, env) + '</td></tr>')
  return '<table><thead><tr>' + headings + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>\n'
}

export function renderPaperLayout(source, layout) {
  return markdown.render(source, { noteLayout: layout, mathSource: true })
}
