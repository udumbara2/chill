import { ModelType, ModelModality, type ModelInfo } from '../../types/models';
import type { ISecureStorage } from '../../interfaces/ISecureStorage';
import type { IFileSystemProvider, FileSystemResult } from '../../interfaces/IFileSystemProvider';
import type { IKeyValueStore } from '../../interfaces/IKeyValueStore';
import { providerManager, resolveCredentialId } from './providerManager';
import { deriveModelKind } from './deriveModelKind';
import { identityKeyOf, applyMultiBindingDisplayNames, resolveApiModelId, composeBindingDisplayName } from './modelIdentity';
import { getModelSeeds, getProviderProfileByName } from './catalog/modelCatalog';
import * as path from 'path';

/** 墓碑名单的 state.json 键：用户删除过的出厂模型名（JSON 数组） */
const DELETED_SEED_MODELS_KEY = 'deletedSeedModels';

/** 键序无关的规范化（影子文件与出厂卡内容等价比较用） */
function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

/** 内容等价比较（builtIn 是所有权标记而非内容，不参与比较） */
function isSameModelContent(a: ModelInfo, b: ModelInfo): boolean {
  const { builtIn: _a, ...restA } = a;
  const { builtIn: _b, ...restB } = b;
  return JSON.stringify(canonicalize(restA)) === JSON.stringify(canonicalize(restB));
}

/**
 * 模型信息服务类
 * 负责存储和管理所有模型的信息
 *
 * 数据所有权划分（每份数据只有一个所有者）：
 * - 内置模型定义 = 出厂数据所有（catalog/modelSeeds.ts + providerProfiles.ts，
 *   随包只读）：启动时从 getBuiltInSeedModels() 种子加载，不落盘、不读盘；
 *   版本演进（新增/改名/参数修正/退役）下次启动自动对齐。
 * - 自定义模型 = 用户所有：仅存 modelsDir 下的 *.json（builtIn:false）。
 * 内存始终为合并视图（出厂层 ∪ 用户层），消费方单一代码路径不变。
 * 覆盖语义：同名时用户层永远赢；state.json 的 deletedSeedModels 墓碑名单过滤出厂层
 * （用户删除的内置模型不复活）；墓碑读写走注入的 IKeyValueStore，未注入时无墓碑、不崩。
 */
export class ModelInfoService {
  private static instance: ModelInfoService;
  private modelInfos: Map<string, ModelInfo> = new Map();
  private secureStorage: ISecureStorage | null = null;
  private fileSystemProvider: IFileSystemProvider | null = null;
  private keyValueStore: IKeyValueStore | null = null;
  private modelsDir: string = '';

  private constructor() {
    // 不在构造时加载模型，modelsDir 和 fileSystemProvider 尚未就绪
    // 由 loadAllModels() 在外部调用方就绪后统一加载
  }

  /**
   * 获取服务单例实例
   */
  static getInstance(): ModelInfoService {
    if (!ModelInfoService.instance) {
      ModelInfoService.instance = new ModelInfoService();
    }
    return ModelInfoService.instance;
  }

  setSecureStorage(storage: ISecureStorage): void {
    this.secureStorage = storage;
  }

  /**
   * 设置文件系统提供者，用于持久化自定义模型
   */
  setFileSystemProvider(provider: IFileSystemProvider): void {
    this.fileSystemProvider = provider;
  }

  /**
   * 设置模型存储目录
   */
  setModelsDir(dirPath: string): void {
    this.modelsDir = dirPath;
  }

  /**
   * 设置 KV 存储（state.json 通道），用于 deletedSeedModels 墓碑名单。
   * 未注入时优雅降级：无墓碑，出厂层全显示。
   */
  setKeyValueStore(store: IKeyValueStore): void {
    this.keyValueStore = store;
  }

