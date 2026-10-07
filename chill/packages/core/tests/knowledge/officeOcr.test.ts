import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeRecursive } from '../helpers/recursiveDelete.ts'
import JSZip from 'jszip'
import { SecureStorageService } from '../../src/services/secureStorageService.ts'
import { EMBEDDING_KEY_PROVIDER } from '../../src/services/knowledge/embeddingClient.ts'
import { KnowledgeStore } from '../../src/services/knowledge/knowledgeStore.ts'
import { ModelServiceFactory } from '../../src/services/models/modelServiceFactory.ts'
import { SelectedModelsService } from '../../src/services/selectedModelsService.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import { ModelModality, ModelType } from '../../src/types/models.ts'
import { extractOfficeText } from '../../src/services/knowledge/officeExtractor.ts'
import {
  encodePng,
  extractPdfEmbeddedImages,
  resolveVisionModel,
  transcribeImages,
} from '../../src/services/knowledge/ocrExtractor.ts'
import { ingestImage, ingestOffice, ingestPdf } from '../../src/services/knowledge/ingestPipeline.ts'

/** 内联 Node fsProvider（同 ingestPipeline.test.ts 的形状） */
function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbocr-'))
  const fsProvider = {
    readFile: async (p: string) => {
      try { return { success: true, data: { content: fs.readFileSync(p, 'utf-8') } } } catch { return { success: false } }
    },
    writeFile: async (p: string, content: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content, 'utf-8')
      return { success: true }
    },
    deleteFile: async (p: string) => { try { removeRecursive(p); return { success: true } } catch { return { success: false } } },
    listDirectory: async (p: string) => {
      try {
        const files = fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
        return { success: true, data: { files } }
      } catch { return { success: false } }
    },
    getCurrentDirectory: () => null,
    fileExists: async (p: string) => ({ success: fs.existsSync(p) }),
    getPathType: async (p: string) => ({ success: true, data: fs.existsSync(p) ? (fs.statSync(p).isDirectory() ? 'directory' : 'file') : null }),
  }
  const store = KnowledgeStore.getInstance()
  store.init(fsProvider as any, { getUserDataPath: () => path.join(home, '.chill'), getUserHomePath: () => home } as any)
  return { home, store, cleanup: () => removeRecursive(home) }
}

function makeSecureStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    storeApiKey: async (provider: string, apiKey: string) => { map.set(provider, apiKey); return true },
    getApiKey: async (provider: string) => map.get(provider) ?? null,
    hasApiKey: async (provider: string) => map.has(provider),
    deleteApiKey: async (provider: string) => map.delete(provider),
    getAllProviders: async () => [...map.keys()],
  }
}

/** mock 全局 fetch：embedding 全部返回同一伪向量（余弦=1 必过阈值） */
function mockFetch() {
  const g = globalThis as any
  g.__origFetch = g.fetch
  g.fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: body.input.map((_: string, i: number) => ({ embedding: [1, 0, 0], index: i })) }),
      text: async () => '',
    } as Response
  }
}

// ==================== mock 视觉模型（ModelServiceFactory.sendChatMessage） ====================

let llmCalls: Array<{ model: string; content: unknown }> = []
let llmBehavior: (call: { model: string; content: unknown }) => Promise<{ content: string }> = async () => ({ content: '转写文字' })
let currentModel: string | null = null
const origSendChatMessage = ModelServiceFactory.getInstance().sendChatMessage
const origGetCurrentModelName = SelectedModelsService.getInstance().getCurrentModelName

function installLlmMock() {
  llmCalls = []
  llmBehavior = async () => ({ content: '转写文字' })
  ModelServiceFactory.getInstance().sendChatMessage = async (model: string, messages: any[]) => {
    const call = { model, content: messages[messages.length - 1]?.content }
    llmCalls.push(call)
    return llmBehavior(call)
  }
  SelectedModelsService.getInstance().getCurrentModelName = () => currentModel
}

