import assert from 'node:assert/strict'
import test from 'node:test'
import { guestMenuAnchor, intersectRect, nativeScreenshotBlob, readChatSelection, sourceCrop } from '../lib/capture.js'
import { createDraftBridge, openPdfSource, pdfResourceAddress, sourceLabel } from '../lib/dsh.js'

test('shows the PDF file name and page to the model without the local directory', () => {
  assert.equal(sourceLabel({ title: 'formula.pdf', path: 'C:\\local\\workspace\\formula.pdf', page: 2 }), 'formula.pdf，第 2 页')
  assert.equal(sourceLabel({ path: 'C:\\local\\workspace\\formula.pdf', page: 2 }), 'formula.pdf，第 2 页')
})

test('maps window CSS coordinates to captured PDF pixels and clips to the page', () => {
  const page = { left: -25, top: 50, right: 375, bottom: 650, width: 400, height: 600 }
  const drag = { left: 2.5, top: 60.5, right: 395, bottom: 81 }
  assert.deepEqual(intersectRect(page, drag), {
    left: 2.5, top: 60.5, right: 375, bottom: 81, width: 372.5, height: 20.5,
  })
  assert.deepEqual(sourceCrop(drag, page, 800, 1200), { x: 55, y: 21, width: 745, height: 41 })
  assert.throws(() => sourceCrop({ left: 400, top: 100, right: 410, bottom: 150 }, page), /框选/u)
})

test('converts Electron screenshots without requiring access to Node Buffer in the renderer', async () => {
  const image = {
    isEmpty: () => false,
    toPNG() { throw new Error('Node Buffer is not available in the sandboxed renderer') },
    toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
  }
  const blob = nativeScreenshotBlob(image, { atob, Blob })
  assert.equal(blob.type, 'image/png')
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.throws(() => nativeScreenshotBlob({ isEmpty: () => true }, { atob, Blob }), /截图为空/u)
})

test('anchors an Electron WebView menu at the original click inside an offset guest', () => {
  const guest = { left: 994, top: 115, right: 1270, bottom: 680, width: 276, height: 565 }
  assert.deepEqual(guestMenuAnchor({ x: 1080, y: 144 }, guest), { x: 1080, y: 144 })
  assert.deepEqual(guestMenuAnchor({ x: 1055, y: 223 }, guest), { x: 1055, y: 223 })
  assert.deepEqual(guestMenuAnchor({ x: 61, y: 108 }, guest), { x: 1055, y: 223 })
  assert.deepEqual(guestMenuAnchor({ x: 1800, y: 223 }, guest), { x: 994, y: 115 })
})

test('projects a selected rendered equation to its original TeX', () => {
  const simpleText = value => ({ nodeType: 3, nodeValue: value })
  const formula = {
    nodeType: 1,
    matches: selector => selector === '.katex',
    querySelector: () => ({ textContent: '\\frac{1}{2}' }),
    closest: () => false,
  }
  const fragment = {
    nodeType: 11,
    childNodes: [simpleText('代入 '), formula, simpleText(' 可得')],
    querySelector: () => formula,
  }
  const range = { cloneContents: () => fragment }
  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    getRangeAt: () => ({ cloneRange: () => range }),
    toString: () => '代入 12 可得',
  }
  assert.equal(readChatSelection(selection), '代入 $\\frac{1}{2}$ 可得')
})

