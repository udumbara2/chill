import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeKeyCombo } from '../../src/execution/keyNames.ts'

test('大小写与空白归一', () => {
  assert.equal(normalizeKeyCombo('CTRL+S'), 'ctrl+s')
  assert.equal(normalizeKeyCombo('Control + s'), 'ctrl+s')
  assert.equal(normalizeKeyCombo('  Enter '), 'enter')
})

test('修饰键别名归一', () => {
  assert.equal(normalizeKeyCombo('cmd+tab'), 'win+tab')
  assert.equal(normalizeKeyCombo('super+t'), 'win+t')
  assert.equal(normalizeKeyCombo('meta+k'), 'win+k')
  assert.equal(normalizeKeyCombo('option+x'), 'alt+x')
})

test('特殊键别名归一', () => {
  assert.equal(normalizeKeyCombo('return'), 'enter')
  assert.equal(normalizeKeyCombo('esc'), 'escape')
  assert.equal(normalizeKeyCombo('del'), 'delete')
  assert.equal(normalizeKeyCombo('ArrowLeft'), 'left')
  assert.equal(normalizeKeyCombo('ARROWUP'), 'up')
})

test('修饰键固定序且去重', () => {
  assert.equal(normalizeKeyCombo('s+ctrl'), 'ctrl+s')
  assert.equal(normalizeKeyCombo('shift+ctrl+a'), 'ctrl+shift+a')
  assert.equal(normalizeKeyCombo('ctrl+ctrl+s'), 'ctrl+s')
  assert.equal(normalizeKeyCombo('win+shift+s'), 'shift+win+s')
})

test('单字符键与功能键通过', () => {
  assert.equal(normalizeKeyCombo('a'), 'a')
  assert.equal(normalizeKeyCombo('5'), '5')
  assert.equal(normalizeKeyCombo('F5'), 'f5')
  assert.equal(normalizeKeyCombo('f24'), 'f24')
})

test('组合键常见形态', () => {
  assert.equal(normalizeKeyCombo('ctrl+alt+delete'), 'ctrl+alt+delete')
  assert.equal(normalizeKeyCombo('alt+tab'), 'alt+tab')
  assert.equal(normalizeKeyCombo('ctrl+shift+escape'), 'ctrl+shift+escape')
})

test('未识别键名明确报错', () => {
  assert.throws(() => normalizeKeyCombo('hyper+x'), /未识别的键名: "hyper"/)
  assert.throws(() => normalizeKeyCombo('f25'), /未识别的键名: "f25"/)
  assert.throws(() => normalizeKeyCombo(''), /键名不能为空/)
  assert.throws(() => normalizeKeyCombo('   '), /键名不能为空/)
})
