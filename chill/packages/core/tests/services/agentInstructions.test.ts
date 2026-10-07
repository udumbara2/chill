import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentInstructions } from '../../src/services/agentInstructions.ts'

/** AGENTS.md 子任务注入：只注入真实约束，无文件时返回空串（不带机制介绍/维护引导噪声） */

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-'))
  const fsProvider = {
    readFile: async (p: string) => {
      try { return { success: true, data: { content: fs.readFileSync(p, 'utf-8') } } } catch { return { success: false } }
    },
  }
  const svc = AgentInstructions.getInstance()
  svc.init(fsProvider as any, { getUserDataPath: () => path.join(home, '.chill'), getUserHomePath: () => home } as any)
  const workDir = path.join(home, 'proj')
  fs.mkdirSync(workDir, { recursive: true })
  return { home, svc, workDir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('buildSubagentInjection: 两级文件均不存在 → 空串（不注噪声）', async () => {
  const { svc, workDir, cleanup } = makeEnv()
  assert.equal(await svc.buildSubagentInjection(workDir), '')
  cleanup()
})

test('buildSubagentInjection: 项目级存在 → 注入内容、带来源标注、无维护引导', async () => {
  const { svc, workDir, cleanup } = makeEnv()
  fs.writeFileSync(path.join(workDir, 'AGENTS.md'), '测试命令是 pnpm test；提交信息用中文。')
  const out = await svc.buildSubagentInjection(workDir)
  assert.ok(out.includes('测试命令是 pnpm test'))
  assert.ok(out.includes('[当前工作目录'))
  assert.ok(!out.includes('create_file'), '子任务注入不应附带维护文件引导')
  cleanup()
})

test('buildSubagentInjection: 全局+项目两级并存 → 全局在前、项目在后', async () => {
  const { home, svc, workDir, cleanup } = makeEnv()
  fs.mkdirSync(path.join(home, '.chill'), { recursive: true })
  fs.writeFileSync(path.join(home, '.chill', 'AGENTS.md'), '全局规则')
  fs.writeFileSync(path.join(workDir, 'AGENTS.md'), '项目规则')
  const out = await svc.buildSubagentInjection(workDir)
  assert.ok(out.indexOf('全局规则') < out.indexOf('项目规则'))
  cleanup()
})
