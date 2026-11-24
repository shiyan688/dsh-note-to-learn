import { t } from './i18n.js'
import { markdownFromHtml } from './paper-html.js'
const WEBVIEW = 'webview[data-sidebar-browser-frame="webview"]'
const PDF_PAGE = '[data-pdf-page]'
const PDF_VIEW = '[data-pdf-preview]'
const CHAT_ROW = '[data-chat-node-key][data-chat-flow-kind]'
const HIDDEN = '[hidden], [inert], [aria-hidden="true"]'
const PNG = 'image/png'
const BLOCKS = 'div, p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr, section'

function element(node) {
  return node?.nodeType === 1 ? node : node?.parentElement ?? null
}

function positivePage(node) {
  const page = Number(node?.closest(PDF_PAGE)?.getAttribute('data-pdf-page'))
  return Number.isInteger(page) && page > 0 ? page : undefined
}

function sessionAt(node) {
  const owner = node?.closest('[data-sidebar-right-session], [data-conversation-session]')
  return owner?.getAttribute('data-sidebar-right-session') || owner?.getAttribute('data-conversation-session') || undefined
}

function chatSource(row) {
  const kind = row?.getAttribute('data-chat-flow-kind')
  const role = ['user', 'steering', 'turn-trigger'].includes(kind) ? 'user'
    : ['assistant', 'assistant-step', 'assistant-message'].includes(kind) ? 'assistant' : undefined
  if (!role) return null
  return {
    origin: 'chat', role, title: role === 'user' ? t('我的消息') : t('AI 回复'),
    sessionId: sessionAt(row), messageKey: row.getAttribute('data-chat-node-key') || undefined,
  }
}

function pdfSource(node, page, endPage) {
  const preview = node.closest('[data-document-preview]')
  const label = preview?.querySelector('[data-textpreview-path]')
  const path = label?.getAttribute('title') || label?.textContent?.trim() || undefined
  const title = path?.split(/[\\/]/u).filter(Boolean).at(-1) || 'PDF'
  return { origin: 'pdf', title, path, page, endPage: endPage === page ? undefined : endPage }
}

function httpUrl(value) {
  try {
    const url = new URL(value)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) return url.href
  } catch { /* Invalid or still blank guest address. */ }
  return undefined
}

function guestAddress(guest) {
  try { return httpUrl(guest.getURL?.()) } catch { return undefined }
}

function guestTitle(guest, url) {
  try { return guest.getTitle?.().trim() || new URL(url).hostname } catch { return url || t('网页') }
}

function stamp(source, sessionId) {
  return { ...source, sessionId, capturedAt: new Date().toISOString() }
}

function formulaText(formula) {
  const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim()
  if (!tex) return ''
  return formula.closest('.katex-display') ? '\n$$\n' + tex + '\n$$\n' : '$' + tex + '$'
}

function fragmentText(node) {
  if (node.nodeType === 3) return node.nodeValue || ''
  if (node.nodeType !== 1 && node.nodeType !== 11) return ''
  if (node.matches?.('.katex')) return formulaText(node) || node.querySelector('.katex-html')?.textContent || ''
  if (node.matches?.('button, .sr-only, [data-text-interaction-exclude], .katex-mathml, [hidden], [aria-hidden="true"]')) return ''
  if (node.nodeName === 'BR') return '\n'
  const text = [...node.childNodes].map(fragmentText).join('')
  return text && node.matches?.(BLOCKS) ? '\n' + text + '\n' : text
}

function chatRange(selection) {
  if (selection?.rangeCount !== 1 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0).cloneRange()
  const startFormula = element(range.startContainer)?.closest('.katex')
  const endFormula = element(range.endContainer)?.closest('.katex')
  if (startFormula) range.setStartBefore(startFormula.closest('.katex-display') || startFormula)
  if (endFormula) range.setEndAfter(endFormula.closest('.katex-display') || endFormula)
  return range
}

/** Treat a rendered KaTeX expression as an atom and project its TeX annotation. */
export function readChatSelection(selection) {
  const range = chatRange(selection)
  if (!range) return ''
  const fragment = range.cloneContents()
  if (!fragment.querySelector('.katex')) return selection.toString().trim()
  return fragmentText(fragment).replace(/\n{3,}/gu, '\n\n').trim()
}

