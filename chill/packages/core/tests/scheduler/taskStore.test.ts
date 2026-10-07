import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../../src/services/scheduler/TaskStore.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'
import type { ScheduledTask } from '../../src/services/scheduler/types.ts'

const FILE = '/home/user/.chill/scheduled-tasks.json'

function makeTask(id: string, extra: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    cron: '0 9 * * *',
    prompt: '汇总昨天进展',
    recurring: true,
    scope: 'project',
    workDir: '/proj',
    createdAt: '2026-08-18T00:00:00.000Z',
    fireCount: 0,
    status: 'active',
    ...extra,
  }
}

/** 内存假 fsProvider（可选 renameFile：具备时走 tmp+rename 原子写路径），带调用计数 */
function makeFakeFs(initialFiles: Record<string, string> = {}, withRename = true) {
  const files = new Map(Object.entries(initialFiles))
  const counters = { readFile: 0, writeFile: 0, renameFile: 0 }
  const fs: IFileSystemProvider & { renameFile?: (from: string, to: string) => Promise<{ success: boolean }> } = {
    readFile: async (p: string) => {
      counters.readFile++
      const content = files.get(p)
      return content === undefined ? { success: false, error: 'not found' } : { success: true, data: { content } }
    },
    writeFile: async (p: string, content: string) => {
      counters.writeFile++
      files.set(p, content)
      return { success: true }
    },
    deleteFile: async (p: string) => {
      files.delete(p)
      return { success: true }
    },
    listDirectory: async () => ({ success: true, data: { files: [] } }),
    getCurrentDirectory: () => null,
    fileExists: async (p: string) => ({ success: true, data: files.has(p) }),
    getPathType: async (p: string) => ({
      success: true,
      data: { type: files.has(p) ? ('file' as const) : ('not_found' as const) },
    }),
  }
  if (withRename) {
    fs.renameFile = async (from: string, to: string) => {
      counters.renameFile++
      const content = files.get(from)
      if (content === undefined) return { success: false }
      files.set(to, content)
      files.delete(from)
      return { success: true }
    }
  }
  return { fs, files, counters }
}

/** 假 mtime provider：value 由测试手动拨动 */
function makeFakeMtime(initial: number | null = 1000) {
  const state = { value: initial as number | null, calls: 0 }
  return {
    state,
    provider: {
      getMtimeMs: async () => {
        state.calls++
        return state.value
      },
    },
  }
}

// ==================== 读写回环 ====================

test('原子写回环：saveAll 经 tmp+rename 落盘，checkReload 读回同内容', async () => {
  const { fs, files, counters } = makeFakeFs()
  const mtime = makeFakeMtime()
  const store = new TaskStore(fs, FILE, mtime.provider)

  const tasks = [makeTask('t-1'), makeTask('t-2', { scope: 'session', sessionId: 's-1', workDir: undefined })]
  assert.equal(await store.saveAll(tasks), true)
  assert.equal(counters.renameFile, 1, '具备 renameFile 时应走 tmp+rename')
  assert.ok(!files.has(`${FILE}.tmp`), 'rename 后 tmp 不残留')

  // 换实例重读（模拟另一进程视角）
  mtime.state.value = 2000
  const store2 = new TaskStore(fs, FILE, mtime.provider)
  const loaded = await store2.checkReload()
  assert.equal(loaded.length, 2)
  assert.equal(loaded[0].id, 't-1')
  assert.equal(loaded[1].sessionId, 's-1')
  assert.deepEqual(store2.getErrors(), [])
})

test('无 renameFile 宿主：退化直写同样可回环', async () => {
  const { fs } = makeFakeFs({}, false)
  const store = new TaskStore(fs, FILE, makeFakeMtime().provider)
  assert.equal(await store.saveAll([makeTask('t-1')]), true)
  assert.equal((await store.checkReload())[0].id, 't-1')
})

// ==================== mtime 惰性重载 ====================

test('mtime 未变零读盘；变化才重读；本实例写盘不回声重载', async () => {
  const { fs, files, counters } = makeFakeFs({ [FILE]: JSON.stringify({ version: 1, tasks: [makeTask('t-1')] }) })
  const mtime = makeFakeMtime(1000)
  const store = new TaskStore(fs, FILE, mtime.provider)

  await store.checkReload()
  assert.equal(counters.readFile, 1)
  await store.checkReload() // mtime 未变 → 零读盘
  assert.equal(counters.readFile, 1)

  // 外部修改 + mtime 变化 → 重读
  files.set(FILE, JSON.stringify({ version: 1, tasks: [makeTask('t-1'), makeTask('t-2')] }))
  mtime.state.value = 2000
  assert.equal((await store.checkReload()).length, 2)
  assert.equal(counters.readFile, 2)

  // 本实例 saveAll 后 mtime 基线刷新 → 立即 checkReload 不重读
  mtime.state.value = 3000 // saveAll 写后宿主 mtime 变化
  await store.saveAll([makeTask('t-3')])
  const readsAfterSave = counters.readFile
  await store.checkReload()
  assert.equal(counters.readFile, readsAfterSave, '自己写入后不应触发回声重载')
})

test('文件不存在视为空清单（非错误）', async () => {
  const { fs } = makeFakeFs()
  const store = new TaskStore(fs, FILE, makeFakeMtime(null).provider)
  assert.deepEqual(await store.checkReload(), [])
  assert.deepEqual(store.getErrors(), [])
})

// ==================== 损坏容错 ====================

test('JSON 损坏：fail-open 空清单 + 错误明细', async () => {
  const { fs } = makeFakeFs({ [FILE]: '{broken json' })
  const store = new TaskStore(fs, FILE, makeFakeMtime().provider)
  assert.deepEqual(await store.checkReload(), [])
  assert.ok(store.getErrors().some((e) => e.includes('JSON 解析失败')))
})

test('非法条目跳过不中断；合法条目补齐默认值', async () => {
  const content = JSON.stringify({
    version: 1,
    tasks: [
      { id: '', prompt: '无 id' }, // 跳过
      { prompt: '无 cron/at', id: 'bad-2' }, // 跳过
      'not-an-object', // 跳过
      { id: 'good', cron: '0 9 * * *', prompt: 'x', recurring: true, scope: 'project', createdAt: '2026-08-18T00:00:00Z' },
    ],
  })
  const { fs } = makeFakeFs({ [FILE]: content })
  const store = new TaskStore(fs, FILE, makeFakeMtime().provider)
  const tasks = await store.checkReload()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].id, 'good')
  assert.equal(tasks[0].fireCount, 0)
  assert.equal(tasks[0].status, 'active')
  assert.equal(store.getErrors().length, 3)
})
