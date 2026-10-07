#!/usr/bin/env node
/**
 * doctor.mjs — 会话历史体检与修复（M7增量3·决策33）。
 *
 * 判据单源：从 core dist 导入 partitionMessages / findCollapsibleDuplicateIndices
 * （严禁在本脚本复写第二套规则——两套判据必然漂移）。
 *
 * 用法：
 *   node scripts/doctor.mjs audit
 *   node scripts/doctor.mjs repair --session <id> [--apply]
 *   node scripts/doctor.mjs restore --quarantine <文件名（quarantine 目录内）> [--apply]
 *
 * 缺省 dry-run（只报告不动盘）；--apply 前自动备份到 ~/.chill/backups/。
 * 修复动作 = ①隔离不合法消息（原文保全进 sessions/quarantine/，绝不删除）
 *           ②折叠重投堆积的重复 user 消息（"无 assistant 间隔段"内按文本去重保首份，
 *             折叠掉的同样保全进隔离区，restore 可逆）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.USERPROFILE ?? process.env.HOME
if (!HOME) {
  console.error('找不到用户目录（USERPROFILE/HOME）')
  process.exit(1)
}
const CHILL = join(HOME, '.chill')
const SESSIONS = join(CHILL, 'sessions')
const QUARANTINE = join(SESSIONS, 'quarantine')
const BACKUPS = join(CHILL, 'backups')

// 判据从 core dist 导入（需先在 packages/core 执行 npm run build）
const { partitionMessages, findCollapsibleDuplicateIndices } = await import('../packages/core/dist/index.js')

const args = process.argv.slice(2)
const command = args[0] ?? 'audit'
const apply = args.includes('--apply')
const optValue = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function loadRecord(id) {
  const file = join(SESSIONS, `${id}.json`)
  if (!existsSync(file)) throw new Error(`会话文件不存在: ${file}`)
  return { file, record: JSON.parse(readFileSync(file, 'utf-8')) }
}

function backup(file, tag) {
  mkdirSync(BACKUPS, { recursive: true })
  const name = file.split(/[\\/]/).pop().replace(/\.json$/, '')
  const dest = join(BACKUPS, `${name}-${tag}-${Date.now()}.json`)
  writeFileSync(dest, readFileSync(file, 'utf-8'))
  return dest
}

const previewMsg = (m) => {
  const role = m?.role ?? '?'
  const content = typeof m?.content === 'string' ? m.content.slice(0, 40) : '(非文本)'
  return `<${role}> ${content}`
}

/** 体检单会话：不合法消息 + 重复折叠计划（折叠在剔除不合法之后的清单上计算，再映射回原索引） */
function examine(messages) {
  const { invalid } = partitionMessages(messages)
  const invalidIdx = new Set(invalid.map((x) => x.index))
  const cleanedIdx = []
  const cleaned = []
  messages.forEach((m, i) => {
    if (!invalidIdx.has(i)) {
      cleaned.push(m)
      cleanedIdx.push(i)
    }
  })
  const dupOrigIdx = findCollapsibleDuplicateIndices(cleaned).map((j) => cleanedIdx[j])
  return { invalid, dupOrigIdx }
}

function audit() {
  const files = readdirSync(SESSIONS).filter((f) => f.endsWith('.json'))
  let sessions = 0
  let problems = 0
  for (const f of files) {
    sessions++
    let record
    try {
      record = JSON.parse(readFileSync(join(SESSIONS, f), 'utf-8'))
    } catch (err) {
      console.log(`✗ ${f}：文件损坏（${err.message}）`)
      problems++
      continue
    }
    const messages = record.messages ?? []
    const { invalid, dupOrigIdx } = examine(messages)
    if (invalid.length === 0 && dupOrigIdx.length === 0) continue
    problems++
    console.log(`✗ ${f}`)
    for (const x of invalid) console.log(`    [非法] idx=${x.index} ${x.reason} | ${previewMsg(x.message)}`)
    if (dupOrigIdx.length > 0) {
      const byText = new Map()
      for (const i of dupOrigIdx) {
        const t = previewMsg(messages[i]).slice(0, 36)
        byText.set(t, (byText.get(t) ?? 0) + 1)
      }
      console.log(`    [重复] ${dupOrigIdx.length} 条可折叠（无 assistant 间隔段内同文）: ${[...byText.entries()].map(([t, n]) => `${t}×${n}`).join('；')}`)
    }
  }
  const qdir = existsSync(QUARANTINE) ? readdirSync(QUARANTINE) : []
  console.log(`\n体检完成：${sessions} 个会话，${problems} 个有问题；隔离区 ${qdir.length} 个文件`)
}

