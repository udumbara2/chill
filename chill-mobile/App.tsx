/**
 * App.tsx — chill 手机端（M6：react-navigation 三屏）。
 * 导航范式：逐级下钻 drill-down stack（AgentList → SessionList → Chat[+Settings]），
 * 层级只对应真实边界（Agent=信任边界 / 聊天=内容边界；项目只是分组标签，不占一级导航）。
 * 配对/错误全屏态保留为导航外层分支（need-pairing/conflict/expired/orphan-revoked/error）。
 * 冷启动一律落 Agent 列表屏（附着对账规则①：不自动回聊天屏）。
 * 审批/提问卡 = 全局浮层（不在聊天屏时顶部悬浮；聊天屏内维持消息流内卡片）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, SafeAreaView, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { enableScreens } from 'react-native-screens';
import { NavigationContainer, createNavigationContainerRef, StackActions } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RelaySession, type SessionState } from './src/relay/session';
import type { CommandCatalogEntry, CommandStateSnapshot } from './src/relay/envelope';
import PairingScreen from './src/screens/PairingScreen';
import ChatScreen from './src/screens/ChatScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import AgentListScreen from './src/screens/AgentListScreen';
import SessionListScreen from './src/screens/SessionListScreen';
import FloatingCards, { type FloatingCardData } from './src/components/FloatingCards';
import IdeaFloatBall, { loadBallSettings, saveBallSettings } from './src/components/IdeaFloatBall';
import IdeaCaptureSheet from './src/components/IdeaCaptureSheet';
import { ConfirmedListSheet } from './src/components/ConfirmedListSheet';
import { updater } from './src/updater/updater';
import { UpdateOverlay } from './src/updater/UpdateOverlay';
import { updateFeedPath, parseManifest, shouldCheckUpdate } from './src/updater/feed';
import { loadPhoneState, savePhoneState } from './src/relay/storage';
import { httpBase } from './src/relay/http';
import { startRelayForegroundService } from './src/bg';
import { getSyncDb } from './src/db/syncDb';
import { resolveDefaultChatTarget, nextFloatingCardPhases, turnCourtPage, type FloatingCardPhase } from './src/screens/syncUiLogic';

enableScreens();

export type RootStackParamList = {
  AgentList: undefined;
  SessionList: undefined;
  /** sessionId：真实 id 或 'new'（新会话界面，发言即建）；pinned=true 从会话列表钉入（返回回列表） */
  Chat: { sessionId: string; title: string; pinned: boolean };
  Settings: undefined;
  /** M6b：配对屏为 push 路由（不再当启动屏；进屏不清配对，resetPairing 保留为屏内带确认逃生口） */
  Pairing: undefined;
};

