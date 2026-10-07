import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchTargetInText, matchAnchorInText } from '../../src/services/positioning/textMatcher.ts'

/**
 * 统一文本匹配引擎测试。
 * 核心回归场景来自生产失败日志与根因实验（experiGround/replace-insert-probe）：
 * 缩进行起始（归一化不对称）、CRLF、行尾空格、多匹配误报、候选自碰撞去重。
 */

test('L0 原文精确：唯一匹配成功，返回原文区间', () => {
  const file = 'line1\nline2\nline3'
  const r = matchTargetInText(file, 'line2')
  assert.equal(r.success, true)
  if (r.success) {
    assert.equal(r.matchedText, 'line2')
    assert.equal(file.slice(r.from, r.to), 'line2')
  }
})

test('根因三回归：缩进行起始的 target 必须一次匹配成功（新鲜内容）', () => {
  const file = 'class Settings:\n    DEBUG: bool = False\n    LLM_ENABLED: bool = True\n    PORT: int = 8010'
  const target = '    LLM_ENABLED: bool = True'
  const r = matchTargetInText(file, target)
  assert.equal(r.success, true, r.success ? '' : r.error)
  if (r.success) {
    assert.equal(r.matchedText, target)
    // from 指向该行行首（含缩进）
    assert.equal(file.slice(r.from, r.to), target)
    assert.equal(r.from, file.indexOf(target))
  }
})

test('根因三回归：多行缩进 target（含空行）一次匹配成功', () => {
  const file = 'x\n\n    LLM_ENABLED: bool = True\n\n    class Config:\ny'
  const target = '    LLM_ENABLED: bool = True\n\n    class Config:'
  const r = matchTargetInText(file, target)
  assert.equal(r.success, true, r.success ? '' : r.error)
  if (r.success) assert.equal(r.matchedText, target)
})

test('L1 行级容忍：CRLF 文件 + LF target 匹配成功', () => {
  const file = 'line1\r\n    foo();\r\nline3'
  const r = matchTargetInText(file, '    foo();')
  assert.equal(r.success, true, r.success ? '' : r.error)
  if (r.success) {
    assert.equal(r.matchedText, '    foo();')
    assert.equal(file.slice(r.from, r.to), '    foo();')
  }
})

test('L1 行级容忍：文件行尾空格差异 → 命中且区间覆盖文件原始行尾空格', () => {
  // 多行 target + CRLF 文件：L0 必败，强制走 L1
  const file = 'a\r\n    foo();   \r\nb'
  const r = matchTargetInText(file, '    foo();\nb')
  assert.equal(r.success, true, r.success ? '' : r.error)
  if (r.success) {
    assert.equal(r.matchedText, '    foo();   \r\nb', '替换区间应吞掉文件侧行尾空格并保留原换行')
  }
})

test('L1 行级容忍：target 行尾空格/末尾换行差异不影响匹配', () => {
  const file = 'a\n    foo();\nb'
  const r1 = matchTargetInText(file, '    foo();   ')
  assert.equal(r1.success, true, r1.success ? '' : r1.error)
  const r2 = matchTargetInText(file, '    foo();\n')
  assert.equal(r2.success, true, r2.success ? '' : r2.error)
})

test('唯一性内建：多处匹配报错并给出 candidates，不得静默取第一', () => {
  const file = 'foo\nbar\nfoo\nbaz'
  const r = matchTargetInText(file, 'foo')
  assert.equal(r.success, false)
  if (!r.success) {
    assert.match(r.error, /2 个匹配位置/)
    assert.ok(r.candidates && r.candidates.length === 2)
  }
})

test('context_before/context_after 精确过滤：两处相同 target 筛出唯一', () => {
  const file = 'AAA foo BBB\nCCC foo DDD'
  const r = matchTargetInText(file, 'foo', 'AAA ')
  assert.equal(r.success, true, r.success ? '' : r.error)
  if (r.success) assert.equal(r.from, 4)
  const r2 = matchTargetInText(file, 'foo', undefined, ' DDD')
  assert.equal(r2.success, true, r2.success ? '' : r2.error)
  if (r2.success) assert.equal(r2.from, 16)
})

test('未找到：报错带 read_file 行动指引，候选按首行包含给出', () => {
  const file = 'alpha\n  LLM_ENABLED: bool = True  // 注释\nbeta'
  const r = matchTargetInText(file, '    LLM_ENABLED: bool = True\n    OTHER: int = 1')
  assert.equal(r.success, false)
  if (!r.success) {
    assert.match(r.error, /未找到匹配的文本/)
    assert.match(r.error, /read_file/)
    assert.ok(r.candidates && r.candidates.length === 1)
  }
})

test('候选去重：间距小于 target 长度的候选被合并（防滑窗自碰撞式误报）', () => {
  // 多行 target（长度 20）的首行 KEY 在相邻三行都出现，行间距 6 < 20 → 应去重为 1 个候选
  const target = 'KEY\nsecond line here'
  const file = 'KEY a\nKEY b\nKEY c'
  const r = matchTargetInText(file, target)
  assert.equal(r.success, false)
  if (!r.success) {
    assert.match(r.error, /未找到匹配的文本/)
    assert.equal(r.candidates!.length, 1)
  }
})

test('空 target / 全空白 target 直接报错', () => {
  const r = matchTargetInText('abc', '   \n  ')
  assert.equal(r.success, false)
})

test('L0 优先：target 从行中间开始（精确子串）命中', () => {
  const file = '    foo bar baz'
  const r = matchTargetInText(file, 'bar baz')
  assert.equal(r.success, true)
  if (r.success) assert.equal(r.from, 8)
})

test('anchor after：插入点在锚点下一行行首（LF）', () => {
  const file = 'line1\nline2\nline3'
  const r = matchAnchorInText(file, 'line2', 'after')
  assert.equal(r.success, true)
  if (r.success) {
    assert.equal(r.pos, file.indexOf('line3'))
  }
})

test('anchor after：CRLF 文件插入点同样落在下一行行首', () => {
  const file = 'line1\r\nline2\r\nline3'
  const r = matchAnchorInText(file, 'line2', 'after')
  assert.equal(r.success, true)
  if (r.success) assert.equal(r.pos, file.indexOf('line3'))
})

test('anchor before：插入点回退到锚点所在行行首', () => {
  const file = 'line1\n    indented anchor\nline3'
  const r = matchAnchorInText(file, 'indented anchor', 'before')
  assert.equal(r.success, true)
  if (r.success) {
    assert.equal(file.slice(r.pos, r.pos + 4), '    ')
    assert.equal(r.pos, file.indexOf('    indented'))
  }
})

test('anchor 未找到：报错含"未找到锚点文本"与 read_file 指引', () => {
  const r = matchAnchorInText('foo\nbar', 'not-exist', 'after')
  assert.equal(r.success, false)
  if (!r.success) {
    assert.match(r.error, /未找到锚点文本/)
    assert.match(r.error, /read_file/)
  }
})

test('anchor 多匹配：报错并要求补充上下文', () => {
  const r = matchAnchorInText('dup\ndup', 'dup', 'after')
  assert.equal(r.success, false)
  if (!r.success) assert.match(r.error, /个匹配位置/)
})
