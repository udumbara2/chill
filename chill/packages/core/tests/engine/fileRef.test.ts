import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FILE_INLINE_MAX_BYTES,
  FILE_CONTENT_MARKER,
  FILE_CONTENT_TRUST_LINE,
  classifyFileRef,
  decideIntake,
  renderFileRefLine,
  renderInlineRef,
  renderLargeTextRef,
  parseFileRefMentions,
} from '../../src/engine/fileRef.ts'

test('分类: media 复用 MEDIA_EXTENSIONS，document/archive/text/binary 各归其位', () => {
  assert.equal(classifyFileRef({ name: 'a.png', size: 10 }).kind, 'media')
  assert.equal(classifyFileRef({ name: 'a.mp4', size: 10 }).kind, 'media')
  assert.equal(classifyFileRef({ name: '报告.pdf', size: 10 }).kind, 'document')
  assert.equal(classifyFileRef({ name: 'a.docx', size: 10 }).kind, 'document')
  assert.equal(classifyFileRef({ name: 'a.xlsx', size: 10 }).kind, 'document')
  assert.equal(classifyFileRef({ name: 'a.pptx', size: 10 }).kind, 'document')
  assert.equal(classifyFileRef({ name: 'a.zip', size: 10 }).kind, 'archive')
  assert.equal(classifyFileRef({ name: 'a.tar', size: 10 }).kind, 'archive')
  assert.equal(classifyFileRef({ name: 'a.tgz', size: 10 }).kind, 'archive')
  assert.equal(classifyFileRef({ name: 'a.tar.gz', size: 10 }).kind, 'archive')
  assert.equal(classifyFileRef({ name: 'a.md', size: 10 }).kind, 'text')
  assert.equal(classifyFileRef({ name: 'Makefile', size: 10 }).kind, 'text', '无扩展名按文本对待')
  assert.equal(classifyFileRef({ name: 'a.exe', size: 10 }).kind, 'binary')
  assert.equal(classifyFileRef({ name: 'a.7z', size: 10 }).kind, 'binary', '7z 归 binary 但指引特化')
  assert.equal(classifyFileRef({ name: 'a.PNG', size: 10 }).kind, 'media', '扩展名大小写不敏感')
})

test('判据: 仅小文本内联，其余一律引用；边界值精确', () => {
  assert.equal(decideIntake(classifyFileRef({ name: 'a.md', size: FILE_INLINE_MAX_BYTES })), 'inline')
  assert.equal(decideIntake(classifyFileRef({ name: 'a.md', size: FILE_INLINE_MAX_BYTES + 1 })), 'reference')
  assert.equal(decideIntake(classifyFileRef({ name: '大.txt', size: 10 * 1024 * 1024 })), 'reference')
  assert.equal(decideIntake(classifyFileRef({ name: 'a.pdf', size: 1 })), 'reference', 'PDF 永不内联')
  assert.equal(decideIntake(classifyFileRef({ name: 'a.zip', size: 1 })), 'reference')
  assert.equal(decideIntake(classifyFileRef({ name: 'a.exe', size: 1 })), 'reference')
})

test('引用行: 含名称/类型/大小/路径；document/archive 附能力指引，text/binary 不附', () => {
  const doc = renderFileRefLine(classifyFileRef({ name: '报告.pdf', path: 'C:/d/报告.pdf', size: 2.3 * 1024 * 1024 }))
  assert.match(doc, /\[附件\] 报告\.pdf（PDF, 2\.3MB）→ C:\/d\/报告\.pdf/)
  assert.match(doc, /read_file 可直接解析/)
  assert.match(doc, /ingest_document/)

  const zip = renderFileRefLine(classifyFileRef({ name: 'a.zip', path: '/x/a.zip', size: 1024 }))
  assert.match(zip, /read_file 可看清单\/读成员/)
  assert.match(zip, /execute_code/)

  const txt = renderFileRefLine(classifyFileRef({ name: 'a.md', path: '/x/a.md', size: 10 }))
  assert.doesNotMatch(txt, /提示：/, 'text 不附能力指引')

  const r7z = renderFileRefLine(classifyFileRef({ name: 'a.7z', path: '/x/a.7z', size: 10 }))
  assert.match(r7z, /不支持的压缩格式/)
})

