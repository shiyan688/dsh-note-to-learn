import { t } from './i18n.js'
const OVERLAY_SLOT = 'conversation.input.overlay'
const FILE_TARGET = '[data-composer-input][contenteditable="true"]'
const HIDDEN = '[hidden], [inert], [aria-hidden="true"]'
const PNG = 'image/png'
const GHOST_CLASS = 'ntl-composer-ghost'
const GHOST_CONTENT = '--ntl-composer-ghost'

function composerEditor(binding) {
  return binding.marker.current.closest('[data-composer-card]')?.querySelector(FILE_TARGET)
}

function isPlaceholder(node) {
  return (node?.nodeType === 3 && node.length === 0) ||
    (node?.nodeName === 'BR' && (node.hasAttribute('data-lexical-managed-linebreak') || node.parentNode.childNodes.length === 1))
}

function isComposerEnd(editor, selection) {
  if (!selection?.isCollapsed || !selection.rangeCount) return false
  const range = selection.getRangeAt(0)
  let node = range.endContainer
  if (!editor.contains(node)) return false
  if (node.nodeType === 3 && range.endOffset !== node.length) return false
  if (node.nodeType !== 3 && [...node.childNodes].slice(range.endOffset).some(child => !isPlaceholder(child))) return false
  while (node !== editor) {
    for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
      if (!isPlaceholder(sibling)) return false
    }
    node = node.parentNode
  }
  return true
}

function focusComposerEnd(document, editor) {
  editor.focus({ preventScroll: true })
  const tail = editor.lastElementChild || editor
  let offset = tail.childNodes.length
  while (offset > 0 && isPlaceholder(tail.childNodes[offset - 1])) offset--
  document.getSelection()?.collapse(tail, offset)
}

function nativeCompletionIsOpen(editor) {
  const card = editor.closest('[data-composer-card]')
  return editor.hasAttribute('data-composer-composing') ||
    !!editor.style.getPropertyValue('--dsh-composer-hint') ||
    !!card?.querySelector('[data-trigger-menu], [aria-haspopup="listbox"][aria-expanded="true"]')
}

function canFocusComposer(document, editor) {
  return !editor.closest(HIDDEN) && editor.getAttribute('aria-disabled') !== 'true' &&
    !nativeCompletionIsOpen(editor) && ![...document.querySelectorAll('dialog[open], [aria-modal="true"]')]
      .some(modal => !modal.closest(HIDDEN) && modal.getClientRects().length > 0)
}

export function sourceLabel(source) {
  if (!source) return ''
  const fileName = source.path?.split(/[\\/]/u).filter(Boolean).at(-1)
  const label = fileName || source.title || source.url || ''
  const location = source.url && source.url !== label ? ' (' + source.url + ')' : ''
  const pages = source.page ? t('，第 {0} 页', source.endPage > source.page ? `${source.page}–${source.endPage}` : source.page) : ''
  return label + location + pages
}

function insertQuote(binding, text, source) {
  const title = sourceLabel(source)
  const details = title ? t('来源：') + title + '\n\n' : ''
  const summary = title ? { label: source?.title || title, title, body: text } : undefined
  return binding.inputActions.insertQuote(details + text, summary)
}

function pasteImage(document, target, file) {
  const view = document.defaultView
  const transfer = new view.DataTransfer()
  transfer.items.add(file)
  const event = new view.ClipboardEvent('paste', {
    clipboardData: transfer, bubbles: true, cancelable: true, composed: true,
  })
  // Dispatch at the exact Composer editor. Its native paste command passes
  // the File through the same validation and attachment intake as onAddFiles.
  target.dispatchEvent(event)
  if (!event.defaultPrevented) throw new Error(t('当前 DSH 输入框无法接收图片。'))
}

function availableBinding(bindings, sessionId) {
  const visible = [...(bindings.get(sessionId) || [])].filter(binding => {
    const node = binding.marker.current
    return node?.isConnected && !node.parentElement?.closest(HIDDEN)
  })
  return visible.find(binding => !binding.marker.current.closest('[data-sidebar-right-tab]')) || visible[0]
}

