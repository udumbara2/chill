/**
 * WorkPlanPanel — 工作计划树「进度长条 + 底部详情卡」（唯一面板；迭代 2 起 BoardPanel 已退役并入本组件）。
 *
 * 显示红线：零判定渲染——形态/前缀/行态全部来自 syncUiLogic 纯函数（workPlanStripView/
 * workPlanStripVisible/workPlanSheetMeta/workPlanRowView），本组件只做展示拼装与收摊状态持有；
 * 只读查阅（C 迭代演进：目录含 task.detail 且行有看板任务关联时可点开查看子任务交付物——
 * requestCmd 拉取，纯只读不发起任何会话写操作；原"纯观测零操作"红线相应放宽为"只读零写"）。
 *
 * 数据源：syncDb.workPlanMeta（树副本，双源=清单项+看板行）+ syncDb.boardItems（feed 实况的
 * 任务键联查——board.state 数据流照旧落库，本组件只取 itemId→claimedByTaskId 映射，不读 boardMeta）。
 * feed.subagent 事实（V2 平移）：看板来源行（根层与 children 都要）的行下进展=note 优先、
 * 空缺时 feedFactFallback 降级最近工具事实；feed 事件驱动重渲染。
 *
 * 形态：输入框上方 38px 圆角长条（spinner/静态○/灰○ + 文案 + 详情› + ✕）；点按升起 bottom sheet
 * （68% 屏高、320ms、scrim）；卡开长条整条退场（同一事实只在一层发声），收起恢复。
 * 全完成=绿底 settled；settled 永驻展示 / 手动 ✕ / 新活跃复现——判定复用 pillPresence 纯函数
 * （settled 用合成 strip.status='settled' 喂入，签名用 pillActivitySig 对扁平化树提取）。
 * settled 永驻规格（2026-10-06 规格演进，取代旧"settled 6s 自动收摊"）：完成后长条保留供回看，
 * 仅两种情况退场——用户点 ✕、新一轮活跃边沿 reappear 复现/顶掉；实现=恒传 settledSince:null 不起算。
 * 初值 dismissed=false：工作计划是持久事实（纯待办清单也要一瞥可见，场景 1）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getSyncDb } from '../db/syncDb';
import { DeliverableModal } from './DeliverableModal';
import type { RelaySession } from '../relay/session';
import type { BoardStripWire, FeedSubagentBody, WorkPlanItemWire } from '../relay/envelope';
import {
  feedFactFallback,
  pillActivitySig,
  pillPresence,
  workPlanRowView,
  workPlanSheetMeta,
  workPlanStripView,
  workPlanStripVisible,
  type PillActivitySig,
  type PillPresence,
  type WorkPlanRowView,
} from '../screens/syncUiLogic';

interface WorkPlanData {
  /** 数据归属会话（切会话首帧防旧会话残留误判/闪现的门） */
  sid: string | null;
  items: WorkPlanItemWire[];
  /** feed 实况的任务键联查（boardItems.detailJson.claimedByTaskId；board.state 照旧落库，只借这张映射） */
  taskByItemId: Record<string, string>;
}

const EMPTY_DATA: WorkPlanData = { sid: null, items: [], taskByItemId: {} };

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 扁平化树（DFS 序；收摊活跃签名提取用——pillActivitySig 按 status 数 in_progress） */
function flattenItems(items: WorkPlanItemWire[]): WorkPlanItemWire[] {
  const out: WorkPlanItemWire[] = [];
  const walk = (list: WorkPlanItemWire[]) => {
    for (const it of list) {
      out.push(it);
      if (it.children) walk(it.children);
    }
  };
  walk(items);
  return out;
}

