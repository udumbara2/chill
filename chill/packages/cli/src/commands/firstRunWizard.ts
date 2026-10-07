// 首次使用模型配置向导（bootstrap loader）：裸用户（零 API Key）首启时引过"第一把 Key"。
// 出现时尚无 AI 可托付，必须是哑 UI；职责边界 = 选模型 → 粘 Key → 之后交给对话。
// 零新数据零新机制（每一步都复用既有事实源/写入路径）：
//   列表   = modelInfoService 合并视图（种子内置 ∪ 磁盘自定义）过滤 chat 卡，数据驱动
//   链接   = 种子卡 documentation（core getProviderDocUrl；自定义 provider 无链接则不显示该行）
//   Key    = SecureStorageService.storeApiKey（与 /key set 同一写入路径，按 provider 稳定 id）
//   选中   = SelectedModelsService.saveCurrentModelName（与 /model switch 同一机制）
//   记忆   = state.json kv（firstRunWizard.dismissed；与桌面 UI 端同名互认，key 同源 ~/.chill/keys）
// 输出通道由调用方注入：交互提示直写 stdout（经 startupOut 会被收集当场不显示），
// 最终确认经 printFinal（启动路径传 startupOut 使 TUI 消息区持久渲染；/setup 路径传直写）。

import type * as readline from 'node:readline'
import {
  SecureStorageService,
  modelInfoService,
  providerManager,
  SelectedModelsService,
  deriveModelKind,
  getProviderDocUrl,
} from '@assistant-ai/core'
import { isTuiActive, hasAskPresenter, presentAsk } from '../tui/tuiState.js'

/** 向导所需的最小 kv 结构（CliContext 的 FileKeyValueStore 满足；结构化类型避免壳层耦合） */
export interface WizardKvStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface WizardOptions {
  /** 主 REPL 的 readline 实例（CLI 路径掩码读 Key 复用；见 questionMasked 的保存/恢复契约） */
  rl: readline.Interface
  /** state.json kv（跳过记忆） */
  kv: WizardKvStore
  /** 最终确认输出通道（成功/跳过通知；见文件头注释） */
  printFinal: (text: string) => void
  /** /setup 显式重开：绕过首用检测语义（由调用方控制）；覆盖已有 Key 前先提示 */
  force?: boolean
}

/** 跳过标记键名（与桌面 UI 端 W2 同一字面量，两端记忆互认） */
export const WIZARD_DISMISSED_KEY = 'firstRunWizard.dismissed'

/** 首用检测：没有任何 provider 配置 Key（getAllProviders = 已存 Key 的 id 列表，一次读） */
export async function detectFirstRun(): Promise<boolean> {
  try {
    const configured = await SecureStorageService.getAllProviders()
    return configured.length === 0
  } catch {
    // 检测失败不阻塞启动：按非首用处理（向导是增益不是依赖）
    return false
  }
}

/**
 * 掩码读取一行输入（回显 *）。rl 是主 REPL 的共享实例：必须保存原 _writeToOutput
 * 并在 question 回调内恢复，否则此后整个会话的提示符永远显示星号（必修契约）。
 */
function questionMasked(rl: readline.Interface, prompt: string): Promise<string> {
  const r = rl as unknown as { _writeToOutput: (s: string) => void }
  const original = r._writeToOutput.bind(rl)
  return new Promise((resolve) => {
    r._writeToOutput = (s: string) => {
      if (s.includes(prompt)) original(prompt)
      else if (s === '\r' || s === '\n' || s === '\r\n') original('\n')
      else original('*')
    }
    rl.question(prompt, (answer) => {
      r._writeToOutput = original
      resolve(answer)
    })
  })
}

interface WizardEntry {
  name: string
  displayName: string
  provider: string
  hasApiKey: boolean
}

/** 列表数据：合并视图过滤 chat 卡（生成模型不进向导），deprecated 退役卡同样跳过（自动/默认路径原则；仍可经 /model switch 显式指定），保持 getAllModelsWithApiKeyStatus 顺序（种子在前） */
async function buildEntries(): Promise<WizardEntry[]> {
  const all = await modelInfoService.getAllModelsWithApiKeyStatus()
  return all
    .filter((e) => deriveModelKind(e.model.adapterConfig?.protocol) === 'chat' && !e.model.deprecated)
    .map((e) => ({
      name: e.model.name,
      displayName: e.model.displayName || e.model.name,
      provider: e.model.provider,
      hasApiKey: e.hasApiKey,
    }))
}

/**
 * 模型选择（双路径，镜像 cli.ts handleModel /model list 的既有形态）：
 * - TUI 活跃（/setup 在 TUI 内重开）：经消息区编号选择（rl 暂停中，按键选择器不可用）
 * - 非 TTY（管道/脚本）：按键选择器收不到事件，退化为编号问答（与 TUI 编号同语义）
 * - CLI 裸终端：↑↓ 移动、回车确认、Esc 取消。按键选择器是此处与 handleModel 之间
 *   有意的第二实现（保守隔离回归面）；第三个消费者出现时提取公共 listPicker（rule of three）。
 */
