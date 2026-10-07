import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommonInjectors, ContextAssembler } from '../../src/engine/ContextAssembler.ts'
import { getWriteBoundary, resetWriteBoundary } from '../../src/services/writeBoundary.ts'
import { wrapSubtaskPrompt } from '../../src/orchestrator/rolePrompt.ts'
import type { AssembleContext } from '../../src/engine/types.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'
import type { Message } from '../../src/types/models.ts'

function makeAssembler(): ContextAssembler {
  return new ContextAssembler({ injectors: createCommonInjectors({}) })
}

function ctx(planMode: boolean): AssembleContext {
  return { planMode, taskToolAvailable: false }
}

function findWriteBoundary(messages: Message[]): Message | undefined {
  return messages.find(
    (m) => typeof m.content === 'string' && m.content.includes('## 写边界'),
  )
}

function setup(t: import('node:test').TestContext, workDir: string) {
  resetWriteBoundary()
  getWriteBoundary().configure({
    fsProvider: { getCurrentDirectory: () => workDir } as unknown as IFileSystemProvider,
    sourceRoot: null,
  })
  t.after(() => resetWriteBoundary())
}

test('write-boundary 注入器: 注入当前边界目录集合', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chill-wbi-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  setup(t, dir)

  const messages = await makeAssembler().assemblePrefix(ctx(false))
  const injected = findWriteBoundary(messages)
  assert.ok(injected, '应注入写边界消息')
  assert.ok(typeof injected.content === 'string' && injected.content.includes(dir))
  assert.ok(typeof injected.content === 'string' && injected.content.includes('圈内可直接写'))
})

test('write-boundary 注入器: add-dir 后下一轮注入即更新', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chill-wbi-'))
  const added = fs.mkdtempSync(join(tmpdir(), 'chill-wbi-added-'))
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(added, { recursive: true, force: true })
  })
  setup(t, dir)

  const assembler = makeAssembler()
  const before = findWriteBoundary(await assembler.assemblePrefix(ctx(false)))
  assert.ok(before && typeof before.content === 'string' && !before.content.includes(added))

  getWriteBoundary().addWritableRoot(added)
  const after = findWriteBoundary(await assembler.assemblePrefix(ctx(false)))
  assert.ok(after && typeof after.content === 'string' && after.content.includes(added))
})

test('write-boundary 注入器: plan 模式与 -p readonly 不注入', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chill-wbi-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  setup(t, dir)

  const assembler = makeAssembler()
  // plan 模式
  assert.equal(findWriteBoundary(await assembler.assemblePrefix(ctx(true))), undefined)

  // -p readonly（写入模式状态经 builtInToolExecutor setters 同步进单例）
  getWriteBoundary().setModeState({ readonly: true })
  assert.equal(findWriteBoundary(await assembler.assemblePrefix(ctx(false))), undefined)
})

test('write-boundary 注入器: autoApply on（含 -p --auto）注明全量直接写、无审批', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chill-wbi-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  setup(t, dir)
  getWriteBoundary().setModeState({ fullAccess: true })

  const injected = findWriteBoundary(await makeAssembler().assemblePrefix(ctx(false)))
  assert.ok(injected && typeof injected.content === 'string')
  assert.ok(injected.content.includes('全量直接写'))
  assert.ok(!injected.content.includes('圈内可直接写'))
})

test('wrapSubtaskPrompt: 携带边界集合与状态分支；不传时无边界段（回归）', () => {
  const template = { name: '测试', subagent_type: 'test-agent' } as any

  const withBoundary = wrapSubtaskPrompt(template, { roots: ['C:\\proj'] })
  assert.ok(withBoundary.includes('## 写边界'))
  assert.ok(withBoundary.includes('C:\\proj'))
  assert.ok(withBoundary.includes('圈内可直接写'))

  const fullAccess = wrapSubtaskPrompt(template, { roots: [], fullAccess: true })
  assert.ok(fullAccess.includes('全量直接写'))

  const readonly = wrapSubtaskPrompt(template, { roots: [], readonly: true })
  assert.ok(readonly.includes('只读模式'))

  // 不传 boundary：行为与之前一致（无写边界段）
  const legacy = wrapSubtaskPrompt(template)
  assert.ok(!legacy.includes('## 写边界'))
  assert.ok(legacy.includes('执行子任务的 Subagent'))
})

test('rolePrompt 只读披露: 模板 readonly → 两个包装函数均含只读权限段；未声明 → 无（回归）', async () => {
  const { wrapFrontAgentPrompt } = await import('../../src/orchestrator/rolePrompt.ts')
  const ro = { name: '评审', subagent_type: 'ro', readonly: true } as any
  const plain = { name: '普通', subagent_type: 'plain' } as any

  assert.ok(wrapSubtaskPrompt(ro).includes('你是只读 Agent'))
  assert.ok(wrapFrontAgentPrompt(ro).includes('你是只读 Agent'))
  assert.ok(!wrapSubtaskPrompt(plain).includes('## 权限'))
  assert.ok(!wrapFrontAgentPrompt(plain).includes('## 权限'))
})