  /**
   * 读取墓碑名单（用户删除过的出厂模型名）。
   * 无 kv 注入或读写失败时降级为空名单（warn + 继续，不让模型加载崩）。
   */
  getDeletedSeedModels(): string[] {
    if (!this.keyValueStore) return [];
    try {
      const raw = this.keyValueStore.getItem(DELETED_SEED_MODELS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(n => typeof n === 'string') : [];
    } catch (e) {
      console.warn('读取 deletedSeedModels 墓碑名单失败，按无墓碑处理:', e);
      return [];
    }
  }

  /**
   * 把出厂模型名写入墓碑名单（remove_model 删内置卡时调用）。
   * 写失败仅告警——内存移除仍生效，最坏情况是重启后该卡重新露出。
   */
  addDeletedSeedModel(modelName: string): void {
    if (!this.keyValueStore) {
      console.warn('addDeletedSeedModel: keyValueStore 未设置，墓碑未持久化（重启后模型会恢复显示）');
      return;
    }
    try {
      const list = this.getDeletedSeedModels();
      if (!list.includes(modelName)) list.push(modelName);
      this.keyValueStore.setItem(DELETED_SEED_MODELS_KEY, JSON.stringify(list));
    } catch (e) {
      console.warn(`写入 deletedSeedModels 墓碑名单失败（${modelName}）:`, e);
    }
  }

  /**
   * 获取内置模型种子数据（唯一种子入口，loadAllModels/reloadFromDisk/migrateKeys 均经此）。
   * 卡数据 = catalog/modelSeeds.ts（只存模型级字段）；
   * 厂商级字段（baseURL/protocol/厂商级约束）由 catalog 内部折叠
   * providerProfiles.ts 补齐，此处直接返回折叠产物。
   */
  static getBuiltInSeedModels(): ModelInfo[] {
    return getModelSeeds();
  }

  /**
   * 初始化模型信息（将种子数据加载到内存 Map）
   */
  private initializeModelInfos(): void {
    const seedModels = ModelInfoService.getBuiltInSeedModels();
    for (const model of seedModels) {
      this.modelInfos.set(model.name, model);
    }
  }

  /**
   * 列出 models 目录下的模型 JSON 文件（排除 providers.json）
   */
  private async listModelJsonFiles(dir: string): Promise<{ name: string }[]> {
    const listResult = await this.fileSystemProvider!.listDirectory(dir);
    if (!listResult.success || !listResult.data) return [];
    let entries: { name: string }[] = [];
    if (Array.isArray(listResult.data)) {
      entries = listResult.data.map((f: any) => (typeof f === 'string' ? { name: f } : f));
    } else if (listResult.data.files) {
      entries = listResult.data.files;
    }
    return entries.filter((e: { name: string }) =>
      e.name.endsWith('.json') && e.name !== 'providers.json'
    );
  }

  /**
   * 读取并解析单个模型 JSON，失败返回 undefined
   */
  private async readModelJson(dir: string, name: string): Promise<ModelInfo | undefined> {
    const readResult = await this.fileSystemProvider!.readFile(path.join(dir, name));
    if (!readResult.success || !readResult.data) return undefined;
    try {
      const content = typeof readResult.data === 'string'
        ? readResult.data
        : readResult.data.content || '';
      return JSON.parse(content) as ModelInfo;
    } catch (e) {
      console.error(`解析模型文件 ${name} 失败:`, e);
      return undefined;
    }
  }

  /**
   * 内置文件迁移（幂等）：旧版本曾把内置种子播种到磁盘，那些文件是过时快照。
   * - builtIn:true 且名称在当前种子里 → 删除（内容本就是代码副本，种子接管）
   * - builtIn:true 且名称已不在种子里 → 以 builtIn:false 重写保留
   *   （退役 = 所有权移交用户；直接删除会让 state.json 中选中它的用户报「模型未注册」）
   * - builtIn:false 且与出厂卡同名（覆盖语义翻转前的存量影子文件）：
   *   内容与折叠后出厂卡一致 → 删除（等于没人改过，避免冗余副本）；
   *   不一致 → 保留（用户数据，翻转后即生效为用户覆盖）
   * - 其余 builtIn:false → 用户数据，不动
   */
  private async migrateBuiltInFiles(dir: string): Promise<void> {
    const seedModels = ModelInfoService.getBuiltInSeedModels();
    const seedByName = new Map(seedModels.map((m) => [m.name, m]));
    let entries: { name: string }[] = [];
    try {
      entries = await this.listModelJsonFiles(dir);
    } catch {
      return; // 目录不存在：无迁移对象
    }
    for (const entry of entries) {
      try {
        const modelInfo = await this.readModelJson(dir, entry.name);
        if (!modelInfo) continue;
        const filePath = path.join(dir, entry.name);
        if (modelInfo.builtIn === true) {
          if (seedByName.has(modelInfo.name)) {
            await this.fileSystemProvider!.deleteFile(filePath);
          } else {
            modelInfo.builtIn = false;
            await this.fileSystemProvider!.writeFile(filePath, JSON.stringify(modelInfo, null, 2));
          }
          continue;
        }
        // 存量影子文件迁移：同名出厂卡存在且内容一致（忽略 builtIn 标记）→ 删除冗余副本
        // deprecated 出厂卡除外：其同内容磁盘文件可能是退役阶段一的物化移交副本，
        // 删除会让用户在阶段二（种子移除）后失去该模型，故保留
        const seed = seedByName.get(modelInfo.name);
        if (seed && !seed.deprecated && isSameModelContent(modelInfo, seed)) {
          await this.fileSystemProvider!.deleteFile(filePath);
        }
      } catch (e) {
        console.error(`内置模型文件迁移 ${entry.name} 失败:`, e);
      }
    }
  }

  /**
   * 获取所有模型信息
   */
  getAllModelInfos(): ModelInfo[] {
    return Array.from(this.modelInfos.values());
  }

  /**
   * 根据模型类型获取模型信息（别名方法）
   */
  getModelsByType(modelType: ModelType): ModelInfo[] {
    return Array.from(this.modelInfos.values()).filter(info => info.type === modelType);
  }

  /**
   * 根据模型名称列表获取模型信息
   */
  getModelsByNames(modelNames: string[]): ModelInfo[] {
    return Array.from(this.modelInfos.values()).filter(info => modelNames.includes(info.name));
  }

  /**
   * 根据供应商获取模型信息
   */
  getModelInfosByProvider(provider: string): ModelInfo[] {
    return Array.from(this.modelInfos.values()).filter(info => info.provider === provider);
  }

  /**
   * 根据模型名称获取模型信息
   */
  getModelInfoByName(modelName: string): ModelInfo | undefined {
    return this.modelInfos.get(modelName);
  }

  /**
   * 获取默认模型信息
   * 从所有已注册模型中返回第一个可用模型
   */
  getDefaultModelInfo(): ModelInfo | undefined {
    return this.modelInfos.values().next().value;
  }

  getDefaultModelName(): string {
    return this.getDefaultModelInfo()?.name || this.getAllModelInfos()[0]?.name || ''
  }

  /**
   * 获取支持特定模态的模型信息
   */
  getModelInfosByModality(modality: ModelModality): ModelInfo[] {
    return Array.from(this.modelInfos.values()).filter(info => info.supportedModalities.includes(modality));
  }

  /**
   * 添加新的模型信息
   */
  addModelInfo(modelInfo: ModelInfo): void {
    this.modelInfos.set(modelInfo.name, modelInfo);
  }

  /**
   * 持久化保存自定义模型信息到文件（P4 原子项：宿主支持 renameFile 时 tmp+rename 落盘）
   */
  async saveCustomModel(modelInfo: ModelInfo): Promise<void> {
    if (!this.fileSystemProvider) {
      console.warn('saveCustomModel: fileSystemProvider 未设置，跳过保存');
      return;
    }
    const dir = this.modelsDir;
    if (!dir) {
      throw new Error('saveCustomModel: modelsDir 未设置，请先调用 setModelsDir()');
    }
    const filePath = path.join(dir, `${modelInfo.name}.json`);
    // 落盘剔除内存投影名：「身份 · 通道短名」由 applyMultiBindingDisplayNames 每次加载幂等重推，
    // 是派生显示而非用户数据——固化进磁盘会在身份退化为单绑定（拼装不再重推）时造成显示漂移；
    // modify 等写入口传入的内存卡可能已带投影名，此处统一剥离（displayName 为 undefined 时 JSON.stringify 自动省略该字段）
    const projectedName = composeBindingDisplayName(resolveApiModelId(modelInfo), resolveCredentialId(modelInfo), modelInfo.provider);
    const toPersist = modelInfo.displayName === projectedName ? { ...modelInfo, displayName: undefined } : modelInfo;
    const content = JSON.stringify(toPersist, null, 2);
    const renameFile = (this.fileSystemProvider as { renameFile?: (from: string, to: string) => Promise<FileSystemResult> }).renameFile;
    let result;
    if (typeof renameFile === 'function') {
      const tmpPath = `${filePath}.tmp`;
      result = await this.fileSystemProvider.writeFile(tmpPath, content);
      if (result.success) {
        result = await renameFile.call(this.fileSystemProvider, tmpPath, filePath);
        if (!result.success) {
          try { await this.fileSystemProvider.deleteFile(tmpPath); } catch { /* 清理尽力而为 */ }
        }
      }
    } else {
      // 宿主未实现 renameFile：退化为直接写（正确性由 P4 失败补偿兜底）
      result = await this.fileSystemProvider.writeFile(filePath, content);
    }
    if (!result.success) {
      console.error(`保存自定义模型 ${modelInfo.name} 失败: ${result.error}`);
      // V4：落盘失败必须上抛——调用方回滚内存注册，禁止假成功
      throw new Error(`保存自定义模型 ${modelInfo.name} 失败: ${result.error}`);
    }
  }

  async deleteCustomModelFile(modelName: string): Promise<void> {
    if (!this.fileSystemProvider) {
      console.warn('deleteCustomModelFile: fileSystemProvider 未设置，跳过删除');
      return;
    }
    const dir = this.modelsDir;
    if (!dir) {
      throw new Error('deleteCustomModelFile: modelsDir 未设置，请先调用 setModelsDir()');
    }
    const filePath = path.join(dir, `${modelName}.json`);
    try {
      await this.fileSystemProvider.deleteFile(filePath);
    } catch (error) {
      console.error(`删除自定义模型文件 ${modelName} 失败:`, error);
    }
  }

  /**
   * 统一加载全部模型：出厂种子（随包只读，不落盘）→ 墓碑过滤 → 内置文件迁移 → 磁盘自定义 → Key 迁移
   */
  async loadAllModels(): Promise<void> {
    // 出厂层：无条件以种子初始化（版本演进即时生效）。
    // 先清空再重建：种子移除（退役阶段二）后旧卡不得在内存残留——
    // 已物化的卡由下方磁盘用户层重新加载，未物化的干净消失
    this.modelInfos.clear();
    this.initializeModelInfos();

    // 出厂卡改名/退役的引用迁移（须在墓碑过滤之前：墓碑里的旧名要先改写为新名称）
    await this.migrateRenamedSeedModelRefs();

    // 墓碑过滤：用户删除过的出厂卡不进入合并视图（无 kv 注入时无墓碑，出厂层全显示）
    for (const name of this.getDeletedSeedModels()) {
      this.modelInfos.delete(name);
    }

    if (!this.fileSystemProvider) {
      console.warn('loadAllModels: fileSystemProvider 未设置，仅加载内置模型');
      return;
    }
    const dir = this.modelsDir;
    if (!dir) {
      throw new Error('loadAllModels: modelsDir 未设置，请先调用 setModelsDir()');
    }

    // 内置文件迁移（幂等）：清理旧版本播种的内置模型磁盘快照与内容一致的影子文件
    await this.migrateBuiltInFiles(dir);

    // 出厂层快照（用户层加载前）：供同名用户卡刷新种子元数据（见 refreshSeedMetadata）
    const seedSnapshot = new Map(this.modelInfos);

    // 从磁盘加载用户层：builtIn:false；同名时用户层赢（覆盖出厂卡）
    try {
      const entries = await this.listModelJsonFiles(dir);
      for (const entry of entries) {
        const modelInfo = await this.readModelJson(dir, entry.name);
        if (!modelInfo || modelInfo.builtIn === true) continue;
        refreshSeedMetadata(modelInfo, findSeedMetadataSource(seedSnapshot, modelInfo));
        this.addModelInfo(modelInfo);
      }
    } catch (e) {
      console.error('加载模型文件失败:', e);
    }

    // 同身份多绑定显示名拼装（「身份 · 通道短名」，内存投影不回写磁盘）
    applyMultiBindingDisplayNames(Array.from(this.modelInfos.values()));

    // 迁移旧 Key：按 ModelType 存储的旧 Key 迁移到按 provider 名称存储
    await this.migrateKeys();

    // 退役阶段一物化移交：仍被选中键引用的 deprecated 出厂卡落盘为用户副本（幂等）
    await this.materializeDeprecatedSelectedModels();
  }

  /** 物化移交判定时扫描的 state.json 选中键（字符串值，单个模型名） */
  private static readonly DEPRECATED_HANDOFF_STRING_KEYS = [
    'current-model-name',      // SelectedModelsService 当前对话模型
    'defaultEvaluatorModel',   // 目标模式评估器模型
    'defaultImageModel',       // 生图默认模型
    'defaultVideoModel',       // 生视频默认模型
    'defaultAudioModel',       // 生音频默认模型
  ];

  /**
   * 退役阶段一物化移交（loadAllModels 末尾执行，幂等）：
   * 遍历 state.json 选中键集合（字符串键 + selected-models 数组 + model-parameters 的 modelName），
   * 若引用的名字命中 deprecated 出厂卡，把内存中已折叠的完整副本置 builtIn:false
   * 物化落盘（saveCustomModel 路径）——移交用户，此后不再随出厂更新/移除。
   * 跳过条件天然成立：墓碑名单里的卡不在内存视图；磁盘已有同名用户文件时
   * 内存条目已是用户卡（builtIn:false，用户层赢）。
   */
  /** 出厂卡改名映射（旧注册名 → 新注册名）；新增一条即迁移一轮引用 */
  private static readonly SEED_MODEL_RENAMES: Record<string, string> = {
    'deepseek-v4-flash': 'deepseek-flash',
  };

  /** 出厂卡退役映射（已下线卡名 → 承接其请求的新卡名）；其墓碑条目迁移时直接丢弃 */
  private static readonly SEED_MODEL_RETIRED: Record<string, string> = {
    'deepseek-v4-pro': 'deepseek-flash',
  };

  /**
   * 出厂卡改名/退役的引用迁移（loadAllModels 早期执行，幂等，仅用 kv）。
   *
   * 背景：注册名（ModelInfo.name）是 state.json 中所有模型引用的外键。出厂卡改名
   * （deepseek-v4-flash → deepseek-flash）或退役（deepseek-v4-pro 被官方下线、请求
   * 由新卡承接）后，既有引用必须同步改写，否则会「模型未注册」或留下失效条目。
   *
   * 规则：
   * - 引用键（复用 DEPRECATED_HANDOFF_STRING_KEYS + selected-models + model-parameters）：
   *   旧名 → 新名；数组保序去重，同名参数项合并保留首项
   * - 墓碑 deletedSeedModels：改名跟着改（用户删过的卡位继续隐藏，不改动既有选择）；
   *   退役直接丢弃条目（卡已不存在，改写成新名会误隐藏新卡）
   * - 仅在有变化时写回；异常只告警不抛出（迁移失败不应阻断启动）
   */
  private async migrateRenamedSeedModelRefs(): Promise<void> {
    if (!this.keyValueStore) return;
    const map: Record<string, string> = {
      ...ModelInfoService.SEED_MODEL_RENAMES,
      ...ModelInfoService.SEED_MODEL_RETIRED,
    };
    if (Object.keys(map).length === 0) return;

    const log: string[] = [];
    const rewrite = (name: string): string => map[name] ?? name;

    // ① 字符串引用键（当前模型 / 评估器模型 / 各生成模态默认模型）
    for (const key of ModelInfoService.DEPRECATED_HANDOFF_STRING_KEYS) {
      try {
        const v = this.keyValueStore.getItem(key);
        if (!v) continue;
        const next = rewrite(v);
        if (next !== v) {
          this.keyValueStore.setItem(key, next);
          log.push(`${key}: ${v} → ${next}`);
        }
      } catch (e) {
        console.warn(`模型引用迁移：${key} 处理失败（忽略继续）:`, e);
      }
    }

    // ② selected-models：JSON 字符串数组，逐项改写 + 保序去重
    try {
      const raw = this.keyValueStore.getItem('selected-models');
      if (raw) {
        const arr: unknown = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const seen = new Set<string>();
          const next: string[] = [];
          for (const n of arr) {
            if (typeof n !== 'string') continue;
            const r = rewrite(n);
            if (!seen.has(r)) { seen.add(r); next.push(r); }
          }
          const before = JSON.stringify(arr.filter((n: unknown) => typeof n === 'string'));
          const after = JSON.stringify(next);
          if (after !== before) {
            this.keyValueStore.setItem('selected-models', after);
            log.push('selected-models 引用已改写');
          }
        }
      }
    } catch (e) {
      console.warn('模型引用迁移：selected-models 处理失败（忽略继续）:', e);
    }

    // ③ model-parameters：[{ modelName, parameters }]，逐项改写 + 同名合并保留首项
    try {
      const raw = this.keyValueStore.getItem('model-parameters');
      if (raw) {
        const arr: unknown = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const seen = new Set<string>();
          const next: Record<string, unknown>[] = [];
          let changed = false;
          for (const item of arr as Array<Record<string, unknown>>) {
            if (!item || typeof item.modelName !== 'string') continue;
            const r = rewrite(item.modelName);
            if (r !== item.modelName) changed = true;
            if (seen.has(r)) { changed = true; continue; }
            seen.add(r);
            next.push(r === item.modelName ? item : { ...item, modelName: r });
          }
          if (changed) {
            this.keyValueStore.setItem('model-parameters', JSON.stringify(next));
            log.push('model-parameters 引用已改写');
          }
        }
      }
    } catch (e) {
      console.warn('模型引用迁移：model-parameters 处理失败（忽略继续）:', e);
    }

