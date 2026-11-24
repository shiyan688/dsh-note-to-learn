import { exportPaperPage } from './paper.js'

export function connectNotePreviews(document, mounted) {
  let disconnect

  function connect() {
    disconnect?.()
    const session = mounted.getSnapshot()
    if (!session) return

    const controller = new AbortController()
    const { signal } = controller
    const query = new URLSearchParams({ session })
    let timer
    const fetchPreview = (route, params, options) => fetch(`/api/dsh-note-to-learn/${route}?${params}`, {
      credentials: 'same-origin', signal, ...options,
    })
    async function poll() {
      try {
        const response = await fetchPreview('preview-job', query)
        if (!response.ok) return
        const job = await response.json()
        if (!job || signal.aborted) return
        const result = new URLSearchParams({ session, id: job.id })
        let blob
        try { blob = await exportPaperPage(document, job.page) } catch { /* An empty result signals a rendering failure. */ }
        if (!signal.aborted) await fetchPreview('preview-result', result, { method: 'POST', body: blob })
      } catch { /* The view or host may disconnect between requests. */ }
      finally {
        if (!signal.aborted) timer = setTimeout(poll, 2000)
      }
    }
    disconnect = () => { controller.abort(); clearTimeout(timer) }
    poll()
  }

  const unsubscribe = mounted.subscribe(connect)
  connect()
  return () => { unsubscribe(); disconnect?.() }
}
