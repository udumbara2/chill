/**
 * keys/index.json：展示名登记 + 迁移审计簿（非寻址依赖）
 *
 * 寻址正确性只依赖 storageKey 编解码双射；本索引仅承担：① 逻辑名展示补全（超长式的
 * 可读名）② 存量迁移审计/断点。撕裂只影响显示，不影响寻址——故不设复杂恢复，
 * 解析失败一律按空索引继续。写入 tmp+rename 原子写（照 team-runs 快照先例）。
 *
 * I/O 经注入的文件原语：CLI/electron 后端只提供读写原语，索引逻辑不写第二份。
 */
import { storageKeyToLogical, isEncodedStorageKey } from './storageKey'

export interface CredentialIndexEntry {
  storageKey: string
  displayName?: string
  note?: string
}

export interface CredentialIndexMigration {
  /** 4a 备份目标目录名（存在即视为备份完成，幂等据点） */
  backupDir?: string
  /** 4a 编码改名是否收尾 */
  encodedDone?: boolean
  /** 4b 归位审计：`<from>→<to>` 列表 */
  relocated?: string[]
}

export interface CredentialIndexData {
  version: 1
  entries: Record<string, CredentialIndexEntry>
  migration?: CredentialIndexMigration
}

/** keys 目录内的文本文件原语（名字不含路径，后端自行拼 keysDir） */
export interface KeyDirTextOps {
  readText(name: string): string | null
  writeText(name: string, content: string): boolean
  rename(from: string, to: string): boolean
  remove(name: string): void
}

const INDEX_FILE = 'index.json'
const INDEX_TMP = 'index.json.tmp'

export function emptyCredentialIndex(): CredentialIndexData {
  return { version: 1, entries: {} }
}

/** 宽松解析：任何异常/缺字段一律收敛为空结构 */
export function normalizeCredentialIndex(raw: unknown): CredentialIndexData {
  const base = emptyCredentialIndex()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>
  const entriesOut: Record<string, CredentialIndexEntry> = {}
  if (r.entries && typeof r.entries === 'object') {
    for (const [logicalId, v] of Object.entries(r.entries as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const e = v as Record<string, unknown>
      if (typeof e.storageKey !== 'string') continue
      entriesOut[logicalId] = {
        storageKey: e.storageKey,
        displayName: typeof e.displayName === 'string' ? e.displayName : undefined,
        note: typeof e.note === 'string' ? e.note : undefined,
      }
    }
  }
  base.entries = entriesOut
  if (r.migration && typeof r.migration === 'object') {
    const m = r.migration as Record<string, unknown>
    base.migration = {
      backupDir: typeof m.backupDir === 'string' ? m.backupDir : undefined,
      encodedDone: m.encodedDone === true,
      relocated: Array.isArray(m.relocated) ? m.relocated.filter((x): x is string => typeof x === 'string') : [],
    }
  }
  return base
}

export function loadCredentialIndex(ops: KeyDirTextOps): CredentialIndexData {
  try {
    const text = ops.readText(INDEX_FILE)
    if (!text) return emptyCredentialIndex()
    return normalizeCredentialIndex(JSON.parse(text))
  } catch {
    return emptyCredentialIndex()
  }
}

export function saveCredentialIndex(ops: KeyDirTextOps, data: CredentialIndexData): boolean {
  try {
    const content = JSON.stringify(data, null, 2)
    if (!ops.writeText(INDEX_TMP, content)) return ops.writeText(INDEX_FILE, content)
    if (!ops.rename(INDEX_TMP, INDEX_FILE)) return ops.writeText(INDEX_FILE, content)
    return true
  } catch {
    return false
  }
}

export function upsertCredentialEntry(
  data: CredentialIndexData,
  logicalId: string,
  storageKey: string,
  displayName?: string,
): void {
  const prev = data.entries[logicalId]
  data.entries[logicalId] = {
    storageKey,
    displayName: displayName ?? prev?.displayName,
    note: prev?.note,
  }
}

/** 超长式/无法解码时的展示名回查 */
export function findLogicalByStorageKey(data: CredentialIndexData, storageKey: string): string | null {
  for (const [logicalId, e] of Object.entries(data.entries)) {
    if (e.storageKey === storageKey) return logicalId
  }
  return null
}

/** 列表展示用：编码名解码还原，超长式回查索引，存量裸名原样（迁移期） */
export function logicalNameForStorageStem(stem: string, index: CredentialIndexData): string {
  const decoded = storageKeyToLogical(stem)
  if (decoded !== null) return decoded
  if (isEncodedStorageKey(stem)) return findLogicalByStorageKey(index, stem) ?? stem
  return stem
}

export function mergeMigration(
  ops: KeyDirTextOps,
  patch: Partial<CredentialIndexMigration>,
): CredentialIndexData {
  const data = loadCredentialIndex(ops)
  data.migration = { backupDir: undefined, encodedDone: false, relocated: [], ...(data.migration ?? {}), ...patch }
  saveCredentialIndex(ops, data)
  return data
}