const navigationRef = createNavigationContainerRef<RootStackParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const session = useMemo(() => new RelaySession(), []);
  const [state, setState] = useState<SessionState>('need-pairing');
  const [stateDetail, setStateDetail] = useState('');
  const [connected, setConnected] = useState(false);
  // M6b：'我的桌面'是唯一默认文案（标题传递链：AgentList 行名 / Settings 对端名 / 浮层直达）
  const [peerName, setPeerName] = useState('我的桌面');
  const [permissionMode, setPermissionMode] = useState<string | null>(null); // M5：null=未同步
  /** M8：命令面状态快照（cmd.state latest-wins；内存态随事件更新，null=未同步） */
  const [commandState, setCommandState] = useState<CommandStateSnapshot | null>(null);
  const [commandCatalog, setCommandCatalog] = useState<CommandCatalogEntry[] | null>(null);
  /** 目录刷新信号（catalog 落库/session.event 目录行变更 → 序号递增，列表屏据此重读副本库） */
  const [catalogTick, setCatalogTick] = useState(0);
  /** 运行态标志：运行中会话集合变化信号（列表"运行中"转圈重渲；与 catalogTick 分立——不触发 DB 重读） */
  const [runningTick, setRunningTick] = useState(0);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  /** 全局浮层卡（最新一张未落定审批/提问；落定即消——唯一消散触发是 resolved 信封） */
  // 归因分流（规划 v5）：浮层数据源改 getCardsSnapshot 派生（未落定卡集合）——消灭单槽"挤出/误清"两病灶；
  // 呈现硬契约：所有未落定卡可发现（堆叠渲染，禁仅最新一张）
  const [floatingCards, setFloatingCards] = useState<FloatingCardData[]>([]);
  /** 裁决卡二态阶段（App 受控持有：召唤回执要跨快照强制展开）+ 展开信号（召唤→卡的本地握手） */
  const [courtPhases, setCourtPhases] = useState<Record<string, FloatingCardPhase>>({});
  const courtPhasesRef = useRef<Record<string, FloatingCardPhase>>({});
  const expandSignalAtRef = useRef<number | null>(null);
  const recomputeFloating = useCallback(() => {
    const snap = session.getCardsSnapshot();
    const cards = [
      ...snap.approval.filter((c) => !c.settled).map((c) => ({ kind: 'approval' as const, info: c })),
      ...snap.ask.filter((c) => !c.settled).map((c) => ({ kind: 'ask' as const, info: c })),
    ];
    setFloatingCards(cards);
    // 裁决卡阶段推进：到达一律隐匿（冷启动重放/重连重推不打扰）、召唤信号强制展开；
    // 二态壳只收无归因卡（纯旁路）——归因卡（模型开庭）跨会话浮出时走 v5 紧凑卡+跳转
    const courtIds = cards
      .filter((c) => c.kind === 'ask' && c.info.card !== undefined && c.info.sessionId == null)
      .map((c) => c.info.id);
    const r = nextFloatingCardPhases({
      courtCardIds: courtIds,
      prev: courtPhasesRef.current,
      expandSignalAt: expandSignalAtRef.current,
      now: Date.now(),
    });
    courtPhasesRef.current = r.phases;
    setCourtPhases(r.phases);
    if (!r.signalLive) expandSignalAtRef.current = null; // 已消费或已过期：清信号
  }, [session]);
  // 查看会话变化 → 门控重求值（viewingSessionId 是门控条件之一；单一事实源）
  useEffect(() => session.onViewingSessionChange(() => recomputeFloating()), [recomputeFloating]);
  /** 当前路由名（浮层门控：聊天屏内由消息流内卡片呈现，浮层不重复出现） */
  const [currentRoute, setCurrentRoute] = useState<string>('AgentList');
  /** M6c：桌面在线（近期有桌面来信；绿点=connected && desktopOnline——绿点不骗人） */
  const [desktopOnline, setDesktopOnline] = useState(false);
  /** 闪念回执 toast（R3：App 根级 cmdResult 订阅——与发起面板解耦，迟到到达同样触发） */
  const [ideaToast, setIdeaToast] = useState<{ text: string; at: number } | null>(null);
  /** App 级记点子面板（悬浮球单击打开——任意屏可用） */
  const [ideaSheetOpen, setIdeaSheetOpen] = useState(false);
  /** D 迭代：已确认清单弹层（长按💡空态打开；App 级任意屏可用） */
  const [confirmedSheetOpen, setConfirmedSheetOpen] = useState(false);
  /** 悬浮球显示开关（设置屏拨动；持久化在悬浮球 KV 的 hidden 字段） */
  const [ballHidden, setBallHidden] = useState(false);
  const ideaAvailable = (commandCatalog ?? []).some((c) => c.id === 'idea');
  /** 提案决策（悬浮球长按入口的目录门）：目录有才接长按，否则长按无效果（诚实降级，不落回 idea） */
  const improveAvailable = (commandCatalog ?? []).some((c) => c.id === 'improve');
  const submitIdea = async (text: string): Promise<string | null> => {
    try {
      await session.sendCmdRequest(`idea-${Date.now()}`, 'idea', { text });
      return null;
    } catch (err) {
      return `投递失败：${err instanceof Error ? err.message : String(err)}`;
    }
  };
  // 启动恢复悬浮球开关（位置记忆在球自身 KV，这里只读 hidden 标志）
  useEffect(() => {
    void loadBallSettings().then((s) => {
      if (s?.hidden) setBallHidden(true);
    });
  }, []);

  useEffect(() => {
    const off = session.on((e) => {
      if (e.type === 'state') {
        setState(e.state);
        setStateDetail(e.detail ?? '');
        if (e.state === 'paired') {
          void startRelayForegroundService();
          // M6b：配对成功自动落 Agent 列表（配对屏是 push 路由，落定即返回主界面）
          if (navigationRef.isReady() && navigationRef.getCurrentRoute()?.name === 'Pairing') {
            navigationRef.goBack();
          }
        }
      } else if (e.type === 'message') {
        // 审批/提问卡事件 → 浮层重算（快照派生：pending 集合；时间线内呈现由 ChatScreen 归因过滤负责）
        const m = e.message;
        if ((m.kind === 'approval' && m.approval) || (m.kind === 'ask' && m.ask)) {
          recomputeFloating();
        }
      } else if (e.type === 'peer') {
        setPeerName(e.name);
      } else if (e.type === 'connection') {
        setConnected(e.connected);
      } else if (e.type === 'mode') {
        setPermissionMode(e.mode);
      } else if (e.type === 'cmdState') {
        // M8：占用环/规划徽标/会话 sheet 值的唯一落定来源（本地不假落定）
        setCommandState(e.state);
        if (e.catalog) setCommandCatalog(e.catalog);
      } else if (e.type === 'catalog') {
        setCatalogTick((n) => n + 1);
      } else if (e.type === 'running') {
        // 运行态标志：集合变化才发（session.ts 防抖）——列表转圈重渲的唯一信号
        setRunningTick((n) => n + 1);
      } else if (e.type === 'activeSession') {
        setActiveSessionId(e.sessionId);
      } else if (e.type === 'attached') {
        setCatalogTick((n) => n + 1);
      } else if (e.type === 'lastChat') {
        // M6b：入口记忆变化 → 列表徽标/Agent 摘要刷新（"📱正在聊"的唯一数据源）
        setCatalogTick((n) => n + 1);
      } else if (e.type === 'presence') {
        setDesktopOnline(e.online);
      } else if (e.type === 'cmdResult') {
        // 闪念捕获回执（replyTo 前缀路由；面板可能已关/迟到到达——根级订阅是唯一收口）
        if (e.replyTo.startsWith('idea-')) {
          const d = (e as { data?: { duplicated?: boolean; truncated?: boolean } }).data;
          const text = !e.ok
            ? `点子未入库：${e.error?.message ?? '失败'}`
            : d?.duplicated
              ? '该点子刚记过（防重），未重复入账'
              : `✓ 点子已入改进提案（闪念簇）${d?.truncated ? '，超长已截断' : ''} · 桌面 /improve 可决策`;
          setIdeaToast({ text, at: Date.now() });
        } else if (e.replyTo.startsWith('desktop-set-')) {
          // 宿主级开关回执（迭代 B）：方向由 ☰ 行值经 cmd.state 落定回显，toast 只报结果与探测（available 仅 on 分支回流）
          const d = (e as { data?: { available?: boolean } }).data;
          const text = !e.ok
            ? `桌面能力设置失败：${e.error?.message ?? '失败'}`
            : d?.available === false
              ? '⚠ 已开启，但电脑缺少桌面原生模块（需重建或无 prebuild）'
              : '✓ 桌面能力开关已更新（☰ 可见最新状态）';
          setIdeaToast({ text, at: Date.now() });
        } else if (e.replyTo.startsWith('autoswitch-set-')) {
          const text = !e.ok
            ? `自动切换设置失败：${e.error?.message ?? '失败'}`
            : '✓ 自动切换已更新（☰ 可见最新状态）';
          setIdeaToast({ text, at: Date.now() });
        } else if (e.replyTo.startsWith('improve-')) {
          // 提案决策召唤回执（三态：裁决卡已发出/已重推/没有待确认提案——文案由桌面执行器供给）；
          // 成功回执 = 展开信号（本地事实区分"自己刚召唤"与"重连重推"——重推不该重新打扰，
          // 但用户再次召唤 = 再次邀请，卡必须亮出来）。
          // D 迭代：空态（court==='empty'）升级为已确认清单视图——目录含 improve.confirmed 时
          // 打开清单弹层替代纯 toast（旧桌面目录无此命令则维持 toast 降级）
          const d = (e as { data?: { message?: string; court?: string } }).data;
          // D 迭代：空态（court==='empty'）升级为已确认清单视图（目录门控已弃——internal 命令不进目录；
          // 旧桌面拉取 improve.confirmed 会得 unsupported，清单弹层错误态诚实降级）
          const emptyToSheet = e.ok && d?.court === 'empty';
          const text = !e.ok
            ? `提案决策失败：${e.error?.message ?? '失败'}`
            : emptyToSheet
              ? '没有待确认提案——已打开已确认清单'
              : d?.message ?? '裁决卡已发出';
          if (emptyToSheet) setConfirmedSheetOpen(true);
          else setIdeaToast({ text, at: Date.now() });
          if (e.ok && !emptyToSheet) {
            expandSignalAtRef.current = Date.now();
            recomputeFloating();
          }
        }
      }
    });
    void session.start();
    // M6c：前台才探活（AppState 驱动）——后台不发 ping，堆积被前台时长限住
    session.setPresenceActive(AppState.currentState === 'active');
    // ---------- 更新发现（App 级）：启动+回前台拉清单（频控 ≥60s；失败静默绝不打扰） ----------
    let updateChecking = false;
    const checkUpdateFeed = async (): Promise<void> => {
      if (updateChecking) return;
      updateChecking = true;
      try {
        const st = await loadPhoneState();
        if (!st) return; // 未配对：无 deskPub 即无 feed，跳过
        if (!shouldCheckUpdate(st.lastUpdateCheckAt, Date.now())) return;
        const feedPath = updateFeedPath(st.deskPub);
        if (!feedPath) return;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        try {
          // RN fetch 派生自 MainApplication 证书固定的全局 OkHttp（与 httpJson 同一信任根——运行时实证）
          const res = await fetch(`${httpBase(st.relay)}/static/${feedPath}`, { signal: ctrl.signal });
          // 取到响应（含 404=服务器明确答复）才推进频控钟；网络错误不消耗间隔。
          // 诊断面：结果码随钟一并落 PhoneState（设置页一行可见——静默失败断了哪环肉眼可查）
          let status: string;
          if (!res.ok) {
            status = `http-${res.status}`;
          } else {
            const manifest = parseManifest(await res.text(), st.deskPub);
            if (!manifest) {
              status = 'bad-manifest';
            } else {
              const phase = await updater.offer(manifest, st.dismissedSnapshot ?? null);
              status = phase === 'available' ? `found:${manifest.snapshot}` : 'up-to-date';
            }
          }
          // 落盘前重读合并（检查窗口 ≤10s 内可能有 dismissed 持久化写入——用开头拍的旧快照会把它覆写回去，卡片复活）
          const fresh = (await loadPhoneState()) ?? st;
          await savePhoneState({ ...fresh, lastUpdateCheckAt: Date.now(), lastUpdateStatus: status });
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // 网络错误：频控钟不动（下次打开即重试）；尽力记一条诊断（记录本身失败也静默）
        try {
          const st = await loadPhoneState();
          if (st) await savePhoneState({ ...st, lastUpdateStatus: 'network-error' });
        } catch {
          /* 静默 */
        }
      } finally {
        updateChecking = false;
      }
    };
    void checkUpdateFeed();
    // dismissed 订阅缝：用户点"稍后" → updater 内存锚一次性取走 → 持久化 PhoneState（跨会话去重）
    const offDismissed = updater.subscribe(() => {
      const d = updater.consumeDismissed();
      if (d !== null) {
        void loadPhoneState()
          .then((st) => (st ? savePhoneState({ ...st, dismissedSnapshot: d }) : undefined))
          .catch(() => {});
      }
    });
    const appStateSub = AppState.addEventListener('change', (s) => {
      session.setPresenceActive(s === 'active');
      if (s === 'active') void checkUpdateFeed();
    });
    return () => {
      appStateSub.remove();
      offDismissed();
      off();
    };
  }, [session]);

  // 闪念回执 toast：3.6s 自动消散
  useEffect(() => {
    if (!ideaToast) return;
    const t = setTimeout(() => setIdeaToast(null), 3600);
    return () => clearTimeout(t);
  }, [ideaToast]);

  /** 浮层点卡身直达：附着会话优先，否则桌面当前会话；标题从副本库现查；直达即"正在聊"（记入口记忆） */
  const jumpToChat = async (targetSid?: string) => {
    const sid = targetSid ?? session.getAttachedSessionId() ?? session.getActiveSessionId();
    if (!sid || !navigationRef.isReady()) return;
    let title = '';
    try {
      const rows = await getSyncDb().listSessions(session.getAgentId());
      title = rows.find((r) => r.sessionId === sid)?.title ?? '';
    } catch {
      /* 标题缺省为空 */
    }
    void session.setLastChatSession(sid);
    navigationRef.navigate('Chat', { sessionId: sid, title, pinned: true });
  };

  /**
   * 点"我的桌面"直达默认聊天屏（M6b 主路径）：
   * 入口记忆有效（仍存在目录中）→ 进该会话；从未聊过/记忆悬空 → 'new' 新会话界面（空屏，发言即建）。
   * 悬空校验第二层（第一层 = catalog deletes 命中即清，syncReducer）；发现悬空即清记忆。
   */
  const openDefaultChat = async () => {
    if (!navigationRef.isReady()) return;
    const lastChat = session.getLastChatSessionId();
    let target = 'new';
    let title = '';
    try {
      const rows = await getSyncDb().listSessions(session.getAgentId());
      target = resolveDefaultChatTarget(lastChat, new Set(rows.map((r) => r.sessionId)));
      if (target === 'new' && lastChat !== null) void session.setLastChatSession(null);
      else if (target !== 'new') title = rows.find((r) => r.sessionId === target)?.title ?? '';
    } catch {
      target = lastChat ?? 'new'; // 副本库不可用：信记忆（附着对账会兜底收敛）
    }
    navigationRef.navigate('Chat', { sessionId: target, title, pinned: false });
  };

  const pairStatusText =
    state === 'redeeming'
      ? '已扫码，正在登记（redeem）…'
      : state === 'waiting-confirm'
        ? '已登记，等待桌面确认配对…'
        : stateDetail;

  // 409 全屏错误（真抢兑检测链的一环）
  if (state === 'conflict') {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.fullError}>
          <Text style={styles.fullErrorTitle}>❌ 配对令牌已被使用</Text>
          <Text style={styles.fullErrorBody}>
            该配对令牌已在别处被消费，令牌可能泄露。{'\n\n'}请勿重试本二维码。请在桌面端 chill 执行 /pair list 审计已配对设备，revoke 陌生设备后重新出码配对。
          </Text>
          <TouchableOpacity style={styles.btn} onPress={() => void session.resetPairing()}>
            <Text style={styles.btnText}>清除本地状态，重新扫码</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }
  if (state === 'expired' || state === 'orphan-revoked' || state === 'error') {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.fullError}>
          <Text style={styles.fullErrorTitle}>
            {state === 'expired' ? '配对令牌已过期' : state === 'orphan-revoked' ? '对端未确认配对' : '出错了'}
          </Text>
          <Text style={styles.fullErrorBody}>
            {state === 'expired'
              ? '已停止重试。请在桌面重新出码后再扫。'
              : state === 'orphan-revoked'
                ? '10 分钟未收到合法配对确认，已注销双侧信箱。请重新扫码配对。'
                : stateDetail}
          </Text>
          <TouchableOpacity style={styles.btn} onPress={() => void session.resetPairing()}>
            <Text style={styles.btnText}>重新扫码</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // M6b 根因修正：主界面（NavigationContainer）无条件挂载、首屏永远落 Agent 列表——
  // 不再有"state 未恢复就渲染配对屏"的全屏门（原 App.tsx:144 `state !== 'paired'` 分支，
  // 是"每次启动先见扫码屏"的根因）。未配对空态引导在 Agent 列表屏内；配对屏为 push 路由；
  // 配对错误态（409/410/吊销/error）保留上方外层全屏提示。

  return (
    // preload={false}：防启动时键盘短暂闪现（官方安装文档明示的规避法）
    <KeyboardProvider preload={false}>
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" />
        <NavigationContainer
          ref={navigationRef}
          onStateChange={() => setCurrentRoute(navigationRef.getCurrentRoute()?.name ?? 'AgentList')}
        >
          <Stack.Navigator
            initialRouteName="AgentList"
            screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0b0f14' } }}
          >
            <Stack.Screen name="AgentList">
              {() => (
                <AgentListScreen
                  session={session}
                  connected={connected}
                  desktopOnline={desktopOnline}
                  paired={state === 'paired'}
                  catalogTick={catalogTick}
                  onOpenChat={() => void openDefaultChat()}
                  onOpenPairing={() => navigationRef.navigate('Pairing')}
                  onOpenSettings={() => navigationRef.navigate('Settings')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="SessionList">
              {() => (
                <SessionListScreen
                  session={session}
                  connected={connected}
                  catalogTick={catalogTick}
                  runningTick={runningTick}
                  onOpenChat={(sessionId) => {
                    void (async () => {
                      let title = '';
                      try {
                        const rows = await getSyncDb().listSessions(session.getAgentId());
                        title = rows.find((r) => r.sessionId === sessionId)?.title ?? '';
                      } catch {
                        /* 标题缺省 */
                      }
                      navigationRef.dispatch(StackActions.push('Chat', { sessionId, title, pinned: true }));
                    })();
                  }}
                  onBack={() => navigationRef.goBack()}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Chat">
              {({ route }) => (
                <ChatScreen
                  session={session}
                  sessionId={route.params.sessionId}
                  title={route.params.title}
                  pinned={route.params.pinned}
                  connected={connected}
                  desktopOnline={desktopOnline}
                  onApprovalDecision={(id, decision) => session.sendApprovalResponse(id, decision)}
                  onAskAnswer={(id, answer, decisions) => session.sendAskResponse(id, answer, decisions)}
                  onBack={() => navigationRef.goBack()}
                  onNewChat={() => navigationRef.dispatch(StackActions.push('Chat', { sessionId: 'new', title: '', pinned: true }))}
                  onOpenHistory={() => navigationRef.navigate('SessionList')}
                  onOpenIdeaCapture={() => setIdeaSheetOpen(true)}
                  permissionMode={permissionMode}
                  onToggleMode={(m) => void session.sendModeSet(m).catch(() => {})}
                  commandState={commandState}
                  commandCatalog={commandCatalog}
                  runningTick={runningTick}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Settings">
              {() => (
                <SettingsScreen
                  peerName={peerName}
                  state={state}
                  connected={connected}
                  desktopOnline={desktopOnline}
                  ideaBallAvailable={ideaAvailable}
                  ideaBallVisible={!ballHidden}
                  onToggleIdeaBall={(v) => {
                    setBallHidden(!v);
                    // 持久化：与悬浮球位置同一 KV（hidden 字段；位置字段原样保留）
                    void loadBallSettings().then((s) => {
                      void saveBallSettings({ yRatio: s?.yRatio ?? 0.6, right: s?.right ?? true, hidden: !v });
                    });
                  }}
                  onRePair={() => navigationRef.navigate('Pairing')}
                  onPair={() => navigationRef.navigate('Pairing')}
                  onResetPairing={() => void session.resetPairing()}
                  onBack={() => navigationRef.goBack()}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Pairing">
              {() => (
                <PairingScreen
                  onQr={(qr) => void session.pair(qr)}
                  statusText={state === 'paired' ? '已配对——扫新码可换绑新令牌' : pairStatusText}
                  onBack={() => navigationRef.goBack()}
                />
              )}
            </Stack.Screen>
          </Stack.Navigator>
          {/* 全局浮层（归因分流 v5）：门控=本意表达——不在聊天屏，或存在不会出现在当前时间线的卡
              （无归因全局请示 / 归因≠当前查看会话）时渲染；聊天屏内且卡均在当前时间线则不重复呈现 */}
          {currentRoute !== 'Chat' ||
          floatingCards.some((c) => c.info.sessionId == null || c.info.sessionId !== session.getViewingSessionId()) ? (
            <FloatingCards
              cards={floatingCards}
              courtPhases={courtPhases}
              onSetCourtPhase={(id, phase) => {
                courtPhasesRef.current = { ...courtPhasesRef.current, [id]: phase };
                setCourtPhases(courtPhasesRef.current);
                // 收起=完全隐去：给一次回程提示（发现性由重唤手势兜底，提示教一次路）
                if (phase === 'parked') setIdeaToast({ text: '已收起 · 长按 💡 随时再打开', at: Date.now() });
              }}
              onApprovalDecision={(id, decision) => session.sendApprovalResponse(id, decision)}
              onAskAnswer={(id, answer, decisions) => session.sendAskResponse(id, answer, decisions)}
              onTurnPage={(dir, decisions) => turnCourtPage(session, dir, decisions)}
              onJumpToChat={(sid) => void jumpToChat(sid)}
            />
          ) : null}
        </NavigationContainer>
        {/* 闪念悬浮球（App 级 · 可拖动贴边 · 目录含 idea 且设置开关未关——npm 模式/关闭时零渲染）。
            长按=召唤提案裁决卡（仅目录含 improve 时接线；回执走根级 improve- toast 路由） */}
        {state === 'paired' && ideaAvailable && !ballHidden ? (
          <IdeaFloatBall
            onPress={() => setIdeaSheetOpen(true)}
            onLongPress={
              improveAvailable
                ? () => void session.sendCmdRequest(`improve-${Date.now()}`, 'improve', {}).catch(() => {})
                : undefined
            }
          />
        ) : null}
        {/* 记点子面板（悬浮球/＋菜单/☰行共用；回执走根级 cmdResult toast） */}
        <IdeaCaptureSheet visible={ideaSheetOpen} onClose={() => setIdeaSheetOpen(false)} onSubmit={submitIdea} />
        {/* D 迭代：已确认/已关闭清单弹层（长按💡空态打开——cmdResult court==='empty' 路由） */}
        <ConfirmedListSheet visible={confirmedSheetOpen} session={session} onClose={() => setConfirmedSheetOpen(false)} />
        {/* 闪念回执 toast（R3：根级呈现，任何屏可见；3.6s 自动消散） */}
        {ideaToast ? (
          <View style={styles.ideaToastWrap} pointerEvents="none">
            <View style={styles.ideaToast}>
              <Text style={styles.ideaToastText}>{ideaToast.text}</Text>
            </View>
          </View>
        ) : null}
        {/* 更新浮层（App 级挂载：发现/下载/确认/失败/done——任何屏可见；含 available 发现卡） */}
        <UpdateOverlay />
      </SafeAreaView>
    </KeyboardProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0f14' },
  fullError: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  fullErrorTitle: { color: '#ef4444', fontSize: 20, fontWeight: '700' },
  fullErrorBody: { color: '#d1d5db', fontSize: 14, lineHeight: 22, marginTop: 16, textAlign: 'center' },
  btn: { backgroundColor: '#3b82f6', borderRadius: 8, padding: 12, marginTop: 24, paddingHorizontal: 24 },
  btnText: { color: '#fff', fontWeight: '600' },
  ideaToastWrap: { position: 'absolute', left: 0, right: 0, top: 54, alignItems: 'center', zIndex: 90 },
  ideaToast: {
    backgroundColor: '#143626',
    borderColor: '#1e5c3c',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    maxWidth: '86%',
  },
  ideaToastText: { color: '#9fd8b4', fontSize: 12.5 },
});
