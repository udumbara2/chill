import { providerManager, LEGACY_PROVIDER_ID_MAP } from './providerManager';
import type { ISecureStorage } from '../../interfaces/ISecureStorage';

/**
 * provider key 命名空间迁移（幂等，启动时执行一次）
 *
 * 背景：key 文件曾按 provider 显示名/模型版本名命名（智谱AI.key、Moonshot AI.key、glm46.key），
 * 现统一为稳定 id（zhipu.key、moonshot.key）。本模块：
 * 1. providers.json 落盘（Map 已是"种子+自定义"全集且带 id）
 * 2. 旧名 key 文件改名到 <id>.key（仅限可正面确证属 provider 域的命名：现役 id/显示名、旧名映射表）
 * 3. 孤儿提示仅限「同域且内容已被规范名取代」的文件；其余未确证文件（mcp- 前缀的 MCP 命名空间、
 *    知识库 embedding 等其他子系统的 key）不属 provider 域——是否孤立由其 owner 判定，
 *    本迁移不碰、不报、不删除任何文件
 *
 * 前置：providerManager.loadProviders() 必须先执行（Map 就位）。
 */

/** CLISecureStorage 提供的文件原语（feature-detect，其他 ISecureStorage 实现可缺省） */
interface KeyFileOps {
  listKeyFiles(): string[];
  renameKey(oldName: string, newName: string): boolean;
}

export interface ProviderKeyMigrationResult {
  renamed: Array<{ from: string; to: string }>;
  orphaned: string[];
}

export async function runProviderKeyMigration(
  secureStorage: ISecureStorage,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<ProviderKeyMigrationResult> {
  const result: ProviderKeyMigrationResult = { renamed: [], orphaned: [] };

  // providers.json 落盘（补 id + 种子全集）
  await providerManager.persistProviders();

  const ops = secureStorage as unknown as Partial<KeyFileOps>;
  if (typeof ops.listKeyFiles !== 'function' || typeof ops.renameKey !== 'function') {
    return result; // 存储实现不支持文件原语（如非文件型存储），跳过
  }

  const keyFiles = ops.listKeyFiles().filter(f => f.endsWith('.key'));
  const keyNames = Array.from(new Set(keyFiles.map(f => f.slice(0, -4))));

  // ModelType 旧 key（如 glm.key）由 loadAllModels 内部的 migrateKeys 处理，本模块不碰
  const { ModelInfoService } = await import('./modelInfoService');
  const modelTypeNames: Set<string> = new Set(ModelInfoService.getBuiltInSeedModels().map(m => m.type as string));

  // 已按规范 id 命名的 key（其 id 视为已被占用）
  const taken = new Set<string>();
  // 待处理候选：非规范命名、非 mcp、非 ModelType 旧约定
  interface Candidate { name: string; canonicalId: string; isCurrent: boolean; isLegacy: boolean }
  const candidates: Candidate[] = [];
  for (const name of keyNames) {
    if (name.startsWith('mcp-')) continue; // MCP key 命名空间
    if (modelTypeNames.has(name)) continue; // ModelType 旧 key 交给 migrateKeys
    const canonicalId = providerManager.idFor(name);
    if (name === canonicalId) {
      taken.add(name);
      continue;
    }
    candidates.push({
      name,
      canonicalId,
      isCurrent: providerManager.providerExists(name),
      isLegacy: LEGACY_PROVIDER_ID_MAP[name] !== undefined,
    });
  }

  // 优先级：当前 provider 显示名（较新约定）先于纯旧名映射——同 id 时显示名 key 赢
  candidates.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));

  for (const c of candidates) {
    if (!c.isCurrent && !c.isLegacy) {
      // 未确证属 provider 域（知识库 embedding、其他子系统的命名空间）：判定权在其 owner，不碰不报
      continue;
    }
    if (taken.has(c.canonicalId)) {
      // 目标已存在（或已被更高优先级的旧名占用）：不覆盖，列为孤儿提示
      result.orphaned.push(`${c.name}.key（内容已被 ${c.canonicalId}.key 取代，可删除）`);
      continue;
    }
    if (ops.renameKey(c.name, c.canonicalId)) {
      result.renamed.push({ from: `${c.name}.key`, to: `${c.canonicalId}.key` });
      taken.add(c.canonicalId);
    }
  }

  if (result.renamed.length > 0) {
    log(`【Provider】已迁移 key 文件命名：${result.renamed.map(r => `${r.from}→${r.to}`).join('，')}`);
  }
  // 孤儿条目自带完整指引（「内容已被 <id>.key 取代，可删除」），直接引述即可
  for (const orphan of result.orphaned) {
    log(`【Provider】检测到孤立 key 文件：${orphan}`);
  }

  return result;
}
