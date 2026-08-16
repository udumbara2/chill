import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeOutput, StreamOutputDecoder } from '../../src/execution/PowerShellExecutor.ts'

// '中文路径' 的 GBK 字节
const GBK_ZHONGWEN = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0xC2, 0xB7, 0xBE, 0xB6])

test('纯 UTF-8 输出（含中文）整段快速通道通过', () => {
  const buf = Buffer.from('开始处理助手目录\n第二行 done\n', 'utf8')
  assert.equal(decodeOutput(buf, 'gbk'), '开始处理助手目录\n第二行 done\n')
})

test('纯 GBK 输出整段回退解码', () => {
  const buf = Buffer.concat([GBK_ZHONGWEN, Buffer.from(' C:\\Users\\test\r\n')])
  assert.equal(decodeOutput(buf, 'gbk'), '中文路径 C:\\Users\\test\r\n')
})

test('混合流：UTF-8 行与 GBK 行各自正确', () => {
  const utf8Line = Buffer.from('开始处理助手目录\n', 'utf8')
  const gbkLine = Buffer.concat([GBK_ZHONGWEN, Buffer.from('\n')])
  const asciiLine = Buffer.from('plain ascii line\n')
  const buf = Buffer.concat([utf8Line, gbkLine, asciiLine])
  assert.equal(decodeOutput(buf, 'gbk'), '开始处理助手目录\n中文路径\nplain ascii line\n')
})

test('无换行单段 GBK 输出', () => {
  assert.equal(decodeOutput(GBK_ZHONGWEN, 'gbk'), '中文路径')
})

test('空 buffer', () => {
  assert.equal(decodeOutput(Buffer.alloc(0), 'gbk'), '')
  assert.equal(decodeOutput(Buffer.alloc(0), null), '')
})

test('无回退标签时退化为纯 UTF-8（历史行为）', () => {
  const utf8Buf = Buffer.from('你好\n', 'utf8')
  assert.equal(decodeOutput(utf8Buf, null), '你好\n')
  // GBK 字节在无回退时按 UTF-8 非严格解码，产生替换符（不抛错）
  const result = decodeOutput(GBK_ZHONGWEN, null)
  assert.ok(result.includes('�'))
})

test('流式解码：UTF-8 中文字符跨块切分不破碎', () => {
  const full = Buffer.from('第1行中文\n', 'utf8')
  // 把多字节字符从中切开
  const c1 = full.subarray(0, 5)
  const c2 = full.subarray(5)
  const dec = new StreamOutputDecoder('gbk')
  const out = dec.push(c1) + dec.push(c2) + dec.flush()
  assert.equal(out, '第1行中文\n')
})

test('流式解码：GBK 块触发回退切换', () => {
  const dec = new StreamOutputDecoder('gbk')
  const out = dec.push(Buffer.concat([GBK_ZHONGWEN, Buffer.from('\n')])) + dec.flush()
  assert.equal(out, '中文路径\n')
})

test('流式解码：setFallbackLabel 迟到绑定生效', () => {
  const dec = new StreamOutputDecoder(null)
  dec.setFallbackLabel('gbk')
  const out = dec.push(GBK_ZHONGWEN) + dec.flush()
  assert.equal(out, '中文路径')
})
