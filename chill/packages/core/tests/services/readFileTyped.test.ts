import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import JSZip from 'jszip'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'

/**
 * read_file 类型内聚（文件引用管线 · T5）：
 * 文本走行分页契约不动；.pdf 分页解析/ocr 指引；.docx 抽文本；.zip 清单/成员透明读；
 * tar/7z/图片/未知二进制类型化拒绝；参数误用显式报错；NUL 嗅探双保险。
 * 真实 BuiltInToolExecutor + 双 fsProvider 形态（含/不含 readFileBase64）。
 */

const key = (p: string) => path.normalize(p)

function makeFsProvider(workDir: string, withBase64 = true) {
  const files = new Map<string, string>()
  const binFiles = new Map<string, Uint8Array>()
  const base: Record<string, unknown> = {
    getCurrentDirectory: () => workDir,
    fileExists: async (p: string) => ({ success: true, data: files.has(key(p)) || binFiles.has(key(p)) }),
    readFile: async (p: string, options?: { offset?: number; limit?: number }) => {
      const content = files.get(key(p))
      if (content === undefined) return { success: false, error: 'not found' }
      const lines = content.split('\n')
      const offset = options?.offset ?? 1
      const limit = options?.limit ?? 2000
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      return {
        success: true,
        data: { content: slice.join('\n'), totalLines: lines.length, startLine: offset, endLine: offset + slice.length - 1 }
      }
    },
    writeFile: async (p: string, content: string) => { files.set(key(p), content); return { success: true } },
    deleteFile: async (p: string) => { files.delete(key(p)); return { success: true } },
    getPathType: async (p: string) => ({
      success: true,
      data: { type: files.has(key(p)) || binFiles.has(key(p)) ? 'file' : 'not_found' }
    }),
    listDirectory: async () => ({ success: true, data: [] }),
  }
  if (withBase64) {
    base.readFileBase64 = async (p: string) => {
      const b = binFiles.get(key(p))
      if (b) return { success: true, data: { base64: Buffer.from(b).toString('base64') } }
      const t = files.get(key(p))
      if (t !== undefined) return { success: true, data: { base64: Buffer.from(t, 'utf-8').toString('base64') } }
      return { success: false, error: 'not found' }
    }
  }
  return { files, binFiles, provider: base as never }
}

function makeExecutor(provider: never) {
  return new BuiltInToolExecutor(
    provider,
    { confirm: async () => true } as never,
    {
      calculatePosition: async () => ({ success: true, data: { startLine: 1, endLine: 1 } }),
      calculateSnapshotPosition: async () => ({ success: true, data: { startLine: 1, endLine: 1 } }),
      validateAnchor: async () => ({ success: true, data: { valid: true } }),
    } as never,
    {} as never,
    ''
  )
}

/** 最小文本层 PDF（同 ingestPipeline.test.ts buildHelloPdf 先例） */
function buildHelloPdf(text: string): Uint8Array {
  const enc = new TextEncoder()
  const content = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  objects.forEach((body, i) => {
    offsets.push(enc.encode(pdf).length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = enc.encode(pdf).length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return enc.encode(pdf)
}

test('文本无回归：行分页契约与 NUL 嗅探放行正常文本', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'))
  const { files, provider } = makeFsProvider(workDir)
  files.set(key(path.join(workDir, 'a.md')), 'hello\nworld')
  const r = await makeExecutor(provider).executeAsync('read_file', JSON.stringify({ path: path.join(workDir, 'a.md') }), 'c1')
  assert.equal(r.success, true)
  assert.match(String((r as { data?: { content?: string } }).data?.content ?? ''), /hello/)
})

test('NUL 嗅探：utf-8 硬解出的二进制拒绝并给指引', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'))
  const { files, provider } = makeFsProvider(workDir)
  files.set(key(path.join(workDir, 'weird.dat')), 'ab\u0000cd')
  const r = await makeExecutor(provider).executeAsync('read_file', JSON.stringify({ path: path.join(workDir, 'weird.dat') }), 'c2')
  assert.equal(r.success, false)
  assert.match(String(r.error), /二进制文件无法按文本读取/)
  assert.match(String(r.error), /NUL/)
})

test('.pdf：文本层解析带页标记与总页数；无文字层报 ocr 指引', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'))
  const { binFiles, provider } = makeFsProvider(workDir)
  const pdfPath = path.join(workDir, 'hello.pdf')
  binFiles.set(key(pdfPath), buildHelloPdf('Hello World'))
  const r = await makeExecutor(provider).executeAsync('read_file', JSON.stringify({ path: pdfPath, pages: '1-1' }), 'c3')
  assert.equal(r.success, true)
  const content = String((r as { data?: { content?: string } }).data?.content ?? '')
  assert.match(content, /Hello World/)
  assert.match(content, /\[第 1 页\]/)
  assert.match(content, /共 1 页/)

  // 空文本层（无算子）→ 扫描件指引
  const enc = new TextEncoder()
  binFiles.set(key(path.join(workDir, 'scan.pdf')), enc.encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'))
  const r2 = await makeExecutor(provider).executeAsync('read_file', JSON.stringify({ path: path.join(workDir, 'scan.pdf') }), 'c4')
  assert.equal(r2.success, false)
  assert.match(String(r2.error), /ocr: true/)
  assert.match(String(r2.error), /ingest_document/)
})

test('.zip 透明读：缺省出清单，member 出成员文本，二进制成员拒绝，缺失成员报错', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'))
  const { binFiles, provider } = makeFsProvider(workDir)
  const zipPath = path.join(workDir, 'pack.zip')
  const zip = new JSZip()
  zip.file('readme.txt', 'zip member text')
  zip.file('blob.bin', new Uint8Array([1, 2, 0, 3]))
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  binFiles.set(key(zipPath), bytes)
  const ex = makeExecutor(provider)

  const list = await ex.executeAsync('read_file', JSON.stringify({ path: zipPath }), 'c5')
  assert.equal(list.success, true)
  const listText = String((list as { data?: { content?: string } }).data?.content ?? '')
  assert.match(listText, /readme\.txt/)
  assert.match(listText, /blob\.bin/)
  assert.match(listText, /member 参数/)

  const member = await ex.executeAsync('read_file', JSON.stringify({ path: zipPath, member: 'readme.txt' }), 'c6')
  assert.equal(member.success, true)
  assert.match(String((member as { data?: { content?: string } }).data?.content ?? ''), /zip member text/)

  const binMember = await ex.executeAsync('read_file', JSON.stringify({ path: zipPath, member: 'blob.bin' }), 'c7')
  assert.equal(binMember.success, false)
  assert.match(String(binMember.error), /二进制成员/)

  const missing = await ex.executeAsync('read_file', JSON.stringify({ path: zipPath, member: 'nope.txt' }), 'c8')
  assert.equal(missing.success, false)
  assert.match(String(missing.error), /未找到成员/)
})

