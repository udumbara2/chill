import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPdfPaged, extractPdfText } from '../../src/services/knowledge/ingestPipeline.ts'

/** 最小 PDF 构造（同 tests/knowledge/ingestPipeline.test.ts 的 buildHelloPdf 先例：单页单文本算子） */
function buildPagePdf(texts: string[]): Uint8Array {
  const enc = new TextEncoder()
  const n = texts.length
  const objects: string[] = []
  // obj1 Catalog / obj2 Pages / obj3..2+n 页 / 之后每页一个 Contents + 共享 Font
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  const kids = Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(' ')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`)
  const contentIds: number[] = []
  for (let i = 0; i < n; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + n} 0 R >> >> /Contents ${3 + n + 1 + i} 0 R >>`)
    contentIds.push(3 + n + 1 + i)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  for (let i = 0; i < n; i++) {
    const content = `BT /F1 24 Tf 100 700 Td (${texts[i]}) Tj ET`
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
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

test('extractPdfPaged 缺省全量：返回逐页文本与总页数', async () => {
  const r = await extractPdfPaged(buildPagePdf(['PageOne', 'PageTwo', 'PageThree']))
  assert.equal(r.numPages, 3)
  assert.equal(r.pages.length, 3)
  assert.match(r.pages[0].text, /PageOne/)
  assert.match(r.pages[1].text, /PageTwo/)
  assert.match(r.pages[2].text, /PageThree/)
  assert.deepEqual(r.pages.map(p => p.page), [1, 2, 3])
})

test('extractPdfPaged 页范围 "2-3" / "2"：只返回指定页', async () => {
  const buf = buildPagePdf(['PageOne', 'PageTwo', 'PageThree'])
  const r1 = await extractPdfPaged(buf, '2-3')
  assert.deepEqual(r1.pages.map(p => p.page), [2, 3])
  assert.match(r1.pages[0].text, /PageTwo/)
  const r2 = await extractPdfPaged(buf, '1')
  assert.deepEqual(r2.pages.map(p => p.page), [1])
  assert.equal(r2.numPages, 3, '总页数始终为全文档页数')
})

test('extractPdfPaged 非法/越界 pages 报中文错', async () => {
  const buf = buildPagePdf(['A', 'B'])
  await assert.rejects(() => extractPdfPaged(buf, 'x-y'), /pages 参数格式非法/)
  await assert.rejects(() => extractPdfPaged(buf, '2-1'), /pages 参数范围非法/)
  await assert.rejects(() => extractPdfPaged(buf, '1-9'), /pages 越界/)
})

test('extractPdfText 薄包装行为不变（ingestPdf 依赖的旧签名零回归）', async () => {
  const text = await extractPdfText(buildPagePdf(['Hello World']))
  assert.match(text, /Hello World/)
})
