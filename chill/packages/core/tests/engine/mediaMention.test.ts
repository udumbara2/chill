import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMediaMentions, MEDIA_EXTENSIONS } from '../../src/engine/mediaMention.ts'

test('基本形态: 无空格 token 提取为媒体提及并从正文剔除', () => {
  const r = parseMediaMentions('看下 @a.png 这张图')
  assert.deepEqual(r.mentions, [{ raw: '@a.png', path: 'a.png', kind: 'image' }])
  assert.equal(r.text, '看下 这张图')
})

test('Windows 路径: 盘符/反斜杠/中文目录均可，扩展名大小写不敏感', () => {
  const r = parseMediaMentions(String.raw`@C:\Users\Administrator\Desktop\测试目录\截图.PNG 描述一下`)
  assert.deepEqual(r.mentions, [
    { raw: String.raw`@C:\Users\Administrator\Desktop\测试目录\截图.PNG`, path: String.raw`C:\Users\Administrator\Desktop\测试目录\截图.PNG`, kind: 'image' },
  ])
  assert.equal(r.text, '描述一下')
})

test('引号形态: 带空格路径用 @"..." 或 @\'...\' 提取', () => {
  const r1 = parseMediaMentions(String.raw`@"C:\my pics\屏幕截图 1.png" 总结`)
  assert.deepEqual(r1.mentions, [
    { raw: String.raw`@"C:\my pics\屏幕截图 1.png"`, path: String.raw`C:\my pics\屏幕截图 1.png`, kind: 'image' },
  ])
  assert.equal(r1.text, '总结')

  const r2 = parseMediaMentions("@'my pics/a b.mp4' 转述")
  assert.deepEqual(r2.mentions, [{ raw: "@'my pics/a b.mp4'", path: 'my pics/a b.mp4', kind: 'video' }])
  assert.equal(r2.text, '转述')
})

test('多提及混合: 图片与视频并存，清理文本压平空白', () => {
  const r = parseMediaMentions('对比 @a.jpg   和 @b.mkv 的差异')
  assert.deepEqual(r.mentions, [
    { raw: '@a.jpg', path: 'a.jpg', kind: 'image' },
    { raw: '@b.mkv', path: 'b.mkv', kind: 'video' },
  ])
  assert.equal(r.text, '对比 和 的差异')
})

test('降级规则: 未知扩展名/@agent/邮箱一律按普通文本保留', () => {
  assert.deepEqual(parseMediaMentions('@security-reviewer 审查'), { text: '@security-reviewer 审查', mentions: [] })
  assert.deepEqual(parseMediaMentions('联系 a@b.com 或看 @readme.txt'), { text: '联系 a@b.com 或看 @readme.txt', mentions: [] })
  assert.deepEqual(parseMediaMentions('没有任何提及'), { text: '没有任何提及', mentions: [] })
})

test('边界: 扩展名后紧跟字母数字不误配（.pngx 不是 .png）', () => {
  assert.deepEqual(parseMediaMentions('@a.pngx 你好'), { text: '@a.pngx 你好', mentions: [] })
  // 扩展名后是标点/空白/文末均可正常命中
  assert.equal(parseMediaMentions('@a.png，看下').mentions.length, 1)
})

test('MEDIA_EXTENSIONS 表完整性: 每个扩展名都有 kind 与 mime', () => {
  for (const [ext, entry] of Object.entries(MEDIA_EXTENSIONS)) {
    assert.ok(ext.startsWith('.'), `${ext} 须带点前缀`)
    assert.ok(entry.kind === 'image' || entry.kind === 'video', `${ext} kind 非法`)
    assert.ok(entry.mime.includes('/'), `${ext} mime 非法`)
  }
})
