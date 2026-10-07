import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickNativeFile, computeShadowTag, shadowFileName, staleShadowNames } from '../../src/services/nativeShadow.ts'

/**
 * 原生模块影子加载判定测试（core 唯一事实点）。
 * 覆盖：候选挑选（无匹配/单份/多份平台优先）、标签格式、影子命名、
 * 过期清单（当前标签不清理 / 他名文件不动 / 临时残留清理）。
 */

test('pickNativeFile：无匹配返回 null', () => {
  assert.equal(pickNativeFile([], 'native-desktop', 'win32', 'x64'), null)
  assert.equal(pickNativeFile(['native-desktop.node', 'other.win32-x64-msvc.node', 'native-desktop.d.ts'], 'native-desktop', 'win32', 'x64'), null)
})

test('pickNativeFile：单份匹配直接命中', () => {
  assert.equal(
    pickNativeFile(['index.js', 'native-desktop.win32-x64-msvc.node'], 'native-desktop', 'win32', 'x64'),
    'native-desktop.win32-x64-msvc.node',
  )
})

test('pickNativeFile：多份时优先当前 platform-arch', () => {
  const files = ['native-desktop.linux-x64-gnu.node', 'native-desktop.win32-x64-msvc.node', 'native-desktop.darwin-arm64.node']
  assert.equal(pickNativeFile(files, 'native-desktop', 'win32', 'x64'), 'native-desktop.win32-x64-msvc.node')
  assert.equal(pickNativeFile(files, 'native-desktop', 'darwin', 'arm64'), 'native-desktop.darwin-arm64.node')
})

test('pickNativeFile：多份但无当前平台时确定性取排序首份', () => {
  const files = ['native-desktop.linux-x64-gnu.node', 'native-desktop.darwin-arm64.node']
  assert.equal(pickNativeFile(files, 'native-desktop', 'win32', 'x64'), 'native-desktop.darwin-arm64.node')
})

test('computeShadowTag：size-mtimeMs 格式', () => {
  assert.equal(computeShadowTag({ size: 6389760, mtimeMs: 1759123456789.5 }), '6389760-1759123456789.5')
  assert.equal(computeShadowTag({ size: 0, mtimeMs: 0 }), '0-0')
})

test('shadowFileName：original.tag', () => {
  assert.equal(shadowFileName('native-desktop.win32-x64-msvc.node', '100-200'), 'native-desktop.win32-x64-msvc.node.100-200')
})

test('staleShadowNames：旧标签与临时残留列出，当前标签与他名文件不动', () => {
  const existing = [
    'native-desktop.win32-x64-msvc.node.100-200',
    'native-desktop.win32-x64-msvc.node.300-400',
    'native-desktop.win32-x64-msvc.node.100-200.tmp-1234',
    'other-module.win32-x64-msvc.node.100-200',
    'README.md',
  ]
  assert.deepEqual(staleShadowNames(existing, 'native-desktop.win32-x64-msvc.node', '100-200'), [
    'native-desktop.win32-x64-msvc.node.300-400',
    'native-desktop.win32-x64-msvc.node.100-200.tmp-1234',
  ])
  assert.deepEqual(staleShadowNames(existing, 'native-desktop.win32-x64-msvc.node', '300-400'), [
    'native-desktop.win32-x64-msvc.node.100-200',
    'native-desktop.win32-x64-msvc.node.100-200.tmp-1234',
  ])
})