    // ④ 墓碑名单：改名跟着改；退役条目丢弃
    try {
      const deleted = this.getDeletedSeedModels();
      if (deleted.length > 0) {
        const renamed = deleted
          .filter(n => !(n in ModelInfoService.SEED_MODEL_RETIRED))
          .map(n => rewrite(n));
        const dedup = Array.from(new Set(renamed));
        if (JSON.stringify(dedup) !== JSON.stringify(deleted)) {
          this.keyValueStore.setItem(DELETED_SEED_MODELS_KEY, JSON.stringify(dedup));
          log.push('deletedSeedModels 墓碑已迁移');
        }
      }
    } catch (e) {
      console.warn('模型引用迁移：墓碑名单处理失败（忽略继续）:', e);
    }

    if (log.length > 0) {
      console.log(`[模型] 已迁移出厂模型引用：${log.join('；')}`);
    }
  }

  private async materializeDeprecatedSelectedModels(): Promise<void> {
    if (!this.keyValueStore) return;
    const referenced = new Set<string>();
    for (const key of ModelInfoService.DEPRECATED_HANDOFF_STRING_KEYS) {
      try {
        const v = this.keyValueStore.getItem(key);
        if (v) referenced.add(v);
      } catch { /* 单键读取失败不阻塞其余键 */ }
    }
    // selected-models：JSON 字符串数组（UI 模型管理页的切换集）
    try {
      const raw = this.keyValueStore.getItem('selected-models');
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        for (const n of arr) if (typeof n === 'string') referenced.add(n);
      }
    } catch { /* 解析失败按无引用处理 */ }
    // model-parameters：JSON 数组 [{ modelName, parameters }]
    try {
      const raw = this.keyValueStore.getItem('model-parameters');
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        for (const s of arr) if (s && typeof s.modelName === 'string') referenced.add(s.modelName);
      }
    } catch { /* 解析失败按无引用处理 */ }

    for (const name of referenced) {
      const card = this.modelInfos.get(name);
      if (!card || !card.deprecated || !card.builtIn) continue;
      const copy: ModelInfo = { ...card, builtIn: false };
      try {
        await this.saveCustomModel(copy);
        this.modelInfos.set(name, copy);
        console.warn(`出厂模型 ${name} 已标记退役（deprecated），仍被选中配置引用：已物化移交用户（${name}.json），此后不再随出厂更新`);
      } catch (e) {
        console.error(`deprecated 出厂卡物化移交失败（${name}）:`, e);
      }
    }
  }

  /**
   * 从磁盘重新加载（外部修改 models 目录后热更新内存，无需重启）
   * 重建规则与 loadAllModels 一致：出厂种子 + 墓碑过滤 + 磁盘用户层（同名时用户层赢）
   */
  async reloadFromDisk(): Promise<void> {
    if (!this.fileSystemProvider || !this.modelsDir) return;
    const dir = this.modelsDir;
    try {
      const deletedSeeds = new Set(this.getDeletedSeedModels());
      const fresh = new Map<string, ModelInfo>();
      for (const model of ModelInfoService.getBuiltInSeedModels()) {
        if (!deletedSeeds.has(model.name)) {
          fresh.set(model.name, model);
        }
      }
      const entries = await this.listModelJsonFiles(dir);
      for (const entry of entries) {
        const modelInfo = await this.readModelJson(dir, entry.name);
        if (!modelInfo || modelInfo.builtIn === true) continue;
        const existing = fresh.get(modelInfo.name);
        refreshSeedMetadata(modelInfo, existing?.builtIn ? existing : findSeedMetadataSource(fresh, modelInfo));
        fresh.set(modelInfo.name, modelInfo);
      }
      // 同身份多绑定显示名拼装（同 loadAllModels，内存投影）
      applyMultiBindingDisplayNames(Array.from(fresh.values()));
      // 种子保底，fresh 永不为空（旧实现"目录空则保留旧内存"的守卫已无必要）
      this.modelInfos = fresh;
    } catch (e) {
      console.error('重新加载模型文件失败:', e);
    }
  }

  /**
   * 迁移按 ModelType 存储的旧 API Key 到按 provider 名称存储
   * 仅当新 Key 不存在时才迁移，避免覆盖
   */
  private async migrateKeys(): Promise<void> {
    if (!this.secureStorage) return;

    // 从种子数据构建 oldKey → providerName 映射
    const typeToProvider: Record<string, string> = {};
    const seedModels = ModelInfoService.getBuiltInSeedModels();
    for (const m of seedModels) {
      if (!typeToProvider[m.type]) {
        typeToProvider[m.type] = m.provider;
      }
    }

    for (const [oldKey, providerName] of Object.entries(typeToProvider)) {
      try {
        // 大小写不同的同名 Key（如 "deepseek" vs "DeepSeek"），
        // 在 Windows 不区分大小写的文件系统上是同一个文件，跳过迁移
        if (oldKey.toLowerCase() === providerName.toLowerCase()) {
          continue;
        }

        // 统一落到稳定 id 命名空间（如 智谱AI → zhipu）
        const providerId = providerManager.resolveId(providerName);

        const oldKeyExists = await this.secureStorage.hasApiKey(oldKey);
        if (!oldKeyExists) continue;

        const newKeyExists = await this.secureStorage.hasApiKey(providerId);
        if (newKeyExists) {
          await this.secureStorage.deleteApiKey(oldKey);
          continue;
        }

        // 将旧 Key 迁移到新位置
        const keyValue = await this.secureStorage.getApiKey(oldKey);
        if (keyValue) {
          await this.secureStorage.storeApiKey(providerId, keyValue);
          await this.secureStorage.deleteApiKey(oldKey);
        }
      } catch {
        // 忽略迁移失败
      }
    }
  }

  /**
   * 更新模型信息
   */
  updateModelInfo(modelName: string, updatedInfo: Partial<ModelInfo>): boolean {
    const modelInfo = this.modelInfos.get(modelName);
    if (!modelInfo) {
      return false;
    }
    Object.assign(modelInfo, updatedInfo);
    return true;
  }

  /**
   * 删除模型信息
   */
  removeModelInfo(modelName: string): boolean {
    return this.modelInfos.delete(modelName);
  }

  /**
   * 清除所有模型信息
   */
  clearAllModelInfos(): void {
    this.modelInfos.clear();
  }

  /**
   * 重新初始化模型信息
   */
  reinitializeModelInfos(): void {
    this.clearAllModelInfos();
    this.initializeModelInfos();
  }

  /**
   * 获取所有已配置 API Key 的模型
   * @returns Promise<ModelInfo[]> 已配置 API Key 的模型列表
   */
  async getModelsWithApiKeys(): Promise<ModelInfo[]> {
    const allModels = this.getAllModelInfos();
    const modelsWithApiKeys: ModelInfo[] = [];

    for (const model of allModels) {
      const hasApiKey = await this.secureStorage?.hasApiKey(resolveCredentialId(model)) ?? false;
      if (hasApiKey) {
        modelsWithApiKeys.push(model);
      }
    }

    return modelsWithApiKeys;
  }

  /**
   * 获取所有模型及其 API Key 配置状态
   * @returns Promise<Array<{model: ModelInfo, hasApiKey: boolean}>> 所有模型列表，包含 API Key 状态
   */
  async getAllModelsWithApiKeyStatus(): Promise<Array<{ model: ModelInfo; hasApiKey: boolean }>> {
    const allModels = this.getAllModelInfos();
    const result: Array<{ model: ModelInfo; hasApiKey: boolean }> = [];

    for (const model of allModels) {
      const hasApiKey = await this.secureStorage?.hasApiKey(resolveCredentialId(model)) ?? false;
      result.push({ model, hasApiKey });
    }

    return result;
  }
}