function assistantMarkdown(selection, doc) {
  const range = chatRange(selection)
  const fragment = range.cloneContents()
  for (const formula of fragment.querySelectorAll('.katex')) {
    const wrapper = formula.closest('.katex-display') || formula
    wrapper.replaceWith(doc.createTextNode(formulaText(formula) || formula.querySelector('.katex-html')?.textContent || ''))
  }
  for (const hidden of fragment.querySelectorAll('button, .sr-only, [data-text-interaction-exclude], [hidden], [aria-hidden="true"]')) {
    hidden.remove()
  }
  // A selection wholly inside a table or list can omit its outer container.
  const owner = element(range.commonAncestorContainer)
  const wrapper = doc.createElement('div')
  const table = owner?.closest('table')
  const list = owner?.closest('ol, ul')
  if (table && !fragment.querySelector('table') && fragment.querySelector('tr')) {
    const shell = doc.createElement('table')
    shell.append(fragment)
    wrapper.append(shell)
  } else if (list && [...fragment.children].some(child => child.tagName === 'LI')) {
    const shell = list.cloneNode(false)
    shell.append(fragment)
    wrapper.append(shell)
  } else wrapper.append(fragment)
  return markdownFromHtml(wrapper.innerHTML, doc)
}

export function intersectRect(a, b) {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.right, b.right)
  const bottom = Math.min(a.bottom, b.bottom)
  return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null
}

/** Convert CSS viewport coordinates into coordinates inside a source element. */
export function sourceCrop(area, bounds, pixelWidth = bounds.width, pixelHeight = bounds.height) {
  const clipped = intersectRect(area, bounds)
  if (!clipped || !pixelWidth || !pixelHeight) throw new Error(t('请框选页面内的区域。'))
  const scaleX = pixelWidth / bounds.width
  const scaleY = pixelHeight / bounds.height
  const x = Math.floor((clipped.left - bounds.left) * scaleX)
  const y = Math.floor((clipped.top - bounds.top) * scaleY)
  const right = Math.min(Math.ceil(pixelWidth), Math.ceil((clipped.right - bounds.left) * scaleX))
  const bottom = Math.min(Math.ceil(pixelHeight), Math.ceil((clipped.bottom - bounds.top) * scaleY))
  return { x, y, width: right - x, height: bottom - y }
}

export function guestMenuAnchor({ x, y }, guest) {
  if (Number.isFinite(x) && Number.isFinite(y)) {
    // Electron forwards context-menu coordinates in the embedder's viewport.
    // Allow a pixel of rounding at the guest boundary.
    if (x >= guest.left - 1 && x <= guest.right + 1 && y >= guest.top - 1 && y <= guest.bottom + 1) return { x, y }
    if (x >= 0 && x <= guest.width && y >= 0 && y <= guest.height) {
      return { x: guest.left + x, y: guest.top + y }
    }
  }
  return { x: guest.left, y: guest.top }
}

function visibleBox(node) {
  if (!node.isConnected || node.closest(HIDDEN)) return null
  const view = node.ownerDocument.defaultView
  if (view.getComputedStyle(node).visibility !== 'visible') return null
  let bounds = intersectRect(node.getBoundingClientRect(), { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight })
  for (let parent = node.parentElement; bounds && parent && parent !== node.ownerDocument.body; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent)
    const clipX = /auto|scroll|hidden|clip/u.test(style.overflowX)
    const clipY = /auto|scroll|hidden|clip/u.test(style.overflowY)
    if (!clipX && !clipY) continue
    const rect = parent.getBoundingClientRect()
    bounds = intersectRect(bounds, {
      left: clipX ? rect.left + parent.clientLeft : bounds.left,
      right: clipX ? rect.left + parent.clientLeft + parent.clientWidth : bounds.right,
      top: clipY ? rect.top + parent.clientTop : bounds.top,
      bottom: clipY ? rect.top + parent.clientTop + parent.clientHeight : bounds.bottom,
    })
  }
  return bounds
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(t('无法生成截图。'))), PNG)
  })
}

function bitmapCrop(document, bitmap, { x, y, width, height }) {
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, Math.sqrt(12_000_000 / (width * height)))
  canvas.width = Math.max(1, Math.floor(width * scale))
  canvas.height = Math.max(1, Math.floor(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error(t('截图画布不可用。'))
  context.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height)
  return canvasBlob(canvas)
}

async function chatImage(document, img) {
  if (!img.complete || !img.naturalWidth || !img.naturalHeight) throw new Error(t('请等图片加载完成后再保存。'))
  const width = img.naturalWidth
  const height = img.naturalHeight
  try {
    return await bitmapCrop(document, img, { x: 0, y: 0, width, height })
  } catch {
    throw new Error(t('此图片无法读取。可以先在 DSH 中打开原图再试。'))
  }
}

