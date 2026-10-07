/**
 * ConfirmedListSheet.tsx — 已确认/已关闭清单弹层（D 迭代）
 *
 * 长按💡空态（court==='empty'）时由 App 打开；也可经目录门控判断显隐。
 * 双 zone（confirmed=待实施 / closed=已关闭归档）切换拉取 improve.confirmed；
 * 长按条目弹动作菜单 → 两段式确认（armed 3s 窗口，对齐裁决卡 armCloseAll 先例）→
 * improve.confirmed.decide 流转 → 原地刷新当前 zone。
 * 写操作门控：目录含 improve.confirmed.decide 才启用菜单（旧桌面零报错降级为纯只读清单）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { RelaySession } from '../relay/session';

// ---------- 可测纯逻辑（导出供 jest） ----------

export type ConfirmedZone = 'confirmed' | 'closed';
export type ConfirmedAction = 'close' | 'implement' | 'requeue' | 'reopen';

/** 各 zone 可用动作（confirmed 区三向流出；closed 区一键恢复） */
export function actionsForZone(zone: ConfirmedZone): Array<{ key: ConfirmedAction; label: string; danger?: boolean }> {
  return zone === 'confirmed'
    ? [
        { key: 'close', label: '✕ 关闭（不做了）', danger: true },
        { key: 'implement', label: '✓ 标记已实现' },
        { key: 'requeue', label: '↺ 退回待确认' },
      ]
    : [{ key: 'reopen', label: '↺ 恢复到已确认' }];
}

/** 两段式确认的武装超时（ms）——与裁决卡 ARM_CLOSE_ALL_MS 同款语义 */
export const ARM_WINDOW_MS = 3000;

// ---------- 组件 ----------

export interface ConfirmedEntry {
  title: string;
  date: string;
  group: string | null;
}

