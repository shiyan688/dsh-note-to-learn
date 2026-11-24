import { randomUUID } from 'node:crypto'

const previewUnavailable = message => ({ status: 'unavailable', message })

export function createNotePreviews() {
  const jobs = new Map()
  function claimed(sessionId, id) {
    const job = jobs.get(id)
    return job?.sessionId === sessionId && job.claimed
  }

  return {
    request(sessionId, page, signal) {
      signal?.throwIfAborted()
      const id = randomUUID()
      return new Promise(resolve => {
        const job = {
          sessionId,
          page,
          claimed: false,
          finish(data) {
            if (!jobs.delete(id)) return
            clearTimeout(timer)
            signal?.removeEventListener('abort', cancel)
            resolve(data)
          },
        }
        const cancel = () => job.finish()
        const timer = setTimeout(cancel, 12_000)
        timer.unref?.()
        jobs.set(id, job)
        signal?.addEventListener('abort', cancel, { once: true })
      })
    },
    take(sessionId) {
      for (const [id, job] of jobs) {
        if (job.sessionId !== sessionId || job.claimed) continue
        job.claimed = true
        return { id, page: job.page }
      }
      return null
    },
    claimed,
    complete(sessionId, id, data) {
      if (claimed(sessionId, id)) jobs.get(id).finish(data)
    },
    clear() {
      for (const job of jobs.values()) job.finish()
    },
  }
}

export async function renderNotePreview(page, exec, getService, previews) {
  const agent = exec.agent
  const session = agent?.session
  const sessionId = session?.header?.id ?? session?.id
  const route = session?.requestHeader?.()?.config
  const provider = route?.provider ?? agent?.options?.provider
  const model = route?.model ?? agent?.options?.model
  const llm = getService('llm')
  const attachments = getService('attachments')
  if (!sessionId || !llm || !provider || !model || !attachments?.imageLimits?.mediaTypes?.includes('image/png')) {
    return previewUnavailable('A connected session with an image-capable model and PNG attachments is required to inspect the note preview.')
  }

  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    if (!info?.inputModalities?.includes('image')) {
      return previewUnavailable('The active model does not accept images. Use an image-capable model to verify the page visually.')
    }
    const data = await previews.request(sessionId, page, exec.signal)
    exec.signal?.throwIfAborted()
    if (data === null) return previewUnavailable('DSH could not render this page. Retry the preview before reporting that the layout was verified.')
    if (!data) return previewUnavailable('The session needs a connected DSH Desktop or web view to render the note preview. Open this session and retry.')
    const { maxImageBytes, maxMessageImageBytes } = attachments.imageLimits
    if (data.byteLength > Math.min(maxImageBytes, maxMessageImageBytes)) {
      return previewUnavailable('The rendered note preview exceeds the session attachment size limit.')
    }
    const { attachmentId, mediaType, bytes, width, height, originalDimensions } = await attachments.saveImage({
      data, mediaType: 'image/png', name: 'note-preview.png',
    })
    return {
      status: 'ready',
      attachment: { attachmentId, mediaType, bytes, width, height, name: 'note-preview.png',
        ...(originalDimensions ? { originalDimensions } : {}) },
    }
  } catch {
    exec.signal?.throwIfAborted()
    return previewUnavailable('DSH could not attach the rendered preview. Retry the preview before reporting that the layout was verified.')
  }
}
