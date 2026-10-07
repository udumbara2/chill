/**
 * SessionListScreen.tsx — 屏（聊天屏"历史"按钮进入）：会话列表（项目=可折叠分区头，会话=分区内条目）。
 * 数据源 = syncDb 副本（catalog 元数据，零正文）；分区按"分区内最新会话 updatedAt"降序，
 * "未分组"伪分区固定最后；M6b 徽标 = "📱正在聊"（手机自己的 lastChatSessionId——
 * 不跟随桌面 activeSessionId，双端会话上下文解耦）；默认展开"正在聊"所在分区，
 * 展开状态本地记忆（syncState.expandedProjectsJson）；LegendList 虚拟化消化长列表。
 * 头部"＋新建会话" → 新会话聊天屏（空屏，发言即建，与默认路径共用 'new' 机制）。
 *
 * 会话管理：① 滑动删除——会话行 PanResponder 单轨手势（IdeaFloatBall v4 教训——严禁
 * PanResponder+Touchable 双轨），左右滑开露出行尾「删除」，点一次原地变「确认删除」，
 * 再点经 cmd.request 命令面上行（session.delete）；② 长按改标题——长按会话行 400ms
 * 标题就地变预填输入框（✓提交/✕放弃），经 session.rename 上行。两条命令 serial/internal，
 * 协议零改动；不假落定：行消失/标题变更的唯一来源是 session.event/catalog 回流，
 * cmd.result 只做快速反馈/错误提示。
 * 真机教训（2026-09-29）：行 UI 态（manageState/editing/renameSubmitting）必须进 items 数据——
 * LegendList 只在 data 身份变化时重渲行；只改屏级 state 时行不重渲（手势看似"没反应"）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, PanResponder, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { LegendList } from '@legendapp/list/react-native';
import { getSyncDb, type SessionRow } from '../db/syncDb';
import type { RelaySession } from '../relay/session';
import {
  RENAME_TITLE_MAX_CHARS,
  UNGROUPED_KEY,
  defaultExpandedKeys,
  groupSessionsIntoSections,
  parseExpanded,
  resolveRenameSubmit,
  resolveSwipeRelease,
  shouldClaimHorizontal,
  type SessionRowManageState,
  type SessionSection,
} from './syncUiLogic';

/** 列表项 = 分区头 | 会话行（折叠分区不产出会话行——LegendList 单层虚拟化）。
 *  会话行的 UI 态随数据走（见文件头"真机教训"——只有 data 身份变化才触发行重渲） */
type ListItem =
  | { type: 'header'; section: SessionSection; expanded: boolean }
  | {
      type: 'session';
      row: SessionRow;
      isChatting: boolean;
      /** 运行态标志：桌面宿主该会话轮次在跑（后台会话也含）——行尾转圈 */
      isRunning: boolean;
      manageState: SessionRowManageState;
      editing: boolean;
      renameSubmitting: boolean;
    };

/** 行尾动作层宽度：滑开=80；确认/执行中=104 */
const DELETE_OPEN_W = 80;
const CONFIRM_W = 104;
/** 长按触发编辑的按住时长 */
const LONG_PRESS_MS = 400;
/** 无回执兜底：清 pending 不报错（收敛交给回流；桌面离线但中继在线时命令暂存信箱） */
const PENDING_TIMEOUT_MS = 30_000;

function rowTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${hm}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 管理态吸附位（translateX 目标；closed=0，open=-80，confirming/submitting=-104） */
function snapOf(state: SessionRowManageState): number {
  if (state === 'open') return -DELETE_OPEN_W;
  if (state === 'confirming' || state === 'submitting') return -CONFIRM_W;
  return 0;
}

