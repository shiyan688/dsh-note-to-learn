import assert from 'node:assert/strict'
import test from 'node:test'
import { lassoContains, renderPaperMarkdown, selectionBounds } from '../lib/paper.js'
import { renderPaperLayout } from '../lib/paper-layout.js'

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
