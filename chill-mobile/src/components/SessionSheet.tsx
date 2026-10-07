/**
 * SessionSheet — M8 会话 sheet（☰ 入口：首行历史会话 + 应答/推进/维护三节设置行）。
 *
 * 显示红线：
 * - 值渲染唯一来源 = cmd.state（App 注入；null=未同步占位——照权限徽标"未同步"先例）；
 * - M1 只读态：命令行禁用（dimmed + 不响应按压），命令执行能力 M2 开放——本组件不发命令；
 * - 目录渲染容错（数据前向兼容）：未知 presentation/section 的 catalog 行折叠为 console-row 或跳过；
 * - sheet 机械仿 WorkPlanPanel：Modal + translateY 320ms（数值位移——原生驱动不吃百分比字符串）+ scrim。
 */
import React, { useCallback, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CommandCatalogEntry, CommandStateSnapshot } from '../relay/envelope';
import { hostToggleValue } from '../screens/hostToggleUi';
import { findCatalogCommand } from '../screens/commandCatalog';
import { fmtTokens } from './ContextRing';

const SECTION_TITLES: Record<string, string> = {
  answer: '应答 · 谁在回答我',
  advance: '推进 · 这场对话怎么跑',
  maintain: '维护',
};

function goalText(goal: CommandStateSnapshot['goal']): string {
  if (!goal) return '无';
  const prefix = goal.status === 'active' ? '推进中' : '已暂停';
  return `${prefix} ${goal.round}/${goal.maxRounds}`;
}

function ctxText(ctx: CommandStateSnapshot['ctx']): { text: string; warn: boolean } | null {
  if (!ctx || !ctx.max) return null;
  const ratio = Math.min(1, ctx.used / ctx.max);
  const approx = ctx.approx === true ? '约 ' : '';
  return { text: `${approx}${fmtTokens(ctx.used)} / ${fmtTokens(ctx.max)} · ${Math.round(ratio * 100)}%`, warn: ratio > 0.8 };
}

function Row({
  title,
  value,
  warn,
  dimmed,
  onPress,
}: {
  title: string;
  value: string;
  warn?: boolean;
  dimmed?: boolean;
  onPress?: () => void;
}) {
  const body = (
    <View style={[styles.row, dimmed && styles.rowDimmed]}>
      <Text style={styles.rowLabel}>{title}</Text>
      <Text style={[styles.rowValue, warn && styles.rowValueWarn, dimmed && styles.valueDimmed]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.rowArrow}>›</Text>
    </View>
  );
  if (dimmed || !onPress) return body;
  return (
    <Pressable onPress={onPress} hitSlop={4} accessibilityLabel={`${title}：${value}`}>
      {body}
    </Pressable>
  );
}

