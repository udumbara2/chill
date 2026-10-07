/**
 * versionGate.ts — 降级闸的版本解析/比对（纯函数，入 jest）。
 *
 * 第一性定案 3（降级闸）：user_version 迁移只升不降，旧代码盖回新版=数据风险面。
 * 解析纪律：**只认 `m<yyyyMMdd-HHmmss>` 时间戳形**快照号——`m6-baseline` 等自定义名
 * 快照真实存在（基线就是），一律视为"未知"（verdict='unknown' → 走自动流，身份闸不依赖它）。
 */

export type VersionVerdict = 'newer' | 'same' | 'older' | 'unknown';

const TS_STAMP = /^m(\d{8})-(\d{6})$/;

/** 快照号 → 可字典序比较的 `yyyyMMdd-HHmmss`；非时间戳形/空 → null */
export function parseSnapshotStamp(s: string | null | undefined): string | null {
  const m = TS_STAMP.exec(String(s ?? ''));
  return m ? `${m[1]}-${m[2]}` : null;
}

/** URL 文件名提取快照号：`app-<snapshotId>.apk` → snapshotId（其余 → null） */
export function extractSnapshotFromUrl(rawUrl: string): string | null {
  let name: string;
  try {
    name = new URL(String(rawUrl)).pathname.split('/').pop() ?? '';
  } catch {
    return null;
  }
  const m = /^app-(.+)\.apk$/i.exec(name);
  return m ? m[1] : null;
}

/**
 * 版本比对：目标 vs 当前构建戳。
 * older=目标更旧（降级，须知情确认）；newer/same=自动流；unknown=任一端不可比 → 自动流。
 */
export function compareVersions(
  targetStamp: string | null | undefined,
  currentStamp: string | null | undefined,
): VersionVerdict {
  const t = parseSnapshotStamp(targetStamp);
  const c = parseSnapshotStamp(currentStamp);
  if (!t || !c) return 'unknown';
  if (t > c) return 'newer';
  if (t < c) return 'older';
  return 'same';
}
