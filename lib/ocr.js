import { Worker } from 'node:worker_threads'

const maxBytes = 16 * 1024 * 1024
const maxPixels = 32 * 1024 * 1024
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const jpegFrames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
let busy = false

function requestError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

function exifOrientation(bytes, start, end) {
  if (start + 14 > end || bytes.toString('ascii', start, start + 6) !== 'Exif\0\0') return 1
  const base = start + 6
  const order = bytes.toString('ascii', base, base + 2)
  if (order !== 'II' && order !== 'MM') return 1
  const short = order === 'II' ? offset => bytes.readUInt16LE(offset) : offset => bytes.readUInt16BE(offset)
  const long = order === 'II' ? offset => bytes.readUInt32LE(offset) : offset => bytes.readUInt32BE(offset)
  if (short(base + 2) !== 42) return 1
  const directory = base + long(base + 4)
  if (directory + 2 > end) return 1
  const entries = short(directory)
  for (let entry = 0, offset = directory + 2; entry < entries && offset + 12 <= end; entry++, offset += 12) {
    if (short(offset) !== 0x0112 || short(offset + 2) !== 3 || long(offset + 4) !== 1) continue
    const orientation = short(offset + 8)
    return orientation >= 1 && orientation <= 8 ? orientation : 1
  }
  return 1
}

function jpegMetadata(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return
  let offset = 2
  let orientation = 1
  while (offset + 3 < bytes.length && bytes[offset] === 0xff) {
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) return
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const size = bytes.readUInt16BE(offset)
    const end = offset + size
    if (size < 2 || end > bytes.length) return
    if (marker === 0xe1) orientation = exifOrientation(bytes, offset + 2, end)
    if (jpegFrames.has(marker) && size >= 8) {
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3), orientation }
    }
    offset = end
  }
}

function imageMetadata(bytes, mime) {
  if (mime === 'image/jpeg') return jpegMetadata(bytes)
  if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(pngSignature) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), orientation: 1 }
  }
}

export async function recognizeImage(bytes, mime, language, signal) {
  if (busy) throw requestError(429, 'ocr_busy', '正在识别上一张图片，请稍后重试。')
  if (bytes.byteLength > maxBytes) throw requestError(413, 'body_limit', '图片超出单次识别大小上限。')
  const metadata = imageMetadata(bytes, mime)
  if (!metadata?.width || !metadata.height) {
    throw requestError(400, 'invalid_image', '无法读取这张图片。')
  }
  if (metadata.width * metadata.height > maxPixels) {
    throw requestError(413, 'image_dimensions', '图片尺寸超出识别上限，请缩小或分块截图。')
  }

  signal?.throwIfAborted()
  busy = true
  let worker
  let cancel
  try {
    const image = Uint8Array.from(bytes)
    worker = new Worker(new URL('./ocr-worker.js', import.meta.url), {
      execArgv: [],
      workerData: { image, orientation: metadata.orientation, language: language === 'eng' ? 'eng' : 'chi_sim' },
      transferList: [image.buffer],
    })
    return await new Promise((resolve, reject) => {
      worker.once('message', ({ text, error }) => {
        if (error) reject(requestError(error.status, error.code, error.message))
        else resolve(text)
      })
      worker.once('error', reject)
      worker.once('exit', code => reject(new Error('OCR worker exited with code ' + code)))
      cancel = () => reject(signal.reason)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel)
    try { await worker?.terminate() } finally { busy = false }
  }
}
