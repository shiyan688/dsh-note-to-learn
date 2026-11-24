import { getLanguage, subscribeLanguage, t } from './i18n.js'
import { installCapture } from './capture.js'
import { createDraftBridge, openPdfSource, sourceLabel } from './dsh.js'
import { createLibrary } from './library-client.js'
import { mountNotebook } from './notebook-view.js'
import { button, element as el, openDialog, toast } from './note-ui.js'
import { suggestQuestion } from './suggestions.js'
import paperCss from './paper.css'
import clientCss from './client.css'

const name = 'dsh-note-to-learn'

function prepareAssistantClip(material) {
  if (material.kind !== 'text' || material.source?.role !== 'assistant') return material
  const markdown = material.markdown || material.text
  return { ...material, text: markdown, markdown, layout: 'auto', originalText: material.text }
}

function previewNotePlacement(materials) {
  const draft = materials.map(prepareAssistantClip)
  return openDialog(t('添加到学习笔记'), ({ body, actions, leave }) => {
    const urls = new Set()
    const list = el('div', { className: 'ntl-materials' })
    const cancel = button(t('取消'), () => leave())
    const accept = button(t('选择放置位置'), () => {
      if (draft.length) leave(draft)
    }, { className: 'ntl-primary' })
    const cleanup = () => { for (const url of urls) URL.revokeObjectURL(url) }
    function draw() {
      cleanup()
      urls.clear()
      list.replaceChildren()
      accept.disabled = draft.length === 0
      draft.forEach((material, index) => {
        const materialTitle = sourceLabel(material.source) || (material.kind === 'image' ? t('图片') : t('文字'))
        const action = button(t('移除'), () => { draft.splice(index, 1); draw() }, { 'aria-label': t('移除第 {0} 项', index + 1) })
        const card = el('div', { className: 'ntl-material' }, el('div', { className: 'ntl-dialog-row' }, el('strong', {}, materialTitle), action))
        if (material.kind === 'image') {
          const src = material.blob ? URL.createObjectURL(material.blob) : material.dataUrl
          if (material.blob) urls.add(src)
          card.append(el('img', { src, alt: material.name ?? t('选区截图') }))
        } else if (material.kind === 'text') {
          const text = el('textarea', { rows: Math.min(10, Math.max(3, (material.text.match(/\n/g)?.length ?? 0) + 2)), value: material.text, 'aria-label': t('第 {0} 项摘录', index + 1) })
          text.addEventListener('input', () => { material.text = text.value; if (material.markdown !== undefined) material.markdown = text.value })
          card.append(text)
        }
        list.append(card)
      })
    }
    body.closest('dialog').addEventListener('close', cleanup, { once: true })
    body.append(list)
    actions.append(cancel, accept)
    draw()
  })
}

