/**
 * CompactConfirmSheet — M3 压缩确认 sheet（维护节二级展开；risk=confirm 档）。
 *
 * 形态：当前用量呈现（cmd.state.ctx，与占用环同源）+ 可选引导语输入 + 确认按钮；
 * 不假落定：确认只显"执行中…"，结果唯一来源 cmd.state.ctx 回流（压缩后 approx 估值空窗"约"）；
 * 守卫错误（running/<3 条用户消息/无模型）诚实 toast（Alert），sheet 收起由用户决定。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Dimensions, Easing, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { RelaySession } from '../relay/session';
import type { CommandStateSnapshot } from '../relay/envelope';
import { fmtTokens } from './ContextRing';

export default function CompactConfirmSheet({
  visible,
  onClose,
  session,
  commandState,
}: {
  visible: boolean;
  onClose: () => void;
  session: RelaySession;
  commandState: CommandStateSnapshot | null;
}) {
  const slide = useRef(new Animated.Value(0)).current;
  const [sheetH, setSheetH] = useState(0);
  const [guidance, setGuidance] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const setOpenAnimated = useCallback(
    (next: boolean) => {
      Animated.timing(slide, { toValue: next ? 1 : 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      if (!next) setTimeout(onClose, 40);
    },
    [slide, onClose],
  );

  React.useEffect(() => {
    if (visible) {
      slide.setValue(0);
      setSubmitting(false);
      setGuidance('');
      Animated.timing(slide, { toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
  }, [visible, slide]);

  // 应答监听：守卫错误 Alert（诚实回错）；成功等待 ctx 回流（App 层状态驱动各处更新，本 sheet 只收口）
  useEffect(() => {
    if (!visible) return;
    const off = session.on((e) => {
      if (e.type === 'cmdResult' && e.replyTo.startsWith('compact-')) {
        setSubmitting(false);
        if (!e.ok) {
          Alert.alert('无法压缩', e.error?.message ?? '桌面拒绝了本次压缩');
        } else {
          setOpenAnimated(false); // 成功 → 收 sheet；用量对比经占用环/会话 sheet 行回落呈现
        }
      }
    });
    return off;
  }, [visible, session, setOpenAnimated]);

  const ctx = commandState?.ctx ?? null;
  const ratio = ctx && ctx.max ? Math.min(1, ctx.used / ctx.max) : null;
  const warn = ratio !== null && ratio > 0.8;
  const usedText = ctx ? `${ctx.approx === true ? '约 ' : ''}${fmtTokens(ctx.used)}${ctx.max ? ` / ${fmtTokens(ctx.max)}` : ''}` : '无实测';

  const submit = () => {
    if (submitting) return;
    setSubmitting(true);
    void session
      .sendCmdRequest(`compact-${Date.now()}`, 'compact', guidance.trim() ? { guidance: guidance.trim() } : undefined)
      .catch(() => {
        setSubmitting(false);
        Alert.alert('投递失败', '桌面可能离线；消息会暂存，恢复后送达');
      });
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={() => setOpenAnimated(false)}>
      <View style={styles.root}>
        <Pressable style={styles.scrim} onPress={() => !submitting && setOpenAnimated(false)} />
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
            <Text style={styles.headTitle}>压缩上下文</Text>
            <Pressable onPress={() => !submitting && setOpenAnimated(false)} hitSlop={8} accessibilityLabel="收起压缩确认">
              <Text style={styles.headClose}>收起 ⌄</Text>
            </Pressable>
          </View>
          <View style={styles.body}>
            <View style={styles.usageRow}>
              <Text style={styles.usageLabel}>当前占用</Text>
              <Text style={[styles.usageValue, warn && styles.usageWarn]}>{usedText}{ratio !== null ? ` · ${Math.round(ratio * 100)}%` : ''}</Text>
            </View>
            <Text style={styles.desc}>
              总结历史并保留最近 2 轮原文；完整历史保留在桌面，不删除。压缩完成后占用回落（短暂显示"约"估值为正常口径）。
            </Text>
            <TextInput
              style={styles.input}
              value={guidance}
              onChangeText={setGuidance}
              placeholder="引导语（可选）：压缩时侧重保留什么"
              placeholderTextColor="#9ca3af"
              multiline
            />
            <Pressable onPress={submit} disabled={submitting} style={[styles.btn, submitting && styles.btnDisabled]} accessibilityLabel="确认压缩">
              <View style={styles.btnRow}>
                {submitting ? <ActivityIndicator size="small" color="#fff" /> : null}
                <Text style={styles.btnText}>{submitting ? '执行中…（桌面确认后回落）' : '确认压缩'}</Text>
              </View>
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Modal>
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
  usageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  usageLabel: { fontSize: 13, color: '#6b7280' },
  usageValue: { fontSize: 13.5, fontWeight: '700', color: '#111827' },
  usageWarn: { color: '#b45309' },
  desc: { fontSize: 12.5, color: '#6b7280', lineHeight: 19, marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, color: '#111827', minHeight: 64, textAlignVertical: 'top', marginBottom: 14 },
  btn: { backgroundColor: '#1d4ed8', borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  btnDisabled: { opacity: 0.65 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
