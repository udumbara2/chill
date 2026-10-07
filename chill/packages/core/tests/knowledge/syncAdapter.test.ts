import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KNOWLEDGE_SNAPSHOT_VERSION,
  type KnowledgeSnapshot,
  type KnowledgeSyncAdapter,
} from '../../src/services/knowledge/syncAdapter.ts'

/** 样例快照：含 note/pdf/distilled 三种 docType，frontmatter 带 Windows 源路径 */
function makeSnapshot(): KnowledgeSnapshot {
  return {
    version: KNOWLEDGE_SNAPSHOT_VERSION,
    exportedAt: '2026-08-17T00:00:00.000Z',
    kb: {
      name: '技术笔记',
      description: '攒资料',
      createdAt: '2026-08-11T00:00:00.000Z',
      embeddingModel: 'text-embedding-v4',
      embeddingDimensions: 1024,
      enhancements: { summaryLayer: true, contextualPrefix: false },
    },
    docs: [
      {
        docId: 'd-aaa',
        frontmatter: { sourcePath: 'C:\\notes\\react.md', type: 'note', contentHash: 'h1', createdAt: '2026-08-11T01:00:00.000Z' },
        body: '# React 笔记\n\n## Hooks\n\nuseEffect 在依赖变化时执行。',
      },
      {
        docId: 'd-bbb',
        frontmatter: { sourcePath: 'C:\\docs\\paper.pdf', type: 'pdf', contentHash: 'h2', createdAt: '2026-08-11T02:00:00.000Z' },
        body: 'PDF 抽取的正文。',
      },
      {
        docId: 'd-ccc',
        frontmatter: { sourcePath: 'session:42#fact:1', type: 'distilled', contentHash: 'h3', createdAt: '2026-08-11T03:00:00.000Z' },
        body: '一条沉淀知识。',
      },
    ],
  }
}

/** 内存 stub adapter：export 从 Map 取、import 深拷贝存入（模拟远端往返的序列化语义） */
function makeStubAdapter(store = new Map<string, string>()): KnowledgeSyncAdapter {
  return {
    async exportSnapshot(kbName) {
      const raw = store.get(kbName)
      if (!raw) throw new Error(`stub 中不存在快照: ${kbName}`)
      return JSON.parse(raw) as KnowledgeSnapshot
    },
    async importSnapshot(snapshot) {
      store.set(snapshot.kb.name, JSON.stringify(snapshot))
    },
  }
}

test('接口契约：export→import 往返类型自洽', async () => {
  const a = makeStubAdapter()
  const snapshot = makeSnapshot()

  await a.importSnapshot(snapshot)
  const loaded = await a.exportSnapshot('技术笔记')

  assert.deepEqual(loaded, snapshot, '经 stub（含 JSON 序列化）往返后完全一致')
  assert.equal(loaded.version, KNOWLEDGE_SNAPSHOT_VERSION)
  assert.equal(loaded.kb.name, '技术笔记')
  assert.deepEqual(loaded.docs.map(d => d.frontmatter.type), ['note', 'pdf', 'distilled'])
  assert.equal(loaded.docs[0].frontmatter.sourcePath, 'C:\\notes\\react.md', 'Windows 源路径含冒号/反斜杠也应原样往返')
})

test('快照格式约定：纯 JSON 数据且不含索引', () => {
  const snapshot = makeSnapshot()
  // 远端传输的前提：JSON 往返自洽
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
  // 索引是易失推导物，不进入快照（导入后 rebuildIndex 再生）
  assert.ok(!('index' in snapshot) && !('chunks' in snapshot), '快照不应携带索引')
  assert.ok(snapshot.docs.every(d => !('embedding' in d)), '文档正本不嵌向量')
})

test('接口可按 kbName 隔离多库；导出缺失库报错', async () => {
  const adapter = makeStubAdapter()
  const s1 = makeSnapshot()
  const s2 = makeSnapshot()
  s2.kb = { ...s2.kb, name: '读书笔记' }

  await adapter.importSnapshot(s1)
  await adapter.importSnapshot(s2)
  assert.equal((await adapter.exportSnapshot('技术笔记')).kb.name, '技术笔记')
  assert.equal((await adapter.exportSnapshot('读书笔记')).kb.name, '读书笔记')
  await assert.rejects(() => adapter.exportSnapshot('不存在'), /不存在快照/)
})
