/**
 * ContextRing — M8 上下文占用环（18px，与桌面 ContextUsageRing / CLI statusline 同口径）。
 *
 * 三口径（协议冻结的显示语义）：
 * 1. ratio = used/max，超 80%（自动压缩阈值）转琥珀 #eab308；
 * 2. 无数据（ctx=null：新会话/服务未回 usage/压缩后无估值）整体不渲染——不显示错误数字；
 * 3. approx（压缩后估值空窗）由调用方文案加"约"前缀。
 *
 * 实现：纯 RN 无 svg 依赖。几何要素（三者缺一即错位，见文件末尾"修复实录"）：
 * - 半环元素是「宽=R、高=2R、右上/右下圆角=R」的半圆盘（半径=元素宽 → 恰好半圆，无直边）；
 * - 半环元素不自己旋转，而是放进「尺寸 2R×2R、中心恰在环心」的 rotor 再由 rotor 旋转
 *   —— RN 的 rotate 轴是元素自身中心，直接转宽 R 的半环会绕错轴心；
 * - 左右各一个「宽 R、高 2R、overflow:hidden」的固定裁剪区，可见弧 = 旋转后的半环 ∩ 裁剪区；
 *   两个裁剪区里放的是**同一种形状**（覆盖 12→6 点的右半环），左半靠 rotate ψ 把它转进左半区。
 * 角度：θ = min(ratio,0.5)*360（右半），ψ = max(ratio-0.5,0)*360（左半）；
 * rotor 角度分别取 θ-180 与 ψ，使可见弧恒为「12 点起顺时针 ratio*360°」。
 * 数据源 cmd.state.ctx（桌面唯一真相，本地不推算）。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CommandStateSnapshot } from '../relay/envelope';

const SIZE = 18;
const THICK = 2.5;
const R = SIZE / 2; // 环半径（圆角半径 / 半环元素宽）
const COLOR_OK = '#3b82f6';
const COLOR_WARN = '#eab308';
const TRACK = '#374151';

/** token 数格式化（与桌面 fmt 同式：k 取整、M 一位小数） */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function ctxRatio(ctx: CommandStateSnapshot['ctx']): number | null {
  if (!ctx || !ctx.max) return null;
  return Math.min(1, ctx.used / ctx.max);
}

function Ring({ ratio, color }: { ratio: number; color: string }) {
  /** 右半区应显示的角度：0~50% 占用 → 0~180° */
  const theta = Math.min(ratio, 0.5) * 360;
  /** 左半区应显示的角度：50%~100% 占用 → 0~180°（同样从 6 点起算） */
  const psi = Math.max(ratio - 0.5, 0) * 360;
  return (
    <View style={styles.ring}>
      <View style={styles.track} />
      {/* 右半裁剪区：显示环的右半（12 点→6 点方向） */}
      <View style={styles.clipRight}>
        <View style={[styles.rotor, styles.rotorRight, { transform: [{ rotate: `${theta - 180}deg` }] }]}>
          <View style={[styles.half, { borderColor: color }]} />
        </View>
      </View>
      {/* 左半裁剪区：同一形状，rotate ψ 把弧的头转进左半区（尾部被裁掉） */}
      <View style={styles.clipLeft}>
        <View style={[styles.rotor, styles.rotorLeft, { transform: [{ rotate: `${psi}deg` }] }]}>
          <View style={[styles.half, { borderColor: color }]} />
        </View>
      </View>
    </View>
  );
}

/**
 * 占用环（含可访问标签）。ctx=null 时渲染 null（零状态零渲染）。
 * onPress 可选：点环 → 压缩 sheet（用量详情+确认压缩同位；完整菜单由 ☰ 进入）。
 */
export default function ContextRing({ ctx, onPress }: { ctx: CommandStateSnapshot['ctx'] | null; onPress?: () => void }) {
  const ratio = ctxRatio(ctx);
  if (ratio === null) return null;
  const pct = Math.round(ratio * 100);
  const approx = ctx?.approx === true ? '约 ' : '';
  const label = `上下文 ${approx}${fmtTokens(ctx!.used)} / ${fmtTokens(ctx!.max!)}（${pct}%）${ratio > 0.8 ? '，已超自动压缩阈值，本轮结束将自动压缩' : ''}`;
  const ring = (
    <>
      <Ring ratio={ratio} color={ratio > 0.8 ? COLOR_WARN : COLOR_OK} />
      <Text style={styles.hiddenLabel}>{label}</Text>
    </>
  );
  if (!onPress) return <View style={styles.wrap}>{ring}</View>;
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityLabel={label} style={styles.wrap}>
      {ring}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { width: SIZE + 4, height: SIZE + 4, alignItems: 'center', justifyContent: 'center' },
  /** 容器即环（无外层 rotate：角度语义直接在 12 点起算，裁剪边界保持竖直） */
  ring: { width: SIZE, height: SIZE },
  track: { position: 'absolute', left: 0, top: 0, width: SIZE, height: SIZE, borderRadius: R, borderWidth: THICK, borderColor: TRACK },
  /** 固定裁剪区：各占环的一半（宽 R、高 2R）。overflow hidden 是象限技法的裁剪面 */
  clipRight: { position: 'absolute', left: R, top: 0, width: R, height: SIZE, overflow: 'hidden' },
  clipLeft: { position: 'absolute', left: 0, top: 0, width: R, height: SIZE, overflow: 'hidden' },
  /**
   * rotor：尺寸 2R×2R，其中心（= RN rotate 的轴心）必须落在环心上。
   * 右半区里 rotor 左移 R（中心落到裁剪区左边缘 = 环心）；左半区里 rotor 不偏移（中心 = 裁剪区中心 = 环心）。
   */
  rotor: { position: 'absolute', top: 0, width: SIZE, height: SIZE },
  rotorRight: { left: -R },
  rotorLeft: { left: 0 },
  /**
   * 半环元素：宽 R、高 2R，右上/右下圆角 R（半径 = 元素宽 → 恰好半圆盘，无直边）。
   * 放在 rotor 的右半（left:R），其圆心 = rotor 中心 = 环心。
   */
  half: {
    position: 'absolute',
    left: R,
    top: 0,
    width: R,
    height: SIZE,
    borderTopWidth: THICK,
    borderRightWidth: THICK,
    borderBottomWidth: THICK,
    borderTopRightRadius: R,
    borderBottomRightRadius: R,
  },
  hiddenLabel: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});

/**
 * 修复实录（2026-09-26，真机重影）：
 * 初版是「18×18 D 形元素（borderTop/Right/Bottom + 右上右下圆角 R）」+ 外层 rotate(-90deg)：
 * - D 形的顶边/底边在自身左半 x∈[0,R] 是**直线段**，未旋转时正好落在裁剪区外看不见，
 *   一旦 rotate ≠ 0 就转进可见区 → 多出一段与主弧错开的弧（真机截图实测：蓝弧半径 12.6 > 环外径 9、
 *   弧长与 ratio 几乎无关、且分成两段）；
 * - 外层 -90° 把裁剪边界转成水平线，弧被齐刷刷切在环心水平线上。
 * 修正即本文件的三要素：半圆盘（无直边）+ rotor（轴心=环心）+ 无外层旋转。
 * 几何正确性用「同一样式翻译成 CSS 后离屏渲染 + 像素测量」逐比例验证过（0.12/0.25/0.5/0.75/0.9
 * 弧长误差 ≤10°，半径 6.4~9.1 全在环带内），再上真机确认。
 */
