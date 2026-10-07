/**
 * GoalSheet — M4 目标生命周期 UI 三件套（值渲染唯一来源 cmd.state.goal，本地不假落定）。
 *
 * - GoalStrip：输入框上方长条（进行中/暂停两态；与 WorkPlanPanel 长条同视觉语言），点按开详情 sheet；
 *   无目标零渲染（零状态零渲染）。
 * - GoalInputSheet：设定目标（objective 必填 + 判据可选 + 轮数上限可选）；risk=input 档。
 * - GoalStateSheet：详情 + 暂停/恢复（risk=instant）+ 放弃（Alert 二次确认——口袋误触防护）。
 *   turn.stop 与 goal 正交：停本轮不停自主推进，真停推进=暂停（按钮语义即为此设计）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Dimensions, Easing, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { RelaySession } from '../relay/session';
import type { CommandStateSnapshot } from '../relay/envelope';

/** sheet 升降机械（WorkPlanPanel 同款：数值位移——原生驱动不吃百分比字符串） */
function useSheetLift(visible: boolean, onClose: () => void) {
  const slide = useRef(new Animated.Value(0)).current;
  const [sheetH, setSheetH] = useState(0);
  const setOpenAnimated = useCallback(
    (next: boolean) => {
      Animated.timing(slide, { toValue: next ? 1 : 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      if (!next) setTimeout(onClose, 40);
    },
    [slide, onClose],
  );
  useEffect(() => {
    if (visible) {
      slide.setValue(0);
      Animated.timing(slide, { toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
  }, [visible, slide]);
  const transform = [
    {
      translateY: slide.interpolate({
        inputRange: [0, 1],
        outputRange: [sheetH > 0 ? sheetH : Dimensions.get('window').height, 0],
      }),
    },
  ];
  return { transform, setSheetH, setOpenAnimated };
}

function SheetFrame({
  visible,
  onClose,
  title,
  children,
  lift,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  lift: ReturnType<typeof useSheetLift>;
}) {
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={() => lift.setOpenAnimated(false)}>
      <View style={styles.root}>
        <Pressable style={styles.scrim} onPress={() => lift.setOpenAnimated(false)} />
        <Animated.View
          onLayout={(e) => {
            const h = Math.round(e.nativeEvent.layout.height);
            if (h > 0) lift.setSheetH((prev) => (h !== prev ? h : prev));
          }}
          style={[styles.sheet, { transform: lift.transform }]}
        >
          <View style={styles.head}>
            <Text style={styles.headTitle}>{title}</Text>
            <Pressable onPress={() => lift.setOpenAnimated(false)} hitSlop={8} accessibilityLabel={`收起${title}`}>
              <Text style={styles.headClose}>收起 ⌄</Text>
            </Pressable>
          </View>
          <View style={styles.body}>{children}</View>
        </Animated.View>
      </View>
    </Modal>
  );
}

// ==================== GoalStrip（输入框上方长条） ====================

export function GoalStrip({ goal, onPress }: { goal: NonNullable<CommandStateSnapshot['goal']>; onPress: () => void }) {
  const active = goal.status === 'active';
  return (
    <Pressable style={stripStyles.wrap} onPress={onPress} accessibilityLabel={`目标${active ? '推进中' : '已暂停'}，点按查看详情`}>
      <View style={[stripStyles.pill, !active && stripStyles.pillPaused]}>
        {active ? <ActivityIndicator size="small" color="#a78bfa" style={stripStyles.spin} /> : <Text style={stripStyles.pauseMark}>⏸</Text>}
        <Text style={stripStyles.txt} numberOfLines={1}>
          {active ? '目标' : '已暂停'} {goal.round}/{goal.maxRounds} · {goal.objective}
        </Text>
        <Text style={stripStyles.more}>详情 ›</Text>
      </View>
    </Pressable>
  );
}

const stripStyles = StyleSheet.create({
  wrap: { paddingHorizontal: 10, paddingBottom: 4 },
  pill: {
    height: 38, borderRadius: 12, backgroundColor: '#f5f3ff', borderWidth: 1, borderColor: '#ddd6fe',
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8,
  },
  pillPaused: { backgroundColor: '#f3f4f6', borderColor: '#e5e7eb' },
  spin: { transform: [{ scale: 0.8 }] },
  pauseMark: { fontSize: 13, color: '#9ca3af' },
  txt: { flex: 1, color: '#4c1d95', fontSize: 12.5, fontWeight: '600' },
  more: { color: '#8b5cf6', fontSize: 12 },
});

// ==================== GoalInputSheet（设定目标） ====================

export function GoalInputSheet({ visible, onClose, session }: { visible: boolean; onClose: () => void; session: RelaySession }) {
  const lift = useSheetLift(visible, onClose);
  const [objective, setObjective] = useState('');
  const [criteria, setCriteria] = useState('');
  const [maxRounds, setMaxRounds] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setObjective('');
      setCriteria('');
      setMaxRounds('');
      setSubmitting(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const off = session.on((e) => {
      if (e.type === 'cmdResult' && e.replyTo.startsWith('goal-set-')) {
        setSubmitting(false);
        if (e.ok) lift.setOpenAnimated(false);
        else Alert.alert('无法设定目标', e.error?.message ?? '桌面拒绝了本次设定');
      }
    });
    return off;
  }, [visible, session, lift]);

  const submit = () => {
    if (submitting || !objective.trim()) return;
    setSubmitting(true);
    const mr = Number(maxRounds);
    void session
      .sendCmdRequest(
        `goal-set-${Date.now()}`,
        'goal.set',
        {
          objective: objective.trim(),
          ...(criteria.trim() ? { criteria: criteria.trim() } : {}),
          ...(Number.isInteger(mr) && mr >= 1 && mr <= 100 ? { maxRounds: mr } : {}),
        },
      )
      .catch(() => {
        setSubmitting(false);
        Alert.alert('投递失败', '桌面可能离线；消息会暂存，恢复后送达');
      });
  };

  return (
    <SheetFrame visible={visible} onClose={onClose} title="设定目标" lift={lift}>
      <Text style={styles.desc}>
        给定目标与完成判据，桌面将自主多轮推进直到达成（每轮结束 cmd.state 回流推进进度）。
      </Text>
      <Text style={styles.label}>目标 *</Text>
      <TextInput style={styles.input} value={objective} onChangeText={setObjective} placeholder="要完成什么" placeholderTextColor="#9ca3af" multiline />
      <Text style={styles.label}>完成判据（可选，缺省同目标）</Text>
      <TextInput style={styles.input} value={criteria} onChangeText={setCriteria} placeholder="怎样算完成" placeholderTextColor="#9ca3af" multiline />
      <Text style={styles.label}>轮数上限（可选，1-100，缺省 20）</Text>
      <TextInput style={styles.inputNum} value={maxRounds} onChangeText={setMaxRounds} placeholder="20" placeholderTextColor="#9ca3af" keyboardType="number-pad" />
      <Pressable onPress={submit} disabled={submitting || !objective.trim()} style={[styles.btn, (submitting || !objective.trim()) && styles.btnDisabled]} accessibilityLabel="设定目标并开工">
        <View style={styles.btnRow}>
          {submitting ? <ActivityIndicator size="small" color="#fff" /> : null}
          <Text style={styles.btnText}>{submitting ? '请求中…' : '设定并开工'}</Text>
        </View>
      </Pressable>
    </SheetFrame>
  );
}

// ==================== GoalStateSheet（详情 + 暂停/恢复/放弃） ====================

export function GoalStateSheet({
  visible,
  onClose,
  session,
  goal,
}: {
  visible: boolean;
  onClose: () => void;
  session: RelaySession;
  goal: CommandStateSnapshot['goal'];
}) {
  const lift = useSheetLift(visible, onClose);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    const off = session.on((e) => {
      if (e.type === 'cmdResult' && e.replyTo.startsWith('goal-')) setPending(null);
    });
    return off;
  }, [visible, session]);

  // 落定回流清待定（goal 变 null=放弃/达成 → 收 sheet）
  useEffect(() => {
    if (!goal) {
      setPending(null);
      if (visible) lift.setOpenAnimated(false);
    }
  }, [goal, visible, lift]);

  const send = (action: 'goal.pause' | 'goal.resume', mark: string) => {
    if (pending) return;
    setPending(mark);
    void session.sendCmdRequest(`goal-${mark}-${Date.now()}`, action).catch(() => setPending(null));
  };
  const abandon = () => {
    if (pending) return;
    Alert.alert('放弃目标？', '目标与推进记录将被清除，不可恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '放弃',
        style: 'destructive',
        onPress: () => {
          setPending('abandon');
          void session.sendCmdRequest(`goal-abandon-${Date.now()}`, 'goal.abandon').catch(() => setPending(null));
        },
      },
    ]);
  };

  if (!goal) return null;
  const active = goal.status === 'active';
  return (
    <SheetFrame visible={visible} onClose={onClose} title="目标" lift={lift}>
      <View style={styles.usageRow}>
        <Text style={styles.statusLabel}>{active ? '🟣 推进中' : '⏸ 已暂停'}</Text>
        <Text style={styles.roundText}>{goal.round}/{goal.maxRounds} 轮</Text>
      </View>
      <Text style={styles.objective}>{goal.objective}</Text>
      <Text style={styles.desc}>
        每轮结束进度经 cmd.state 回流；「■ 停止」只中断当前轮，不停止自主推进——暂停才是停推进。
      </Text>
      <View style={styles.actionRow}>
        {active ? (
          <Pressable onPress={() => send('goal.pause', 'pause')} disabled={!!pending} style={[styles.actionBtn, styles.pauseBtn]} accessibilityLabel="暂停目标推进">
            <Text style={styles.pauseText}>{pending === 'pause' ? '请求中…' : '暂停推进'}</Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => send('goal.resume', 'resume')} disabled={!!pending} style={[styles.actionBtn, styles.btn]} accessibilityLabel="恢复目标推进">
            <Text style={styles.btnText}>{pending === 'resume' ? '请求中…' : '恢复推进'}</Text>
          </Pressable>
        )}
        <Pressable onPress={abandon} disabled={!!pending} style={[styles.actionBtn, styles.abandonBtn]} accessibilityLabel="放弃目标">
          <Text style={styles.abandonText}>{pending === 'abandon' ? '请求中…' : '放弃'}</Text>
        </Pressable>
      </View>
    </SheetFrame>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { backgroundColor: '#ffffff', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 28 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  headTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  headClose: { color: '#3b82f6', fontSize: 13 },
  body: { paddingHorizontal: 16 },
  desc: { fontSize: 12.5, color: '#6b7280', lineHeight: 19, marginBottom: 12 },
  label: { fontSize: 12, fontWeight: '700', color: '#9ca3af', marginTop: 10, marginBottom: 5 },
  input: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, color: '#111827', minHeight: 44, textAlignVertical: 'top' },
  inputNum: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, color: '#111827' },
  btn: { backgroundColor: '#1d4ed8', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 16 },
  btnDisabled: { opacity: 0.55 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  usageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  statusLabel: { fontSize: 14, fontWeight: '700', color: '#111827' },
  roundText: { fontSize: 13, color: '#6b7280' },
  objective: { fontSize: 14.5, color: '#111827', fontWeight: '600', marginBottom: 8 },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  actionBtn: { flex: 1, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  pauseBtn: { backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#d1d5db' },
  pauseText: { color: '#374151', fontSize: 15, fontWeight: '700' },
  abandonBtn: { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fca5a5', flex: 0.6 },
  abandonText: { color: '#b91c1c', fontSize: 15, fontWeight: '700' },
});