function harness() {
  let activeSession = 's1'
  let composer
  let disposeCount = 0
  let initialCommit = true
  let attachmentIds = []
  let hookIndex = 0
  let effects = []
  const refs = []
  const inserted = []
  const pasted = []
  const editor = {
    dispatchEvent(event) {
      pasted.push(...event.clipboardData.files)
      event.preventDefault()
      attachmentIds = [...attachmentIds, 'image-1']
      mount()
    },
  }
  const marker = {
    isConnected: true,
    parentElement: { closest: () => null },
    closest: selector => selector === '[data-composer-card]' ? { querySelector: () => editor } : null,
  }
  const ctx = { slots: {
    inject(name, register) {
      assert.equal(name, 'conversation.input.overlay')
      register()
      return () => { disposeCount += 1 }
    },
    register(options, component) { composer = component },
  } }
  const React = {
    useRef(value) {
      const index = hookIndex++
      return refs[index] ??= { current: value }
    },
    useLayoutEffect(effect) { effects.push(effect) },
    createElement(tag, { ref }) { ref.current = marker },
  }
  class DataTransfer {
    files = []
    items = { add: file => this.files.push(file) }
  }
  class ClipboardEvent extends Event {
    constructor(type, options) {
      super(type, options)
      this.clipboardData = options.clipboardData
    }
  }
  const document = { defaultView: { DataTransfer, ClipboardEvent, File } }
  const bridge = createDraftBridge(ctx, { React, document, getSessionId: () => activeSession })
  const inputActions = {
    insertQuote(text, summary) { inserted.push({ kind: 'quote', text, summary }); return true },
    captureInsertion: () => ({ offset: 3 }),
    insertText(text, span) { inserted.push({ kind: 'plain', text, span }); return true },
  }
  function mount() {
    hookIndex = 0
    effects = []
    composer({
      sessionId: 's1', inputActions,
      useInput: select => select({ attachmentIds }),
      useAccess: () => true,
      useSession: select => select({ removed: false }),
    })
    for (const effect of effects.slice(initialCommit ? 0 : 1)) effect()
    initialCommit = false
  }
  mount()
  return { bridge, pasted, inserted, navigate: session => { activeSession = session }, disposeCount: () => disposeCount }
}

test('uses the current native draft for plain text, sourced quotes and PNG attachments', async () => {
  const { bridge, inserted, pasted, navigate, disposeCount } = harness()
  await bridge.add({ kind: 'text', text: ' 摘录 ', source: { title: '论文', path: 'paper.pdf', page: 4, endPage: 6 } }, 's1')
  await bridge.add({ kind: 'text', text: '说明' }, 's1', { quote: false })
  await bridge.add({ kind: 'image', blob: new Blob(['image bytes'], { type: 'image/png' }) }, 's1')
  assert.deepEqual(inserted, [
    { kind: 'quote', text: '来源：paper.pdf，第 4–6 页\n\n摘录', summary: { label: '论文', title: 'paper.pdf，第 4–6 页', body: '摘录' } },
    { kind: 'plain', text: '说明', span: { offset: 3 } },
  ])
  assert.equal(pasted[0].type, 'image/png')
  assert.equal(pasted[0].name, '学习截图.png')
  assert.equal(await pasted[0].text(), 'image bytes')
  navigate('s2')
  await assert.rejects(bridge.add({ kind: 'text', text: '另一个会话' }, 's1'), /会话已切换/u)
  bridge.dispose()
  bridge.dispose()
  assert.equal(disposeCount(), 1)
})

test('reopens native Windows PDFs through DSH resource routing and finds their page', async () => {
  const path = 'C:\\研究\\note #2.pdf'
  assert.equal(pdfResourceAddress('s/1', path), 'dsh-resource://file/session/s%2F1/C:/%E7%A0%94%E7%A9%B6/note%20%232.pdf')
  assert.equal(sourceLabel({ title: 'Example', url: 'https://example.com/' }), 'Example (https://example.com/)')
  const operations = []
  const page = { dataset: { pdfPage: '3' }, scrollIntoView: config => operations.push(config) }
  const preview = {
    closest: selector => selector === '[data-sidebar-right-session]' ? { getAttribute: () => 's1' } : null,
    querySelector: () => ({ getAttribute: () => 'c:/研究/note #2.pdf' }),
    querySelectorAll: () => [page],
  }
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  const document = {
    defaultView: { MutationObserver, setTimeout, clearTimeout },
    querySelectorAll: () => [preview],
  }
  const sidebar = { mounted: { getSnapshot: () => 's1' }, openResource: address => operations.push(address) }
  await openPdfSource(sidebar, document, 's1', { path, page: 3 })
  assert.deepEqual(operations, [pdfResourceAddress('s1', path), { block: 'start', inline: 'nearest' }])
})
