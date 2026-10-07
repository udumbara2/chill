import type { Message } from '../../types/models'
import { ModelModality } from '../../types/models'
import { ModelServiceFactory } from '../models/modelServiceFactory'
import { modelInfoService } from '../models/modelInfoService'
import { SelectedModelsService } from '../selectedModelsService'
import { bytesToBase64 } from '../mediaContentBuilder'

/**
 * 图片 / 扫描 PDF 的 OCR 抽取（二期任务 5，设计见 iDream/知识管理.md 第八节任务 5）。
 *
 * 路线：图片字节 → data URL → 多模态聊天模型转写为文字（走 ModelServiceFactory.sendChatMessage，
 * 与 summaryEnricher 同款调用路径，ContentPart image_url 即 core 现有多模态消息构造）。
 *
 * 扫描 PDF 的取图用 **pdfjs operatorList 抽取页内嵌图片**（paintImageXObject / paintInlineImageXObject），
 * 严禁页面渲染成图——canvas 需原生依赖，破坏三端同码。
 * 内嵌图片三种形态统一处理：JPEG/PNG 原始字节直接透传；解码后的位图（RGBA/RGB/灰度/1bpp）
 * 用内置纯 JS PNG 编码器（stored deflate，零依赖）转成 PNG 再送模型。
 *
 * 失败降级契约：单张图转写失败收集告警、不阻塞其余图片；全部失败或无可用视觉模型时抛中文指引错误。
 */

/** 一张待 OCR 的图片（字节 + MIME） */
export interface OcrImage {
  data: Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
}

/** OCR 结果：逐图转写文本已拼接；warnings 为单图失败降级告警 */
export interface OcrResult {
  text: string
  warnings: string[]
}

const OCR_PROMPT = `请把这张图片中的文字内容完整转写为纯文本。
要求：忠实原文，不要概括或改写；保留段落换行；表格按行转写、列间用制表符分隔；图片中没有文字时只回答"（无文字）"。`

/**
 * 解析可用的视觉模型：优先用户当前选中的模型（带 image 模态即可，与"直接送用户已选的多模态模型"
 * 的设计一致）；当前模型不支持看图时，退到第一个带 image 模态且已配 API Key 的模型。
 * 都没有返回 null，由调用方给中文指引。
 */
export async function resolveVisionModel(): Promise<string | null> {
  const current = SelectedModelsService.getInstance().getCurrentModelName()
  if (current) {
    const info = modelInfoService.getModelInfoByName(current)
    if (info?.supportedModalities.includes(ModelModality.IMAGE)) return current
  }
  const withKeys = await modelInfoService.getModelsWithApiKeys()
  const vision = withKeys.find(m => m.supportedModalities.includes(ModelModality.IMAGE))
  return vision?.name ?? null
}

/**
 * 逐张送视觉模型转写（顺序执行，控制并发与成本）。单张失败只记告警继续；
 * 全部失败/空文本时返回的 text 为空串，由调用方决定报错。
 */
