import { emptyKnowledgeIndex, knowledgeStore, computeEnhancementsFingerprint, resolveEnhancements } from './knowledgeStore'
import { chunkMarkdown, chunkPlainText, embeddingText } from './chunker'
import { embedTexts, getEmbeddingApiKey } from './embeddingClient'
import { DEFAULT_ENRICHERS, resolveActiveEnrichers, runEnrichers, type ChunkEnricher } from './enrich'
import { extractOfficeText } from './officeExtractor'
import { extractPdfEmbeddedImages, resolveVisionModel, transcribeImages } from './ocrExtractor'
import type { ChunkRecord, DocType, KnowledgeBaseConfig, KnowledgeGlobalConfig } from './types'

/**
 * 知识库摄入管线（设计见 iDream/知识管理.md 任务 4；二期管线阶段化见第八节）
 *
 * - ingestDocument：md/txt 已抽取文本的主入口。内容 hash 未变跳过；变化则重切重嵌，
 *   旧 doc 的索引记录先剔除再追加（幂等，重复摄入结果一致）
 * - ingestPdf：pdfjs-dist 抽取 PDF 文本后走同一管线
 * - removeDocument：删 doc 正本并剔除索引记录
 * - rebuildIndex：换 embedding 模型/维度/增强开关后，遍历 docs/ 正本强制重切重嵌、整体重写索引
 *
 * 摄入与重建共用一个"单文档切块 + 增强"管线（processDocument）：chunk → enrich →（由调用方统一
 * embed 落盘）。增强只在管线一处生效，重建时不会静默丢失。
 *
 * 三端同码：只用全局 fetch / crypto.subtle 等 Web 标准 API；pdfjs-dist 为纯 JS。
 */

/** 摄入结果：skipped 表示内容 hash 未变（未重新切块/embedding） */
export interface IngestResult {
  docId: string
  status: 'ingested' | 'skipped'
  /** 索引中该文档的记录总数（父块 + 子块） */
  chunkCount: number
  /** 嵌向量的子块数（embedding 请求条数） */
  childCount: number
  /** enrich 阶段降级告警（增强失败不阻塞摄入，降级为无增强并在此记录） */
  warnings: string[]
}

/** 删除结果：removedChunks 为从索引剔除的记录数 */
export interface RemoveResult {
  success: boolean
  error?: string
  removedChunks: number
}

/** 重建结果：docCount 为参与重建的文档数，chunkCount/childCount 为新索引规模 */
export interface RebuildResult {
  docCount: number
  chunkCount: number
  /** 嵌向量的子块数（embedding 请求条数） */
  childCount: number
  /** enrich 阶段降级告警（逐文档汇总） */
  warnings: string[]
}

/** SHA-256 内容 hash（Web Crypto，Node 19+ 与浏览器均有全局 crypto.subtle） */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** docId 由来源路径派生：同一来源重复摄入落在同一 docId，天然幂等 */
export async function docIdForSource(sourcePath: string): Promise<string> {
  return `d-${(await sha256Hex(sourcePath)).slice(0, 16)}`
}

/** 沉淀知识：每条一个 chunk 不再切（设计第二节第 5 点），直接嵌向量、无父块 */
function chunkDistilled(content: string, docId: string): ChunkRecord[] {
  const text = content.trim()
  return [{ id: `${docId}-c0`, docId, charStart: 0, charEnd: text.length, text }]
}

/** 单文档管线（processDocument）输出：最终 chunk 记录 + 待嵌向量的子块 + enrich 降级告警 */
export interface ProcessDocumentResult {
  records: ChunkRecord[]
  children: ChunkRecord[]
  warnings: string[]
}