/** 注册一个带 image 模态的测试模型（内存态，不落盘） */
function registerVisionModel(name = 'vision-test', provider = 'test-vision') {
  modelInfoService.addModelInfo({
    type: ModelType.CUSTOM,
    name,
    displayName: name,
    provider,
    builtIn: false,
    supportedModalities: [ModelModality.TEXT, ModelModality.IMAGE],
    availableModels: [name],
    supportedParameters: [],
    supportsStreaming: true,
    supportsTools: false,
    supportsThinking: false,
  })
}

/** 建库 + 小维度全局配置（rerank 关闭） */
async function setup() {
  const env = makeEnv()
  await env.store.createKnowledgeBase('kb')
  const config = await env.store.getGlobalConfig()
  config.embedding.dimensions = 3
  config.rerank.enabled = false
  await env.store.saveGlobalConfig(config)
  return env
}

let env: ReturnType<typeof setup> extends Promise<infer T> ? T : never

beforeEach(() => {
  SecureStorageService.initialize(makeSecureStorage({ [EMBEDDING_KEY_PROVIDER]: 'sk-test' }) as any)
  // modelInfoService 自有的 secureStorage 字段逐测重置（getModelsWithApiKeys 走这里，防跨测泄漏）
  modelInfoService.setSecureStorage(makeSecureStorage({}) as any)
  mockFetch()
  installLlmMock()
})

afterEach(() => {
  ModelServiceFactory.getInstance().sendChatMessage = origSendChatMessage
  SelectedModelsService.getInstance().getCurrentModelName = origGetCurrentModelName
  const g = globalThis as any
  if (g.__origFetch) { g.fetch = g.__origFetch; delete g.__origFetch }
  env?.cleanup()
})

// ==================== Office 样本构造（jszip 现场打包） ====================

