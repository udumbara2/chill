import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type {
  SubagentTemplate,
  TemplatePriority,
  PriorityScope,
  TemplateType,
} from '../../src/orchestrator/types.ts'

// src 内部相对导入是无扩展名的 bundler 风格，node 原生跑 .ts 时不做补全；
// 注册同步解析钩子，为被测模块图补全 .ts / /index.ts
// （node --test 每个测试文件独立子进程，钩子不影响其他测试文件）
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.')) {
        for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
          try {
            return nextResolve(candidate, context)
          } catch {
            // 继续尝试下一个候选
          }
        }
      }
      throw err
    }
  },
})

// 静态导入在注册钩子前就已完成链接，被测模块必须动态导入
const { SubagentTemplateManager } = await import(
  '../../src/orchestrator/managers/SubagentTemplateManager.ts'
)

// TemplatePriority/PriorityScope/TemplateType 是 enum（不可经 node 类型擦除运行时导入），测试里用字面量替代
const PROJECT_PRIORITY = 1 as TemplatePriority
const USER_PRIORITY = 2 as TemplatePriority
const REMOTE_PRIORITY = 4 as TemplatePriority
const BUILTIN_SCOPE = 'builtin' as PriorityScope
const CUSTOM_TYPE = 'custom' as TemplateType
const BUILTIN_TYPE = 'builtin' as TemplateType
const REMOTE_API_TYPE = 'remote-api' as TemplateType

function tpl(subagentType: string, name: string, extra?: Partial<SubagentTemplate>): SubagentTemplate {
  return {
    name,
    subagent_type: subagentType,
    priority: USER_PRIORITY,
    ...extra,
  }
}

test('initialize: 无 loader 时加载内置四模板', async () => {
  const m = new SubagentTemplateManager()
  await m.initialize()

  const builtins = m.getBuiltinTemplates()
  assert.deepEqual(
    builtins.map((t) => t.subagent_type).sort(),
    ['code-reviewer', 'document-writer', 'general-purpose', 'reviewer'],
  )
  assert.equal(m.getAllTemplates().length, 4)
})

test('分层合并: 同名冲突 项目 > 用户 > 内置 > 远程', async () => {
  const m = new SubagentTemplateManager()
  await m.initialize()

  // remote 与内置同名：内置胜
  m.registerRemoteTemplate(
    tpl('code-reviewer', '远程版', { priority: REMOTE_PRIORITY, type: REMOTE_API_TYPE }),
  )
  assert.equal(m.getTemplateByType('code-reviewer')!.name, '代码审查专家')

  // user 覆盖内置与远程
  m.setCustomTemplates([tpl('code-reviewer', '用户版')], [])
  assert.equal(m.getTemplateByType('code-reviewer')!.name, '用户版')

  // project 覆盖用户
  m.setCustomTemplates([tpl('code-reviewer', '用户版')], [tpl('code-reviewer', '项目版')])
  assert.equal(m.getTemplateByType('code-reviewer')!.name, '项目版')

  // 仅存于 remote 的类型仍可见
  m.registerRemoteTemplate(tpl('remote-only', '仅远程', { priority: REMOTE_PRIORITY }))
  assert.equal(m.getTemplateByType('remote-only')!.name, '仅远程')

  // 仅存于 user 的类型覆盖 remote 同名
  m.registerRemoteTemplate(tpl('shared-type', '远程版', { priority: REMOTE_PRIORITY }))
  m.setCustomTemplates([tpl('shared-type', '用户版')], [])
  assert.equal(m.getTemplateByType('shared-type')!.name, '用户版')
})

test('同层数组内同名: 按数组顺序后者覆盖', async () => {
  const m = new SubagentTemplateManager()
  await m.initialize()

  m.setCustomTemplates(
    [tpl('user-dup', '用户前者'), tpl('user-dup', '用户后者')],
    [tpl('proj-dup', '项目前者'), tpl('proj-dup', '项目后者')],
  )

  assert.equal(m.getTemplateByType('user-dup')!.name, '用户后者')
  assert.equal(m.getTemplateByType('proj-dup')!.name, '项目后者')
})

test('setCustomTemplates: 规范化 type/priority/priority_scope 且不修改入参', async () => {
  const m = new SubagentTemplateManager()
  await m.initialize()

  const userInput = tpl('my-agent', '用户模板', { priority: 99 as TemplatePriority })
  const projectInput = tpl('proj-agent', '项目模板', {
    type: BUILTIN_TYPE,
    priority_scope: BUILTIN_SCOPE,
  })

  m.setCustomTemplates([userInput], [projectInput])

  const userT = m.getTemplateByType('my-agent')!
  assert.equal(userT.type, CUSTOM_TYPE)
  assert.equal(userT.priority, USER_PRIORITY)
  assert.equal(userT.priority_scope, 'user')

  const projT = m.getTemplateByType('proj-agent')!
  assert.equal(projT.type, CUSTOM_TYPE)
  assert.equal(projT.priority, PROJECT_PRIORITY)
  assert.equal(projT.priority_scope, 'project')

  // 入参对象不被改写
  assert.equal(userInput.priority, 99)
  assert.equal(projectInput.type, BUILTIN_TYPE)
})

test('setCustomTemplates: 替换式语义，空数组清空自定义层且不影响内置/远程', async () => {
  const m = new SubagentTemplateManager()
  await m.initialize()
  m.registerRemoteTemplate(tpl('remote-x', '远程X', { priority: REMOTE_PRIORITY }))

  m.setCustomTemplates([tpl('u1', 'U1')], [tpl('p1', 'P1')])
  assert.ok(m.getTemplateByType('u1'))
  assert.ok(m.getTemplateByType('p1'))

  m.setCustomTemplates([], [])
  assert.equal(m.getTemplateByType('u1'), undefined)
  assert.equal(m.getTemplateByType('p1'), undefined)
  // 内置四模板 + remote-x 仍在
  assert.equal(m.getAllTemplates().length, 5)
  assert.equal(m.getTemplateByType('code-reviewer')!.name, '代码审查专家')
  assert.equal(m.getTemplateByType('remote-x')!.name, '远程X')
})

test('remote 层行为不变: register/unregister/reset 兼容且优先级最低', async () => {
  const m = new SubagentTemplateManager()
  await m.initialize()

  m.registerRemoteTemplate(tpl('r1', 'R1', { priority: REMOTE_PRIORITY }))
  m.registerRemoteTemplate(tpl('r2', 'R2', { priority: REMOTE_PRIORITY }))
  assert.deepEqual(
    m.getRemoteTemplates().map((t) => t.subagent_type),
    ['r1', 'r2'],
  )

  m.unregisterRemoteTemplate('r1')
  assert.deepEqual(
    m.getRemoteTemplates().map((t) => t.subagent_type),
    ['r2'],
  )
  assert.equal(m.getTemplateByType('r1'), undefined)

  m.resetRemoteTemplates([
    tpl('r3', 'R3', { priority: REMOTE_PRIORITY }),
    tpl('code-reviewer', '远程评审', { priority: REMOTE_PRIORITY }),
  ])
  assert.equal(m.getRemoteTemplates().length, 2)
  assert.equal(m.getTemplateByType('r3')!.name, 'R3')
  // remote 不覆盖内置
  assert.equal(m.getTemplateByType('code-reviewer')!.name, '代码审查专家')
  // project 覆盖 remote
  m.setCustomTemplates([], [tpl('r3', '项目版R3')])
  assert.equal(m.getTemplateByType('r3')!.name, '项目版R3')
})
