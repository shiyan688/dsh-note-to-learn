const base = '/api/dsh-note-to-learn/'

export async function requestNotes(workspace, route, { query = {}, json, blob } = {}) {
  const url = `${base}${route}?${new URLSearchParams({ workspace, ...query })}`
  const headers = json ? { 'content-type': 'application/json' } : blob ? { 'content-type': blob.type } : undefined
  const response = await fetch(url, {
    credentials: 'same-origin', method: headers ? 'POST' : 'GET', headers,
    body: json ? JSON.stringify(json) : blob,
  })
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}))
    const message = response.status === 409 ? '笔记已被 Agent 或另一个窗口更新。请先保存本窗口的副本，再重新载入。' : problem.error
    throw Object.assign(new Error(message || `操作失败（${response.status}）`), { status: response.status })
  }
  return response.json()
}

const collections = ['notebooks', 'sections', 'pages']
const pageContent = ['blocks', 'strokes']
const conflict = Symbol('overlapping note edit')

function equal(left, right) {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && left.length !== right.length) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
}

function withUnchangedPages(previous, current) {
  if (!previous || !current) return current
  const before = new Map(previous.pages.map(page => [page.id, page]))
  const pages = current.pages.map(page => {
    const old = before.get(page.id)
    if (!old) return page
    if (equal(old, page)) return old
    return {
      ...page,
      ...Object.fromEntries(pageContent.filter(key => Object.hasOwn(page, key) && equal(old[key], page[key]))
        .map(key => [key, old[key]])),
    }
  })
  return { ...current, pages }
}

function mergeValue(base, local, remote, merge) {
  if (equal(local, remote) || equal(base, remote)) return local
  if (equal(base, local)) return remote
  return merge ? merge(base, local, remote) : conflict
}

function mergeRecord(base, local, remote, mergeField) {
  if (![base, local, remote].every(item => item && typeof item === 'object' && !Array.isArray(item))) return conflict
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])
  const values = []
  for (const key of keys) {
    const field = item => Object.hasOwn(item, key) ? item[key] : undefined
    const value = mergeValue(field(base), field(local), field(remote), mergeField?.(key))
    if (value === conflict) return conflict
    if (value !== undefined) values.push([key, value])
  }
  return Object.fromEntries(values)
}

function records(items) {
  if (!Array.isArray(items)) return null
  const found = new Map()
  for (const row of items) {
    if (typeof row?.id !== 'string' || !row.id || found.has(row.id)) return null
    found.set(row.id, row)
  }
  return found
}

// Rebase add/edit/delete operations while keeping stable order. Simultaneous
// reorders or insertions between existing records require explicit review.
function retainsOrder(original, changed) {
  const remaining = [...original.keys()].filter(id => changed.has(id))
  const order = [...changed.keys()]
  return remaining.every((id, index) => id === order[index])
}

function mergeRecords(base, local, remote, mergeRow) {
  const original = records(base ?? [])
  const edited = records(local)
  const incoming = records(remote)
  if (!original || !edited || !incoming || !retainsOrder(original, edited) || !retainsOrder(original, incoming)) return conflict
  const keys = new Set([...original.keys(), ...incoming.keys(), ...edited.keys()])
  const result = []
  for (const key of keys) {
    const row = mergeValue(original.get(key), edited.get(key), incoming.get(key), mergeRow)
    if (row === conflict) return conflict
    if (row) result.push(row)
  }
  return result
}

function boxesOverlap(first, second) {
  return first.x < second.x + second.width && first.x + first.width > second.x &&
    first.y < second.y + second.height && first.y + first.height > second.y
}

function mergeBlocks(base, local, remote) {
  const merged = mergeRecords(base, local, remote)
  if (merged === conflict) return conflict
  const existing = new Set((base ?? []).map(block => block.id))
  const newItems = items => items.filter(block => !existing.has(block.id))
  const incoming = newItems(remote)
  return newItems(local).some(block => incoming.some(item => block.id !== item.id && boxesOverlap(block, item)))
    ? conflict : merged
}

function mergePage(base, local, remote) {
  // Keep a concurrent typed or ink edit visible for review when either writer
  // moved the same page to/from the recycle bin.
  if (Boolean(base?.deletedAt) !== Boolean(local?.deletedAt) || Boolean(base?.deletedAt) !== Boolean(remote?.deletedAt)) return conflict
  return mergeRecord(base, local, remote, key => {
    if (key === 'blocks') return mergeBlocks
    if (key === 'strokes') return mergeRecords
  })
}

