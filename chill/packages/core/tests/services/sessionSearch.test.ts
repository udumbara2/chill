import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchSessionRecords, listSessionSummaries } from '../../src/services/sessionSearch.ts'
import { extractEntry, ensureIndex, INDEX_VERSION, indexPathOf } from '../../src/services/sessionIndex.ts'

function setup(t: import('node:test').TestContext): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chill-ss-'))
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function writeSession(dir: string, id: string, title: string, texts: string[], updatedAt: string): void {
  const record = {
    id,
    title,
    messages: texts.map((text, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: text, timestamp: updatedAt })),
    createdAt: updatedAt,
    updatedAt,
  }
  fs.writeFileSync(join(dir, `${id}.json`), JSON.stringify(record))
}

test('会话搜索: 标题命中返回 preview，正文命中返回片段', (t) => {
  const dir = setup(t)
  writeSession(dir, 'a', '深度模型选型讨论', ['随便聊聊'], '2026-08-10T10:00:00Z')
  writeSession(dir, 'b', '普通标题', ['我们讨论一下深度学习的优化'], '2026-08-11T10:00:00Z')
  writeSession(dir, 'c', '无关会话', ['天气不错'], '2026-08-12T10:00:00Z')

  const hits = searchSessionRecords(dir, '深度')
  assert.equal(hits.length, 2)
  const byId = new Map(hits.map(h => [h.id, h]))
  assert.equal(byId.get('a')?.matchKind, 'title')
  assert.equal(byId.get('b')?.matchKind, 'content')
  assert.ok(byId.get('b')!.snippet.includes('深度学习'))
})

test('会话搜索: 多词元 AND、顺序无关；空白 query 返回空', (t) => {
  const dir = setup(t)
  writeSession(dir, 'a', '部署 DeepSeek V4 到生产', ['ok'], '2026-08-10T10:00:00Z')

  assert.equal(searchSessionRecords(dir, 'deepseek v4').length, 1) // 大小写与连字符差异兼容
  assert.equal(searchSessionRecords(dir, 'v4 deepseek').length, 1) // 顺序无关
  assert.equal(searchSessionRecords(dir, 'deepseek 不存在词').length, 0) // AND 语义
  assert.deepEqual(searchSessionRecords(dir, '   '), [])
})

test('会话搜索: limit 生效；损坏文件跳过不中断', (t) => {
  const dir = setup(t)
  for (let i = 0; i < 5; i++) {
    writeSession(dir, `s${i}`, `目标词 会话${i}`, ['内容'], `2026-08-1${i}T10:00:00Z`)
  }
  fs.writeFileSync(join(dir, 'broken.json'), '{not json')

  const hits = searchSessionRecords(dir, '目标词', 3)
  assert.equal(hits.length, 3)
})

test('extractEntry: 从 record 拷贝 projectId/workdir/titleSource；无该字段时为 undefined', () => {
  const record = {
    id: 'ignored', // id 以文件名（寻址真相）为准
    title: 't',
    titleSource: 'manual',
    messages: [{ role: 'user', content: 'hello', timestamp: '2026-08-10T10:00:00Z' }],
    createdAt: '2026-08-10T10:00:00Z',
    updatedAt: '2026-08-11T10:00:00Z',
    projectId: 'proj-1',
    workdir: '/data/proj-a',
  }
  const entry = extractEntry('file-id', record, 100, 1234567890)
  assert.equal(entry.id, 'file-id')
  assert.equal(entry.projectId, 'proj-1')
  assert.equal(entry.workdir, '/data/proj-a')
  assert.equal(entry.titleSource, 'manual')

  const bare = extractEntry('file-id', { title: 't', messages: [] }, 10, 20)
  assert.equal(bare.projectId, undefined)
  assert.equal(bare.workdir, undefined)
  assert.equal(bare.titleSource, undefined)
})

test('listSessionSummaries: 旧版索引（v 行不符）整体废弃重建，写回当前版本', async (t) => {
  const dir = setup(t)
  writeSession(dir, 'a', '会话A', ['内容'], '2026-08-10T10:00:00Z')
  // 手写一份 v1 旧索引（条目缺 projectId/workdir，属上一 schema）
  const staleEntry = { id: 'a', title: '旧标题', preview: '', createdAt: '', updatedAt: '2026-08-10T10:00:00Z', messageCount: 1, bytes: 1, mtimeMs: 1 }
  fs.writeFileSync(indexPathOf(dir), `{"v":${INDEX_VERSION - 1}}\n${JSON.stringify(staleEntry)}\n`)

  // v 行不符 → 全量重建：结果来自正文 re-parse（标题是新值），并写回当前版本头
  const summaries = await listSessionSummaries(dir)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].title, '会话A')
  const head = JSON.parse(fs.readFileSync(indexPathOf(dir), 'utf-8').split('\n')[0])
  assert.equal(head.v, INDEX_VERSION)
})

test('listSessionSummaries: updatedAt 降序返回，projectId/workdir 随条目带出', async (t) => {
  const dir = setup(t)
  writeSession(dir, 'a', '会话A', ['内容'], '2026-08-10T10:00:00Z')
  writeSession(dir, 'b', '会话B', ['内容'], '2026-08-12T10:00:00Z')
  writeSession(dir, 'c', '会话C', ['内容'], '2026-08-11T10:00:00Z')
  // 给 b 补上归属字段（writeSession 不写）
  const bPath = join(dir, 'b.json')
  const bRecord = JSON.parse(fs.readFileSync(bPath, 'utf-8'))
  bRecord.projectId = 'proj-1'
  bRecord.workdir = '/data/proj-a'
  bRecord.titleSource = 'manual'
  fs.writeFileSync(bPath, JSON.stringify(bRecord))

  const summaries = await listSessionSummaries(dir)
  assert.deepEqual(summaries.map(s => s.id), ['b', 'c', 'a'])
  const b = summaries[0]
  assert.equal(b.projectId, 'proj-1')
  assert.equal(b.workdir, '/data/proj-a')
  assert.equal(b.titleSource, 'manual')
  assert.equal(b.title, '会话B')
  assert.equal(b.createdAt, '2026-08-12T10:00:00Z')
  assert.equal(summaries[1].projectId, undefined)
  assert.equal(summaries[1].titleSource, undefined)
  // 元数据粒度：不含 messages
  assert.equal('messages' in b, false)
})

test('listSessionSummaries: 索引写回后二次调用零 parse；改一个文件只重 parse 该文件', async (t) => {
  const dir = setup(t)
  writeSession(dir, 'a', '会话A', ['内容'], '2026-08-10T10:00:00Z')
  writeSession(dir, 'b', '会话B', ['内容'], '2026-08-11T10:00:00Z')
  writeSession(dir, 'c', '会话C', ['内容'], '2026-08-12T10:00:00Z')

  // 首次调用 dirty → 原子写回索引；此后 stat 指纹全命中 → parsedCount 0
  await listSessionSummaries(dir)
  let check = ensureIndex(dir)
  assert.equal(check.parsedCount, 0)

  // 只改 b（内容变 → bytes 指纹变，无论 mtime 是否前进都必被检出）
  writeSession(dir, 'b', '会话B改', ['新内容新内容'], '2026-08-13T10:00:00Z')
  check = ensureIndex(dir)
  assert.equal(check.parsedCount, 1)

  // 增量结果正确：b 的新标题生效且排到最前
  const summaries = await listSessionSummaries(dir)
  assert.deepEqual(summaries.map(s => s.id), ['b', 'c', 'a'])
  assert.equal(summaries[0].title, '会话B改')
})
