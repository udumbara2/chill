/**
 * wsKeepalive.test.ts — 读长连主动探活策略回归（常数语义 + 判死判定边界）。
 * 背景：纯接收向 WS 静默死亡后客户端结构性失明（2026-10-03 事故），策略单源在 core，
 * 壳侧只做定时器编排——改判定前本文件须全绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WS_KEEPALIVE_PING_INTERVAL_MS,
  WS_KEEPALIVE_STALE_MS,
  keepaliveAction,
} from '../../src/services/relay/wsKeepalive.ts'

test('keepalive: 常数语义——ping 周期与服务器心跳同值，判死阈值 > 2×周期', () => {
  assert.equal(WS_KEEPALIVE_PING_INTERVAL_MS, 30_000)
  assert.ok(WS_KEEPALIVE_STALE_MS > 2 * WS_KEEPALIVE_PING_INTERVAL_MS, '判死须容忍连续错过 2 个 pong')
})

test('keepalive: 新鲜活跃 → ping', () => {
  assert.equal(keepaliveAction(1_000, 1_000 + WS_KEEPALIVE_STALE_MS), 'ping')
})

test('keepalive: 错过 ~2 个 pong（阈值+1ms）→ terminate 判死', () => {
  assert.equal(keepaliveAction(1_000, 1_000 + WS_KEEPALIVE_STALE_MS + 1), 'terminate')
})

test('keepalive: 首个周期内（未到判死阈值）→ ping 而非误杀', () => {
  // 连上后第一个 tick：lastAliveAt=连接时刻，只过去一个周期
  assert.equal(keepaliveAction(0, WS_KEEPALIVE_PING_INTERVAL_MS), 'ping')
})
