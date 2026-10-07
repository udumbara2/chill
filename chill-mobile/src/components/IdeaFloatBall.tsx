/**
 * IdeaFloatBall.tsx — 闪念悬浮球（App 级 · AssistiveTouch 模式）
 *
 * 全局唯一可拖动入口：单击=打开记点子面板（App 根级 IdeaCaptureSheet）；
 * 长按（500ms，RN delayLongPress 默认值）=召唤提案裁决卡（onLongPress 可选注入；
 * 未注入=长按无效果——目录无 improve 的诚实降级，不落回 idea）；
 * 拖动=调整位置（跟手移动，松手吸附最近左右边缘——AssistiveTouch 同款语义）；
 * 位置跨启动记忆（Keychain KV，存归一化坐标）。
 *
 * v4 修复（点击中毒 bug）：v3 的 Pressable onPress 与 PanResponder 双轨竞争——某次触摸
 * 带微小位移被 pan 抢走后，moved 标记残留旧值，Pressable 的 tap 判定从此永远不通过
 * （点一两下后失灵的根因，与点法无关）。v4 改为手势系统单轨全判定：onStart 即接管，
 * release 时按累计位移分派 tap（<8px）或拖动贴边——无竞态、无残留。
 *
 * 显示条件：命令目录含 'idea'（桌面 managed 注册）且设置开关未关闭（hidden 标志同 KV）。
 * 视觉：透明底——纯 💡 字形 + 文字投影（深浅背景均可读），与蓝色实心底相比近乎隐形。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, PanResponder, StyleSheet, Text } from 'react-native';
import * as Keychain from 'react-native-keychain';

const BALL = 44;
const EDGE = 6;
const TAP_SLOP = 8;
/** 长按判定时长（RN delayLongPress 默认值） */
const LONG_PRESS_MS = 500;
const SERVICE = 'chill.idea-ball';

export interface BallSettings {
  yRatio: number;
  right: boolean;
  hidden?: boolean;
}

export async function loadBallSettings(): Promise<BallSettings | null> {
  try {
    const r = await Keychain.getGenericPassword({ service: SERVICE });
    if (!r) return null;
    const p = JSON.parse(r.password);
    if (typeof p?.yRatio === 'number' && typeof p?.right === 'boolean') return p as BallSettings;
    return null;
  } catch {
    return null;
  }
}

async function saveBallSettingsRaw(p: BallSettings): Promise<void> {
  try {
    await Keychain.setGenericPassword('ball', JSON.stringify(p), { service: SERVICE });
  } catch {
    /* 记忆失败不影响功能（下次回默认位） */
  }
}

/** 持久化球设置（设置屏开关等外部写入口） */
export async function saveBallSettings(p: BallSettings): Promise<void> {
  await saveBallSettingsRaw(p);
}

export default function IdeaFloatBall({ onPress, onLongPress }: { onPress: () => void; onLongPress?: () => void }) {
  const screen = Dimensions.get('window');
  const defaultX = screen.width - BALL - EDGE - 4;
  const defaultY = Math.round(screen.height * 0.6);
  const pos = useRef(new Animated.ValueXY({ x: defaultX, y: defaultY })).current;
  const base = useRef({ x: defaultX, y: defaultY });
  const moved = useRef(0);
  const settingsRef = useRef<BallSettings>({ yRatio: defaultY / screen.height, right: true });
  const [dragging, setDragging] = useState(false);
  /** 长按判定（手势单轨内的定时器）：到点且位移未超 tap 阈值 → 触发 onLongPress 并抑制本次 tap */
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(() => {
    void loadBallSettings().then((p) => {
      if (!p) return;
      settingsRef.current = p;
      const x = p.right ? screen.width - BALL - EDGE - 4 : EDGE + 4;
      const y = Math.max(60, Math.min(screen.height - BALL - 120, Math.round(p.yRatio * screen.height)));
      base.current = { x, y };
      pos.setValue({ x, y });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 卸载清长按定时器（防卸载后回调悬空）
  useEffect(() => cancelLongPress, []);

  /** 贴边落位（拖动结束）+ 位置记忆 */
  const settle = (rawX: number, rawY: number, vx: number) => {
    const goRight = vx > 0.8 || (vx > -0.8 && rawX + BALL / 2 > screen.width / 2);
    const x = goRight ? screen.width - BALL - EDGE - 4 : EDGE + 4;
    const y = Math.max(60, Math.min(screen.height - BALL - 120, rawY));
    base.current = { x, y };
    Animated.spring(pos, { toValue: { x, y }, useNativeDriver: true, speed: 18, bounciness: 5 }).start();
    settingsRef.current = { ...settingsRef.current, yRatio: Math.min(1, Math.max(0, y / screen.height)), right: goRight };
    void saveBallSettings(settingsRef.current);
  };

  const pan = useRef(
    PanResponder.create({
      // v4：触摸开始即接管（单轨全判定——tap/drag 分派在 release，无 Pressable 竞争）
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        moved.current = 0;
        longPressFired.current = false;
        setDragging(true);
        pos.setOffset({ x: base.current.x, y: base.current.y });
        pos.setValue({ x: 0, y: 0 });
        if (onLongPress) {
          longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            if (moved.current < TAP_SLOP) {
              longPressFired.current = true;
              onLongPress();
            }
          }, LONG_PRESS_MS);
        }
      },
      onPanResponderMove: (_e, g) => {
        moved.current = Math.max(moved.current, Math.abs(g.dx) + Math.abs(g.dy));
        if (moved.current >= TAP_SLOP) cancelLongPress(); // 已构成拖动意图：撤销长按判定
        pos.setValue({ x: g.dx, y: g.dy });
      },
      onPanResponderRelease: (_e, g) => {
        cancelLongPress();
        pos.flattenOffset();
        setDragging(false);
        if (moved.current < TAP_SLOP) {
          // 单击：回原位 + 触发（moved 每次 Grant 都重置——不再有残留中毒）；
          // 长按已触发则抑制本次 tap（与 RN onLongPress/onPress 互斥语义一致）
          Animated.timing(pos, { toValue: base.current, duration: 80, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
          if (!longPressFired.current) onPress();
          return;
        }
        settle(base.current.x + g.dx, base.current.y + g.dy, g.vx);
      },
      onPanResponderTerminate: () => {
        cancelLongPress();
        pos.flattenOffset();
        setDragging(false);
        Animated.timing(pos, { toValue: base.current, duration: 120, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      },
    }),
  ).current;

  return (
    <Animated.View
      style={[styles.wrap, { transform: pos.getTranslateTransform(), opacity: dragging ? 0.55 : 0.95 }]}
      {...pan.panHandlers}
      accessibilityLabel="记个点子（可拖动）"
    >
      <Text style={styles.icon}>💡</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    width: BALL,
    height: BALL,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 80,
    elevation: 9,
  },
  // 透明底：纯字形 + 文字投影（深浅背景均可读——去掉实心蓝色圆底）
  icon: {
    fontSize: 28,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 5,
    textShadowOffset: { width: 0, height: 1 },
  },
});