export function nativeScreenshotBlob(nativeImage, view) {
  if (nativeImage?.isEmpty?.()) throw new Error(t('网页截图为空。请刷新页面后重试。'))
  // NativeImage buffer methods require a Node context. DSH's renderer is sandboxed.
  const dataUrl = nativeImage?.toDataURL?.()
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
    const binary = view.atob(dataUrl.slice('data:image/png;base64,'.length))
    return new view.Blob([Uint8Array.from(binary, character => character.charCodeAt(0))], { type: PNG })
  }
  throw new Error(t('此 DSH 版本没有返回可用的网页截图。'))
}

function button(document, caption, act) {
  const item = document.createElement('button')
  item.type = 'button'
  item.setAttribute('role', 'menuitem')
  item.textContent = caption
  Object.assign(item.style, {
    display: 'block', border: 'none', borderRadius: '5px', background: 'transparent',
    color: 'inherit', font: 'inherit', textAlign: 'left', padding: '8px 11px', width: '100%', cursor: 'pointer',
  })
  item.addEventListener('click', act)
  return item
}

function labelFor(kind, action) {
  if (kind === 'region') return action === 'context' ? t('区域截图加入当前对话') : t('区域截图保存到笔记')
  if (kind === 'image') return action === 'context' ? t('图片加入当前对话') : t('图片保存到笔记')
  return action === 'context' ? t('选中文字加入当前对话') : t('选中文字保存到笔记')
}

function selectRegion(document, node, onRegion, onDismiss) {
  const view = document.defaultView
  const bounds = visibleBox(node)
  if (!bounds) throw new Error(t('请先显示要截图的页面。'))
  const overlay = document.createElement('div')
  overlay.tabIndex = -1
  overlay.setAttribute('aria-label', t('拖动框选截图区域，按 Esc 取消'))
  Object.assign(overlay.style, {
    position: 'fixed', zIndex: '2147483646', left: bounds.left + 'px', top: bounds.top + 'px',
    width: bounds.width + 'px', height: bounds.height + 'px', cursor: 'crosshair', touchAction: 'none',
    background: 'rgba(45, 90, 135, 0.18)', outline: '2px solid #3975c6', userSelect: 'none',
  })
  const help = document.createElement('div')
  help.textContent = t('拖动框选 · Esc 取消')
  Object.assign(help.style, {
    position: 'absolute', top: '8px', left: '8px', padding: '5px 8px', borderRadius: '4px',
    background: '#143762', color: '#fff', font: '12px system-ui, sans-serif', pointerEvents: 'none',
  })
  const box = document.createElement('div')
  Object.assign(box.style, { position: 'absolute', pointerEvents: 'none', border: '2px solid #3f83e5', boxSizing: 'border-box' })
  overlay.append(help, box)
  document.body.append(overlay)
  overlay.focus({ preventScroll: true })
  const controls = new view.AbortController()
  const options = { signal: controls.signal }
  function close() { controls.abort(); overlay.remove() }
  let start
  let pointer

  function point(event) {
    return {
      x: Math.min(bounds.right, Math.max(bounds.left, event.clientX)),
      y: Math.min(bounds.bottom, Math.max(bounds.top, event.clientY)),
    }
  }
  function area(event) {
    const end = point(event)
    return {
      left: Math.min(start.x, end.x), top: Math.min(start.y, end.y),
      right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y),
    }
  }
  overlay.addEventListener('pointerdown', event => {
    if (event.button !== 0 || start) return
    pointer = event.pointerId
    start = point(event)
    overlay.setPointerCapture(pointer)
    event.preventDefault()
  }, options)
  overlay.addEventListener('pointermove', event => {
    if (!start || event.pointerId !== pointer) return
    const region = area(event)
    Object.assign(box.style, {
      left: region.left - bounds.left + 'px', top: region.top - bounds.top + 'px',
      width: region.right - region.left + 'px', height: region.bottom - region.top + 'px',
    })
  }, options)
  overlay.addEventListener('pointerup', event => {
    if (!start || event.pointerId !== pointer) return
    const region = area(event)
    onDismiss()
    if (region.right - region.left >= 3 && region.bottom - region.top >= 3) onRegion(region)
  }, options)
  overlay.addEventListener('pointercancel', onDismiss, options)
  document.addEventListener('scroll', onDismiss, { capture: true, signal: controls.signal })
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onDismiss()
  }, { capture: true, signal: controls.signal })
  view.addEventListener('resize', onDismiss, options)
  view.addEventListener('blur', onDismiss, options)
  return close
}