test('类型化拒绝：tar/7z/图片 各给可行动指引', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'))
  const { files, binFiles, provider } = makeFsProvider(workDir)
  const ex = makeExecutor(provider)

  binFiles.set(key(path.join(workDir, 'a.tar.gz')), new Uint8Array([1]))
  const r1 = await ex.executeAsync('read_file', JSON.stringify({ path: path.join(workDir, 'a.tar.gz') }), 'c9')
  assert.equal(r1.success, false)
  assert.match(String(r1.error), /execute_code/)

  binFiles.set(key(path.join(workDir, 'a.7z')), new Uint8Array([1]))
  const r2 = await ex.executeAsync('read_file', JSON.stringify({ path: path.join(workDir, 'a.7z') }), 'c10')
  assert.equal(r2.success, false)
  assert.match(String(r2.error), /不支持的压缩格式/)

  binFiles.set(key(path.join(workDir, 'a.png')), new Uint8Array([1]))
  const r3 = await ex.executeAsync('read_file', JSON.stringify({ path: path.join(workDir, 'a.png') }), 'c11')
  assert.equal(r3.success, false)
  assert.match(String(r3.error), /图片附件|ingest_document/)

  binFiles.set(key(path.join(workDir, 'a.exe')), new Uint8Array([1]))
  const r4 = await ex.executeAsync('read_file', JSON.stringify({ path: path.join(workDir, 'a.exe') }), 'c12')
  assert.equal(r4.success, false)
  assert.match(String(r4.error), /二进制/)
  void files
})

test('参数误用显式化：非 pdf 传 pages/ocr、非 zip 传 member 报参数错误', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'))
  const { files, provider } = makeFsProvider(workDir)
  files.set(key(path.join(workDir, 'a.md')), 'x')
  files.set(key(path.join(workDir, 'a.zip')), 'x')
  const ex = makeExecutor(provider)

  const r1 = await ex.executeAsync('read_file', JSON.stringify({ path: path.join(workDir, 'a.md'), pages: '1' }), 'c13')
  assert.equal(r1.success, false)
  assert.match(String(r1.error), /参数错误：pages\/ocr 仅对 \.pdf/)

  const r2 = await ex.executeAsync('read_file', JSON.stringify({ path: path.join(workDir, 'a.md'), member: 'x' }), 'c14')
  assert.equal(r2.success, false)
  assert.match(String(r2.error), /参数错误：member 仅对 \.zip/)

  const r3 = await ex.executeAsync('read_file', JSON.stringify({ path: path.join(workDir, 'a.zip'), pages: '1' }), 'c15')
  assert.equal(r3.success, false)
  assert.match(String(r3.error), /参数错误：pages/)
})

test('宿主无 readFileBase64：PDF/zip 得退化指引而非崩溃', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'))
  const { files, provider } = makeFsProvider(workDir, false)
  files.set(key(path.join(workDir, 'a.pdf')), 'x')
  const r = await makeExecutor(provider).executeAsync('read_file', JSON.stringify({ path: path.join(workDir, 'a.pdf') }), 'c16')
  assert.equal(r.success, false)
  assert.match(String(r.error), /不支持读取二进制文件/)
})
