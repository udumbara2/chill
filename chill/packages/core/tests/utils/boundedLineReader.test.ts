/**
 * boundedLineReader.test.ts — 文件行读取安全形态回归。
 * 背景：裸 readline 遍历文件流时 kLine_buffer 无上限，单行 ≥ V8 字符串上限
 * （~536M 字符）在 data 事件上下文抛 RangeError 杀死宿主进程（2026-10-04
 * serve 崩溃实测，640MB 单行文件本地复现栈逐字节一致）。本读取器以固定容量
 * 滚动缓冲根治——改行为前本文件须全绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readLinesBounded, MAX_LINE_CHARS } from '../../src/utils/boundedLineReader.ts'

async function* toAsync(chunks: Array<string | Uint8Array>): AsyncGenerator<string | Uint8Array> {
  for (const c of chunks) yield c
}

async function collect(chunks: Array<string | Uint8Array>, cap?: number) {
  const out: string[] = []
  for await (const line of readLinesBounded(toAsync(chunks), cap)) {
    out.push(line.truncated ? `${line.text}|${line.originalLength}` : line.text)
  }
  return out
}

test('bounded: 常规多行文本——\\n / \\r\\n / 孤立 \\r / 末行无换行', async () => {
  const out = await collect(['a\nb\r\nc\rd', 'e\n'])
  // 第一块结尾的 'd' 与第二块开头的 'e' 跨块续成同一行 'de'（滚动缓冲语义）
  assert.deepEqual(out, ['a', 'b', 'c', 'de'])
})

test('bounded: 文件以换行结尾不产多余空行；单个换行产一个空行', async () => {
  assert.deepEqual(await collect(['x\n']), ['x'])
  assert.deepEqual(await collect(['\n']), [''])
  assert.deepEqual(await collect([]), [])
})

test('bounded: 超长行截断——text 封顶、originalLength 如实、后续行不受影响', async () => {
  const giant = 'y'.repeat(50)
  const out = await collect([giant + '\n', 'next\n'], 10)
  assert.deepEqual(out, ['y'.repeat(10) + '|50', 'next'])
})

test('bounded: 超长行不落换行结尾也产出（截断口径一致）', async () => {
  const out = await collect(['z'.repeat(30)], 5)
  assert.deepEqual(out, ['zzzzz|30'])
})

test('bounded: 字节块跨块多字节安全解码（UTF-8 字符被 chunk 边界劈开）', async () => {
  // '你' = E4 BD A0，三个字节各成一块
  const out = await collect([new Uint8Array([0xe4]), new Uint8Array([0xbd]), new Uint8Array([0xa0]), '\n' + '好'.repeat(2) + '\n'])
  assert.deepEqual(out, ['你', '好好'])
})

test('bounded: 大输入小上限——内存口径与产出完整性（100 万字符行、上限 1000）', async () => {
  const chunks: string[] = []
  for (let i = 0; i < 100; i++) chunks.push('w'.repeat(10_000))
  const out = await collect(chunks, 1000)
  assert.equal(out.length, 1)
  assert.equal(out[0], 'w'.repeat(1000) + '|1000000')
})

test('bounded: 缺省上限值语义——8MiB 字符（合法单行宽裕天花板）', () => {
  assert.equal(MAX_LINE_CHARS, 8 * 1024 * 1024)
})
