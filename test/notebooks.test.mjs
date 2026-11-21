import assert from 'node:assert/strict'
import test from 'node:test'
import { copyPage, exportPageMarkdown, importPageMarkdown, movePage, searchPages } from '../lib/notebooks.js'

function library() {
  return {
    notebooks: [{ id: 'one' }, { id: 'two' }, { id: 'three', deletedAt: 'today' }],
    sections: [
      { id: 'group', notebookId: 'one', kind: 'group' },
      { id: 'start', notebookId: 'one', parentId: 'group' },
      { id: 'end', notebookId: 'two' },
      { id: 'hidden', notebookId: 'three' },
    ],
    pages: [
      { id: 'main', sectionId: 'start', title: 'Read', blocks: [{ kind: 'text', text: 'diffusion' }] },
      { id: 'child', sectionId: 'start', parentId: 'main', title: 'PDF', tags: ['重要'],
        background: { ocrText: '深度学习 ＡＩ' } },
      { id: 'trashed', sectionId: 'start', parentId: 'child', deletedAt: 'today', title: 'AI' },
      { id: 'another', sectionId: 'start', title: 'More' },
      { id: 'target', sectionId: 'end', title: 'Destination' },
      { id: 'hidden-page', sectionId: 'hidden', title: 'AI' },
    ],
  }
}

test('moving a page moves its subtree and rejects ancestry cycles', () => {
  const input = library()
  assert.throws(() => movePage(input, 'main', { sectionId: 'start', parentId: 'child' }), /子页/)
  const moved = movePage(input, 'main', { sectionId: 'end', parentId: 'target' })
  assert.deepEqual(moved.pages.map(page => page.id), ['another', 'target', 'main', 'child', 'trashed', 'hidden-page'])
  assert.deepEqual(moved.pages.slice(2, 5).map(page => [page.sectionId, page.parentId]), [
    ['end', 'target'], ['end', 'main'], ['end', 'child'],
  ])
  assert.equal(moved.pages[4].deletedAt, 'today')
  assert.equal(input.pages[0].sectionId, 'start')
  const reordered = movePage(input, 'another', { sectionId: 'start', beforeId: 'main' })
  assert.equal(reordered.pages[0].id, 'another')
})

test('copying assigns fresh parent IDs and keeps old deleted children out of the copy', () => {
  const input = library()
  const ids = ['new-main', 'new-child']
  const copy = copyPage(input, 'main', { sectionId: 'end', beforeId: 'target' }, () => ids.shift())
  assert.equal(copy.pageId, 'new-main')
  const inserted = copy.state.pages.slice(4, 6)
  assert.deepEqual(inserted.map(page => [page.id, page.parentId, page.sectionId]), [
    ['new-main', null, 'end'], ['new-child', 'new-main', 'end'],
  ])
  assert.equal(copy.state.pages.filter(page => page.deletedAt).length, 1)
  inserted[0].blocks[0].text = 'edited copy'
  assert.equal(input.pages[0].blocks[0].text, 'diffusion')
})

test('search combines OCR, text, titles and tags while excluding trashed hierarchies', () => {
  const input = library()
  assert.deepEqual(searchPages(input, 'ai 深度', { tag: '#重要' }).map(({ page }) => page.id), ['child'])
  assert.deepEqual(searchPages(input, 'ai').map(({ page }) => page.id), ['child'])
  assert.equal(searchPages(input, 'diffusion', { notebookId: 'one' })[0].snippet, 'diffusion')
  input.sections[0].deletedAt = 'today'
  assert.equal(searchPages(input, 'ai').length, 0)
})

test('Markdown import stores editable source and safely previews links and raw HTML', () => {
  const incoming = '# 我的笔记\n\n<strong onclick="attack()">HTML</strong>\n\n' +
    '[坏链接](javascript:alert(1))\n\n![扫描](https://example.test/scan.png)\n\n## 对照\n\n**正文**'
  const page = importPageMarkdown(incoming, { id: 'p', sectionId: 'start' })
  assert.equal(page.title, '我的笔记')
  assert.equal(page.blocks[0].markdown, incoming.slice(incoming.indexOf('<strong')))
  assert.match(page.blocks[0].html, /&lt;strong/)
  assert.doesNotMatch(page.blocks[0].html, /<img|href="javascript/)
  assert.match(page.blocks[0].html, /href="https:\/\/example\.test\/scan\.png"/)
  assert.match(page.blocks[0].html, /<h2>对照<\/h2>[\s\S]*<strong>正文<\/strong>/)
})

test('Markdown export provides real archive paths and protects markup while retaining formulas', () => {
  const math = '$\\frac{a}{b}<2$'
  const pdf = 'data:application/pdf;base64,AAAA'
  const note = {
    title: '资料 [实验]',
    blocks: [
      { kind: 'file', name: '../../spec.pdf', dataUrl: pdf, y: 60, source: { title: '原文', page: 4, endPage: 6 } },
      { kind: 'text', text: math, markdown: math, y: 40, source: { title: '网页', url: 'https://example.test/source' } },
      { kind: 'text', text: '<script>code</script>', markdown: '<script>code</script>', y: 100 },
    ],
  }
  const { markdown, attachments } = exportPageMarkdown(note)
  assert.equal(markdown.includes(math), true)
  assert.match(markdown, /https:\/\/example\.test\/source/)
  assert.match(markdown, /第 4–6 页/)
  assert.match(markdown, /\(assets\/1-spec\.pdf\)/)
  assert.doesNotMatch(markdown, /<script>/)
  assert.deepEqual(attachments, [{ path: 'assets/1-spec.pdf', dataUrl: pdf }])
  assert.ok(markdown.indexOf(math) < markdown.indexOf('assets/'))
})
