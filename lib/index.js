import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { createStore } from './store.js'
import { recognizeImage } from './ocr.js'
import { registerNoteTools } from './note-tools.js'

export const name = 'dsh-note-to-learn'
const api = '/api/dsh-note-to-learn/'
const maxDocument = 128 * 1024 * 1024
const maxImage = 16 * 1024 * 1024
const require = createRequire(import.meta.url)
const pdfAssets = dirname(require.resolve('pdfjs-dist/package.json'))
const assetTypes = new Map([
  ['mjs', 'text/javascript; charset=utf-8'], ['wasm', 'application/wasm'],
  ['bcmap', 'application/octet-stream'], ['ttf', 'font/ttf'], ['pfb', 'application/octet-stream'],
])

function json(status, value) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function error(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

async function readBody(request, maxBytes) {
  if (Number(request.headers.get('content-length')) > maxBytes) {
    throw error(413, 'body_limit', '文件或笔记数据超出单次处理上限。')
  }
  const chunks = []
  let size = 0
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength
    if (size > maxBytes) throw error(413, 'body_limit', '文件或笔记数据超出单次处理上限。')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

async function readDocument(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw error(415, 'expected_json', '请求必须使用 JSON 格式。')
  }
  const bytes = await readBody(request, maxDocument)
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch { /* Normalize parse failures to the same response. */ }
  throw error(400, 'invalid_json', '无法读取笔记数据。')
}

async function pdfAsset(request, query) {
  const file = query.get('file') ?? ''
  if (file !== 'build/pdf.worker.min.mjs' && !/^(?:cmaps|standard_fonts|wasm)\/[a-z0-9_.-]+\.(?:bcmap|ttf|pfb|wasm|mjs)$/i.test(file)) {
    throw error(404, 'asset_missing', '未找到 PDF 资源。')
  }
  const location = join(pdfAssets, ...file.split('/'))
  const entry = await stat(location).catch(cause => {
    if (cause.code === 'ENOENT') throw error(404, 'asset_missing', '未找到 PDF 资源。')
    throw cause
  })
  if (!entry.isFile()) throw error(404, 'asset_missing', '未找到 PDF 资源。')
  const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(location))
  return new Response(body, { headers: {
    'content-type': assetTypes.get(file.split('.').at(-1).toLowerCase()),
    'content-length': String(entry.size),
    'cache-control': 'private, max-age=86400',
    'x-content-type-options': 'nosniff',
  } })
}

export function registerNoteRoutes(registry, notes, logger) {
  const routes = [
    ['state', ['GET'], (_request, query, workspace) => {
      const value = query.get('since')
      return value !== null && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value))
        ? notes.read(workspace, { since: Number(value) })
        : notes.read(workspace)
    }],
    ['write', ['POST'], async (request, _query, workspace) => notes.write(workspace, await readDocument(request))],
    ['history', ['GET'], (_request, query, workspace) => notes.history(workspace, query.get('page'))],
    ['restore', ['POST'], async (request, _query, workspace) => notes.restore(workspace, await readDocument(request))],
    ['backup', ['GET'], (_request, _query, workspace) => notes.backup(workspace)],
    ['backup-restore', ['POST'], async (request, _query, workspace) => notes.restoreBackup(workspace, await readDocument(request))],
    ['asset', ['GET', 'HEAD'], pdfAsset],
    ['ocr', ['POST'], async (request, query) => {
      const mime = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      if (mime !== 'image/png' && mime !== 'image/jpeg') {
        throw error(415, 'expected_image', '文字识别支持 PNG 和 JPEG。')
      }
      return { text: await recognizeImage(await readBody(request, maxImage), mime, query.get('lang'), request.signal) }
    }],
  ]
  return routes.map(([route, methods, handler]) => registry.register({
    path: api + route,
    methods,
    requestBody: methods.includes('POST') ? 'streaming' : 'buffered',
    async fetch(request) {
      try {
        const query = new URL(request.url).searchParams
        const workspace = query.get('workspace')
        if (route !== 'asset' && (!workspace || workspace.length > 1024)) {
          throw error(400, 'workspace_required', '请先打开一个 DSH 工作区。')
        }
        const value = await handler(request, query, workspace)
        return value instanceof Response ? value : json(200, value)
      } catch (cause) {
        if (cause.status >= 400 && cause.status < 500) {
          return json(cause.status, { code: cause.code, error: cause.message })
        }
        logger?.warn?.('dsh-note-to-learn request failed: %s', cause.code ?? cause.name ?? 'error')
        return json(500, { code: 'note_request_failed', error: '笔记操作失败，请检查宿主日志后重试。' })
      }
    },
  }))
}

export function apply(ctx) {
  const dataDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', name)
  const notes = createStore({ dataDir })
  ctx.inject(['connection'], owner => {
    registerNoteRoutes(owner.connection.fetch, notes, owner.logger)
  })
  ctx.inject(['tools'], owner => {
    registerNoteTools(owner.tools, notes)
  })
}
