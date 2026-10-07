/**
 * 键名规范化（computer_use 的 key 动作 → 原生层 combo 字符串）。
 * 模型输出的键名大小写/别名五花八门（CTRL/Control/ctrl、cmd/win/super、return/enter），
 * 在 core 统一归一后再交给 Rust 层；无法识别的键名明确抛错，而不是静默忽略
 * （静默忽略会让模型以为按键已生效，是坐标之外的另一类隐蔽失败源）。
 * 输出约定：小写、修饰键在前（ctrl/alt/shift/win 固定序）、'+' 连接，如 "ctrl+s"。
 */

/** 修饰键别名 → 规范名 */
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  win: 'win',
  cmd: 'win',
  command: 'win',
  super: 'win',
  meta: 'win',
}

/** 特殊键别名 → 规范名 */
const KEY_ALIASES: Record<string, string> = {
  enter: 'enter',
  return: 'enter',
  escape: 'escape',
  esc: 'escape',
  space: 'space',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  insert: 'insert',
  ins: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  capslock: 'capslock',
  numlock: 'numlock',
  scrolllock: 'scrolllock',
  printscreen: 'printscreen',
  pause: 'pause',
  menu: 'menu',
}

/** 修饰键输出固定序 */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'win']

/**
 * 规范化组合键字符串："CTRL+S" / "Control + s" → "ctrl+s"；"cmd+tab" → "win+tab"。
 * 单字符键（a-z/0-9）与 F1-F24 原样（小写）通过；未识别的键名抛错。
 */
export function normalizeKeyCombo(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('键名不能为空')
  }
  const parts = input
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0)
  if (parts.length === 0) {
    throw new Error(`键名不能为空（原始输入: "${input}"）`)
  }

  const normalized = new Set<string>()
  for (const part of parts) {
    const mapped = MODIFIER_ALIASES[part] ?? KEY_ALIASES[part]
    if (mapped) {
      normalized.add(mapped)
      continue
    }
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(part) || /^[a-z0-9]$/.test(part)) {
      normalized.add(part)
      continue
    }
    throw new Error(`未识别的键名: "${part}"（原始输入: "${input}"）`)
  }

  // 修饰键按固定序排前，其余保持输入顺序
  const modifiers = MODIFIER_ORDER.filter((m) => normalized.has(m))
  const keys = [...normalized].filter((k) => !MODIFIER_ORDER.includes(k))
  return [...modifiers, ...keys].join('+')
}