function mountPlugin(ctx, React) {
  const h = React.createElement
  const libraries = new Map()
  const pending = new Map()
  const listeners = new Map()
  const draftQueue = new Map()
  const getSessionId = () => ctx.sidebarRight.mounted.getSnapshot()
  const bridge = createDraftBridge(ctx, { React, document, getSessionId })
  const report = message => toast(message?.message ?? String(message), true)
  const needActive = sessionId => {
    if (!sessionId || getSessionId() !== sessionId) throw new Error(t('当前会话已切换，请重新选择材料。'))
  }

  function setPending(sessionId, items) {
    if (items.length) pending.set(sessionId, items)
    else pending.delete(sessionId)
    for (const listener of listeners.get(sessionId) ?? []) listener()
  }
  function subscribePending(sessionId, listener) {
    const subscriptions = listeners.get(sessionId) ?? new Set()
    subscriptions.add(listener)
    listeners.set(sessionId, subscriptions)
    return () => {
      subscriptions.delete(listener)
      if (!subscriptions.size) listeners.delete(sessionId)
    }
  }
  function openWeb(url) {
    const address = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
      throw new Error(t('请输入 HTTP 或 HTTPS 网页地址。'))
    }
    ctx.sidebarRight.openTab('browser', { params: { url: address.href }, preferNewPane: true })
  }
  function openNotes() {
    if (!getSessionId()) { toast(t('请先打开一个 DSH 会话。'), true); return }
    ctx.sidebarRight.openTab(name)
  }

  function queueDraft(materials, sessionId) {
    needActive(sessionId)
    const previous = draftQueue.get(sessionId)
    const clips = materials.filter(item => item.kind !== 'text' || item.text.trim())
    if (!clips.length) throw new Error(t('请选择有内容的文字或图片。'))
    const operation = { completion: undefined }
    bridge.clearSuggestion(sessionId)
    operation.completion = (previous?.completion ?? Promise.resolve()).then(async () => {
      const added = []
      try {
        for (const clip of clips) {
          needActive(sessionId)
          await bridge.add(clip, sessionId, { quote: clip.editableDraft !== true })
          added.push(clip)
        }
        toast(added.length === 1 ? t('已加入当前草稿。') : t('已加入 {0} 项材料。', added.length))
      } catch (cause) {
        if (added.length) toast(t('已加入 {0} 项材料。', added.length))
        report(cause)
      } finally {
        if (draftQueue.get(sessionId) === operation) {
          draftQueue.delete(sessionId)
          if (added.length && getSessionId() === sessionId) {
            const question = added.find(clip => typeof clip.suggestedQuestion === 'string')?.suggestedQuestion
            bridge.suggest(question ?? suggestQuestion(added), sessionId)
          }
        }
      }
    }).catch(report)
    draftQueue.set(sessionId, operation)
    return operation.completion
  }

  async function useMaterials(materials, action, sessionId) {
    try {
      needActive(sessionId)
      if (action === 'context') return await queueDraft(materials, sessionId)
      const choice = await previewNotePlacement(materials)
      if (!choice) return
      needActive(sessionId)
      const clips = choice.filter(item => item.kind !== 'text' || item.text.trim())
      if (!clips.length) throw new Error(t('请保留一项文字或图片。'))
      setPending(sessionId, [...(pending.get(sessionId) ?? []), ...clips])
      openNotes()
    } catch (cause) { report(cause) }
  }

  function Tab(props) {
    const { sessionId } = props
    const container = React.useRef(null)
    const lastPage = React.useRef(null)
    const language = React.useSyncExternalStore(subscribeLanguage, getLanguage)
    const workspace = props.useSessions(state => state.byId[sessionId]?.cwd)
    React.useEffect(() => {
      if (!container.current || !workspace) return undefined
      if (!libraries.has(workspace)) libraries.set(workspace, createLibrary(workspace))
      return mountNotebook(container.current, {
        library: libraries.get(workspace), preview: (materials, action) => useMaterials(materials, action, sessionId),
        startupPageId: lastPage.current?.sessionId === sessionId && lastPage.current.workspace === workspace ? lastPage.current.pageId : undefined,
        onPageChange: pageId => { lastPage.current = { sessionId, workspace, pageId } },
        getPending: () => pending.get(sessionId) ?? [], setPending: items => setPending(sessionId, items),
        subscribePending: listener => subscribePending(sessionId, listener),
        openWeb(url) { needActive(sessionId); openWeb(url) },
        openSource(source) {
          needActive(sessionId)
          return source.path ? openPdfSource(ctx.sidebarRight, document, sessionId, source) : openWeb(source.url)
        },
      })
    }, [sessionId, workspace, language])
    return h('div', { className: 'ntl-host', ref: container }, workspace ? null : t('请先打开 DSH 工作区。'))
  }

  ctx.effect(() => {
    const styles = el('style', { 'data-dsh-note-to-learn': '' }, clientCss, paperCss)
    document.head.append(styles)
    const dispose = installCapture({
      document,
      getContext() { const sessionId = getSessionId(); return sessionId ? { sessionId } : undefined },
      onClip(clip, action, context) { return useMaterials([clip], action, context.sessionId) },
      reportError: report,
    })
    return () => { dispose(); bridge.dispose(); styles.remove() }
  })
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: name, kind: name, title: () => t('学习笔记'),
    guide: [{ id: name, order: 40, title: () => t('学习笔记') }],
  }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: name }, Tab))
  function Launcher() {
    React.useSyncExternalStore(subscribeLanguage, getLanguage)
    return h('button', { className: 'ntl-launch', type: 'button', onClick: () => { try { openNotes() } catch (cause) { report(cause) } } }, t('学习笔记'))
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: name, order: 48, label: () => t('学习笔记') }, Launcher))
}

window.__ModuleLoader__.load({
  id: name,
  factory(require) {
    const React = require('react')
    return { name, inject: ['slots', 'sidebarRight', 'sidebarRightTabs'], apply: ctx => mountPlugin(ctx, React) }
  },
})
