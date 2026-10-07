import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTeamDefinition, serializeTeam } from '../../src/team/teamSerializer.ts'
import { TeamTemplateService, setTeamServiceForIndex, getTeamServiceForIndex } from '../../src/services/team/TeamTemplateService.ts'
import { executeUseTeam } from '../../src/services/team/useTeamTool.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

const VALID = `
name: news-team
version: 1
title: 热点团队
description: 调研+撰稿的热点生产班底
when_to_use: 需要团队分工完成热点内容时
members:
  - agent: researcher
    role: 调研员
    note: 多轮检索
  - agent: writer
orchestration: |
  先调研后撰稿,素材不足时调研员补一轮。
`

test('parse: 合法团队定义全字段解析', () => {
  const r = parseTeamDefinition(VALID)
  assert.equal(r.success, true, r.error)
  const d = r.definition!
  assert.equal(d.name, 'news-team')
  assert.equal(d.members.length, 2)
  assert.equal(d.members[0].role, '调研员')
  assert.equal(d.members[1].role, undefined)
  assert.ok(d.orchestration?.includes('先调研后撰稿'))
})

test('parse: 必填与规范校验(name/version/members)', () => {
  assert.match(parseTeamDefinition('version: 1\nmembers: [{agent: a}]').error!, /缺少必填字段 "name"/)
  assert.match(parseTeamDefinition('name: Bad_Name\nversion: 1\nmembers: [{agent: a}]').error!, /不符合命名规范/)
  assert.match(parseTeamDefinition('name: a\nmembers: [{agent: a}]').error!, /缺少必填字段 "version"/)
  assert.match(parseTeamDefinition('name: a\nversion: 99\nmembers: [{agent: a}]').error!, /不支持的 DSL 版本/)
  assert.match(parseTeamDefinition('name: a\nversion: 1\nmembers: []').error!, /至少包含 1 个成员/)
  assert.match(parseTeamDefinition('name: a\nversion: 1\nmembers: [{role: x}]').error!, /agent 字段必填/)
})

test('serialize⇄parse 往返无损(可选字段省略)', () => {
  const d1 = parseTeamDefinition(VALID).definition!
  const text = serializeTeam(d1)
  assert.ok(!text.includes('sourcePath') && !text.includes('scope'))
  const d2 = parseTeamDefinition(text).definition!
  assert.deepEqual(
    { name: d2.name, version: d2.version, title: d2.title, description: d2.description, when_to_use: d2.when_to_use, members: d2.members, orchestration: d2.orchestration },
    { name: d1.name, version: d1.version, title: d1.title, description: d1.description, when_to_use: d1.when_to_use, members: d1.members, orchestration: d1.orchestration },
  )
  // 可选字段全缺的极简定义
  const minimal = parseTeamDefinition('name: a\nversion: 1\nmembers: [{agent: x}]').definition!
  const text2 = serializeTeam(minimal)
  assert.ok(!text2.includes('title:') && !text2.includes('orchestration:'))
  assert.equal(parseTeamDefinition(text2).definition!.members[0].agent, 'x')
})

/** 内存 fs 桩(目录 → 文件内容表;Windows join 反斜杠键名归一化为正斜杠) */
function memFs(files: Record<string, string>): IFileSystemProvider {
  const norm = (p: string) => p.replace(/\\/g, '/')
  return {
    getCurrentDirectory: () => null,
    readFile: async (p: string) => (files[norm(p)] !== undefined ? { success: true, data: { content: files[norm(p)] } } : { success: false, error: 'nf' }),
    writeFile: async () => ({ success: true }),
    deleteFile: async () => ({ success: true }),
    listDirectory: async (dir: string) => ({
      success: true,
      data: { files: Object.keys(files).filter((f) => f.startsWith(norm(dir) + '/')).map((f) => ({ name: f.slice(norm(dir).length + 1), type: 'file' })) },
    }),
    fileExists: async (p: string) => ({ success: true, data: norm(p) in files || Object.keys(files).some((f) => f.startsWith(norm(p) + '/')) }),
  } as unknown as IFileSystemProvider
}

test('service: 用户级+项目级合并,项目覆盖用户,错误可见', async () => {
  const fs = memFs({
    '/user/teams/a.yaml': VALID,
    '/user/teams/b.yaml': 'name: b\nversion: 1\nmembers: [{agent: x}]',
    '/user/teams/bad.yaml': 'name: Bad!\nversion: 1\nmembers: []',
    'C:/proj/.agents/teams/b.yaml': 'name: b\nversion: 1\ntitle: 项目级B\nmembers: [{agent: y}]',
  })
  const svc = new TeamTemplateService(fs, '/user/teams')
  await svc.initialize('C:/proj')
  const names = svc.getAllTeams().map((t) => t.name).sort()
  assert.deepEqual(names, ['b', 'news-team'])
  assert.equal(svc.getTeamByName('b')?.title, '项目级B', '项目级应覆盖用户级同名团队')
  assert.equal(svc.getErrors().length, 1)
  assert.match(svc.getErrors()[0], /bad\.yaml/)
})

test('use_team: 返回声明全文与成员校验;不存在时列出可用团队', async () => {
  const fs = memFs({ '/user/teams/news.yaml': VALID })
  const svc = new TeamTemplateService(fs, '/user/teams')
  await svc.initialize()
  setTeamServiceForIndex(svc)

  const ok = await executeUseTeam(JSON.stringify({ name: 'news-team' }))
  // 模板管理器未装配内置模板时,researcher/writer 都会列入缺失——校验信息必须列明
  assert.equal(ok.success, true)
  assert.ok(ok.data!.includes('news-team'))
  assert.ok(ok.data!.includes('先调研后撰稿'))
  assert.ok(ok.data!.includes('成员模板缺失') || ok.data!.includes('@researcher'))

  const nf = await executeUseTeam(JSON.stringify({ name: 'ghost' }))
  assert.equal(nf.success, false)
  assert.match(nf.error!, /不存在/)
  assert.match(nf.error!, /news/)

  setTeamServiceForIndex(undefined as any)
  assert.equal(getTeamServiceForIndex(), undefined)
})