// 导出服务实例
export const modelInfoService = ModelInfoService.getInstance();

/**
 * 身份级种子元数据源查找（refreshSeedMetadata 先例推广）：
 * 同名种子优先，其次同身份（provider × 上游 ID）种子——同身份多绑定的每张绑定卡
 * 内嵌同一份能力快照，加载时从目录（种子）单一来源刷新。
 */
function findSeedMetadataSource(seeds: Map<string, ModelInfo>, userCard: ModelInfo): ModelInfo | undefined {
  const byName = seeds.get(userCard.name);
  if (byName?.builtIn) return byName;
  const key = identityKeyOf(userCard);
  for (const seed of seeds.values()) {
    if (seed.builtIn && identityKeyOf(seed) === key) return seed;
  }
  return undefined;
}

/**
 * 同名/同身份用户卡的种子元数据刷新（loadAllModels/reloadFromDisk 用户层加载时调用）：
 * - supportedParameters 是纯种子快照（add_model/modify_model 均不接受该字段，用户无编写入口），
 *   同名/同身份时以当前种子整体刷新——否则物化副本冻结旧声明（实例：GLM-5.3 旧副本的陈旧 thinking
 *   声明会让弹窗复活已退役的开关、压缩降档误发 disabled 踩 400）。
 * - adapterConfig.unsupportedParams 用户可经 modify_model 编写，不能整体替换：按并集合并
 *   （用户与种子的意图都是剥除，合并无冲突）。
 * 纯内存刷新、不回写磁盘（每次加载幂等重推导）。seed 非 builtIn 或缺省时不动作。
 */
