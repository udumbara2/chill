/**
 * decompressArchive.test.ts — 解压子系统错误真实化回归
 * 背景（2026-10-13 fetch-source 事故根因环 #3/#4）：Expand-Archive 对非 zip 报非终止错误、
 * powershell.exe 退出码 0，Node exec 视为成功；空 destDir 被穿透逻辑当有效根返回——
 * 「下载到网页 → 解压假成功 → 空目录当源码就位」三连洗白。本测试钉死两条防线：
 * 非压缩包必须 reject、空结果必须 reject；合法 zip 照常解出（防误伤）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decompressArchive } from '../../src/utils/decompressArchive.ts'

test('非 zip 文件（HTML 网页头）必须 reject——不许洗白成假成功', async () => {
  const work = mkdtempSync(join(tmpdir(), 'decomp-fake-'))
  try {
    const fake = join(work, 'source.zip')
    writeFileSync(fake, '<!DOCTYPE html><html><body>login wall</body></html>')
    const dest = join(work, 'dest')
    mkdirSync(dest)
    await assert.rejects(
      decompressArchive(fake, dest),
      (err: unknown) => err instanceof Error,
      'HTML 冒充 zip 必须以错误结束（EAP=Stop 前缀保证退出码非 0）',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('解压结果为空必须 reject——空目录不是有效根', async () => {
  const work = mkdtempSync(join(tmpdir(), 'decomp-empty-'))
  try {
    // 空目录打成的 tar.gz：解压退出码 0、零产出——正是穿透逻辑曾把它当有效根的形态
    const emptyDir = join(work, 'empty')
    mkdirSync(emptyDir)
    const archive = join(work, 'empty.tar.gz')
    execSync(`tar -czf "${archive}" -C "${emptyDir}" .`, { shell: true, stdio: 'ignore' })
    const dest = join(work, 'dest')
    mkdirSync(dest)
    await assert.rejects(
      decompressArchive(archive, dest),
      /解压结果为空/,
      '零条目解压必须显式报错，不得返回 destDir 本身',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('合法 zip 正常解出（防误伤既有行为）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'decomp-ok-'))
  try {
    const fileDir = join(work, 'payload')
    mkdirSync(fileDir)
    writeFileSync(join(fileDir, 'hello.txt'), 'hi')
    const archive = join(work, 'payload.zip')
    execSync(
      `powershell -Command "Compress-Archive -Path '${join(fileDir, 'hello.txt').replace(/'/g, "''")}' -DestinationPath '${archive.replace(/'/g, "''")}' -Force"`,
      { shell: true, stdio: 'ignore' },
    )
    assert.ok(existsSync(archive), '测试夹具：zip 现造成功')
    const dest = join(work, 'dest')
    mkdirSync(dest)
    const root = await decompressArchive(archive, dest)
    assert.ok(existsSync(join(root, 'hello.txt')), '合法 zip 解出内容完整')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
