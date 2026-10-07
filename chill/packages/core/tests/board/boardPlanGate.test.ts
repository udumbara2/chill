import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { resetApprovalChannel } from '../../src/services/approvals.ts'
import { resetWriteBoundary } from '../../src/services/writeBoundary.ts'
import { PLAN_MODE_BLOCKED_TOOLS } from '../../src/orchestrator/toolPolicy.ts'
import {
  SessionBoardService,
  resetSessionBoardService,
  setSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'
import { BoardStore } from '../../src/services/board/boardStore.ts'

/**
 * plan=只读语义拍板落实：board 整工具入 PLAN_MODE_BLOCKED_TOOLS（名单是工具级），
 * 写类 action 拦截、read 经 action 级豁免放行（isBoardReadOnlyAction——无独立 board_status 工具，
 * 看板 read 是唯一的板面只读探查）。
 */

function makeFsProvider(workDir = 'C:\\proj') {
  return {
    getCurrentDirectory: () => workDir,
    fileExists: async () => ({ success: true, data: false }),
    readFile: async () => ({ success: false, error: 'not found' }),
    writeFile: async () => ({ success: true }),
    deleteFile: async () => ({ success: true }),
    getPathType: async () => ({ success: true, data: { type: 'not_found' } }),
    listDirectory: async () => ({ success: true, data: [] }),
  }
}

async function setup(t: TestContext): Promise<{ executor: BuiltInToolExecutor; svc: SessionBoardService }> {
  const dir = await mkdtemp(join(tmpdir(), 'board-plan-'))
  const svc = new SessionBoardService(new BoardStore(dir))
  setSessionBoardService(svc)
  const executor = new BuiltInToolExecutor(makeFsProvider() as any, {} as any, {} as any, {} as any)
  executor.setPlanMode(true)
  t.after(async () => {
    executor.setPlanMode(false)
    resetSessionBoardService()
    resetApprovalChannel()
    resetWriteBoundary()
    await rm(dir, { recursive: true, force: true })
  })
  return { executor, svc }
}

test('拍板1:board 已入 PLAN_MODE_BLOCKED_TOOLS（工具级名单）', () => {
  assert.ok(PLAN_MODE_BLOCKED_TOOLS.includes('board'))
})

const WRITE_ACTIONS: Array<{ action: string; args: Record<string, unknown> }> = [
  { action: 'post', args: { action: 'post', title: 'x' } },
  { action: 'claim', args: { action: 'claim', id: 'b1' } },
  { action: 'update', args: { action: 'update', id: 'b1', note: 'n' } },
  { action: 'release', args: { action: 'release', id: 'b1', reason: 'r' } },
  { action: 'remove', args: { action: 'remove', id: 'b1' } },
  { action: 'adjudicate', args: { action: 'adjudicate', id: 'b1', decision: 'retry' } },
  { action: 'unblock', args: { action: 'unblock', id: 'b1' } },
  { action: 'cancel_item', args: { action: 'cancel_item', id: 'b1' } },
]

test('plan 模式:board 全部写类 action 被拒（8 动作逐个过闸）', async (t) => {
  const { executor } = await setup(t)
  for (const { action, args } of WRITE_ACTIONS) {
    const res = await executor.executeAsync('board', JSON.stringify(args), `tc-${action}`)
    assert.equal(res.success, false, `board ${action} 应被 plan 门拦截`)
    assert.ok(res.error!.includes('当前处于规划模式，禁止执行修改性操作'), `board ${action}: ${res.error}`)
  }
})

test('plan 模式:board read 放行（action 级豁免）', async (t) => {
  const { executor, svc } = await setup(t)
  await svc.post('sess-1', { title: '计划期可见', createdBy: 'lead' })
  const res = await executor.executeAsync(
    'board',
    JSON.stringify({ action: 'read', __origin: { source: 'main', sessionId: 'sess-1' } }),
    'tc-read',
  )
  assert.equal(res.success, true, `board read 不应被 plan 门拦截: ${res.error}`)
  assert.match((res.data as { content: string }).content, /计划期可见/)
})

test('readonly 模式同口径:写类拦截、read 放行', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'board-ro-'))
  const svc = new SessionBoardService(new BoardStore(dir))
  setSessionBoardService(svc)
  const executor = new BuiltInToolExecutor(makeFsProvider() as any, {} as any, {} as any, {} as any)
  executor.setPermissionMode('readonly')
  t.after(async () => {
    executor.setPermissionMode('boundary')
    resetSessionBoardService()
    resetApprovalChannel()
    resetWriteBoundary()
    await rm(dir, { recursive: true, force: true })
  })
  await svc.post('sess-1', { title: '只读可见', createdBy: 'lead' })
  const blocked = await executor.executeAsync('board', JSON.stringify({ action: 'post', title: 'x' }), 'tc-ro-w')
  assert.equal(blocked.success, false)
  assert.ok(blocked.error!.includes('只读模式'))
  const read = await executor.executeAsync(
    'board',
    JSON.stringify({ action: 'read', __origin: { source: 'main', sessionId: 'sess-1' } }),
    'tc-ro-r',
  )
  assert.equal(read.success, true, `readonly 下 read 应放行: ${read.error}`)
})
