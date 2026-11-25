import { t } from './i18n.js'
import { NOTE_FIGURE_FENCE, OUTCOMES, RULE_LABELS, TWO_CARD_RULES, twoCard } from './note-components.js'

function caption(value, limit) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= limit ? text : null
}

function items(value, min, max, read) {
  if (!Array.isArray(value) || value.length < min || value.length > max) return null
  const result = value.map(read)
  return result.includes(null) ? null : result
}

function parseFigure(source) {
  if (source.length > 12_000) return null
  let input
  try { input = JSON.parse(source) } catch { return null }
  const title = caption(input?.title, 100)
  if (!title) return null

  if (input.type === 'flow') {
    const steps = items(input.steps, 2, 8, step => {
      const label = caption(step?.label, 64)
      const explanation = caption(step?.explanation, 480)
      return label && explanation ? { label, explanation } : null
    })
    return steps && { type: 'flow', title, steps }
  }

  if (input.type !== 'bar') return null
  const labels = items(input.labels, 1, 8, label => caption(label, 48))
  const unit = input.unit === undefined ? '' : caption(input.unit, 16)
  if (!labels || unit === null) return null
  const scenarios = items(input.scenarios, 1, 4, entry => {
    const label = caption(entry?.label, 64)
    const explanation = entry?.explanation === undefined ? '' : caption(entry.explanation, 480)
    const values = items(entry?.values, labels.length, labels.length, value =>
      Number.isFinite(value) && value >= 0 ? value : null)
    return label && values && explanation !== null ? { label, values, explanation } : null
  })
  if (!scenarios) return null
  const highest = Math.max(...scenarios.flatMap(scenario => scenario.values))
  const max = input.max ?? (highest || 1)
  if (!Number.isFinite(max) || max <= 0 || max < highest) return null
  return { type: 'bar', title, labels, scenarios, unit, max }
}

function create(doc, tag, className, label) {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (label !== undefined) node.textContent = label
  return node
}

function controls(doc, options, label, select, flow = false) {
  const group = create(doc, 'div', 'nl-figure-controls')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', label)
  const buttons = options.map((option, index) => {
    const button = create(doc, 'button', 'nl-paper-button nl-figure-control', option.label)
    button.type = 'button'
    const item = create(doc, 'span', 'nl-figure-option')
    if (flow && index > 0) {
      const arrow = create(doc, 'span', 'nl-figure-arrow', '→')
      arrow.setAttribute('aria-hidden', 'true')
      item.append(arrow)
    }
    item.append(button)
    group.append(item)
    button.addEventListener('click', () => choose(index))
    return button
  })
  function choose(index) {
    buttons.forEach((button, position) => button.setAttribute('aria-pressed', String(position === index)))
    select(options[index])
  }
  choose(0)
  return group
}

function flowFigure(root, figure) {
  const doc = root.ownerDocument
  const detail = create(doc, 'div', 'nl-figure-detail')
  detail.setAttribute('aria-live', 'polite')
  const label = create(doc, 'strong')
  const explanation = create(doc, 'p')
  detail.append(label, explanation)
  const steps = controls(doc, figure.steps, t('流程步骤'), step => {
    label.textContent = step.label
    explanation.textContent = step.explanation
  }, true)
  root.append(steps, detail)
}

function barFigure(root, figure) {
  const doc = root.ownerDocument
  const graph = create(doc, 'div', 'nl-card-graph nl-figure-graph')
  const format = value => String(value) + (figure.unit === '%' ? '%' : figure.unit ? ' ' + figure.unit : '')
  const scale = create(doc, 'p', 'nl-figure-scale', t('共同刻度 0–{0}', format(figure.max)))
  const detail = create(doc, 'p', 'nl-figure-detail')
  detail.setAttribute('aria-live', 'polite')
  const bars = figure.labels.map(label => {
    const row = create(doc, 'div', 'nl-figure-row')
    const track = create(doc, 'span', 'nl-card-track')
    track.setAttribute('aria-hidden', 'true')
    const fill = create(doc, 'span', 'nl-card-fill')
    track.append(fill)
    const amount = create(doc, 'span', 'nl-figure-value')
    row.append(create(doc, 'span', '', label), track, amount)
    graph.append(row)
    return { fill, amount }
  })
  const choices = controls(doc, figure.scenarios, t('比较条件'), scenario => {
    bars.forEach(({ fill, amount }, index) => {
      const value = scenario.values[index]
      fill.style.width = (value / figure.max * 100) + '%'
      amount.textContent = format(value)
    })
    detail.textContent = scenario.explanation
    detail.hidden = !scenario.explanation
  })
  root.append(choices, scale, graph, detail)
}

export function mountNoteFigures(preview) {
  const doc = preview.ownerDocument
  for (const code of preview.querySelectorAll('pre > code.language-' + NOTE_FIGURE_FENCE)) {
    const figure = parseFigure(code.textContent)
    if (!figure) {
      code.parentElement.before(create(doc, 'p', 'nl-figure-error', t('图示数据有误，请在 Markdown 源码中修正。')))
      continue
    }
    const root = create(doc, 'section', 'nl-note-figure')
    root.setAttribute('aria-label', figure.title)
    root.append(create(doc, 'h3', '', figure.title))
    if (figure.type === 'flow') flowFigure(root, figure)
    else barFigure(root, figure)
    code.parentElement.replaceWith(root)
  }
}

export function sampleFigureMarkdown(type) {
  const figure = type === 'flow' ? {
    type, title: t('两次抽样的过程'),
    steps: [
      { label: t('第一次抽取'), explanation: t('等概率抽到 A 或 B。') },
      { label: t('应用抽样规则'), explanation: t('有放回时，第二次仍然可以抽到同一张卡片。') },
      { label: t('第二次抽取'), explanation: t('用乘法法则计算两次抽取结果的联合概率。') },
    ],
  } : {
    type, title: t('四种结果的概率'), labels: OUTCOMES, unit: '%', max: 100,
    scenarios: TWO_CARD_RULES.map(rule => {
      const { probabilities } = twoCard({ rule })
      return {
        label: t(RULE_LABELS[rule]),
        values: OUTCOMES.map(outcome => probabilities[outcome] * 100),
        explanation: rule === 'independent'
          ? t('每种结果都是 25%。AA 和 BB 合计占一半。')
          : t('只有 AB 和 BA，概率各为 50%。'),
      }
    }),
  }
  const fields = Object.entries(figure).map(([key, value]) => '  ' + JSON.stringify(key) + ': ' + JSON.stringify(value))
  return ['```' + NOTE_FIGURE_FENCE, '{', fields.join(',\n'), '}', '```'].join('\n')
}
