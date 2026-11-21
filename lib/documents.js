import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import { PDFDocument } from 'pdf-lib'

const assets = '/api/dsh-note-to-learn/asset?file='
const maxPdfBytes = 36 * 1024 * 1024

export function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export function download(blob, filename) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 20_000)
}

export function encodeCanvas(canvas, mime = 'image/png', quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成图片。')), mime, quality))
}

export async function readPdf(file, progress = () => {}) {
  if (file.size > maxPdfBytes) throw new Error('请导入 36 MiB 以内的 PDF。')
  GlobalWorkerOptions.workerSrc = new URL(`${assets}build/pdf.worker.min.mjs`, location.href).href
  const assetUrl = path => new URL(`${assets}${path}/`, location.href).href
  const loading = getDocument({
    data: await file.arrayBuffer(),
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    isEvalSupported: false,
    useWorkerFetch: false,
  })
  try {
    const doc = await loading.promise
    const result = []
    let encodedBytes = 0
    for (let number = 1; number <= doc.numPages; number++) {
      progress(number, doc.numPages)
      const pdfPage = await doc.getPage(number)
      const natural = pdfPage.getViewport({ scale: 1 })
      const viewport = pdfPage.getViewport({ scale: Math.min(2, 1680 / Math.max(natural.width, natural.height)) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      await pdfPage.render({ canvas, viewport, background: '#fff' }).promise
      const raster = canvas.toDataURL('image/jpeg', 0.86)
      encodedBytes += raster.length
      if (encodedBytes > 70 * 1024 * 1024) throw new Error('图片化后的 PDF 超出单次导入大小，请先按页拆分。')
      const text = await pdfPage.getTextContent()
      const width = Math.round(Math.max(260, Math.min(940, natural.width * 1.2)))
      const height = Math.max(180, Math.round(width * natural.height / natural.width))
      result.push({
        width, height,
        text: text.items.map(item => typeof item.str === 'string' ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim(),
        dataUrl: raster, pageNumber: number,
      })
      canvas.width = 0
      pdfPage.cleanup()
    }
    return result
  } finally {
    await loading.destroy()
  }
}

export async function makePdf(pages, rasterize) {
  const document = await PDFDocument.create()
  for (const page of pages) {
    const image = await document.embedPng(await (await rasterize(page)).arrayBuffer())
    const scale = Math.min(1, 1000 / Math.max(image.width, image.height))
    const size = image.scale(scale)
    const sheet = document.addPage([size.width, size.height])
    sheet.drawImage(image, { x: 0, y: 0, ...size })
  }
  return new Blob([await document.save()], { type: 'application/pdf' })
}
