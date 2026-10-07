/**
 * commandCatalog.ts — 命令目录消费纯逻辑（无 React，jest 可单测）：
 * - findCatalogCommand：入口显隐唯一判据——目录有才显示（npm 模式目录无此行自然零渲染，
 *   "入口不存在而非禁用"，对齐 core commandSurface 目录驱动先例）
 * - resolveSlashCommand：斜杠命令拦截（白名单制，目前仅 /improve 裁决卡召唤）——
 *   命中白名单且目录有才拦截为 cmd.request；否则返回 null 按普通消息发送
 *   （目录无该命令时斜杠文本原样进聊天，诚实降级不假执行）。
 */
import type { CommandCatalogEntry } from '../relay/envelope';

/** 手机端斜杠命令白名单（仅裁决卡召唤；新增斜杠命令须先在此登记） */
const SLASH_COMMANDS = new Set(['improve']);

/** 目录查找（null=未同步按无目录处理） */
export function findCatalogCommand(
  catalog: CommandCatalogEntry[] | null | undefined,
  id: string,
): CommandCatalogEntry | undefined {
  return (catalog ?? []).find((c) => c.id === id);
}

/** 斜杠命令解析："/improve"（忽略大小写与首尾空白）命中白名单且目录含该命令 → 命令 id；否则 null */
export function resolveSlashCommand(
  text: string,
  catalog: CommandCatalogEntry[] | null | undefined,
): string | null {
  const t = text.trim().toLowerCase();
  if (!t.startsWith('/')) return null;
  const id = t.slice(1);
  if (!SLASH_COMMANDS.has(id)) return null;
  return findCatalogCommand(catalog, id) ? id : null;
}
