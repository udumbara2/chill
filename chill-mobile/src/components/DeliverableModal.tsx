/**
 * DeliverableModal.tsx — 子任务交付物三态查看（中量档 v2：执行过程实时可见）
 *
 * 状态机：loading → running（动作流时间线 + 落定监听）→ settled（Markdown 全文）。
 * 数据编排（规划 tmp/plan-deliverable-midtier-v1.md v2，三审全 PASS）：
 * - push 管过程：feed 事实 → **本地每任务环形缓冲（cap 50，toolCallId 归并、终态同行回填）
 *   为唯一渲染源**——不以 overlay 直读渲染（overlay 全局 60 prune 跨任务，并行洪峰会中途回收正看的时间线）；
 *   feed 事件载荷只带 taskId（不带事实本体）→ 事件到达重读 getFeedFacts(taskId, 50) union 进本地环（只增不删）。
 * - pull 管结果：task.detail 轮询（3s）+ feed 事件触发即时重拉（节流 3s 下限——对非活动会话��
 *   readMessages 反复读盘，统一安全侧）。乱序双守卫：① 请求序号（仅认最新发出请求的应答，旧应答丢弃）；
 *   ② settled 单向吸收（终态不回退 running；万一迁移自动重武装轮询，双保险防死端）。
 * - 清理纪律：close/unmount 一处收口，清四项（feed 订阅 / 轮询 timer / 秒表 tick / 节流窗口）。
 * 交互对齐桌面 AgentProcessPanel：参数摘要 ~200 字折叠/展开、状态行（进行中…/成功·耗时/失败·原因）、
 * settle 后时间线保留供回看（默认收起）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { RelaySession } from '../relay/session';
import { MarkdownText } from './MarkdownText';

/** task.detail 应答线形（core commandSurface task.detail data） */
export interface TaskDetailData {
  status: string | null;
  deliverable: string;
  truncated: boolean;
}

/** 时间线本地环条目（FeedSubagentBody 视图同形） */
interface FactRow {
  toolCallId: string;
  toolName: string;
  kind: string;
  argsSummary: string;
  status: 'running' | 'success' | 'failed';
  resultSummary?: string;
  durationMs?: number;
  at: number;
}

/** 本地环上限（对齐桌面 TOOL_CALL_LOG_MAX） */
const TIMELINE_CAP = 50;
/** 落定轮询间隔 */
const POLL_MS = 3_000;
/** feed 触发重拉节流下限（含非活动会话防读盘风暴——统一安全侧，三审 m2 执行注意） */
const FEED_RETICK_MIN_MS = 3_000;
/** 摘要折叠阈值（对齐桌面 AgentProcessPanel FOLD_CHARS） */
const FOLD_CHARS = 200;

type Phase = 'loading' | 'running' | 'settled' | 'error';

const STATUS_LABEL: Record<string, { text: string; bg: string; fg: string }> = {
  success: { text: '✓ 成功', bg: '#14532d', fg: '#86efac' },
  failed: { text: '✗ 失败', bg: '#7f1d1d', fg: '#fca5a5' },
  running: { text: '进行中', bg: '#1e3a8a', fg: '#93c5fd' },
};

