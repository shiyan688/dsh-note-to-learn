export const NOTE_LAYOUTS = ['auto', 'comparison', 'steps', 'checklist']
export const TWO_CARD = 'two-card'
export const TWO_CARD_RULES = ['without-replacement', 'independent']
export const OUTCOMES = ['AB', 'BA', 'AA', 'BB']
export const RULE_LABELS = {
  'without-replacement': '无放回抽样',
  independent: '两次独立抽样',
}
export const CARD_TEXT_LIMIT = 2_000

export function twoCard(data = {}) {
  const rule = TWO_CARD_RULES.includes(data?.rule) ? data.rule : 'without-replacement'
  const [AB, BA, AA, BB] = rule === 'independent' ? [0.25, 0.25, 0.25, 0.25] : [0.5, 0.5, 0, 0]
  return {
    type: TWO_CARD, rule, probabilities: { AB, BA, AA, BB },
    summary: typeof data?.summary === 'string' ? data.summary.slice(0, CARD_TEXT_LIMIT) : '',
    question: typeof data?.question === 'string' ? data.question.slice(0, CARD_TEXT_LIMIT) : '',
  }
}

export function twoCardMarkdown(data, translate = text => text) {
  const card = twoCard(data)
  return [
    '### ' + translate('两张卡片'),
    translate('抽样规则') + ' · ' + translate(RULE_LABELS[card.rule]),
    ['| ' + translate('结果') + ' | ' + translate('概率') + ' |', '| --- | --- |',
      ...OUTCOMES.map(outcome => '| ' + outcome + ' | ' + card.probabilities[outcome] * 100 + '% |')].join('\n'),
    card.summary.trim() && '**' + translate('我的总结') + '**\n\n' + card.summary,
    card.question.trim() && '**' + translate('我的疑问') + '**\n\n' + card.question,
  ].filter(Boolean).join('\n\n')
}
