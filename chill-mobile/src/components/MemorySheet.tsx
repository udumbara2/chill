/**
 * MemorySheet — 记忆库管理面板（直记+事后���理；蒸馏审批制已退役）。
 *
 * 通道：cmd.request memory.list/show/delete/seen（确定性命令面，不占模型轮）——
 * 与 ModelPickerSheet 同款应答回收（session.on('cmdResult') 形状过滤）。
 * 打开即巡检：memory.seen 上报水位（维护节「N 新」徽标随之归零）。
 * 删除两段防线：本地确认弹层（risk=confirm 的呈现侧）+ 桌面执行器复核。
 * sheet 机械仿 WorkPlanPanel/SessionSheet：Modal + translateY 320ms 数值位移 + scrim。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { RelaySession } from '../relay/session';

/** memory.list 投影条目（core 命令面线形；不含 body——show 按需拉全文） */
interface MemoryItem {
  name: string;
  type: string;
  hook: string;
  importance: number;
  updated_at: string;
  new: boolean;
}

/** memory.show 详情（全文） */
interface MemoryDetail extends MemoryItem {
  body: string;
  created_at: string;
  last_used_at: string;
  usage_count: number;
}

const LINE = '#e5e7eb';

export default function MemorySheet({ visible, onClose, session }: { visible: boolean; onClose: () => void; session: RelaySession }) {
  const slide = useRef(new Animated.Value(0)).current;
  const [sheetH, setSheetH] = useState(0);
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState<string | null>(null);

  const setOpenAnimated = useCallback(
    (next: boolean) => {
      if (next) slide.setValue(0);
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

  // 打开即：订阅应答 + memory.list 拉取 + memory.seen 巡检上报（水位归零闭环）
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const off = session.on((e) => {
      if (e.type !== 'cmdResult' || !alive) return;
      const data = (e.data ?? {}) as Record<string, unknown>;
      if (!e.ok) {
        if (data['items'] === undefined && data['entry'] === undefined && data['deleted'] === undefined) {
          // 与本面板无关的失败应答（形状不含本面板字段）不侵扰——按请求超时/失败统一提示仅限本面板命令
          return;
        }
        setErrorText(e.error?.message ?? '操作失败');
        setLoading(false);
        setDetailLoading(false);
        return;
      }
      if (Array.isArray(data['items'])) {
        setItems(data['items'] as MemoryItem[]);
        setLoading(false);
        setErrorText(null);
      } else if (data['entry'] && typeof data['entry'] === 'object') {
        setDetail(data['entry'] as unknown as MemoryDetail);
        setDetailLoading(false);
      } else if (typeof data['deleted'] === 'string') {
        const gone = data['deleted'];
        setItems((prev) => (prev ? prev.filter((i) => i.name !== gone) : prev));
        setConfirmTitle(null);
        setDetail(null);
      }
    });
    setItems(null);
    setDetail(null);
    setQuery('');
    setErrorText(null);
    setLoading(true);
    void session.sendCmdRequest(`memory-list-${Date.now()}`, 'memory.list').catch(() => {
      if (alive) {
        setLoading(false);
        setErrorText('投递失败（桌面离线？）');
      }
    });
    // 巡检水位上报（fire-and-forget：失败不打扰——徽标下次打开重试）
    void session.sendCmdRequest(`memory-seen-${Date.now()}`, 'memory.seen').catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }, [visible, session]);

  const openDetail = (name: string) => {
    if (detail?.name === name) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setDetail(null);
    void session.sendCmdRequest(`memory-show-${Date.now()}`, 'memory.show', { title: name }).catch(() => setDetailLoading(false));
  };

  const doDelete = () => {
    if (!confirmTitle) return;
    void session.sendCmdRequest(`memory-delete-${Date.now()}`, 'memory.delete', { title: confirmTitle }).catch(() => {
      setErrorText('删除请求投递失败');
      setConfirmTitle(null);
    });
  };

  const filtered = (items ?? []).filter(
    (i) => !query.trim() || i.name.toLowerCase().includes(query.trim().toLowerCase()) || i.hook.toLowerCase().includes(query.trim().toLowerCase()),
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
            { transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [sheetH || 480, 0] }) }] },
          ]}
        >
          <View style={styles.head}>
            <Text style={styles.headTitle}>🧠 记忆库</Text>
            <Pressable onPress={() => setOpenAnimated(false)} hitSlop={8}>
              <Text style={styles.headClose}>收起</Text>
            </Pressable>
          </View>

          <View style={styles.body}>
            <TextInput
              style={styles.search}
              placeholder="搜索标题 / 摘要…"
              placeholderTextColor="#b3b9c2"
              value={query}
              onChangeText={setQuery}
            />

            {loading && (
              <View style={styles.hintRow}>
                <ActivityIndicator size="small" color="#3b82f6" />
                <Text style={styles.hintText}>拉取记忆列表…</Text>
              </View>
            )}
            {errorText && <Text style={styles.errorText}>{errorText}</Text>}
            {!loading && items && filtered.length === 0 && (
              <Text style={styles.hintText}>{items.length === 0 ? '暂无记忆（对话中说「记住……」即可沉淀）' : '无匹配结果'}</Text>
            )}

            <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
              {!loading &&
                filtered.map((i) => (
                  <View key={i.name}>
                    <Pressable style={styles.itemRow} onPress={() => openDetail(i.name)}>
                      <View style={styles.itemMain}>
                        <View style={styles.itemTitleRow}>
                          {i.new && <Text style={styles.newBadge}>NEW</Text>}
                          <Text style={styles.itemType}>[{i.type}]</Text>
                          <Text style={styles.itemName} numberOfLines={1}>
                            {i.name}
                          </Text>
                        </View>
                        {!!i.hook && (
                          <Text style={styles.itemHook} numberOfLines={1}>
                            {i.hook}
                          </Text>
                        )}
                        <Text style={styles.itemMeta}>
                          更新 {i.updated_at.slice(0, 10)} · 重要度 {i.importance}
                        </Text>
                      </View>
                      <Text style={styles.itemArrow}>{detailLoading && detail === null ? '…' : detail?.name === i.name ? '▾' : '›'}</Text>
                    </Pressable>

                    {detail?.name === i.name && (
                      <View style={styles.detailBox}>
                        <Text style={styles.detailBody}>{detail.body}</Text>
                        <Text style={styles.detailMeta}>
                          创建 {detail.created_at.slice(0, 10)} · 被引用 {detail.usage_count} 次
                        </Text>
                        <Pressable
                          style={styles.deleteBtn}
                          onPress={() => setConfirmTitle(i.name)}
                          accessibilityLabel={`删除记忆 ${i.name}`}
                        >
                          <Text style={styles.deleteBtnText}>删除该记忆</Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                ))}
            </ScrollView>

            <Text style={styles.footnote}>记忆由助手在对话中直记入库；此面板浏览 / 删除即事后治理。打开面板即标记已巡检。</Text>
          </View>

          {confirmTitle !== null && (
            <View style={styles.confirmBox}>
              <Text style={styles.confirmText}>删除记忆「{confirmTitle}」？此操作不可撤销。</Text>
              <View style={styles.confirmRow}>
                <Pressable style={styles.confirmCancel} onPress={() => setConfirmTitle(null)}>
                  <Text style={styles.confirmCancelText}>取消</Text>
                </Pressable>
                <Pressable style={styles.confirmGo} onPress={doDelete}>
                  <Text style={styles.confirmGoText}>删除</Text>
                </Pressable>
              </View>
            </View>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  scrim: { flex: 1 },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 22 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  headTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  headClose: { color: '#3b82f6', fontSize: 13 },
  body: { paddingHorizontal: 16 },
  search: { borderWidth: 1, borderColor: LINE, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13.5, color: '#111827', marginTop: 4 },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14 },
  hintText: { color: '#9ca3af', fontSize: 12.5, paddingVertical: 12 },
  errorText: { color: '#dc2626', fontSize: 12.5, paddingVertical: 8 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: LINE },
  itemMain: { flex: 1 },
  itemTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  newBadge: { backgroundColor: '#3b82f6', color: '#fff', fontSize: 9, fontWeight: '800', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, overflow: 'hidden' },
  itemType: { fontSize: 11, color: '#6b7280' },
  itemName: { fontSize: 13.5, fontWeight: '600', color: '#111827', flexShrink: 1 },
  itemHook: { color: '#9ca3af', fontSize: 11.5, marginTop: 2 },
  itemMeta: { color: '#b3b9c2', fontSize: 10.5, marginTop: 2 },
  itemArrow: { color: '#b3b9c2', fontSize: 16 },
  detailBox: { backgroundColor: '#f8fafc', borderRadius: 10, padding: 12, marginVertical: 6 },
  detailBody: { fontSize: 12.5, color: '#374151', lineHeight: 19 },
  detailMeta: { color: '#b3b9c2', fontSize: 10.5, marginTop: 8 },
  deleteBtn: { alignSelf: 'flex-start', marginTop: 10, borderWidth: 1, borderColor: '#fca5a5', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  deleteBtnText: { color: '#dc2626', fontSize: 12.5, fontWeight: '600' },
  footnote: { color: '#b3b9c2', fontSize: 11, marginTop: 12 },
  confirmBox: { marginHorizontal: 16, marginBottom: 4, backgroundColor: '#fef2f2', borderRadius: 12, padding: 14 },
  confirmText: { color: '#991b1b', fontSize: 13, lineHeight: 19 },
  confirmRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  confirmCancel: { flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  confirmCancelText: { color: '#6b7280', fontSize: 13, fontWeight: '600' },
  confirmGo: { flex: 1, backgroundColor: '#dc2626', borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  confirmGoText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
