/**
 * 凭证存储键存量迁移（4a 编码改名 + 4b key 归位）
 *
 * 挂载时序（双壳同构）：backupKeysDir（备份在任何改名之前）→ runProviderKeyMigration（显名→id）
 * → loadAllModels（内含 migrateKeys：ModelType→id）→ **本模块**（编码改名 → 保守归位）。
 *
 * 幂等/断点续迁：以**磁盘状态检测**为据点（未编码 stem 即未完成改名；裸槽位有 key 而目标槽位
 * 无即归位候选），比 index 标志更抗撕裂——index 已降级为展示簿（§5），不作寻址/进度依赖。
 *
 * 4b 归位（保守启发，不猜测 / V7）：判定范围只算被 state.json 引用的**用户**绑定（出厂种子卡
 * 不计——glm-5.3 种子恒绑模板域，计入则启发永假死锁）；全部被引用用户绑定同指一个非模板域、
 * 且无被引用的模板域用户绑定时，才把裸槽位 key 划归该域（GLM Coding 形态）。证据不清一律留原地。
 */
import type { ISecureStorage } from '../../interfaces/ISecureStorage'
import { storageKeyFor, isEncodedStorageKey } from '../../services/credentials/storageKey'
import { providerManager, resolveCredentialId } from './providerManager'
import { modelInfoService } from './modelInfoService'
import { SelectedModelsService } from '../selectedModelsService'

interface KeyFileOps {
  listKeyFiles(): string[]
  renameKey(oldName: string, newName: string): boolean
}

/** 备份据点信息：name=备份目录名；created=本次是否真正新建（复用=false，作日志降噪依据） */
export interface KeysBackupInfo {
  name: string
  created: boolean
}

export interface KeyStorageMigrationResult {
  backedUp: string | null
  /** 本次是否真正新建了备份（false=复用已有备份，静默不播报） */
  backupCreated: boolean
  renamed: Array<{ from: string; to: string }>
  relocated: Array<{ from: string; to: string }>
}

/** state.json 引用扫描（口径同 materializeDeprecatedSelectedModels）：选中集 + 当前模型 + 各默认键 + 参数表 */
function collectReferencedModelNames(): Set<string> {
  const out = new Set<string>()
  try {
    const svc = SelectedModelsService.getInstance()
    for (const m of svc.getSelectedModels()) if (m?.name) out.add(m.name)
    const cur = svc.getCurrentModelName()
    if (cur) out.add(cur)
    try {
      for (const s of (svc as any).getAllModelParameterSettings?.() ?? []) {
        if (s?.modelName) out.add(s.modelName)
      }
    } catch { /* 参数表不可读不阻断 */ }
  } catch { /* 无 kv 注入时跳过 */ }
  return out
}

export async function runKeyStorageMigration(
  secureStorage: ISecureStorage & Partial<KeyFileOps> & { backupKeysDir?: () => KeysBackupInfo | null },
  log: (msg: string) => void = (m) => console.log(m),
): Promise<KeyStorageMigrationResult> {
  const result: KeyStorageMigrationResult = { backedUp: null, backupCreated: false, renamed: [], relocated: [] }

  // 4a-0 备份（幂等；调用方通常已在更早时点调过 backupKeysDir，这里兜底）
  // 日志降噪：只在本次**真正新建**备份时播报；已有备份复用一律静默（启动不再重复喊话）
  try {
    const info = secureStorage.backupKeysDir?.() ?? null
    result.backedUp = info?.name ?? null
    result.backupCreated = info?.created === true
    if (result.backupCreated) log(`【凭证迁移】keys 目录已新建备份：${result.backedUp}`)
  } catch (e) {
    log(`【凭证迁移】备份失败（继续只读迁移步骤）：${e}`)
  }

  // 4a-1 编码改名：未编码 stem → storageKeyFor(stem)（存量裸名的逻辑 ID 即 stem 本身）
  const ops = secureStorage as Partial<KeyFileOps>
  if (typeof ops.listKeyFiles === 'function' && typeof ops.renameKey === 'function') {
    for (const file of ops.listKeyFiles()) {
      if (!file.endsWith('.key')) continue
      const stem = file.slice(0, -4)
      if (isEncodedStorageKey(stem)) continue
      const newStem = storageKeyFor(stem)
      if (ops.renameKey(stem, newStem)) {
        result.renamed.push({ from: file, to: `${newStem}.key` })
      }
    }
    if (result.renamed.length > 0) {
      log(`【凭证迁移】存储键编码改名 ${result.renamed.length} 项（如 ${result.renamed[0].from}→${result.renamed[0].to}）`)
    }
  }

  // 4b key 归位（保守启发）
  const referenced = collectReferencedModelNames()
  if (referenced.size > 0) {
    const byProvider = new Map<string, string[]>() // providerId → 被引用用户绑定的槽位
    for (const name of referenced) {
      const card = modelInfoService.getModelInfoByName(name)
      if (!card || card.builtIn) continue // 出厂种子卡不计
      const providerId = providerManager.idFor(card.provider)
      const slot = resolveCredentialId(card)
      const list = byProvider.get(providerId) ?? []
      list.push(slot)
      byProvider.set(providerId, list)
    }
    for (const [providerId, slots] of byProvider) {
      const nonTemplate = Array.from(new Set(slots.filter(s => s !== providerId)))
      const hasTemplateRef = slots.some(s => s === providerId)
      if (nonTemplate.length !== 1 || hasTemplateRef) continue // 证据不清：不猜测、不搬迁
      const target = nonTemplate[0]
      const hasBare = await secureStorage.hasApiKey(providerId)
      const hasTarget = await secureStorage.hasApiKey(target)
      if (!hasBare || hasTarget) continue
      const key = await secureStorage.getApiKey(providerId)
      if (!key) continue
      const stored = await secureStorage.storeApiKey(target, key)
      if (stored) {
        await secureStorage.deleteApiKey(providerId)
        result.relocated.push({ from: providerId, to: target })
        log(`【凭证迁移】key 归位：${providerId} → ${target}（被引用绑定同指该通道域）`)
      }
    }
  }

  return result
}