/** Bind to the native draft UI through DSH's session-scoped Composer slot. */
export function createDraftBridge(ctx, { React, document, getSessionId = () => ctx.sidebarRight.mounted.getSnapshot() }) {
  const bindings = new Map()
  const pending = new Set()
  let disposed = false
  let suggestion

  function ComposerBinding(props) {
    const marker = React.useRef(null)
    const live = React.useRef(null)
    const attachmentIds = props.useInput(state => state.attachmentIds)
    const draftRev = props.useInput(state => state.draftRev)
    const phase = props.useInput(state => state.phase)
    const canUpload = props.useAccess('fileUploads/upload')
    const removed = props.useSession(state => state.removed)
    const { sessionId, inputActions } = props
    if (live.current === null) live.current = { marker, sessionId }
    const binding = live.current

    React.useLayoutEffect(() => {
      let list = bindings.get(sessionId)
      if (!list) bindings.set(sessionId, list = new Set())
      list.add(binding)
      return () => {
        if (suggestion?.binding === binding) clearSuggestion()
        list.delete(binding)
        if (!list.size) bindings.delete(sessionId)
      }
    }, [binding, sessionId])

    React.useLayoutEffect(() => {
      Object.assign(binding, { inputActions, attachmentIds, canUpload, removed, draftRev, phase })
      for (const observe of pending) observe()
      if (suggestion?.binding === binding) refreshSuggestion()
    }, [binding, inputActions, attachmentIds, canUpload, removed, draftRev, phase])

    return React.createElement('span', { ref: marker, hidden: true, 'aria-hidden': 'true' })
  }

  const off = ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
    name: OVERLAY_SLOT,
    id: 'dsh-note-to-learn-draft-bridge',
  }, ComposerBinding))

  function getBinding(sessionId) {
    if (disposed || !sessionId || getSessionId() !== sessionId) {
      throw new Error(t('当前会话已切换，请重新添加资料。'))
    }
    const binding = availableBinding(bindings, sessionId)
    if (!binding?.inputActions || binding.removed) {
      throw new Error(t('请先打开需要添加资料的 DSH 对话。'))
    }
    return binding
  }

  function paintSuggestion(current, text) {
    const { editor } = current
    if (text) {
      const tail = editor.lastElementChild || editor
      editor.classList.add(GHOST_CLASS)
      editor.toggleAttribute('data-ntl-ghost-blank-line', [...tail.childNodes].every(isPlaceholder))
      editor.style.setProperty(GHOST_CONTENT, JSON.stringify(text.replace(/[\s\x00-\x1f\x7f]/gu, ' ')))
    } else if (editor.classList.contains(GHOST_CLASS)) {
      editor.classList.remove(GHOST_CLASS)
      editor.removeAttribute('data-ntl-ghost-blank-line')
      editor.style.removeProperty(GHOST_CONTENT)
    }
  }

  function clearSuggestion(sessionId) {
    const current = suggestion
    if (!current || (sessionId !== undefined && current.sessionId !== sessionId)) return
    suggestion = undefined
    current.cleanup?.()
    paintSuggestion(current)
  }

  function refreshSuggestion() {
    const current = suggestion
    if (!current) return
    const { binding, editor, sessionId, revision, text } = current
    if (!editor.isConnected || getSessionId() !== sessionId || binding.removed ||
      binding.draftRev !== revision || binding.phase !== 'plain') {
      clearSuggestion()
      return
    }
    if (document.activeElement !== editor || !canFocusComposer(document, editor) ||
      !isComposerEnd(editor, document.getSelection())) {
      paintSuggestion(current)
      return
    }
    const span = binding.inputActions.captureInsertion()
    if (span.start !== span.end || span.draftRev !== revision) {
      paintSuggestion(current)
      return
    }
    const lastLine = editor.lastElementChild || editor
    const nonempty = span.start > 0 && [...lastLine.childNodes].some(node => !isPlaceholder(node))
    const append = nonempty ? ' ' + text : text
    paintSuggestion(current, append)
    return { span, append }
  }

  function suggest(text, sessionId, { focus = true } = {}) {
    const value = typeof text === 'string' ? text.replace(/\r\n?/gu, '\n').trim() : ''
    if (!value || disposed || getSessionId() !== sessionId) return false
    const binding = availableBinding(bindings, sessionId)
    if (!binding?.inputActions || binding.removed || binding.phase !== 'plain' ||
      binding.marker.current.closest('[data-sidebar-right-tab]')) return false
    const editor = composerEditor(binding)
    if (!editor || !canFocusComposer(document, editor)) return false
    clearSuggestion()
    const view = document.defaultView
    const lifetime = new view.AbortController()
    const options = { signal: lifetime.signal }
    const current = { binding, editor, sessionId, revision: binding.draftRev, text: value }
    suggestion = current

    for (const event of ['beforeinput', 'input', 'paste', 'cut', 'compositionstart', 'blur']) {
      editor.addEventListener(event, () => clearSuggestion(sessionId), { ...options, capture: true })
    }
    document.addEventListener('selectionchange', refreshSuggestion, options)
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') clearSuggestion(sessionId)
    }, { ...options, capture: true })
    // Native DSH/Lexical completion gets this keyboard event at the editor first.
    document.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || event.defaultPrevented || event.repeat || event.isComposing ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        event.target !== editor || !editor.classList.contains(GHOST_CLASS)) return
      const insertion = refreshSuggestion()
      if (!insertion) return
      clearSuggestion(sessionId)
      if (binding.inputActions.insertText(insertion.append, insertion.span)) event.preventDefault()
    }, options)
    const observer = new view.MutationObserver(refreshSuggestion)
    observer.observe(editor.closest('[data-composer-card]'), {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['aria-expanded', 'contenteditable', 'data-composer-composing', 'aria-disabled'],
    })
    const offSession = ctx.sidebarRight?.mounted?.subscribe(refreshSuggestion)
    current.cleanup = () => {
      lifetime.abort()
      observer.disconnect()
      offSession?.()
    }
    if (focus && (document.activeElement !== editor || !isComposerEnd(editor, document.getSelection()))) {
      focusComposerEnd(document, editor)
    }
    refreshSuggestion()
    return suggestion === current
  }

  function waitForAttachment(binding, target, file, sessionId) {
    const previousIds = new Set(binding.attachmentIds)
    return new Promise((resolve, reject) => {
      let timer
      function settle(error) {
        if (!pending.delete(observe)) return
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      function observe() {
        try {
          const current = getBinding(sessionId)
          if (current.attachmentIds?.some(id => !previousIds.has(id))) settle()
        } catch (error) { settle(error) }
      }
      pending.add(observe)
      timer = setTimeout(() => settle(new Error(t('图片未加入草稿，请检查 DSH 的图片限制或重试。'))), 1200)
      try { pasteImage(document, target, file) } catch (error) { settle(error) }
      observe()
    })
  }

  async function prepareTextInsertion(binding, sessionId) {
    const editor = composerEditor(binding)
    if (!editor?.focus || document.activeElement === editor) return binding.inputActions.captureInsertion()
    if (!canFocusComposer(document, editor)) throw new Error(t('当前输入框暂不可编辑，请稍后重试。'))
    const before = binding.inputActions.captureInsertion()
    focusComposerEnd(document, editor)
    const frame = document.defaultView.requestAnimationFrame.bind(document.defaultView)
    // Lexical tracks a DOM selection change on its own event cycle.
    await new Promise(resolve => frame(() => frame(resolve)))
    const current = getBinding(sessionId).inputActions.captureInsertion()
    if (current.draftRev !== before.draftRev || current.start !== current.end ||
      document.activeElement !== editor || !isComposerEnd(editor, document.getSelection())) {
      throw new Error(t('草稿或光标位置已变化，请重新添加资料。'))
    }
    return current
  }

  async function add(clip, sessionId, { quote = true } = {}) {
    const binding = getBinding(sessionId)
    clearSuggestion(sessionId)
    if (clip.kind === 'text') {
      if (!clip.text?.trim()) throw new Error(t('没有可加入对话的文字。'))
      const span = await prepareTextInsertion(binding, sessionId)
      const current = getBinding(sessionId)
      const accepted = quote
        ? insertQuote(current, clip.text.trim(), clip.source)
        : current.inputActions.insertText(clip.text, span.start === span.end ? span : { ...span, start: span.end })
      if (!accepted) throw new Error(t('当前草稿暂不可编辑，请稍后重试。'))
      return
    }
    if (clip.kind !== 'image' || !clip.blob?.size) throw new Error(t('没有可加入对话的图片。'))
    if (!binding.canUpload) throw new Error(t('当前会话不允许接收图片附件。'))
    const target = composerEditor(binding)
    if (!target) throw new Error(t('当前输入框暂不可编辑，请稍后重试。'))
    const name = clip.blob.type === PNG ? t('学习截图.png') : (clip.blob.name || t('学习图片'))
    const file = new document.defaultView.File([clip.blob], name, { type: clip.blob.type || PNG })
    await waitForAttachment(binding, target, file, sessionId)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    clearSuggestion()
    off?.()
    for (const observe of pending) observe()
    bindings.clear()
  }
  return { add, suggest, clearSuggestion, dispose }
}

