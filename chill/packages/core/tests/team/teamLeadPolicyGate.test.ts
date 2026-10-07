import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import {
  TeamRuntimeService,
  setTeamRuntimeService,
  resetTeamRuntimeService,
} from '../../src/services/team/TeamRuntimeService.ts'
import { resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/**
 * 前台授权门(迭代 4 结构层)回归:
 * 实测教训——收权后 Lead 凭历史记忆调用 task 照样派出(LLM 工具调用是自由文本,schema 过滤只是提示层),
 * 结构拦截必须在执行层管线(team-lead-policy link)。
 */

function memFs(): IFileSystemProvider & { written: Map<string, string> } {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const written = new Map<string, string>()
  return {
    written,
    getCurrentDirectory: () => 'C:\\proj',
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

function makeExecutor(): BuiltInToolExecutor {
  return new BuiltInToolExecutor(
    memFs() as any,
    {} as any,
    {} as any,
    { executePowerShell: async () => ({ success: true, output: '' }) } as any,
  )
}

let svc: TeamRuntimeService

beforeEach(async () => {
  resetTeamRuntimeService()
  resetTaskRegistry()
  svc = new TeamRuntimeService(memFs(), '/team-runs')
  setTeamRuntimeService(svc)
  await svc.formFromDefinition({ name: 't-team', version: 1, members: [{ agent: 'researcher' }] })
})

afterEach(() => {
  resetTeamRuntimeService()
  resetTaskRegistry()
})

const TASK_ARGS = JSON.stringify({ task_id: 'probe', subagent_type: 'general-purpose', task_description: '探针' })

test('前台授权门:放权快照收走 task → 执行层 deny(实测回归:schema 过滤挡不住凭记忆的调用)', async () => {
  await svc.updateSnapshot(
    { grants: { lead: ['team_policy', 'team_board', 'team_status', 'send_message', 'query_task_status'] } },
    'lead',
    '放权',
  )
  const executor = makeExecutor()
  const blocked = await executor.executeAsync('task', TASK_ARGS, 'tc-g1')
  assert.equal(blocked.success, false)
  assert.match(blocked.error!, /收走 Lead 的 task 权限/)
  assert.match(blocked.error!, /team_policy/)
})

test('前台授权门:默认快照(零行为变化红线)与豁免工具不拦', async () => {
  const executor = makeExecutor()
  // 默认快照 lead='*' → task 不被本门拦(后续失败是执行层原因,绝非门文案)
  const res = await executor.executeAsync('task', TASK_ARGS, 'tc-g2')
  assert.ok(!res.error?.includes('放权模式'), `默认快照不应被拦: ${res.error}`)
  // steer_task 同理
  const res2 = await executor.executeAsync('steer_task', JSON.stringify({}), 'tc-g3')
  assert.ok(!res2.error?.includes('放权模式'), `默认快照不应被拦: ${res2.error}`)
})

test('前台授权门:Worker 来源(__origin subagent)不拦——成员拉新门在 delegation 层', async () => {
  await svc.updateSnapshot(
    { grants: { lead: ['team_policy'] } },
    'lead',
    '放权',
  )
  const executor = makeExecutor()
  const res = await executor.executeAsync(
    'task',
    JSON.stringify({ task_id: 'm-spawn', subagent_type: 'general-purpose', task_description: 'x', __origin: { source: 'subagent', taskId: 't-member' } }),
    'tc-g4',
  )
  assert.ok(!res.error?.includes('放权模式'), `Worker 来源不应被前台门拦: ${res.error}`)
})

test('前台授权门:解冻态恢复(restoredGrants 叠加)', async () => {
  await svc.updateSnapshot({ grants: { lead: ['team_policy'] } }, 'lead', '放权')
  await svc.setUnfreeze({ by: 'watchdog', at: Date.now(), reason: '停滞', restoredGrants: ['task', 'batch_task', 'resume_task', 'steer_task'] }, '解冻')
  const executor = makeExecutor()
  const res = await executor.executeAsync('task', TASK_ARGS, 'tc-g5')
  assert.ok(!res.error?.includes('放权模式'), `解冻后不应被拦: ${res.error}`)
})

test('合法值集:query_task_status/cancel_task 可被显式保留(实测:收权时被误拒)', async () => {
  const next = await svc.updateSnapshot(
    { grants: { lead: ['team_policy', 'query_task_status', 'cancel_task', 'team_board', 'team_status', 'send_message'] } },
    'lead',
    '收权但保留任务管理',
  )
  assert.deepEqual(next.grants.lead, ['team_policy', 'query_task_status', 'cancel_task', 'team_board', 'team_status', 'send_message'])
})