async function pickModel(rl: readline.Interface, entries: WizardEntry[]): Promise<WizardEntry | null> {
  if (isTuiActive() && hasAskPresenter()) {
    const answer = await presentAsk(
      '选择要配置的模型（回车取消）: ',
      entries.map((e, i) => ({
        label: String(i + 1),
        description: `${e.displayName}（${e.provider}）${e.hasApiKey ? '' : '（未配置 Key）'}`,
      })),
      true
    )
    const trimmed = (answer ?? '').trim()
    if (!trimmed) return null
    const idx = Number.parseInt(trimmed, 10)
    if (Number.isNaN(idx) || idx < 1 || idx > entries.length) {
      process.stdout.write('无效的选择\n')
      return null
    }
    return entries[idx - 1]
  }

  if (!process.stdin.isTTY) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const status = e.hasApiKey ? '✓' : '✗'
      process.stdout.write(`  ${status} ${i + 1}. ${e.displayName.padEnd(26)} ${e.provider}\n`)
    }
    const answer = await new Promise<string>((resolve) => {
      rl.question('输入序号选择（回车取消）: ', resolve)
    })
    const trimmed = answer.trim()
    if (!trimmed) return null
    const idx = Number.parseInt(trimmed, 10)
    if (Number.isNaN(idx) || idx < 1 || idx > entries.length) {
      process.stdout.write('无效的选择\n')
      return null
    }
    return entries[idx - 1]
  }

  let selectedIdx = 0
  const totalLines = entries.length + 2
  const renderList = () => {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const cursor = i === selectedIdx ? '►' : ' '
      const status = e.hasApiKey ? '✓' : '✗'
      process.stdout.write(`${cursor} ${status} ${e.displayName.padEnd(26)} ${e.provider}\n`)
    }
    process.stdout.write('↑↓ 选择, 回车确认, Esc 跳过\n')
  }
  const clearList = () => {
    process.stdout.write(`\x1b[${totalLines}A\x1b[J`)
  }
  renderList()

  // 临时接管键盘输入：保存并移除所有 keypress 监听器（含 readline 自身和粘贴处理器），结束恢复
  const savedListeners = process.stdin.listeners('keypress')
  for (const l of savedListeners) {
    process.stdin.removeListener('keypress', l as (...args: any[]) => void)
  }
  try {
    return await new Promise<WizardEntry | null>((resolve) => {
      const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
        if (!key) return
        if (key.name === 'up') {
          selectedIdx = (selectedIdx - 1 + entries.length) % entries.length
          clearList()
          renderList()
        } else if (key.name === 'down') {
          selectedIdx = (selectedIdx + 1) % entries.length
          clearList()
          renderList()
        } else if (key.name === 'return') {
          cleanup()
          clearList()
          resolve(entries[selectedIdx])
        } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          cleanup()
          clearList()
          resolve(null)
        }
      }
      function cleanup() {
        process.stdin.removeListener('keypress', onKeypress)
      }
      process.stdin.on('keypress', onKeypress)
    })
  } finally {
    for (const l of savedListeners) {
      process.stdin.on('keypress', l as (...args: any[]) => void)
    }
  }
}

/** Key 收集双通道：TUI 走 presentAsk 自由文本（TUI 拥有输入权，掩码 readline 不可用，与 /key set 同观感）；CLI 走掩码 */
async function askApiKey(rl: readline.Interface, entry: WizardEntry): Promise<string> {
  if (isTuiActive() && hasAskPresenter()) {
    const answer = await presentAsk(`请粘贴 ${entry.displayName}（${entry.provider}）的 API Key（留空取消）: `, undefined, true)
    return (answer ?? '').trim()
  }
  return questionMasked(rl, '  → 请粘贴 API Key（回车确认，留空取消）: ')
}

/**
 * 运行向导。返回：
 * - configured：选卡 + 存 Key + 设为当前模型成功
 * - dismissed：Esc / 空 Key 取消（已写跳过标记）
 * - failed：保存失败（未写跳过标记，下次启动仍会触发）
 * - unavailable：无 chat 卡可配（零副作用）
 */
export async function runFirstRunWizard(opts: WizardOptions): Promise<'configured' | 'dismissed' | 'failed' | 'unavailable'> {
  const entries = await buildEntries()
  if (entries.length === 0) {
    opts.printFinal('未发现可配置的对话模型，跳过首次配置。\n')
    return 'unavailable'
  }

  process.stdout.write('\n┌ 首次使用 · 选一个模型开始\n')
  process.stdout.write('  （✓ 已配置 Key  ✗ 未配置）\n')
  const picked = await pickModel(opts.rl, entries)

  if (!picked) {
    opts.kv.setItem(WIZARD_DISMISSED_KEY, 'true')
    opts.printFinal('已跳过首次配置。稍后可输入 /setup 重新配置，或 /key set <供应商> <Key> 直接添加。\n')
    return 'dismissed'
  }

  process.stdout.write(`  → 已选 ${picked.displayName}（${picked.provider}）\n`)
  const docUrl = getProviderDocUrl(picked.provider)
  if (docUrl) {
    process.stdout.write(`  → 获取 API Key: ${docUrl}\n`)
  }

  const key = (await askApiKey(opts.rl, picked)).trim()
  if (!key) {
    opts.kv.setItem(WIZARD_DISMISSED_KEY, 'true')
    opts.printFinal('已跳过首次配置。稍后可输入 /setup 重新配置。\n')
    return 'dismissed'
  }

  // 统一落稳定 id（与 /key set 同一入口；未知 provider 走 slug）
  const providerId = providerManager.idFor(picked.provider)
  if (opts.force && await SecureStorageService.hasApiKey(providerId)) {
    process.stdout.write('  ⚠ 该供应商已有 Key，将覆盖。\n')
  }

  const ok = await SecureStorageService.storeApiKey(providerId, key)
  if (!ok) {
    opts.printFinal('✗ API Key 保存失败，稍后可输入 /setup 重试。\n')
    return 'failed'
  }
  SelectedModelsService.getInstance().saveCurrentModelName(picked.name)
  opts.printFinal(`✓ 已配置 ${picked.displayName}，开始对话吧。需要其他模型可直接告诉我，/model switch 换模型、/key set 换 Key。\n`)
  return 'configured'
}