/**
 * 会话行（滑动删除 + 长按改标题）：PanResponder 单轨——onStart 接管起点（tap 才能到达 pan），
 * move 期水平占优才跟手、垂直占优经 terminationRequest 放手给 ScrollView，
 * release 按累计位移分派 tap/open/snap（判定全部走 syncUiLogic 纯函数）；
 * 长按 = grant 起 400ms 计时（位移超 8px 取消），命中即进编辑态并吞掉本次 release。
 * 编辑输入为非受控 TextInput（defaultValue 挂载时生效；文本经 textRef 读出）——
 * 草稿不进 items，避免逐键触发表级重渲与 IME 合成被打断。
 */
function SessionRowItem(props: {
  row: SessionRow;
  isChatting: boolean;
  isRunning: boolean;
  manageState: SessionRowManageState;
  editing: boolean;
  renameSubmitting: boolean;
  onOpenChat: () => void;
  onSwipeOpen: () => void;
  onDismiss: () => void;
  onTapDelete: () => void;
  onTapConfirm: () => void;
  onLongPressRow: () => void;
  onSubmitEdit: (text: string) => void;
  onCancelEdit: () => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const claimed = useRef(false);
  const longPressed = useRef(false);
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef(props.row.title || '');
  const [draftOk, setDraftOk] = useState(true);
  // pan 回调闭包需要最新 manageState/editing（吸附位/tap 语义/手势门），经 ref 透传
  const stateRef = useRef(props.manageState);
  stateRef.current = props.manageState;
  const editingRef = useRef(props.editing);
  editingRef.current = props.editing;

  // 管理态/身份变化 → 吸附到对应位置（recycleItems 复用时 sessionId 变化同样归零——回收安全）
  useEffect(() => {
    Animated.spring(translateX, { toValue: snapOf(props.manageState), useNativeDriver: true, speed: 24, bounciness: 0 }).start();
  }, [props.manageState, props.row.sessionId, translateX]);

  // 进入编辑/身份切换：文本基准与 ✓ 可用态复位（recycleItems 实例复用不串行）
  useEffect(() => {
    textRef.current = props.row.title || '';
    setDraftOk(true);
  }, [props.row.sessionId, props.editing, props.row.title]);

  // 卸载/回收时清长按计时器
  useEffect(() => {
    return () => {
      if (lpTimer.current) clearTimeout(lpTimer.current);
    };
  }, []);

  const pan = useRef(
    PanResponder.create({
      // 编辑态禁手势（输入框/按钮接管该行）
      onStartShouldSetPanResponder: () => !editingRef.current,
      onMoveShouldSetPanResponder: () => false,
      onPanResponderGrant: () => {
        claimed.current = false;
        longPressed.current = false;
        lpTimer.current = setTimeout(() => {
          longPressed.current = true;
          props.onLongPressRow();
        }, LONG_PRESS_MS);
      },
      onPanResponderMove: (_e, g) => {
        if (lpTimer.current && (Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8)) {
          clearTimeout(lpTimer.current);
          lpTimer.current = null;
        }
        if (!claimed.current && shouldClaimHorizontal(g.dx, g.dy)) claimed.current = true;
        if (claimed.current) {
          // 按钮停靠行尾：只跟随左滑分量；右滑由 release 阈值判定（左右滑同效开）
          translateX.setValue(Math.min(0, snapOf(stateRef.current) === 0 ? g.dx : snapOf(stateRef.current) + g.dx));
        }
      },
      onPanResponderTerminationRequest: (_e, g) => !shouldClaimHorizontal(g.dx, g.dy),
      onPanResponderRelease: (_e, g) => {
        if (lpTimer.current) {
          clearTimeout(lpTimer.current);
          lpTimer.current = null;
        }
        if (longPressed.current) {
          longPressed.current = false;
          claimed.current = false;
          return; // 长按已触发编辑，吞掉本次 release
        }
        const base = snapOf(stateRef.current);
        const outcome = resolveSwipeRelease(g.dx, g.dy, base !== 0);
        if (outcome === 'tap') {
          if (stateRef.current === 'closed') props.onOpenChat();
          else props.onDismiss(); // open/confirming 态 tap=收回；submitting 态状态机不吃 dismiss
        } else if (outcome === 'open') {
          props.onSwipeOpen();
        } else if (outcome === 'close') {
          props.onDismiss(); // 展开态右滑回滑过阈值=收回删除按钮
        } else {
          Animated.spring(translateX, { toValue: base, useNativeDriver: true, speed: 24, bounciness: 0 }).start();
        }
        claimed.current = false;
      },
      onPanResponderTerminate: () => {
        if (lpTimer.current) {
          clearTimeout(lpTimer.current);
          lpTimer.current = null;
        }
        // ScrollView 夺走 responder（垂直滚动）：回吸附位
        Animated.spring(translateX, { toValue: snapOf(stateRef.current), useNativeDriver: true, speed: 24, bounciness: 0 }).start();
        claimed.current = false;
      },
    }),
  ).current;

  /** ✓ 提交分派：invalid 已被置灰拦截；unchanged=静默退出（同 ✕）；submit=上抛文本 */
  const submitEdit = () => {
    const verdict = resolveRenameSubmit(textRef.current, props.row.title || '');
    if (verdict === 'submit') props.onSubmitEdit(textRef.current.trim());
    else if (verdict === 'unchanged') props.onCancelEdit();
  };

  const st = props.manageState;
  return (
    <View style={styles.swipeWrap}>
      {/* 行尾动作层（内容层之下；宽度随两步确认展开） */}
      <View style={styles.swipeActions}>
        <TouchableOpacity
          style={[
            styles.swipeDelete,
            st === 'open' && { width: DELETE_OPEN_W },
            (st === 'confirming' || st === 'submitting') && { width: CONFIRM_W },
            st === 'confirming' && styles.swipeDeleteConfirm,
            st === 'submitting' && styles.swipeDeleteBusy,
          ]}
          activeOpacity={0.85}
          onPress={() => {
            if (st === 'open') props.onTapDelete();
            else if (st === 'confirming') props.onTapConfirm();
            // closed=不可达（被内容层盖住）；submitting=执行中不吃点击
          }}
        >
          {st === 'submitting' ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.swipeDeleteLabel}>{st === 'confirming' ? '确认删除' : '删除'}</Text>
          )}
        </TouchableOpacity>
      </View>
      {/* 内容层（pan 单轨手势载体） */}
      <Animated.View
        style={[styles.sessionRow, st === 'submitting' && styles.sessionRowFading, { transform: [{ translateX }] }]}
        {...pan.panHandlers}
      >
        <View style={styles.sessionMain}>
          <View style={styles.sessionTitleRow}>
            {props.editing ? (
              <TextInput
                style={styles.titleInput}
                defaultValue={props.row.title || ''}
                onChangeText={(t) => {
                  textRef.current = t;
                  setDraftOk(resolveRenameSubmit(t, props.row.title || '') !== 'invalid');
                }}
                autoFocus
                maxLength={RENAME_TITLE_MAX_CHARS}
                returnKeyType="done"
                onSubmitEditing={submitEdit}
                placeholder="会话标题"
                placeholderTextColor="#6b7280"
              />
            ) : (
              <Text style={styles.sessionTitle} numberOfLines={1}>
                {props.row.title || '（无标题）'}
              </Text>
            )}
            {!props.editing && props.isChatting ? <Text style={styles.currentBadge}>📱正在聊</Text> : null}
          </View>
          <Text style={styles.sessionPreview} numberOfLines={1}>
            {props.row.preview || ' '}
          </Text>
        </View>
        {props.renameSubmitting ? (
          <View style={styles.editBusy}>
            <ActivityIndicator size="small" color="#6b7280" />
            <Text style={styles.editBusyText}>执行中…</Text>
          </View>
        ) : props.editing ? (
          <View style={styles.editActions}>
            <TouchableOpacity
              style={[styles.editBtn, styles.editBtnOk, !draftOk && styles.editBtnDisabled]}
              disabled={!draftOk}
              onPress={submitEdit}
              accessibilityLabel="确认重命名"
            >
              <Text style={styles.editBtnOkText}>✓</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.editBtn, styles.editBtnNo]} onPress={props.onCancelEdit} accessibilityLabel="取消重命名">
              <Text style={styles.editBtnNoText}>✕</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.rowTrailing}>
            {props.isRunning ? <ActivityIndicator size="small" color="#60a5fa" /> : null}
            <Text style={styles.sessionTime}>{rowTime(props.row.updatedAt)}</Text>
          </View>
        )}
      </Animated.View>
    </View>
  );
}

