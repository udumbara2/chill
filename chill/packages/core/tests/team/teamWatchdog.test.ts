import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamRuntimeService,
  setTeamRuntimeService,
  resetTeamRuntimeService,
} from '../../src/services/team/TeamRuntimeService.ts'
import {
  startTeamWatchdog,
  stopTeamWatchdog,
  resetTeamWatchdogFired,
} from '../../src/services/team/teamWatchdog.ts'
import { computeLeadBlockedTools } from '../../src/services/team/teamPolicy.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let svc: TeamRuntimeService
let alerts: number
const onAlert = () => alerts++

beforeEach(async () => {
  resetTeamRuntimeService()
  resetTaskRegistry()
  stopTeamWatchdog()
  alerts = 0
  eventBus.on(EVENTS.TEAM_WATCHDOG_ALERT, onAlert)
  svc = new TeamRuntimeService(memFs(), '/team-runs')
  setTeamRuntimeService(svc)
  await svc.formFromDefinition({ name: 'news-team', version: 1, members: [{ agent: 'researcher' }] })
})

afterEach(() => {
  eventBus.off(EVENTS.TEAM_WATCHDOG_ALERT, onAlert)
  stopTeamWatchdog()
})

test('停滞:任务级截止到期触发——解冻留痕 + 回流消息 + 警报事件', async () => {
  startTeamWatchdog()
  await svc.boardPost({ title: '卡住的调研', createdBy: 'lead', stagnationAfter: 0.005 }) // 300ms
  await svc.flush()
  await sleep(700)
  await svc.flush()
  const snap = svc.getSnapshot()!
  assert.equal(snap.unfreeze?.by, 'watchdog')
  assert.match(snap.unfreeze!.reason, /卡住的调研/)
  assert.ok(snap.unfreeze!.restoredGrants.includes('task'))
  const msgs = getTaskRegistry().drainTeamMessages()
  assert.ok(msgs.some((m) => m.from.includes('watchdog') && m.content.includes('停滞')))
  assert.ok(alerts >= 1)
})

test('冲突:同一条目 release ≥2 次触发;节流(同一事件不重复报)', async () => {
  startTeamWatchdog()
  const { item } = await svc.boardPost({ title: '踢皮球', createdBy: 'lead' })
  await svc.boardClaim(item.id, 'researcher')
  await svc.registerMember({ agent: 'researcher', taskId: 't1' })
  await svc.boardRelease(item.id, 'researcher', { reason: '做不了' })
  await svc.boardClaim(item.id, 'lead')
  await svc.boardRelease(item.id, 'lead', { reason: '再退回' })
  await svc.flush()
  assert.equal(svc.getSnapshot()!.unfreeze?.by, 'watchdog')
  assert.match(svc.getSnapshot()!.unfreeze!.reason, /退回 2 次/)
  const alertsAfterFirst = alerts
  // 第三次 release:同一事件已报过,节流不重复
  await svc.boardClaim(item.id, 'lead')
  await svc.boardRelease(item.id, 'lead', { reason: '第三次' })
  await svc.flush()
  assert.equal(alerts, alertsAfterFirst)
})

test('冲突:系统死亡回流不计入(by=system 的回收不是认领困难——实测误报回归)', async () => {
  startTeamWatchdog()
  const { item } = await svc.boardPost({ title: '被踢皮球的守候', createdBy: 'lead' })
  await svc.registerMember({ agent: 'researcher', taskId: 't1' })
  await svc.boardClaim(item.id, 'researcher')
  // 系统死亡回流(by:system)+ 1 次成员退回 = 不足 2 次人为退回,不应触发
  svc.syncOnTaskSettle('t1', 'failed')
  await svc.boardClaim(item.id, 'lead')
  await svc.boardRelease(item.id, 'lead', { reason: '纪律退回' })
  await svc.flush()
  assert.equal(svc.getSnapshot()!.unfreeze, undefined, '系统回流不计入,1 次人为退回不触发')
  // 再补 1 次人为退回 → 2 次人为退回,触发
  await svc.boardClaim(item.id, 'lead')
  await svc.boardRelease(item.id, 'lead', { reason: '再次纪律退回' })
  await svc.flush()
  assert.equal(svc.getSnapshot()!.unfreeze?.by, 'watchdog')
})

test('预算异常:token 消耗超上限触发', async () => {
  await svc.updateSnapshot({ budget: { maxTokens: 100 } }, 'lead', 'x')
  startTeamWatchdog()
  svc.addTokenSpend(150)
  await svc.flush()
  assert.match(svc.getSnapshot()!.unfreeze!.reason, /预算上限/)
})

