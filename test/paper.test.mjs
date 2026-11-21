import assert from 'node:assert/strict'
import test from 'node:test'
import { lassoContains, renderPaperMarkdown, selectionBounds } from '../lib/paper.js'

test('Markdown previews DSH math without treating code or currency as formulas', () => {
  const source = [
    '解释 $x^2$ or \\(y^2\\).', '$$', '\\frac{1}{a}', '$$', '\\[z\\]', '',
    'Costs $12 and $13. Example: `$literal$`.',
  ].join('\n')
  const preview = renderPaperMarkdown(source)
  assert.equal(preview.match(/<math /g)?.length, 4)
  assert.equal(preview.match(/<math [^>]*display="block"/g)?.length, 2)
  assert.match(preview, /<mfrac>/)
  assert.match(preview, /\$12 and \$13/)
  assert.match(preview, /<code>\$literal\$<\/code>/)
})

test('a pasted Markdown preview cannot load active html or third-party images', () => {
  const preview = renderPaperMarkdown('<iframe src="https://example.test"></iframe>\n\n![chart](https://example.test/chart.png)')
  assert.match(preview, /&lt;iframe/)
  assert.match(preview, /chart/)
  assert.doesNotMatch(preview, /<iframe|<img|src="https:\/\/example\.test\/chart/)
})

test('lasso ranges are clipped to page bounds', () => {
  const polygon = [{ x: -8, y: 40 }, { x: 92.3, y: 10.8 }, { x: 35, y: 120 }]
  assert.deepEqual(selectionBounds(polygon, 100, 100), { x: 0, y: 10, width: 93, height: 90 })
  assert.equal(lassoContains({ x: 24, y: 43 }, polygon), true)
  assert.equal(lassoContains({ x: 94, y: 93 }, polygon), false)
})