export default function SessionListScreen(props: {
  session: RelaySession;
  connected: boolean;
  /** 目录刷新信号（catalog/lastChat 事件序号） */
  catalogTick: number;
  /** 运行态刷新信号（running 事件序号——只重算行内转圈，不触发 DB 重读） */
  runningTick: number;
  onOpenChat: (sessionId: string) => void;
  onBack: () => void;
}) {
  const { session } = props;
  const [sections, setSections] = useState<SessionSection[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedLoaded, setExpandedLoaded] = useState(false);
  const [chattingId, setChattingId] = useState<string | null>(null);
  // 会话管理行态（屏级——recycleItems 下行内 useState 会串状态）：滑开行/确认行/编辑行/提交中集合
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingOps, setPendingOps] = useState<ReadonlyMap<string, 'delete' | 'rename'>>(new Map());
  const pendingReqs = useRef(new Map<string, { id: string; op: 'delete' | 'rename' }>());
  const pendingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // 键盘几何直驱（ChatScreen 同款：paddingBottom 逐帧跟随键盘，adjustResize 之外的精确补偿）
  const { height: kbHeight } = useReanimatedKeyboardAnimation();
  const kavAnimStyle = useAnimatedStyle(() => ({ paddingBottom: -kbHeight.value }));

  const reload = useCallback(async () => {
    try {
      const db = getSyncDb();
      const agentId = session.getAgentId();
      if (!agentId) return;
      const [sessions, projects, st] = await Promise.all([
        db.listSessions(agentId),
        db.listProjects(agentId),
        db.getSyncState(agentId),
      ]);
      const next = groupSessionsIntoSections(sessions, projects);
      setSections(next);
      // 删除落定收敛点：回流后行已消失 → 清掉悬空 pending（rename 的 pending 由 cmd.result/超时清理）
      const alive = new Set(sessions.map((s) => s.sessionId));
      setPendingOps((prev) => {
        if (prev.size === 0) return prev;
        const m = new Map(prev);
        for (const id of m.keys()) if (!alive.has(id)) m.delete(id);
        return m;
      });
      // M6b：徽标锚 = 手机自己的入口记忆（不跟随桌面 activeSessionId）
      const lastChat = session.getLastChatSessionId();
      setChattingId(lastChat);
      setExpanded((prev) => {
        if (expandedLoaded) return prev; // 用户操作过/已加载过 → 不动
        // 首次加载：本地记忆优先，无记忆按默认规则（"正在聊"所在分区）
        const remembered = parseExpanded(st?.expandedProjectsJson ?? null);
        if (Object.keys(remembered).length > 0) return remembered;
        const def = defaultExpandedKeys(next, lastChat);
        return Object.fromEntries(next.map((s) => [s.key, def.has(s.key)]));
      });
      setExpandedLoaded(true);
    } catch {
      /* 副本库不可用时列表留空 */
    }
  }, [session, expandedLoaded]);

  useEffect(() => {
    void reload();
  }, [reload, props.catalogTick]);

  /** 提交收尾（幂等）：清 pending/计时器；error 时诚实 Alert（不假落定——视图收敛交给回流） */
  const settlePending = useCallback((reqId: string, errorMessage?: string) => {
    const entry = pendingReqs.current.get(reqId);
    if (!entry) return; // 已收尾（超时兜底/重复回执）
    pendingReqs.current.delete(reqId);
    const timer = pendingTimers.current.get(reqId);
    if (timer) clearTimeout(timer);
    pendingTimers.current.delete(reqId);
    setPendingOps((prev) => {
      const m = new Map(prev);
      m.delete(entry.id);
      return m;
    });
    if (errorMessage) {
      Alert.alert(entry.op === 'delete' ? '无法删除会话' : '无法重命名会话', errorMessage);
    }
  }, []);

  /** cmd.result 回执订阅（sess-del-/sess-rn- 前缀路由；屏卸载清订阅与计时器） */
  useEffect(() => {
    const off = session.on((e) => {
      if (e.type !== 'cmdResult') return;
      if (!e.replyTo.startsWith('sess-del-') && !e.replyTo.startsWith('sess-rn-')) return;
      if (e.ok) settlePending(e.replyTo);
      else settlePending(e.replyTo, e.error?.message ?? '桌面拒绝了本次操作');
    });
    const reqs = pendingReqs.current;
    const timers = pendingTimers.current;
    return () => {
      off();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      reqs.clear();
    };
  }, [session, settlePending]);

  /** 删除提交（确认态第二击）：登记 pending → 30s 兜底 → cmd.request 上行；投递失败即收尾报错 */
  const submitDelete = useCallback(
    (id: string) => {
      const reqId = `sess-del-${Date.now()}`;
      pendingReqs.current.set(reqId, { id, op: 'delete' });
      setPendingOps((prev) => new Map(prev).set(id, 'delete'));
      setConfirmingId(null);
      setOpenRowId(null);
      pendingTimers.current.set(
        reqId,
        setTimeout(() => settlePending(reqId), PENDING_TIMEOUT_MS), // 超时静默收尾：桌面离线暂存的命令经回流兜底收敛
      );
      session.sendCmdRequest(reqId, 'session.delete', { sessionId: id }).catch(() => {
        settlePending(reqId, '投递失败，桌面可能离线；恢复连接后重试');
      });
    },
    [session, settlePending],
  );

  /** 重命名提交（✓/键盘完成；行内已判 submit）：未连接=留住编辑态诚实提示；否则收输入框、标题仍显示旧值等回流 */
  const submitRename = useCallback(
    (id: string, title: string) => {
      if (!props.connected) {
        // sendCmdRequest 未连接时静默空转——入口前置拦截（不假落定），编辑态保留由用户决定去留
        Alert.alert('无法重命名会话', '桌面未连接，恢复连接后再试');
        return;
      }
      const reqId = `sess-rn-${Date.now()}`;
      pendingReqs.current.set(reqId, { id, op: 'rename' });
      setPendingOps((prev) => new Map(prev).set(id, 'rename'));
      setEditingId(null);
      pendingTimers.current.set(
        reqId,
        setTimeout(() => settlePending(reqId), PENDING_TIMEOUT_MS),
      );
      session.sendCmdRequest(reqId, 'session.rename', { sessionId: id, title }).catch(() => {
        settlePending(reqId, '投递失败，桌面可能离线；恢复连接后重试');
      });
    },
    [props.connected, session, settlePending],
  );

  /** 折叠切换 + 本地记忆（syncState.expandedProjectsJson） */
  const toggle = useCallback(
    (key: string) => {
      setExpanded((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        void (async () => {
          try {
            const db = getSyncDb();
            const agentId = session.getAgentId();
            const st = await db.getSyncState(agentId);
            await db.putSyncState({
              agentId,
              attachedSessionId: st?.attachedSessionId ?? null,
              projectsRev: st?.projectsRev ?? null,
              catalogSyncedAt: st?.catalogSyncedAt ?? null,
              expandedProjectsJson: JSON.stringify(next),
              lastChatSessionId: st?.lastChatSessionId ?? null,
            });
          } catch {
            /* 记忆落库失败不影响当次展开 */
          }
        })();
        return next;
      });
    },
    [session],
  );

  const manageStateOf = useCallback(
    (id: string): SessionRowManageState => {
      if (pendingOps.get(id) === 'delete') return 'submitting';
      if (confirmingId === id) return 'confirming';
      if (openRowId === id) return 'open';
      return 'closed';
    },
    [pendingOps, confirmingId, openRowId],
  );

  /** 编辑态反悔：点编辑行以外的任何地方先退出编辑（第一次点击只退出、不触发自身动作） */
  const swallowIfEditingElsewhere = (id?: string): boolean => {
    if (editingId && editingId !== id) {
      setEditingId(null);
      return true;
    }
    return false;
  };

  const items = useMemo(() => {
    // 行 UI 态随数据走（LegendList 只在 data 身份变化时重渲行——真机教训，见文件头）
    // 运行态：volatile 集合现读（runningTick 依赖驱动重算；不触发 DB 重读）
    const running = session.getRunningSessions();
    const out: ListItem[] = [];
    for (const sec of sections) {
      const isOpen = expanded[sec.key] === true;
      out.push({ type: 'header', section: sec, expanded: isOpen });
      if (isOpen) {
        for (const row of sec.rows) {
          out.push({
            type: 'session',
            row,
            isChatting: row.sessionId === chattingId,
            isRunning: running.has(row.sessionId),
            manageState: manageStateOf(row.sessionId),
            editing: editingId === row.sessionId,
            renameSubmitting: pendingOps.get(row.sessionId) === 'rename',
          });
        }
      }
    }
    return out;
  }, [sections, expanded, chattingId, manageStateOf, editingId, pendingOps, session, props.runningTick]);

  const renderItem = ({ item }: { item: ListItem }) => {
    if (item.type === 'header') {
      const { section } = item;
      return (
        <TouchableOpacity
          style={styles.sectionHeader}
          onPress={() => {
            if (swallowIfEditingElsewhere()) return;
            toggle(section.key);
          }}
          activeOpacity={0.7}
        >
          <Text style={styles.sectionArrow}>{item.expanded ? '▾' : '▸'}</Text>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          <Text style={styles.sectionCount}>{section.rows.length}</Text>
        </TouchableOpacity>
      );
    }
    const { row } = item;
    return (
      <SessionRowItem
        row={row}
        isChatting={item.isChatting}
        isRunning={item.isRunning}
        manageState={item.manageState}
        editing={item.editing}
        renameSubmitting={item.renameSubmitting}
        onOpenChat={() => {
          if (swallowIfEditingElsewhere(row.sessionId)) return;
          props.onOpenChat(row.sessionId);
        }}
        onSwipeOpen={() => {
          if (editingId) setEditingId(null); // 滑开他行即退出进行中的编辑
          setOpenRowId(row.sessionId);
          setConfirmingId(null);
        }}
        onDismiss={() => {
          if (swallowIfEditingElsewhere(row.sessionId)) return;
          setOpenRowId((prev) => (prev === row.sessionId ? null : prev));
          setConfirmingId((prev) => (prev === row.sessionId ? null : prev));
        }}
        onTapDelete={() => {
          if (!props.connected) {
            // sendCmdRequest 未连接时静默空转——入口前置拦截（不假落定）
            Alert.alert('无法删除会话', '桌面未连接，恢复连接后再试');
            return;
          }
          setConfirmingId(row.sessionId);
        }}
        onTapConfirm={() => submitDelete(row.sessionId)}
        onLongPressRow={() => {
          if (pendingOps.has(row.sessionId)) return; // 提交中不可编辑
          if (!props.connected) {
            Alert.alert('无法重命名会话', '桌面未连接，恢复连接后再试');
            return;
          }
          setEditingId(row.sessionId);
          setOpenRowId(null);
          setConfirmingId(null);
        }}
        onSubmitEdit={(text) => submitRename(row.sessionId, text)}
        onCancelEdit={() => setEditingId(null)}
      />
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={props.onBack}>
          <Text style={styles.backLink}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>历史会话</Text>
        <Text style={styles.statusDot}>{props.connected ? '🟢' : '🔴'}</Text>
      </View>
      {/* 键盘几何直驱（ChatScreen 同款）：编辑态弹键盘时列表底部逐帧让位。
          编辑态反悔：容器 onStartShouldSetResponder——RN responder 深层优先（行 pan/TextInput/分区头
          都先认领），只有空白处的点按冒泡到容器；非编辑态返回 false 零影响；滚动经默认
          onResponderTerminationRequest=true 夺回，不误退编辑 */}
      <Reanimated.View
        style={[styles.list, kavAnimStyle]}
        onStartShouldSetResponder={() => editingId !== null}
        onResponderRelease={() => setEditingId(null)}
      >
        <LegendList
          style={styles.list}
          data={items}
          keyExtractor={(it) => (it.type === 'header' ? `h-${it.section.key}` : `s-${it.row.sessionId}`)}
          renderItem={renderItem}
          recycleItems
          onScroll={() => {
            // 滚动即收回滑开/确认行（submitting 不受 dismiss——由状态机保证，这里只清屏级行态的非提交项）
            if (openRowId) setOpenRowId(null);
            if (confirmingId) setConfirmingId(null);
          }}
        />
      </Reanimated.View>
      {items.length === 0 ? <Text style={styles.empty}>还没有会话——回桌面聊一句就会出现</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0f14' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
    marginTop: 36,
  },
  backLink: { color: '#3b82f6', fontSize: 26, paddingHorizontal: 6 },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  statusDot: { fontSize: 12, width: 32, textAlign: 'right' },
  list: { flex: 1 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 6,
    backgroundColor: '#0b0f14',
  },
  sectionArrow: { color: '#6b7280', fontSize: 12, width: 14 },
  sectionTitle: { color: '#d1d5db', fontSize: 14, fontWeight: '600', flex: 1 },
  sectionCount: { color: '#6b7280', fontSize: 12 },
  swipeWrap: {
    position: 'relative',
    overflow: 'hidden',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2937',
  },
  swipeActions: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    flexDirection: 'row',
  },
  swipeDelete: {
    backgroundColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swipeDeleteConfirm: { backgroundColor: '#b91c1c' },
  swipeDeleteBusy: { backgroundColor: '#991b1b' },
  swipeDeleteLabel: { color: '#fff', fontSize: 14, fontWeight: '600', letterSpacing: 1 },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingLeft: 36,
    paddingVertical: 10,
    gap: 10,
    backgroundColor: '#0b0f14',
  },
  sessionRowFading: { opacity: 0.45 },
  sessionMain: { flex: 1, gap: 2 },
  sessionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sessionTitle: { color: '#e5e7eb', fontSize: 15, flexShrink: 1 },
  titleInput: {
    flex: 1,
    backgroundColor: '#111827',
    borderWidth: 1.5,
    borderColor: '#3b82f6',
    borderRadius: 8,
    color: '#fff',
    fontSize: 15,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  editActions: { flexDirection: 'row', gap: 6 },
  editBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  editBtnOk: { backgroundColor: '#3b82f6' },
  editBtnOkText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  editBtnNo: { backgroundColor: '#1f2937' },
  editBtnNoText: { color: '#9ca3af', fontSize: 15, fontWeight: '700' },
  editBtnDisabled: { opacity: 0.4 },
  editBusy: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  editBusyText: { color: '#6b7280', fontSize: 11.5 },
  rowTrailing: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  currentBadge: { color: '#4ade80', fontSize: 11 },
  sessionPreview: { color: '#6b7280', fontSize: 12 },
  sessionTime: { color: '#4b5563', fontSize: 11 },
  empty: { color: '#374151', fontSize: 13, textAlign: 'center', marginTop: 60 },
});

export { UNGROUPED_KEY };