test('预算异常:估值入账同样触发(服务商不回 usage 时告警不设摆)', async () => {
  await svc.updateSnapshot({ budget: { maxTokens: 100 } }, 'lead', 'x')
  startTeamWatchdog()
  svc.addTokenSpend(150, true) // 估值入账(estimated 单向置位)
  await svc.flush()
  assert.match(svc.getSnapshot()!.unfreeze!.reason, /预算上限/)
  assert.equal(svc.getActiveTeam()!.ledger!.estimated, true)
  const msgs = getTaskRegistry().drainTeamMessages()
  assert.ok(msgs.some((m) => m.from.includes('watchdog') && m.content.includes('预算')))
  assert.ok(alerts >= 1)
})

test('平息收回:解冻后看板恢复活动 → unfreeze 自动收回并留痕', async () => {
  startTeamWatchdog()
  await svc.boardPost({ title: '停滞项', createdBy: 'lead', stagnationAfter: 0.005 })
  await svc.flush()
  await sleep(700)
  await svc.flush()
  assert.equal(svc.getSnapshot()!.unfreeze?.by, 'watchdog')
  // lead 被唤醒后处置:看板有新活动(updatedAt > unfreeze.at)→ 自动收回
  await svc.boardPost({ title: '新任务', createdBy: 'lead' })
  await svc.flush()
  const snap = svc.getSnapshot()!
  assert.equal(snap.unfreeze, undefined)
  assert.ok(snap.history.some((h) => h.note.includes('平息收回')))
})

test('升级:解冻后 M 分钟未平息 → 升级提醒(每事件一次)', async () => {
  startTeamWatchdog({ stagnationMin: 0.005, escalateAfterMin: 0.01 })
  await svc.boardPost({ title: '长期卡死', createdBy: 'lead', stagnationAfter: 0.005 })
  await svc.flush()
  await sleep(700) // 触发解冻
  await svc.flush()
  assert.equal(svc.getSnapshot()!.unfreeze?.by, 'watchdog')
  getTaskRegistry().drainTeamMessages() // 清掉第一条
  await sleep(800) // 超过升级时限且无新活动
  await svc.flush()
  const msgs = getTaskRegistry().drainTeamMessages()
  assert.ok(msgs.some((m) => m.content.includes('升级提醒')))
})

test('computeLeadBlockedTools:默认快照零收走;放权收走;解冻恢复(SSOT)', async () => {
  assert.deepEqual(computeLeadBlockedTools(undefined), [])
  assert.deepEqual(computeLeadBlockedTools(svc.getSnapshot()), [])
  await svc.updateSnapshot(
    { grants: { lead: ['team_policy', 'team_board', 'team_status', 'send_message'] } },
    'lead',
    '放权',
  )
  const blocked = computeLeadBlockedTools(svc.getSnapshot())
  assert.ok(blocked.includes('task') && blocked.includes('batch_task') && blocked.includes('resume_task') && blocked.includes('steer_task'))
  await svc.setUnfreeze({ by: 'watchdog', at: Date.now(), reason: 'x', restoredGrants: ['task', 'batch_task', 'resume_task', 'steer_task'] }, 'y')
  assert.deepEqual(computeLeadBlockedTools(svc.getSnapshot()), [])
})

// ---------- 停滞判定归位:running 认领人豁免(归任务 timeout) ----------

test('running 豁免:认领人 running 的条目不触发(合法守候不误报)', async () => {
  await svc.registerMember({ agent: 'researcher', taskId: 't1' }) // running
  const { item } = await svc.boardPost({ title: '合法守候', createdBy: 'lead', stagnationAfter: 0.005 })
  await svc.boardClaim(item.id, 'researcher')
  startTeamWatchdog()
  await sleep(800)
  await svc.flush()
  assert.equal(svc.getSnapshot()!.unfreeze, undefined, 'running 认领人豁免,不应解冻')
})

test('running 豁免:认领人 settle 转 idle 后恢复检测(无人推进真停滞照抓)', async () => {
  await svc.registerMember({ agent: 'researcher', taskId: 't1' })
  const { item } = await svc.boardPost({ title: '卡死项', createdBy: 'lead', stagnationAfter: 0.005 })
  await svc.boardClaim(item.id, 'researcher')
  svc.syncOnTaskSettle('t1', 'completed', undefined, true) // 转 idle(plan 任务不自动结项,条目仍在)
  assert.equal(svc.getActiveTeam()!.roster.find((e) => e.name === 'researcher')!.status, 'idle')
  startTeamWatchdog()
  await sleep(800)
  await svc.flush()
  assert.equal(svc.getSnapshot()!.unfreeze?.by, 'watchdog', 'idle 后应按声明触发')
})

test('running 豁免:无认领(pending)条目仍按声明触发', async () => {
  startTeamWatchdog()
  await svc.boardPost({ title: '无人认领', createdBy: 'lead', stagnationAfter: 0.005 })
  await svc.flush()
  await sleep(800)
  await svc.flush()
  assert.equal(svc.getSnapshot()!.unfreeze?.by, 'watchdog')
})