/**
 * 单文档切块 + 增强管线（ingestDocument 与 rebuildIndex 共用的唯一切块入口）。
 *
 * 阶段：按 DocType 分派切块（note→Markdown 标题切、pdf/office/image→纯文本递归切、distilled→单块）
 * → enrich（enricher 链经 resolveActiveEnrichers 按增强开关门控，单个失败降级并收集告警，见 enrich.ts 契约）。
 * embed 与落盘由调用方统一做（摄入是单文档增量写，重建是全量一次性写）。
 *
 * children 为嵌向量目标：全部带 parentId 的子块 + 摘要块（kind='summary'）+ 沉淀单块；父块不嵌向量。
 */
export async function processDocument(
  text: string,
  docType: DocType,
  docId: string,
  config: KnowledgeGlobalConfig,
  kbConfig: KnowledgeBaseConfig,
  enrichers: ChunkEnricher[] = DEFAULT_ENRICHERS
): Promise<ProcessDocumentResult> {
  const { childChunkSize, parentChunkSize } = config.retrieval
  const chunks = docType === 'distilled'
    ? chunkDistilled(text, docId)
    : docType === 'note'
      ? chunkMarkdown(text, { childChunkSize, parentChunkSize, docId })
      : chunkPlainText(text, { childChunkSize, parentChunkSize, docId })

  const enhancements = resolveEnhancements(config, kbConfig)
  const { chunks: enriched, warnings } = await runEnrichers(
    { chunks, text, docId, docType, enhancements, config, kbConfig },
    resolveActiveEnrichers(enhancements, enrichers)
  )
  const children = enriched.filter(r => r.parentId || r.kind === 'summary' || docType === 'distilled')
  return { records: enriched, children, warnings }
}

/**
 * 摄入一篇文档（md/txt 直读场景，content 为已抽取文本）。
 *
 * 流程：校验库存在与 embedding 快照 → 内容 hash 与已有 frontmatter 比对（未变跳过）
 * → 按类型切块（note 走 Markdown 标题切、pdf 纯文本递归切、distilled 单块）
 * → 子块 embeddingText 批量 embedTexts → 剔除旧 doc 索引记录后追加 → 写 docs 正本。
 *
 * 换过 embedding 模型/维度（快照不一致）时抛出带中文重建指引的错误。
 */
export async function ingestDocument(
  kbName: string,
  sourcePath: string,
  content: string,
  docType: DocType = 'note'
): Promise<IngestResult> {
  const store = knowledgeStore
  const kbConfig = await store.getKnowledgeBaseConfig(kbName)
  if (!kbConfig) {
    throw new Error(`未找到知识库: ${kbName}，请先创建知识库再摄入文档`)
  }
  if (!(await store.isIndexEmbeddingCurrent(kbName))) {
    const config = await store.getGlobalConfig()
    throw new Error(
      `知识库 "${kbName}" 的索引与当前 embedding 配置（${config.embedding.model} / ${config.embedding.dimensions} 维）不一致，`
      + '需要先重建索引才能摄入：请使用 rebuild_knowledge_index 工具重建该库的索引'
      + '（或在设置-知识库页签点重建按钮），或把 knowledge.json 的 embedding 配置改回原模型/维度。'
    )
  }
  const text = content.trim()
  if (!text) {
    // 分场景给出可行动的提示：沉淀来源（无磁盘文件）/ 0 字节空文件 / 仅空白字符
    if (sourcePath.startsWith('distilled:') || sourcePath.startsWith('inline:')) {
      throw new Error('沉淀内容为空：请填写内容后再入库')
    }
    if (content.length === 0) {
      throw new Error(`文件是空文件（0 字节），没有可摄入的内容：${sourcePath}。请确认文件内容已保存`)
    }
    throw new Error(`文件只包含空白字符（空格/换行），没有可摄入的内容：${sourcePath}`)
  }

  const docId = await docIdForSource(sourcePath)
  const contentHash = await sha256Hex(text)
  const existing = await store.readDoc(kbName, docId)
  const oldIndex = await store.readIndex(kbName)
  if (existing?.frontmatter.contentHash === contentHash) {
    // 内容未变：跳过切块与 embedding（返回现有索引统计）
    const chunks = (oldIndex?.chunks ?? []).filter(c => c.docId === docId)
    return { docId, status: 'skipped', chunkCount: chunks.length, childCount: chunks.filter(c => c.embedding).length, warnings: [] }
  }

  const config = await store.getGlobalConfig()
  const { records, children, warnings } = await processDocument(text, docType, docId, config, kbConfig)

  const apiKey = await getEmbeddingApiKey() // key 未配置时在此抛出带指引的中文错误
  const vectors = await embedTexts(children.map(embeddingText), config.embedding, apiKey)
  children.forEach((r, i) => { r.embedding = vectors[i] })

  // 幂等：旧 doc 记录先剔除再追加；索引快照（embedding + 增强指纹）对齐当前生效配置
  const index = oldIndex ?? emptyKnowledgeIndex(config, kbConfig)
  index.embeddingModel = config.embedding.model
  index.embeddingDimensions = config.embedding.dimensions
  index.enhancementsFingerprint = computeEnhancementsFingerprint(resolveEnhancements(config, kbConfig))
  index.chunks = index.chunks.filter(c => c.docId !== docId).concat(records)
  const saveIdx = await store.saveIndex(kbName, index)
  if (!saveIdx.success) throw new Error(`写入索引失败: ${saveIdx.error}`)

  const save = await store.saveDoc(
    kbName,
    docId,
    { sourcePath, type: docType, contentHash, createdAt: existing?.frontmatter.createdAt ?? new Date().toISOString() },
    text
  )
  if (!save.success) throw new Error(`写入文档失败: ${save.error}`)

  return { docId, status: 'ingested', chunkCount: records.length, childCount: children.length, warnings }
}

