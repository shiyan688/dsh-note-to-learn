import { t } from './i18n.js'
import { NOTE_LAYOUTS, TWO_CARD, twoCard, twoCardMarkdown } from './note-components.js'
import { renderTwoCard } from './paper-card.js'
import { renderPaperLayout, renderPaperMarkdown } from './paper-layout.js'
import { markdownFromHtml, safeLink, sanitizePaperHtml } from './paper-html.js'
import {
  PAPER_FORMULA, completeTypedFormula, formulaSource, insertFormulaHtml, makePaperFormula,
  paperSourceText, placeCaretAfter, readMath, renderRichMath, standalonePaperFormula,
} from './paper-math.js'

const PAGE_WIDTH = 820
const PAGE_HEIGHT = 1120
const MAX_SIDE = 8192
const MAX_UNDO = 30
const IMAGE_DATA = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i
const TOOLS = [
  ['select', '选择'], ['text', '文字'], ['pen', '画笔'], ['highlight', '荧光笔'],
  ['eraser', '橡皮'], ['lasso', '套索'],
]
const SHAPES = [['line', '直线'], ['rectangle', '矩形'], ['ellipse', '椭圆']]

export { renderPaperMarkdown } from './paper-layout.js'

function element(doc, name, className, label) {
  const node = doc.createElement(name)
  if (className) node.className = className
  if (label !== undefined) node.textContent = label
  return node
}