export function refreshSeedMetadata(userCard: ModelInfo, seed?: ModelInfo): void {
  if (!seed?.builtIn) return;
  userCard.supportedParameters = seed.supportedParameters ?? [];
  const seedStrip = seed.adapterConfig?.unsupportedParams;
  if (seedStrip?.length) {
    const prev = userCard.adapterConfig;
    const seedAc = seed.adapterConfig;
    const merged = [...new Set([...(prev?.unsupportedParams ?? []), ...seedStrip])];
    userCard.adapterConfig = {
      protocol: prev?.protocol ?? seedAc?.protocol ?? 'openai-chat',
      baseURL: prev?.baseURL ?? seedAc?.baseURL ?? '',
      // 请求字段只装上游 ID（V6）：不得回退本地注册名
      defaultModel: prev?.defaultModel ?? seedAc?.defaultModel ?? resolveApiModelId(userCard),
      defaultMaxTokens: prev?.defaultMaxTokens ?? seedAc?.defaultMaxTokens,
      defaultTemperature: prev?.defaultTemperature ?? seedAc?.defaultTemperature,
      headers: prev?.headers,
      extraBodyParams: prev?.extraBodyParams,
      fixedParams: prev?.fixedParams,
      unsupportedParams: merged,
    };
  }
}

/**
 * 首个支持视觉的已注册 chat 模型名（桌面能力文案的动态推荐：
 * 系统提示、capture_screen 视觉守卫报错、/desktop 开启提示共用）。
 * 跳过 deprecated 退役卡（自动/默认路径原则）；一个都没有时返回 undefined，
 * 调用方文案退化为不点名（"请切换到支持视觉的模型"）。
 */
