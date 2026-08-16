import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkMarkdown, chunkPlainText, embeddingText, recursiveSplit } from '../../src/services/knowledge/chunker.ts'
import type { ChunkRecord } from '../../src/services/knowledge/types.ts'

/** 从扁平记录里拆出父块 / 子块 */
function splitParentChild(records: ChunkRecord[]) {
  return {
    parents: records.filter(r => !r.parentId),
    children: records.filter(r => r.parentId),
  }
}

// ==================== recursiveSplit ====================

test('递归切：短文本原样返回单块', () => {
  assert.deepEqual(recursiveSplit('短文本', 100, 0), ['短文本'])
  assert.deepEqual(recursiveSplit('   \n  ', 100, 0), [], '纯空白返回空')
})

test('递归切：切口落在句号边界，拼接还原原文', () => {
  const sentences = ['春眠不觉晓。', '处处闻啼鸟。', '夜来风雨声。', '花落知多少。']
  const text = sentences.join('')
  const chunks = recursiveSplit(text, 12, 0)
  assert.ok(chunks.length > 1)
  for (const c of chunks) {
    assert.ok(c.length <= 12, `块长 ${c.length} 超限`)
    assert.ok(c.endsWith('。'), `切口应落在句号: ${c}`)
  }
  assert.equal(chunks.join(''), text, '无重叠时拼接应还原原文')
})

test('递归切：段落分隔优先于句号', () => {
  // 两段各 12 字，maxSize 24 容得下两段整体；maxSize 14 必须按 \n\n 断
  const p1 = '第一段内容啊。'
  const p2 = '第二段内容啊。'
  const text = `${p1}\n\n${p2}`
  const chunks = recursiveSplit(text, 14, 0)
  assert.deepEqual(chunks, [p1, p2], '每段独立成块，切口在段落边界')
})

test('递归切：长段落降级到换行 / 句号', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `第${i}行内容。`)
  const text = lines.join('\n')
  const chunks = recursiveSplit(text, 20, 0)
  for (const c of chunks) {
    assert.ok(c.length <= 20)
    assert.ok(c.endsWith('。'), `切口应落在行末句号: ${c}`)
  }
  assert.equal(chunks.join('\n'), text)
})

test('递归切：无分隔符硬超限时按字符断', () => {
  const chunks = recursiveSplit('x'.repeat(100), 30, 0)
  assert.deepEqual(chunks.map(c => c.length), [30, 30, 30, 10])
})

test('递归切：重叠保留上一块尾部', () => {
  const chunks = recursiveSplit('x'.repeat(60), 30, 10)
  assert.ok(chunks.length >= 2)
  assert.ok(chunks[1].startsWith(chunks[0].slice(-10)), '后块开头 = 前块尾部 overlap')
})

test('递归切：非法 maxSize 抛错', () => {
  assert.throws(() => recursiveSplit('abc', 0), /maxSize/)
})

// ==================== chunkMarkdown ====================

const MD = [
  '# React',
  'React 简介内容。',
  '## Hooks',
  'Hooks 概述内容。',
  '### useEffect',
  'useEffect 的详细说明。',
  '## 总结',
  '总结内容。',
].join('\n')

test('Markdown：标题层级生成 headingPath，同级标题弹栈', () => {
  const { parents, children } = splitParentChild(chunkMarkdown(MD, { docId: 'd1' }))
  assert.equal(parents.length, 1, '小文档一个父块')
  const byText = (s: string) => children.find(c => c.text.includes(s))
  assert.equal(byText('useEffect 的详细说明')!.headingPath, 'React > Hooks > useEffect')
  assert.equal(byText('Hooks 概述内容')!.headingPath, 'React > Hooks')
  assert.equal(byText('总结内容')!.headingPath, 'React > 总结', '同级 ## 应弹掉 ### 与 ##')
  assert.equal(byText('React 简介内容')!.headingPath, 'React')
})

test('Markdown：子块带 parentId 指向父块，父块不嵌向量', () => {
  const records = chunkMarkdown(MD, { docId: 'd1' })
  const { parents, children } = splitParentChild(records)
  assert.ok(children.length > 0)
  const parentIds = new Set(parents.map(p => p.id))
  for (const c of children) {
    assert.ok(parentIds.has(c.parentId!), `子块 ${c.id} 的 parentId 应指向存在的父块`)
    assert.equal(c.docId, 'd1')
  }
  for (const p of parents) {
    assert.equal(p.parentId, undefined)
    assert.equal('embedding' in p, false, '父块不嵌向量')
  }
})