function fmtDur(ms?: number): string {
  if (ms === undefined) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function DeliverableModal({
  visible,
  onClose,
  session,
  sessionId,
  taskId,
  title,
}: {
  visible: boolean;
  onClose: () => void;
  session: RelaySession;
  sessionId: string;
  taskId: string;
  title: string;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [settled, setSettled] = useState<TaskDetailData | null>(null);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [tlReplayOpen, setTlReplayOpen] = useState(false);

  // ---- 引用态（守卫与清理；不参与渲染） ----
  const ringRef = useRef<FactRow[]>([]); // 本地环（union 只增不删，唯一渲染事实源）
  const phaseRef = useRef<Phase>('loading'); // phase 镜像（回调内读最新）
  const pollSeqRef = useRef(0); // 请求序号守卫：仅认最新发出请求的应答
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const throttleRef = useRef(0); // 上次 feed 触发重拉时刻
  const offFeedRef = useRef<(() => void) | null>(null);
  const startedAtRef = useRef(0);
  const setPhaseBoth = (p: Phase) => { phaseRef.current = p; setPhase(p); };

  /** overlay 读数 union 进本地环：同 toolCallId 按 at latest-wins（终态同行回填）；只增不删；cap 50 丢最旧 */
  const mergeIntoRing = useCallback((fresh: FactRow[]): void => {
    if (fresh.length === 0) return; // 空读不触发渲染（防回收：overlay 被挤出时本地环保留）
    const byId = new Map(ringRef.current.map((f) => [f.toolCallId, f]));
    for (const f of fresh) {
      const old = byId.get(f.toolCallId);
      if (!old || f.at >= old.at) byId.set(f.toolCallId, f);
    }
    let all = [...byId.values()].sort((a, b) => a.at - b.at);
    if (all.length > TIMELINE_CAP) all = all.slice(all.length - TIMELINE_CAP);
    ringRef.current = all;
    setFacts(all);
  }, []);

  const readOverlayFacts = useCallback((): FactRow[] => {
    try {
      return (session.getFeedFacts(taskId, TIMELINE_CAP) ?? []) as unknown as FactRow[];
    } catch {
      return [];
    }
  }, [session, taskId]);

  const clearPollTimer = (): void => {
    if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null; }
  };

  /** 武装下一轮轮询（setTimeout 链：应答回来若仍 running 再武装，无重入） */
  const armPoll = useCallback((): void => {
    clearPollTimer();
    pollSeqRef.current += 1;
    const seq = pollSeqRef.current;
    pollTimerRef.current = setTimeout(() => { void fetchDetailRef.current?.(seq); }, POLL_MS);
  }, []);

  /** task.detail 拉取（乱序双守卫 + 状态单向吸收） */
  const fetchDetail = useCallback(async (seq: number): Promise<void> => {
    try {
      const r = await session.requestCmd(
        `taskdt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        'task.detail',
        { sessionId, taskId },
      );
      if (seq !== pollSeqRef.current) return; // ① 迟到应答丢弃（序号守卫）
      if (!r.ok || !r.data) {
        setPhaseBoth('error');
        setErrorText((r.error as { message?: string } | undefined)?.message ?? '拉取失败');
        clearPollTimer();
        return;
      }
      const d = r.data as unknown as TaskDetailData;
      if (d.status === 'running') {
        if (phaseRef.current === 'settled') return; // ② settled 单向吸收（双保险，正常不可达）
        setPhaseBoth('running');
        armPoll(); // 重武装（保持轮询链）
      } else {
        setPhaseBoth('settled');
        setSettled(d);
        clearPollTimer();
      }
    } catch (err) {
      if (seq !== pollSeqRef.current) return;
      setPhaseBoth('error');
      setErrorText(err instanceof Error ? err.message : String(err));
      clearPollTimer();
    }
  }, [armPoll, session, sessionId, taskId]);
  const fetchDetailRef = useRef(fetchDetail);
  fetchDetailRef.current = fetchDetail;

  /** 四项清理（close/unmount 一处收口；seq 自增作废在途应答） */
  const cleanup = useCallback((): void => {
    offFeedRef.current?.(); offFeedRef.current = null;
    clearPollTimer();
    if (tickTimerRef.current) { clearInterval(tickTimerRef.current); tickTimerRef.current = null; }
    pollSeqRef.current += 1;
    throttleRef.current = 0;
  }, []);

  // ---- 生命周期：visible 驱动（打开初始化 / 关闭与卸载清理） ----
  useEffect(() => {
    if (!visible) { cleanup(); return cleanup; }
    ringRef.current = [];
    setFacts([]);
    setSettled(null);
    setErrorText(null);
    setTlReplayOpen(false);
    setPhaseBoth('loading');
    startedAtRef.current = Date.now();
    setElapsed(0);
    mergeIntoRing(readOverlayFacts()); // 初值（冷启动可能为空 → 空态文案）
    tickTimerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1_000);
    offFeedRef.current = session.on((e) => {
      if (e.type !== 'feed' || (e as { taskId?: string }).taskId !== taskId) return; // 防串过滤
      mergeIntoRing(readOverlayFacts()); // 事件只带 taskId → 重读 overlay union 进环
      if (phaseRef.current === 'running' && Date.now() - throttleRef.current >= FEED_RETICK_MIN_MS) {
        throttleRef.current = Date.now();
        clearPollTimer();
        pollSeqRef.current += 1;
        void fetchDetailRef.current?.(pollSeqRef.current); // 即时重拉（节流下限）
      }
    });
    pollSeqRef.current += 1;
    void fetchDetailRef.current?.(pollSeqRef.current); // 首拉
    return cleanup;
  }, [visible, taskId, session, cleanup, mergeIntoRing, readOverlayFacts]);

  const badge = phase === 'settled' && settled?.status ? STATUS_LABEL[settled.status] : null;
  const subagentType = facts.length > 0 ? (facts[facts.length - 1] as { subagentType?: string }).subagentType : undefined;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        {/* 头部 */}
        <View style={styles.head}>
          <View style={styles.headMid}>
            <Text style={styles.title} numberOfLines={2}>{title}</Text>
            {phase === 'loading' ? (
              <View style={[styles.badge, styles.badgeRun]}><ActivityIndicator size="small" color="#93c5fd" /></View>
            ) : phase === 'running' ? (
              <View style={[styles.badge, styles.badgeRun]}><Text style={styles.badgeRunTxt}>进行中 · {elapsed}s</Text></View>
            ) : badge ? (
              <View style={[styles.badge, { backgroundColor: badge.bg }]}><Text style={[styles.badgeTxt, { color: badge.fg }]}>{badge.text}</Text></View>
            ) : null}
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityLabel="关闭交付物查看">
            <Text style={styles.close}>关闭 ✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {phase === 'loading' ? (
            <View style={styles.center}>
              <ActivityIndicator color="#3b82f6" size="large" />
              <Text style={styles.hint}>正在向桌面拉取…</Text>
            </View>
          ) : phase === 'error' ? (
            <View style={styles.center}>
              <Text style={styles.errTitle}>拉取失败</Text>
              <Text style={styles.errBody}>{errorText}</Text>
            </View>
          ) : phase === 'running' ? (
            <>
              <View style={styles.metaRow}>
                {subagentType ? <Text style={styles.chip}>@{subagentType}</Text> : null}
                <Text style={styles.chip}>工具调用 {facts.length} 次</Text>
              </View>
              <Text style={styles.tlTitle}>执行过程（实时）</Text>
              {facts.length === 0 ? (
                <Text style={styles.empty}>暂无工具调用记录（准备阶段不经工具网关）</Text>
              ) : (
                facts.map((f) => <TimelineRow key={f.toolCallId} f={f} />)
              )}
              <View style={styles.finalWait}>
                <Text style={styles.finalTitle}>最终输出（任务完成后呈现）</Text>
                <Text style={styles.finalHint}>任务进行中——成员交付后在此自动显示全文，无需关闭重开。</Text>
              </View>
            </>
          ) : (
            <>
              <MarkdownText text={settled?.deliverable ?? ''} baseStyle={styles.deliverable} />
              {settled?.truncated ? (
                <Text style={styles.truncNote}>⚠ 交付物超长已截断——完整内容请回桌面查看</Text>
              ) : null}
              {facts.length > 0 ? (
                <TouchableOpacity style={styles.replayToggle} onPress={() => setTlReplayOpen((v) => !v)}>
                  <Text style={styles.replayTxt}>{tlReplayOpen ? '▾' : '▸'} 执行过程回看（{facts.length} 次工具调用）</Text>
                </TouchableOpacity>
              ) : null}
              {tlReplayOpen ? facts.map((f) => <TimelineRow key={f.toolCallId} f={f} />) : null}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** 时间线行（状态图标/工具名/参数摘要折叠/状态行/结果摘要折叠——对齐桌面交互） */
function TimelineRow({ f }: { f: FactRow }) {
  const [expanded, setExpanded] = useState(false);
  const argsLong = f.argsSummary.length > FOLD_CHARS;
  const resLong = (f.resultSummary?.length ?? 0) > FOLD_CHARS;
  const fold = (s: string): string => (expanded || s.length <= FOLD_CHARS ? s : `${s.slice(0, FOLD_CHARS)}…`);
  return (
    <View style={styles.tlItem}>
      <View style={[styles.tlIcon, f.status === 'success' && styles.tlIconOk, f.status === 'failed' && styles.tlIconErr]}>
        {f.status === 'running' ? <View style={styles.tlPulse} /> : <Text style={styles.tlIconTxt}>{f.status === 'success' ? '✓' : '✗'}</Text>}
      </View>
      <View style={styles.tlBody}>
        <Text style={styles.tlTool}>{f.toolName}</Text>
        {f.argsSummary ? (
          <Text
            style={[styles.tlArgs, (argsLong || resLong) && styles.tlExpandable]}
            onPress={() => { if (argsLong || resLong) setExpanded((v) => !v); }}
          >
            {fold(f.argsSummary)}{(argsLong || resLong) ? (expanded ? ' ▴' : ' ▾') : ''}
          </Text>
        ) : null}
        {f.status === 'running' ? <Text style={styles.tlMeta}>进行中…</Text> : null}
        {f.status === 'success' ? <Text style={styles.tlMetaOk}>成功{f.durationMs !== undefined ? ` · ${fmtDur(f.durationMs)}` : ''}</Text> : null}
        {f.status === 'failed' ? <Text style={styles.tlMetaErr}>失败{f.resultSummary ? ` · ${fold(f.resultSummary)}` : ''}</Text> : null}
        {f.status === 'success' && f.resultSummary ? (
          <View style={styles.tlResult}>
            <Text style={styles.tlResultLb}>结果摘要</Text>
            <Text style={styles.tlResultTxt}>{fold(f.resultSummary)}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0f14', paddingTop: 54 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#1f2937' },
  headMid: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 8 },
  title: { flex: 1, color: '#f3f4f6', fontSize: 15, fontWeight: '700' },
  badge: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  badgeRun: { backgroundColor: '#1e3a8a' },
  badgeRunTxt: { color: '#93c5fd', fontSize: 11, fontWeight: '700' },
  badgeTxt: { fontSize: 11, fontWeight: '700' },
  close: { color: '#9ca3af', fontSize: 13, fontWeight: '600' },
  body: { flex: 1 },
  bodyContent: { padding: 16, paddingBottom: 40 },
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 10 },
  hint: { color: '#9ca3af', fontSize: 13 },
  errTitle: { color: '#ef4444', fontSize: 15, fontWeight: '700' },
  errBody: { color: '#d1d5db', fontSize: 13, textAlign: 'center', lineHeight: 20, maxWidth: '84%' },
  deliverable: { color: '#e5e7eb', fontSize: 13.5, lineHeight: 21 },
  truncNote: { color: '#f59e0b', fontSize: 12, marginTop: 14, textAlign: 'center' },
  metaRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  chip: { backgroundColor: '#111827', borderColor: '#1f2937', borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, fontSize: 11, color: '#9ca3af', overflow: 'hidden' },
  tlTitle: { fontSize: 11, color: '#6b7280', fontWeight: '700', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 },
  empty: { color: '#6b7280', fontSize: 12.5, paddingVertical: 20, textAlign: 'center' },
  tlItem: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  tlIcon: { width: 20, height: 20, borderRadius: 10, flexShrink: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1e3a8a', marginTop: 1 },
  tlIconOk: { backgroundColor: '#14532d' },
  tlIconErr: { backgroundColor: '#7f1d1d' },
  tlIconTxt: { color: '#fff', fontSize: 11, fontWeight: '800' },
  tlPulse: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#93c5fd' },
  tlBody: { flex: 1, minWidth: 0 },
  tlTool: { color: '#e5e7eb', fontSize: 13, fontWeight: '700' },
  tlArgs: { color: '#6b7280', fontSize: 11.5, marginTop: 3, lineHeight: 17 },
  tlExpandable: { color: '#9ca3af' },
  tlMeta: { color: '#6b7280', fontSize: 11, marginTop: 3 },
  tlMetaOk: { color: '#86efac', fontSize: 11, marginTop: 3 },
  tlMetaErr: { color: '#fca5a5', fontSize: 11, marginTop: 3 },
  tlResult: { marginTop: 5, backgroundColor: '#111827', borderColor: '#1f2937', borderWidth: 1, borderRadius: 8, padding: 7 },
  tlResultLb: { color: '#4b5563', fontSize: 10, fontWeight: '700', marginBottom: 2 },
  tlResultTxt: { color: '#9ca3af', fontSize: 11, lineHeight: 16 },
  finalWait: { marginTop: 18, borderTopWidth: 1, borderTopColor: '#1f2937', paddingTop: 12 },
  finalTitle: { fontSize: 11, color: '#6b7280', fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 },
  finalHint: { color: '#4b5563', fontSize: 11.5, lineHeight: 17 },
  replayToggle: { marginTop: 18, borderTopWidth: 1, borderTopColor: '#1f2937', paddingTop: 12 },
  replayTxt: { color: '#6b7280', fontSize: 12, fontWeight: '600' },
});
