import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamRuntimeService,
  setTeamRuntimeService,
  resetTeamRuntimeService,
} from '../../src/services/team/TeamRuntimeService.ts'
import { resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/**
 * BoardItem.claimedAt(看板显示三段式 · 迭代 1):"已认领 N 分钟"计时基线——
 * claim 写入(认领 mutation 唯一收敛点)/ release 清除 / 无 claim 无字段(旧数据兼容)。
 */

/** 内存 fs 桩(与 teamProbeEmptyState.test.ts 同款) */
function memFs(): IFileSystemProvider {
  const written = new Map<string, string>()
  const norm = (p: string) => p.replace(/\\/g, '/')
  return {
    getCurrentDirectory: () => null,
    readFile: async (p: string) =>
      written.has(norm(p))
        ? { success: true, data: { content: written.get(norm(p))! } }
        : { success: false, error: 'nf' },
    writeFile: async (p: string, content: string) => {
      written.set(norm(p), content)
      return { success: true }
    },
    renameFile: async (from: string, to: string) => {
      written.set(norm(to), written.get(norm(from)) ?? '')
      written.delete(norm(from))
      return { success: true }
    },
    deleteFile: async () => ({ success: true }),
    listDirectory: async () => ({ success: true, data: { files: [] } }),
    fileExists: async () => ({ success: true, data: false }),
  } as unknown as IFileSystemProvider
}

let svc: TeamRuntimeService

beforeEach(() => {
  resetTeamRuntimeService()
  resetTaskRegistry()
  svc = new TeamRuntimeService(memFs(), '/team-runs')
  setTeamRuntimeService(svc)
})

test('claimedAt:无 claim 无字段(旧数据兼容);claim 写入认领时刻', async () => {
  svc.ensureAdHocTeam()
  const { item } = await svc.boardPost({ title: '调研热点', createdBy: 'lead' })
  assert.equal(item.claimedAt, undefined) // 未认领:无字段,显示层不显示时长

  const before = Date.now()
  const { item: claimed } = await svc.boardClaim(item.id, '调研员')
  assert.equal(typeof claimed.claimedAt, 'number')
  assert.ok(claimed.claimedAt! >= before)
})

test('claimedAt:release 清除;再认领重新写入', async () => {
  svc.ensureAdHocTeam()
  const { item } = await svc.boardPost({ title: '撰写初稿', createdBy: 'lead' })
  const { item: claimed } = await svc.boardClaim(item.id, '撰稿员')
  const firstClaimAt = claimed.claimedAt!

  const { item: released } = await svc.boardRelease(item.id, 'lead', { reason: '换源重来' })
  assert.equal(released.claimedAt, undefined) // 回流待认领:清除
  assert.equal(released.assignee, undefined)
  assert.equal(released.releaseHistory!.length, 1) // 留痕不受影响

  // 再认领:重新写入(覆盖语义)
  const { item: reclaimed } = await svc.boardClaim(item.id, '校对员')
  assert.equal(typeof reclaimed.claimedAt, 'number')
  assert.ok(reclaimed.claimedAt! >= firstClaimAt)
})

test('claimedAt:lead 认领同样写入(成员行不计,但气泡进行中分组显示时长)', async () => {
  svc.ensureAdHocTeam()
  const { item } = await svc.boardPost({ title: 'lead 亲自跟进', createdBy: 'lead' })
  const { item: claimed } = await svc.boardClaim(item.id, 'lead')
  assert.equal(typeof claimed.claimedAt, 'number')
  assert.equal(claimed.claimedByTaskId, undefined) // lead 认领无任务绑定(既有语义不动)
})