export async function transcribeImages(images: OcrImage[], modelName: string): Promise<OcrResult> {
  const warnings: string[] = []
  const texts: string[] = []
  for (let i = 0; i < images.length; i++) {
    const label = `第 ${i + 1}/${images.length} 张图`
    try {
      const dataUrl = `data:${images[i].mimeType};base64,${bytesToBase64(images[i].data)}`
      const messages: Message[] = [
        {
          role: 'user' as Message['role'],
          content: [
            { type: 'text', text: OCR_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
          timestamp: new Date(),
        },
      ]
      const response = await ModelServiceFactory.getInstance().sendChatMessage(modelName, messages, {})
      const text = (response?.content ?? '').trim()
      if (!text || text === '（无文字）') {
        warnings.push(`${label}未转写出文字（模型返回为空或图中无文字）`)
        continue
      }
      texts.push(text)
    } catch (e) {
      warnings.push(`${label}转写失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { text: texts.join('\n\n'), warnings }
}

// ==================== 纯 JS PNG 编码器（stored deflate，零依赖） ====================

/** CRC32（PNG 块校验用，标准多项式 0xEDB88320） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const out = new Uint8Array(4 + 4 + data.length + 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  const crcInput = out.subarray(4, 8 + data.length)
  view.setUint32(8 + data.length, crc32(crcInput))
  return out
}

/** zlib 封装（stored 块：不压缩，免去 deflate 实现/依赖；体积略大，OCR 场景可接受） */
function zlibStored(data: Uint8Array): Uint8Array {
  const BLOCK = 65535
  const blockCount = Math.ceil(data.length / BLOCK) || 1
  const out = new Uint8Array(2 + blockCount * 5 + data.length + 4)
  const view = new DataView(out.buffer)
  out[0] = 0x78 // zlib header：deflate，32K 窗口
  out[1] = 0x01 // 不压缩标记的校验位组合（(0x78*256+0x01) % 31 === 0）
  let offset = 2
  for (let i = 0; i < blockCount; i++) {
    const chunk = data.subarray(i * BLOCK, Math.min((i + 1) * BLOCK, data.length))
    out[offset] = i === blockCount - 1 ? 0x01 : 0x00 // BFINAL
    view.setUint16(offset + 1, chunk.length, true)
    view.setUint16(offset + 3, ~chunk.length & 0xffff, true)
    out.set(chunk, offset + 5)
    offset += 5 + chunk.length
  }
  view.setUint32(offset, adler32(data), false)
  return out
}

/**
 * 位图字节 → PNG。channels：4=RGBA / 3=RGB / 1=8 位灰度。
 * scanline 逐行加 filter 0 字节后经 stored zlib 封装，无压缩亦无第三方依赖（三端同码）。
 */
export function encodePng(width: number, height: number, data: Uint8Array, channels: 1 | 3 | 4): Uint8Array {
  const colorType = channels === 4 ? 6 : channels === 3 ? 2 : 0
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width, false)
  ihdrView.setUint32(4, height, false)
  ihdr[8] = 8 // bit depth
  ihdr[9] = colorType
  // 10/11/12：compression/filter/interlace 均 0

  const stride = width * channels
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const idat = pngChunk('IDAT', zlibStored(raw))
  const head = pngChunk('IHDR', ihdr)
  const end = pngChunk('IEND', new Uint8Array(0))
  const png = new Uint8Array(signature.length + head.length + idat.length + end.length)
  png.set(signature, 0)
  png.set(head, signature.length)
  png.set(idat, signature.length + head.length)
  png.set(end, signature.length + head.length + idat.length)
  return png
}

/** 1bpp 打包位图（pdfjs ImageKind.GRAYSCALE_1BPP）展开为 8 位灰度 */
function unpack1bpp(data: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = Math.ceil(width / 8)
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = data[y * rowBytes + (x >> 3)] ?? 0
      out[y * width + x] = byte & (0x80 >> (x & 7)) ? 0xff : 0x00
    }
  }
  return out
}

/** pdfjs 图片对象 → 待 OCR 图片；无法识别的形态返回 null（调用方记告警） */
function normalizePdfImage(img: { data?: Uint8Array | Uint8ClampedArray; width?: number; height?: number; kind?: number }): OcrImage | null {
  const { data, width, height } = img
  if (!data || !width || !height) return null
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  // JPEG / PNG 原始字节透传（部分 JPEG 图片的 data 即编码字节，无需再转码）
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { data: bytes, mimeType: 'image/jpeg' }
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { data: bytes, mimeType: 'image/png' }
  // 解码位图：按 kind（pdfjs ImageKind：1=1bpp 灰度，2=RGB，3=RGBA）或长度推断通道数
  if (img.kind === 1 || bytes.length === Math.ceil(width / 8) * height) {
    return { data: encodePng(width, height, unpack1bpp(bytes, width, height), 1), mimeType: 'image/png' }
  }
  if (img.kind === 3 || bytes.length === width * height * 4) {
    return { data: encodePng(width, height, bytes, 4), mimeType: 'image/png' }
  }
  if (img.kind === 2 || bytes.length === width * height * 3) {
    return { data: encodePng(width, height, bytes, 3), mimeType: 'image/png' }
  }
  if (bytes.length === width * height) {
    return { data: encodePng(width, height, bytes, 1), mimeType: 'image/png' }
  }
  return null
}

// ==================== pdfjs operatorList 抽取页内嵌图片 ====================

/** pdfjs 懒加载（与 ingestPipeline 同一 legacy build；此处独立缓存避免模块环依赖） */
let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null

function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsPromise
}

/** pdfjs 页对象的最小结构（只列本模块用到的成员，避免绑死 pdfjs 内部类型的导出路径） */
interface PdfPageLike {
  objs: { get(name: string, callback?: (obj: unknown) => void): unknown }
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
  cleanup(): void
}

/** objs.get 的回调形式包成 Promise（图片对象可能尚未解析完成，直接 get 会抛 Unknown object） */
function getObj(page: PdfPageLike, name: string): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      const direct = page.objs.get(name)
      if (direct !== undefined) {
        resolve(direct)
        return
      }
    } catch {
      // 未解析：走回调等待
    }
    try {
      page.objs.get(name, (obj: unknown) => resolve(obj))
    } catch {
      resolve(null)
    }
  })
}

/**
 * 抽取 PDF 全部页内嵌图片（operatorList 走查，非渲染路径）。
 * 单页/单图失败收集告警继续；返回按页序排列的图片列表（供逐张 OCR）。
 */
export async function extractPdfEmbeddedImages(
  pdfBuffer: Uint8Array | ArrayBuffer
): Promise<{ images: OcrImage[]; warnings: string[] }> {
  const pdfjs = await loadPdfjs()
  const warnings: string[] = []
  // 复制一份再交给 pdfjs（getDocument 会 transfer/neuter 传入 buffer，同 extractPdfText 的处理）
  const src = pdfBuffer instanceof Uint8Array ? pdfBuffer : new Uint8Array(pdfBuffer)
  const data = new Uint8Array(src)
  const loadingTask = pdfjs.getDocument({ data, useWorkerFetch: false, disableFontFace: true })
  try {
    const doc = await loadingTask.promise
    const images: OcrImage[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      let page: PdfPageLike
      try {
        page = await doc.getPage(p) as unknown as PdfPageLike
      } catch (e) {
        warnings.push(`第 ${p} 页打开失败: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      try {
        const opList = await page.getOperatorList()
        const seen = new Set<string>() // 页内按对象名去重（同一图多次引用只取一次）
        for (let i = 0; i < opList.fnArray.length; i++) {
          const fn = opList.fnArray[i]
          // pdfjs 6.x 已无独立 paintJpegXObject（JPEG 也走 paintImageXObject，
          // 是否原始字节由 normalizePdfImage 按 SOI 魔数判别）
          const isXObject = fn === pdfjs.OPS.paintImageXObject
          const isInline = fn === pdfjs.OPS.paintInlineImageXObject
          if (!isXObject && !isInline) continue
          try {
            // XObject 按名取对象；内联图片的对象直接在 args[0]
            const raw = isInline ? opList.argsArray[i][0] : await getObj(page, String(opList.argsArray[i][0]))
            const name = isInline ? `inline#${i}` : String(opList.argsArray[i][0])
            if (seen.has(name)) continue
            seen.add(name)
            const image = normalizePdfImage((raw ?? {}) as { data?: Uint8Array; width?: number; height?: number; kind?: number })
            if (image) images.push(image)
            else warnings.push(`第 ${p} 页一张图片格式无法识别，已跳过`)
          } catch (e) {
            warnings.push(`第 ${p} 页一张图片抽取失败: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      } catch (e) {
        warnings.push(`第 ${p} 页图片抽取失败: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        page.cleanup()
      }
    }
    return { images, warnings }
  } catch (e) {
    throw new Error(`PDF 解析失败: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    await loadingTask.destroy()
  }
}
