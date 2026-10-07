/**
 * versionToken.test.ts — 换版令牌单测（版本切换接续规划 M1.2c）
 *
 * 覆盖：读写往返与原子性、严格 schema 校验（畸形一律 null）、
 * watch 助手（新令牌触发一次/旧令牌不触发/启动时既有令牌视为过去时/poll 兜底/stop 幂等）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  defaultVersionTokenPath,
  isVersionSwitchToken,
  readVersionToken,
  watchVersionToken,
  writeVersionToken,
} from '../../src/services/versionToken.ts'

function tmpTokenPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'vtok-')), 'version-switched.json')
}

test('A1 读写往返：write→read 字段齐备且 nonce 唯一', () => {
  const p = tmpTokenPath()
  const t1 = writeVersionToken(p, 'v-test-1')
  assert.ok(t1, '写应成功')
  const back = readVersionToken(p)
  assert.ok(back, '读应成功')
  assert.equal(back.version, 'v-test-1')
  assert.equal(typeof back.at, 'number')
  const t2 = writeVersionToken(p, 'v-test-2')
  assert.notEqual(t1!.nonce, t2!.nonce, 'nonce 逐次唯一')
  rmSync(join(p, '..'), { recursive: true, force: true })
})

test('A2 畸形令牌一律 null：不存在 / 非 JSON / 字段缺失 / 字段类型错', () => {
  const p = tmpTokenPath()
  assert.equal(readVersionToken(p), null, '文件不存在 → null')
  writeFileSync(p, 'not-json{{', 'utf8')
  assert.equal(readVersionToken(p), null, '非 JSON → null')
  writeFileSync(p, JSON.stringify({ version: 'v', at: 1 }), 'utf8')
  assert.equal(readVersionToken(p), null, '缺 nonce → null')
  writeFileSync(p, JSON.stringify({ version: '', at: 1, nonce: 'x' }), 'utf8')
  assert.equal(readVersionToken(p), null, 'version 空串 → null')
  writeFileSync(p, JSON.stringify({ version: 'v', at: 'not-number', nonce: 'x' }), 'utf8')
  assert.equal(readVersionToken(p), null, 'at 类型错 → null')
  assert.equal(isVersionSwitchToken({ version: 'v', at: 1, nonce: 'x' }), true)
  rmSync(join(p, '..'), { recursive: true, force: true })
})

test('A3 watch：启动时既有令牌不触发；启动后新令牌触发一次；同令牌重复写不重触', async () => {
  const p = tmpTokenPath()
  const initial = writeVersionToken(p, 'v-initial')
  assert.ok(initial)
  const seen: string[] = []
  const w = watchVersionToken(p, (t) => seen.push(t.version), 30)
  try {
    await delay(100)
    assert.equal(seen.length, 0, '启动时盘上既有令牌=过去时，不触发')
    writeVersionToken(p, 'v-new')
    await delay(150)
    assert.deepEqual(seen, ['v-new'], '新令牌触发恰好一次（watch 事件+轮询去重）')
    // 幂等性：把当前令牌原样重写一遍（文件内容逐字节相同）→ 不重触
    writeFileSync(p, JSON.stringify(readVersionToken(p)), 'utf8')
    await delay(120)
    assert.equal(seen.length, 1, '同令牌原样重写不触发第二次')
    // 语义边界（如实记录）：重放更早的旧令牌会触发一次——令牌是建议性信号，
    // 自续到 junction 当前所指（可能就是本版本），无害；防的是"重复打扰"而非"重放"。
  } finally {
    w.stop()
    w.stop() // 幂等
  }
  rmSync(join(p, '..'), { recursive: true, force: true })
})

test('A4 watch：轮询兜底（watch 不可用环境语义等价——此处验证 poll 周期发现新令牌）', async () => {
  const p = tmpTokenPath()
  const seen: string[] = []
  const w = watchVersionToken(p, (t) => seen.push(t.version), 40)
  try {
    await delay(30)
    writeVersionToken(p, 'v-poll')
    await delay(200)
    assert.deepEqual(seen, ['v-poll'], '兜底轮询在 pollMs 量级内发现新令牌')
    assert.ok(w.lastSeen())
  } finally {
    w.stop()
  }
  rmSync(join(p, '..'), { recursive: true, force: true })
})

test('A5 defaultVersionTokenPath 落点与 relay.lock 同栖息地', () => {
  const p = defaultVersionTokenPath(join('X:', 'home'))
  assert.ok(p.endsWith(join('.chill', 'version-switched.json')), p)
})

test('A6 BOM 容错：带 UTF-8 BOM 的合法令牌可解析（实测教训：PS UTF8 写入带 BOM 曾被静默当畸形）', () => {
  const p = tmpTokenPath()
  const t = writeVersionToken(p, 'v-bom')
  assert.ok(t)
  writeFileSync(p, '\uFEFF' + JSON.stringify(t), 'utf8')
  const back = readVersionToken(p)
  assert.ok(back, 'BOM 令牌应可读')
  assert.equal(back!.version, 'v-bom')
  rmSync(join(p, '..'), { recursive: true, force: true })
})
