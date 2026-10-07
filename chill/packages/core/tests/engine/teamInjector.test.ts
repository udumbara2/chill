import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createCommonInjectors, ContextAssembler } from '../../src/engine/ContextAssembler.ts'
import { TeamRuntimeService, setTeamRuntimeService, resetTeamRuntimeService } from '../../src/services/team/TeamRuntimeService.ts'
import type { AssembleContext } from '../../src/engine/types.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/** 最小内存 fs(注入器测试不写盘) */
const noopFs = {
  writeFile: async () => ({ success: true }),
  renameFile: async () => ({ success: true }),
} as unknown as IFileSystemProvider

function assemble() {
  const assembler = new ContextAssembler({ injectors: createCommonInjectors({} as never) })
  const ctx: AssembleContext = { planMode: false, taskToolAvailable: false }
  return assembler.assemblePrefix(ctx)
}

beforeEach(() => {
  resetTeamRuntimeService()
})

test('活动团队注入行: 无团队零注入;有团队出现花名册/看板计数', async () => {
  // 无团队 → 零注入
  const before = await assemble()
  assert.ok(!before.some((m) => typeof m.content === 'string' && m.content.includes('活动团队')))

  // 成队 + 挂一项 → 注入行出现且计数正确
  const svc = new TeamRuntimeService(noopFs, '/team-runs')
  setTeamRuntimeService(svc)
  await svc.formFromDefinition({
    name: 'news-team',
    version: 1,
    members: [
      { agent: 'researcher', role: '调研员' },
      { agent: 'writer' },
    ],
  })
  await svc.boardPost({ title: '搜集资料', createdBy: 'lead' })

  const after = await assemble()
  const line = after.find((m) => typeof m.content === 'string' && m.content.includes('活动团队'))
  assert.ok(line, '有活动团队时应注入状态行')
  const content = line!.content as string
  assert.ok(content.includes('「news-team」'))
  assert.ok(content.includes('花名册 2 人'))
  assert.ok(content.includes('待认领 1'))
})