export function getRecommendedVisionModelName(): string | undefined {
  const model = ModelInfoService.getInstance().getAllModelInfos().find(
    info => !info.deprecated
      && deriveModelKind(info.adapterConfig?.protocol) === 'chat'
      && info.supportedModalities?.includes(ModelModality.IMAGE)
  );
  return model?.name;
}

/**
 * 取提供商的注册/文档链接（单一事实源 = catalog/providerProfiles.ts 的 docUrl 字段）。
 * 非种子提供商（用户自定义）返回 undefined，
 * 调用方自行决定不显示链接行（不引入空占位状态）。
 * 首跑向导与 /key list 的"获取 API Key"行共用；提供商端点模板同理由厂商预设派生
 * （见下方 getProviderEndpointTemplate）。
 */
export function getProviderDocUrl(providerName: string): string | undefined {
  return getProviderProfileByName(providerName)?.docUrl;
}

/**
 * 取提供商的端点模板（单一事实源 = catalog/providerProfiles.ts 的 endpoint 字段；
 * 厂商端点只存在于厂商预设中，不再从种子卡反向派生）。
 * add_model 未显式给 base_url/protocol 时由此派生默认值；
 * 非种子提供商返回 undefined，调用方要求用户显式提供。
 */
export function getProviderEndpointTemplate(providerName: string): { baseURL: string; protocol: string } | undefined {
  const endpoint = getProviderProfileByName(providerName)?.endpoint;
  return endpoint ? { baseURL: endpoint.baseURL, protocol: endpoint.protocol } : undefined;
}