// ==================== PDF 文本抽取 ====================

/** pdfjs-dist 懒加载（包体大，只在摄入 PDF 时才载入；缓存单次 import） */
let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null

function loadPdfjs() {
  if (!pdfjsPromise) {
    // legacy build：ES5 语法、不依赖现代浏览器特性，Node 与 Electron 渲染进程通用。
    // Node 下不设 GlobalWorkerOptions.workerSrc，pdfjs 自动回落 fake worker（主线程跑解析），
    // 个人规模 PDF 足够；切勿 import pdf.worker（打包体积翻倍且无收益）。
    //
    // 渲染进程接入注意：PDF 较大时主线程解析会卡 UI，应配置真 worker——
    // 用 vite 的 `new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' })`
    // 赋给 GlobalWorkerOptions.workerPort（或把 worker 文件拷成静态资源设 workerSrc）。
    // 本模块不替 UI 层做该配置，保持三端同码。
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
  }
  return pdfjsPromise
}

/** 一页的 TextContent 拼成文本：按 hasEOL 断行（item 为排版切片，直接相连即可） */
function textContentToString(textContent: { items: unknown[] }): string {
  let out = ''
  for (const item of textContent.items) {
    if (typeof item !== 'object' || item === null || !('str' in item)) continue
    const t = item as { str: string; hasEOL?: boolean }
    out += t.str
    if (t.hasEOL) out += '\n'
  }
  return out.trim()
}

