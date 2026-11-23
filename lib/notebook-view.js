import { getLanguage, setLanguage, t } from './i18n.js'
import { zipSync, strToU8 } from 'fflate'
import { dataUrl, download, makePdf, readPdf } from './documents.js'
import { button, chooseDialog, confirmDialog, element as el, inputDialog, openDialog, pickFile, toast } from './note-ui.js'
import { copyPage, exportPageMarkdown, importPageMarkdown, movePage, searchPages } from './notebooks.js'
import { exportPaperPage, mountPaper } from './paper.js'

const id = () => crypto.randomUUID()
const active = entries => entries.filter(entry => !entry.deletedAt)
const notebookRoot = (title, notebookId = id()) => ({ id: notebookId, title })
const sectionRoot = (title, notebookId, kind = 'section', parentId = null) => ({ id: id(), notebookId, title, parentId, kind })
const blank = (sectionId, title, parentId = null) => ({ id: id(), sectionId, title, parentId, tags: [], blocks: [], strokes: [] })

export function mountNotebook(root, { library, preview, getPending, setPending, openSource, openWeb, subscribePending, startupPageId, onPageChange }) {
  root.classList.add('ntl-notebook')
  const view = root.ownerDocument.defaultView
  const lifetime = new view.AbortController()
  const toolbar = el('div', { className: 'ntl-workspace-bar' })
  const grid = el('div', { className: 'ntl-workspace-grid' })
  const navigation = el('nav', { id: `ntl-library-${id()}`, className: 'ntl-library', 'aria-label': t('笔记目录') })
  const body = el('section', { className: 'ntl-document' })
  const titlebar = el('div', { className: 'ntl-pagebar' })
  const paperRoot = el('div', { className: 'ntl-paper-root' })
  const placement = el('div', { className: 'ntl-placement', hidden: '' })
  const status = el('div', { className: 'ntl-status', role: 'status', 'aria-atomic': 'true' })
  const paperControls = el('div', { className: 'ntl-paper-controls' })
  const footer = el('footer', { className: 'ntl-workspace-footer' }, status, paperControls)
  const navigationToggle = button(el('span', { 'aria-hidden': 'true', className: 'ntl-icon-library' }), () => {
    setLibraryVisible(navigation.hidden)
    if (!compact) wideLibraryVisible = !navigation.hidden
    if (compact && !navigation.hidden) {
      const search = navigation.querySelector('input')
      if (search) search.focus({ preventScroll: true })
    }
  }, { className: 'ntl-icon-button', 'aria-label': t('切换笔记目录'), 'aria-controls': navigation.id, title: t('切换笔记目录') })
  const languagePicker = el('select', { className: 'ntl-language', 'aria-label': '语言 / Language' },
    el('option', { value: 'zh-CN', lang: 'zh-CN' }, '简体中文'),
    el('option', { value: 'en', lang: 'en' }, 'English'))
  languagePicker.value = getLanguage()
  languagePicker.addEventListener('change', () => setLanguage(languagePicker.value))
  grid.append(navigation, body)
  body.append(titlebar, placement, paperRoot)
  root.replaceChildren(toolbar, grid, footer)
  let notebookId, sectionId, pageId, paper, mountedPage
  let compact
  let wideLibraryVisible = true
  let query = ''
  let dragId
  let alive = true
  let importing = false
  let applying = false
  let busy = ''

  function setLibraryVisible(visible) {
    const hidesFocus = (!visible && navigation.contains(document.activeElement)) ||
      (compact && visible && body.contains(document.activeElement))
    navigation.hidden = !visible
    body.hidden = Boolean(compact && visible)
    paperControls.hidden = body.hidden
    root.dataset.library = visible ? 'open' : 'closed'
    navigationToggle.setAttribute('aria-expanded', String(visible))
    if (hidesFocus) navigationToggle.focus({ preventScroll: true })
  }

  function layout() {
    const width = root.clientWidth
    if (!width) return
    const narrow = width < 590
    if (compact === narrow) return
    compact = narrow
    root.dataset.layout = compact ? 'compact' : 'wide'
    setLibraryVisible(!compact && wideLibraryVisible)
  }
  const layoutObserver = new view.ResizeObserver(layout)
  layoutObserver.observe(root)
  layout()

  document.addEventListener('pointerdown', event => {
    for (const open of root.querySelectorAll('details[data-ntl-menu][open]')) {
      if (!open.contains(event.target)) open.open = false
    }
  }, { capture: true, signal: lifetime.signal })
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    const open = root.querySelector('details[data-ntl-menu][open]')
    if (open) {
      open.open = false
      open.querySelector('summary').focus({ preventScroll: true })
    } else if (compact && !navigation.hidden) {
      setLibraryVisible(false)
      navigationToggle.focus({ preventScroll: true })
    } else return
    event.preventDefault()
    event.stopPropagation()
  }, { capture: true, signal: lifetime.signal })

  const showError = cause => toast(cause?.message ?? String(cause), true)
  const run = action => async event => {
    try { await action(event) } catch (cause) { if (alive) showError(cause) }
  }
  const savePage = (next, structure = false) => library.edit(state => ({
    ...state,
    pages: state.pages.map(page => {
      if (page.id !== next.id || page.deletedAt) return page
      if (structure) return next
      const { blocks, strokes, width, height } = next
      return { ...page, blocks, strokes, width, height }
    }),
  }), root, structure)
  const selected = () => library.data?.pages.find(page => page.id === pageId && !page.deletedAt)

  function select(page) {
    if (!page) return
    const section = library.data?.sections.find(item => item.id === page.sectionId)
    if (section) notebookId = section.notebookId
    sectionId = page.sectionId
    pageId = page.id
    query = ''
    const fromCompactLibrary = compact && !navigation.hidden
    if (fromCompactLibrary) setLibraryVisible(false)
    renderNavigation()
    renderPage(true)
    if (fromCompactLibrary) titlebar.querySelector('h2')?.focus({ preventScroll: true })
  }

  const addNotebook = async () => {
    const title = await inputDialog(t('新建笔记本'), t('笔记本名称'))
    if (!title || !alive) return
    const notebook = notebookRoot(title)
    const section = sectionRoot(t('常规'), notebook.id)
    const page = blank(section.id, t('无标题笔记'))
    library.edit(state => ({ ...state, notebooks: [...state.notebooks, notebook], sections: [...state.sections, section], pages: [...state.pages, page] }), root)
    select(page)
  }

  function ensureSection(state, newSections, newNotebooks) {
    if (sectionId && active(state.sections).some(section => section.id === sectionId && section.kind !== 'group')) return sectionId
    const notebook = active(state.notebooks).find(entry => entry.id === notebookId) ?? active(state.notebooks)[0] ?? notebookRoot(t('学习笔记'))
    if (!state.notebooks.includes(notebook)) newNotebooks.push(notebook)
    const section = sectionRoot(t('常规'), notebook.id)
    newSections.push(section)
    return section.id
  }

  const addSection = async (kind, parentId = null) => {
    if (!notebookId) return addNotebook()
    const title = await inputDialog(kind === 'group' ? t('新建分区组') : t('新建分区'), t('名称'))
    if (!title || !alive) return
    const section = sectionRoot(title, notebookId, kind, parentId)
    library.edit(state => ({ ...state, sections: [...state.sections, section] }), root)
    sectionId = section.id
    pageId = undefined
    renderNavigation()
    renderPage(true)
  }

  const addPage = async (parentId = null) => {
    const title = await inputDialog(parentId ? t('新建子页') : t('新建页面'), t('页面标题'), t('无标题笔记'))
    if (!title || !alive) return
    let page
    library.edit(state => {
      const sections = [...state.sections], notebooks = [...state.notebooks]
      page = blank(ensureSection(state, sections, notebooks), title, parentId)
      return { ...state, sections, notebooks, pages: [...state.pages, page] }
    }, root)
    select(page)
  }

  const rename = async (kind, entry) => {
    const title = await inputDialog(t('重命名'), t('名称'), entry.title)
    if (title && alive) library.edit(state => ({ ...state, [kind]: state[kind].map(item => item.id === entry.id ? { ...item, title } : item) }), root)
  }

  const trash = async (kind, entry) => {
    if (!await confirmDialog(t('移到回收站'), t('将「{0}」移到回收站？', entry.title), t('移到回收站')) || !alive) return
    library.edit(state => ({ ...state, [kind]: state[kind].map(item => item.id === entry.id ? { ...item, deletedAt: new Date().toISOString() } : item) }), root)
  }

  const recycleBin = () => openDialog(t('回收站'), ({ body: content, actions, leave }) => {
    const removed = ['notebooks', 'sections', 'pages'].flatMap(kind => library.data[kind].filter(entry => entry.deletedAt).map(entry => [kind, entry]))
    if (!removed.length) content.append(el('p', {}, t('回收站为空。')))
    for (const [kind, entry] of removed) content.append(el('div', { className: 'ntl-dialog-row' }, entry.title, button(t('恢复'), () => {
      library.edit(state => ({ ...state, [kind]: state[kind].map(item => item.id === entry.id ? { ...item, deletedAt: null } : item) }), root)
      leave()
    })))
    actions.append(button(t('关闭'), () => leave()))
  })

  const history = async page => {
    await library.save()
    const versions = await library.send('history', { query: { page: page.id } })
    if (!versions.length) { toast(t('此页暂无历史版本。')); return }
    const versionId = await chooseDialog(t('页面历史'), t('恢复到版本'), versions.map(item => [item.id, new Date(item.savedAt).toLocaleString(getLanguage())]))
    if (versionId && alive && await confirmDialog(t('恢复页面'), t('将「{0}」恢复到所选版本？当前版本仍在历史里。', page.title), t('恢复'))) {
      await library.restore('restore', { pageId: page.id, versionId })
    }
  }

  const changePageLocation = async (page, copy) => {
    const sections = active(library.data.sections).filter(section => section.kind !== 'group' && active(library.data.notebooks).some(n => n.id === section.notebookId))
    const target = await chooseDialog(copy ? t('复制页面') : t('移动页面'), t('选择分区'), sections.map(section => [section.id, `${library.data.notebooks.find(n => n.id === section.notebookId)?.title} / ${section.title}`]))
    if (!target || !alive) return
    const result = copy ? copyPage(library.data, page.id, { sectionId: target }) : { state: movePage(library.data, page.id, { sectionId: target }), pageId: page.id }
    library.edit(() => result.state, root)
    select(library.data.pages.find(item => item.id === result.pageId))
  }

  function reconcileSelection() {
    const data = library.data
    if (!data) return
    const notebooks = active(data.notebooks)
    if (!notebooks.some(item => item.id === notebookId)) notebookId = notebooks[0]?.id
    const sections = active(data.sections).filter(item => item.notebookId === notebookId)
    if (!sections.some(item => item.id === sectionId)) sectionId = sections.find(item => item.kind !== 'group')?.id
    const pages = searchPages(data, '', { notebookId, sectionId }).map(entry => entry.page)
    if (!pages.some(item => item.id === pageId)) pageId = pages[0]?.id
    if (!startupPageId) return
    const requested = searchPages(data, '').find(entry => entry.page.id === startupPageId)?.page
    startupPageId = undefined
    if (requested) select(requested)
  }

  function menu(name, entries, variant = '') {
    const label = el('span', { className: 'ntl-menu-label' }, name)
    const summary = el('summary', { title: name, 'aria-label': name }, label)
    const details = el('details', { className: `ntl-menu ${variant}`, 'data-ntl-menu': '' }, summary)
    details.append(el('div', { className: 'ntl-menu-items' }, ...entries.map(([text, action]) => button(text, run(() => {
      details.open = false
      summary.focus({ preventScroll: true })
      return action()
    })))))
    return details
  }

  function renderPageList(container) {
    if (!library.data) return
    if (query) {
      const matching = searchPages(library.data, query)
      container.append(...matching.map(({ page, section, notebook }) => button(
        el('span', { className: 'ntl-result' },
          el('span', { className: 'ntl-row-title', dir: 'auto' }, page.title),
          el('span', { className: 'ntl-result-path', dir: 'auto' }, `${notebook.title} / ${section.title}`)),
        () => select(page), { title: page.title, className: 'ntl-tree', 'data-ntl-nav-key': `page:${page.id}`, 'aria-current': page.id === pageId ? 'page' : null })))
      if (!matching.length) container.append(el('p', { className: 'ntl-muted' }, t('没有匹配页面。')))
      return
    }
    const pages = Map.groupBy(active(library.data.pages).filter(page => page.sectionId === sectionId), page => page.parentId ?? null)
    function add(parentId, depth = 0) {
      if (depth > 10) return
      for (const page of pages.get(parentId) ?? []) {
        const title = el('span', { className: 'ntl-row-title', dir: 'auto' }, page.title)
        const row = button(title, () => select(page), { className: 'ntl-tree ntl-page-row', 'data-ntl-nav-key': `page:${page.id}`, 'aria-current': page.id === pageId ? 'page' : null, draggable: 'true', title: page.title })
        row.style.setProperty('--ntl-indent', `${Math.min(depth, 5) * 12}px`)
        row.addEventListener('dragstart', event => { dragId = page.id; event.dataTransfer.setData('text/plain', page.id); event.dataTransfer.effectAllowed = 'move' })
        row.addEventListener('dragend', () => { dragId = undefined })
        row.addEventListener('dragover', event => { if (dragId && dragId !== page.id) event.preventDefault() })
        row.addEventListener('drop', run(event => {
          if (!dragId || dragId === page.id) return
          event.preventDefault()
          library.edit(state => movePage(state, dragId, { sectionId, parentId: page.parentId, beforeId: page.id }), root)
          dragId = undefined
        }))
        container.append(row)
        add(page.id, depth + 1)
      }
    }
    add(null)
  }

  function renderNavigation() {
    const data = library.data
    if (!data) { navigation.replaceChildren(); return }
    const scrollTop = navigation.querySelector('.ntl-nav-scroll')?.scrollTop ?? 0
    const focused = document.activeElement
    const focusKey = navigation.contains(focused) ? focused.dataset.ntlNavKey : null
    const books = active(data.notebooks)
    const book = books.find(entry => entry.id === notebookId)
    const search = el('input', { type: 'search', value: query, placeholder: t('搜索所有笔记'), 'aria-label': t('搜索所有笔记'), 'data-ntl-nav-key': 'search' })
    const pages = el('div', { className: 'ntl-pages' })
    const pagesLabel = el('div', { className: 'ntl-nav-label' })
    const bookPicker = el('select', { 'aria-label': t('笔记本'), 'data-ntl-nav-key': 'books' }, ...books.map(item => el('option', { value: item.id }, item.title)))
    bookPicker.value = book?.id ?? ''
    bookPicker.addEventListener('change', () => { notebookId = bookPicker.value; sectionId = pageId = undefined; reconcileSelection(); renderNavigation(); renderPage(true) })
    const sectionControls = []
    const sections = active(data.sections).filter(entry => entry.notebookId === notebookId)
    function addSections(parent = null, depth = 0) {
      if (depth > 8) return
      for (const section of sections.filter(item => (item.parentId ?? null) === parent)) {
        const title = el('span', { className: 'ntl-row-title', dir: 'auto' }, section.title)
        const row = button(title, () => {
          sectionId = section.id; pageId = undefined; reconcileSelection(); renderNavigation(); renderPage(true)
        }, { className: 'ntl-tree ntl-section-row', 'data-ntl-nav-key': `section:${section.id}`, 'data-kind': section.kind, 'aria-current': section.id === sectionId ? 'true' : null, title: section.title })
        row.style.setProperty('--ntl-indent', `${Math.min(depth, 5) * 10}px`)
        sectionControls.push(row)
        addSections(section.id, depth + 1)
      }
    }
    addSections()
    const currentSection = sections.find(item => item.id === sectionId)
    const bookMenu = [[t('新建笔记本'), addNotebook], [t('新建分区'), () => addSection('section', currentSection?.kind === 'group' ? currentSection.id : null)], [t('新建分区组'), () => addSection('group', currentSection?.kind === 'group' ? currentSection.id : null)]]
    if (book) bookMenu.push([t('重命名笔记本'), () => rename('notebooks', book)], [t('回收笔记本'), () => trash('notebooks', book)])
    if (currentSection) bookMenu.push([t('重命名分区'), () => rename('sections', currentSection)], [t('回收分区'), () => trash('sections', currentSection)])
    const sectionList = el('div', { className: 'ntl-sections-wrap' },
      el('div', { className: 'ntl-nav-label' }, t('分区')),
      el('div', { className: 'ntl-sections' }, ...sectionControls))
    const navScroll = el('div', { className: 'ntl-nav-scroll' }, sectionList, pagesLabel, pages)
    const updateResults = () => {
      sectionList.hidden = Boolean(query) || !sections.length
      pagesLabel.textContent = query ? t('搜索结果') : t('页面')
      pages.replaceChildren()
      renderPageList(pages)
    }
    search.addEventListener('input', () => {
      query = search.value.trim()
      navScroll.scrollTop = 0
      updateResults()
    })
    navigation.replaceChildren(el('div', { className: 'ntl-nav-head' },
      el('div', { className: 'ntl-bookpick' }, bookPicker, menu(t('管理'), bookMenu, 'ntl-menu-icon')),
      el('div', { className: 'ntl-search' }, search)), navScroll)
    updateResults()
    navScroll.scrollTop = scrollTop
    if (focusKey) navigation.querySelector(`[data-ntl-nav-key="${view.CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true })
  }

  async function requestPlacement() {
    const list = getPending()
    if (!list.length) return
    placement.hidden = false
    placement.replaceChildren(el('span', { className: 'ntl-placement-hint' }, t('点击纸面放置 {0} 项', list.length)),
      button(t('追加到页面'), run(() => dropMaterials()), { className: 'ntl-primary' }), button(t('取消'), () => setPending([])))
  }

  async function dropMaterials(point) {
    const materials = getPending()
    if (!materials.length || !paper || applying) return
    applying = true
    const destination = paper
    try {
      const ready = await Promise.all(materials.map(async item => item.kind === 'image' && !item.dataUrl && item.blob ? { ...item, dataUrl: await dataUrl(item.blob) } : item))
      if (paper !== destination) return
      await destination.insert(ready, point)
      setPending([])
    } finally { applying = false }
  }

  const onPlace = run(event => {
    if (!getPending().length || !paper?.matchesPaper(event.target)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    return dropMaterials(paper.pointFromEvent(event))
  })
  paperRoot.addEventListener('click', onPlace, true)

  const importContent = async (file, fromUrl) => {
    if (!file || !alive || importing) return
    importing = true
    let target
    try {
      const stem = file.name.replace(/\.[^.]+$/, '')
      if (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf') {
        const parts = await readPdf(file, (current, total) => { busy = t('正在导入 PDF {0}/{1}', current, total); renderStatus() })
        if (!alive) return
        library.edit(state => {
          const sections = [...state.sections], notebooks = [...state.notebooks]
          const destination = ensureSection(state, sections, notebooks)
          const collectionId = id()
          const pages = parts.map(part => ({ ...blank(destination, `${stem} · ${part.pageNumber}`), width: part.width, height: part.height,
            background: { ...part, collectionId, source: { title: file.name, page: part.pageNumber, url: fromUrl } } }))
          target = pages[0]
          return { ...state, sections, notebooks, pages: [...state.pages, ...pages] }
        }, root)
      } else {
        if (file.size > 2 * 1024 * 1024) throw new Error(t('请导入 2 MiB 以内的 Markdown 文件。'))
        const text = await file.text()
        if (!alive) return
        library.edit(state => {
          const sections = [...state.sections], notebooks = [...state.notebooks]
          target = importPageMarkdown(text, { id: id(), title: stem, sectionId: ensureSection(state, sections, notebooks) })
          return { ...state, sections, notebooks, pages: [...state.pages, target] }
        }, root)
      }
      if (target) { select(target); await library.save() }
    } finally { importing = false; busy = ''; renderStatus() }
  }

  const importUrl = async () => {
    const text = await inputDialog(t('打开在线 PDF'), t('HTTPS 链接'))
    if (!text) return
    const url = new URL(text)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(t('请输入可公开读取的 HTTPS PDF 链接。'))
    let response
    try { response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(30_000) }) }
    catch { throw new Error(t('站点未允许直接读取，或连接超时。可先在浏览器下载，再从本地导入。')) }
    if (!response.ok || !response.body) throw new Error(t('在线 PDF 下载失败。'))
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 36 * 1024 * 1024) throw new Error(t('请导入 36 MiB 以内的 PDF。'))
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const file = url.pathname.split('/').at(-1) || t('在线资料.pdf')
    await importContent(new File(chunks, file.endsWith('.pdf') ? file : `${file}.pdf`, { type: 'application/pdf' }), url.href)
  }

  const exportBackup = async () => {
    const data = library.data
    if (!data) return
    let backup
    if (library.error?.status === 409) backup = { format: 'dsh-note-to-learn-backup', version: 1, exportedAt: new Date().toISOString(), state: data }
    else { await library.save(); backup = await library.send('backup') }
    download(new Blob([JSON.stringify(backup)], { type: 'application/json' }), 'dsh-note-to-learn-backup.json')
  }

  const restoreBackup = async () => {
    const [file] = await pickFile('.json,application/json')
    if (!file || !alive || !await confirmDialog(t('恢复备份'), t('此操作会用备份替换当前工作区的笔记内容。'), t('恢复备份'))) return
    if (file.size > 128 * 1024 * 1024) throw new Error(t('备份文件超出 128 MiB。'))
    await library.restore('backup-restore', { backup: JSON.parse(await file.text()) })
  }

  const exportMarkdown = async page => {
    const pageImage = page.strokes?.length ? await dataUrl(await exportPaperPage(document, page)) : undefined
    const { markdown, attachments } = exportPageMarkdown(page, { pageImage })
    if (!attachments.length) { download(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${page.title}.md`); return }
    const content = { [t('笔记.md')]: strToU8(markdown) }
    for (const attachment of attachments) content[attachment.path] = new Uint8Array(await (await fetch(attachment.dataUrl)).arrayBuffer())
    download(new Blob([zipSync(content)], { type: 'application/zip' }), `${page.title}.zip`)
  }

  const exportPdf = async (pages, title) => {
    if (!pages.length) throw new Error(t('此分区没有可导出的页面。'))
    const pdf = await makePdf(pages, page => exportPaperPage(document, page))
    download(pdf, `${title}.pdf`)
  }

  const ocr = async page => {
    const lang = await chooseDialog(t('识别图像文字'), t('语言'), [['chi_sim', t('简体中文')], ['eng', t('英语')]])
    if (!lang || !alive || !paper) return
    const block = paper.getSelectionBlock()
    const clips = await paper.captureSelection().catch(() => [])
    const clip = clips.find(item => item.kind === 'image')
    const image = clip?.blob ?? (clip?.dataUrl ? await (await fetch(clip.dataUrl)).blob() : await paper.exportPage())
    busy = t('正在识别…'); renderStatus()
    try {
      const { text } = await library.send('ocr', { query: { lang }, blob: image })
      if (!text) { toast(t('未识别到文字。')); return }
      const current = library.data.pages.find(item => item.id === page.id && !item.deletedAt)
      if (current) savePage(block?.kind === 'image'
        ? { ...current, blocks: current.blocks.map(item => item.id === block.id ? { ...item, ocrText: text } : item) }
        : { ...current, ocrText: text }, true)
      await openDialog(t('识别结果'), ({ body: content, actions, leave }) => {
        const editable = el('textarea', { rows: 9, value: text, 'aria-label': t('识别出的文字') })
        content.append(editable)
        actions.append(button(t('关闭'), () => leave()), button(t('放到纸面'), () => {
          if (paper && pageId === page.id) { setPending([{ kind: 'text', text: editable.value, name: t('识别结果') }]); leave() }
        }, { className: 'ntl-primary' }))
      })
    } finally { busy = ''; renderStatus() }
  }

  function renderPage(force = false) {
    onPageChange?.(pageId)
    const page = selected()
    if (!page) {
      paper?.destroy()
      paper = undefined; mountedPage = undefined
      titlebar.replaceChildren()
      paperRoot.replaceChildren(el('div', { className: 'ntl-empty' },
        el('span', { className: 'ntl-empty-sheet', 'aria-hidden': 'true' }),
        el('h2', {}, t('这里还没有页面')),
        el('p', {}, getPending().length ? t('新建页面后即可放置摘录。') : t('创建页面，或从网页和 PDF 摘录内容。'))))
      placement.hidden = true
      return
    }
    if (mountedPage === page.id && !force) return
    const actions = [
      [t('重命名'), () => rename('pages', page)], [t('新建子页'), () => addPage(page.id)],
      [t('移动到分区'), () => changePageLocation(page, false)], [t('复制到分区'), () => changePageLocation(page, true)],
      [t('更改上级页面'), async () => {
        const siblings = active(library.data.pages).filter(item => item.id !== page.id && item.sectionId === page.sectionId)
        const parentId = await chooseDialog(t('移动为子页'), t('上级页面'), [['', t('移到顶层')], ...siblings.map(item => [item.id, item.title])])
        if (parentId !== undefined) library.edit(state => movePage(state, page.id, { sectionId: page.sectionId, parentId: parentId || null }), root)
      }],
      [t('插入笔记页链接'), async () => {
        const choices = active(library.data.pages).filter(item => item.id !== page.id)
        if (!choices.length) throw new Error(t('请先新建另一个页面。'))
        const target = await chooseDialog(t('插入笔记页链接'), t('目标页面'), choices.map(item => [item.id, item.title]))
        const linked = choices.find(item => item.id === target)
        if (linked && pageId === page.id) await paper.insert({ kind: 'text', text: linked.title, source: { pageId: linked.id, title: t('打开笔记页面') } })
      }],
      [t('编辑标签'), async () => {
        const text = await openDialog(t('编辑标签'), ({ body: content, actions, leave }) => {
          const input = el('input', { type: 'text', value: (page.tags ?? []).join('，'), 'aria-label': t('用逗号分隔标签') })
          content.append(el('label', {}, t('用逗号分隔标签'), input))
          actions.append(button(t('取消'), () => leave()), button(t('保存'), () => leave(input.value), { className: 'ntl-primary' }))
        })
        const current = selected()
        if (text !== undefined && current?.id === page.id) savePage({ ...current, tags: [...new Set(text.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))] }, true)
      }],
      [t('识别图片或扫描页文字'), () => ocr(page)], [t('页面历史'), () => history(page)],
      [t('导出此页 PDF'), () => exportPdf([selected()], page.title)], [t('导出分区 PDF'), () => exportPdf(active(library.data.pages).filter(item => item.sectionId === page.sectionId), library.data.sections.find(item => item.id === page.sectionId)?.title ?? t('笔记'))],
      [t('导出 Markdown'), () => exportMarkdown(selected())], [t('移到回收站'), () => trash('pages', page)],
    ]
    if (page.background?.text) actions.unshift([t('选取 PDF 本页文字'), async () => {
      const selection = await openDialog(t('选取 PDF 本页文字'), ({ body: content, actions, leave }) => {
        const input = el('textarea', { rows: 12, value: page.background.text, 'aria-label': t('PDF 本页文字') })
        content.append(input)
        actions.append(button(t('取消'), () => leave()), button(t('预览选区'), () => {
          const text = input.value.slice(input.selectionStart, input.selectionEnd).trim()
          if (text) leave(text)
          else toast(t('请先选中要引用的文字。'), true)
        }, { className: 'ntl-primary' }))
      })
      if (selection && alive) preview([{ kind: 'text', text: selection, source: page.background.source }], 'context')
    }])
    const section = library.data.sections.find(item => item.id === page.sectionId)
    const tags = (page.tags ?? []).map(tag => el('span', { className: 'ntl-tag', title: tag, dir: 'auto' }, tag))
    titlebar.replaceChildren(el('div', { className: 'ntl-page-heading' },
      section && el('div', { className: 'ntl-page-section', title: section.title, dir: 'auto' }, section.title),
      el('h2', { title: page.title, dir: 'auto', tabindex: '-1' }, page.title),
      tags.length ? el('div', { className: 'ntl-page-tags' }, ...tags) : null),
      menu(t('页面操作'), actions, 'ntl-page-menu'))
    if (mountedPage !== page.id) {
      paper?.destroy()
      paper = mountPaper(paperRoot, {
        page, controlsRoot: paperControls,
        onChange(next) { try { savePage(next) } catch (cause) { showError(cause) } },
        onAsk: materials => preview(materials, 'context'), onError: showError,
        onSource(source) {
          const linked = source.pageId && searchPages(library.data, '').find(item => item.page.id === source.pageId)?.page
          if (linked) { select(linked); return true }
          if (source.path || source.url) { Promise.resolve().then(() => openSource(source)).catch(showError); return true }
          toast(t('找不到关联页面。'), true)
          return true
        },
      })
      mountedPage = page.id
    } else paper.setPage(page)
    updatePlacement()
  }

  function renderStatus(update = {}) {
    const error = update.error ?? library.error
    languagePicker.disabled = importing || applying || Boolean(update.locked)
    const text = busy || (update.locked ? t('正在恢复…') : update.pending ? t('待保存') : library.data ? t('本地保存') : t('正在载入…'))
    status.dataset.state = error ? 'error' : busy || update.locked || !library.data ? 'busy' : update.pending ? 'pending' : 'saved'
    const items = [el('span', { className: 'ntl-status-label' }, text)]
    if (error) items.push(el('span', { className: 'ntl-error' }, error.message))
    if (error?.status === 409) items.push(button(t('下载本窗口副本'), run(exportBackup)), button(t('重载'), run(async () => {
      if (await confirmDialog(t('重新载入'), t('重载会用磁盘上的版本替换本窗口尚未保存的编辑。'), t('重载'))) await library.load(true)
    })))
    else if (error) items.push(button(t('重试'), run(() => library.data ? library.save() : library.load(true))))
    status.replaceChildren(...items)
  }

  function updatePlacement() {
    placement.hidden = !selected() || !getPending().length
    if (!placement.hidden) requestPlacement()
  }

  const unsubscribe = library.subscribe(update => {
    if (!alive) return
    if (update.structure) { reconcileSelection(); renderNavigation(); renderPage(true) }
    else if (update.source && update.source !== root && selected()) paper?.setPage(selected())
    renderStatus(update)
  }, { canRefresh: () => !applying && !importing && !paper?.isInteracting() && !navigation.contains(document.activeElement) })
  const unsubscribePending = subscribePending(updatePlacement)
  const refresh = () => {
    if (document.visibilityState !== 'visible' || !root.getClientRects().length) return
    library.refresh().catch(() => {})
  }
  const refreshTimer = setInterval(refresh, 4000)
  document.defaultView.addEventListener('focus', refresh)
  const newPage = button(el('span', { className: 'ntl-new-label' }, el('span', { 'aria-hidden': 'true' }, '+'), t('新建页面')),
    run(() => addPage()), { className: 'ntl-primary', 'aria-label': t('新建页面') })
  toolbar.append(el('div', { className: 'ntl-workspace-identity' }, navigationToggle, el('strong', {}, t('学习笔记'))),
    el('div', { className: 'ntl-workspace-actions' }, languagePicker,
    menu(t('资料与备份'), [
      [t('在侧栏打开网页'), async () => { const url = await inputDialog(t('打开网页'), t('网页地址')); if (url) openWeb(url) }],
      [t('导入 PDF 或 Markdown'), async () => { const [file] = await pickFile('.pdf,.md,.markdown,application/pdf,text/markdown'); await importContent(file) }],
      [t('打开在线 PDF'), importUrl], [t('导出可编辑备份'), exportBackup], [t('恢复备份'), restoreBackup], [t('回收站'), recycleBin],
    ], 'ntl-resource-menu'), newPage))
  library.load().then(() => {
    if (!alive) return
    reconcileSelection(); renderNavigation(); renderPage(true); renderStatus()
  }).catch(() => { if (alive) renderStatus() })
  return () => {
    alive = false
    layoutObserver.disconnect()
    lifetime.abort()
    clearInterval(refreshTimer)
    document.defaultView.removeEventListener('focus', refresh)
    unsubscribe(); unsubscribePending()
    paper?.destroy()
    library.save().catch(() => {})
    root.replaceChildren()
  }
}
