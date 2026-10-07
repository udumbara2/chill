/**
 * commandSurfaceDesktop.test.ts — 宿主级开关（desktop.set / autoswitch.set）行为测试。
 * 覆盖：执行器写键/合成消息/放行收回/探测回流/事件通告、缺端口诚实 unsupported、
 * buildCommandState 宿主标量（undefined ≠ false）、目录下发规格。
 * 单一事实点在 services/desktopControl.ts（共享核心）——本套件经命令面执行器入口验证整链。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeCommand, buildCommandState } from '../../src/services/commands/commandSurface.ts'
import {
  readDesktopEnabled,
  readAutoSwitch,
  DESKTOP_CONTROL_ENABLED_KEY,
  AUTOSWITCH_AFTER_ITERATION_KEY,
  DESKTOP_ENABLED_NOTICE,
  DESKTOP_DISABLED_NOTICE,
  type DesktopControlStore,
} from '../../src/services/desktopControl.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'

// ==================== fakes ====================

function makeStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  const writes: Array<[string, string]> = []
  const store: DesktopControlStore = {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v)
      writes.push([k, v])
    },
  }
  return { store, writes, map: m }
}

function makeEngine() {
  const synth: Array<{ text: string; tag?: string }> = []
  return {
    engine: {
      getSessionState: () => ({ sessionId: 's1', planMode: false, isRunning: false }),
      getContextStatus: () => null,
      appendSyntheticMessage: (text: string, tag?: string) => {
        synth.push({ text, tag })
      },
    },
    synth,
  }
}

function makeSessionAllow() {
  const calls: number[] = []
  return { sessionAllow: { resetDesktopSessionAllow: () => calls.push(calls.length) }, calls }
}

/** 事件捕获（用后退订，防跨用例污染） */
function captureEvent(event: string) {
  const got: Array<{ on: boolean }> = []
  const fn = (p: { on: boolean }) => got.push(p)
  eventBus.on(event, fn)
  return { got, off: () => eventBus.off(event, fn) }
}

// ==================== desktop.set 执行器 ====================

test('desktop.set on：写键 + 合成消息（desktopToggle）+ 探测回流 + 事件通告', async () => {
  const { store, writes } = makeStore({ [DESKTOP_CONTROL_ENABLED_KEY]: 'false' })
  const { engine, synth } = makeEngine()
  const ev = captureEvent(EVENTS.DESKTOP_CONTROL_TOGGLED)
  try {
    const r = await executeCommand(
      { engine, desktopControl: { store, desktop: { isAvailable: async () => true } } },
      'desktop.set',
      { on: true },
    )
    assert.ok(r.ok, `desktop.set on 应成功：${r.ok ? '' : JSON.stringify(r.error)}`)
    assert.deepEqual(writes, [[DESKTOP_CONTROL_ENABLED_KEY, 'true']], '写键 desktop_control_enabled=true')
    assert.equal(synth.length, 1, '注入一条合成消息')
    assert.equal(synth[0]!.tag, 'desktopToggle')
    assert.equal(synth[0]!.text, DESKTOP_ENABLED_NOTICE, '文案与共享核心常量逐字一致（CLI 同源）')
    assert.equal((r as { data?: { available?: boolean } }).data?.available, true, '可用性探测经 data.available 回流')
    assert.deepEqual(ev.got, [{ on: true }], 'DESKTOP_CONTROL_TOGGLED 事件载荷 { on: true }')
  } finally {
    ev.off()
  }
})

test('desktop.set off：写键 + 收回会话放行 + 已关闭合成消息 + 事件', async () => {
  const { store, writes } = makeStore({ [DESKTOP_CONTROL_ENABLED_KEY]: 'true' })
  const { engine, synth } = makeEngine()
  const { sessionAllow, calls } = makeSessionAllow()
  const ev = captureEvent(EVENTS.DESKTOP_CONTROL_TOGGLED)
  try {
    const r = await executeCommand({ engine, desktopControl: { store, sessionAllow } }, 'desktop.set', { on: false })
    assert.ok(r.ok)
    assert.deepEqual(writes, [[DESKTOP_CONTROL_ENABLED_KEY, 'false']])
    assert.equal(calls.length, 1, 'off 收回桌面操作的会话级放行（[s] 授权随开关关闭失效）')
    assert.equal(synth.length, 1)
    assert.equal(synth[0]!.text, DESKTOP_DISABLED_NOTICE)
    assert.deepEqual(ev.got, [{ on: false }])
  } finally {
    ev.off()
  }
})

test('desktop.set：off 不装 sessionAllow → 跳过收回（无放行可收的宿主语义），仍成功', async () => {
  const { store } = makeStore({ [DESKTOP_CONTROL_ENABLED_KEY]: 'true' })
  const { engine } = makeEngine()
  const r = await executeCommand({ engine, desktopControl: { store } }, 'desktop.set', { on: false })
  assert.ok(r.ok)
})

