import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { registerNoteRoutes } from '../lib/index.js'
import { createNotePreviews, renderNotePreview } from '../lib/note-previews.js'
import { registerNoteTools } from '../lib/note-tools.js'
import { createStore } from '../lib/store.js'

const executablePath = process.env.DSH_NOTE_TEST_BROWSER
const root = fileURLToPath(new URL('..', import.meta.url))
const sessionId = 'layout-regression-session'

function savedPage() {
  const explanation = 'The probability of the observed result depends on each draw and on how the sample space is defined. '.repeat(5).trim()
  const steps = Array.from({ length: 6 }, (_, index) => `${index + 1}. ${explanation}`).join('\n')
  const table = '| Method | Explanation | Notes |\n|---|---|---|\n' +
    Array.from({ length: 5 }, (_, index) => `| Method ${index + 1} | ${explanation} | Example |`).join('\n')
  const checklist = Array.from({ length: 6 }, (_, index) => `- [${index % 2 ? 'x' : ' '}] ${explanation}`).join('\n')
  const bodies = [
    ['# Joint distributions\n\n## A worked example\n\n' + ('> ' + explanation + '\n\n').repeat(5) +
      '    mean = sum(samples) / len(samples)\n    print(mean)\n\n' + steps, undefined],
    ['## Derivation\n\n' + steps, 'steps'],
    ['## Review checklist\n\n' + checklist, 'checklist'],
    ['## Comparison\n\n' + table, 'comparison'],
    ['## Compare the models\n\n' + table + '\n\n## 待办\n\n' + checklist, 'auto'],
    ['## 結果\n\n' + explanation.repeat(3), undefined],
    ['## Last visible block\n\nThe last line remains reachable.', undefined],
  ]
  const positions = [[38, 746], [808, 458], [1290, 266], [1580, 242], [1846, 218], [2088, 218], [2330, 218]]
  return { id: 'legacy-page', sectionId: 'section', title: 'Page before the fix', width: 820, height: 2608, strokes: [],
    blocks: positions.map(([y, height], index) => {
      const [markdown, layout] = bodies[index]
      return { id: 'block-' + index, kind: 'text', x: 38, y, width: 744, height, text: markdown, markdown,
        ...(layout ? { layout } : {}), ...(index === 0 ? { originalText: explanation.repeat(5) } : {}) }
    }) }
}

