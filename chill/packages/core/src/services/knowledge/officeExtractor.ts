import JSZip from 'jszip'

/**
 * Office 文档文本抽取（二期任务 5，设计见 iDream/知识管理.md 第八节任务 5）。
 *
 * docx/xlsx/pptx 本质都是 ZIP 包 XML，统一用 jszip 解包后按格式抽取文本：
 * - docx：word/document.xml，按 <w:p> 段落抽取 <w:t> 文本 run
 * - xlsx：xl/sharedStrings.xml 共享字符串表 + xl/worksheets/sheetN.xml 单元格引用还原，
 *   单元格按列位 Tab 分隔、按行换行，工作表带标题行
 * - pptx：ppt/slides/slideN.xml，按 <a:p> 段落抽取 <a:t> 文本 run，逐页带页码标题
 *
 * 选型理由（硬约束：三端同码、无原生模块）：jszip 纯 JS 无原生绑定，Node/浏览器/Electron
 * 渲染进程通用，一个依赖覆盖三种格式；mammoth 只支持 docx、exceljs 只支持 xlsx 且依赖
 * Node stream 生态，组合引入反而更重。XML 用正则提取文本节点而非完整 DOM 解析——
 * RAG 抽取只要正文文本，不需要保真排版，省掉 XML 解析器依赖。
 *
 * 抽取是 best-effort：复杂排版（文本框/嵌套表/艺术字）可能遗漏，单文件损坏抛中文错误由上层收集。
 */