test('desktop.set：缺 desktopControl 端口 → 诚实 unsupported（UI 壳未装配的同款降级）', async () => {
  const { engine } = makeEngine()
  const r = await executeCommand({ engine }, 'desktop.set', { on: true })
  assert.ok(!r.ok)
  assert.equal((r as { error: { code: string } }).error.code, 'unsupported')
})

test('desktop.set：引擎缺合成消息口 → unsupported（合成消息是模型能力认知关键动作，缺即拒绝）', async () => {
  const { store } = makeStore()
  const bareEngine = { getSessionState: () => ({ sessionId: 's1', planMode: false, isRunning: false }), getContextStatus: () => null }
  const r = await executeCommand({ engine: bareEngine, desktopControl: { store } }, 'desktop.set', { on: true })
  assert.ok(!r.ok)
  assert.equal((r as { error: { code: string } }).error.code, 'unsupported')
})

test('desktop.set：desktop 探测口缺省 → available 不回流（字段省略而非假值）', async () => {
  const { store } = makeStore()
  const { engine } = makeEngine()
  const r = await executeCommand({ engine, desktopControl: { store } }, 'desktop.set', { on: true })
  assert.ok(r.ok)
  assert.ok(r.ok && !('available' in (r.data ?? {})), 'available 键缺省（无探测即无承诺，不下发假值）')
})

// ==================== autoswitch.set 执行器 ====================

test('autoswitch.set on/off：纯写键 + 事件，不碰引擎合成消息', async () => {
  const { store, writes } = makeStore({ [AUTOSWITCH_AFTER_ITERATION_KEY]: 'false' })
  const { engine, synth } = makeEngine()
  const ev = captureEvent(EVENTS.AUTOSWITCH_TOGGLED)
  try {
    const r1 = await executeCommand({ engine, desktopControl: { store } }, 'autoswitch.set', { on: true })
    assert.ok(r1.ok)
    const r2 = await executeCommand({ engine, desktopControl: { store } }, 'autoswitch.set', { on: false })
    assert.ok(r2.ok)
    assert.deepEqual(writes, [
      [AUTOSWITCH_AFTER_ITERATION_KEY, 'true'],
      [AUTOSWITCH_AFTER_ITERATION_KEY, 'false'],
    ])
    assert.equal(synth.length, 0, '自动切换不注入合成消息（不涉会话内工具集）')
    assert.deepEqual(ev.got, [{ on: true }, { on: false }])
  } finally {
    ev.off()
  }
})

test('autoswitch.set：缺 desktopControl 端口 → 诚实 unsupported', async () => {
  const { engine } = makeEngine()
  const r = await executeCommand({ engine }, 'autoswitch.set', { on: true })
  assert.ok(!r.ok)
  assert.equal((r as { error: { code: string } }).error.code, 'unsupported')
})

// ==================== 状态快照宿主标量（undefined ≠ false） ====================

test('buildCommandState：hostFlags 装配 → desktop/autoswitch 读键布尔；缺省 → 字段整体缺省（未知 ≠ 已关）', () => {
  const { engine } = makeEngine()
  const on = makeStore({ [DESKTOP_CONTROL_ENABLED_KEY]: 'true', [AUTOSWITCH_AFTER_ITERATION_KEY]: 'true' })
  const s1 = buildCommandState({ engine, hostFlags: on.store })
  assert.equal(s1.desktop, true)
  assert.equal(s1.autoswitch, true)

  const off = makeStore({ [DESKTOP_CONTROL_ENABLED_KEY]: 'false', [AUTOSWITCH_AFTER_ITERATION_KEY]: 'false' })
  const s2 = buildCommandState({ engine, hostFlags: off.store })
  assert.equal(s2.desktop, false)
  assert.equal(s2.autoswitch, false)

  // 未装配读口（旧壳形态）：字段缺省而非 false——手机端显示"未同步"而非"已关"
  const s3 = buildCommandState({ engine }) as Record<string, unknown>
  assert.ok(!('desktop' in s3), 'desktop 字段应整体缺省')
  assert.ok(!('autoswitch' in s3), 'autoswitch 字段应整体缺省')
})

// ==================== 读面纯函数 ====================

test('readDesktopEnabled / readAutoSwitch：store 缺省 → undefined（与 false 严格区分）', () => {
  assert.equal(readDesktopEnabled(undefined), undefined)
  assert.equal(readAutoSwitch(undefined), undefined)
  const { store } = makeStore({ [DESKTOP_CONTROL_ENABLED_KEY]: 'true' })
  assert.equal(readDesktopEnabled(store), true)
  assert.equal(readAutoSwitch(store), false, 'store 在场而键未写 = 已知为关（false），而非未知（undefined）')
})
