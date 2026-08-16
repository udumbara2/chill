import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore, normalizeTitle } from '../../src/services/memory/memoryStore.ts'

/** 内联 Node fsProvider（同 IFileSystemProvider 形状） */
function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memtest-'))
  const fsProvider = {
    readFile: async (p: string) => {
      try { return { success: true, data: { content: fs.readFileSync(p, 'utf-8') } } } catch { return { success: false } }
    },
    writeFile: async (p: string, content: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content, 'utf-8')
      return { success: true }
    },
    deleteFile: async (p: string) => { try { fs.unlinkSync(p); return { success: true } } catch { return { success: false } } },
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
  const store = MemoryStore.getInstance()
  store.init(fsProvider as any, { getUserDataPath: () => path.join(home, '.chill'), getUserHomePath: () => home } as any)
  return { home, store, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

const batch = (title: string, ts = 0) => ({
  createdAt: new Date(ts || Date.now()).toISOString(),
  sourceSessionId: 's1',
  candidates: [{ type: 'user' as const, title, content: '正文' }],
})

test('写时去重：同标题仅一份（pending 内去重）', async () => {
  const { store, cleanup } = makeEnv()
  const f1 = await store.writePending(batch('偏好简洁回答'))
  const f2 = await store.writePending(batch('偏好简洁回答'))
  assert.ok(f1 !== null)
  assert.equal(f2, null, '重复标题应被丢弃不创建文件')
  const pending = await store.listPending()
  assert.equal(pending.flatMap(b => b.candidates).length, 1)
  cleanup()
})

test('写时去重：已在裁决日志的标题直接丢弃', async () => {
  const { store, cleanup } = makeEnv()
  await store.writeReviewed({ [normalizeTitle('已处理条目')]: { verdict: 'rejected', at: new Date().toISOString() } })
  const f = await store.writePending(batch('已处理条目'))
  assert.equal(f, null)
  cleanup()
})

test('裁决日志：读-合并-写 + first-decision-wins', async () => {
  const { store, cleanup } = makeEnv()
  await store.writeReviewed({ a: { verdict: 'approved', at: '2026-01-01T00:00:00Z' } })
  await store.writeReviewed({ a: { verdict: 'rejected', at: '2026-01-02T00:00:00Z' }, b: { verdict: 'rejected', at: '2026-01-02T00:00:00Z' } })
  const reviewed = await store.readReviewed()
  assert.equal(reviewed.a.verdict, 'approved', '已存在键不得被覆写')
  assert.equal(reviewed.b.verdict, 'rejected')
  cleanup()
})

test('reviewPending：批准入库 + 其余记 rejected + 清空', async () => {
  const { store, cleanup } = makeEnv()
  await store.writePending(batch('保存我'))
  await store.writePending(batch('不要我'))
  const result = await store.reviewPending(['保存我'])
  assert.equal(result.success, true)
  assert.equal(result.saved, 1)
  assert.equal(result.discarded, 1)
  const reviewed = await store.readReviewed()
  assert.equal(reviewed[normalizeTitle('保存我')].verdict, 'approved')
  assert.equal(reviewed[normalizeTitle('不要我')].verdict, 'rejected')
  assert.equal((await store.listPending()).length, 0)
  cleanup()
})

test('listPendingFiltered 与 notice 空过滤返回 null', async () => {
  const { store, cleanup } = makeEnv()
  await store.writePending(batch('已裁决的'))
  await store.writeReviewed({ [normalizeTitle('已裁决的')]: { verdict: 'rejected', at: new Date().toISOString() } })
  assert.equal((await store.listPendingFiltered()).length, 0)
  assert.equal(await store.buildPendingNotice(), null)
  cleanup()
})

test('notice 含未裁决条目与 exitHint', async () => {
  const { store, cleanup } = makeEnv()
  await store.writePending(batch('未处理'))
  const notice = await store.buildPendingNotice('（也可以 /memory review）')
  assert.ok(notice !== null && notice.includes('未处理') && notice.includes('/memory review'))
  cleanup()
})

test('distill-state 水位读写与旧格式迁移', async () => {
  const { store, cleanup } = makeEnv()
  // 旧格式
  fs.mkdirSync((store as any).memoryDir(), { recursive: true })
  fs.writeFileSync(
    path.join((store as any).memoryDir(), '.distill-state.json'),
    JSON.stringify({ sessionId: 'x', updatedAt: '2026-01-01' })
  )
  const migrated = await store.readDistillState()
  assert.deepEqual(migrated, { watermarks: {} })
  await store.writeDistillState({ watermarks: { s1: 123 } })
  const state = await store.readDistillState()
  assert.equal(state?.watermarks.s1, 123)
  cleanup()
})
