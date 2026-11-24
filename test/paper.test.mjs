import assert from 'node:assert/strict'
import test from 'node:test'
import { lassoContains, renderPaperMarkdown, selectionBounds } from '../lib/paper.js'
import { renderPaperLayout } from '../lib/paper-layout.js'
import { measurePaperLayout } from '../lib/paper-flow.js'

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

test('native answer layout preserves the content of labeled comparisons, derivations and tasks', () => {
  const source = [
    '## 方法对比', '', '- **自回归：** 逐词预测', '- 扩散：迭代去噪', '- 流匹配：积分速度场',
    '', '## 推导步骤', '', '- 写出 $P(A)$', '- 计算联合概率',
    '', '$$', '\\frac{1}{2}', '$$', '', '## 待办', '', '- [ ] 比较结果', '- [x] 选好样本',
  ].join('\n')
  const view = renderPaperLayout(source, 'auto')
  assert.match(view, /<table>[\s\S]*<td>自回归<\/td><td>逐词预测<\/td>[\s\S]*积分速度场/)
  assert.match(view, /<ol>[\s\S]*写出 \\\(P\(A\)\\\)[\s\S]*计算联合概率/)
  assert.ok(view.includes('<div>$$\n\\frac{1}{2}\n$$</div>'))
  assert.match(view, /<input type="checkbox"> 比较结果/)
  assert.match(view, /<input type="checkbox" checked> 选好样本/)
  assert.doesNotMatch(renderPaperLayout('<iframe src="https://example.test"></iframe>', 'auto'), /<iframe/)
})

test('lasso ranges are clipped to page bounds', () => {
  const polygon = [{ x: -8, y: 40 }, { x: 92.3, y: 10.8 }, { x: 35, y: 120 }]
  assert.deepEqual(selectionBounds(polygon, 100, 100), { x: 0, y: 10, width: 93, height: 90 })
  assert.equal(lassoContains({ x: 24, y: 43 }, polygon), true)
  assert.equal(lassoContains({ x: 94, y: 93 }, polygon), false)
})

test('seven saved Agent blocks reflow to measured heights and extend the scrollable paper', () => {
  const positions = [[38, 746], [808, 458], [1290, 266], [1580, 242], [1846, 218], [2088, 218], [2330, 218]]
  const measured = [1423, 620, 335, 401, 288, 262, 258]
  const blocks = positions.map(([y, height], index) => ({
    id: String(index), kind: 'text', x: 38, y, width: 744, height, markdown: 'Text',
  }))
  const page = { width: 820, height: 2608, blocks }
  const layout = measurePaperLayout(page, id => measured[Number(id)])
  const boxes = Array.from(layout.bounds.values())
  assert.equal(boxes[0].y, 38)
  for (let index = 1; index < boxes.length; index++) {
    const previous = boxes[index - 1]
    assert.ok(boxes[index].y >= previous.y + previous.height + 24)
  }
  assert.ok(layout.height >= boxes.at(-1).y + boxes.at(-1).height)
  assert.deepEqual(page.blocks.map(block => [block.y, block.height]), positions)
})

test('single blocks and fixed canvas positions keep their coordinates', () => {
  const first = { id: 'legacy', kind: 'text', x: 38, y: 38, width: 744, height: 60, markdown: 'A note' }
  const single = { width: 820, height: 1120, blocks: [first] }
  assert.equal(measurePaperLayout(single, () => 214).bounds.get(first.id).y, first.y)
  const fixed = { ...first, id: 'fixed', placement: 'fixed', x: 55, y: 80, width: 160 }
  const auto = { ...first, id: 'auto', placement: 'flow', y: 130 }
  const page = { ...single, blocks: [first, fixed, auto] }
  const layout = measurePaperLayout(page, id => id === first.id ? 214 : 60)
  assert.equal(layout.bounds.get(fixed.id).y, fixed.y)
  assert.ok(layout.bounds.get(auto.id).y >= first.y + 214)
  const pdf = measurePaperLayout({ ...page, background: {} }, () => 1700)
  assert.equal(pdf.bounds.get(auto.id).y, auto.y)
  assert.equal(pdf.height, page.height)
})