test('a saved seven-block page grows at 100% and 125%, and the Agent can inspect a fresh render after editing',
  { skip: !executablePath, timeout: 45_000 }, async t => {
    const directory = await mkdtemp(join(root, '.note-browser-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const cwd = join(directory, 'project')
    const notes = createStore({ dataDir: directory })
    const previews = createNotePreviews()
    t.after(() => previews.clear())
    const original = savedPage()
    await notes.write(cwd, { expectedRevision: 0, state: {
      notebooks: [{ id: 'book', title: 'Notes' }],
      sections: [{ id: 'section', title: 'General', notebookId: 'book', kind: 'section' }],
      pages: [original],
    } })
    const backup = await notes.backup(cwd)
    await notes.restoreBackup(cwd, { expectedRevision: 1, backup })
    const { revision, state } = await notes.read(cwd)
    assert.deepEqual(state.pages[0], original)
    assert.ok((await notes.history(cwd, original.id)).length > 0)

    const routes = new Map()
    registerNoteRoutes({ register(route) { routes.set(route.path, route) } }, notes, console, previews)
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const route = routes.get(url.pathname)
      if (route) {
        const forwarded = await route.fetch(new Request(url, {
          method: request.method, headers: request.headers,
          ...(request.method === 'POST' ? { body: Readable.toWeb(request), duplex: 'half' } : {}),
        }))
        response.writeHead(forwarded.status, Object.fromEntries(forwarded.headers))
        response.end(Buffer.from(await forwarded.arrayBuffer()))
      } else {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!doctype html><div id="paper" style="width:100%;height:700px;display:flex;flex-direction:column"></div>')
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => { server.closeAllConnections(); server.close() })
    const browser = await chromium.launch({ executablePath, headless: true })
    t.after(() => browser.close())
    const tab = await browser.newPage({ viewport: { width: 1250, height: 800 } })
    const bundle = await build({
      stdin: { contents: 'export { mountPaper } from "./lib/paper.js"; export { connectNotePreviews } from "./lib/note-preview-client.js";',
        resolveDir: root },
      bundle: true, format: 'iife', globalName: 'TestNotes', platform: 'browser', write: false,
    })
    await tab.goto(`http://127.0.0.1:${server.address().port}/`)
    await tab.addStyleTag({ content: await readFile(join(root, 'lib', 'paper.css'), 'utf8') })
    await tab.addScriptTag({ content: bundle.outputFiles[0].text })
    await tab.evaluate(({ original, sessionId }) => {
      TestNotes.mountPaper(document.querySelector('#paper'), { page: original })
      TestNotes.connectNotePreviews(document, { getSnapshot: () => sessionId, subscribe: () => () => {} })
    }, { original, sessionId })
    for (const zoom of ['100%', '125%']) {
      const layout = await tab.evaluate(zoom => {
        document.body.style.zoom = zoom
        const sheet = document.querySelector('.nl-paper-sheet')
        const viewport = document.querySelector('.nl-paper-viewport')
        const blocks = Array.from(sheet.querySelectorAll('.nl-paper-block'))
        const boxes = blocks.map(block => {
          const { top, bottom, height } = block.getBoundingClientRect()
          const fits = Array.from(block.querySelectorAll('table, ol, input')).every(node =>
            node.getBoundingClientRect().bottom <= bottom)
          const headers = Array.from(block.querySelectorAll('th')).every(node => {
            const height = node.getBoundingClientRect().height
            return height < 2 * parseFloat(getComputedStyle(node).lineHeight) * parseFloat(zoom) / 100
          })
          return { top, bottom, height, contentFits: fits && headers }
        })
        const sheetBottom = sheet.getBoundingClientRect().bottom
        viewport.scrollTop = viewport.scrollHeight
        return { boxes, sheetBottom,
          lastVisible: blocks.at(-1).getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom }
      }, zoom)
      assert.equal(layout.boxes.length, 7)
      assert.ok(layout.boxes[0].height > original.blocks[0].height * (zoom === '125%' ? 1.25 : 1))
      for (let index = 1; index < layout.boxes.length; index++) {
        assert.ok(layout.boxes[index].top >= layout.boxes[index - 1].bottom, `Blocks ${index - 1}/${index} overlap at ${zoom}`)
      }
      assert.ok(layout.boxes.every(box => box.contentFits))
      assert.ok(layout.sheetBottom >= layout.boxes.at(-1).bottom)
      assert.ok(layout.lastVisible, `The last block is outside the viewport at ${zoom}`)
    }

    const secondY = await tab.locator('[data-id="block-1"]').evaluate(block => block.offsetTop)
    await tab.locator('[data-id="block-0"] details').evaluate(details => { details.open = true })
    await tab.waitForFunction(y => document.querySelector('[data-id="block-1"]').offsetTop > y, secondY)
    await tab.locator('[data-id="block-0"] details').evaluate(details => { details.open = false })
    await tab.waitForFunction(y => document.querySelector('[data-id="block-1"]').offsetTop === y, secondY)
    await tab.evaluate(() => { document.body.style.zoom = '100%' })

    const captures = []
    const attachmentStore = {
      imageLimits: { maxImageBytes: 16_000_000, maxMessageImageBytes: 16_000_000, mediaTypes: ['image/png'] },
      async saveImage({ data, mediaType }) {
        assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
        captures.push(data)
        return { attachmentId: 'preview-' + captures.length, mediaType, bytes: data.length,
          width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
      },
    }
    const services = { attachments: attachmentStore, llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } }
    const tools = new Map()
    registerNoteTools({ register(tool) { tools.set(tool.name, tool) } }, notes,
      (page, exec) => renderNotePreview(page, exec, key => services[key], previews))
    const exec = {
      agent: { session: { header: { id: sessionId, cwd } }, options: { provider: 'test', model: 'vision-test' } },
      signal: new AbortController().signal,
    }
    const review = { pageId: original.id, preview: true }
    const read = tools.get('note_read')
    const first = await read.execute(review, exec)
    assert.equal(first.preview.revision, revision)
    assert.equal(first.preview.status, 'ready', first.preview.message)
    assert.equal(read.output.render(review, first).at(-1).type, 'image')
    const edit = await tools.get('note_edit').execute({ pageId: original.id, mode: 'replace_text',
      blockId: first.blocks[0].blockId, expectedBlockVersion: first.blocks[0].blockVersion,
      markdown: '## Verified shorter version\n\nAn edited explanation.', layout: 'steps',
    }, exec)
    assert.match(edit.nextStep, /note_read with preview: true/)
    const second = await read.execute(review, exec)
    assert.equal(second.preview.revision, edit.revision)
    assert.equal(second.preview.status, 'ready', second.preview.message)
    assert.notDeepEqual(captures[0], captures[1])
    services.llm.resolveModelInfo = async () => ({ inputModalities: ['text'] })
    const unavailable = await read.execute(review, exec)
    assert.equal(unavailable.preview.status, 'unavailable')
    assert.match(unavailable.preview.message, /does not accept images/)
    assert.equal(read.output.render(review, unavailable).length, 1)
    if (process.env.DSH_NOTE_TEST_SCREENSHOTS) {
      const screenshots = process.env.DSH_NOTE_TEST_SCREENSHOTS
      await writeFile(join(screenshots, 'note-layout-preview.png'), captures[0])
      await writeFile(join(screenshots, 'note-layout-after-review.png'), captures[1])
    }
  })

test('Agent note figures work alongside LaTeX and tables, and appear in exported previews',
  { skip: !executablePath, timeout: 45_000 }, async t => {
    const directory = await mkdtemp(join(root, '.note-browser-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const cwd = join(directory, 'project')
    const notes = createStore({ dataDir: directory })
    const tools = new Map()
    registerNoteTools({ register(tool) { tools.set(tool.name, tool) } }, notes)
    const create = tools.get('note_create')
    const examples = [...create.parameters.properties.markdown.description.matchAll(/```note-figure\n[\s\S]*?\n```/g)]
      .map(match => match[0])
    assert.equal(examples.length, 2)
    assert.match(create.description, /major sticking point.*labeled figure/)
    const markdown = [
      '## Why the sampling rule matters',
      'For independent draws, $P(AA)=P(A)^2$.',
      '| Rule | Probability of AA |\n| --- | --- |\n| Independent | $\\frac{1}{4}$ |',
      '$$\n\\begin{aligned} P(AA)&=P(A)^2\\\\&=\\frac{1}{4} \\end{aligned}\n$$',
      ...examples,
    ].join('\n\n')
    const write = await create.execute({ title: 'Two draws', markdown, layout: 'auto' }, {
      agent: { session: { header: { cwd } } }, signal: new AbortController().signal,
    })
    assert.match(write.nextStep, /rendered math.*figure state/)
    const { state } = await notes.read(cwd)
    const page = state.pages[0]
    assert.equal(page.blocks[0].markdown, markdown)

    const browser = await chromium.launch({ executablePath, headless: true })
    t.after(() => browser.close())
    const tab = await browser.newPage({ viewport: { width: 1050, height: 850 } })
    const bundle = await build({
      stdin: { contents: 'export { mountPaper, exportPaperPage } from "./lib/paper.js"; ' +
        'export { setLanguage } from "./lib/i18n.js"; ' +
        'export { exportPageMarkdown, importPageMarkdown } from "./lib/notebooks.js";', resolveDir: root },
      bundle: true, format: 'iife', globalName: 'TestNotes', platform: 'browser', write: false,
    })
    await tab.setContent('<!doctype html><div id="paper" style="width:100%;height:790px;display:flex;flex-direction:column"></div>')
    await tab.addStyleTag({ content: await readFile(join(root, 'lib', 'paper.css'), 'utf8') })
    await tab.addScriptTag({ content: bundle.outputFiles[0].text })
    await tab.evaluate(page => {
      TestNotes.setLanguage('en')
      window.paper = TestNotes.mountPaper(document.querySelector('#paper'), { page })
    }, page)

    assert.equal(await tab.locator('.nl-paper-markdown-preview math').count(), 3)
    assert.equal(await tab.locator('.katex-error').count(), 0)
    assert.equal(await tab.locator('td math').count(), 1)
    assert.equal(await tab.locator('math[display="block"] mtable').count(), 1)
    const flow = tab.getByRole('region', { name: 'Two draws', exact: true })
    const second = flow.getByRole('button', { name: 'Second draw' })
    await second.click()
    assert.equal(await second.getAttribute('aria-pressed'), 'true')
    assert.match(await flow.locator('.nl-figure-detail').textContent(), /does not change these probabilities/)

    const chart = tab.getByRole('region', { name: 'Probability of AA and AB' })
    const barValues = chart.locator('.nl-figure-value')
    assert.deepEqual(await barValues.allTextContents(), ['0%', '50%'])
    const independent = chart.getByRole('button', { name: 'Independent draws' })
    await independent.press('Space')
    assert.equal(await independent.getAttribute('aria-pressed'), 'true')
    assert.deepEqual(await barValues.allTextContents(), ['25%', '25%'])
    assert.deepEqual(await chart.locator('.nl-card-fill').evaluateAll(nodes => nodes.map(node => node.style.width)), ['25%', '25%'])
    assert.equal(await tab.evaluate(() => window.paper.getPage().blocks[0].markdown), markdown)

    const exported = await tab.evaluate(async page => {
      const [block] = page.blocks
      const { markdown } = TestNotes.exportPageMarkdown({
        ...page, blocks: [{ ...block, markdown: block.markdown + '\n\nPress <kbd>Tab</kbd> to focus a step.' }],
      })
      const imported = TestNotes.importPageMarkdown(markdown, { id: 'round-trip', sectionId: page.sectionId })
      const bitmap = await createImageBitmap(await TestNotes.exportPaperPage(document, imported))
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      let paintedBar = false
      for (let offset = 0; offset < data.length; offset += 4) {
        if (data[offset] === 52 && data[offset + 1] === 107 && data[offset + 2] === 171) {
          paintedBar = true
          break
        }
      }
      return { markdown: imported.blocks[0].markdown, paintedBar }
    }, page)
    assert.ok(exported.paintedBar, 'The preview includes the bar, not just its text label.')
    assert.ok(examples.every(example => exported.markdown.includes(example)))
    assert.ok(!exported.markdown.includes('<kbd>'))

    if (process.env.DSH_NOTE_TEST_SCREENSHOTS) {
      await tab.locator('.nl-paper-markdown-preview').screenshot({
        path: join(process.env.DSH_NOTE_TEST_SCREENSHOTS, 'note-interactive-figures.png'),
      })
    }

    const toggle = tab.locator('.nl-paper-markdown-toggle')
    await toggle.click()
    const editor = tab.locator('.nl-paper-markdown-source')
    await editor.fill(markdown.replace('"values":[25,25]', '"values":[25]'))
    await toggle.click()
    assert.equal(await tab.locator('.nl-figure-error').count(), 1)
    assert.match(await tab.locator('code.language-note-figure').textContent(), /"values":\[25\]/)
    assert.equal(await flow.count(), 1)
  })