export default function SessionSheet({
  visible,
  onClose,
  commandState,
  commandCatalog,
  onOpenHistory,
  onOpenModel,
  onOpenFront,
  onTogglePlan,
  onToggleDesktop,
  onToggleAutoSwitch,
  onOpenCompact,
  onOpenGoal,
  onOpenIdea,
  onOpenImprove,
  onOpenMemory,
  onSessionMismatch,
}: {
  visible: boolean;
  onClose: () => void;
  commandState: CommandStateSnapshot | null;
  commandCatalog: CommandCatalogEntry[] | null;
  onOpenHistory: () => void;
  /** M2：模型行入口（注入即激活——打开 ModelPickerSheet；缺省保持只读态） */
  onOpenModel?: () => void;
  /** M3：前台行入口 / 规划行开关 / 压缩行入口（注入即激活） */
  onOpenFront?: () => void;
  onTogglePlan?: () => void;
  onOpenCompact?: () => void;
  /** 宿主级开关行入口（迭代 B：目录含 'desktop.set'/'autoswitch.set' 才渲染；值经 cmd.state 宿主标量落定） */
  onToggleDesktop?: () => void;
  onToggleAutoSwitch?: () => void;
  /** M4：目标行入口（有目标→详情 sheet；无目标→设定 sheet；由 ChatScreen 分派） */
  onOpenGoal?: () => void;
  /** 闪念捕获行入口（注入即激活——目录含 'idea' 才渲染；缺省该行不出现=managed 门控的呈现侧） */
  onOpenIdea?: () => void;
  /** 提案决策行入口（注入即激活——目录含 'improve' 才渲染；与 idea 攒料/决策成对） */
  onOpenImprove?: () => void;
  /** 记忆库行入口（直记+事后治理；目录含 'memory' 且注入入口才渲染——桌面任何布局均注册） */
  onOpenMemory?: () => void;
  /** D9 消歧提示：手机附着会话 ≠ 桌面活动会话时的提示文案（null=一致/未知不提示） */
  onSessionMismatch?: string | null;
}) {
  const slide = useRef(new Animated.Value(0)).current;
  const [sheetH, setSheetH] = useState(0);

  const setOpenAnimated = useCallback(
    (next: boolean) => {
      if (next) slide.setValue(0);
      Animated.timing(slide, {
        toValue: next ? 1 : 0,
        duration: 320,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      if (!next) setTimeout(onClose, 40); // 收起动画期间保持 Modal 挂载
    },
    [slide, onClose],
  );

  // 只在 visible 变真时播开动画（Modal 挂载即升）
  React.useEffect(() => {
    if (visible) {
      slide.setValue(0);
      Animated.timing(slide, { toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
  }, [visible, slide]);

  const s = commandState;
  const ctx = s ? ctxText(s.ctx) : null;
  // 目录分组（容错：未知 section 归 advance；M1 无目录时按 state 现算三节固定行）
  const sections: Array<{ key: string; title: string; rows: React.ReactNode[] }> = [
    { key: 'answer', title: SECTION_TITLES['answer']!, rows: [] },
    { key: 'advance', title: SECTION_TITLES['advance']!, rows: [] },
    { key: 'maintain', title: SECTION_TITLES['maintain']!, rows: [] },
  ];
  const findSection = (key: string) => sections.find((x) => x.key === key) ?? sections[1]!;

  // M1：固定五值行（目录数据 M2 起驱动 picker；值全部来自 state）
  findSection('answer').rows.push(
    <Row
      key="model"
      title="模型"
      value={s?.model ? `${s.model.name}${s.model.effort ? ` · 思考 ${s.model.effort}` : ''}` : '未同步'}
      dimmed={!onOpenModel}
      onPress={onOpenModel}
    />,
    <Row key="front" title="会话前台" value={s ? (s.front ?? '裸模型') : '未同步'} dimmed={!onOpenFront} onPress={onOpenFront} />,
  );
  findSection('advance').rows.push(
    <Row
      key="plan"
      title="规划模式"
      value={s ? (s.plan ? '开' : '关') : '未同步'}
      dimmed={!onTogglePlan}
      onPress={onTogglePlan}
    />,
    <Row key="goal" title="目标" value={s ? goalText(s.goal) : '未同步'} dimmed={!onOpenGoal} onPress={onOpenGoal} />,
  );
  findSection('maintain').rows.push(
    <Row key="compact" title="压缩上下文" value={ctx ? ctx.text : s ? '无实测' : '未同步'} warn={ctx?.warn} dimmed={!onOpenCompact} onPress={onOpenCompact} />,
  );
  // 宿主级开关行（目录含该命令且注入入口才渲染——旧桌面目录无此行自动不显示，"不存在而非禁用"）：
  // 桌面能力=电脑上助手的截屏+键鼠工具集放行；自动切换=自迭代后自动版本切换。与 CLI /desktop、/auto-switch 同源同键
  const desktopEntry = findCatalogCommand(commandCatalog, 'desktop.set');
  if (desktopEntry && onToggleDesktop) {
    findSection('maintain').rows.push(
      <Row key="desktop" title="🖥️ 桌面能力" value={hostToggleValue(s?.desktop)} onPress={onToggleDesktop} />,
    );
  }
  const autoswitchEntry = findCatalogCommand(commandCatalog, 'autoswitch.set');
  if (autoswitchEntry && onToggleAutoSwitch) {
    findSection('maintain').rows.push(
      <Row key="autoswitch" title="自动切换" value={hostToggleValue(s?.autoswitch)} onPress={onToggleAutoSwitch} />,
    );
  }
  // 闪念捕获行（迭代 2 · U1）：目录含 'idea' 且注入入口才渲染——桌面 managed 布局注册即出现
  const ideaEntry = findCatalogCommand(commandCatalog, 'idea');
  if (ideaEntry && onOpenIdea) {
    findSection('maintain').rows.push(
      <Row key="idea" title={`💡 ${ideaEntry.title}`} value="入改进提案 ›" onPress={onOpenIdea} />,
    );
  }
  // 提案决策行（裁决卡召唤；目录含 'improve' 且注入入口才渲染——与 idea 攒料/决策成对同闸）
  const improveEntry = findCatalogCommand(commandCatalog, 'improve');
  if (improveEntry && onOpenImprove) {
    findSection('maintain').rows.push(
      <Row key="improve" title={`📬 ${improveEntry.title}`} value="裁决卡 ›" onPress={onOpenImprove} />,
    );
  }
  // 记忆库行（直记+事后治理）：目录含 'memory' 且注入入口才渲染；value=未巡检新记忆数
  // （cmd.state memoryNewCount 加法标量；缺省=旧桌面/未同步。新 N 时 warn 高亮提醒巡检）
  const memoryEntry = findCatalogCommand(commandCatalog, 'memory');
  if (memoryEntry && onOpenMemory) {
    const memoryValue =
      s?.memoryNewCount === undefined || s === null ? '未同步' : s.memoryNewCount > 0 ? `${s.memoryNewCount} 新` : '无新';
    findSection('maintain').rows.push(
      <Row
        key="memory"
        title={`🧠 ${memoryEntry.title}`}
        value={`${memoryValue} ›`}
        warn={!!s && !!s.memoryNewCount && s.memoryNewCount > 0}
        onPress={onOpenMemory}
      />,
    );
  }

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={() => setOpenAnimated(false)}>
      <View style={styles.root}>
        <Pressable style={styles.scrim} onPress={() => setOpenAnimated(false)} />
        <Animated.View
          onLayout={(e) => {
            const h = Math.round(e.nativeEvent.layout.height);
            if (h > 0 && h !== sheetH) setSheetH(h);
          }}
          style={[
            styles.sheet,
            {
              transform: [
                {
                  translateY: slide.interpolate({
                    inputRange: [0, 1],
                    outputRange: [sheetH > 0 ? sheetH : Dimensions.get('window').height, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <View style={styles.head}>
            <Text style={styles.headTitle}>会话</Text>
            <Pressable onPress={() => setOpenAnimated(false)} hitSlop={8} accessibilityLabel="收起会话设置">
              <Text style={styles.headClose}>收起 ⌄</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {/* 首行：历史会话（原 ☰ 功能收进此处） */}
            <Pressable onPress={onOpenHistory} hitSlop={4} accessibilityLabel="打开历史会话列表">
              <View style={styles.row}>
                <Text style={styles.rowLabel}>历史会话</Text>
                <Text style={styles.rowValue}>会话列表 ›</Text>
              </View>
            </Pressable>
            {onSessionMismatch ? <Text style={styles.mismatch}>{onSessionMismatch}</Text> : null}
            {sections.map((sec) => (
              <View key={sec.key}>
                <Text style={styles.secTitle}>{sec.title}</Text>
                {sec.rows}
              </View>
            ))}
            <Text style={styles.footnote}>
              以上设置状态与桌面端实时同步。
            </Text>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const BG = '#ffffff';
const LINE = '#f3f4f6';

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: BG,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '68%',
    paddingBottom: 24,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  headTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  headClose: { color: '#3b82f6', fontSize: 13 },
  body: { paddingHorizontal: 16 },
  bodyContent: { paddingBottom: 8 },
  mismatch: { color: '#b45309', fontSize: 12, marginTop: 6 },
  secTitle: { fontSize: 11, fontWeight: '700', color: '#9ca3af', marginTop: 14, marginBottom: 2, letterSpacing: 0.5 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
  },
  rowDimmed: { opacity: 0.75 },
  rowLabel: { fontSize: 14, fontWeight: '600', color: '#111827' },
  rowValue: { flex: 1, textAlign: 'right', fontSize: 12.5, color: '#9ca3af' },
  rowValueWarn: { color: '#b45309', fontWeight: '700' },
  valueDimmed: {},
  rowArrow: { color: '#b3b9c2', fontSize: 16 },
  footnote: { color: '#b3b9c2', fontSize: 11, marginTop: 14 },
});
