import assert from 'node:assert/strict'
import { test } from 'node:test'
import { suggestQuestion } from '../lib/suggestions.js'

test('infers a local question from the type of captured material', () => {
  assert.match(suggestQuestion([{ kind: 'text', text: 'y = x^2 + 3x + 2' }]), /公式.*推导/)
  assert.match(suggestQuestion([{ kind: 'text', text: 'function example() { let i=1 }' }]), /代码/)
  assert.match(suggestQuestion([{ kind: 'image', source: { pageId: 'local-note' } }]), /圈选的笔记/)
  assert.match(suggestQuestion([{ kind: 'image', source: { origin: 'pdf' } }]), /截图/)
  assert.match(suggestQuestion([{ kind: 'text', text: '偏微分方程' }]), /术语/)
  assert.doesNotMatch(suggestQuestion([{ kind: 'text', text: 'only retained in the draft' }]), /retained/)
})
