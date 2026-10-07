/**
 * commandCatalog 测试（命令目录消费纯逻辑——裁决卡召唤入口的显隐/拦截判据）：
 * - findCatalogCommand：目录有才显示（npm 模式/未同步自然零渲染）
 * - resolveSlashCommand：白名单（仅 /improve）+ 目录双门；不命中按普通消息发送
 */
import type { CommandCatalogEntry } from '../src/relay/envelope';
import { findCatalogCommand, resolveSlashCommand } from '../src/screens/commandCatalog';

function entry(id: string): CommandCatalogEntry {
  return { id, title: id, section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast' };
}

describe('findCatalogCommand', () => {
  it('目录有才命中', () => {
    const catalog = [entry('idea'), entry('improve')];
    expect(findCatalogCommand(catalog, 'improve')).toEqual(entry('improve'));
  });

  it('目录无 → undefined（入口不渲染/不发送）', () => {
    expect(findCatalogCommand([entry('idea')], 'improve')).toBeUndefined();
  });

  it('目录未同步（null/undefined）→ undefined', () => {
    expect(findCatalogCommand(null, 'improve')).toBeUndefined();
    expect(findCatalogCommand(undefined, 'improve')).toBeUndefined();
  });
});

describe('resolveSlashCommand', () => {
  const catalog = [entry('improve')];

  it('"/improve" 且目录有 → 拦截为命令', () => {
    expect(resolveSlashCommand('/improve', catalog)).toBe('improve');
  });

  it('大小写与首尾空白容忍', () => {
    expect(resolveSlashCommand('  /Improve ', catalog)).toBe('improve');
  });

  it('目录无 improve → null（按普通消息发送，不假执行）', () => {
    expect(resolveSlashCommand('/improve', [entry('idea')])).toBeNull();
    expect(resolveSlashCommand('/improve', null)).toBeNull();
  });

  it('非斜杠/白名单外/带参数 → null', () => {
    expect(resolveSlashCommand('improve', catalog)).toBeNull();
    expect(resolveSlashCommand('/stop', catalog)).toBeNull(); // 白名单外（目录有也不拦截）
    expect(resolveSlashCommand('/improve now', catalog)).toBeNull(); // 白名单精确匹配，不带参数形态
  });
});
