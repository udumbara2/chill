import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionPersistence } from '../../src/persistence/SessionPersistence.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import { setSessionTaskCleaner } from '../../src/services/scheduler/sessionTaskCleaner.ts'
import type { IPathProvider } from '../../src/interfaces/IPathProvider.ts'

/**
 * M5 会话删除的定时任务清账（规划《定时任务 serve 持钟与定向路由》）：
 * SessionPersistence.delete 成功后 best-effort 调用进程级清账器（照看板归档先例）；
 * 清账失败不阻断删除（残留由下次触发时的路由 orphan 分支兜底）。
 */

function makePersistence() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chill-cleaner-test-'))
  const sdir = join(dir, 'sessions')
  const provider = { getUserDataPath: () => dir, getUserHomePath: () => dir } as IPathProvider
  return { dir, persistence: new SessionPersistence(provider, sdir) }
}

function recordOf(id: string): SessionRecord {
  return {
    id,
    title: 't',
    messages: [],
    createdAt: '2026-08-17T09:00:00.000Z',
    updatedAt: '2026-08-17T09:00:00.000Z',
  } as SessionRecord
}

test('delete 成功 → 清账器以被删会话 id 被调用；未装配=无操作；清账抛错不阻断删除', async () => {
  const { dir, persistence } = makePersistence()
  try {
    await persistence.save(recordOf('s-del'))
    await persistence.save(recordOf('s-keep'))

    // ① 未装配：现状路径（无清账、不抛错）
    let r = await persistence.delete('s-keep')
    assert.equal(r.success, true)

    // ② 装配：删除成功后清账器收到被删会话 id
    const seen: string[] = []
    setSessionTaskCleaner(async (sessionId) => {
      seen.push(sessionId)
      return [`${sessionId}-t1`]
    })
    try {
      r = await persistence.delete('s-del')
      assert.equal(r.success, true)
      assert.deepEqual(seen, ['s-del'], '清账器以被删会话 id 被调用（四壳删除路径单一收口）')

      // ③ 清账器抛错：不阻断删除（best-effort）
      setSessionTaskCleaner(async () => {
        throw new Error('清账失败模拟')
      })
      await persistence.save(recordOf('s-err'))
      r = await persistence.delete('s-err')
      assert.equal(r.success, true, '清账失败不阻断会话删除')
    } finally {
      setSessionTaskCleaner(null) // 进程级单槽：测试后必须复位，防污染其他测试
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