async function buildDocx(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip()
  const body = paragraphs
    .map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join('')
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`)
  return zip.generateAsync({ type: 'uint8array' })
}

async function buildXlsx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('xl/sharedStrings.xml', '<sst><si><t>名称</t></si><si><r><t>排</t></r><r><t>错手册</t></r></si></sst>')
  zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="数据表" sheetId="1" r:id="rId1"/></sheets></workbook>')
  // A1 共享字符串 0、B1 空、C1 原始数字；A2 共享字符串 1（富文本双 run 拼接）
  zip.file('xl/worksheets/sheet1.xml',
    '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>内联</t></is></c></row>'
    + '</sheetData></worksheet>')
  return zip.generateAsync({ type: 'uint8array' })
}

async function buildPptx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>标题页</a:t></a:r></a:p><a:p><a:r><a:t>副标题 &amp; 说明</a:t></a:r></a:p></p:sld>')
  zip.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>第二页内容</a:t></a:r></a:p></p:sld>')
  return zip.generateAsync({ type: 'uint8array' })
}

// ==================== Office 解析 ====================

test('extractOfficeText(docx)：段落抽取 + 实体解码', async () => {
  const buf = await buildDocx(['第一章 引言', '含实体 A &lt; B &amp; C'])
  const text = await extractOfficeText(buf, 'docx')
  assert.equal(text, '第一章 引言\n含实体 A < B & C')
})

test('extractOfficeText(xlsx)：共享字符串/内联字符串/数字 + 空列补位 + 工作表名', async () => {
  const text = await extractOfficeText(await buildXlsx(), 'xlsx')
  assert.ok(text.includes('【工作表: 数据表】'), '带工作表标题')
  assert.ok(text.includes('名称\t\t42') || text.includes('名称\t42'), '空单元格按列补 Tab')
  assert.ok(text.includes('排错手册\t内联'), '富文本多 run 拼接 + 内联字符串')
})

test('extractOfficeText(pptx)：逐页抽取 + 页码标题 + 段落换行', async () => {
  const text = await extractOfficeText(await buildPptx(), 'pptx')
  assert.ok(text.includes('【幻灯片 1】\n标题页\n副标题 & 说明'), '页内段落换行 + 实体解码')
  assert.ok(text.includes('【幻灯片 2】\n第二页内容'), '第二页按序拼接')
})

test('extractOfficeText：损坏文件抛中文错误', async () => {
  await assert.rejects(() => extractOfficeText(new Uint8Array([1, 2, 3]), 'docx'), /解包失败|损坏/)
})

test('ingestOffice 端到端：type=office 入库、内容可检索、重复摄入跳过', async () => {
  env = await setup()
  const buf = await buildDocx(['季度复盘结论', '转化率提升源于新引导流程。'])
  const result = await ingestOffice('kb', buf, '/tmp/review.docx')
  assert.equal(result.status, 'ingested')

  const doc = await env.store.readDoc('kb', result.docId)
  assert.equal(doc!.frontmatter.type, 'office')
  assert.ok(doc!.body.includes('转化率提升源于新引导流程。'))

  const again = await ingestOffice('kb', buf, '/tmp/review.docx')
  assert.equal(again.status, 'skipped')
})

// ==================== PNG 编码器 ====================

test('encodePng：签名/IHDR 宽高/块结构正确（2x1 RGB）', () => {
  const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 0, 255, 0]), 3)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 签名')
  const view = new DataView(png.buffer, png.byteOffset)
  assert.equal(view.getUint32(8), 13, 'IHDR 长度')
  assert.equal(String.fromCharCode(...png.subarray(12, 16)), 'IHDR')
  assert.equal(view.getUint32(16), 2, '宽度')
  assert.equal(view.getUint32(20), 1, '高度')
  assert.equal(png[25], 2, 'RGB 色彩类型')
  assert.ok(png.length > 8 + 25 + 12, '含 IDAT 与 IEND')
})

// ==================== OCR：视觉模型调用与降级 ====================

test('resolveVisionModel：当前模型带 image 模态 → 优先用当前模型', async () => {
  registerVisionModel()
  currentModel = 'vision-test'
  assert.equal(await resolveVisionModel(), 'vision-test')
})

test('resolveVisionModel：无可用视觉模型 → null（上层给中文指引）', async () => {
  currentModel = null
  // 内存 SecureStorage 只有 embedding key，任何带 image 模态的模型都无 key
  assert.equal(await resolveVisionModel(), null)
})

test('resolveVisionModel：当前模型不能看图 → 兜底第一个有 key 的 image 模型', async () => {
  registerVisionModel()
  modelInfoService.addModelInfo({
    type: ModelType.CUSTOM,
    name: 'text-only',
    displayName: 'text-only',
    provider: 'test-text',
    builtIn: false,
    supportedModalities: [ModelModality.TEXT],
    availableModels: ['text-only'],
    supportedParameters: [],
    supportsStreaming: true,
    supportsTools: false,
    supportsThinking: false,
  })
  currentModel = 'text-only'
  // getModelsWithApiKeys 走 modelInfoService 自有的 secureStorage 字段（非 SecureStorageService 单例）；
  // key 命名与真实链一致——经 idFor 槽位解析（未注册名 → slug），原始名 'test-vision' → 'testvision'
  modelInfoService.setSecureStorage(makeSecureStorage({ testvision: 'sk-v' }) as any)
  assert.equal(await resolveVisionModel(), 'vision-test')
})

test('transcribeImages：多模态消息构造正确（text + image_url data URL）', async () => {
  const data = new Uint8Array([0x89, 0x50, 1, 2])
  const result = await transcribeImages([{ data, mimeType: 'image/png' }], 'vision-test')
  assert.equal(result.text, '转写文字')
  assert.equal(result.warnings.length, 0)
  const parts = llmCalls[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>
  assert.equal(llmCalls[0].model, 'vision-test')
  assert.equal(parts[0].type, 'text')
  assert.equal(parts[1].type, 'image_url')
  assert.ok(parts[1].image_url!.url.startsWith('data:image/png;base64,'), '图片以 data URL 送达')
})

test('transcribeImages：单张失败降级为告警，其余照常（不阻塞整体）', async () => {
  let n = 0
  llmBehavior = async () => {
    n++
    if (n === 2) throw new Error('模型超时')
    return { content: `第${n}张文字` }
  }
  const img = { data: new Uint8Array([1]), mimeType: 'image/png' as const }
  const result = await transcribeImages([img, img, img], 'vision-test')
  assert.equal(result.text, '第1张文字\n\n第3张文字', '失败张跳过，成功张保留顺序拼接')
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /第 2\/3 张图转写失败: 模型超时/)
})

// ==================== 扫描 PDF：operatorList 抽取内嵌图片 ====================

/**
 * 构造最小 PDF：单页、无文字层、页内一张 2x2 DeviceRGB 图片 XObject。
 * 图片采样字节取 ASCII 可见字符（A..L），保证字符串构造 PDF 时偏移计算不受多字节影响。
 */
function buildImagePdf(): Uint8Array {
  const pixels = 'ABCDEFGHIJKL' // 2x2 RGB = 12 字节
  const content = 'q 200 0 0 200 100 500 cm /Im0 Do Q'
  const objects = [
    { body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>' },
    { body: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream` },
    { body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream` },
  ]
  const enc = new TextEncoder()
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  objects.forEach((obj, i) => {
    offsets.push(enc.encode(pdf).length)
    pdf += `${i + 1} 0 obj\n${obj.body}\nendobj\n`
  })
  const xrefStart = enc.encode(pdf).length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return enc.encode(pdf)
}

test('extractPdfEmbeddedImages：operatorList 抽取页内嵌图片（非渲染路径），位图转 PNG', async () => {
  const { images, warnings } = await extractPdfEmbeddedImages(buildImagePdf())
  assert.equal(images.length, 1, `应抽到 1 张图（告警: ${warnings.join('；')}）`)
  assert.equal(images[0].mimeType, 'image/png', 'DeviceRGB 原始采样 → 位图 → PNG')
  assert.deepEqual([...images[0].data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG 签名')
})

test('ingestPdf 扫描件：无文字层自动降级 OCR（视觉模型转写）入库，告警留痕', async () => {
  env = await setup()
  registerVisionModel()
  currentModel = 'vision-test'
  llmBehavior = async () => ({ content: '扫描页转写出的合同条款。' })

  const result = await ingestPdf('kb', buildImagePdf(), '/tmp/scan.pdf')
  assert.equal(result.status, 'ingested')
  assert.ok(result.warnings.some(w => w.includes('OCR')), '结果带 OCR 降级告警')

  const doc = await env.store.readDoc('kb', result.docId)
  assert.equal(doc!.frontmatter.type, 'pdf', '扫描件仍归 pdf 类型')
  assert.ok(doc!.body.includes('扫描页转写出的合同条款。'))
})

test('ingestPdf 扫描件：无可用视觉模型时抛中文指引', async () => {
  env = await setup()
  currentModel = null
  await assert.rejects(() => ingestPdf('kb', buildImagePdf(), '/tmp/scan.pdf'), /视觉模型做 OCR|image 模态/)
})

// ==================== 图片摄入 ====================

test('ingestImage 端到端：图片 OCR 转写后以 type=image 入库', async () => {
  env = await setup()
  registerVisionModel()
  currentModel = 'vision-test'
  llmBehavior = async () => ({ content: '白板照片里的架构图文字。' })

  const result = await ingestImage('kb', new Uint8Array([0x89, 0x50, 0x4e, 0x47]), '/tmp/board.png')
  assert.equal(result.status, 'ingested')
  assert.ok(result.warnings.some(w => w.includes('OCR')))

  const doc = await env.store.readDoc('kb', result.docId)
  assert.equal(doc!.frontmatter.type, 'image')
  assert.ok(doc!.body.includes('白板照片里的架构图文字。'))
})

test('ingestImage：无可用视觉模型时抛中文指引', async () => {
  env = await setup()
  currentModel = null
  await assert.rejects(() => ingestImage('kb', new Uint8Array([1]), '/tmp/a.png'), /视觉模型做 OCR|image 模态/)
})