export function WorkPlanPanel({ session, sessionId }: { session: RelaySession; sessionId: string }) {
  const [data, setData] = useState<WorkPlanData>(EMPTY_DATA);
  const [open, setOpen] = useState(false);
  // C 迭代→中量档：交付物弹层入口态（数据获取/轮询/时间线均在 Modal 内自持——视图内聚）
  const [detail, setDetail] = useState<{ open: boolean; taskId: string | null; title: string }>({
    open: false,
    taskId: null,
    title: '',
  });
  const [, setFeedTick] = useState(0); // feed 事实版本戳（触发看板来源行进展兜底重渲染）
  const slide = useRef(new Animated.Value(0)).current; // 0=收起 1=升起
  const [sheetH, setSheetH] = useState(0); // 弹层实测高度（数值位移用——原生驱动不吃百分比字符串）
  // 长条收摊状态：进程内 per-session（切会话隔离、不落库）；判定一律走 pillPresence 纯函数。
  // 初值 dismissed=false：工作计划树是持久事实，纯待办清单首次同步即应可见
  const dismissRef = useRef(new Map<string, { dismissed: boolean; sinceSig: PillActivitySig | null }>());
  const [presenceTick, setPresenceTick] = useState(0);
  const grow = useRef(new Animated.Value(0)).current;
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const db = getSyncDb();
      const agentId = session.getAgentId();
      const meta = await db.getWorkPlanMeta(agentId, sessionId);
      // feed 联查映射（boardItems 行 detailJson.claimedByTaskId；不读 boardMeta——树是唯一显示源）
      const boardRows = await db.listBoardItems(agentId, sessionId);
      if (!mounted.current) return;
      const taskByItemId: Record<string, string> = {};
      for (const r of boardRows) {
        const taskId = parseJson<{ claimedByTaskId?: string }>(r.detailJson)?.claimedByTaskId;
        if (taskId) taskByItemId[r.itemId] = taskId;
      }
      setData({
        sid: sessionId,
        items: parseJson<WorkPlanItemWire[]>(meta?.treeJson ?? null) ?? [],
        taskByItemId,
      });
    } catch {
      /* 副本读失败：保持上一帧视图 */
    }
  }, [session, sessionId]);

  useEffect(() => {
    mounted.current = true;
    // 切会话即重置屏内数据（防旧会话残留触发收摊边沿误判）
    setData({ ...EMPTY_DATA, sid: sessionId });
    void reload();
    const off = session.on((e) => {
      // workplan 落库 / board 落库（feed 联查映射可能变化）都触发重读
      if ((e.type === 'workplan' || e.type === 'board') && e.sessionId === sessionId) void reload();
      // feed 事实落位 → 重渲染（进展兜底数据源；事实在 session overlay，不落库）
      if (e.type === 'feed') setFeedTick((n) => n + 1);
    });
    return () => {
      mounted.current = false;
      off();
    };
  }, [session, sessionId, reload]);

  // 数据归属门：切会话首帧（reload 未归位）不拿旧会话残留做渲染/判定（防闪现与收摊边沿误判）
  const live = data.sid === sessionId ? data : EMPTY_DATA;
  // ---- C 迭代：交付物查阅（行可点 = 行有看板任务关联；目录门控已弃——internal 命令不进目录，
  // 改为试探式：旧桌面收到未知命令 fail-closed 回 unsupported，弹层错误态诚实降级） ----
  const detailableRow = useCallback(
    (rowId: string) => !!live.taskByItemId[rowId],
    [live.taskByItemId],
  );
  const openDetail = useCallback(
    (rowId: string, title: string) => {
      const taskId = live.taskByItemId[rowId];
      if (!taskId) return;
      setDetail({ open: true, taskId, title: title || '子任务交付物' });
    },
    [live.taskByItemId],
  );
  const view = workPlanStripView(live.items);
  const flat = flattenItems(live.items);
  // 收摊状态机复用 pillPresence：settled=全完成 → 合成 strip 喂入（判定纯函数零分叉）
  const synthStrip: BoardStripWire | null = view.visible
    ? { status: view.done ? 'settled' : 'running', countText: '', needsYou: view.needsYou }
    : null;

  // ---- 长条收摊状态机（判定唯一走 pillPresence 纯函数；本组件只持 per-session 状态与表现动画） ----
  const presenceState = (sid: string): { dismissed: boolean; sinceSig: PillActivitySig | null } => {
    let s = dismissRef.current.get(sid);
    if (!s) {
      s = { dismissed: false, sinceSig: null }; // 初值 false=工作计划首见即亮（见文件头注释）
      dismissRef.current.set(sid, s);
    }
    return s;
  };
  const pState = presenceState(sessionId);
  const sig = pillActivitySig(synthStrip, null, flat);
  // settled 永驻规格：恒传 settledSince:null（不起算）——pillPresence 对 settled 永返 'show'，无 auto-dismiss 通路
  const presence: PillPresence = pillPresence({
    strip: synthStrip,
    needsYou: null,
    rowCount: live.items.length,
    dismissed: pState.dismissed,
    settledSince: null,
    now: Date.now(),
    sig,
    sinceSig: pState.sinceSig,
  });
  // 语义显隐即时生效（红线：不依赖动画完成态）
  const stripOn = workPlanStripVisible(live.items);
  const pillVisible = stripOn && !open && (presence === 'show' || presence === 'reappear');

  // 状态迁移应用（reappear 复现——幂等收敛防循环）。settled 永驻规格（2026-10-06）：settledSince 恒 null
  // 不起算、auto-dismiss 通路不可达（纯函数语义保留在 syncUiLogic 供未来调用方复用），仅新活跃边沿可复现
  useEffect(() => {
    const s = presenceState(sessionId);
    const cur = pillActivitySig(synthStrip, null, flat);
    const p = pillPresence({
      strip: synthStrip,
      needsYou: null,
      rowCount: live.items.length,
      dismissed: s.dismissed,
      settledSince: null,
      now: Date.now(),
      sig: cur,
      sinceSig: s.sinceSig,
    });
    if (p === 'reappear') {
      s.dismissed = false;
      s.sinceSig = cur; // 快照前进：同一条边沿不重复弹
      setPresenceTick((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // 表现层：高度/透明度 0.35s 过渡（显隐语义不依赖本动画）
  useEffect(() => {
    Animated.timing(grow, {
      toValue: pillVisible ? 1 : 0,
      duration: 350,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // height 非原生驱动面
    }).start();
  }, [grow, pillVisible]);

  /** 手动 ✕ 立即收摊（纯观测：不产生任何会话操作）——settled 永驻规格下长条的唯一人工退场口 */
  const onDismissPill = useCallback(() => {
    const s = presenceState(sessionId);
    s.dismissed = true;
    s.sinceSig = pillActivitySig(synthStrip, null, flat); // 收摊快照：持续活跃不复现，出现新边沿才弹
    setPresenceTick((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, data]);

  const setOpenAnimated = useCallback(
    (next: boolean) => {
      setOpen(next);
      Animated.timing(slide, {
        toValue: next ? 1 : 0,
        duration: 320,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    },
    [slide],
  );

  const rowViews: WorkPlanRowView[] = live.items.map(workPlanRowView);
  const meta = workPlanSheetMeta(live.items);
  /** feed 实况（看板来源行：claimedByTaskId → 最近工具事实；无任务键=清单项空数组） */
  const factsOf = (rowId: string): FeedSubagentBody[] => {
    const taskId = live.taskByItemId[rowId];
    return taskId ? session.getFeedFacts(taskId, 3) : [];
  };

  return (
    <>
      {/* 进度长条（卡开整条退场：同一事实只在一层发声）。
          显隐=**语义挂载**（pillVisible 为真才在树上，为假立即卸载）——红线：可见性绝不依赖动画完成态。
          真机教训：旧写法「常挂载 + pointerEvents 由 pillVisible 切换 + grow 动画收合」，在高度/透明度
          动画未生效时会留下"看得见却点不动"的残影（全完成收摊后尤甚）。挂载即代表可见 ⇒ 看得见就一定点得动。
          grow 只管淡入表现（mount 时 0→1），不承担显隐语义。 */}
      {pillVisible ? (
        <Animated.View
          style={[
            { overflow: 'hidden' },
            {
              height: grow.interpolate({ inputRange: [0, 1], outputRange: [0, PILL_WRAP_H] }),
              opacity: grow,
            },
          ]}
        >
          <Pressable style={styles.pillWrap} onPress={() => setOpenAnimated(true)} accessibilityLabel="工作计划进度，点按查看详情">
            <View style={[styles.pill, view.done && styles.pillDone]}>
              {view.spinning ? (
                <ActivityIndicator size="small" color="#4f8cff" style={styles.spin} />
              ) : !view.done ? (
                <View style={[styles.staticDot, view.muted && styles.staticDotMuted]} />
              ) : null}
              <Text
                style={[
                  styles.pillTxt,
                  view.done && styles.pillTxtDone,
                  view.failed && styles.pillTxtFailed,
                  view.needsYou && styles.pillTxtNeedsYou,
                  view.muted && styles.pillTxtMuted,
                ]}
                numberOfLines={1}
              >
                {view.text}
              </Text>
              <Text style={[styles.pillMore, view.done && styles.pillMoreDone]}>详情 ›</Text>
              {/* 手动收摊 ✕（弱化小号、与「详情 ›」并排不抢视觉；纯观测零会话操作） */}
              <Pressable onPress={onDismissPill} hitSlop={8} accessibilityLabel="收起工作计划长条">
                <Text style={styles.pillX}>✕</Text>
              </Pressable>
              {view.needsYou ? <View style={styles.sigDot} /> : null}
            </View>
          </Pressable>
        </Animated.View>
      ) : null}

      {/* 底部详情卡（scrim 点按 /「收起 ⌄」关闭） */}
      <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpenAnimated(false)}>
        <View style={styles.sheetRoot}>
          <Pressable style={styles.scrimFill} onPress={() => setOpenAnimated(false)} />
          <Animated.View
            onLayout={(e) => {
              const h = Math.round(e.nativeEvent.layout.height);
              if (h > 0 && h !== sheetH) setSheetH(h);
            }}
            style={[
              styles.sheet,
              {
                // 数值位移（动画红线）：'100%' 字符串 outputRange 在原生驱动下失效（Android Kotlin 插值节点
                // 只把字符串写进 objectValue，nodeValue 恒 NaN → transform 拿到 NaN，弹层永不升起）。
                // onLayout 量真实高度；未量定的首帧用屏高兜底（必在屏外，量定即接棒，无跳变）。
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
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>工作计划</Text>
              <View style={styles.sheetHeadRight}>
                <Text style={styles.sheetCount}>
                  {meta.doneCount}/{meta.total} 已完成
                </Text>
                <Pressable onPress={() => setOpenAnimated(false)} hitSlop={8} accessibilityLabel="收起详情卡">
                  <Text style={styles.sheetClose}>收起 ⌄</Text>
                </Pressable>
              </View>
            </View>
            <ScrollView style={styles.sheetBody} contentContainerStyle={styles.sheetBodyContent}>
              {rowViews.length === 0 ? (
                <Text style={styles.sheetEmpty}>暂无工作计划</Text>
              ) : (
                rowViews.map((row) => (
                  <WorkPlanRowCard key={row.id} view={row} factsOf={factsOf} detailableRow={detailableRow} openDetail={openDetail} />
                ))
              )}
            </ScrollView>
          </Animated.View>
        </View>
      </Modal>
      {/* C 迭代→中量档：交付物三态查看（执行中实时时间线/落定 Markdown 全文；组件自持数据、轮询与清理） */}
      {detail.taskId ? (
        <DeliverableModal
          visible={detail.open}
          onClose={() => setDetail((d) => ({ ...d, open: false }))}
          session={session}
          sessionId={sessionId}
          taskId={detail.taskId}
          title={detail.title}
        />
      ) : null}
    </>
  );
}

/**
 * 行卡（顶层项=行卡样式；children 嵌在父项卡片内部——左侧引导线包裹的子行）。
 * 只读查阅（C 迭代）：detailableRow 命中时 Pressable 可点开交付物（› 指示）；状态图标不变
 * （doing 蓝脉冲 / todo 琥珀空心 / done ✓删除线 / dead 玫瑰 / cancel 灰删除线）。
 */
function WorkPlanRowCard({
  view,
  factsOf,
  detailableRow,
  openDetail,
}: {
  view: WorkPlanRowView;
  factsOf: (rowId: string) => FeedSubagentBody[];
  detailableRow?: (rowId: string) => boolean;
  openDetail?: (rowId: string, title: string) => void;
}) {
  const facts = factsOf(view.id);
  const canOpen = !!detailableRow?.(view.id);
  return (
    <Pressable
      style={[styles.trow, view.dotKind === 'dead' && styles.trowDead]}
      disabled={!canOpen}
      onPress={() => openDetail?.(view.id, view.content)}
      accessibilityLabel={canOpen ? `查看 ${view.content} 的交付物` : undefined}
    >
      <View style={styles.trowHead}>
        <View style={styles.dotSlot}>
          <WorkPlanDot kind={view.dotKind} pulse={view.dotKind === 'doing'} />
        </View>
        <Text style={[styles.biTitle, view.done && styles.biTitleDone, view.cancelled && styles.biTitleCancelled]} numberOfLines={2}>
          {view.content}
        </Text>
        {view.needsYou ? <View style={styles.rowSigDot} /> : null}
        {view.badge ? (
          <View style={[styles.badge, BADGE_BG[view.badge.color]]}>
            <Text style={[styles.badgeTxt, BADGE_FG[view.badge.color]]} numberOfLines={1}>
              {view.badge.text}
            </Text>
          </View>
        ) : null}
        {canOpen ? <Text style={styles.chev}>›</Text> : null}
      </View>
      <WorkPlanNote view={view} facts={facts} />
      {/* 嵌套子行（children 随行渲染：有链看板行嵌父卡；引导线包裹） */}
      {view.children.length > 0 ? (
        <View style={styles.childWrap}>
          {view.children.map((c) => (
            <WorkPlanChildRow key={c.id} view={c} factsOf={factsOf} detailableRow={detailableRow} openDetail={openDetail} />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

/** 子行（引导线内的嵌套行；递归随行；C 迭代：同样可点开交付物） */
function WorkPlanChildRow({
  view,
  factsOf,
  detailableRow,
  openDetail,
}: {
  view: WorkPlanRowView;
  factsOf: (rowId: string) => FeedSubagentBody[];
  detailableRow?: (rowId: string) => boolean;
  openDetail?: (rowId: string, title: string) => void;
}) {
  const facts = factsOf(view.id);
  const canOpen = !!detailableRow?.(view.id);
  return (
    <Pressable
      style={styles.crow}
      disabled={!canOpen}
      onPress={() => openDetail?.(view.id, view.content)}
      accessibilityLabel={canOpen ? `查看 ${view.content} 的交付物` : undefined}
    >
      <View style={styles.trowHead}>
        <View style={styles.dotSlot}>
          <WorkPlanDot kind={view.dotKind} pulse={view.dotKind === 'doing'} />
        </View>
        <Text style={[styles.crowTitle, view.done && styles.biTitleDone, view.cancelled && styles.biTitleCancelled]} numberOfLines={2}>
          {view.content}
        </Text>
        {view.needsYou ? <View style={styles.rowSigDot} /> : null}
        {view.badge ? (
          <View style={[styles.badge, BADGE_BG[view.badge.color]]}>
            <Text style={[styles.badgeTxt, BADGE_FG[view.badge.color]]} numberOfLines={1}>
              {view.badge.text}
            </Text>
          </View>
        ) : null}
        {canOpen ? <Text style={styles.chev}>›</Text> : null}
      </View>
      <WorkPlanNote view={view} facts={facts} compact />
      {view.children.length > 0 ? (
        <View style={styles.childWrap}>
          {view.children.map((c) => (
            <WorkPlanChildRow key={c.id} view={c} factsOf={factsOf} detailableRow={detailableRow} openDetail={openDetail} />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * 进展/结果小注（feed 实况平移：非终态行 note 空缺时 feedFactFallback 降级最近工具事实——
 * 决策 8 双源兜底；终态行只显示结果留痕不兜底）。上色：failed 红 / needsYou 琥珀 / 其余灰。
 */
function WorkPlanNote({ view, facts, compact }: { view: WorkPlanRowView; facts: FeedSubagentBody[]; compact?: boolean }) {
  const terminal = view.done || view.cancelled || view.dotKind === 'dead';
  const line = terminal ? view.note : feedFactFallback(view.note, facts);
  if (!line) return null;
  return (
    <Text
      style={[styles.biNote, view.noteFailed && styles.biNoteFailed, view.needsYou && styles.biNoteNeedsYou]}
      numberOfLines={compact ? 2 : 3}
    >
      {line}
    </Text>
  );
}

/** 状态点（doing 蓝[pulse 时脉冲] / todo 琥珀空心 / dead 玫瑰实心 / done ✓ / cancel 灰） */
function WorkPlanDot({ kind, pulse }: { kind: WorkPlanRowView['dotKind']; pulse: boolean }) {
  if (kind === 'done') return <Text style={styles.dotDone}>✓</Text>;
  if (kind === 'doing' && pulse) return <PulseDoingDot />;
  return (
    <View
      style={[
        styles.dot,
        kind === 'doing' && styles.dotDoing,
        kind === 'todo' && styles.dotTodo,
        kind === 'dead' && styles.dotDead,
        kind === 'cancel' && styles.dotCancel,
      ]}
    />
  );
}

/** doing 蓝点脉冲（装饰层;卸载即停） */
function PulseDoingDot() {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 550, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 550, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return <Animated.View style={[styles.dot, styles.dotDoing, { opacity: pulse }]} />;
}

const BADGE_BG = {
  indigo: { backgroundColor: '#e0e7ff' },
  teal: { backgroundColor: '#ccfbf1' },
  amber: { backgroundColor: '#fef3c7' },
  rose: { backgroundColor: '#fee2e2' },
  muted: { backgroundColor: '#eef2f0' },
} as const;
const BADGE_FG = {
  indigo: { color: '#4338ca' },
  teal: { color: '#0f766e' },
  amber: { color: '#b45309' },
  rose: { color: '#b91c1c' },
  muted: { color: '#6b8a7d' },
} as const;

/** 长条容器动画高度（上留白 8 + pill 38 = 46） */
const PILL_WRAP_H = 46;

const styles = StyleSheet.create({
  // ---- 进度长条（38px 高圆角） ----
  pillWrap: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 0 },
  pill: {
    height: 38,
    backgroundColor: '#fafafa',
    borderColor: '#e5e7eb',
    borderWidth: 1,
    borderRadius: 19,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 8,
  },
  pillDone: { backgroundColor: '#ecfdf5', borderColor: '#a7f3d0' },
  spin: { width: 13, height: 13 },
  /** 无进行中时的静态 ○（琥珀空心=待办语义；不变量 ② 没人在跑不装跑） */
  staticDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: '#f59e0b' },
  /** 待认领灰调（场景 4：只有待认领看板行——灰点不冒充待办） */
  staticDotMuted: { borderColor: '#9ca3af' },
  pillTxt: { flexShrink: 1, fontSize: 12.5, fontWeight: '600', color: '#374151' },
  pillTxtDone: { color: '#059669' },
  pillTxtFailed: { color: '#b91c1c' },
  pillTxtNeedsYou: { color: '#b45309' },
  pillTxtMuted: { color: '#6b7280' },
  pillMore: { marginLeft: 'auto', fontSize: 12, fontWeight: '600', color: '#4f8cff' },
  pillMoreDone: { color: '#059669' },
  pillX: { fontSize: 12, fontWeight: '600', color: '#c4cad3' },
  sigDot: {
    width: 6.5,
    height: 6.5,
    borderRadius: 4,
    backgroundColor: '#f59e0b',
    shadowColor: '#f59e0b',
    shadowOpacity: 0.7,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
    elevation: 2,
  },
  /** 行级 needsYou 琥珀标记（行内形态；与长条 sigDot 同色收束） */
  rowSigDot: { width: 6.5, height: 6.5, borderRadius: 4, backgroundColor: '#f59e0b' },
  // ---- 底部详情卡（68% 白卡） ----
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  scrimFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(10,15,28,0.38)' },
  sheet: {
    height: '68%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    shadowColor: '#0f172a',
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -12 },
    elevation: 12,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f1f4',
  },
  sheetTitle: { fontSize: 14.5, fontWeight: '700', color: '#111' },
  sheetHeadRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sheetCount: { fontSize: 12, fontWeight: '600', color: '#9ca3af' },
  sheetClose: { fontSize: 12.5, color: '#6b7280', fontWeight: '500' },
  sheetBody: { flex: 1 },
  sheetBodyContent: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 16 },
  sheetEmpty: { textAlign: 'center', color: '#9ca3af', fontSize: 12, paddingVertical: 30 },
  // ---- 行卡（浅灰圆角） ----
  trow: {
    backgroundColor: '#fafafa',
    borderColor: '#eef0f3',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  trowDead: { backgroundColor: '#fcf8f8', borderColor: '#f1e6e6' },
  trowHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dotSlot: { width: 14, alignItems: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotDoing: { backgroundColor: '#3b82f6' },
  dotTodo: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: '#f59e0b', width: 8, height: 8, borderRadius: 4 },
  dotDead: { backgroundColor: '#c07070' },
  dotCancel: { backgroundColor: '#9ca3af' },
  dotDone: { fontSize: 11, fontWeight: '800', color: '#10b981', lineHeight: 13 },
  biTitle: { flex: 1, fontSize: 12.5, fontWeight: '600', color: '#1a1a1a' },
  /** completed=删除线+灰（绿 ✓=完成[删除线+结果摘要]） */
  biTitleDone: { textDecorationLine: 'line-through', color: '#9ca3af', fontWeight: '500' },
  /** cancelled=灰删除线（取消留痕不冒充完成） */
  biTitleCancelled: { textDecorationLine: 'line-through', color: '#b3b9c2', fontWeight: '500' },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1.5, maxWidth: 120, flexShrink: 1 },
  badgeTxt: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
  biNote: { fontSize: 11, color: '#9ca3af', marginLeft: 21, marginTop: 4, lineHeight: 16 },
  biNoteFailed: { color: '#b91c1c' },
  /** C 迭代：可点行尾指示（›） */
  chev: { color: '#9ca3af', fontSize: 16, fontWeight: '700', marginLeft: 4 },
  biNoteNeedsYou: { color: '#b45309' },
  // ---- 嵌套子行（左侧引导线包裹） ----
  childWrap: {
    marginTop: 6,
    marginLeft: 7,
    paddingLeft: 9,
    borderLeftWidth: 1.5,
    borderLeftColor: '#e5e7eb',
    gap: 6,
  },
  crow: { paddingVertical: 2 },
  crowTitle: { flex: 1, fontSize: 12, fontWeight: '500', color: '#374151' },
});
