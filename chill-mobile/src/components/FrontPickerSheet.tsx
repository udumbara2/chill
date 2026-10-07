/**
 * FrontPickerSheet — M3 会话前台选择器（会话 sheet 应答节二级展开）。
 *
 * 候选=front.list 惰性拉取（仅本地模板——与 CLI /front 同口径）；首行「裸模型」（front=null）。
 * 不假落定：切换只显"请求中"，落定唯一来源 cmd.state.front 回流。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Dimensions, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { RelaySession } from '../relay/session';
import type { CommandStateSnapshot } from '../relay/envelope';

interface FrontOption {
  type: string;
  name: string;
  description?: string;
}

export default function FrontPickerSheet({
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
  const [options, setOptions] = useState<FrontOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  /** 待落定前台（'∅'=裸模型 pending；null=无） */
  const [pending, setPending] = useState<string | null>(null);

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
      Animated.timing(slide, { toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
  }, [visible, slide]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const off = session.on((e) => {
      if (e.type === 'cmdResult' && e.replyTo.startsWith('front-list-')) {
        if (!alive) return;
        if (e.ok && e.data && Array.isArray(e.data['options'])) {
          setOptions(e.data['options'] as FrontOption[]);
          setLoading(false);
        } else if (!e.ok) {
          setLoading(false);
          setErrorText(e.error?.message ?? '拉取失败');
        }
      }
    });
    setLoading(true);
    setErrorText(null);
    void session.sendCmdRequest(`front-list-${Date.now()}`, 'front.list').catch(() => {
      if (alive) {
        setLoading(false);
        setErrorText('投递失败（桌面离线？）');
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [visible, session]);

  const current = commandState?.front ?? null;
  useEffect(() => {
    const target = pending === '∅' ? null : pending;
    if (pending && current === target) setPending(null);
  }, [current, pending]);

  const pick = (type: string | null) => {
    const target = type ?? '∅';
    const isCurrent = (type === null && current === null) || type === current;
    if (isCurrent || pending) return;
    setPending(target);
    void session.sendCmdRequest(`front-set-${Date.now()}`, 'front.set', type === null ? { type: null } : { type }).catch(() => setPending(null));
  };

  const rowFor = (key: string, title: string, sub: string | null, isCurrent: boolean, isPending: boolean, onPress: () => void) => (
    <Pressable key={key} onPress={onPress} hitSlop={4} accessibilityLabel={`选择前台 ${title}`}>
      <View style={styles.row}>
        <View style={styles.rowMain}>
          <Text style={[styles.rowTitle, isCurrent && styles.rowTitleCurrent]} numberOfLines={1}>
            {title}
          </Text>
          {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
        </View>
        {isPending ? <ActivityIndicator size="small" color="#3b82f6" /> : isCurrent ? <Text style={styles.check}>✓</Text> : null}
      </View>
    </Pressable>
  );

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
            <Text style={styles.headTitle}>会话前台</Text>
            <Pressable onPress={() => setOpenAnimated(false)} hitSlop={8} accessibilityLabel="收起前台选择">
              <Text style={styles.headClose}>收起 ⌄</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {rowFor('bare', '裸模型', '直接与当前模型对话', current === null, pending === '∅', () => pick(null))}
            {loading ? (
              <View style={styles.centerRow}>
                <ActivityIndicator size="small" color="#3b82f6" />
                <Text style={styles.hint}>拉取前台候选…</Text>
              </View>
            ) : errorText ? (
              <Text style={styles.error}>{errorText}</Text>
            ) : (
              (options ?? []).map((o) => rowFor(o.type, o.name, o.description ?? null, o.type === current, pending === o.type, () => pick(o.type)))
            )}
            <Text style={styles.footnote}>仅本地模板可选（远程模板只能被 task 委派）；切换自下一轮生效，随会话持久化。</Text>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { backgroundColor: '#ffffff', borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '68%', paddingBottom: 24 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  headTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  headClose: { color: '#3b82f6', fontSize: 13 },
  body: { paddingHorizontal: 16 },
  bodyContent: { paddingBottom: 8 },
  centerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 18 },
  hint: { color: '#9ca3af', fontSize: 13 },
  error: { color: '#b91c1c', fontSize: 13, paddingVertical: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 10 },
  rowMain: { flex: 1 },
  rowTitle: { fontSize: 14.5, fontWeight: '600', color: '#111827' },
  rowTitleCurrent: { color: '#1d4ed8' },
  rowSub: { fontSize: 12, color: '#9ca3af', marginTop: 1 },
  check: { color: '#1d4ed8', fontSize: 16, fontWeight: '700' },
  footnote: { color: '#b3b9c2', fontSize: 11, marginTop: 14 },
});