function rebaseDocument(base, local, remote) {
  return mergeValue(base, local, remote, (before, mine, theirs) => mergeRecord(before, mine, theirs, key => {
    if (!collections.includes(key)) return undefined
    return (value, edit, disk) => mergeRecords(value, edit, disk, key === 'pages' ? mergePage : undefined)
  }))
}

export function createLibrary(workspace, request = requestNotes) {
  const listeners = new Set()
  const refreshGuards = new Set()
  let data = null
  let saved = null
  let revision = 0
  let pending = false
  let error
  let timer
  let saving
  let loading
  let refreshing
  let locked = false
  let rebaseWhenIdle = false
  const send = (route, options) => request(workspace, route, options)
  function publish(source, structure) {
    for (const listener of listeners) listener({ data, pending: pending || Boolean(saving), error, source, structure, locked })
  }
  function apply(result) {
    revision = result.revision
    data = saved = withUnchangedPages(data, result.state)
    error = undefined
    rebaseWhenIdle = false
  }
  async function load(force = false) {
    if (loading) return loading
    if (data && !force) return data
    if (saving) {
      await saving.catch(() => {})
      if (loading) return loading
    }
    const before = data
    loading = send('state').then(result => {
      if (data !== before) throw new Error('载入期间有新的本地编辑，请保存后再重新载入。')
      apply(result)
      pending = false
      publish(null, true)
      return data
    }).catch(cause => { error = cause; throw cause }).finally(() => {
      loading = undefined
      publish(null, false)
    })
    return loading
  }

  function guarded(canApply = () => true) {
    return canApply() && [...refreshGuards].every(guard => guard())
  }

  async function refresh({ canApply } = {}) {
    if (rebaseWhenIdle && pending && !saving && !loading && !locked && guarded(canApply)) {
      await save(canApply)
      return true
    }
    const ready = () => data && !pending && !saving && !loading && !locked && guarded(canApply)
    if (!ready()) return false
    if (refreshing) return refreshing
    const since = revision
    refreshing = (async () => {
      const result = await send('state', { query: { since } })
      if (!ready() || revision !== since || result.revision <= since || !result.state) return false
      apply(result)
      publish(null, true)
      return true
    })().finally(() => { refreshing = undefined })
    return refreshing
  }

  async function mergeLatest(canApply) {
    if (!guarded(canApply)) {
      rebaseWhenIdle = true
      return false
    }
    const result = await send('state')
    if (!guarded(canApply)) {
      rebaseWhenIdle = true
      return false
    }
    const resolved = rebaseDocument(saved, data, result.state)
    if (resolved === conflict) return false
    saved = result.state
    revision = result.revision
    data = withUnchangedPages(data, resolved)
    pending = !equal(data, saved)
    error = undefined
    publish(null, true)
    return true
  }

  async function save(canRebase) {
    clearTimeout(timer)
    if (saving) return saving
    if (loading) {
      await loading.catch(() => {})
      return save(canRebase)
    }
    if (!pending) return
    saving = (async () => {
      let attempts = 0
      while (pending) {
        const snapshot = data
        pending = false
        try {
          const result = await send('write', { json: { state: snapshot, expectedRevision: revision } })
          revision = result.revision
          saved = snapshot
          error = undefined
          rebaseWhenIdle = false
          attempts = 0
        } catch (cause) {
          pending = true
          rebaseWhenIdle = false
          if (cause.status === 409 && attempts++ < 2 && await mergeLatest(canRebase).catch(() => false)) continue
          error = cause
          throw cause
        }
      }
    })().finally(() => {
      saving = undefined
      publish(null, false)
    })
    publish(null, false)
    return saving
  }
  function edit(change, source, structure = true) {
    if (!data) throw new Error('笔记载入后即可编辑。')
    if (locked) throw new Error('请等待当前恢复操作完成。')
    const next = change(data)
    if (next === data) return
    data = next
    pending = true
    clearTimeout(timer)
    if (error?.status !== 409) timer = setTimeout(() => save().catch(() => {}), 400)
    publish(source, structure)
  }
  async function restore(route, body) {
    await save()
    locked = true
    publish(null, false)
    try {
      apply(await send(route, { json: { ...body, expectedRevision: revision } }))
    } finally {
      locked = false
      publish(null, true)
    }
  }
  return {
    get data() { return data },
    get error() { return error },
    subscribe(listener, { canRefresh } = {}) {
      listeners.add(listener)
      if (canRefresh) refreshGuards.add(canRefresh)
      return () => { listeners.delete(listener); if (canRefresh) refreshGuards.delete(canRefresh) }
    },
    load, refresh, edit, save, restore, send,
  }
}
