/**
 * hostToggleUi.ts — 宿主级开关行的纯逻辑（��� React，jest 可单测）。
 * 值映射与徽标显隐的唯一事实点：undefined = 桌面未装配读口/未知（"未同步"），严格区别于已关（"关"）。
 * 数据源：cmd.state 快照的宿主级标量（CommandStateSnapshot.desktop / autoswitch，v=1 additive）。
 */
import type { CommandStateSnapshot } from '../relay/envelope';

/** 开关行值文案：undefined→未同步（旧桌面/快照未达）；true/false→开/关（cmd.state 落定，不本地假落定） */
export function hostToggleValue(v: boolean | undefined): string {
  return v === undefined ? '未同步' : v ? '开' : '关';
}

/** 桌面能力常驻徽标显隐：仅明确开启时显示（安全感知——用户应随时一眼确认助手能否操作电脑屏幕） */
export function desktopBadgeVisible(state: CommandStateSnapshot | null | undefined): boolean {
  return state?.desktop === true;
}

/** 点按目标态：未知（undefined）时点按视为开（旧桌面已被目录门控挡住，能点到即新桌面；仅明确为开才关） */
export function hostToggleNext(cur: boolean | undefined): boolean {
  return cur !== true;
}