function reqId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function ConfirmedListSheet({ visible, session, onClose }: { visible: boolean; session: RelaySession; onClose: () => void }) {
  const [zone, setZone] = useState<ConfirmedZone>('confirmed');
  const [entries, setEntries] = useState<ConfirmedEntry[] | null>(null); // null=加载中
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null); // 长按选中的条目标题
  const [armed, setArmed] = useState<ConfirmedAction | null>(null); // 已武装动作（再点才执行）
  const [busy, setBusy] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 目录门控已弃（internal 命令不进目录恒 false）——试探式：旧桌面 decide 会得 unsupported，
  // 错误信息在弹层内展示，长按不再被本地禁用

  const load = useCallback(
    async (z: ConfirmedZone) => {
      setEntries(null);
      setError(null);
      try {
        const r = await session.requestCmd(reqId('impc'), 'improve.confirmed', { zone: z });
        if (r.ok && Array.isArray((r.data as { entries?: ConfirmedEntry[] })?.entries)) {
          setEntries(((r.data as { entries: ConfirmedEntry[] }).entries));
        } else {
          setError((r.error as { message?: string } | undefined)?.message ?? '清单拉取失败');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [session],
  );

  useEffect(() => {
    if (visible) void load(zone);
  }, [visible, zone, load]);

  // 关闭时清理菜单与武装态
  useEffect(() => {
    if (!visible) {
      setMenuFor(null);
      setArmed(null);
    }
  }, [visible]);

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  /** 动作点击：首点武装（3s 窗口），再点执行；执行后关菜单原地刷新 */
  const onAction = useCallback(
    (title: string, action: ConfirmedAction) => {
      if (busy) return;
      if (armed !== action) {
        setArmed(action);
        if (armTimer.current) clearTimeout(armTimer.current);
        armTimer.current = setTimeout(() => setArmed(null), ARM_WINDOW_MS);
        return;
      }
      if (armTimer.current) clearTimeout(armTimer.current);
      setBusy(true);
      void (async () => {
        try {
          const r = await session.requestCmd(reqId('impd'), 'improve.confirmed.decide', { titles: [title], action });
          if (r.ok) {
            setArmed(null);
            setMenuFor(null);
            await load(zone);
          } else {
            setError((r.error as { message?: string } | undefined)?.message ?? '流转失败');
            setArmed(null);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setArmed(null);
        } finally {
          setBusy(false);
        }
      })();
    },
    [armed, busy, load, session, zone],
  );

  const zoneTabs: Array<{ key: ConfirmedZone; label: string }> = [
    { key: 'confirmed', label: '待实施' },
    { key: 'closed', label: '已关闭' },
  ];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.head}>
          <Text style={styles.headTitle}>改进提案 · 已确认账本</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityLabel="关闭清单">
            <Text style={styles.close}>关闭 ✕</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.tabs}>
          {zoneTabs.map((t) => (
            <TouchableOpacity
              key={t.key}
              style={[styles.tab, zone === t.key && styles.tabOn]}
              onPress={() => {
                setZone(t.key);
                setMenuFor(null);
                setArmed(null);
              }}
            >
              <Text style={[styles.tabTxt, zone === t.key && styles.tabTxtOn]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {error ? <Text style={styles.err}>{error}</Text> : null}
          {entries === null ? (
            <View style={styles.center}>
              <ActivityIndicator color="#3b82f6" size="large" />
              <Text style={styles.hint}>正在拉取清单…</Text>
            </View>
          ) : entries.length === 0 ? (
            <Text style={styles.empty}>{zone === 'confirmed' ? '暂无已确认待实施条目' : '已关闭区为空'}</Text>
          ) : (
            entries.map((e) => (
              <TouchableOpacity
                key={`${e.date}-${e.title}`}
                style={styles.row}
                activeOpacity={0.85}
                onLongPress={() => {
                  setMenuFor(e.title);
                  setArmed(null);
                }}
              >
                <Text style={styles.rowDate}>{e.date}</Text>
                <Text style={styles.rowTitle} selectable>
                  {e.title}
                </Text>
                {e.group ? <Text style={styles.rowGroup}>{e.group}</Text> : null}
                {menuFor === e.title ? (
                  <View style={styles.menu}>
                    {actionsForZone(zone).map((a) => (
                      <TouchableOpacity
                        key={a.key}
                        style={[styles.menuBtn, armed === a.key && (a.danger ? styles.menuBtnArmedDanger : styles.menuBtnArmed)]}
                        disabled={busy}
                        onPress={() => onAction(e.title, a.key)}
                      >
                        <Text style={[styles.menuBtnTxt, armed === a.key && styles.menuBtnTxtArmed]}>
                          {busy && armed === a.key ? '执行中…' : armed === a.key ? `再点确认 · ${a.label}` : a.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity style={styles.menuCancel} onPress={() => setMenuFor(null)}>
                      <Text style={styles.menuCancelTxt}>取消</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
        <Text style={styles.footHint}>长按条目可管理状态（关闭 / 标记已实现 / 退回 / 恢复）；旧桌面版本会提示不支持</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0f14', paddingTop: 54 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#1f2937' },
  headTitle: { color: '#f3f4f6', fontSize: 16, fontWeight: '700' },
  close: { color: '#9ca3af', fontSize: 13, fontWeight: '600' },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  tab: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#1f2937' },
  tabOn: { backgroundColor: '#3b82f6' },
  tabTxt: { color: '#9ca3af', fontSize: 13, fontWeight: '600' },
  tabTxtOn: { color: '#fff' },
  body: { flex: 1 },
  bodyContent: { padding: 16, paddingBottom: 40 },
  center: { alignItems: 'center', paddingTop: 60, gap: 10 },
  hint: { color: '#9ca3af', fontSize: 13 },
  err: { color: '#f87171', fontSize: 12.5, marginBottom: 10 },
  empty: { color: '#6b7280', fontSize: 13, textAlign: 'center', paddingTop: 60 },
  row: { backgroundColor: '#111827', borderRadius: 10, padding: 12, marginBottom: 10 },
  rowDate: { color: '#6b7280', fontSize: 11 },
  rowTitle: { color: '#e5e7eb', fontSize: 13.5, lineHeight: 20, marginTop: 3 },
  rowGroup: { color: '#3b82f6', fontSize: 11, marginTop: 4 },
  menu: { marginTop: 10, gap: 6 },
  menuBtn: { backgroundColor: '#1f2937', borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
  menuBtnArmed: { backgroundColor: '#3b82f6' },
  menuBtnArmedDanger: { backgroundColor: '#dc2626' },
  menuBtnTxt: { color: '#d1d5db', fontSize: 13, fontWeight: '600' },
  menuBtnTxtArmed: { color: '#fff' },
  menuCancel: { paddingVertical: 6, alignItems: 'center' },
  menuCancelTxt: { color: '#6b7280', fontSize: 12 },
  footHint: { color: '#4b5563', fontSize: 11, textAlign: 'center', paddingBottom: 12 },
});
