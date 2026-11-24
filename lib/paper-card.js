import { t } from './i18n.js'
import { CARD_TEXT_LIMIT, OUTCOMES, RULE_LABELS, TWO_CARD_RULES, twoCard } from './note-components.js'

export function renderTwoCard(doc, value, { onChange, onFinish, onAsk, listener }) {
  const make = (tag, className, label) => {
    const element = doc.createElement(tag)
    if (className) element.className = className
    if (label !== undefined) element.textContent = label
    return element
  }
  let card = twoCard(value)
  const root = make('section', 'nl-two-card')
  root.setAttribute('aria-label', t('两张卡片'))
  const title = make('h3', '', t('两张卡片'))
  const rules = make('div', 'nl-card-rules')
  rules.setAttribute('role', 'group')
  rules.setAttribute('aria-label', t('抽样规则'))
  const controls = new Map(TWO_CARD_RULES.map(rule => {
    const control = make('button', 'nl-paper-button', t(RULE_LABELS[rule]))
    control.type = 'button'
    control.addEventListener('click', () => {
      if (card.rule === rule) return
      card = twoCard({ ...card, rule })
      draw()
      onChange(card, false)
    }, listener)
    rules.append(control)
    return [rule, control]
  }))
  const graph = make('div', 'nl-card-graph')
  graph.setAttribute('aria-label', t('四种结果的概率'))
  graph.setAttribute('role', 'group')
  const rows = OUTCOMES.map(outcome => {
    const track = make('span', 'nl-card-track')
    track.setAttribute('aria-hidden', 'true')
    const fill = make('span', 'nl-card-fill')
    track.append(fill)
    const amount = make('span', 'nl-card-percent')
    const row = make('div', 'nl-card-row')
    row.append(make('span', '', outcome), track, amount)
    graph.append(row)
    return { outcome, fill, amount }
  })
  const explanation = make('p', 'nl-card-explanation')
  explanation.setAttribute('aria-live', 'polite')

  function draw() {
    for (const [rule, control] of controls) control.setAttribute('aria-pressed', String(card.rule === rule))
    for (const { outcome, fill, amount } of rows) {
      const percent = card.probabilities[outcome] * 100 + '%'
      fill.style.width = percent
      amount.textContent = percent
    }
    explanation.textContent = card.rule === 'independent'
      ? t('每种结果都是 25%。AA 和 BB 合计占一半。')
      : t('只有 AB 和 BA，概率各为 50%。')
  }

  function field(key, caption) {
    const label = make('label', 'nl-card-field')
    const input = make('textarea')
    input.rows = 2
    input.maxLength = CARD_TEXT_LIMIT
    input.value = card[key]
    input.addEventListener('input', () => {
      card = twoCard({ ...card, [key]: input.value })
      onChange(card, true)
    }, listener)
    input.addEventListener('blur', onFinish, listener)
    label.append(make('span', '', t(caption)), input)
    return label
  }
  draw()
  root.append(title, make('p', 'nl-card-description', t('比较从 A、B 两张卡片中等概率抽取两次的结果。')),
    rules, graph, explanation, field('summary', '我的总结'), field('question', '我的疑问'))
  if (onAsk) {
    const ask = make('button', 'nl-paper-button nl-card-ask', t('加入 DSH 草稿'))
    ask.type = 'button'
    ask.addEventListener('click', () => onAsk(card), listener)
    root.append(ask)
  }
  return root
}
