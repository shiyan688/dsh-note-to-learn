const blockGap = 24
const bottomMargin = 36

function horizontallyOverlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width
}

function isLegacyAppend(block, page) {
  return block.placement === undefined && block.x === 38 && block.width === Math.max(200, page.width - 76) &&
    ((block.kind === 'text' && typeof block.markdown === 'string') || block.kind === 'card')
}

export function measurePaperLayout(page, measureHeight) {
  const ordered = page.blocks.toSorted((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))
  const bounds = new Map()
  const fixed = []
  const flowing = []
  let legacyBottom = -Infinity
  for (const block of ordered) {
    const { x = 0, y = 0, width = 0, height = 0 } = block
    const box = { x, y, width, height: Math.max(height, measureHeight(block.id)) }
    bounds.set(block.id, box)
    // Older Agent blocks shared a full-width column and had disjoint saved bounds.
    const legacy = isLegacyAppend(block, page)
    const inFlow = block.placement === 'flow' || (legacy && y >= legacyBottom)
    if (legacy) legacyBottom = Math.max(legacyBottom, y + height)
    if (inFlow) flowing.push({ box, height })
    else fixed.push({ box, height })
  }

  if (page.background) return { bounds, height: page.height }

  const placed = []
  for (const { box, height: savedHeight } of flowing) {
    let y = box.y
    for (const previous of placed) {
      if (horizontallyOverlaps(box, previous)) y = Math.max(y, previous.y + previous.height + blockGap)
    }
    for (const { box: obstacle, height } of fixed) {
      if (!horizontallyOverlaps(box, obstacle)) continue
      // A fixed object that was deliberately placed on the saved block stays over it.
      if (box.y < obstacle.y + height && obstacle.y < box.y + savedHeight) continue
      if (y < obstacle.y + obstacle.height && obstacle.y < y + box.height) {
        y = obstacle.y + obstacle.height + blockGap
      }
    }
    box.y = y
    placed.push(box)
  }

  let height = page.height
  for (const box of bounds.values()) height = Math.max(height, box.y + box.height + bottomMargin)
  return { bounds, height: Math.ceil(height) }
}
