import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KnowledgeStore, emptyKnowledgeIndex, isValidKbName } from '../../src/services/knowledge/knowledgeStore.ts'
import { DEFAULT_KNOWLEDGE_CONFIG } from '../../src/services/knowledge/types.ts'

/** 内联 Node fsProvider（同 IFileSystemProvider 形状；deleteFile 支持删目录） */
function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbtest-'))
  const fsProvider = {
    readFile: async (p: string) => {
      try { return { success: true, data: { content: fs.readFileSync(p, 'utf-8') } } } catch { return { success: false } }
    },
    writeFile: async (p: string, content: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content, 'utf-8')
      return { success: true }
    },
    deleteFile: async (p: string) => { try { fs.rmSync(p, { recursive: true, force: true }); return { success: true } } catch { return { success: false } } },
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
  return { home, store, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

const frontmatter = (hash = 'h1') => ({
  sourcePath: 'C:\\notes\\react.md',
  type: 'note' as const,
  contentHash: hash,
  createdAt: '2026-08-11T00:00:00.000Z',
})

test('全局配置：缺失文件返回默认值', async () => {
  const { store, cleanup } = makeEnv()
  assert.deepEqual(await store.getGlobalConfig(), DEFAULT_KNOWLEDGE_CONFIG)
  cleanup()
})

test('全局配置：部分字段缺失逐节合并默认值', async () => {
  const { store, cleanup } = makeEnv()
  fs.mkdirSync(store.knowledgeDir(), { recursive: true })
  fs.writeFileSync(
    path.join(store.knowledgeDir(), 'knowledge.json'),
    JSON.stringify({ embedding: { model: 'text-embedding-v3' }, retrieval: { topK: 10 } })
  )
  const config = await store.getGlobalConfig()
  assert.equal(config.embedding.model, 'text-embedding-v3', '显式字段覆盖默认值')
  assert.equal(config.embedding.dimensions, 1024, '未写字段落回默认')
  assert.equal(config.retrieval.topK, 10)
  assert.equal(config.retrieval.similarityThreshold, 0.5)
  assert.equal(config.rerank.enabled, true)
  cleanup()
})

test('全局配置：保存后读取往返 + 损坏文件落回默认', async () => {
  const { store, cleanup } = makeEnv()
  const config = structuredClone(DEFAULT_KNOWLEDGE_CONFIG)
  config.rerank.enabled = false
  assert.equal((await store.saveGlobalConfig(config)).success, true)
  assert.equal((await store.getGlobalConfig()).rerank.enabled, false)
  fs.writeFileSync(path.join(store.knowledgeDir(), 'knowledge.json'), '{broken')
  assert.deepEqual(await store.getGlobalConfig(), DEFAULT_KNOWLEDGE_CONFIG)
  cleanup()
})

test('建库/列库/删库：kb.json 带 embedding 快照', async () => {
  const { store, cleanup } = makeEnv()
  assert.deepEqual(await store.listKnowledgeBases(), [])

  assert.equal((await store.createKnowledgeBase('技术笔记', '攒资料')).success, true)
  const config = await store.getKnowledgeBaseConfig('技术笔记')
  assert.equal(config?.name, '技术笔记')
  assert.equal(config?.description, '攒资料')
  assert.equal(config?.embeddingModel, DEFAULT_KNOWLEDGE_CONFIG.embedding.model)
  assert.equal(config?.embeddingDimensions, DEFAULT_KNOWLEDGE_CONFIG.embedding.dimensions)
  assert.ok(config?.createdAt)

  const dup = await store.createKnowledgeBase('技术笔记')
  assert.equal(dup.success, false, '重名建库应失败')

  const invalid = await store.createKnowledgeBase('a/b')
  assert.equal(invalid.success, false, '含路径分隔符的名字应被拒绝')
  assert.equal(isValidKbName(''), false)

  const kbs = await store.listKnowledgeBases()
  assert.deepEqual(kbs.map(k => k.name), ['技术笔记'])

  assert.equal((await store.deleteKnowledgeBase('技术笔记')).success, true)
  assert.equal(fs.existsSync(path.join(store.knowledgeDir(), '技术笔记')), false, '整目录应被删除')
  assert.deepEqual(await store.listKnowledgeBases(), [])
  assert.equal((await store.deleteKnowledgeBase('技术笔记')).success, false, '重复删库应报错')
  cleanup()
})

test('索引：读写往返（含父子块）', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')
  assert.equal(await store.readIndex('kb1'), null, '未写索引前返回 null')

  const index = emptyKnowledgeIndex(await store.getGlobalConfig())
  index.chunks.push(
    { id: 'p1', docId: 'doc1', charStart: 0, charEnd: 1000, text: '父块正文' },
    { id: 'c1', docId: 'doc1', parentId: 'p1', headingPath: 'React > Hooks', charStart: 0, charEnd: 300, text: '子块正文', embedding: [0.1, 0.2] },
  )
  assert.equal((await store.saveIndex('kb1', index)).success, true)

  const loaded = await store.readIndex('kb1')
  assert.deepEqual(loaded, index)
  assert.equal(loaded?.chunks[1].parentId, 'p1')
  assert.equal(loaded?.chunks[1].headingPath, 'React > Hooks')
  cleanup()
})

test('文档：save/read/list/delete 往返', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')
  assert.deepEqual(await store.listDocs('kb1'), [])

  assert.equal((await store.saveDoc('kb1', 'doc1', frontmatter(), '# 标题\n\n正文内容')).success, true)
  const doc = await store.readDoc('kb1', 'doc1')
  assert.equal(doc?.frontmatter.sourcePath, 'C:\\notes\\react.md', 'Windows 源路径含冒号也应解析正确')
  assert.equal(doc?.frontmatter.type, 'note')
  assert.equal(doc?.frontmatter.contentHash, 'h1')
  assert.equal(doc?.body, '# 标题\n\n正文内容')

  await store.saveDoc('kb1', 'doc2', frontmatter('h2'), '另一篇')
  assert.deepEqual(await store.listDocs('kb1'), ['doc1', 'doc2'])

  assert.equal((await store.deleteDoc('kb1', 'doc1')).success, true)
  assert.equal(await store.readDoc('kb1', 'doc1'), null)
  assert.deepEqual(await store.listDocs('kb1'), ['doc2'])
  cleanup()
})

test('快照比对：换模型/维度后不一致，无索引视为一致', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')
  assert.equal(await store.isIndexEmbeddingCurrent('kb1'), true, '无索引无需重建')

  const index = emptyKnowledgeIndex(await store.getGlobalConfig())
  await store.saveIndex('kb1', index)
  assert.equal(await store.isIndexEmbeddingCurrent('kb1'), true, '快照与全局配置一致')

  const config = await store.getGlobalConfig()
  config.embedding.model = 'text-embedding-v3'
  await store.saveGlobalConfig(config)
  assert.equal(await store.isIndexEmbeddingCurrent('kb1'), false, '换模型后应检出快照不一致')

  config.embedding.dimensions = 512
  await store.saveGlobalConfig(config)
  assert.equal(await store.isIndexEmbeddingCurrent('kb1'), false)
  cleanup()
})

test('未初始化：方法抛明确错误', async () => {
  const fresh = new (KnowledgeStore as any)()
  await assert.rejects(() => fresh.getGlobalConfig(), /KnowledgeStore 未初始化/)
  await assert.rejects(() => fresh.listKnowledgeBases(), /KnowledgeStore 未初始化/)
  assert.throws(() => fresh.knowledgeDir(), /KnowledgeStore 未初始化/)
})
