import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bm25Rank, cosineSimilarity, rrfFuse, tokenize } from '../../src/services/knowledge/vectorSearch.ts'

test('余弦：相同向量 1，正交 0，反向 -1，零向量 0', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9)
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9)
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9)
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, '零范数不除零，返回 0')
})

test('余弦：维度不一致抛中文错误', () => {
  assert.throws(() => cosineSimilarity([1, 0], [1, 0, 0]), /维度不一致/)
})

test('分词：中文按词（Intl.Segmenter zh），英文按空格/标点并小写', () => {
  const zh = tokenize('机器学习与深度学习')
  // zh word 粒度把「机器学习」切成「机器」「学习」等词，而不是逐字
  assert.ok(zh.includes('机器'), `应切出词「机器」，实际: ${zh}`)
  assert.ok(zh.includes('学习'), `应切出词「学习」，实际: ${zh}`)
  assert.ok(!zh.includes('机'), `不应逐字切，实际: ${zh}`)

  const en = tokenize('Hello, World! 42')
  assert.deepEqual(en, ['hello', 'world', '42'])
})

test('BM25：中文查询命中中文文档（不依赖空格分词）', () => {
  const hits = bm25Rank('机器学习', [
    '机器学习是人工智能的一个重要分支',
    '今天天气很好，适合出门散步',
  ])
  assert.equal(hits.length, 1, '只有含查询词的文档应得分')
  assert.equal(hits[0].index, 0)
  assert.ok(hits[0].score > 0)
})

test('BM25：等长文档词频高的排前，零匹配文档不出现在结果里', () => {
  // 等长语料排除长度归一化干扰，只比较词频
  const hits = bm25Rank('react hooks', [
    'react hooks 入门 指南',
    'vue 入门 教程 指南',
    'react hooks hooks hooks',
  ])
  assert.deepEqual(hits.map(h => h.index), [2, 0])
})

test('RRF：按名次融合，与两路分数量纲无关', () => {
  const fused = rrfFuse(
    [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
    [{ id: 'b', score: 5 }, { id: 'c', score: 3 }]
  )
  // b 两路都上榜（1/62 + 1/61）应第一；a（1/61）在 c（1/62）前
  assert.deepEqual(fused.map(f => f.id), ['b', 'a', 'c'])
  const b = fused[0]
  assert.equal(b.vectorScore, 0.8)
  assert.equal(b.bm25Score, 5)
  assert.ok(Math.abs(b.score - (1 / 62 + 1 / 61)) < 1e-12)
  assert.equal(fused[1].bm25Score, null, '缺路原始分记为 null')
  assert.equal(fused[2].vectorScore, null)
})