function identifier() {
  return globalThis.crypto?.randomUUID?.() ?? `paper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function clamp(number, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, number))
}

function normalizedPage(page) {
  return {
    ...page,
    width: clamp(finite(page.width, PAGE_WIDTH), 320, MAX_SIDE),
    height: clamp(finite(page.height, PAGE_HEIGHT), 280, MAX_SIDE),
    blocks: Array.isArray(page.blocks) ? page.blocks : [],
    strokes: Array.isArray(page.strokes) ? page.strokes : [],
  }
}

export function lassoContains(point, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if ((a.y > point.y) !== (b.y > point.y) &&
      point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function selectionBounds(points, width, height) {
  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  const x = clamp(Math.floor(minX), 0, width)
  const y = clamp(Math.floor(minY), 0, height)
  return {
    x, y,
    width: Math.max(0, Math.min(width, Math.ceil(maxX)) - x),
    height: Math.max(0, Math.min(height, Math.ceil(maxY)) - y),
  }
}

function polyline(ctx, points) {
  if (!points.length) return
  ctx.moveTo(points[0].x, points[0].y)
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y)
}

function pathForStroke(ctx, stroke) {
  const { type, points } = stroke
  const first = points[0]
  const last = points.at(-1)
  ctx.beginPath()
  if (type === 'rectangle') {
    ctx.rect(first.x, first.y, last.x - first.x, last.y - first.y)
  } else if (type === 'ellipse') {
    ctx.ellipse((first.x + last.x) / 2, (first.y + last.y) / 2, Math.abs(last.x - first.x) / 2,
      Math.abs(last.y - first.y) / 2, 0, 0, Math.PI * 2)
  } else if (type === 'line') {
    ctx.moveTo(first.x, first.y)
    ctx.lineTo(last.x, last.y)
  } else {
    polyline(ctx, points)
  }
}

function pressureSize(size, point) {
  return size * (0.3 + clamp(finite(point.pressure, 0.6), 0, 1) * 0.9)
}

function renderStroke(ctx, stroke) {
  const { points, type } = stroke
  if (!Array.isArray(points) || !points.length) return
  const size = clamp(finite(stroke.size, 3), 0.5, 60)
  ctx.save()
  ctx.strokeStyle = stroke.color || '#264260'
  ctx.fillStyle = ctx.strokeStyle
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (type === 'highlight') ctx.globalAlpha = 0.32
  if (points.length === 1) {
    ctx.beginPath()
    ctx.arc(points[0].x, points[0].y, pressureSize(size, points[0]) / 2, 0, Math.PI * 2)
    ctx.fill()
  } else if (type === 'pen') {
    let previous = points[0]
    for (const point of points.slice(1)) {
      ctx.beginPath()
      ctx.lineWidth = pressureSize(size, {
        pressure: (finite(previous.pressure, 0.6) + finite(point.pressure, 0.6)) / 2,
      })
      ctx.moveTo(previous.x, previous.y)
      ctx.lineTo(point.x, point.y)
      ctx.stroke()
      previous = point
    }
  } else {
    ctx.lineWidth = size
    pathForStroke(ctx, stroke)
    ctx.stroke()
  }
  ctx.restore()
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const squared = dx * dx + dy * dy
  const t = squared ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / squared, 0, 1) : 0
  return Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t)
}

function erasePaths(strokes, point, radius, ctx) {
  return strokes.filter(stroke => {
    const points = stroke.points
    if (!Array.isArray(points) || !points.length) return true
    const distance = radius + finite(stroke.size, 3) / 2
    if (points.length === 1) return distanceToSegment(point, points[0], points[0]) > distance
    if (['rectangle', 'ellipse'].includes(stroke.type)) {
      ctx.save()
      ctx.resetTransform()
      ctx.lineWidth = distance * 2
      pathForStroke(ctx, stroke)
      const hit = ctx.isPointInStroke(point.x, point.y)
      ctx.restore()
      return !hit
    }
    return !points.slice(1).some((end, i) => distanceToSegment(point, points[i], end) <= distance)
  })
}

function readData(file, win) {
  return new Promise((resolve, reject) => {
    const reader = new win.FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error(t('无法读取文件')))
    reader.readAsDataURL(file)
  })
}

function imageBlob(dataUrl, win) {
  const header = IMAGE_DATA.exec(dataUrl)?.[0]
  if (!header) throw new Error(t('无法读取图片附件'))
  const mime = header.slice(5, header.indexOf(';'))
  const decoded = win.atob(dataUrl.slice(header.length))
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0))
  return new win.Blob([bytes], { type: mime })
}

function loadedImage(win, source) {
  return new Promise((resolve, reject) => {
    const image = new win.Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(t('无法打开图片')))
    image.src = source
  })
}

function sourceLabel(source) {
  if (typeof source === 'string') return source
  if (!source) return ''
  const title = source.title || source.name || source.fileName || source.path || source.url || (source.pageId ? t('笔记页面') : '')
  const page = source.pageNumber ?? source.page
  return page === undefined ? title : `${title} · ${t('第 {0} 页', page)}`
}

function lineRect(rect, origin, scale) {
  return {
    x: (rect.left - origin.left) / scale,
    y: (rect.top - origin.top) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  }
}

function canvasPng(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error(t('无法生成纸面图片'))), 'image/png',
  ))
}

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function segmentsCross(a, b, c, d) {
  const side = (p, start, end) => (p.y - start.y) * (end.x - start.x) - (p.x - start.x) * (end.y - start.y)
  return side(a, c, d) * side(b, c, d) < 0 && side(c, a, b) * side(d, a, b) < 0
}

function pathTouchesPolygon(points, polygon) {
  if (points.some(point => lassoContains(point, polygon))) return true
  return points.slice(1).some((end, index) => polygon.some((p, i) =>
    segmentsCross(points[index], end, p, polygon[(i + 1) % polygon.length])))
}

function outline(stroke) {
  const first = stroke.points[0]
  const last = stroke.points.at(-1)
  if (stroke.type === 'rectangle') {
    return [first, { x: last.x, y: first.y }, last, { x: first.x, y: last.y }, first]
  }
  if (stroke.type === 'ellipse' && stroke.points.length > 1) {
    return Array.from({ length: 41 }, (_, index) => {
      const angle = index / 40 * Math.PI * 2
      return {
        x: (first.x + last.x) / 2 + Math.cos(angle) * Math.abs(last.x - first.x) / 2,
        y: (first.y + last.y) / 2 + Math.sin(angle) * Math.abs(last.y - first.y) / 2,
      }
    })
  }
  return stroke.points
}

function colorFor(text, fallback) {
  return /^#[\da-f]{6}$/i.test(text ?? '') ? text : fallback
}

/**
 * Mount the editable paper for one note page. Documents own their data and may
 * be persisted by the caller after each committed change.
 */
export function mountPaper(root, { page: initialPage, controlsRoot, onChange = () => {}, onAsk, onError, onSource } = {}) {
  const doc = root.ownerDocument
  const win = doc.defaultView
  const controller = new win.AbortController()
  const listener = { signal: controller.signal }
  let page = normalizedPage(initialPage ?? { id: identifier(), title: '' })
  let mode = 'select'
  let showFormat = false
  let currentId = null
  let polygon = []
  let zoom = null
  let scale = 1
  let toolStroke = null
  let gesture = null
  let background = null
  let backgroundSource
  let backgroundPending = Promise.resolve(null)
  let nextInsertion
  let focusedEditor = null
  let editId = null
  let destroyed = false
  const undoStack = []
  const redoStack = []
  const blockNodes = new Map()
  const layoutBaseline = new WeakMap()

  const container = element(doc, 'section', 'nl-paper')
  container.setAttribute('aria-label', t('笔记纸面'))
  const toolbar = element(doc, 'div', 'nl-paper-toolbar')
  toolbar.setAttribute('role', 'group')
  toolbar.setAttribute('aria-label', t('笔记纸面工具'))
  const formatBar = element(doc, 'div', 'nl-paper-format')
  formatBar.id = `nl-format-${identifier()}`
  formatBar.setAttribute('role', 'group')
  formatBar.setAttribute('aria-label', t('文字格式'))
  const viewport = element(doc, 'div', 'nl-paper-viewport')
  const sheetFrame = element(doc, 'div', 'nl-paper-sheet-frame')
  const sheet = element(doc, 'div', 'nl-paper-sheet')
  const paperBackground = element(doc, 'img', 'nl-paper-background')
  paperBackground.alt = ''
  paperBackground.draggable = false
  paperBackground.hidden = true
  const ink = element(doc, 'canvas', 'nl-paper-ink')
  const objects = element(doc, 'div', 'nl-paper-objects')
  const selectionInk = element(doc, 'canvas', 'nl-paper-selection')
  const fileInput = element(doc, 'input')
  fileInput.type = 'file'
  fileInput.multiple = true
  fileInput.hidden = true
  const live = element(doc, 'p', 'nl-paper-live')
  live.setAttribute('aria-live', 'polite')
  live.setAttribute('role', 'status')
  const color = element(doc, 'input', 'nl-paper-color')
  color.type = 'color'
  color.value = '#264a75'
  color.setAttribute('aria-label', t('笔颜色'))
  let penColor = color.value
  let highlighterColor = '#f4cd55'
  const size = element(doc, 'input', 'nl-paper-size')
  size.type = 'range'
  size.min = '1'
  size.max = '18'
  size.value = '3'
  size.setAttribute('aria-label', t('笔粗细'))
  let penSize = 3
  let highlighterSize = 14
  let eraserSize = 12

  function notify(message) {
    live.textContent = message
  }

  function report(error) {
    const message = error instanceof Error ? error.message : String(error)
    notify(message)
    onError?.(error)
  }

  function button(group, label, action, title = label, preserveFocus = false) {
    const control = element(doc, 'button', 'nl-paper-button', label)
    control.type = 'button'
    control.title = title
    if (preserveFocus) control.addEventListener('mousedown', event => event.preventDefault(), listener)
    control.addEventListener('click', () => {
      try {
        Promise.resolve(action()).catch(report)
      } catch (error) {
        report(error)
      }
    }, listener)
    group.append(control)
    return control
  }

  const tools = element(doc, 'div', 'nl-paper-tools')
  const toolButtons = new Map(TOOLS.map(([key, label]) =>
    [key, button(tools, t(label), () => selectTool(key))]))
  const shapes = element(doc, 'details', 'ntl-menu nl-paper-shapes')
  shapes.dataset.ntlMenu = ''
  const shapesSummary = element(doc, 'summary', '', t('形状'))
  const shapeItems = element(doc, 'div', 'ntl-menu-items')
  for (const [key, label] of SHAPES) {
    toolButtons.set(key, button(shapeItems, t(label), () => {
      selectTool(key)
      shapes.open = false
      shapesSummary.focus({ preventScroll: true })
    }))
  }
  shapes.append(shapesSummary, shapeItems)
  tools.append(shapes)

  const editActions = element(doc, 'div', 'nl-paper-actions')
  const formatToggle = button(editActions, t('格式'), () => {
    showFormat = !showFormat
    updateControls()
  }, t('文字格式'), true)
  formatToggle.setAttribute('aria-controls', formatBar.id)
  const attach = button(editActions, t('附件'), () => fileInput.click(), t('插入图片或文件附件'))
  attach.setAttribute('aria-label', t('插入图片或文件附件'))
  const undoButton = button(editActions, '↶', undo, t('撤销 (Ctrl+Z)'))
  const redoButton = button(editActions, '↷', redo, t('重做 (Ctrl+Y)'))
  undoButton.classList.add('nl-paper-history')
  redoButton.classList.add('nl-paper-history')
  undoButton.setAttribute('aria-label', t('撤销'))
  redoButton.setAttribute('aria-label', t('重做'))
  const removeButton = button(editActions, '', removeSelected, t('删除选中的对象或笔迹'))
  removeButton.classList.add('nl-paper-delete')
  removeButton.setAttribute('aria-label', t('删除选中'))
  const askButton = onAsk
    ? button(editActions, t('选区问 AI'), askSelection, t('把选区加入当前 DSH 对话草稿'), true)
    : null
  askButton?.classList.add('nl-paper-ask')
  const penSettings = element(doc, 'div', 'nl-paper-pen')
  penSettings.append(color, size)

  const zoomGroup = element(doc, 'div', 'nl-paper-zoom')
  zoomGroup.setAttribute('role', 'group')
  zoomGroup.setAttribute('aria-label', t('纸面缩放'))
  const zoomOut = button(zoomGroup, '−', () => setZoom(scale / 1.18), t('缩小纸面'))
  const zoomDisplay = button(zoomGroup, t('适宽'), () => setZoom(null), t('适合侧栏宽度'))
  const zoomIn = button(zoomGroup, '+', () => setZoom(scale * 1.18), t('放大纸面'))
  zoomOut.setAttribute('aria-label', t('缩小纸面'))
  zoomIn.setAttribute('aria-label', t('放大纸面'))
  button(zoomGroup, t('加长纸面'), extendPage, t('在自由画布下方增加空间'))
  controlsRoot?.append(zoomGroup)
  toolbar.append(tools, editActions)
  const formatting = [
    [t('粗体'), 'bold'], [t('斜体'), 'italic'], [t('下划线'), 'underline'],
    [t('标题'), 'formatBlock', 'h2'], [t('列表'), 'insertUnorderedList'],
    [t('编号'), 'insertOrderedList'],
  ]
  for (const [label, command, value] of formatting) {
    button(formatBar, label, () => format(command, value), label, true)
  }
  button(formatBar, t('待办'), () => format('insertHTML', `<div><input type="checkbox" contenteditable="false" aria-label="${t('待办状态')}"> ${t('待办事项')}</div>`), t('插入可勾选待办'), true)
  button(formatBar, t('表格'), () => format('insertHTML', `<table><tbody><tr><th>${t('标题')}</th><th>${t('标题')}</th></tr><tr><td>${t('内容')}</td><td>${t('内容')}</td></tr></tbody></table><div><br></div>`), t('插入两列表格'), true)
  button(formatBar, t('链接'), openLink, t('将当前文字设为链接'), true)
  button(formatBar, 'Markdown', addMarkdown, t('插入 Markdown 与 LaTeX 公式'))
  const linkBox = element(doc, 'form', 'nl-paper-link-form')
  linkBox.hidden = true
  const linkInput = element(doc, 'input')
  linkInput.type = 'text'
  linkInput.placeholder = 'https://'
  linkInput.setAttribute('aria-label', t('链接地址'))
  const saveLink = element(doc, 'button', 'nl-paper-button', t('插入链接'))
  saveLink.type = 'submit'
  linkBox.append(linkInput, saveLink)
  button(linkBox, t('取消'), () => {
    linkBox.hidden = true
    focusedEditor?.focus()
  })
  let linkSelection = null
  linkBox.addEventListener('submit', event => {
    event.preventDefault()
    const href = safeLink(linkInput.value.trim())
    if (!href) return notify(t('请输入 HTTP、HTTPS 或邮箱地址链接'))
    linkBox.hidden = true
    focusedEditor?.focus()
    const userSelection = win.getSelection()
    if (linkSelection && focusedEditor?.contains(linkSelection.commonAncestorContainer)) {
      userSelection?.removeAllRanges()
      userSelection?.addRange(linkSelection)
    }
    if (userSelection?.isCollapsed) {
      const anchor = element(doc, 'a', '', href)
      anchor.href = href
      format('insertHTML', anchor.outerHTML)
    } else {
      format('createLink', href)
    }
  }, listener)

  sheet.append(paperBackground, objects, ink, selectionInk)
  sheetFrame.append(sheet)
  viewport.append(sheetFrame)
  container.append(toolbar, penSettings, formatBar, linkBox, viewport, live, fileInput)
  root.replaceChildren(container)

  function selectTool(tool) {
    if (gesture) cancelGesture()
    flushEdits()
    focusedEditor?.blur()
    if (mode !== tool) showFormat = tool === 'text'
    mode = tool
    if (mode !== 'select' && mode !== 'lasso') {
      polygon = []
      currentId = null
    }
    if (mode !== 'select' && mode !== 'text') {
      linkBox.hidden = true
      for (const editor of objects.querySelectorAll('.nl-paper-markdown-source:not([hidden])')) {
        editor.previousElementSibling.click()
      }
    }
    updateControls()
    drawInk()
  }

  function updateControls() {
    for (const [key, control] of toolButtons) control.setAttribute('aria-pressed', String(mode === key))
    const isShape = SHAPES.some(([key]) => mode === key)
    shapesSummary.dataset.active = String(isShape)
    sheet.dataset.tool = mode
    objects.inert = mode !== 'select' && mode !== 'text'
    formatToggle.hidden = objects.inert
    formatBar.hidden = objects.inert || !showFormat
    formatToggle.setAttribute('aria-expanded', String(!formatBar.hidden))
    penSettings.hidden = !isShape && !['pen', 'highlight', 'eraser'].includes(mode)
    color.value = mode === 'highlight' ? highlighterColor : penColor
    size.value = String(mode === 'highlight' ? highlighterSize : mode === 'eraser' ? eraserSize : penSize)
    color.disabled = mode === 'eraser'
    undoButton.disabled = !undoStack.length
    redoButton.disabled = !redoStack.length
    removeButton.disabled = !currentId && polygon.length < 3
    if (askButton) askButton.disabled = !currentId && polygon.length < 3 && !selectedText()
    for (const [id, node] of blockNodes) node.classList.toggle('is-selected', id === currentId)
  }

  function setZoom(value) {
    zoom = value === null ? null : clamp(value, Math.min(0.1, scale), 2.5)
    resize()
  }

  function resize() {
    if (destroyed) return
    const { paddingLeft, paddingRight } = win.getComputedStyle(viewport)
    const available = viewport.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight)
    scale = zoom ?? (available > 0 ? Math.min(available / page.width, 1) : 1)
    sheet.style.width = `${page.width}px`
    sheet.style.height = `${page.height}px`
    sheet.style.transform = `scale(${scale})`
    sheetFrame.style.width = `${page.width * scale}px`
    sheetFrame.style.height = `${page.height * scale}px`
    zoomDisplay.textContent = zoom === null ? t('适宽') : `${Math.round(scale * 100)}%`
    const ratio = Math.min(2, Math.max(1, (win.devicePixelRatio || 1) * scale),
      MAX_SIDE / Math.max(page.width, page.height), Math.sqrt(8_000_000 / (page.width * page.height)))
    const width = Math.ceil(page.width * ratio)
    const height = Math.ceil(page.height * ratio)
    for (const canvas of [ink, selectionInk]) {
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
    }
    drawInk()
  }

  function drawInk() {
    const ctx = ink.getContext('2d')
    const selectionCtx = selectionInk.getContext('2d')
    if (!ctx || !selectionCtx) return
    for (const [canvas, context] of [[ink, ctx], [selectionInk, selectionCtx]]) {
      context.setTransform(canvas.width / page.width, 0, 0, canvas.height / page.height, 0, 0)
      context.clearRect(0, 0, page.width, page.height)
    }
    for (const stroke of page.strokes) renderStroke(ctx, stroke)
    if (toolStroke) renderStroke(ctx, toolStroke)
    if (polygon.length > 1) {
      selectionCtx.beginPath()
      polyline(selectionCtx, polygon)
      if (gesture?.tool !== 'lasso') {
        selectionCtx.closePath()
        selectionCtx.fillStyle = 'rgba(36,99,186,.10)'
        selectionCtx.fill()
      }
      selectionCtx.strokeStyle = '#2263b9'
      selectionCtx.lineWidth = 2 / scale
      selectionCtx.setLineDash([5 / scale, 4 / scale])
      selectionCtx.stroke()
      selectionCtx.setLineDash([])
    }
  }

  function refreshBackground() {
    const next = page.background?.dataUrl
    if (next === backgroundSource) return
    backgroundSource = next
    background = null
    paperBackground.hidden = !IMAGE_DATA.test(next ?? '')
    if (paperBackground.hidden) {
      paperBackground.removeAttribute('src')
      backgroundPending = Promise.resolve(null)
      return
    }
    paperBackground.src = next
    backgroundPending = loadedImage(win, next).then(image => {
      if (backgroundSource === next) background = image
      return image
    }, () => {
      if (backgroundSource === next) notify(t('PDF 底图无法显示'))
      return null
    })
  }

  function blockGeometry(block) {
    const node = blockNodes.get(block.id)
    return {
      x: block.x, y: block.y, width: block.width,
      height: Math.max(block.height, node?.offsetHeight ?? 0),
    }
  }

  function position(node, block) {
    node.style.left = `${block.x}px`
    node.style.top = `${block.y}px`
    node.style.width = `${block.width}px`
    node.style.minHeight = `${block.height}px`
  }

  function renderBlocks() {
    focusedEditor = null
    editId = null
    blockNodes.clear()
    const fragment = doc.createDocumentFragment()
    for (const block of page.blocks) {
      const item = element(doc, 'article', 'nl-paper-block')
      item.dataset.kind = block.kind
      item.dataset.id = block.id
      const structured = NOTE_LAYOUTS.includes(block.layout)
      if (block.kind !== 'text' || (!structured && typeof block.markdown === 'string')) item.tabIndex = 0
      position(item, block)
      const move = element(doc, 'button', 'nl-paper-move', '⠿')
      move.type = 'button'
      move.setAttribute('aria-label', t('移动对象（用方向键微调）'))
      move.dataset.move = ''
      move.addEventListener('keydown', event => nudge(event, block.id), listener)
      item.append(move)
      if (block.kind === 'text' && !structured && typeof block.markdown === 'string') {
        renderMarkdownBlock(item, block)
      } else if (block.kind === 'text') {
        renderTextBlock(item, block)
      } else if (block.kind === 'card' && block.card?.type === TWO_CARD) {
        item.append(renderTwoCard(doc, block.card, {
          listener,
          onChange(card, typing) {
            if (destroyed) return
            const old = page.blocks.find(candidate => candidate.id === block.id)
            if (!old) return
            const checkpoint = !typing || editId !== old.id
            editId = typing ? old.id : null
            const updated = { ...old, card, text: twoCardMarkdown(card) }
            changeBlocks(page.blocks.map(candidate => candidate === old ? updated : candidate), { repaint: false, checkpoint })
          },
          onFinish() { if (editId === block.id) editId = null },
          onAsk: onAsk && (card => Promise.resolve(onAsk([cardMaterial(card)])).catch(report)),
        }))
        item.addEventListener('focusin', () => {
          if (currentId !== block.id) selectBlock(block.id)
        }, listener)
      } else if (block.kind === 'image' && IMAGE_DATA.test(block.dataUrl ?? '')) {
        const image = element(doc, 'img', 'nl-paper-object-image')
        image.src = block.dataUrl
        image.alt = block.name || t('图片')
        image.draggable = false
        image.style.height = `${block.height}px`
        item.append(image)
      } else if (block.kind === 'file') {
        const download = element(doc, 'button', 'nl-paper-file', block.name || t('文件附件'))
        download.type = 'button'
        download.addEventListener('click', () => downloadFile(block), listener)
        item.append(download)
      }
      const source = sourceLabel(block.source)
      if (source) {
        const link = safeLink(typeof block.source === 'string' ? block.source : block.source?.url)
        const sourceAction = onSource && typeof block.source === 'object' &&
          [block.source.pageId, block.source.path, block.source.url].some(value => typeof value === 'string' && value)
        const reference = element(doc, sourceAction ? 'button' : link ? 'a' : 'span', 'nl-paper-reference', source)
        if (sourceAction) {
          reference.type = 'button'
          reference.setAttribute('aria-label', t('打开来源 ') + source)
          reference.addEventListener('click', async () => {
            try {
              if (await onSource(block.source) === false && link) win.open(link, '_blank', 'noopener,noreferrer')
            } catch (error) {
              report(error)
            }
          }, listener)
        } else if (link) {
          reference.href = link
          reference.rel = 'noopener noreferrer'
          reference.target = '_blank'
        }
        item.append(reference)
      }
      if (typeof block.originalText === 'string' && block.originalText.trim()) {
        const original = element(doc, 'details', 'nl-note-original')
        original.append(element(doc, 'summary', '', t('摘录原文')), element(doc, 'p', '', block.originalText))
        original.addEventListener('toggle', () => {
          if (original.open && fitContent()) { resize(); onChange(page) }
        }, listener)
        item.append(original)
      }
      const resizer = element(doc, 'button', 'nl-paper-resize')
      resizer.type = 'button'
      resizer.title = t('拖动调整大小')
      resizer.setAttribute('aria-label', t('调整对象大小'))
      resizer.dataset.resize = ''
      item.append(resizer)
      fragment.append(item)
      blockNodes.set(block.id, item)
    }
    objects.replaceChildren(fragment)
  }

  function render() {
    refreshBackground()
    renderBlocks()
    fitContent()
    resize()
    updateControls()
  }

  function fitContent() {
    if (page.background) return false
    const needed = page.blocks.reduce((height, block) => {
      const bottom = block.y + blockGeometry(block).height + 36
      return Math.max(height, bottom)
    }, page.height)
    const height = Math.min(MAX_SIDE, Math.ceil(needed))
    if (height === page.height) return false
    page = { ...page, height }
    return true
  }

  function renderTextBlock(item, block) {
    const edit = element(doc, 'div', 'nl-paper-edit')
    edit.contentEditable = 'true'
    edit.setAttribute('role', 'textbox')
    edit.setAttribute('aria-multiline', 'true')
    edit.setAttribute('aria-label', t('编辑笔记文字'))
    edit.dataset.editor = block.id
    const structured = NOTE_LAYOUTS.includes(block.layout)
    if (block.html || (structured && typeof block.html === 'string')) edit.innerHTML = sanitizePaperHtml(doc, block.html)
    else if (structured) edit.innerHTML = sanitizePaperHtml(doc, renderPaperLayout(block.markdown ?? block.text ?? '', block.layout))
    else edit.textContent = block.text || ''
    renderRichMath(edit)
    if (structured) layoutBaseline.set(edit, sanitizePaperHtml(doc, edit.innerHTML))
    edit.addEventListener('focus', () => {
      focusedEditor = edit
      selectBlock(block.id)
    }, listener)
    edit.addEventListener('beforeinput', event => {
      if (event.target !== edit || event.inputType !== 'insertText' || !event.cancelable || event.isComposing) return
      if (completeTypedFormula(edit, win.getSelection(), event.data, node =>
        doc.execCommand('insertHTML', false, node.outerHTML))) {
        event.preventDefault()
        saveEditor(edit)
      }
    }, listener)
    edit.addEventListener('input', event => {
      if (event.target !== edit || event.isComposing) return
      if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') renderRichMath(edit, win.getSelection())
      saveEditor(edit)
    }, listener)
    edit.addEventListener('compositionend', event => {
      if (event.target !== edit) return
      renderRichMath(edit, win.getSelection())
      saveEditor(edit)
    }, listener)
    edit.addEventListener('blur', () => {
      saveEditor(edit)
      editId = null
    }, listener)
    edit.addEventListener('paste', paste, listener)
    edit.addEventListener('copy', copyFormula, listener)
    edit.addEventListener('cut', copyFormula, listener)
    edit.addEventListener('change', event => {
      if (event.target.matches('input[type="checkbox"]')) {
        event.target.defaultChecked = event.target.checked
        saveEditor(edit)
        editId = null
      }
    }, listener)
    edit.addEventListener('click', event => {
      const formula = event.target.closest?.(PAPER_FORMULA)
      if (formula && win.getSelection()?.isCollapsed && formula.querySelector('math')) {
        editFormula(edit, formula)
        return
      }
      const anchor = event.target.closest?.('a')
      if (!anchor || !anchor.href || !event.ctrlKey) return
      event.preventDefault()
      const href = safeLink(anchor.href)
      if (href) win.open(href, '_blank', 'noopener,noreferrer')
    }, listener)
    edit.addEventListener('keydown', event => {
      if (!event.target.matches(PAPER_FORMULA) || !['Enter', 'F2'].includes(event.key)) return
      event.preventDefault()
      editFormula(edit, event.target)
    }, listener)
    item.append(edit)
  }

  function editFormula(editor, formula) {
    const original = formulaSource(formula)
    if (!original) return
    const match = readMath(original, 0, original.length, true)
    if (match?.end !== original.length) return
    const input = element(doc, 'textarea', 'nl-paper-formula-source')
    input.setAttribute('aria-label', t('LaTeX 源码'))
    input.rows = match.display ? 3 : 1
    input.value = match.latex
    input.spellcheck = false
    let finished = false
    const editedSource = () => input.value.trim() ? match.open + input.value + match.close : ''
    function finish(cancel = false, returnFocus = false) {
      if (finished) return
      finished = true
      const source = cancel ? original : editedSource()
      const next = makePaperFormula(doc, source) ?? doc.createTextNode(source)
      formula.replaceWith(next)
      if (returnFocus && next.isConnected) {
        editor.focus({ preventScroll: true })
        placeCaretAfter(next, win.getSelection())
      }
      saveEditor(editor)
    }
    input.addEventListener('input', () => { formula.dataset.nlMath = editedSource() }, listener)
    input.addEventListener('blur', () => finish(), { ...listener, once: true })
    input.addEventListener('keydown', event => {
      if (event.isComposing) return
      const cancel = event.key === 'Escape'
      const apply = event.key === 'Enter' && (!match.display || event.ctrlKey || event.metaKey)
      if (!cancel && !apply) return
      event.preventDefault()
      event.stopPropagation()
      finish(cancel, true)
    }, listener)
    formula.replaceChildren(input)
    input.focus({ preventScroll: true })
    input.select()
  }

  function renderMarkdownBlock(item, block) {
    const preview = element(doc, 'div', 'nl-paper-edit nl-paper-markdown-preview')
    const toggle = element(doc, 'button', 'nl-paper-markdown-toggle', t('编辑 Markdown'))
    toggle.type = 'button'
    const editor = element(doc, 'textarea', 'nl-paper-markdown-source')
    editor.hidden = true
    editor.setAttribute('aria-label', t('编辑 Markdown 源码'))
    editor.spellcheck = false
    editor.value = block.markdown
    function updatePreview() {
      preview.innerHTML = renderPaperMarkdown(editor.value)
    }
    function saveMarkdown() {
      const old = page.blocks.find(candidate => candidate.id === block.id)
      if (!old || editor.value === old.markdown) return
      const { html, ...metadata } = old
      const updated = { ...metadata, text: editor.value, markdown: editor.value }
      const checkpoint = editId !== old.id
      editId = old.id
      changeBlocks(page.blocks.map(candidate => candidate.id === old.id ? updated : candidate),
        { repaint: false, checkpoint })
    }
    toggle.addEventListener('click', () => {
      const editing = editor.hidden
      if (!editing) {
        saveMarkdown()
        updatePreview()
      }
      preview.hidden = editing
      editor.hidden = !editing
      toggle.textContent = editing ? t('预览 Markdown') : t('编辑 Markdown')
      if (editing) editor.focus()
      else if (fitContent()) {
        resize()
        onChange(page)
      }
    }, listener)
    preview.addEventListener('dblclick', event => {
      if (!event.target.closest?.('a')) toggle.click()
    }, listener)
    editor.addEventListener('input', saveMarkdown, listener)
    editor.addEventListener('blur', () => {
      saveMarkdown()
      editId = null
    }, listener)
    updatePreview()
    item.append(toggle, editor, preview)
  }

  function replacePage(next, { repaint = true, checkpoint = true } = {}) {
    if (checkpoint) {
      undoStack.push(page)
      if (undoStack.length > MAX_UNDO) undoStack.shift()
      redoStack.length = 0
    }
    page = next
    if (repaint) render()
    else {
      if (fitContent()) resize()
      updateControls()
    }
    onChange(page)
  }

  function changeBlocks(blocks, options) {
    replacePage({ ...page, blocks }, options)
  }

  function saveEditor(editor) {
    if (!editor?.isConnected) return
    const id = editor.dataset.editor
    const old = page.blocks.find(block => block.id === id)
    if (!old) return
    const html = sanitizePaperHtml(doc, editor.innerHTML)
    const structured = layoutBaseline.has(editor)
    if (structured && layoutBaseline.get(editor) === html) return
    const text = (editor.querySelector(PAPER_FORMULA) ? paperSourceText(editor) : editor.innerText).replace(/\u00a0/g, ' ')
    const sameHtml = old.html === undefined ? [...editor.children].every(child => child.matches(PAPER_FORMULA)) : html === old.html
    if (!structured && text === (old.text ?? '') && sameHtml) return
    const updated = { ...old, html, text }
    if (structured) {
      updated.markdown = markdownFromHtml(html, doc)
      layoutBaseline.set(editor, html)
    }
    const newEdit = editId !== id
    editId = id
    changeBlocks(page.blocks.map(block => block.id === id ? updated : block), { repaint: false, checkpoint: newEdit })
  }

  function flushEdits() {
    if (focusedEditor) saveEditor(focusedEditor)
  }

  function selectBlock(id) {
    currentId = id
    polygon = []
    updateControls()
    drawInk()
  }

  function undo() {
    flushEdits()
    const previous = undoStack.pop()
    if (!previous) return
    redoStack.push(page)
    replacePage(previous, { checkpoint: false })
  }

  function redo() {
    flushEdits()
    const next = redoStack.pop()
    if (!next) return
    undoStack.push(page)
    replacePage(next, { checkpoint: false })
  }

  function extendPage() {
    if (page.background) return notify(t('PDF 批注页采用原文件的纸面比例'))
    const height = Math.min(MAX_SIDE, page.height + 440)
    if (height !== page.height) replacePage({ ...page, height })
  }

  function format(command, value) {
    if (!focusedEditor?.isConnected) {
      const block = currentId ? blockNodes.get(currentId) : undefined
      const editor = block?.querySelector('[data-editor]')
      if (!editor) return notify(t('先在文字块里放置光标'))
      editor.focus()
    }
    if (!focusedEditor.contains(doc.activeElement)) focusedEditor.focus()
    const applied = doc.execCommand(command, false, value)
    saveEditor(focusedEditor)
    return applied
  }

  function openLink() {
    if (!focusedEditor?.isConnected) return notify(t('先在文字块里放置光标'))
    const userSelection = win.getSelection()
    linkSelection = userSelection?.rangeCount ? userSelection.getRangeAt(0).cloneRange() : null
    linkBox.hidden = false
    linkInput.value = ''
    linkInput.focus()
  }

  function paste(event) {
    if (event.target !== event.currentTarget) return
    const files = Array.from(event.clipboardData?.files ?? [])
    if (files.length) {
      event.preventDefault()
      const block = page.blocks.find(item => item.id === currentId)
      insertFiles(files, block ? { x: block.x + 24, y: block.y + 36 } : undefined).catch(report)
      return
    }
    const rich = event.clipboardData?.getData('text/html')
    const plain = event.clipboardData?.getData('text/plain') ?? ''
    const fragment = element(doc, 'div')
    if (rich) fragment.innerHTML = sanitizePaperHtml(doc, rich)
    else fragment.textContent = plain.replace(/\r\n?/g, '\n')
    if (!renderRichMath(fragment) && (!rich || fragment.textContent.trim() === plain.trim())) {
      const formula = standalonePaperFormula(doc, plain)
      if (formula) fragment.replaceChildren(formula)
    }
    if (!rich && !fragment.querySelector(PAPER_FORMULA)) return
    event.preventDefault()
    let tail = fragment.lastChild
    while (tail) {
      if (tail.nodeType === 3 && !tail.data) tail = tail.previousSibling
      else if (tail.nodeType === 1 && !tail.matches(PAPER_FORMULA)) tail = tail.lastChild
      else break
    }
    insertFormulaHtml(event.currentTarget, win.getSelection(), tail && formulaSource(tail), () =>
      format('insertHTML', fragment.innerHTML))
    saveEditor(event.currentTarget)
  }

  function copyFormula(event) {
    if (event.target !== event.currentTarget || !event.clipboardData) return
    const selection = win.getSelection()
    if (!selection?.rangeCount || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    const editor = event.currentTarget
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return
    const fragment = element(doc, 'div')
    fragment.append(range.cloneContents())
    if (!fragment.querySelector(PAPER_FORMULA)) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', paperSourceText(fragment))
    event.clipboardData.setData('text/html', sanitizePaperHtml(doc, fragment.innerHTML))
    if (event.type === 'cut') format('delete')
  }

  async function insertFiles(files, point) {
    return insert(await Promise.all(files.map(async file => ({
      kind: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(file.type)
        ? 'image' : 'file',
      name: file.name,
      dataUrl: await readData(file, win),
    }))), point)
  }

  function downloadFile(block) {
    const data = typeof block.dataUrl === 'string' && /^data:[^,]*;base64,/i.test(block.dataUrl)
      ? block.dataUrl.slice(block.dataUrl.indexOf(',') + 1) : ''
    if (!data) return notify(t('此附件没有保存原文件'))
    const anchor = element(doc, 'a')
    anchor.href = `data:application/octet-stream;base64,${data}`
    anchor.download = block.name || t('附件')
    anchor.click()
  }

  async function insert(items, point) {
    if (destroyed) return []
    const targetPageId = page.id
    const materials = Array.isArray(items) ? items : [items]
    const last = page.blocks.at(-1)
    const landing = point ?? nextInsertion ?? (last ? { x: last.x + 12, y: last.y + blockGeometry(last).height + 24 } : { x: 38, y: 38 })
    const newBlocks = []
    let y = finite(landing.y, 38)
    for (const material of materials) {
      if (!material || !['text', 'image', 'file', 'card'].includes(material.kind)) continue
      const isCard = material.kind === 'card'
      if (isCard && material.card?.type !== TWO_CARD) continue
      const structured = material.kind === 'text' && NOTE_LAYOUTS.includes(material.layout)
      const minWidth = isCard ? 380 : 140
      const x = clamp(finite(landing.x, 38), 0, Math.max(0, page.width - minWidth))
      const dataUrl = material.dataUrl ?? (material.blob || material.file ? await readData(material.blob ?? material.file, win) : undefined)
      const block = {
        id: identifier(), kind: material.kind, x, y: Math.max(0, y),
        width: Math.min(isCard || structured ? 640 : 470, page.width - x), height: 38,
      }
      if (material.source !== undefined) block.source = material.source
      if (material.kind === 'text') {
        block.text = String(material.markdown ?? material.text ?? '')
        if (structured) block.layout = material.layout
        if (typeof material.originalText === 'string') block.originalText = material.originalText
        if (typeof material.markdown === 'string') block.markdown = material.markdown
        else if (material.html) block.html = sanitizePaperHtml(doc, material.html)
        const lines = block.text.split(/\r?\n/).reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 35)), 0)
        block.height = Math.max(44, Math.min(500, lines * 22 + 12))
      } else if (isCard) {
        block.card = twoCard(material.card)
        block.text = twoCardMarkdown(block.card)
        block.height = 395
      } else {
        if (!dataUrl) continue
        block.name = material.name ?? material.file?.name ?? ''
        block.dataUrl = dataUrl
        if (material.kind === 'image') {
          if (!IMAGE_DATA.test(dataUrl)) throw new Error(t('支持 PNG、JPEG、WebP、GIF、AVIF 和 BMP 图片'))
          const image = await loadedImage(win, dataUrl)
          block.width = Math.min(block.width, image.naturalWidth || 400)
          block.height = Math.max(32, Math.round(block.width * image.naturalHeight / image.naturalWidth))
        }
      }
      if (page.background) block.y = clamp(block.y, 0, Math.max(0, page.height - block.height))
      y = block.y + block.height + (block.source ? 24 : 10) + 14
      newBlocks.push(block)
    }
    if (!newBlocks.length || destroyed) return []
    if (page.id !== targetPageId) throw new Error(t('已切换笔记页，请重新选择内容的落点'))
    const needed = Math.max(...newBlocks.map(block => block.y + block.height)) + 40
    const height = page.background ? page.height : Math.max(page.height, Math.min(MAX_SIDE, needed))
    nextInsertion = undefined
    mode = 'select'
    currentId = newBlocks.at(-1).id
    polygon = []
    replacePage({ ...page, height, blocks: [...page.blocks, ...newBlocks] })
    blockNodes.get(currentId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    return newBlocks
  }

  function addText(point) {
    insert({ kind: 'text', text: '' }, point).then(([block]) => {
      if (block) blockNodes.get(block.id)?.querySelector('[data-editor]')?.focus()
    }).catch(report)
  }

  async function addMarkdown() {
    const [block] = await insert({ kind: 'text', markdown: '' })
    if (block) blockNodes.get(block.id)?.querySelector('.nl-paper-markdown-toggle')?.click()
  }

  function pointFor(event) {
    const rect = sheet.getBoundingClientRect()
    return {
      x: clamp((event.clientX - rect.left) / scale, 0, page.width),
      y: clamp((event.clientY - rect.top) / scale, 0, page.height),
      pressure: event.pointerType === 'pen' ? finite(event.pressure, 0.6) : 0.65,
    }
  }

  function matchesPaper(target) {
    return target instanceof win.Element && sheet.contains(target)
  }

  function start(event) {
    if (event.button !== 0 || gesture || event.isPrimary === false) return
    const point = pointFor(event)
    const item = event.target.closest?.('[data-id]')
    const block = item ? page.blocks.find(candidate => candidate.id === item.dataset.id) : null
    if (mode === 'select') {
      if (block) {
        selectBlock(block.id)
        const moving = event.target.closest('[data-move]')
        const resizing = event.target.closest('[data-resize]')
        if (!moving && !resizing) return
        beginGesture(event, { tool: moving ? 'move' : 'resize', origin: point, block, node: item })
        return
      }
      selectBlock(null)
      nextInsertion = point
      return
    }
    if (mode === 'text') {
      if (!event.target.closest('[data-editor], .nl-two-card, .nl-note-original')) addText(point)
      return
    }
    currentId = null
    if (mode === 'lasso') {
      polygon = [point]
      beginGesture(event, { tool: 'lasso' })
    } else if (mode === 'eraser') {
      beginGesture(event, { tool: 'eraser', original: page })
      erase(point)
    } else {
      const activeSize = mode === 'highlight' ? highlighterSize : penSize
      const activeColor = mode === 'highlight' ? highlighterColor : penColor
      toolStroke = { id: identifier(), type: mode, size: activeSize, color: activeColor, points: [point] }
      beginGesture(event, { tool: mode })
      drawInk()
    }
  }

  function beginGesture(event, data) {
    if (event.cancelable) event.preventDefault()
    gesture = { ...data, pointerId: event.pointerId }
    sheet.setPointerCapture?.(event.pointerId)
  }

  function erase(point) {
    const ctx = ink.getContext('2d')
    if (!ctx) return
    const strokes = erasePaths(page.strokes, point, eraserSize, ctx)
    if (strokes.length !== page.strokes.length) {
      page = { ...page, strokes }
      drawInk()
    }
  }

  function movePointer(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (event.cancelable) event.preventDefault()
    const point = pointFor(event)
    const { tool, origin, block, node } = gesture
    if (tool === 'move' || tool === 'resize') {
      const dx = point.x - origin.x
      const dy = point.y - origin.y
      const changed = { ...block }
      if (tool === 'move') {
        changed.x = clamp(block.x + dx, 0, Math.max(0, page.width - block.width))
        changed.y = clamp(block.y + dy, 0, Math.max(0, page.height - block.height))
      } else {
        changed.width = clamp(block.width + dx, 80, page.width - block.x)
        changed.height = clamp(block.height + dy, 32, page.height - block.y)
        if (block.kind === 'image') {
          const image = node.querySelector('img')
          if (image) image.style.height = `${changed.height}px`
        }
      }
      gesture.changed = changed
      position(node, changed)
      return
    }
    if (tool === 'eraser') {
      erase(point)
      return
    }
    if (tool === 'lasso') {
      if (Math.hypot(point.x - polygon.at(-1).x, point.y - polygon.at(-1).y) >= 2) polygon.push(point)
    } else if (toolStroke) {
      if (tool === 'pen' || tool === 'highlight') {
        const samples = event.getCoalescedEvents?.()
        for (const sample of samples?.length ? samples : [event]) toolStroke.points.push(pointFor(sample))
      } else {
        toolStroke.points[1] = point
      }
    }
    drawInk()
  }

  function finish(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const current = gesture
    gesture = null
    if (sheet.hasPointerCapture?.(event.pointerId)) sheet.releasePointerCapture(event.pointerId)
    if (current.tool === 'eraser') {
      const changed = page
      if (changed !== current.original) {
        page = current.original
        replacePage(changed, { repaint: false })
      }
    } else if (current.tool === 'lasso') {
      if (polygon.length < 3) polygon = []
    } else if (current.changed) {
      changeBlocks(page.blocks.map(block => block.id === current.changed.id ? current.changed : block))
    } else if (toolStroke) {
      const stroke = toolStroke
      toolStroke = null
      replacePage({ ...page, strokes: [...page.strokes, stroke] }, { repaint: false })
    }
    updateControls()
    drawInk()
  }

  function cancelGesture() {
    if (!gesture) return
    const current = gesture
    gesture = null
    if (sheet.hasPointerCapture?.(current.pointerId)) sheet.releasePointerCapture(current.pointerId)
    if (current.original) page = current.original
    if (current.changed) {
      position(current.node, current.block)
      if (current.block.kind === 'image') {
        const image = current.node.querySelector('img')
        if (image) image.style.height = `${current.block.height}px`
      }
    }
    toolStroke = null
    polygon = []
    drawInk()
  }

  function nudge(event, id) {
    const direction = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key]
    if (!direction) return
    event.preventDefault()
    const amount = event.shiftKey ? 12 : 2
    const blocks = page.blocks.map(block => block.id === id ? {
      ...block,
      x: clamp(block.x + direction[0] * amount, 0, Math.max(0, page.width - block.width)),
      y: clamp(block.y + direction[1] * amount, 0, Math.max(0, page.height - block.height)),
    } : block)
    changeBlocks(blocks)
    blockNodes.get(id)?.querySelector('[data-move]')?.focus()
  }

  function insidePolygon(block) {
    const { x, y, width, height } = blockGeometry(block)
    const edges = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }, { x, y }]
    return pathTouchesPolygon(edges, polygon) ||
      polygon.some(point => point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height)
  }

  function removeSelected() {
    if (currentId) {
      const id = currentId
      currentId = null
      changeBlocks(page.blocks.filter(block => block.id !== id))
    } else if (polygon.length > 2) {
      const blocks = page.blocks.filter(block => !insidePolygon(block))
      const strokes = page.strokes.filter(stroke => !stroke.points?.length || !pathTouchesPolygon(outline(stroke), polygon))
      polygon = []
      replacePage({ ...page, blocks, strokes })
    }
  }

  function selectedText() {
    const active = doc.activeElement
    if (active?.matches('.nl-paper-markdown-source, .nl-paper-formula-source') && objects.contains(active) && active.selectionStart !== active.selectionEnd) {
      return active.value.slice(active.selectionStart, active.selectionEnd).trim()
    }
    const selection = win.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return ''
    const range = selection.getRangeAt(0)
    if (!objects.contains(range.startContainer) || !objects.contains(range.endContainer)) return ''
    const selected = range.cloneContents()
    const formulas = selected.querySelectorAll(PAPER_FORMULA + ', math')
    if (!formulas.length) return selection.toString().trim()
    for (const equation of formulas) {
      const source = formulaSource(equation)
      if (source !== null) {
        equation.replaceWith(doc.createTextNode(source))
        continue
      }
      const latex = equation.querySelector('annotation[encoding="application/x-tex"]')?.textContent
      if (latex !== undefined) {
        const multiline = equation.getAttribute('display') === 'block'
        equation.replaceWith(doc.createTextNode(multiline ? '$$' + latex + '$$' : '\\(' + latex + '\\)'))
      }
    }
    return paperSourceText(selected).trim()
  }

  function noteSource() {
    return {
      type: 'note', title: page.title || t('学习笔记'), pageId: page.id,
      page: page.background?.pageNumber, pageNumber: page.background?.pageNumber,
    }
  }

  function cardMaterial(card) {
    const data = twoCard(card)
    return {
      kind: 'text',
      text: twoCardMarkdown(data, t),
      source: noteSource(),
      editableDraft: true,
      suggestedQuestion: data.question.trim() ? '' : t('为什么两种抽样规则的联合分布不同？'),
    }
  }

  function renderTextNode(ctx, textNode, range, origin, bounds) {
    const style = win.getComputedStyle(textNode.parentElement)
    const fontSize = parseFloat(style.fontSize)
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`
    ctx.fillStyle = style.color || '#26374e'
    ctx.strokeStyle = ctx.fillStyle
    ctx.textBaseline = 'alphabetic'
    // A range locates real wrapped lines before the canvas paints them. Use
    // graphemes for unspaced scripts and actual words for proportional text.
    const content = textNode.textContent
    const pieces = content.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)
    for (const piece of pieces) {
      range.setStart(textNode, piece.index)
      range.setEnd(textNode, piece.index + piece[0].length)
      const rects = range.getClientRects()
      if (!rects.length) continue
      if (rects.length === 1) {
        const line = lineRect(rects[0], origin, scale)
        if (intersects(line, bounds)) drawPart(piece[0], line)
      } else {
        let offset = piece.index
        for (const char of piece[0]) {
          range.setStart(textNode, offset)
          offset += char.length
          range.setEnd(textNode, offset)
          const raw = range.getBoundingClientRect()
          const line = lineRect(raw, origin, scale)
          if (intersects(line, bounds)) drawPart(char, line)
        }
      }
    }
    function drawPart(word, line) {
      const baseline = line.y + (line.height + fontSize) / 2 - fontSize * 0.19
      if (line.width > 0) ctx.fillText(word, line.x, baseline, line.width)
      if (style.textDecorationLine.includes('underline')) {
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(line.x, baseline + 2)
        ctx.lineTo(line.x + line.width, baseline + 2)
        ctx.stroke()
      }
    }
  }

  function renderText(ctx, node, origin, bounds) {
    if (!node) return
    for (const cell of node.querySelectorAll('td, th, input[type="checkbox"]')) {
      const rect = lineRect(cell.getBoundingClientRect(), origin, scale)
      if (!intersects(rect, bounds)) continue
      ctx.lineWidth = 1
      ctx.strokeStyle = '#788b9e'
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height)
      if (cell.tagName === 'INPUT' && cell.checked) {
        ctx.beginPath()
        ctx.moveTo(rect.x + rect.width * 0.2, rect.y + rect.height * 0.55)
        ctx.lineTo(rect.x + rect.width * 0.4, rect.y + rect.height * 0.73)
        ctx.lineTo(rect.x + rect.width * 0.82, rect.y + rect.height * 0.25)
        ctx.stroke()
      }
    }
    for (const listItem of node.querySelectorAll('li')) {
      const rect = lineRect(listItem.getBoundingClientRect(), origin, scale)
      const size = parseFloat(win.getComputedStyle(listItem).fontSize)
      if (!intersects(rect, bounds)) continue
      ctx.font = `${size}px sans-serif`
      ctx.fillStyle = '#27374d'
      const parent = listItem.parentElement
      const point = parent.tagName === 'OL' ? String(parent.start + [...parent.children].indexOf(listItem)) + '.' : '•'
      ctx.fillText(point, rect.x - size, rect.y + size)
    }
    for (const fraction of node.querySelectorAll('mfrac')) {
      const [numerator, denominator] = fraction.children
      if (!numerator || !denominator) continue
      const rect = lineRect(fraction.getBoundingClientRect(), origin, scale)
      if (!intersects(rect, bounds)) continue
      const line = (numerator.getBoundingClientRect().bottom + denominator.getBoundingClientRect().top) / 2
      const y = (line - origin.top) / scale
      ctx.strokeStyle = '#26394f'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(rect.x, y)
      ctx.lineTo(rect.x + rect.width, y)
      ctx.stroke()
    }
    const walker = doc.createTreeWalker(node, win.NodeFilter.SHOW_TEXT)
    const range = doc.createRange()
    while (walker.nextNode()) {
      if (!walker.currentNode.parentElement?.closest('annotation')) renderTextNode(ctx, walker.currentNode, range, origin, bounds)
    }
  }

  function renderCardCanvas(ctx, node, origin, bounds) {
    if (!node) return
    for (const part of [node, ...node.querySelectorAll('.nl-card-track, .nl-card-fill, textarea')]) {
      const rect = lineRect(part.getBoundingClientRect(), origin, scale)
      if (!intersects(rect, bounds)) continue
      const style = win.getComputedStyle(part)
      ctx.fillStyle = style.backgroundColor
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      if (part.tagName !== 'TEXTAREA') continue
      ctx.save()
      ctx.beginPath()
      ctx.rect(rect.x, rect.y, rect.width, rect.height)
      ctx.clip()
      ctx.font = style.fontSize + ' ' + style.fontFamily
      ctx.fillStyle = style.color
      const width = Math.max(1, rect.width - 12)
      const lineHeight = parseFloat(style.lineHeight) || 22
      let y = rect.y + lineHeight - part.scrollTop
      let line = ''
      for (const character of part.value) {
        if (character === '\n' || (line && ctx.measureText(line + character).width > width)) {
          ctx.fillText(line, rect.x + 6, y)
          y += lineHeight
          line = ''
        }
        if (y > rect.y + rect.height) break
        if (character !== '\n') line += character
      }
      ctx.fillText(line, rect.x + 6, y)
      ctx.restore()
    }
  }

  async function renderPng(bounds, clip) {
    const target = page
    await backgroundPending
    const imageNodes = Array.from(objects.querySelectorAll('img.nl-paper-object-image'))
    await Promise.all(imageNodes.map(image => image.decode?.().catch(() => {})))
    if (destroyed || target !== page) throw new Error(t('纸面已变更，请重新截取当前选区'))
    const factor = Math.min(2, 4096 / Math.max(bounds.width, bounds.height))
    const canvas = element(doc, 'canvas')
    canvas.width = Math.max(1, Math.ceil(bounds.width * factor))
    canvas.height = Math.max(1, Math.ceil(bounds.height * factor))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error(t('当前应用无法生成画布图片'))
    ctx.setTransform(factor, 0, 0, factor, -bounds.x * factor, -bounds.y * factor)
    ctx.fillStyle = '#fffef9'
    ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height)
    if (clip?.length > 2) {
      ctx.beginPath()
      polyline(ctx, clip)
      ctx.closePath()
      ctx.clip()
    }
    if (background) ctx.drawImage(background, 0, 0, target.width, target.height)
    const origin = sheet.getBoundingClientRect()
    for (const block of target.blocks) {
      const node = blockNodes.get(block.id)
      if (!node || !intersects(blockGeometry(block), bounds)) continue
      const image = node.querySelector('img')
      if (image?.complete && image.naturalWidth > 0) {
        ctx.drawImage(image, block.x, block.y, block.width, block.height)
      }
      const preview = node.querySelector('.nl-paper-edit, .nl-paper-file, .nl-two-card')
      if (preview?.hidden) {
        const editor = node.querySelector('.nl-paper-markdown-source')
        const source = lineRect(editor.getBoundingClientRect(), origin, scale)
        ctx.font = '16px Consolas, monospace'
        ctx.fillStyle = '#26394f'
        let y = source.y + 21
        for (const line of editor.value.split('\n')) {
          ctx.fillText(line, source.x + 8, y, source.width - 16)
          y += 24
          if (y > source.y + source.height) break
        }
      } else {
        if (block.kind === 'card') renderCardCanvas(ctx, preview, origin, bounds)
        renderText(ctx, preview, origin, bounds)
      }
      renderText(ctx, node.querySelector('.nl-paper-reference'), origin, bounds)
    }
    for (const stroke of target.strokes) renderStroke(ctx, stroke)
    return canvasPng(canvas)
  }

  async function captureSelection() {
    if (destroyed) return []
    flushEdits()
    const text = selectedText()
    const source = noteSource()
    if (text) return [{ kind: 'text', text, source }]
    if (polygon.length > 2) {
      const clip = [...polygon]
      const bounds = selectionBounds(clip, page.width, page.height)
      if (bounds.width < 3 || bounds.height < 3) return []
      const blob = await renderPng(bounds, clip)
      return [{
        kind: 'image', blob, dataUrl: await readData(blob, win),
        name: t('笔记选区.png'), source: { ...source, region: bounds },
      }]
    }
    const block = page.blocks.find(candidate => candidate.id === currentId)
    if (block?.kind === 'card' && block.card?.type === TWO_CARD) return [cardMaterial(block.card)]
    if (block?.kind === 'text' && block.text?.trim()) {
      return [{ kind: 'text', text: block.text, html: block.html, markdown: block.markdown, source: block.source ?? source }]
    }
    if (block?.kind === 'image' && block.dataUrl) {
      return [{
        kind: 'image', blob: imageBlob(block.dataUrl, win), dataUrl: block.dataUrl,
        name: block.name, source: block.source ?? source,
      }]
    }
    return []
  }

  async function askSelection() {
    const materials = await captureSelection()
    if (!materials.length) return notify(t('请选择文字、图片，或用套索圈出纸面区域'))
    await onAsk?.(materials)
  }

  function exportPage() {
    flushEdits()
    return renderPng({ x: 0, y: 0, width: page.width, height: page.height })
  }

  function setPage(next) {
    if (!next || destroyed || next === page) return
    flushEdits()
    cancelGesture()
    // Title or metadata changes supplied by the library should keep local
    // undo and selection when the underlying paper has not been replaced.
    const sameDocument = next.id === page.id && next.blocks === page.blocks && next.strokes === page.strokes
    page = normalizedPage(next)
    if (sameDocument) {
      refreshBackground()
      resize()
      return
    }
    undoStack.length = 0
    redoStack.length = 0
    nextInsertion = undefined
    currentId = null
    polygon = []
    viewport.scrollTo?.(0, 0)
    render()
  }

  function keyDown(event) {
    const target = event.target
    if (target.closest?.('input, textarea, [contenteditable="true"]')) return
    const key = event.key.toLowerCase()
    if (event.ctrlKey || event.metaKey) {
      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (key === 'y') {
        event.preventDefault()
        redo()
      }
    } else if (key === 'delete' && (currentId || polygon.length > 2)) {
      event.preventDefault()
      removeSelected()
    } else if (key === 'escape') {
      cancelGesture()
      selectBlock(null)
    }
  }

  color.addEventListener('input', () => {
    if (mode === 'highlight') highlighterColor = colorFor(color.value, highlighterColor)
    else penColor = colorFor(color.value, penColor)
  }, listener)
  size.addEventListener('input', () => {
    const width = Number(size.value)
    if (mode === 'highlight') highlighterSize = width
    else if (mode === 'eraser') eraserSize = width
    else penSize = width
  }, listener)
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? [])
    fileInput.value = ''
    insertFiles(files).catch(report)
  }, listener)
  sheet.addEventListener('pointerdown', start, listener)
  sheet.addEventListener('pointermove', movePointer, listener)
  sheet.addEventListener('pointerup', finish, listener)
  sheet.addEventListener('pointercancel', cancelGesture, listener)
  sheet.addEventListener('lostpointercapture', cancelGesture, listener)
  sheet.addEventListener('dragover', event => {
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault()
  }, listener)
  sheet.addEventListener('drop', event => {
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (!files.length) return
    event.preventDefault()
    insertFiles(files, pointFor(event)).catch(report)
  }, listener)
  container.addEventListener('keydown', keyDown, listener)
  doc.addEventListener('selectionchange', updateControls, listener)
  const observer = new win.ResizeObserver(resize)
  observer.observe(viewport)
  render()

  return {
    setPage, insert, captureSelection, exportPage, matchesPaper, pointFromEvent: pointFor,
    isInteracting() {
      const active = doc.activeElement
      return Boolean(gesture || active && objects.contains(active) &&
        active.matches('[contenteditable="true"], textarea'))
    },
    getSelectionBlock() {
      flushEdits()
      return page.blocks.find(block => block.id === currentId)
    },
    getPage: () => {
      flushEdits()
      return page
    },
    destroy() {
      if (destroyed) return
      flushEdits()
      destroyed = true
      observer.disconnect()
      controller.abort()
      zoomGroup.remove()
      container.remove()
    },
  }
}

/** Render a persisted page even when it isn't the active editor tab. */
export async function exportPaperPage(doc, page) {
  const scratch = element(doc, 'div', 'nl-paper-export')
  scratch.setAttribute('aria-hidden', 'true')
  scratch.inert = true
  Object.assign(scratch.style, {
    position: 'fixed', top: '0', left: '-15000px', width: '900px', height: '1000px', pointerEvents: 'none',
  })
  doc.body.append(scratch)
  const editor = mountPaper(scratch, { page })
  try {
    return await editor.exportPage()
  } finally {
    editor.destroy()
    scratch.remove()
  }
}
