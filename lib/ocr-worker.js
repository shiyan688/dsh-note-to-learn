import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parentPort, workerData } from 'node:worker_threads'
import { gunzip } from 'node:zlib'
import chinese from '@tesseract.js-data/chi_sim'
import english from '@tesseract.js-data/eng'
import createTesseract from 'tesseract.js-core/tesseract-core-lstm.js'

const decompress = promisify(gunzip)
const { image, orientation, language } = workerData
const { code, langPath } = language === 'eng' ? english : chinese
const [core, trainedData] = await Promise.all([
  createTesseract(),
  readFile(join(langPath, code + '.traineddata.gz')).then(decompress),
])

core.FS.writeFile('/' + code + '.traineddata', trainedData)
const api = new core.TessBaseAPI()
try {
  const lstmOnly = 1
  if (api.Init(null, code, lstmOnly, undefined) !== 0) throw new Error('Unable to initialize the OCR engine.')
  core.FS.writeFile('/input', image)
  if (api.SetImageFile(orientation, 0) !== 0) {
    parentPort.postMessage({ error: { status: 400, code: 'invalid_image', message: '无法读取这张图片。' } })
  } else {
    const uniformTextBlock = 6
    api.SetVariable('tessedit_pageseg_mode', String(uniformTextBlock))
    if (api.Recognize(null) !== 0) throw new Error('OCR engine could not recognize the image.')
    parentPort.postMessage({ text: api.GetUTF8Text().trim() })
  }
} finally {
  api.End()
  api.delete()
}
