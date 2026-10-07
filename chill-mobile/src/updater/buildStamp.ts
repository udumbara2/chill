/**
 * buildStamp.ts — 构建戳（降级闸数据源；第一性定案 3）。
 *
 * 活树常驻占位 'unknown'——保证 Metro/tsc/jest 均可解析、开发内环不断。
 * mobile-push.js apk 在构建场构建前**覆盖**本文件为真实快照戳（活树零污染）。
 * 占位/未知值在版本比对中视为"未知"→ 走自动流（身份闸不依赖它）。
 */
export const BUILD_STAMP = 'unknown';
