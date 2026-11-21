const equation = /\\(?:frac|sqrt|sum|int|begin)\b|[∫∑√∂]|[a-z0-9)\]}]\s*(?:\^|=)\s*[-+({a-z0-9]/iu
const code = /(?:^|\n)\s*```|\b(?:TypeError|SyntaxError|ReferenceError|stack trace)\b|\b(?:function|def|class|import|SELECT)\s+[\w{]/iu

export function suggestQuestion(clips) {
  const text = clips.map(clip => clip.text ?? '').join('\n').trim().slice(0, 8000)
  if (code.test(text)) return '请解释这段代码的作用，并指出容易出错的地方。'
  if (equation.test(text)) return '请逐步解释这个公式的推导。'
  if (clips.some(clip => clip.source?.role === 'assistant')) return '请用一个具体的例子解释这段回答。'
  if (clips.some(clip => clip.kind === 'image')) {
    const isPaper = clips.some(clip => clip.source?.origin === 'note' || clip.source?.pageId)
    return isPaper ? '请解读圈选的笔记，说明关键步骤。' : '请解读这张截图，说明最重要的信息。'
  }
  if (text.length <= 24 && text.length >= 2 && !/[，。！？、:：\n]/u.test(text)) {
    return '请解释这个术语，并举一个简单的例子。'
  }
  return text.length > 180 ? '请总结这段材料的要点，并解释最难理解的部分。' : '请解释这段内容，并说明它为什么重要。'
}