function repair() {
  const id = optValue('--session')
  if (!id) {
    console.error('用法: doctor.mjs repair --session <id> [--apply]')
    process.exit(1)
  }
  const { file, record } = loadRecord(id)
  const messages = record.messages ?? []
  const { invalid, dupOrigIdx } = examine(messages)
  if (invalid.length === 0 && dupOrigIdx.length === 0) {
    console.log(`✓ 会话 ${id} 干净，无需修复`)
    return
  }
  console.log(`会话 ${id}：隔离 ${invalid.length} 条非法消息，折叠 ${dupOrigIdx.length} 条重复消息`)
  for (const x of invalid) console.log(`    [隔离] idx=${x.index} ${x.reason} | ${previewMsg(x.message)}`)
  for (const i of dupOrigIdx) console.log(`    [折叠] idx=${i} | ${previewMsg(messages[i])}`)
  if (!apply) {
    console.log(`\n（dry-run：加 --apply 执行。执行前自动备份到 ${BACKUPS}）`)
    return
  }
  const backupFile = backup(file, 'doctor-repair')
  console.log(`已备份: ${backupFile}`)
  // 保全进隔离区（原文绝不删除；restore 可逆）
  mkdirSync(QUARANTINE, { recursive: true })
  const sidecar = join(QUARANTINE, `${id}.ndjson`)
  const lines =
    [
      ...invalid.map((x) => JSON.stringify({ quarantinedAt: new Date().toISOString(), reason: x.reason, source: 'doctor:非法消息', message: x.message })),
      ...dupOrigIdx.map((i) => JSON.stringify({ quarantinedAt: new Date().toISOString(), reason: '重投堆积重复（折叠保首份）', source: 'doctor:重复折叠', message: messages[i] })),
    ].join('\n') + '\n'
  writeFileSync(sidecar, (existsSync(sidecar) ? readFileSync(sidecar, 'utf-8') : '') + lines)
  const removeIdx = new Set([...invalid.map((x) => x.index), ...dupOrigIdx])
  record.messages = messages.filter((_, i) => !removeIdx.has(i))
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(record, null, 2))
  renameSync(tmp, file)
  console.log(`✓ 修复完成：${record.messages.length} 条消息保留；原文保全于 ${sidecar}`)
}

function restore() {
  const name = optValue('--quarantine')
  if (!name) {
    console.error('用法: doctor.mjs restore --quarantine <文件名（quarantine 目录内）> [--apply]')
    process.exit(1)
  }
  const sidecar = join(QUARANTINE, name)
  if (!existsSync(sidecar)) throw new Error(`隔离文件不存在: ${sidecar}`)
  const id = name.replace(/\.ndjson$/, '')
  const entries = readFileSync(sidecar, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  const { file, record } = loadRecord(id)
  console.log(`把 ${entries.length} 条隔离消息放回会话 ${id}（${record.messages.length} → ${record.messages.length + entries.length} 条）`)
  if (!apply) {
    console.log('\n（dry-run：加 --apply 执行。执行前自动备份）')
    return
  }
  const backupFile = backup(file, 'doctor-restore')
  console.log(`已备份: ${backupFile}`)
  const restored = [...record.messages, ...entries.map((e) => e.message)]
  restored.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  record.messages = restored
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(record, null, 2))
  renameSync(tmp, file)
  // 清空该会话的隔离账（已全部放回；再次 load 时读闸会重新体检）
  writeFileSync(sidecar, '')
  console.log('✓ 恢复完成')
}

if (command === 'audit') audit()
else if (command === 'repair') repair()
else if (command === 'restore') restore()
else {
  console.error(`未知命令: ${command}（audit | repair | restore）`)
  process.exit(1)
}