export function pdfResourceAddress(sessionId, path) {
  const encode = segment => encodeURIComponent(segment).replaceAll('%3A', ':')
  const escaped = path.replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '').split('/').map(encode).join('/')
  return 'dsh-resource://file/session/' + encode(sessionId) + '/' + escaped
}

function comparablePath(path) {
  const normalized = path.replaceAll('\\', '/')
  return /^[a-z]:\/|^\/\//iu.test(normalized) ? normalized.toLowerCase() : normalized
}

/** Reveal the native file tab and, after its own preview mounts, scroll to a captured page. */
export async function openPdfSource(sidebar, document, sessionId, source) {
  if (!source?.path) throw new Error(t('这条资料没有可打开的 PDF 路径。'))
  if (sidebar.mounted.getSnapshot() !== sessionId) throw new Error(t('请在原工作区的会话中打开 PDF。'))
  sidebar.openResource(pdfResourceAddress(sessionId, source.path))
  if (!source.page) return
  const view = document.defaultView
  const expected = comparablePath(source.path)
  const canceled = t('当前会话已切换。')
  return new Promise((resolve, reject) => {
    let timer
    const observer = new view.MutationObserver(findPage)

    function stop(error) {
      observer.disconnect()
      view.clearTimeout(timer)
      if (error) reject(new Error(error))
      else resolve()
    }
    function findPage() {
      if (sidebar.mounted.getSnapshot() !== sessionId) return stop(canceled)
      for (const preview of document.querySelectorAll('[data-document-preview]')) {
        const owner = preview.closest('[data-sidebar-right-session]')
        const label = preview.querySelector('[data-textpreview-path]')?.getAttribute('title')
        if (owner?.getAttribute('data-sidebar-right-session') !== sessionId ||
          preview.closest(HIDDEN) || !label || comparablePath(label) !== expected) continue
        const page = [...preview.querySelectorAll('[data-pdf-page]')].find(item => Number(item.dataset.pdfPage) === source.page)
        if (!page) continue
        page.scrollIntoView({ block: 'start', inline: 'nearest' })
        return stop()
      }
    }

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'title'] })
    timer = view.setTimeout(() => stop(t('PDF 已发起打开，但未能定位到记录的页码。')), 5000)
    findPage()
  })
}