test('Markdown：超长节递归兜底，父子块大小约束成立', () => {
  const body = Array.from({ length: 100 }, (_, i) => `第${i}句的内容填充填充填充。`).join('\n')
  const text = `# 长节\n${body}\n`
  const records = chunkMarkdown(text, { docId: 'long' })
  const { parents, children } = splitParentChild(records)
  assert.ok(parents.length >= 2, `1600+ 字应切出多个父块，实际 ${parents.length}`)
  for (const p of parents) {
    assert.ok(p.text.length <= 1200, `父块 ${p.id} 长 ${p.text.length} 超 parentChunkSize`)
  }
  for (const c of children) {
    assert.ok(c.text.length <= 300, `子块 ${c.id} 长 ${c.text.length} 超 childChunkSize`)
    assert.equal(c.headingPath, '长节', '兜底拆分仍继承标题路径')
    assert.ok(c.text.endsWith('。'), `切口应落在句号: ...${c.text.slice(-10)}`)
    const parent = records.find(r => r.id === c.parentId)!
    assert.ok(parent.text.includes(c.text), '父块文本应覆盖其子块')
  }
  // 首尾子块覆盖原文首尾（偏移单调递增）
  for (let i = 1; i < children.length; i++) {
    assert.ok(children[i].charStart >= children[i - 1].charStart, '子块偏移应单调')
  }
  assert.equal(children[0].charStart, text.indexOf('# 长节'))
})

test('Markdown：自定义尺寸生效', () => {
  const body = Array.from({ length: 40 }, (_, i) => `第${i}句填充内容。`).join('\n')
  const records = chunkMarkdown(`# 节\n${body}`, { childChunkSize: 60, parentChunkSize: 150, docId: 'd2' })
  const { parents, children } = splitParentChild(records)
  assert.ok(parents.length > 1)
  for (const c of children) assert.ok(c.text.length <= 60)
  for (const p of parents) assert.ok(p.text.length <= 150)
})

test('Markdown：裸标题块并入下一块，不产孤立标题 chunk', () => {
  const records = chunkMarkdown('# 大标题\n## 小标题\n正文内容。', { docId: 'd3' })
  const { children } = splitParentChild(records)
  assert.equal(children.length, 1)
  assert.equal(children[0].headingPath, '大标题 > 小标题')
  assert.ok(children[0].text.includes('正文内容'))
})

test('Markdown：空文本返回空数组', () => {
  assert.deepEqual(chunkMarkdown(''), [])
  assert.deepEqual(chunkMarkdown('  \n\n  '), [])
})

// ==================== chunkPlainText ====================

test('纯文本：递归切 + 父子块，无标题路径', () => {
  const text = Array.from({ length: 80 }, (_, i) => `第${i}段纯文本内容。`).join('\n\n')
  const records = chunkPlainText(text, { docId: 'pdf1' })
  const { parents, children } = splitParentChild(records)
  assert.ok(parents.length >= 1 && children.length > parents.length)
  for (const r of records) assert.equal(r.headingPath, undefined, '纯文本无标题路径')
  const parentIds = new Set(parents.map(p => p.id))
  for (const c of children) {
    assert.ok(c.text.length <= 300)
    assert.ok(parentIds.has(c.parentId!))
  }
})

test('纯文本：短文本单父单子', () => {
  const { parents, children } = splitParentChild(chunkPlainText('一段很短的话。', { docId: 'p2' }))
  assert.equal(parents.length, 1)
  assert.equal(children.length, 1)
  assert.equal(children[0].parentId, parents[0].id)
  assert.equal(children[0].text, '一段很短的话。')
})

// ==================== embeddingText ====================

test('embeddingText：标题路径前缀 + 正文', () => {
  const records = chunkMarkdown(MD, { docId: 'd4' })
  const child = records.find(r => r.parentId && r.text.includes('useEffect 的详细说明'))!
  assert.equal(embeddingText(child), `React > Hooks > useEffect\n${child.text}`)
  assert.equal(embeddingText({ ...child, headingPath: undefined }), child.text, '无路径时就是正文')
})