/** Install capture over the existing Desktop Browser, local PDF and Chat panes. */
export function installCapture({ document, getContext, onClip, reportError = () => {} }) {
  const view = document.defaultView
  if (!view) return () => {}
  const lifetime = new view.AbortController()
  const guests = new Map()
  let dismiss = () => {}

  function resolveContext(node) {
    const detected = sessionAt(node)
    const current = getContext?.(node)
    const sessionId = detected || current?.sessionId
    if (!sessionId || (getContext && current?.sessionId !== sessionId)) return null
    return { ...current, sessionId }
  }

  function ensureCurrent(node, sessionId) {
    if (lifetime.signal.aborted || !node.isConnected || node.closest(HIDDEN) || resolveContext(node)?.sessionId !== sessionId) {
      throw new Error(t('来源已关闭或会话已切换，请重新选择内容。'))
    }
  }

  function report(error) { reportError(error instanceof Error ? error.message : String(error)) }

  function deliver(clip, action, node, context) {
    ensureCurrent(node, context.sessionId)
    return onClip(clip, action, context)
  }

  function openMenu(position, node, context, operations) {
    dismiss()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', t('截取学习资料'))
    Object.assign(menu.style, {
      position: 'fixed', zIndex: '2147483647', minWidth: '170px', maxWidth: 'calc(100vw - 12px)',
      colorScheme: 'light dark', background: 'Canvas', color: 'CanvasText', padding: '4px',
      font: '13px system-ui, sans-serif', boxShadow: '0 5px 24px #0004',
      border: '1px solid color-mix(in srgb, CanvasText 18%, Canvas)', borderRadius: '8px',
    })
    const controls = new view.AbortController()
    const options = { signal: controls.signal }
    function run(operation, action) {
      dismiss()
      Promise.resolve().then(() => {
        ensureCurrent(node, context.sessionId)
        if (operation.region) {
          dismiss = selectRegion(document, operation.region, area => {
            Promise.resolve().then(async () => {
              ensureCurrent(node, context.sessionId)
              const clip = await operation.read(area)
              return deliver(clip, action, node, context)
            }).catch(report)
          }, () => dismiss())
          return
        }
        return Promise.resolve(operation.read()).then(clip => deliver(clip, action, node, context))
      }).catch(report)
    }
    const entries = []
    for (const operation of operations) {
      for (const action of ['context', 'note']) {
        entries.push(button(document, labelFor(operation.kind, action), () => run(operation, action)))
      }
    }
    const copy = operations.find(operation => operation.kind === 'text')
    if (copy && view.navigator.clipboard?.writeText) {
      entries.push(button(document, t('复制选中文字'), () => {
        dismiss()
        view.navigator.clipboard.writeText(copy.read().text).catch(report)
      }))
    }
    menu.append(...entries)
    document.body.append(menu)
    menu.style.left = Math.max(4, Math.min(position.x, view.innerWidth - menu.offsetWidth - 4)) + 'px'
    menu.style.top = Math.max(4, Math.min(position.y, view.innerHeight - menu.offsetHeight - 4)) + 'px'
    dismiss = () => { controls.abort(); menu.remove() }
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) dismiss() }, { ...options, capture: true })
    document.addEventListener('keydown', event => {
      if (!['Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      if (event.key === 'Tab') return dismiss()
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') return dismiss()
      const active = entries.indexOf(document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
        : (active + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length
      entries[next]?.focus({ preventScroll: true })
    }, { ...options, capture: true })
    view.addEventListener('blur', () => dismiss(), options)
    view.addEventListener('resize', () => dismiss(), options)
    entries[0]?.focus({ preventScroll: true })
  }

  function readSelection(node) {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null
    const range = selection.getRangeAt(0)
    const start = element(range.startContainer)
    const end = element(range.endContainer)
    const pdf = node.closest(PDF_VIEW)
    if (pdf && start?.closest(PDF_VIEW) === pdf && end?.closest(PDF_VIEW) === pdf) {
      const firstPage = positivePage(start)
      const lastPage = positivePage(end)
      const text = selection.toString().trim()
      return firstPage && lastPage && text ? { text, source: pdfSource(node, firstPage, lastPage) } : null
    }
    const chat = node.closest(CHAT_ROW)
    const textBody = start?.closest('[data-text-interaction-source]')
    if (!chat || !textBody || textBody !== end?.closest('[data-text-interaction-source]') ||
      !chat.contains(textBody) || textBody.closest('[data-chat-group-part="reasoning"]')) return null
    const source = chatSource(chat)
    const text = source && readChatSelection(selection)
    if (!text || !source) return null
    const markdown = source.role === 'assistant' ? assistantMarkdown(selection, document) : undefined
    return { text, source, markdown }
  }

  function contextMenu(event) {
    const node = element(event.target)
    if (!node || node.closest(HIDDEN) || node.closest('[contenteditable="true"], input, textarea')) return
    if (!node.closest(PDF_VIEW) && !node.closest(CHAT_ROW)) return
    const context = resolveContext(node)
    if (!context) return
    const operations = []
    const selected = readSelection(node)
    if (selected) {
      operations.push({ kind: 'text', read: () => ({ kind: 'text', ...selected, source: stamp(selected.source, context.sessionId) }) })
    }
    const page = node.closest(PDF_PAGE)
    const bitmap = page?.querySelector('canvas')
    if (bitmap?.width && bitmap.height && visibleBox(bitmap)) {
      const source = pdfSource(node, positivePage(page))
      operations.push({ kind: 'region', region: bitmap, async read(area) {
        const rect = sourceCrop(area, bitmap.getBoundingClientRect(), bitmap.width, bitmap.height)
        return { kind: 'image', blob: await bitmapCrop(document, bitmap, rect), source: stamp(source, context.sessionId) }
      } })
    }
    const img = node.closest('img')
    const source = img && chatSource(img.closest(CHAT_ROW))
    if (source) operations.push({ kind: 'image', async read() {
      return { kind: 'image', blob: await chatImage(document, img), source: stamp(source, context.sessionId) }
    } })
    if (!operations.length) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const anchor = node.getBoundingClientRect()
    openMenu({ x: event.clientX || anchor.left, y: event.clientY || anchor.bottom }, node, context, operations)
  }

  function guestContextMenu(guest, event) {
    const settings = event.params
    const bounds = visibleBox(guest)
    const context = resolveContext(guest)
    const url = guestAddress(guest) || httpUrl(settings?.pageURL)
    if (!bounds || !context || !settings || !url) return
    const source = { origin: 'web', title: guestTitle(guest, url), url, frameUrl: httpUrl(settings.frameURL) }
    const operations = []
    const text = settings.formControlType === 'input-password' ? '' : settings.selectionText?.trim()
    if (text) operations.push({ kind: 'text', read: () => ({ kind: 'text', text, source: stamp(source, context.sessionId) }) })
    if (typeof guest.capturePage === 'function') {
      operations.push({ kind: 'region', region: guest, async read(area) {
        if (guestAddress(guest) !== url) throw new Error(t('网页已跳转，请重新框选。'))
        const crop = sourceCrop(area, guest.getBoundingClientRect())
        const blob = nativeScreenshotBlob(await guest.capturePage(crop), view)
        if (guestAddress(guest) !== url) throw new Error(t('截图期间网页已跳转，请重试。'))
        return { kind: 'image', blob, source: stamp(source, context.sessionId) }
      } })
    }
    if (!operations.length) return
    event.preventDefault?.()
    openMenu(guestMenuAnchor(settings, guest.getBoundingClientRect()), guest, context, operations)
  }

  function syncGuests() {
    for (const [guest, listener] of guests) {
      if (!guest.isConnected || !guest.matches(WEBVIEW)) {
        guest.removeEventListener('context-menu', listener)
        guests.delete(guest)
      }
    }
    for (const guest of document.querySelectorAll(WEBVIEW)) {
      if (guests.has(guest)) continue
      const listener = event => guestContextMenu(guest, event)
      guest.addEventListener('context-menu', listener)
      guests.set(guest, listener)
    }
  }

  function observeGuestChanges(records) {
    const matches = node => node.nodeType === 1 && (node.matches(WEBVIEW) || node.querySelector(WEBVIEW))
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(matches))) syncGuests()
  }

  syncGuests()
  const observer = new view.MutationObserver(observeGuestChanges)
  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('contextmenu', contextMenu, { capture: true, signal: lifetime.signal })
  return () => {
    lifetime.abort()
    observer.disconnect()
    for (const [guest, listener] of guests) guest.removeEventListener('context-menu', listener)
    guests.clear()
    dismiss()
  }
}