/** pdfjs-dist 抽取 PDF 全文（页间空行分隔）；扫描件无文字层时返回空串由上层报错 */
/** 解析 pages 参数（"1-5" | "3"，缺省全量）→ 有序页号列表；非法/越界报中文错 */
function parsePdfPageRange(pages: string | undefined, numPages: number): number[] {
  if (!pages) return Array.from({ length: numPages }, (_, i) => i + 1)
  const m = pages.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
  if (!m) throw new Error(`pages 参数格式非法（应为 "3" 或 "1-5"）: ${pages}`)
  const from = Number(m[1])
  const to = m[2] !== undefined ? Number(m[2]) : from
  if (from < 1 || to < from) throw new Error(`pages 参数范围非法: ${pages}`)
  if (to > numPages) throw new Error(`pages 越界: ${pages}（文档共 ${numPages} 页）`)
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

/**
 * PDF 分页抽取原语（文件引用管线 · T4）：按页返回文本 + 总页数。
 * `pages: "1-5" | "3"`，缺省全量；非法/越界报中文错。
 * `extractPdfText` 为其薄包装（行为不变），`ingestPdf` 调用处零改动。
 */
export async function extractPdfPaged(
  pdfBuffer: Uint8Array | ArrayBuffer,
  pages?: string
): Promise<{ numPages: number; pages: Array<{ page: number; text: string }> }> {
  const pdfjs = await loadPdfjs()
  // 复制一份再交给 pdfjs：getDocument 默认 transfer 该 buffer（调用方的 buffer 会被 neuter），
  // 同一 buffer 二次摄入或调用方事后复用都会炸 "Cannot transfer object of unsupported type"
  const src = pdfBuffer instanceof Uint8Array ? pdfBuffer : new Uint8Array(pdfBuffer)
  const data = new Uint8Array(src)
  const loadingTask = pdfjs.getDocument({
    data,
    useWorkerFetch: false, // fake worker 下走主线程 fetch 逻辑，避免 worker 环境依赖
    disableFontFace: true, // 只抽文本不渲染，无需加载字体字形
  })
  try {
    const doc = await loadingTask.promise
    const wanted = parsePdfPageRange(pages, doc.numPages)
    const out: Array<{ page: number; text: string }> = []
    for (const p of wanted) {
      const page = await doc.getPage(p)
      out.push({ page: p, text: textContentToString(await page.getTextContent()) })
      page.cleanup()
    }
    return { numPages: doc.numPages, pages: out }
  } catch (e) {
    if (e instanceof Error && /pages (参数|越界)/.test(e.message)) throw e
    throw new Error(`PDF 解析失败: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    await loadingTask.destroy()
  }
}

export async function extractPdfText(pdfBuffer: Uint8Array | ArrayBuffer): Promise<string> {
  const { pages } = await extractPdfPaged(pdfBuffer)
  return pages.map(p => p.text).filter(Boolean).join('\n\n')
}

/**
 * base64 → Uint8Array（三端同码：atob 在 Node 16+ 与浏览器均为全局，不用 Buffer）。
 * 供 add_knowledge 的 PDF 路径把 IFileSystemProvider.readFileBase64 的结果还原为字节。
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 摄入 PDF：pdfjs-dist 抽取文本后走与 ingestDocument 相同的管线（docType = 'pdf'）。
 *  无文字层（扫描件）时降级走 OCR：operatorList 抽取页内嵌图片 → 视觉模型转写 → 同一管线。 */
export async function ingestPdf(
  kbName: string,
  pdfBuffer: Uint8Array | ArrayBuffer,
  sourcePath: string
): Promise<IngestResult> {
  const text = await extractPdfText(pdfBuffer)
  if (text.trim()) {
    return ingestDocument(kbName, sourcePath, text, 'pdf')
  }
  // 扫描件 OCR 降级路径（二期任务 5）：逐页抽内嵌图片送视觉模型，单页失败记告警不阻塞
  const { images, warnings } = await extractPdfEmbeddedImages(pdfBuffer)
  if (images.length === 0) {
    throw new Error(
      `PDF 既没有文字层也没有可抽取的图片，无法摄入: ${sourcePath}。`
      + (warnings.length > 0 ? `（抽取过程告警：${warnings.join('；')}）` : '')
    )
  }
  const modelName = await resolveVisionModel()
  if (!modelName) {
    throw new Error(
      `PDF 无文字层（扫描件），需要视觉模型做 OCR，但未找到可用模型: ${sourcePath}。`
      + '请先在设置中添加支持图片输入（image 模态）的模型并配置 API Key，或把当前模型切换为带图模型后重试。'
    )
  }
  const ocr = await transcribeImages(images, modelName)
  if (!ocr.text.trim()) {
    throw new Error(
      `扫描 PDF 的 OCR 未产出任何文字: ${sourcePath}（共抽取 ${images.length} 张页内图片）。`
      + `（告警：${[...warnings, ...ocr.warnings].join('；') || '无'}）`
    )
  }
  const result = await ingestDocument(kbName, sourcePath, ocr.text, 'pdf')
  // OCR 降级告警并入摄入结果（OCR 本身已是降级路径，产出文本就入库）
  result.warnings = [`扫描件无文字层，已走 OCR（模型 ${modelName}，${images.length} 张图片）`, ...warnings, ...ocr.warnings, ...result.warnings]
  return result
}

// ==================== Office / 图片摄入（二期任务 5） ====================

/** 支持的 Office 扩展名 → 短名（extractOfficeText 的分派键） */
const OFFICE_EXTENSIONS: Record<string, 'docx' | 'xlsx' | 'pptx'> = {
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
}

/** 支持的图片扩展名 → MIME（OCR 送视觉模型） */
const IMAGE_EXTENSIONS: Record<string, 'image/png' | 'image/jpeg'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

/** 按扩展名判断 Office 短名（非 Office 返回 null） */
export function officeExtOf(sourcePath: string): 'docx' | 'xlsx' | 'pptx' | null {
  const dot = sourcePath.lastIndexOf('.')
  if (dot < 0) return null
  return OFFICE_EXTENSIONS[sourcePath.slice(dot).toLowerCase()] ?? null
}

/** 按扩展名判断图片 MIME（非图片返回 null） */
export function imageMimeOf(sourcePath: string): 'image/png' | 'image/jpeg' | null {
  const dot = sourcePath.lastIndexOf('.')
  if (dot < 0) return null
  return IMAGE_EXTENSIONS[sourcePath.slice(dot).toLowerCase()] ?? null
}

/** 摄入 Office 文档（docx/xlsx/pptx）：jszip 解包抽文本后走与 ingestDocument 相同的管线（docType = 'office'） */
export async function ingestOffice(
  kbName: string,
  buffer: Uint8Array | ArrayBuffer,
  sourcePath: string
): Promise<IngestResult> {
  const ext = officeExtOf(sourcePath)
  if (!ext) throw new Error(`不支持的 Office 格式（仅支持 .docx/.xlsx/.pptx）: ${sourcePath}`)
  const text = await extractOfficeText(buffer, ext)
  if (!text.trim()) {
    throw new Error(`Office 文档未抽取到文本（可能是空文档或纯图片内容）: ${sourcePath}`)
  }
  return ingestDocument(kbName, sourcePath, text, 'office')
}

/** 摄入图片（png/jpg）：视觉模型 OCR 转写后走与 ingestDocument 相同的管线（docType = 'image'） */
export async function ingestImage(
  kbName: string,
  buffer: Uint8Array | ArrayBuffer,
  sourcePath: string
): Promise<IngestResult> {
  const mimeType = imageMimeOf(sourcePath)
  if (!mimeType) throw new Error(`不支持的图片格式（仅支持 .png/.jpg/.jpeg）: ${sourcePath}`)
  const modelName = await resolveVisionModel()
  if (!modelName) {
    throw new Error(
      `图片摄入需要视觉模型做 OCR，但未找到可用模型: ${sourcePath}。`
      + '请先在设置中添加支持图片输入（image 模态）的模型并配置 API Key，或把当前模型切换为带图模型后重试。'
    )
  }
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const ocr = await transcribeImages([{ data, mimeType }], modelName)
  if (!ocr.text.trim()) {
    throw new Error(`图片 OCR 未转写出文字: ${sourcePath}（${ocr.warnings.join('；') || '模型返回为空'}）`)
  }
  const result = await ingestDocument(kbName, sourcePath, ocr.text, 'image')
  result.warnings = [`图片经 OCR 入库（模型 ${modelName}）`, ...ocr.warnings, ...result.warnings]
  return result
}

/** 删除文档：删 docs 正本并剔除索引中该 doc 的全部记录（父子块级联清理） */
export async function removeDocument(kbName: string, docId: string): Promise<RemoveResult> {
  const store = knowledgeStore
  const doc = await store.readDoc(kbName, docId)
  const index = await store.readIndex(kbName)
  const remaining = (index?.chunks ?? []).filter(c => c.docId !== docId)
  const removedChunks = (index?.chunks.length ?? 0) - remaining.length
  if (!doc && removedChunks === 0) {
    return { success: false, error: `未找到文档: ${docId}`, removedChunks: 0 }
  }
  const del = await store.deleteDoc(kbName, docId)
  if (!del.success) return { success: false, error: del.error || '删除文档失败', removedChunks: 0 }
  if (index && removedChunks > 0) {
    index.chunks = remaining
    const save = await store.saveIndex(kbName, index)
    if (!save.success) return { success: false, error: `更新索引失败: ${save.error}`, removedChunks: 0 }
  }
  return { success: true, removedChunks }
}

/**
 * 重建整个知识库的向量索引（换 embedding 模型/维度/增强开关后的修复手段，对应 rebuild_knowledge_index 工具）。
 *
 * 遍历 docs/ 全部正本，逐篇走与摄入相同的单文档管线（processDocument：按 docType 切块 → enrich），
 * 子块按当前全局 embedding 配置重新嵌向量，最后整体重写 index.json（快照含增强指纹）。
 *
 * 与 ingestDocument 的区别：
 * - 绕过内容 hash 跳过——重建语义就是强制重做，正本只读不写（frontmatter 无需变更）
 * - 逐库整体重建而非逐文档增量，索引快照一次性对齐当前全局配置
 *
 * chunk id 由 docId 前缀派生，与摄入时同一规则，重建后 id 稳定。
 * 安全性：全部文档切块 + embedding 成功后才一次性 saveIndex；任一步失败旧 index.json 原样保留，
 * 不会出现半截索引（对正本只存在于 docs/ 的沉淀/粘贴型知识尤其关键）。
 */
export async function rebuildIndex(kbName: string): Promise<RebuildResult> {
  const store = knowledgeStore
  const kbConfig = await store.getKnowledgeBaseConfig(kbName)
  if (!kbConfig) {
    throw new Error(`未找到知识库: ${kbName}，请先创建知识库再重建索引`)
  }
  const config = await store.getGlobalConfig()

  // 第一阶段：只读正本、逐篇走切块 + 增强管线。任何一篇正本缺失/损坏都在此中止，旧索引不动
  const docIds = await store.listDocs(kbName)
  const allRecords: ChunkRecord[] = []
  const allChildren: ChunkRecord[] = []
  const warnings: string[] = []
  for (const docId of docIds) {
    const doc = await store.readDoc(kbName, docId)
    if (!doc || !doc.body.trim()) {
      throw new Error(
        `文档正本缺失或损坏，无法重建: ${docId}（知识库 "${kbName}"）。`
        + '旧索引未改动；可先用 delete_knowledge 清理该文档后重试。'
      )
    }
    const { records, children, warnings: docWarnings } = await processDocument(
      doc.body.trim(), doc.frontmatter.type, docId, config, kbConfig
    )
    allRecords.push(...records)
    allChildren.push(...children)
    warnings.push(...docWarnings.map(w => `[${docId}] ${w}`))
  }

  // 第二阶段：全部子块批量嵌向量（embedTexts 内部按批拆分）。失败同样不触碰旧索引
  const apiKey = await getEmbeddingApiKey() // key 未配置时在此抛出带指引的中文错误
  const vectors = await embedTexts(allChildren.map(embeddingText), config.embedding, apiKey)
  allChildren.forEach((r, i) => { r.embedding = vectors[i] })

  // 第三阶段：全量构建成功，一次性重写索引（version + 当前 embedding 快照 + 增强指纹 + 新 chunks）
  const index = emptyKnowledgeIndex(config, kbConfig)
  index.chunks = allRecords
  const save = await store.saveIndex(kbName, index)
  if (!save.success) throw new Error(`写入索引失败: ${save.error}`)

  return { docCount: docIds.length, chunkCount: allRecords.length, childCount: allChildren.length, warnings }
}