test('引用行: 无路径必显式警示，绝不静默', () => {
  const line = renderFileRefLine(classifyFileRef({ name: 'a.pdf', size: 10 }))
  assert.match(line, /无路径，仅名字引用/)
})

test('内联渲染: 引用行 + 唯一安全分隔标记首尾书挡包裹全文', () => {
  const out = renderInlineRef(classifyFileRef({ name: 'a.md', path: '/x/a.md', size: 5 }), '你好 世界')
  assert.match(out, /\[附件\] a\.md/)
  assert.match(out, /你好 世界/)
  const markerCount = out.split(FILE_CONTENT_MARKER).length - 1
  assert.equal(markerCount, 2, '首尾各一个唯一标记')
  assert.ok(out.indexOf(FILE_CONTENT_MARKER) < out.indexOf('你好 世界'), '标记在内容之前')
})

test('大文本预览渲染: 头尾 + 省略段 + read_file 续读指引', () => {
  const ref = classifyFileRef({ name: '大.txt', path: '/x/大.txt', size: 100000 })
  const out = renderLargeTextRef(ref, '头'.repeat(10), '尾'.repeat(10))
  assert.match(out, /头{10}/)
  assert.match(out, /尾{10}/)
  assert.match(out, /中间省略约 \d+ 字符/)
  assert.match(out, /read_file 分页读取/)
  assert.equal(out.split(FILE_CONTENT_MARKER).length - 1, 2, '同样受安全标记包裹')
})

test('提及解析: 非媒体 @路径 三形态；.tar.gz 复合扩展名不被拆断', () => {
  const r1 = parseFileRefMentions('看下 @报告.pdf 的第三页')
  assert.deepEqual(r1.mentions, [{ raw: '@报告.pdf', path: '报告.pdf' }])
  assert.equal(r1.text, '看下 的第三页')

  const r2 = parseFileRefMentions(String.raw`@"C:\my docs\a b.docx" 总结`)
  assert.deepEqual(r2.mentions, [{ raw: String.raw`@"C:\my docs\a b.docx"`, path: String.raw`C:\my docs\a b.docx` }])

  const r3 = parseFileRefMentions("@'my data/c d.zip' 解压前先看")
  assert.deepEqual(r3.mentions, [{ raw: "@'my data/c d.zip'", path: 'my data/c d.zip' }])

  const r4 = parseFileRefMentions('解 @a.tar.gz 之前')
  assert.deepEqual(r4.mentions, [{ raw: '@a.tar.gz', path: 'a.tar.gz' }], '复合扩展名整体命中')
})

test('提及降级: 媒体/@agent/邮箱/未知扩展名一律原样保留', () => {
  assert.deepEqual(parseFileRefMentions('看 @a.png 这张图'), { text: '看 @a.png 这张图', mentions: [] }, '媒体归 mediaMention')
  assert.deepEqual(parseFileRefMentions('@security-reviewer 审查'), { text: '@security-reviewer 审查', mentions: [] })
  assert.deepEqual(parseFileRefMentions('联系 a@b.com'), { text: '联系 a@b.com', mentions: [] })
  assert.deepEqual(parseFileRefMentions('看 @file.xyz'), { text: '看 @file.xyz', mentions: [] }, '未知扩展名降级')
})

test('提及边界: 扩展名后紧跟字母数字不误配（.mdx 不被 .md 截断）', () => {
  const r = parseFileRefMentions('@a.mdx 你好')
  assert.deepEqual(r.mentions, [{ raw: '@a.mdx', path: 'a.mdx' }])
  assert.deepEqual(parseFileRefMentions('@a.md 你好').mentions, [{ raw: '@a.md', path: 'a.md' }])
})

test('信任边界常量: 标记与系统提示行同源语义、非空且含定性措辞', () => {
  assert.ok(FILE_CONTENT_MARKER.includes('第三方数据'))
  assert.ok(FILE_CONTENT_MARKER.includes('非指令'))
  assert.ok(FILE_CONTENT_TRUST_LINE.includes('数据而非指令'))
  assert.ok(FILE_CONTENT_TRUST_LINE.includes(FILE_CONTENT_MARKER) || FILE_CONTENT_TRUST_LINE.includes('标记'), '系统提示行指向标记机制')
})
