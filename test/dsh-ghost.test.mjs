import assert from 'node:assert/strict'
import test from 'node:test'
import { createDraftBridge } from '../lib/dsh.js'

function setup() {
  let session = 'test'
  let completionOpen = false
  let modalOpen = false
  let span = { draftRev: 4, start: 5, end: 5 }
  let Component
  const sessionListeners = new Set()
  const effects = []
  const inserted = []
  const classes = new Set()
  const css = new Map()
  const paragraph = { nodeType: 1, childNodes: [] }
  const text = { nodeType: 3, length: 5, parentNode: paragraph }
  paragraph.childNodes.push(text)
  const card = {
    querySelector(selector) {
      return selector.startsWith('[data-composer-input]') ? editor : completionOpen ? {} : null
    },
  }
  const editor = Object.assign(new EventTarget(), {
    nodeType: 1, childNodes: [paragraph], lastElementChild: paragraph, isConnected: true,
    closest: selector => selector === '[data-composer-card]' ? card : null,
    classList: { add: key => classes.add(key), contains: key => classes.has(key), remove: key => classes.delete(key) },
    style: { getPropertyValue: name => css.get(name) || '', setProperty: (name, value) => css.set(name, value), removeProperty: name => css.delete(name) },
    contains: node => [text, paragraph, editor].includes(node),
    getAttribute: () => null, hasAttribute: () => false, toggleAttribute() {}, removeAttribute() {},
    focus() { document.activeElement = editor },
  })
  paragraph.parentNode = editor
  const marker = { isConnected: true, parentElement: { closest: () => null }, closest: editor.closest }
  const cursor = {
    isCollapsed: true, rangeCount: 1,
    getRangeAt: () => ({ endContainer: text, endOffset: span.end }),
    collapse() { span = { ...span, start: 5, end: 5 } },
  }
  const document = Object.assign(new EventTarget(), {
    activeElement: editor,
    getSelection: () => cursor,
    querySelectorAll: () => modalOpen ? [{ closest: () => null, getClientRects: () => [1] }] : [],
    defaultView: { AbortController, requestAnimationFrame: callback => callback(),
      MutationObserver: class { observe() {} disconnect() {} } },
  })
  const ctx = {
    slots: { inject: (name, register) => register(), register: (options, component) => { Component = component } },
    sidebarRight: { mounted: { subscribe(listener) {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    } } },
  }
  const React = {
    useRef: current => ({ current }),
    useLayoutEffect: effect => effects.push(effect),
    createElement: (_element, { ref }) => { ref.current = marker },
  }
  const bridge = createDraftBridge(ctx, { React, document, getSessionId: () => session })
  Component({
    sessionId: 'test',
    useSession: select => select({ removed: false }), useAccess: () => true,
    useInput: select => select({ attachmentIds: [], draftRev: 4, phase: 'plain' }),
    inputActions: {
      captureInsertion: () => span,
      insertText(text, target) { inserted.push({ text, target }); return true },
    },
  })
  for (const effect of effects) effect()
  return {
    bridge, css, editor, document, inserted,
    completion(value) { completionOpen = value },
    modal(value) { modalOpen = value },
    caret(index) { span = { ...span, start: index, end: index } },
    navigate(id) { session = id; sessionListeners.forEach(listener => listener()) },
    key(key, options = {}) {
      const event = new Event('keydown', { cancelable: true })
      Object.defineProperties(event, {
        key: { value: key }, target: { value: editor }, shiftKey: { value: options.shiftKey },
      })
      if (options.preventDefault) event.preventDefault()
      document.dispatchEvent(event)
      return event.defaultPrevented
    },
  }
}

test('sends one ghost proposal to the current native draft only when Tab accepts it', () => {
  const fixture = setup()
  assert.equal(fixture.bridge.suggest('短句 “示例”', 'test'), true)
  assert.deepEqual(fixture.inserted, [])
  assert.equal(fixture.css.get('--ntl-composer-ghost'), '" 短句 “示例”"')
  assert.equal(fixture.key('Tab', { shiftKey: true }), false)
  assert.equal(fixture.key('Tab', { preventDefault: true }), true)
  assert.deepEqual(fixture.inserted, [])
  assert.equal(fixture.key('Tab'), true)
  assert.equal(fixture.key('Tab'), false)
  assert.deepEqual(fixture.inserted, [{ text: ' 短句 “示例”', target: { draftRev: 4, start: 5, end: 5 } }])
  assert.equal(fixture.css.has('--ntl-composer-ghost'), false)
  fixture.bridge.dispose()
})

test('defers to native completions and clears on input, Escape and session switches', () => {
  const fixture = setup()
  fixture.completion(true)
  assert.equal(fixture.bridge.suggest('提议', 'test'), false)
  fixture.completion(false)
  fixture.modal(true)
  assert.equal(fixture.bridge.suggest('提议', 'test'), false)
  fixture.modal(false)
  fixture.caret(2)
  assert.equal(fixture.bridge.suggest('提议', 'test', { focus: false }), true)
  assert.equal(fixture.css.has('--ntl-composer-ghost'), false)
  assert.equal(fixture.key('Tab'), false)
  fixture.caret(5)
  assert.equal(fixture.bridge.suggest('提议', 'test'), true)
  fixture.completion(true)
  assert.equal(fixture.key('Tab'), false)
  fixture.completion(false)
  for (const dismiss of [
    () => fixture.editor.dispatchEvent(new Event('beforeinput')),
    () => fixture.key('Escape'),
    () => fixture.navigate('other'),
  ]) {
    assert.equal(fixture.bridge.suggest('提议', 'test'), true)
    dismiss()
    assert.equal(fixture.css.has('--ntl-composer-ghost'), false)
    assert.equal(fixture.key('Tab'), false)
  }
  assert.deepEqual(fixture.inserted, [])
  fixture.bridge.dispose()
})

test('adding plain text after the source takes focus uses the end of the existing draft', async () => {
  const fixture = setup()
  fixture.document.activeElement = null
  fixture.caret(2)
  await fixture.bridge.add({ kind: 'text', text: ' 追加' }, 'test', { quote: false })
  assert.deepEqual(fixture.inserted, [{ text: ' 追加', target: { draftRev: 4, start: 5, end: 5 } }])
  fixture.bridge.dispose()
})
