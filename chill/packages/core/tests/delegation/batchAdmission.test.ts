import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamRuntimeService,
  setTeamRuntimeService,
  resetTeamRuntimeService,
} from '../../src/services/team/TeamRuntimeService.ts'
import { executeBatchTask, executeTaskToolCalls } from '../../src/services/delegation/delegationTools.ts'
import type { ToolCall } from '../../src/types/models.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/**
 * batch_task 准入迁移(统一协作基板迭代 2)回归:
 * - 成员发起的 batch = 拉新,三闸不过原子拒绝整批;
 * - 与单 task 同款的 preflight 对齐:失败成员登记后立即按失败结清(批次可见,无"执行中"幽灵)。
 */

function memFs(): IFileSystemProvider & { written: Map<string, string> } {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const written = new Map<string, string>()
  return {
    written,
    getCurrentDirectory: () => null,
    readFile: async (p: string) =>
      written.has(norm(p)) ? { success: true, data: { content: written.get(norm(p))! } } : { success: false, error: 'nf' },
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
  } as unknown as IFileSystemProvider & { written: Map<string, string> }
}

let svc: TeamRuntimeService

beforeEach(async () => {
  resetTeamRuntimeService()
  resetTaskRegistry()
  svc = new TeamRuntimeService(memFs(), '/team-runs')
  setTeamRuntimeService(svc)
  await svc.formFromDefinition({ name: 'news-team', version: 1, members: [{ agent: 'researcher' }] })
})

afterEach(() => {
  resetTaskRegistry()
})

test('batch 拉新门:成员无 task 授权发起 batch → 原子拒绝整批', async () => {
  await svc.registerMember({ agent: 'researcher', taskId: 't-caller' })
  const res = await executeBatchTask('batch-1', {
    tasks: [
      { subagent_type: 'general-purpose', task_description: 'A' },
      { subagent_type: 'general-purpose', task_description: 'B' },
    ],
    __origin: { source: 'subagent', taskId: 't-caller' },
  } as never)
  assert.equal(res.success, false)
  assert.match(res.error!, /未授予你委派/)
  assert.equal(getTaskRegistry().list().length, 0, '整批拒绝,零登记')
})

test('batch 预检对齐:预检失败的成员登记后即失败结清(批次可见,无执行中幽灵)', async () => {
  // lead 发起(无 origin);成员模板不存在 → 预检确定性失败(与执行器初始化状态无关)
  const res = await executeBatchTask('batch-2', {
    tasks: [
      { subagent_type: 'no-such-template', task_description: 'A' },
      { subagent_type: 'no-such-template', task_description: 'B' },
    ],
  } as never)
  assert.equal(res.success, true) // 批次受理(占位),成员逐个按预检结果结清
  await new Promise((r) => setTimeout(r, 50)) // forEach 回调是异步的:等预检+结清微任务落地再断言
  const registry = getTaskRegistry()
  const entries = registry.list()
  assert.equal(entries.length, 2)
  for (const e of entries) {
    assert.equal(e.status, 'failed', `成员应已失败结清而非执行中: ${e.taskId} = ${e.status}`)
  }
})

test('-p 同步分支:单个 task 也入队(历史缺口——同步分支只跳注册表,花名册必须入队)', async () => {
  const call = {
    id: 'sync-call-1',
    type: 'function',
    function: {
      name: 'task',
      arguments: JSON.stringify({ subagent_type: 'general-purpose', member_name: 'sync-member', task_description: 'x' }),
    },
  } as unknown as ToolCall
  // sync: true 即 chill -p 路径;执行会失败(TaskExecutor 未初始化),但入队必须先发生
  await executeTaskToolCalls([call], undefined, undefined, { sync: true })
  const roster = svc.getActiveTeam()!.roster.map((e) => e.name)
  assert.ok(roster.includes('sync-member'), `-p 同步分支成员应入队,实际花名册: ${roster}`)
})