/** 抽取入口：按扩展名分派；不支持的扩展名抛中文错误 */
export async function extractOfficeText(
  buffer: Uint8Array | ArrayBuffer,
  ext: 'docx' | 'xlsx' | 'pptx'
): Promise<string> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))
  } catch (e) {
    throw new Error(`Office 文件解包失败（文件可能损坏或不是有效的 ${ext}）: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (ext === 'docx') return extractDocx(zip)
  if (ext === 'xlsx') return extractXlsx(zip)
  return extractPptx(zip)
}

/** Office Open XML 文本节点的实体解码 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&') // &amp; 必须最后解码，避免把 &lt; 之类的实体文本二次解码
}

/** 抽取某段 XML 里指定标签的全部文本 run（dotAll；标签可能带属性，如 <w:t xml:space="preserve">） */
function extractTextRuns(xml: string, tag: string): string[] {
  const runs: string[] = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) runs.push(decodeXmlEntities(m[1]))
  return runs
}

/** 按结束标签把 XML 切成块（如按 </w:p> 切段落），返回含结束边界语义的原始块数组 */
function splitByCloseTag(xml: string, closeTag: string): string[] {
  return xml.split(closeTag).slice(0, -1) // 最后一段是结尾标签之后的残余，不是完整块
}

// ==================== docx ====================

async function extractDocx(zip: JSZip): Promise<string> {
  const file = zip.file('word/document.xml')
  if (!file) throw new Error('docx 中未找到 word/document.xml（文件可能损坏）')
  const xml = await file.async('string')
  // 逐段落：段落内 <w:t> run 相连，<w:tab/> 还原为制表符，<w:br/> 还原为换行
  const paragraphs = splitByCloseTag(xml, '</w:p>').map((p) => {
    const withBreaks = p.replace(/<w:tab\s*\/>/g, '\t').replace(/<w:br\s*\/>/g, '\n')
    return extractTextRuns(withBreaks, 'w:t').join('')
  })
  return paragraphs.map(p => p.trim()).filter(Boolean).join('\n')
}

// ==================== xlsx ====================

/** 共享字符串表：每个 <si> 内的全部 <t> run 拼接（富文本单元格有多个 run） */
async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const file = zip.file('xl/sharedStrings.xml')
  if (!file) return [] // 纯数字/内联字符串的工作簿可以没有共享字符串表
  const xml = await file.async('string')
  return splitByCloseTag(xml, '</si>').map(si => extractTextRuns(si, 't').join(''))
}

/** 工作表名（xl/workbook.xml 的 <sheet name>，按声明顺序对应 sheetN 顺序——常规生成器一致，个别不一致时仅影响标题行） */
async function readSheetNames(zip: JSZip): Promise<string[]> {
  const file = zip.file('xl/workbook.xml')
  if (!file) return []
  const xml = await file.async('string')
  const names: string[] = []
  const re = /<sheet(?:\s[^>]*)?\sname="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) names.push(decodeXmlEntities(m[1]))
  return names
}

/** 单元格列号（如 "B5" → 1）：用于按列位补 Tab，保住空单元格的列对齐 */
function columnIndex(cellRef: string): number {
  let idx = 0
  for (const ch of cellRef) {
    if (ch < 'A' || ch > 'Z') break
    idx = idx * 26 + (ch.charCodeAt(0) - 64)
  }
  return idx - 1
}

/** 单个工作表 XML → 文本：逐行逐格，共享字符串/内联字符串/原始值三类还原 */
function sheetXmlToText(xml: string, sharedStrings: string[]): string {
  const rows = splitByCloseTag(xml, '</row>').map((rowXml) => {
    const cells: string[] = []
    const cellRe = /<c(?:\s([^>]*))?>([\s\S]*?)<\/c>/g
    let m: RegExpExecArray | null
    while ((m = cellRe.exec(rowXml)) !== null) {
      const attrs = m[1] ?? ''
      const body = m[2]
      const refMatch = /\br="([A-Z]+\d+)"/.exec(attrs)
      const col = refMatch ? columnIndex(refMatch[1]) : cells.length
      const typeMatch = /\bt="(\w+)"/.exec(attrs)
      const type = typeMatch?.[1]
      let value = ''
      if (type === 's') {
        const v = /<v>(\d+)<\/v>/.exec(body)
        if (v) value = sharedStrings[parseInt(v[1], 10)] ?? ''
      } else if (type === 'inlineStr') {
        value = extractTextRuns(body, 't').join('')
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)
        if (v) value = decodeXmlEntities(v[1])
      }
      if (value === '') continue
      while (cells.length < col) cells.push('')
      cells.push(value)
    }
    return cells.join('\t').trimEnd()
  })
  return rows.filter(r => r.trim()).join('\n')
}

async function extractXlsx(zip: JSZip): Promise<string> {
  const sharedStrings = await readSharedStrings(zip)
  const sheetNames = await readSheetNames(zip)
  // 工作表文件按数字序排列（sheet2 不能排在 sheet10 后面）
  const sheetFiles = zip.file(/^xl\/worksheets\/sheet\d+\.xml$/)
    .sort((a, b) => parseInt(a.name.match(/sheet(\d+)/)![1], 10) - parseInt(b.name.match(/sheet(\d+)/)![1], 10))
  if (sheetFiles.length === 0) throw new Error('xlsx 中未找到工作表（xl/worksheets/）')
  const parts: string[] = []
  for (let i = 0; i < sheetFiles.length; i++) {
    const text = sheetXmlToText(await sheetFiles[i].async('string'), sharedStrings)
    if (!text) continue
    const name = sheetNames[i]
    parts.push(name ? `【工作表: ${name}】\n${text}` : text)
  }
  return parts.join('\n\n')
}

// ==================== pptx ====================

async function extractPptx(zip: JSZip): Promise<string> {
  const slideFiles = zip.file(/^ppt\/slides\/slide\d+\.xml$/)
    .sort((a, b) => parseInt(a.name.match(/slide(\d+)/)![1], 10) - parseInt(b.name.match(/slide(\d+)/)![1], 10))
  if (slideFiles.length === 0) throw new Error('pptx 中未找到幻灯片（ppt/slides/）')
  const parts: string[] = []
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await slideFiles[i].async('string')
    // 段落级：每个 <a:p> 内的 <a:t> run 相连，段落换行
    const paragraphs = splitByCloseTag(xml, '</a:p>').map(p => extractTextRuns(p, 'a:t').join(''))
    const text = paragraphs.map(p => p.trim()).filter(Boolean).join('\n')
    if (text) parts.push(`【幻灯片 ${i + 1}】\n${text}`)
  }
  return parts.join('\n\n')
}
