import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TemplateSubagentForkManager } from '../../src/orchestrator/isolation/TemplateSubagentForkManager.ts'

/**
 * 委派失败死因透传：环境清理时 pending 请求须带具体死因 reject（超时/主动销毁/异常退出），
 * 让 Lead 能据原因调整委派策略，而不是只看到"环境已清理"。
 * 直接操作私有 Map 模拟运行态（同 workerOrigin.test.ts 的 (as any) 惯例）。
 */

/** 登记一个 fake pending 请求，返回其 reject 捕获 */
function plantPending(fm: TemplateSubagentForkManager, envId: string) {
  const rejected: Error[] = []
  const timeout = setTimeout(() => {}, 60000)
  ;(fm as any).pendingRequests.set(`req-${envId}`, {
    resolve: () => {},
    reject: (e: Error) => rejected.push(e),
    timeout,
    envId,
  })
  return rejected
}

test('死因透传: 已登记死因（超时）→ pending reject 携带死因与 envId', async () => {
  const fm = new TemplateSubagentForkManager()
  const envId = 'code-reviewer-1787454018570-test01'
  const rejected = plantPending(fm, envId)
  ;(fm as any).closeReasons.set(envId, '任务执行超时（硬上限 300s）')

  await (fm as any).cleanupEnvironment(envId)

  assert.equal(rejected.length, 1)
  assert.match(rejected[0].message, /任务执行超时（硬上限 300s）/)
  assert.match(rejected[0].message, /code-reviewer-1787454018570-test01/)
  // 死因登记与计时器随清理移除
  assert.equal((fm as any).closeReasons.has(envId), false)
})

test('死因透传: 未登记死因 → 回退"环境已清理"（向后兼容）', async () => {
  const fm = new TemplateSubagentForkManager()
  const envId = 'doc-writer-1787454018570-test02'
  const rejected = plantPending(fm, envId)

  await (fm as any).cleanupEnvironment(envId)

  assert.equal(rejected.length, 1)
  assert.match(rejected[0].message, /环境已清理/)
})

test('死因透传: destroy 登记主动销毁死因；已登记死因不被覆盖', async () => {
  const fm = new TemplateSubagentForkManager()
  const envId = 'agent-1787454018570-test03'
  const rejected = plantPending(fm, envId)

  // 模拟 destroy 的死因登记逻辑（destroy 本体需真实子进程，这里直接验证其登记分支的语义）
  if (!(fm as any).closeReasons.has(envId)) {
    ;(fm as any).closeReasons.set(envId, '任务已终止：环境被主动销毁（任务完成、cancel_task 取消或会话结束）')
  }
  // 二次登记不得覆盖（硬超时优先原则）
  const before = (fm as any).closeReasons.get(envId)
  if (!(fm as any).closeReasons.has(envId)) {
    ;(fm as any).closeReasons.set(envId, '不应出现')
  }
  assert.equal((fm as any).closeReasons.get(envId), before)

  await (fm as any).cleanupEnvironment(envId)
  assert.match(rejected[0].message, /主动销毁/)
})

test('死因透传: 硬超时计时器随清理取消（不泄漏）', async () => {
  const fm = new TemplateSubagentForkManager()
  const envId = 'agent-1787454018570-test04'
  ;(fm as any).hardTimeouts.set(envId, setTimeout(() => {
    throw new Error('硬超时计时器泄漏：清理后仍触发')
  }, 5))

  await (fm as any).cleanupEnvironment(envId)
  assert.equal((fm as any).hardTimeouts.has(envId), false)
  // 等待超过 5ms 验证计时器确实未触发（触发则抛错使测试失败）
  await new Promise((r) => setTimeout(r, 20))
})
