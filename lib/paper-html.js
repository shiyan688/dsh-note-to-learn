import { t } from './i18n.js'
import { NOTE_FIGURE_FENCE } from './note-components.js'
import { formulaSource, renderRichMath } from './paper-math.js'

const figureLanguage = 'language-' + NOTE_FIGURE_FENCE
const ALLOWED_ELEMENTS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H2', 'H3',
  'I', 'INPUT', 'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB',
  'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL',
])
const DISCARDED_ELEMENTS = new Set([
  'EMBED', 'IFRAME', 'LINK', 'MATH', 'META', 'NOSCRIPT', 'OBJECT', 'SCRIPT',
  'STYLE', 'SVG', 'TEMPLATE',
])

export function safeLink(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

export function sanitizePaperHtml(doc, html) {
  const source = doc.createElement('template')
  source.innerHTML = String(html ?? '')
  const clean = doc.createElement('div')
  function append(node, target) {
    if (node.nodeType === 3) {
      target.append(doc.createTextNode(node.textContent ?? ''))
      return
    }
    if (node.nodeType !== 1) return
    const original = node.tagName.toUpperCase()
    const tag = original === 'H1' ? 'H2' : /^H[4-6]$/.test(original) ? 'H3' : original
    if (DISCARDED_ELEMENTS.has(tag)) return
    const source = tag === 'SPAN' ? formulaSource(node) : null
    if (source !== null) {
      target.append(doc.createTextNode(source))
      return
    }
    if (!ALLOWED_ELEMENTS.has(tag)) {
      for (const child of node.childNodes) append(child, target)
      return
    }
    if (tag === 'INPUT' && node.type !== 'checkbox') return
    const safeNode = doc.createElement(tag)
    if (tag === 'A') {
      const href = safeLink(node.getAttribute('href'))
      if (href) {
        safeNode.href = href
        safeNode.rel = 'noopener noreferrer'
        safeNode.target = '_blank'
      }
    }
    if (tag === 'INPUT') {
      safeNode.type = 'checkbox'
      safeNode.defaultChecked = node.checked
      safeNode.setAttribute('contenteditable', 'false')
      safeNode.setAttribute('aria-label', t('待办状态'))
    }
    if (tag === 'OL' && node.hasAttribute('start')) safeNode.start = node.start
    if (tag === 'CODE' && node.parentElement?.tagName === 'PRE' && node.classList.contains(figureLanguage)) {
      safeNode.className = figureLanguage
    }
    for (const child of node.childNodes) append(child, safeNode)
    target.append(safeNode)
  }
  for (const child of source.content.childNodes) append(child, clean)
  return clean.innerHTML
}

export function escapeMarkdown(text) {
  return String(text ?? '').replace(/[\\`*_[\]<>|~!]/g, '\\$&')
}

function codeFence(code, length) {
  for (const match of code.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  return '`'.repeat(length)
}

export function markdownFromHtml(html, doc, plainText) {
  const fragment = doc.createElement('template')
  if (plainText === undefined) fragment.innerHTML = sanitizePaperHtml(doc, html)
  else fragment.content.append(doc.createTextNode(plainText))
  renderRichMath(fragment.content)
  function children(node) {
    return Array.from(node.childNodes, render).join('')
  }
  function render(node) {
    if (node.nodeType === 3) return escapeMarkdown(node.textContent)
    const formula = formulaSource(node)
    if (formula !== null) return node.dataset.display === 'block' ? '\n\n' + formula + '\n\n' : formula
    switch (node.tagName) {
      case 'A': {
        const url = safeLink(node.getAttribute('href'))
        const text = children(node)
        return url ? `[${text || label(url)}](<${url}>)` : text
      }
      case 'BR': return '  \n'
      case 'H2': return `\n\n## ${children(node).trim()}\n\n`
      case 'H3': return `\n\n### ${children(node).trim()}\n\n`
      case 'P':
      case 'DIV': return `\n\n${children(node).trim()}\n\n`
      case 'B':
      case 'STRONG': return `**${children(node)}**`
      case 'I':
      case 'EM': return `*${children(node)}*`
      case 'DEL':
      case 'S': return `~~${children(node)}~~`
      case 'INPUT': return node.checked ? '[x] ' : '[ ] '
      case 'BLOCKQUOTE': return `\n\n${children(node).trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`
      case 'PRE': {
        const code = node.textContent.replace(/\n$/, '')
        const fence = codeFence(code, 3)
        const language = node.firstElementChild?.classList.contains(figureLanguage) ? NOTE_FIGURE_FENCE : ''
        return `\n\n${fence}${language}\n${code}\n${fence}\n\n`
      }
      case 'CODE': {
        const code = node.textContent
        const fence = codeFence(code, 1)
        const padding = code.startsWith('`') || code.endsWith('`') ? ' ' : ''
        return fence + padding + code + padding + fence
      }
      case 'UL':
      case 'OL': {
        const lines = Array.from(node.children).filter(item => item.tagName === 'LI').map((item, index) => {
          const marker = node.tagName === 'OL' ? String(node.start + index) + '. ' : '- '
          const [first, ...rest] = children(item).trim().split('\n')
          return marker + first + rest.map(line => `\n${' '.repeat(marker.length)}${line}`).join('')
        })
        return `\n\n${lines.join('\n')}\n\n`
      }
      case 'TABLE': {
        const rows = Array.from(node.querySelectorAll('tr'), row => Array.from(row.cells, cell =>
          children(cell).trim().replace(/\r?\n+/g, ' ')))
        if (!rows.length || !rows[0].length) return ''
        const [heading, ...values] = rows
        const rowLine = row => `| ${row.join(' | ')} |`
        return `\n\n${[heading, heading.map(() => '---'), ...values].map(rowLine).join('\n')}\n\n`
      }
      default: return children(node)
    }
  }
  return children(fragment.content).trim()
}
