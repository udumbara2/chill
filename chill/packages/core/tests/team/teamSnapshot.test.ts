import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamRuntimeService,
  setTeamRuntimeService,
  resetTeamRuntimeService,
} from '../../src/services/team/TeamRuntimeService.ts'
import { executeTeamPolicy } from '../../src/services/team/teamPolicyTool.ts'
import { resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/** 内存 fs 桩(与 teamRuntime.test.ts 同款;记录全部写入验证落盘) */
function memFs(): IFileSystemProvider & { written: Map<string, string> } {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const written = new Map<string, string>()
  return {
    written,
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
  } as unknown as IFileSystemProvider & { written: Map<string, string> }
}

let fs: ReturnType<typeof memFs>
let svc: TeamRuntimeService

beforeEach(() => {
  resetTeamRuntimeService()
  resetTaskRegistry()
  fs = memFs()
  svc = new TeamRuntimeService(fs, '/team-runs')
  setTeamRuntimeService(svc)
})

test('use_team 显式成队路径:快照生成(默认语义)并落盘 snapshot.json', async () => {
  await svc.formFromDefinition({ name: 'news-team', version: 1, members: [{ agent: 'researcher' }] })
  const snap = svc.getSnapshot()
  assert.ok(snap)
  assert.equal(snap.source, 'default')
  assert.deepEqual(snap.grants.lead, ['*'])
  await svc.flush()
  const written = [...fs.written.keys()].find((k) => k.endsWith('snapshot.json'))
  assert.ok(written, 'snapshot.json 应落盘')
  const persisted = JSON.parse(fs.written.get(written!)!)
  assert.equal(persisted.snapshot.source, 'default')
  assert.ok(persisted.ledger)
})

test('惰性成队路径(task 委派 ensureAdHocTeam):快照同样生成', async () => {
  svc.ensureAdHocTeam()
  assert.ok(svc.getSnapshot())
  assert.equal(svc.getSnapshot()!.source, 'default')
  await svc.flush()
  assert.ok([...fs.written.keys()].some((k) => k.endsWith('snapshot.json')))
})

test('团队 YAML policy 段:成队快照按模板生成(source=template)', async () => {
  await svc.formFromDefinition({
    name: 'news-team',
    version: 1,
    members: [{ agent: 'researcher' }],
    policy: { budget: { max_members: 4 }, default_member_grants: ['send_message', 'team_policy:read', 'team_board'] },
  })
  const snap = svc.getSnapshot()!
  assert.equal(snap.source, 'template')
  assert.equal(snap.budget.maxMembers, 4)
})

test('updateSnapshot: 热更新留痕并落盘;非法授权与收走豁免响亮拒绝', async () => {
  await svc.formFromDefinition({ name: 'news-team', version: 1, members: [{ agent: 'researcher' }] })
  const next = await svc.updateSnapshot({ budget: { maxMembers: 3 } }, 'lead', '用户说:最多 3 人')
  assert.equal(next.budget.maxMembers, 3)
  assert.equal(next.history.at(-1)!.note, '用户说:最多 3 人')
  await svc.flush()
  const written = [...fs.written.keys()].find((k) => k.endsWith('snapshot.json'))!
  assert.equal(JSON.parse(fs.written.get(written)!).snapshot.budget.maxMembers, 3)
  await assert.rejects(() => svc.updateSnapshot({ defaultMemberGrants: ['task'] }, 'lead', 'x'), /send_message/)
})

test('team_policy read:无活动团队应答空态(非报错);成队后全员可读', async () => {
  const noTeam = await executeTeamPolicy('{"action":"read"}')
  assert.equal(noTeam.success, true)
  assert.match(noTeam.data!, /没有活动团队/)
  assert.match(noTeam.data!, /无授权快照/)
  await svc.formFromDefinition({ name: 'news-team', version: 1, members: [{ agent: 'researcher' }] })
  const read = await executeTeamPolicy('{}')
  assert.equal(read.success, true)
  assert.match(read.data!, /授权快照/)
})

test('team_policy update:成员调用被拒(提权后门);Lead 调用成功', async () => {
  await svc.formFromDefinition({ name: 'news-team', version: 1, members: [{ agent: 'researcher' }] })
  const { entry } = await svc.registerMember({ agent: 'researcher', taskId: 't-member-1' })
  // 成员身份(origin.source='subagent' + taskId 在册)→ update 拒绝
  const asMember = await executeTeamPolicy(
    JSON.stringify({ action: 'update', budget: { max_members: 99 }, note: '我自己扩权' }),
    { source: 'subagent', taskId: 't-member-1' },
  )
  assert.equal(asMember.success, false)
  assert.match(asMember.error!, /只有 Lead/)
  // Lead(无 origin)→ 成功
  const asLead = await executeTeamPolicy(JSON.stringify({ action: 'update', budget: { max_members: 99 }, note: '用户批准扩容' }))
  assert.equal(asLead.success, true)
  assert.equal(svc.getSnapshot()!.budget.maxMembers, 99)
  assert.ok(entry.name)
})

test('team_policy update:缺 note 拒绝;无变更字段拒绝', async () => {
  await svc.formFromDefinition({ name: 'news-team', version: 1, members: [{ agent: 'researcher' }] })
  const noNote = await executeTeamPolicy(JSON.stringify({ action: 'update', budget: { max_members: 2 } }))
  assert.equal(noNote.success, false)
  assert.match(noNote.error!, /note/)
  const empty = await executeTeamPolicy(JSON.stringify({ action: 'update', note: 'x' }))
  assert.equal(empty.success, false)
})
