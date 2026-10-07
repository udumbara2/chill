/**
 * ModelPickerSheet — M2 模型选择器（会话 sheet 应答节的二级展开；惰性拉取 + 思考强度分段）。
 *
 * 红线：
 * - 打开时 cmd.request model.list 惰性拉取（不进目录数据；picker 即时打开——fast 通道不受运行轮阻塞）；
 * - 思考强度档位 = 当前模型 options.efforts（枚举随模型定义：换模型档位自动变——model.param 通例）；
 * - 不假落定：选模型/调档只显"请求中…"，落定唯一来源是 cmd.state 回流（App 层状态更新驱动本组件重渲染）；
 * - 同值点击 = 无操作（幂等防抖）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Dimensions, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { RelaySession } from '../relay/session';
import type { CommandStateSnapshot } from '../relay/envelope';

interface ModelOption {
  name: string;
  displayName?: string;
  provider?: string;
  efforts: string[];
  /** 凭据槽是否已配 Key（CLI /model list 同口径；false=禁用+标注——配 Key 是桌面 /key 的资产管理边界） */
  hasKey?: boolean;
  /** 出厂卡退役标记（可选，标注） */
  deprecated?: boolean;
}

export default function ModelPickerSheet({
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
  const [options, setOptions] = useState<ModelOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  /** 待落定标记：model=待切换模型名；effort=待落定档位（cmd.state 回流对齐即清） */
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingEffort, setPendingEffort] = useState<string | null>(null);

  const setOpenAnimated = useCallback(
    (next: boolean) => {
      Animated.timing(slide, {
        toValue: next ? 1 : 0,
        duration: 320,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
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

  // 惰性拉取：打开即 model.list（fast 通道，运行轮中即时返回）
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const off = session.on((e) => {
      if (e.type === 'cmdResult' && e.ok && e.data && Array.isArray(e.data['options'])) {
        if (!alive) return;
        setOptions(e.data['options'] as ModelOption[]);
        setLoading(false);
        setErrorText(null);
      } else if (e.type === 'cmdResult' && !e.ok) {
        if (!alive) return;
        setLoading(false);
        setErrorText(e.error?.message ?? '拉取失败');
      }
    });
    setLoading(true);
    setErrorText(null);
    void session.sendCmdRequest(`model-list-${Date.now()}`, 'model.list').catch(() => {
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

  const current = commandState?.model ?? null;
  // 落定回流清待定标记（cmd.state 由 App 层传入，本组件只读）
  useEffect(() => {
    if (pendingModel && current?.name === pendingModel) setPendingModel(null);
    if (pendingEffort && current?.effort === pendingEffort) setPendingEffort(null);
  }, [current, pendingModel, pendingEffort]);

  const pickModel = (name: string) => {
    if (name === current?.name || pendingModel) return;
    setPendingModel(name);
    void session.sendCmdRequest(`model-set-${Date.now()}`, 'model.set', { name }).catch(() => setPendingModel(null));
  };
  const pickEffort = (value: string) => {
    if (value === current?.effort || pendingEffort || !current) return;
    setPendingEffort(value);
    void session
      .sendCmdRequest(`model-param-${Date.now()}`, 'model.param', { param: 'reasoning_effort', value })
      .catch(() => setPendingEffort(null));
  };

  const efforts = options?.find((o) => o.name === current?.name)?.efforts ?? [];

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
            <Text style={styles.headTitle}>模型</Text>
            <Pressable onPress={() => setOpenAnimated(false)} hitSlop={8} accessibilityLabel="收起模型选择">
              <Text style={styles.headClose}>收起 ⌄</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {loading ? (
              <View style={styles.centerRow}>
                <ActivityIndicator size="small" color="#3b82f6" />
                <Text style={styles.hint}>拉取模型列表…</Text>
              </View>
            ) : errorText ? (
              <Text style={styles.error}>{errorText}</Text>
            ) : (
              (options ?? []).map((o) => {
                const isCurrent = o.name === current?.name;
                const selectable = o.hasKey !== false;
                const marks: string[] = [];
                if (o.hasKey === false) marks.push('未配置 Key');
                if (o.deprecated) marks.push('已退役');
                const rowBody = (
                  <View style={[styles.row, !selectable && styles.rowDisabled]}>
                    <View style={styles.rowMain}>
                      <Text style={[styles.rowTitle, isCurrent && styles.rowTitleCurrent, !selectable && styles.rowTitleDim]} numberOfLines={1}>
                        {o.displayName || o.name}
                      </Text>
                      <Text style={styles.rowSub} numberOfLines={1}>
                        {marks.length > 0 ? `${marks.join(' · ')}${o.provider ? ` · ${o.provider}` : ''}` : o.provider ?? ''}
                      </Text>
                    </View>
                    {pendingModel === o.name ? (
                      <ActivityIndicator size="small" color="#3b82f6" />
                    ) : isCurrent ? (
                      <Text style={styles.check}>✓</Text>
                    ) : null}
                  </View>
                );
                if (!selectable) return <View key={o.name}>{rowBody}</View>;
                return (
                  <Pressable key={o.name} onPress={() => pickModel(o.name)} hitSlop={4} accessibilityLabel={`选择模型 ${o.name}`}>
                    {rowBody}
                  </Pressable>
                );
              })
            )}
            {/* 思考强度：档位随当前模型定义（换模型自动变）；无枚举则整段不渲染（零状态零渲染） */}
            {efforts.length > 0 && current ? (
              <View style={styles.effortBlock}>
                <Text style={styles.effortTitle}>思考强度（随模型定义）</Text>
                <View style={styles.segRow}>
                  {efforts.map((v) => {
                    const on = v === current.effort;
                    const pending = pendingEffort === v;
                    return (
                      <Pressable key={v} onPress={() => pickEffort(v)} hitSlop={4} accessibilityLabel={`思考强度 ${v}`}>
                        <View style={[styles.segBtn, on && styles.segBtnOn, pending && styles.segBtnPending]}>
                          <Text style={[styles.segText, on && styles.segTextOn]} numberOfLines={1}>
                            {pending ? '…' : v}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
            <Text style={styles.footnote}>落定以桌面 cmd.state 回流为准（本地不假落定）；轮次运行中切换自下一轮生效。</Text>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { backgroundColor: '#ffffff', borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '72%', paddingBottom: 24 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  headTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  headClose: { color: '#3b82f6', fontSize: 13 },
  body: { paddingHorizontal: 16 },
  bodyContent: { paddingBottom: 8 },
  centerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 18 },
  hint: { color: '#9ca3af', fontSize: 13 },
  error: { color: '#b91c1c', fontSize: 13, paddingVertical: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 10 },
  rowCurrent: { opacity: 1 },
  rowDisabled: { opacity: 0.55 },
  rowMain: { flex: 1 },
  rowTitle: { fontSize: 14.5, fontWeight: '600', color: '#111827' },
  rowTitleCurrent: { color: '#1d4ed8' },
  rowTitleDim: { color: '#6b7280' },
  rowSub: { fontSize: 12, color: '#9ca3af', marginTop: 1 },
  check: { color: '#1d4ed8', fontSize: 16, fontWeight: '700' },
  effortBlock: { marginTop: 16 },
  effortTitle: { fontSize: 11, fontWeight: '700', color: '#9ca3af', marginBottom: 8, letterSpacing: 0.5 },
  segRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  segBtn: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: '#fff' },
  segBtnOn: { borderColor: '#1d4ed8', backgroundColor: 'rgba(29,78,216,0.06)' },
  segBtnPending: { opacity: 0.6 },
  segText: { fontSize: 13, color: '#374151' },
  segTextOn: { color: '#1d4ed8', fontWeight: '700' },
  footnote: { color: '#b3b9c2', fontSize: 11, marginTop: 14 },
});
