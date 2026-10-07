/**
 * ChatScreen.tsx — M6 屏 3：会话聊天屏（DB 驱动改造）。
 *
 * 数据源（类五改造）：DB 副本（syncDb.messages，rowsToChatMessages 映射渲染）为基底，
 * 附着会话实时流作为"尾追加 overlay"（chat.event 直推，落定后由尾部拉齐进 DB、overlay 清除）。
 * - 进入即 sendAttach(sessionId) + 拉最新一页；离开（卸载）即 sendAttach(null)——不假落定：
 *   attached.changed 确认到达前实时区显示"同步中"。
 * - 上翻（onStartReached）：先读 DB 更早一页，DB 见底且桌面还有（isHistoryComplete=false）
 *   才 sendHistoryRequest(before=已持有最早 msgKey) 向桌面拉。
 * - 历史类型映射渲染：text 正文（reasoningContent 拆思考行）/ tool 工具行 / notice 提示行 /
 *   media 占位"请在桌面查看"（映射规则见 syncUiLogic.rowsToChatMessages）。
 * - 滚动/键盘/思考区/工具行/审批卡/提问卡/档位徽标全部沿用 M4i/M5 既有组件与几何不动点范式。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  Dimensions,
  Image,
  Modal,
  Pressable,
  ActivityIndicator,
  Vibration,
} from 'react-native';
import { LegendList } from '@legendapp/list/react-native';
import type { LegendListRef } from '@legendapp/list/react-native';
import { useFocusEffect } from '@react-navigation/native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { MarkdownText } from '../components/MarkdownText';
import { WorkPlanPanel } from '../components/WorkPlanPanel';
import ContextRing from '../components/ContextRing';
import SessionSheet from '../components/SessionSheet';
import MemorySheet from '../components/MemorySheet';
import ModelPickerSheet from '../components/ModelPickerSheet';
import FrontPickerSheet from '../components/FrontPickerSheet';
import CompactConfirmSheet from '../components/CompactConfirmSheet';
import { GoalStrip, GoalInputSheet, GoalStateSheet } from '../components/GoalSheet';
import type { CommandCatalogEntry, CommandStateSnapshot, AskDecisionEntry } from '../relay/envelope';
import { hostToggleNext, desktopBadgeVisible } from './hostToggleUi';
import { routeStaticUrl } from '../updater/routeStaticUrl';
import { useTrustedRelay } from '../updater/useTrustedRelay';
import { updater } from '../updater/updater';
import { ImagePreviewModal } from '../updater/ImagePreviewModal';
import { getSyncDb, type MessageRow } from '../db/syncDb';
import type { ChatMessage, FileCardInfo, RelaySession } from '../relay/session';
import { ANCHORED_STREAM, allowsMessageForSession, buildEchoSets, cursorAllowsPrepend, emptyEchoSets, fileCardPhase, mergeEchoSets, mergeLiveOverlay, pickParkableBubbles, receivedFileToMessage, retireConfirmedOverlay, retireWithSnapshot, rowsToChatMessages, turnCourtPage, type EchoSets } from './syncUiLogic';
import { pickAttachment, AttachmentTooLargeError } from '../relay/attachmentStore';
import { openDeliveredFile } from '../relay/deliverFile';
import { TriageCard } from './TriageCard';
import { validateTriageCard } from './triageLogic';
import { findCatalogCommand, resolveSlashCommand } from './commandCatalog';

/** viewability 配置必须是模块级常量（RN 系列表对渲染间变更 viewability 配置会直接抛错） */
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 };

const PAGE_SIZE = 50;

/** 提问卡问题区最大高度：超长内容（如整篇规划全文）在卡内滚动，避免淹没会话流 */
const QUESTION_MAX_HEIGHT = Math.round(Dimensions.get('window').height * 0.55);

export default function ChatScreen(props: {
  session: RelaySession;
  /** 会话 id；'new' = 新会话界面（空屏，发言即建——桥端轮前附着，attached.changed 回流真实 id 后收编） */
  sessionId: string;
  /** 会话标题（默认/新模式传空——头部主标题恒为"我的桌面"，会话标题作副标题呈现） */
  title: string;
  /** true = 从会话列表钉入（返回回列表）；false = 默认直达屏（返回回 Agent 列表） */
  pinned: boolean;
  connected: boolean;
  /** M6c：桌面在线（近期有桌面来信）；connected && !desktopOnline → 顶部黄条提示"消息会暂存" */
  desktopOnline: boolean;
  onApprovalDecision: (id: string, decision: 'approve' | 'reject' | 'session') => Promise<void>;
  /** decisions（可选）：裁决卡结构化决策随 ask.response 携带（旧桌面安全忽略，走 answer 文本回退） */
  onAskAnswer: (id: string, answer: string, decisions?: AskDecisionEntry[]) => Promise<void>;
  onBack: () => void;
  /** "＋新会话"入口（M6b 归位到聊天屏头部；走既有 'new' 机制，按钮只是入口） */
  onNewChat: () => void;
  /** M6b 验收修复：历史会话入口（设置已并回上一页——聊天屏头部只留 ＋ 与历史两个图标） */
  onOpenHistory: () => void;
  /** 记点子：打开 App 级面板（悬浮球同款；＋ 菜单行与 ☰ 行经此路由） */
  onOpenIdeaCapture?: () => void;
  /** M5：已同步的权限模式（null=未同步；徽标渲染与点击门控） */
  permissionMode: string | null;
  /** M5：请求切换权限模式（落定以 mode.state 回流为准，本地不假落定） */
  onToggleMode: (mode: string) => void;
  /** M8：命令面状态快照（cmd.state latest-wins；null=未同步。占用环/规划徽标/会话 sheet 值的唯一来源） */
  commandState: CommandStateSnapshot | null;
  /** M8：命令目录（cmd.sync 应答携带；M1 只读态未消费，M2 起驱动 picker） */
  commandCatalog: CommandCatalogEntry[] | null;
  /** 运行态重道信号（App 层 runningTick 下发，busy 判定现读 getRunningSessions——SessionListScreen 同款接线） */
  runningTick: number;
}) {
  const { session } = props;
  /** 有效会话 id：'new' 模式发言收编（attached.changed 回流真实 id）前保持 'new' */
  const [effectiveId, setEffectiveId] = useState(props.sessionId);
  const isNewMode = props.sessionId === 'new' && effectiveId === 'new';
  const sessionId = effectiveId;
  const [draft, setDraft] = useState('');
  /** d→m 文件 done 胶囊 toast（自绘，顶部绝对定位；2s 自动消隐） */
  const [fileToast, setFileToast] = useState<string | null>(null);
  const fileToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFileToast = useCallback((text: string) => {
    if (fileToastTimer.current) clearTimeout(fileToastTimer.current);
    setFileToast(text);
    fileToastTimer.current = setTimeout(() => setFileToast(null), 2000);
  }, []);
  /** M8：会话 sheet（☰ 入口；值渲染唯一来源 cmd.state） */
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  /** M2：模型选择器（会话 sheet 应答节二级展开；惰性拉取） */
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [memorySheetOpen, setMemorySheetOpen] = useState(false);
  /** M3：前台选择器 / 压缩确认 sheet */
  const [frontPickerOpen, setFrontPickerOpen] = useState(false);
  const [compactSheetOpen, setCompactSheetOpen] = useState(false);
  /** M4：目标设定 / 目标详情 sheet */
  const [goalInputOpen, setGoalInputOpen] = useState(false);
  const [goalStateOpen, setGoalStateOpen] = useState(false);
  /** App 内更新器：白名单锚点（配对中继）+ 链接路由 + shot 预览态 */
  const relay = useTrustedRelay();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /** file.*：本地图片全屏预览（file:// URI——托盘缩略图/历史 media 行点击打开） */
  const [previewLocalUri, setPreviewLocalUri] = useState<string | null>(null);

  /** file.*：附件抽屉开关（Android Alert.alert 3 按钮上限——第 4 个"取消"被静默丢弃，真机实测教训） */
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const ideaAvailable = (props.commandCatalog ?? []).some((c) => c.id === 'idea');
  /** 提案决策（裁决卡召唤）：目录有才显示/才拦截（npm 模式自然零渲染——入口不存在而非禁用） */
  const improveAvailable = findCatalogCommand(props.commandCatalog, 'improve') !== undefined;
  const memoryAvailable = findCatalogCommand(props.commandCatalog, 'memory') !== undefined;
  /** 记点子：App 级面板（悬浮球同款）——＋ 菜单行与 ☰ 行经此路由 */
  const openIdeaCapture = () => props.onOpenIdeaCapture?.();
  /** 召唤裁决卡（fast 通道即时回执；三态文案经 App 根级 cmdResult toast 呈现） */
  const summonImprove = () => {
    void session.sendCmdRequest(`improve-${Date.now()}`, 'improve', {}).catch(() => {});
  };

  const handleLinkPress = (url: string): boolean => {
    const r = routeStaticUrl(url, relay);
    if (r.kind === 'shot') {
      setPreviewUrl(url);
      return true;
    }
    if (r.kind === 'apk') {
      void updater.beginUpdate(url).then((phase) => {
        if (phase === 'busy') Alert.alert('更新进行中');
      });
      return true;
    }
    return false; // external 照旧 Linking.openURL（诚实语义）
  };
  /** DB 基底（落定历史）+ overlay（实时流/未落定卡）双源合并 */
  const [dbMessages, setDbMessages] = useState<ChatMessage[]>([]);
  const [overlay, setOverlay] = useState<ChatMessage[]>([]);
  const [syncing, setSyncing] = useState(true); // 附着确认到达前 = true（不假落定）
  /** 'new' 模式：第一句已发、真实 id 未回流期间的标记（其间续发走缺省当前会话路径，落地同一个新会话） */
  const [awaitingNewId, setAwaitingNewId] = useState(false);
  const listRef = useRef<LegendListRef>(null);
  const [showJump, setShowJump] = useState(false);
  /** showJump 最新值镜像（事件监听器闭包读最新值——history refresh 分支的底部判据用；同款模式 overlayRef/sessionIdRef） */
  const showJumpRef = useRef(false);
  const { height: kbHeight } = useReanimatedKeyboardAnimation();
  const kavAnimStyle = useAnimatedStyle(() => ({ paddingBottom: -kbHeight.value }));

  /** DB 已加载的最早 msgKey（上翻游标） */
  const earliestRef = useRef<string | null>(null);
  const pagingRef = useRef(false);
  /** 落定轮锚点（final/notice 到达即闭合；invalidated 真相重写时清 overlay 的依据） */
  const closedAnchorsRef = useRef(new Set<string>());
  /** DB 窗口回声集（退休判定源；三种构建形态的铁律见 syncUiLogic.mergeEchoSets 注释：
 *  reloadDb 整组重建 / loadOlder 并集累积 / retireOnly 整组替换（悬空快照，仅退休用）） */
  const echoesRef = useRef<EchoSets>(emptyEchoSets());
  /** 渲染收口 flag（按钮卡停止修复 v3）：悬空期 retireOnly 退休过 → 待回底收编；回底跳变或置位时已贴底时消费并清零 */
  const pendingBottomRefreshRef = useRef(false);
  /** retireOnly in-flight 守卫（复用 pagingRef 先例形态：async 回读期间 history 事件连发不重入） */
  const retireOnlyBusyRef = useRef(false);
  /** overlay 最新值镜像（事件监听器闭包读最新 overlay——roundSettled 闭合锚点用；overlay 不在监听器 deps 里） */
  const overlayRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);
  /** 当前查看会话 id 镜像（事件监听器闭包读最新值——d→m 文件卡归属过滤用） */
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  /** d→m 文件卡片缓存（progress/state 事件只携增量——整卡重建的数据源；DB 合并与 fileOffer 事件双源填充） */
  const fileCardsRef = useRef(new Map<string, FileCardInfo>());

  /** 快照注入（规划 v5：重进会话重现）：getCardsSnapshot 中归因本会话的卡注入 overlay。
   *  enqueueOverlay 同语义（同 id 保留首次 ts + append 序）；id 纪律 = ask-<id>/approval-<id>
   *  （与 message 事件同 id 同位替换——重连重推与注入双通道天然合一，无双份卡）。
   *  注入坐标 = requestTs（请求发生时刻）钉位：重进时灰卡/pending 卡钉回请求时刻位置，不再以重进
   *  时刻 Date.now() 漂到多轮之后（无缓存旧卡 requestTs 时 Date.now() 兜底）。
   *  无归因卡不注入（App 浮层呈现）；pending 永不淘汰（待答卡不丢）；灰卡超 30min TTL 不重现（问答本体在会话历史落库）。 */
  const injectCardsSnapshot = useCallback(() => {
    const snap = session.getCardsSnapshot();
    setOverlay((prev) => {
      const next = [...prev];
      const upsert = (m: ChatMessage) => {
        const idx = next.findIndex((x) => x.id === m.id);
        if (idx >= 0) next[idx] = { ...m, ts: next[idx]!.ts }; // 同 id 钉住首次 ts（与 enqueueOverlay 一致）
        else next.push(m);
      };
      for (const a of snap.approval) {
        if (a.sessionId != null && a.sessionId === sessionIdRef.current) {
          upsert({ id: `approval-${a.id}`, dir: 'in', text: '', kind: 'approval', ts: a.requestTs ?? Date.now(), approval: a });
        }
      }
      for (const k of snap.ask) {
        if (k.sessionId != null && k.sessionId === sessionIdRef.current) {
          upsert({ id: `ask-${k.id}`, dir: 'in', text: '', kind: 'ask', ts: k.requestTs ?? Date.now(), ask: k });
        }
      }
      return next;
    });
  }, [session]);

  /** 从 DB 重读基底（最新一页或游标前页）；older=true 时向前拼接 */
  const reloadDb = useCallback(
    async (older: boolean) => {
      try {
        const db = getSyncDb();
        const agentId = session.getAgentId();
        if (!agentId) return;
        const before = older ? (earliestRef.current ?? undefined) : undefined;
        const rows = await db.listMessages(agentId, sessionId, before, PAGE_SIZE);
        // file.*：本页 refs 批量联查本地登记表（图片缩略图/芯片的渲染源；纯函数映射保持同步可测）
        const refIds: string[] = [];
        for (const r of rows) {
          if (r.refsJson) {
            try {
              const refs = JSON.parse(r.refsJson) as Array<{ ref: string }>;
              for (const x of refs) if (typeof x?.ref === 'string') refIds.push(x.ref);
            } catch {
              /* refs 损坏按无 refs 降级 */
            }
          }
        }
        const sent = refIds.length > 0 ? await db.getSentAttachments(refIds) : [];
        const sentByRef = new Map(sent.map((s) => [s.fileId, { kind: s.kind, localUri: s.localUri }]));
        const mapped = rowsToChatMessages(rows, sentByRef);
        if (older) {
          if (rows.length === 0) return;
          // 游标 CAS：查询期间游标被并发通路推进（loadOlder prepend / 整组替换重置）→ 本批已在窗口中，
          // 让位早退。同基准同参数查询结果相同，保留其一零丢失（DB 存货永在，早退只跳过内存 prepend）。
          // 临界区：校验→推进→prepend 必须同步连续，勿插入 await（JS 单线程下双通路不可同时通过）
          if (!cursorAllowsPrepend(earliestRef.current, before)) return;
          earliestRef.current = rows[0]!.msgKey;
          setDbMessages((prev) => [...mapped, ...prev]);
          // 上翻补页：回声集并集累积（与渲染窗口同源）后统一退休——补到回声的气泡/节拍卡原地交出
          echoesRef.current = mergeEchoSets(echoesRef.current, buildEchoSets(rows));
          setOverlay((prev) => retireConfirmedOverlay(prev, echoesRef.current));
        } else {
          // d→m 收件卡：receivedFiles 副本合并进基底（精确匹配归属本会话；ts=要约到达时刻，归并进时间线）
          const fileRows = await db.listReceivedFilesForSession(sessionId);
          const fileMsgs = fileRows.map(receivedFileToMessage);
          for (const m of fileMsgs) if (m.fileCard) fileCardsRef.current.set(m.fileCard.fileId, m.fileCard);
          earliestRef.current = rows[0]?.msgKey ?? null;
          setDbMessages([...mapped, ...fileMsgs].sort((a, b) => a.ts - b.ts));
          // 统一回声确认退休：echo 集随全量查询重建（与渲染窗口严格同源）——有 DB 对应物的等回声，
          // 无对应物的按信号（拒绝/中止）；页预算截断不再是误清依据
          echoesRef.current = buildEchoSets(rows);
          setOverlay((prev) => retireConfirmedOverlay(prev, echoesRef.current));
          // ②B 迟到锚定钩子（reloadDb 完成点；门 a=无进行中轮，与按钮 busy 同源判定）：
          // running 集合不含本会话且 overlay 无流式卡才锚——保证 DB 尾部=归属轮真末条；
          // 门 b（同钟系有效性）在 computeAnchorTs 内。轮进行中不锚（留待下一钩子，无回退）；
          // roundSettled 不直接锚定（尾拉→history→reloadDb 链路天然推迟到落库后）
          const streamBusyNow = overlayRef.current.some(
            (m) => m.dir === 'in' && (m.kind === 'delta' || m.kind === 'reasoning'),
          );
          if (!session.getRunningSessions().has(sessionId) && !streamBusyNow) {
            void session.anchorPendingReceivedFiles(sessionId);
          }
        }
      } catch {
        /* 副本库不可用时只显示 overlay */
      }
    },
    [session, sessionId],
  );

  /** 悬空退休（按钮卡停止修复 v3）：history 落库但视口不在底部时的数据层收敛——退休不等回底
   *  （流式卡不退休 = streamBusy 恒真 = 按钮卡停止），渲染窗口保持不动（不跳视口）。
   *  回声纪律：每次从最新页全量回读（满页且仍有退休才向老续读，before 游标保证页不相交）→ 行集
   *  一次性 buildEchoSets → echoesRef 整组替换——绝不 merge 旧值（滑动最新页前缀重叠会重复 bump，
   *  计数虚高 → 固定文案卡误退休）。无跨调用增量状态：每次全新快照，同页两次到达天然幂等。
   *  终止有界：读到会话头（rows < PAGE_SIZE）或累计回声无新增退休（退休单调，最坏迭代被现存卡数封顶）。 */
  const retireOnly = useCallback(
    async () => {
      if (retireOnlyBusyRef.current) return;
      retireOnlyBusyRef.current = true;
      try {
        const db = getSyncDb();
        const agentId = session.getAgentId();
        if (!agentId) return;
        const allRows: MessageRow[] = [];
        let before: string | undefined = undefined;
        for (;;) {
          const rows = await db.listMessages(agentId, sessionId, before, PAGE_SIZE);
          if (rows.length === 0) break;
          allRows.push(...rows);
          // 续读判据（updater 外、镜像上算——React updater 纯函数约定，StrictMode 双调不误判）：
          // 累计回声仍能退休至少一张卡才值得向老读；无新增退休即停（防顽固不匹配卡失控翻页）
          if (!retireWithSnapshot(overlayRef.current, allRows).retired) break;
          if (rows.length < PAGE_SIZE) break;
          before = rows[0]!.msgKey;
        }
        if (allRows.length === 0) return;
        // 整组替换（回声纪律③）；React 退休走 updater（不丢 flush 合帧的 pending 批，updater 内无 ref 副作用）
        echoesRef.current = buildEchoSets(allRows);
        setOverlay((prev) => retireConfirmedOverlay(prev, echoesRef.current));
        // 渲染收口：退休确有发生（镜像上实际减少，不以 echo 消耗为准）→ 已贴底（await 期间用户滑回
        // = 跳变先于置位的时序洞）直接收编；悬空则挂 flag 等回底跳变消费（viewability 转变沿）
        if (retireWithSnapshot(overlayRef.current, allRows).retired) {
          if (showJumpRef.current) {
            pendingBottomRefreshRef.current = true;
          } else {
            void reloadDb(false);
          }
        }
      } catch {
        /* 副本库不可用时只显示 overlay（与 reloadDb 同款降级） */
      } finally {
        retireOnlyBusyRef.current = false;
      }
    },
    [session, sessionId, reloadDb],
  );

  /** M6b 验收修复：参数变更防护——navigate 路径更新 params（非 push 新实例）时切换会话即重置屏内态；
   *  "＋新会话"原先用 navigate 导致 params 变了但屏内 state 不动（看起来点了没反应），现已改 push +
   *  此防护双保险；'new' 收编走 setEffectiveId 不经 props，不受影响。 */
  useEffect(() => {
    // 切会话保命（2026-10-05）：离开会话（param 变更或卸载）把未退休发送气泡停进 RelaySession；
    // 重进注入、DB 回声退休（clientId=env.id）接管清除。cleanup 阶段**现读** ref——全部 cleanup
    // 先于全部 body（param 变更时 ref 尚为旧 id），'new' 收编后的真实 id 也被覆盖。'new' 不停（键不稳）。
    return () => {
      const parkId = sessionIdRef.current;
      if (parkId && parkId !== 'new') session.parkOutBubbles(parkId, pickParkableBubbles(overlayRef.current));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);
  useEffect(() => {
    setEffectiveId(props.sessionId);
    setDbMessages([]);
    setOverlay(props.sessionId === 'new' ? [] : session.takeParkedBubbles(props.sessionId));
    closedAnchorsRef.current.clear();
    echoesRef.current = emptyEchoSets();
    pendingBottomRefreshRef.current = false; // 渲染收口欠账随会话切换清（与 echoesRef 同点归零——同生同灭）
    earliestRef.current = null;
    fileCardsRef.current.clear(); // d→m 文件卡缓存随会话切换清空（新会话由 DB 合并重填）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  /** 归因分流·查看中语义（规划 v5 单一事实源）：focus 写 viewingSessionId / blur 与卸载 clear-if-mine 清。
   *  App 浮层门控与 message 过滤同读 session 镜像——消除 params/effectiveId 平行源（'new' 收编、
   *  Chat→Chat push 倒挂、pop 返回三态全闭合：clear-if-mine 仅所有者可清自己的值）。
   *  deps [session, sessionId]（sessionId=effectiveId）覆盖收编重跑：先 cleanup（clearIfMine 旧值）后写新值。 */
  useFocusEffect(
    useCallback(() => {
      session.setViewingSessionId(sessionId);
      injectCardsSnapshot(); // 查看会话即触发快照注入重算（含 'new' 收编——viewingSessionId 变化即重算）
      return () => {
        session.clearViewingSessionIdIfMine(sessionId);
      };
    }, [session, sessionId, injectCardsSnapshot]),
  );

  /** 进入即附着 + 拉最新页 + 记入口记忆；离开即脱离（不假落定：确认前 syncing=true）。
   *  'new' 模式：不附着不拉取（新会话无内容可订阅——发言才存在），直接就绪 */
  useEffect(() => {
    if (props.sessionId === 'new') {
      setSyncing(false);
      return;
    }
    setSyncing(true);
    void session.sendAttach(sessionId);
    void session.sendHistoryRequest(sessionId);
    void session.setLastChatSession(sessionId); // 进入聊天屏 = 记入口（附着与入口记忆分离：离开只脱离附着）
    void reloadDb(false);
    return () => {
      void session.sendAttach(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessionId]);

  /** session 事件订阅：实时流 overlay / 附着确认 / 历史页落库 / 附着会话被删 */
  useEffect(() => {
    /**
     * 消息合帧（M4i 修复的保留：Fabric 挂载竞态 addViewAt 的燃料抽取）：
     * 高频流式信封先在缓冲内按 id 归并，每 ~100ms 一批进 setOverlay——
     * 挂载批次频率降一个量级；信箱洪峰（重开灌离线信封）同样被摊平。
     */
    const pending: ChatMessage[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      setOverlay((prev) => {
        const next = prev.slice();
        for (const m of batch) {
          const idx = next.findIndex((x) => x.id === m.id);
          // 位置钉住（审批卡乱跳修复）：同 id 替换只在首次出现时取 ts（排序坐标）——后续更新帧
          // （流式生长 / resolved 重发 / running→完成）内容替换但 ts 保留，归并排序不重排、卡片不跳位
          if (idx >= 0) next[idx] = { ...m, ts: next[idx]!.ts };
          else insertLogical(next, m);
        }
        // 退休 pass 触发点③（signals 变）：notice 到达合帧后统一退休——守卫拒绝无任何 history 事件，
        // 只挂 reloadDb/loadOlder 的话被拒绝的气泡/半截卡会永久挂住
        return retireConfirmedOverlay(next, echoesRef.current);
      });
    };
    const enqueueOverlay = (m: ChatMessage) => {
      const idx = pending.findIndex((x) => x.id === m.id);
      if (idx >= 0) pending[idx] = { ...m, ts: pending[idx]!.ts }; // 同批内同样钉住首次 ts
      else pending.push(m);
      if (!flushTimer) flushTimer = setTimeout(flush, 100);
    };
    /** 低频交互事件（文件卡）即时 flush——100ms 合帧为流式洪峰设计，人手点击不该被摊平 */
    const flushNow = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
    };
    /**
     * 逻辑序插入（治重连洪峰乱序：思考信封可能晚于同节拍正文到达——实测洪峰中 18 个 delta 先于 reasoning 快照）。
     * think-{anchor}-{beat} 必须插到同节拍 stream-{anchor}-{beat} 之前（M4b 节拍语义：想完→开答），
     * 不依赖信封到达顺序。其余维持到达序追加。
     */
    const THINK_ID = /^think-(.+)-(\d+)$/;
    const insertLogical = (next: ChatMessage[], m: ChatMessage) => {
      const t = THINK_ID.exec(m.id);
      if (t) {
        const si = next.findIndex((x) => x.id === `stream-${t[1]}-${t[2]}`);
        if (si >= 0) {
          next.splice(si, 0, m);
          return;
        }
      }
      next.push(m);
    };
    const off = session.on((e) => {
      if (e.type === 'message') {
        const m = e.message;
        // 落定信号记账（final/notice 闭合锚点——overlay 清理依据）；'new' 模式 notice = 新建被守卫拒（复位待收编）
        if ((m.kind === 'final' || m.kind === 'notice') && m.dir === 'in') {
          const t = ANCHORED_STREAM.exec(m.id);
          if (t) closedAnchorsRef.current.add(t[1]);
          if (m.kind === 'notice') setAwaitingNewId(false);
        }
        // 归因分流（规划 v5）：提问/审批卡——有归因仅进来源会话时间线（精确匹配），
        // 无归因（全局请示）不进任何时间线，由 App 浮层呈现与作答（可见且可答）
        if (m.kind === 'ask' || m.kind === 'approval') {
          const sid = m.kind === 'ask' ? m.ask?.sessionId : m.approval?.sessionId;
          if (sid != null && sid === sessionIdRef.current) enqueueOverlay(m);
        } else if (allowsMessageForSession(m, sessionIdRef.current)) {
          // 会话归属过滤（串场根治）：无戳放行（旧桌面兜底）、归属=本屏放行、其余丢弃（双屏各取所需）
          enqueueOverlay(m);
        }
      } else if (e.type === 'attached') {
        if (props.sessionId === 'new' && effectiveId === 'new' && e.sessionId !== null) {
          // 'new' 发言收编：桥轮前附着的真实 id 回流（session 侧已落附着意图+入口记忆）
          setEffectiveId(e.sessionId);
          setAwaitingNewId(false);
          setSyncing(false);
          void reloadDb(false);
        } else if (e.sessionId === sessionId) {
          setSyncing(false);
        }
      } else if (e.type === 'history' && e.sessionId === sessionId) {
        if (e.invalidated === true) {
          // invalidated=真相重写（压缩/再生）：回声永远达不到——清已闭合的 overlay 卡（活轮卡保留），
          // overlay 永不与重写后的真相矛盾；closedAnchorsRef 的唯一剩余用途
          setOverlay((prev) =>
            prev.filter((m) => {
              // 提问/审批卡已按归因分流（v5）：无锚 in 卡走下方通用保留分支（ask-*/approval-* 不匹配锚正则）
              const t = ANCHORED_STREAM.exec(m.id);
              if (t) return !closedAnchorsRef.current.has(t[1]);
              if (m.dir === 'out') return !closedAnchorsRef.current.has(m.id);
              return true; // 无锚卡（status/fileOffer/ask/approval 等）：活轮证据/待决请示，保留
            }),
          );
          echoesRef.current = emptyEchoSets(); // 副本已清，旧回声集作废（reloadDb 随重拉重建）
          void reloadDb(false); // 真相重写：重置到最新是诚实的（现行为保留）
        } else if (e.intent === 'older') {
          // 上翻补页应答落库：prepend 向前扩展窗口（视口锚定由 MVCP data:true 保证），
          // 不重置到最新——这是上翻视口跳变修复的核心分支
          void reloadDb(true);
        } else if (!showJumpRef.current) {
          // 刷新语义（进入尾拉/轮落定尾拉齐/迟到应答）：仅视口在底部时跟随最新
          void reloadDb(false);
        } else {
          // 视口悬空（按钮卡停止修复 v3）：退休与渲染解耦——数据层无条件收敛（流式卡不退休 =
          // streamBusy 恒真 = 按钮卡停止），渲染窗口不动（不跳视口）；回底收编见 viewability 转变沿
          void retireOnly();
        }
      } else if (e.type === 'sessionDeleted' && e.sessionId === sessionId) {
        Alert.alert('该会话已被桌面删除', undefined, [{ text: '好', onPress: props.onBack }]);
      } else if (e.type === 'roundSettled' && e.sessionId === sessionId) {
        // M6c：一轮真正落定——闭合该轮全部流式/思考卡锚点。本地镜像轮无 final，这是其唯一收口通路；
        // 不闭合则随后落定的尾部拉齐（history 事件）触发的 reloadDb 无法清除这些 overlay 卡（永久双份）。
        // 手机轮 final 已闭合，此处幂等。
        for (const m of overlayRef.current) {
          const t = ANCHORED_STREAM.exec(m.id);
          if (t) closedAnchorsRef.current.add(t[1]);
        }
      } else if (e.type === 'fileOffer') {
        // d→m 文件卡（新要约落库后到达）：归属过滤——卡片长在产生它的那轮对话里，不串场
        // （归属不可变=落库原值；null 卡不显示——本屏不在看归属会话 → 不进 overlay，进该会话时由 DB 合并呈现）
        const c = e.card;
        fileCardsRef.current.set(c.fileId, c);
        if (c.sessionId === sessionIdRef.current) {
          enqueueOverlay({ id: `file-${c.fileId}`, dir: 'in', text: '', kind: 'fileOffer', ts: Date.now(), fileCard: c });
          flushNow();
        }
      } else if (e.type === 'fileProgress') {
        // 拉取进度（回调直报，不走 DeviceEventEmitter）：整卡重建同 id 原位替换
        const prev = fileCardsRef.current.get(e.fileId);
        if (prev && prev.sessionId === sessionIdRef.current) {
          const next: FileCardInfo = { ...prev, state: 'pulling', progress: { received: e.received, total: e.total } };
          delete next.lastProgress; // 真进度接管，暂停标记即时清除
          fileCardsRef.current.set(e.fileId, next);
          enqueueOverlay({ id: `file-${e.fileId}`, dir: 'in', text: '', kind: 'fileOffer', ts: Date.now(), fileCard: next });
          flushNow();
        }
      } else if (e.type === 'fileState') {
        // 状态跃迁（offered/pulling/done/failed/expired）：唯一落定来源=receivedFiles 落库后的本事件
        const prev = fileCardsRef.current.get(e.fileId);
        if (prev && prev.sessionId === sessionIdRef.current) {
          const next: FileCardInfo = { ...prev, state: e.state };
          delete next.progress;
          if (e.state === 'offered') {
            // 取消/清扫复位：断点进度转为暂停显示（"取消 = 停下来不是扔掉"）
            if (prev.progress && prev.progress.received > 0) next.lastProgress = prev.progress;
          } else {
            delete next.lastProgress;
          }
          if (e.error !== undefined) next.error = e.error;
          else delete next.error;
          if (e.contentUri !== undefined) next.contentUri = e.contentUri;
          fileCardsRef.current.set(e.fileId, next);
          enqueueOverlay({ id: `file-${e.fileId}`, dir: 'in', text: '', kind: 'fileOffer', ts: Date.now(), fileCard: next });
          flushNow();
          if (e.state === 'done') {
            Vibration.vibrate(30);
            showFileToast('✓ 已存到 下载/chill/');
          }
        }
      } else if (e.type === 'fileAnchored' && e.sessionId === sessionIdRef.current) {
        // ②B：锚定落库完成——活卡 ts 更新为 anchorTs（一次跳位=锚定语义修正）。独立 setter 直接改
        // overlay 项（不复用 enqueueOverlay——其同 id 钉首次 ts 纪律会使跳位不生效）；锚值回查 DB
        // （事件只携 sessionId）；锚后 DB 卡位由下次 reloadDb 的 receivedFileToMessage（anchorTs 优先）接管
        void (async () => {
          try {
            const rows = await getSyncDb().listReceivedFilesForSession(sessionIdRef.current);
            const anchored = new Map<string, number>(
              rows.filter((r) => r.anchorTs != null).map((r) => [`file-${r.fileId}`, r.anchorTs!] as const),
            );
            if (anchored.size === 0) return;
            setOverlay((prev) =>
              prev.map((m) => (m.kind === 'fileOffer' && anchored.has(m.id) ? { ...m, ts: anchored.get(m.id)! } : m)),
            );
          } catch {
            /* 副本库不可用：跳过（活卡保持现位，下次 reloadDb 从 DB 读锚值） */
          }
        })();
      }
    });
    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      if (fileToastTimer.current) clearTimeout(fileToastTimer.current);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessionId, reloadDb, retireOnly]);

  /** 上翻：先读 DB 更早一页；DB 见底且**已有游标**且有更多历史 → 向桌面拉（游标=已持有最早 msgKey）。
   *  修复（新会话首轮重复渲染）：游标为 null 时（DB 空）不得发"无 before"请求——那是"最新页"（拉回正在
   *  流式进行中的内容，造成 DB 副本与 overlay 双份渲染）；入口拉取职责在进入效应，不在上翻。 */
  const loadOlder = useCallback(() => {
    if (pagingRef.current) return;
    pagingRef.current = true;
    void (async () => {
      try {
        const db = getSyncDb();
        const agentId = session.getAgentId();
        const before = earliestRef.current ?? undefined; // 游标快照（CAS 基准）
        const rows = agentId
          ? await db.listMessages(agentId, sessionId, before, PAGE_SIZE)
          : [];
        if (rows.length > 0) {
          // 游标 CAS：查询期间游标被并发通路推进（older 应答 reloadDb(true) prepend / 整组替换）→
          // 本批已在窗口中，让位早退且不发桌面请求（"是否见底"应基于新游标，由下次触发评估；
          // rows=0 的通路不推进游标，不触发此处让位——单通路见底发请求逻辑不受影响）。
          // 临界区：校验→推进→prepend 必须同步连续，勿插入 await
          if (!cursorAllowsPrepend(earliestRef.current, before)) return;
          earliestRef.current = rows[0]!.msgKey;
          setDbMessages((prev) => [...rowsToChatMessages(rows), ...prev]);
          // 上翻补页：回声集并集累积后统一退休（补到回声的气泡/节拍卡原地交出）
          echoesRef.current = mergeEchoSets(echoesRef.current, buildEchoSets(rows));
          setOverlay((prev) => retireConfirmedOverlay(prev, echoesRef.current));
        }
        if (rows.length < PAGE_SIZE && earliestRef.current !== null && !session.isHistoryComplete(sessionId)) {
          // asOlder：上翻补页请求——应答经 replyTo 配对携带 intent='older'，UI prepend 保持窗口
          await session.sendHistoryRequest(sessionId, earliestRef.current, undefined, { asOlder: true });
        }
      } finally {
        pagingRef.current = false;
      }
    })();
  }, [session, sessionId]);

  // M6b 修复：ts 归并（卡片钉在到达时刻位置），块追加会让 overlay 卡片永远沉底
  const messages = useMemo(() => mergeLiveOverlay(dbMessages, overlay), [dbMessages, overlay]);
  /** 乐观流式证据：本屏 overlay 有未退休的流式卡（'new' 收编窗口与旧桌面的兜底信号） */
  const streamBusy = overlay.some((m) => m.dir === 'in' && (m.kind === 'delta' || m.kind === 'reasoning'));
  /** 停止变形的忙碌判定（按钮卡停止修复 v3）：运行集合.contains(本会话) ∪ streamBusy。
   *  运行集合 = session.event running.changed 链（与列表小转圈同源；TURN_STARTED/SETTLED 1:1 配对，
   *  转换随行 runningAll 整替 + 5min 重申 + 重连对账三重收敛）——按钮与小转圈构造上不可能矛盾。
   *  cmd.state.running 已移除消费：它是活跃会话信息性快照（非按会话 busy 源）——不可再生信封、
   *  丢失无对账（残留 true 卡停止）、多会话并行时它让空闲会话误显停止。协议字段保留，其它消费者不受影响。
   *  等价性：'new' 收编/429 丢帧窗口内短暂显示箭头与旧判定等价（wireCommandState 无 TURN_STARTED
   *  推送点，同窗口旧判定同样不点亮）——禁止再加乐观置位"修复"。
   *  断连注记：断连时运行集合诚实清空（观察态），按钮以本地 streamBusy 证据为准、stop 意图离线排队——
   *  与小转圈（断连即灭）的语义分叉是有意设计。 */
  const busy = useMemo(
    () => session.getRunningSessions().has(sessionId) || streamBusy,
    // runningTick=重道信号（集合现读，SessionListScreen 同款）；'new' 不在集合（集合存真实 id），无需显式排除
    [session, sessionId, streamBusy, props.runningTick],
  );

  const lastMsgId = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: Array<{ key: string }> }) => {
      if (!lastMsgId) {
        // 会话切换瞬间 messages 清空（取沿豁免——非用户回底语义，不触发渲染收口）
        showJumpRef.current = false;
        return setShowJump(false);
      }
      const hidden = !viewableItems.some((t) => t.key === lastMsgId);
      // 渲染收口转变沿（按钮卡停止修复 v3）：悬空期 retireOnly 退休过（flag 在位）且本次为回底跳变
      // （true→false，viewability 实测——手势滑回与 ↓ 按钮 scrollToEnd 两条路径统一覆盖）→ 收编
      // 渲染窗口（此刻确已见底，全窗重置不跳视口）。flag 不在位的跳变零动作（无欠账不空刷）。
      if (showJumpRef.current && !hidden && pendingBottomRefreshRef.current) {
        pendingBottomRefreshRef.current = false;
        void reloadDb(false);
      }
      showJumpRef.current = hidden; // 同步写镜像（事件闭包即时可读，不等 effect flush）
      setShowJump(hidden);
    },
    [lastMsgId, reloadDb],
  );

  // ---------- file.* 协议族：附件托盘（选中即登记+预传输；receipt 收敛；发送门控） ----------
  const [tray, setTray] = useState<
    Array<{
      fileId: string;
      name: string;
      mime: string;
      kind: 'image' | 'file';
      localUri: string;
      size: number;
      /** 裸磁盘路径（大文件 v2 分片读源；与 localUri 同体去 file:// 前缀） */
      localPath?: string;
      bytes: Uint8Array;
      pct: number;
      status: 'uploading' | 'ok' | 'failed';
      error?: string;
      /** 媒体直传已发布、桌面离线等待回执（presence 门控——离线不回退） */
      waiting?: boolean;
    }>
  >([]);
  const trayBusy = tray.some((t) => t.status !== 'ok');

  const pickFrom = (src: 'gallery' | 'camera' | 'document') => {
    if (tray.length >= 5) {
      Alert.alert('一次最多 5 个附件');
      return;
    }
    void (async () => {
      try {
        const picked = await pickAttachment(src);
        if (!picked) return; // 用户取消
        // 选中即预传输（receipt 收敛状态；发送只是确认门控）
        setTray((prev) => [
          ...prev,
          { ...picked, pct: 0, status: 'uploading' },
        ]);
        const r = await session.uploadAttachment(
          picked,
          (pct) => {
            setTray((prev) => prev.map((t) => (t.fileId === picked.fileId ? { ...t, pct } : t)));
          },
          () => {
            // 桌面离线：字节已到服务器，等桌面上线回执（48h 有效）
            setTray((prev) => prev.map((t) => (t.fileId === picked.fileId ? { ...t, waiting: true } : t)));
          },
        );
        setTray((prev) =>
          prev.map((t) =>
            t.fileId === picked.fileId ? { ...t, status: r.ok ? 'ok' : 'failed', error: r.ok ? undefined : r.error } : t,
          ),
        );
        if (!r.ok) Alert.alert(`「${picked.name}」未送达`, `${r.error ?? '未知原因'}。可移除后重试，或把文件放到电脑上用 @提及 发送`);
      } catch (e) {
        const msg = e instanceof AttachmentTooLargeError
          ? `${e.message}。可压缩后再试，或把文件放到电脑上用 @提及 发送`
          : `添加附件失败：${e instanceof Error ? e.message : String(e)}`;
        Alert.alert('无法添加附件', msg);
      }
    })();
  };

  const openAttachSheet = () => setAttachSheetOpen(true);

  const send = () => {
    const t = draft.trim();
    if (!t && tray.length === 0) return;
    if (trayBusy) {
      Alert.alert('附件还在传输，完成后自动可发');
      return;
    }
    // 斜杠命令（白名单 + 目录驱动）：/improve 召唤裁决卡走 cmd.request 而非聊天消息；
    // 不命中（含目录无该命令/带附件）按普通消息发送，诚实降级不假执行
    const slash = tray.length === 0 ? resolveSlashCommand(t, props.commandCatalog) : null;
    if (slash) {
      setDraft('');
      void session.sendCmdRequest(`${slash}-${Date.now()}`, slash, {}).catch(() => {});
      return;
    }
    const attachments = tray.map((x) => ({ fileId: x.fileId, name: x.name, mime: x.mime }));
    const mediaItems = tray.map((x) => ({ ref: x.fileId, name: x.name, mime: x.mime, kind: x.kind, localUri: x.localUri }));
    setDraft('');
    setTray([]);
    setShowJump(false);
    // M6b 发言即附着：钉住会话带其 id；'new' 模式第一句带 'new'（桥端建会话+轮前附着），
    // 真实 id 回流前（awaitingNewId）的续发走缺省当前会话路径（桌面当前会话就是这个新会话）
    const target = isNewMode ? (awaitingNewId ? undefined : 'new') : sessionId;
    if (isNewMode && !awaitingNewId) setAwaitingNewId(true);
    // 回显走 session 的 chat.user 事件（id=env.id=轮锚点，落定后被锚点清除、由历史行接管）；
    // 媒体显示信息（localUri）随回显携带——用户发出什么立刻看到什么
    void session.sendChat(t, target, attachments, mediaItems).catch(() => {});
    // 发消息 = 明确回底意图（用户动作，非流式追赶——这是全文件仅存的两条滚动指令之一）
    listRef.current?.scrollToEnd({ animated: true });
  };

  const renderItem = ({ item }: { item: ChatMessage }) => {
    // alarm 臂已删（v5：全库零生产者的死代码；notice 为活路径保留）
    if (item.kind === 'notice') {
      return <Text style={styles.systemLine}>{item.text}</Text>;
    }
    if (item.kind === 'media') {
      // 方向分渲染（真机实测教训）：用户发的 media（带附件消息）= 蓝色右气泡（含缩略图/芯片）；
      // 桌面产生的 media / 无副本降级 = 左侧裸排版
      const row = <MediaRow msg={item} onLinkPress={handleLinkPress} onImagePress={setPreviewLocalUri} />;
      if (item.dir === 'out') {
        return <View style={styles.outBubble}>{row}</View>;
      }
      return row;
    }
    if (item.kind === 'reasoning') {
      return <ThinkRegion text={item.text} streaming={item.streaming === true} />;
    }
    if (item.kind === 'status') {
      return <ToolLine msg={item} />;
    }
    if (item.kind === 'approval' && item.approval) {
      return <ApprovalCard msg={item} onDecision={props.onApprovalDecision} />;
    }
    if (item.kind === 'fileOffer' && item.fileCard) {
      // d→m 文件卡（对话流内联；点击只发意图，状态落定以 session 事件回流为准）
      return (
        <FileCard
          msg={item}
          onReceive={(fileId) => void session.receiveFile(fileId)}
          onCancel={(fileId) => session.cancelReceiveFile(fileId)}
          onOpen={(uri, mime) =>
            void openDeliveredFile(uri, mime).then((r) => {
              if (!r.ok) Alert.alert('无法打开文件', r.detail);
            })
          }
        />
      );
    }
    if (item.kind === 'ask' && item.ask) {
      // 裁决卡分派：card 载荷形状校验有效 → 点选裁决卡；缺字段/校验失败 → 照旧文本问答卡
      const triage = item.ask.card !== undefined ? validateTriageCard(item.ask.card) : null;
      if (triage)
        return (
          <TriageCard
            msg={item}
            card={triage}
            onAnswer={props.onAskAnswer}
            // 原地翻页（improve.page cmd 一次往返；与 App 浮层卡共用 turnCourtPage 单一拼装点）
            onTurnPage={(dir, decisions) => turnCourtPage(session, dir, decisions)}
          />
        );
      return <QuestionCard msg={item} onAnswer={props.onAskAnswer} />;
    }
    if (item.dir === 'out') {
      return (
        <View style={styles.outBubble}>
          <Text style={styles.outText}>{item.text}</Text>
        </View>
      );
    }
    // assistant 正文（kind: delta/final）：MarkdownText 渲染（解析器为全函数，流式半截标记按字面兜底）。
    // 无流式光标——运动即"正在写"的信号（与无"正在X"标签同哲学）；光标是装饰且制造过视觉 bug
    return <MarkdownText text={item.text} baseStyle={styles.contentText} onLinkPress={handleLinkPress} />;
  };

  return (
    <View style={styles.root}>
      {fileToast ? (
        <View style={styles.fileToast}>
          <Text style={styles.fileToastText}>{fileToast}</Text>
        </View>
      ) : null}
      {/* 标题栏在键盘几何驱动区之外——键盘弹出时它构造上不可能移动（M4g 段二硬需求） */}
      <View style={styles.header}>
        <TouchableOpacity onPress={props.onBack}>
          <Text style={styles.backLink}>‹</Text>
        </TouchableOpacity>
        {/* M6b：头部主标题恒为"我的桌面"（验收 15）；会话标题作副标题（钉入模式/已知标题时） */}
        <View style={styles.headerTitleCol}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            我的桌面
          </Text>
          {props.title ? (
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {props.title}
            </Text>
          ) : null}
        </View>
        <View style={styles.headerRight}>
          {/* M8 上下文占用环（与桌面同口径：无数据不渲染、>80% 琥珀；点按直达压缩 sheet——用量详情+确认压缩同位；完整菜单由 ☰ 进入） */}
          <ContextRing ctx={props.commandState?.ctx ?? null} onPress={() => setCompactSheetOpen(true)} />
          {/* M8 规划徽标（激活态显示——零状态零渲染；值随 cmd.state 回流） */}
          {props.commandState?.plan ? <Text style={styles.planBadge}>规划·开</Text> : null}
          {/* M5 权限模式徽标：危险档位常显于使用现场；点击只在 mode.state 落定后变化（不假落定）；
              开启方向二次确认（口袋误触防护），从严/回默认方向直接生效 */}
          <TouchableOpacity
            disabled={props.permissionMode === null}
            onPress={() => {
              if (props.permissionMode === 'boundary') {
                Alert.alert(
                  '开启直写模式？',
                  '开启后手机发起的写入/命令不再逐条询问，任意路径直接生效。建议仅在信任/隔离环境使用。',
                  [
                    { text: '取消', style: 'cancel' },
                    { text: '开启', style: 'destructive', onPress: () => props.onToggleMode('fullAccess') },
                  ],
                );
              } else if (props.permissionMode === 'fullAccess' || props.permissionMode === 'readonly') {
                props.onToggleMode('boundary');
              }
            }}
          >
            <Text style={[styles.modeBadge, props.permissionMode === 'fullAccess' && styles.modeBadgeDanger]}>
              {props.permissionMode === null
                ? '未同步'
                : props.permissionMode === 'fullAccess'
                  ? '⚠ 直写中'
                  : props.permissionMode === 'readonly'
                    ? '只读'
                    : '边界'}
            </Text>
          </TouchableOpacity>
          {/* M6b：＋新会话 / 历史——图标化（设置已回到 Agent 列表页，聊天屏不再有设置入口） */}
          <TouchableOpacity
            onPress={() => {
              if (isNewMode) {
                setDraft('');
                return;
              }
              props.onNewChat();
            }}
          >
            <Text style={styles.headerIcon}>＋</Text>
          </TouchableOpacity>
          {/* M8：☰ = 会话 sheet 入口（首行历史会话——原功能收进；应答/推进/维护三节设置行） */}
          <TouchableOpacity onPress={() => setSessionSheetOpen(true)}>
            <Text style={styles.headerIcon}>☰</Text>
          </TouchableOpacity>
        </View>
      </View>
      {/* 恒渲染（display 控显隐）：条件渲染会让 KAV 内兄弟节点下标平移——
          Fabric 挂载竞态（addViewAt）的嫌犯类之一，构造性消除；视觉与交互不变 */}
      <View style={[styles.offlineBar, props.connected && styles.hidden]}>
        <Text style={styles.offlineText}>重连中…（消息不丢，恢复后自动补投）</Text>
      </View>
      {/* M6c：已连中继但桌面未在线——消息会暂存，等桌面开机后送达（绿点不骗人的聊天屏侧呈现） */}
      <View style={[styles.desktopOfflineBar, !(props.connected && !props.desktopOnline) && styles.hidden]}>
        <Text style={styles.desktopOfflineText}>桌面未在线 · 消息会暂存，等它开机后自动送达</Text>
      </View>
      {/* 附着未确认前实时区提示（请求-确认制，不假落定）；M6c：桌面离线时不显示——没有可同步的对象，
          黄条已把状态说清，留着它自相矛盾（用户实测反馈） */}
      <View style={[styles.syncingBar, !(syncing && props.desktopOnline) && styles.hidden]}>
        <Text style={styles.syncingText}>同步中…</Text>
      </View>
      {/* 键盘几何直驱：kavBody 的 paddingBottom 由键盘共享值逐帧驱动（见上方注释） */}
      <Animated.View style={[styles.kavBody, kavAnimStyle]}>
        <LegendList
          ref={listRef}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={messages}
          keyExtractor={(m) => m.id}
          maintainScrollAtEnd
          // 视口稳定三件套（上翻跳动第二轮修复）：
          // data:true = data 变化（prepend 历史页）时锚定视口内 item（第一轮修复主体）；
          // size:true = 滚动中尺寸/布局变化（估算→实测高度修正）时保持视口——库默认开启，
          //   历史配置显式关闭正是"无流式也跳"的残留因；消息高度方差大（短问答 vs 大表格汇报）修正明显；
          // experimental_hideItemsUntilMeasured = 回收行未实测前不显示暂态布局
          //   （治快速上翻时的间隙/重叠/闪变——实测视频里顶部暗行形态）；
          // estimatedItemSize = 初始估算接近真实均值，减小首屏学习期误差（库会自学习后续平均值）
          maintainVisibleContentPosition={{ data: true, size: true }}
          experimental_hideItemsUntilMeasured
          estimatedItemSize={150}
          onViewableItemsChanged={handleViewableItemsChanged}
          viewabilityConfig={VIEWABILITY_CONFIG}
          onStartReached={loadOlder}
          onStartReachedThreshold={0.2}
          renderItem={renderItem}
        />
        {/* 浮钮恒渲染（display 控显隐）：与 offlineBar 同理，消除 KAV 内兄弟下标平移的嫌犯类 */}
        <TouchableOpacity
          style={[styles.jumpBtn, !showJump && styles.hidden]}
          onPress={() => {
            setShowJump(false);
            // 用户主动回底（全文件仅存的两条滚动指令之二）
            listRef.current?.scrollToEnd({ animated: true });
          }}
        >
          <Text style={styles.jumpBtnText}>↓</Text>
        </TouchableOpacity>
        {/* M4：目标长条（无目标零渲染；与看板长条堆叠共存——生命周期态与看板态是两个正交事实） */}
        {props.commandState?.goal ? (
          <GoalStrip goal={props.commandState.goal} onPress={() => setGoalStateOpen(true)} />
        ) : null}
        {/* 宿主级开关徽标（C1）：桌面能力明确开启时常驻（安全感知——一眼确认电脑上的助手能否操作屏幕）；点击直达 ☰ 开关行 */}
        {desktopBadgeVisible(props.commandState) ? (
          <TouchableOpacity style={styles.desktopBadge} onPress={() => setSessionSheetOpen(true)} accessibilityLabel="桌面能力已开启">
            <Text style={styles.desktopBadgeText}>🖥️ 桌面能力已开</Text>
          </TouchableOpacity>
        ) : null}
        {/* 工作计划树长条（输入框上方唯一面板；树=清单+看板双源投影；'new' 未收编无树不渲染） */}
        {effectiveId !== 'new' ? <WorkPlanPanel session={session} sessionId={effectiveId} /> : null}
        {/* file.*：待发附件托盘（缩略图/芯片 + 进度/失败态 + ×移除；选中即预传输，receipt 收敛） */}
        {tray.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tray} contentContainerStyle={styles.trayContent}>
            {tray.map((x) => (
              <View key={x.fileId} style={styles.trayItem}>
                {x.kind === 'image' ? (
                  <ImageGridThumb localUri={x.localUri} onPress={() => setPreviewLocalUri(x.localUri)} />
                ) : (
                  <View style={styles.trayChip}>
                    <Text style={styles.trayChipIcon}>{x.mime.startsWith('video/') ? '▶' : '▣'}</Text>
                    <Text style={styles.trayChipName} numberOfLines={1}>
                      {x.name}
                    </Text>
                  </View>
                )}
                <Text style={styles.trayState} numberOfLines={1}>
                  {x.status === 'uploading'
                    ? x.waiting
                      ? '等待桌面…'
                      : `${x.pct}%`
                    : x.status === 'failed'
                      ? '失败·点×移除'
                      : '已送达 ✓'}
                </Text>
                <TouchableOpacity style={styles.trayRm} onPress={() => setTray((prev) => prev.filter((t) => t.fileId !== x.fileId))}>
                  <Text style={styles.trayRmText}>×</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.inputRow}>
          <TouchableOpacity
            style={styles.attachBtn}
            onPress={openAttachSheet}
          >
            <Text style={styles.attachBtnText}>＋</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="给桌面的 chill 发消息…"
            placeholderTextColor="#666"
            onSubmitEditing={send}
            returnKeyType="send"
          />
          {/* M2 发送↔停止变形（v3 真相源切换）：busy = 运行集合.contains(本会话) ∪ streamBusy 乐观兜底
              （判定语义见上方 busy useMemo 注释；D4 例外依旧：turn.stop 空转幂等无风险，停止无二次确认） */}
          {busy ? (
            <TouchableOpacity
              style={styles.stopBtn}
              onPress={() => void session.sendCmdRequest(`stop-${Date.now()}`, 'turn.stop').catch(() => {})}
              accessibilityLabel="停止本轮"
              hitSlop={6}
            >
              <Text style={styles.stopText}>■</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.sendBtn} onPress={send} accessibilityLabel="发送" hitSlop={6}>
              <Text style={styles.sendText}>↑</Text>
            </TouchableOpacity>
          )}
        </View>
      </Animated.View>
      {/* shot 全屏预览（UpdateOverlay 已上移 App 根——更新发现是 App 级关切，任何屏可见） */}
      <ImagePreviewModal url={previewUrl} onClose={() => setPreviewUrl(null)} />
      {/* file.*：附件入口抽屉（自定义底部弹层——Android Alert.alert 3 按钮上限，取消被静默丢弃的实测教训） */}
      <Modal visible={attachSheetOpen} transparent animationType="slide" onRequestClose={() => setAttachSheetOpen(false)}>
        <Pressable style={styles.attachBackdrop} onPress={() => setAttachSheetOpen(false)}>
          <View style={styles.attachSheet}>
            <Text style={styles.attachSheetTitle}>添加附件</Text>
            <Text style={styles.attachSheetMeta}>经端到端加密通道发给桌面</Text>
            {ideaAvailable ? (
              <TouchableOpacity
                style={styles.attachSheetItem}
                onPress={() => { setAttachSheetOpen(false); openIdeaCapture(); }}
              >
                <Text style={styles.attachSheetItemIcon}>💡</Text>
                <Text style={styles.attachSheetItemText}>记个点子</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={styles.attachSheetItem}
              onPress={() => { setAttachSheetOpen(false); pickFrom('gallery'); }}
            >
              <Text style={styles.attachSheetItemIcon}>◫</Text>
              <Text style={styles.attachSheetItemText}>相册</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.attachSheetItem}
              onPress={() => { setAttachSheetOpen(false); pickFrom('camera'); }}
            >
              <Text style={styles.attachSheetItemIcon}>◎</Text>
              <Text style={styles.attachSheetItemText}>拍照</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.attachSheetItem}
              onPress={() => { setAttachSheetOpen(false); pickFrom('document'); }}
            >
              <Text style={styles.attachSheetItemIcon}>▤</Text>
              <Text style={styles.attachSheetItemText}>文件</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachSheetCancel} onPress={() => setAttachSheetOpen(false)}>
              <Text style={styles.attachSheetCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
      {/* file.*：本地图片全屏预览（点任意处关闭——与 shot 预览同交互） */}
      <Modal visible={previewLocalUri !== null} transparent animationType="fade" onRequestClose={() => setPreviewLocalUri(null)}>
        <Pressable style={styles.localPreviewBackdrop} onPress={() => setPreviewLocalUri(null)}>
          <View style={styles.localPreviewCenter}>
            {previewLocalUri && (
              <Image
                source={{ uri: previewLocalUri.startsWith('file://') ? previewLocalUri : `file://${previewLocalUri}` }}
                style={styles.localPreviewImg}
                resizeMode="contain"
              />
            )}
            <Text style={styles.localPreviewHint}>点任意处关闭</Text>
          </View>
        </Pressable>
      </Modal>
      {/* M8 会话 sheet（☰ 入口；值渲染唯一来源 cmd.state，本地不落定） */}
      <SessionSheet
        visible={sessionSheetOpen}
        onClose={() => setSessionSheetOpen(false)}
        commandState={props.commandState}
        commandCatalog={props.commandCatalog}
        onOpenHistory={props.onOpenHistory}
        onOpenModel={() => {
          setSessionSheetOpen(false);
          setModelPickerOpen(true);
        }}
        onOpenFront={() => {
          setSessionSheetOpen(false);
          setFrontPickerOpen(true);
        }}
        onTogglePlan={() => {
          if (!props.commandState) return;
          void session
            .sendCmdRequest(`plan-set-${Date.now()}`, 'plan.set', { on: !props.commandState.plan })
            .catch(() => {});
        }}
        onToggleDesktop={() => {
          if (!props.commandState) return;
          const next = hostToggleNext(props.commandState.desktop);
          // risk=confirm 档两段式防线（照 goal.abandon Alert 先例；Android 3 按钮上限内）：放行键鼠是敏感动作
          Alert.alert(
            next ? '开启桌面能力？' : '关闭桌面能力？',
            next
              ? '电脑上的助手将获得截屏与键鼠操作工具（capture_screen / inspect_ui / computer_use），主动作仍需你逐次审批。'
              : '将同时收回本会话已放行的桌面操作授权。',
            [
              { text: '取消', style: 'cancel' },
              {
                text: next ? '开启' : '关闭',
                style: next ? 'default' : 'destructive',
                onPress: () => {
                  void session.sendCmdRequest(`desktop-set-${Date.now()}`, 'desktop.set', { on: next }).catch(() => {});
                },
              },
            ],
          );
        }}
        onToggleAutoSwitch={() => {
          if (!props.commandState) return;
          const next = hostToggleNext(props.commandState.autoswitch);
          void session.sendCmdRequest(`autoswitch-set-${Date.now()}`, 'autoswitch.set', { on: next }).catch(() => {});
        }}
        onOpenCompact={() => {
          setSessionSheetOpen(false);
          setCompactSheetOpen(true);
        }}
        onOpenGoal={() => {
          setSessionSheetOpen(false);
          if (props.commandState?.goal) setGoalStateOpen(true);
          else setGoalInputOpen(true);
        }}
        onOpenIdea={ideaAvailable ? () => { setSessionSheetOpen(false); openIdeaCapture(); } : undefined}
        onOpenImprove={improveAvailable ? () => { setSessionSheetOpen(false); summonImprove(); } : undefined}
        onOpenMemory={memoryAvailable ? () => { setSessionSheetOpen(false); setMemorySheetOpen(true); } : undefined}
        onSessionMismatch={
          props.commandState?.sessionId && effectiveId !== 'new' && props.commandState.sessionId !== effectiveId
            ? '桌面正在其它会话上工作，以下值以桌面为准'
            : null
        }
      />
      {/* 闪念捕获：可发现路径在 ＋ 菜单首行与 ☰ 维护节行（快捷路径=App 级悬浮球，不在此屏）；
          回执走 App 根级 cmdResult toast */}
      {/* M2 模型选择器（惰性拉取 + 思考强度分段；落定以 cmd.state 回流为准） */}
      <ModelPickerSheet
        visible={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        session={session}
        commandState={props.commandState}
      />
      {/* 记忆库面板（直记+事后治理）：打开即 memory.seen 巡检上报，维护节「N 新」随之归零 */}
      <MemorySheet
        visible={memorySheetOpen}
        onClose={() => setMemorySheetOpen(false)}
        session={session}
      />
      {/* M3 前台选择器 / 压缩确认 */}
      <FrontPickerSheet
        visible={frontPickerOpen}
        onClose={() => setFrontPickerOpen(false)}
        session={session}
        commandState={props.commandState}
      />
      <CompactConfirmSheet
        visible={compactSheetOpen}
        onClose={() => setCompactSheetOpen(false)}
        session={session}
        commandState={props.commandState}
      />
      {/* M4 目标生命周期 */}
      <GoalInputSheet visible={goalInputOpen} onClose={() => setGoalInputOpen(false)} session={session} />
      <GoalStateSheet
        visible={goalStateOpen}
        onClose={() => setGoalStateOpen(false)}
        session={session}
        goal={props.commandState?.goal ?? null}
      />
    </View>
  );
}

/**
 * 思考区（灰区层）：浅灰小字（字体本身就是区分度，不加竖线不加三角）。
 * 流式中：一行高，内容滚动（露尾部，运动即活着的信号）；
 * 收敛后：露最后一段（\n\n 分段取末段，无分段=全文即末段完整显示），点按展开全文/再点收起（直觉操作，无指示符）。
 */
function ThinkRegion({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  let display = text;
  if (streaming) {
    display = text.length > 60 ? `…${text.slice(-60)}` : text; // 一行滚动：只露尾部
  } else if (!expanded) {
    const paras = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    display = paras.length > 0 ? paras[paras.length - 1]! : text;
  }
  return (
    <TouchableOpacity
      style={styles.thinkRegion}
      onPress={() => !streaming && setExpanded((v) => !v)}
      activeOpacity={streaming ? 1 : 0.7}
    >
      <Text style={styles.thinkText} numberOfLines={streaming ? 1 : undefined}>
        {display}
      </Text>
    </TouchableOpacity>
  );
}

/** 工具行（灰区层）：一行灰字保留在流里（审计线索）；点按展开参数摘要/结果预览（直觉操作，无三角指示符） */
function ToolLine({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const d = msg.toolDetail;
  return (
    <View>
      <TouchableOpacity onPress={() => d && setExpanded((v) => !v)} activeOpacity={d ? 0.7 : 1}>
        <Text style={styles.toolLine}>{msg.text}</Text>
      </TouchableOpacity>
      {expanded && d ? (
        <View style={styles.toolDetail}>
          {d.paramsSummary ? <Text style={styles.toolDetailText}>参数：{d.paramsSummary}</Text> : null}
          {d.resultPreview ? <Text style={styles.toolDetailText}>结果：{d.resultPreview}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * 审批卡片（控件层，全界面唯一的卡）：
 * 点击后按钮立即禁用显示"提交中…"（防连点产生第二个 response 被 cancelled 覆盖真实终态）；
 * 投递失败恢复可点并提示重试；卡片变灰的唯一触发是 approval.resolved 信封，本地点击不假装落定。
 */
function ApprovalCard({
  msg,
  onDecision,
}: {
  msg: ChatMessage;
  onDecision: (id: string, decision: 'approve' | 'reject' | 'session') => Promise<void>;
}) {
  const info = msg.approval!;
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [, forceTick] = useState(0);

  // 倒计时（有 timeoutAt 时；手机本地时钟对桌面死线的近似显示，真正死线在桌面执行）
  useEffect(() => {
    if (info.timeoutAt === undefined || info.settled) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [info.timeoutAt, info.settled]);

  const decide = async (decision: 'approve' | 'reject' | 'session') => {
    setSubmitting(true);
    setFailed(false);
    try {
      await onDecision(info.id, decision);
      // 成功投递：保持"提交中…"，等 approval.resolved 信封落定
    } catch {
      setSubmitting(false);
      setFailed(true);
    }
  };

  const settledText = (() => {
    if (!info.settled) return null;
    const { approved, by } = info.settled;
    if (by === 'phone') return approved ? '已批准（手机）' : '已拒绝（手机）';
    if (by === 'timeout') return '超时已拒绝';
    if (by === 'cancelled') return '该审批已失效';
    return approved ? '已在桌面批准' : '已在桌面拒绝';
  })();

  const remainingMs = info.timeoutAt !== undefined ? info.timeoutAt - Date.now() : undefined;
  const countdown =
    remainingMs !== undefined && remainingMs > 0
      ? `${Math.floor(remainingMs / 60000)}:${String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, '0')}`
      : undefined;

  return (
    <View style={[styles.approvalCard, info.settled ? styles.approvalCardSettled : null]}>
      <Text style={styles.approvalTitle}>
        {info.kind === 'command' ? (info.sessionGrantable ? '⚠️ 桌面操作' : '⚠️ 命令审批') : '⚠️ 写入审批'}
      </Text>
      {info.summary ? <Text style={styles.approvalSummary}>{info.summary}</Text> : null}
      {info.preview ? (
        <TouchableOpacity onPress={() => setShowPreview((v) => !v)} activeOpacity={0.7}>
          <Text style={styles.approvalPreviewToggle}>{showPreview ? '收起预览 ▲' : '查看预览 ▼'}</Text>
          {showPreview ? <Text style={styles.approvalPreview}>{info.preview}</Text> : null}
        </TouchableOpacity>
      ) : null}
      {info.settled ? (
        <Text style={styles.approvalSettledText}>{settledText}</Text>
      ) : submitting ? (
        <Text style={styles.approvalCountdown}>提交中…</Text>
      ) : (
        <View>
          {failed ? <Text style={styles.approvalFailed}>投递失败，请重试</Text> : null}
          {countdown !== undefined ? (
            <Text style={styles.approvalCountdown}>剩余 {countdown}（超时自动拒绝）</Text>
          ) : null}
          <View style={styles.approvalBtns}>
            <TouchableOpacity style={styles.approveBtn} onPress={() => void decide('approve')}>
              <Text style={styles.approvalBtnText}>批准</Text>
            </TouchableOpacity>
            {/* 桌面操作审批（sessionGrantable）：本次会话放行——对齐桌面 CLI [s]/桌面 UI 语义 */}
            {info.sessionGrantable === true ? (
              <TouchableOpacity style={styles.sessionBtn} onPress={() => void decide('session')}>
                <Text style={styles.approvalBtnText}>本次会话放行</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.rejectBtn} onPress={() => void decide('reject')}>
              <Text style={styles.approvalBtnText}>拒绝</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * 提问卡片（M4e 控件层，与审批卡同骨架）：
 * 问题全文（自带语境与规划预览）+ 选项按钮列（N 个，发 label 原文）+ 自由文本输入
 * （allowFreeText 时，占位用 hint）+ 跳过按钮。点击即禁用显示"提交中…"（防连点）；
 * 投递失败恢复可点并提示重试；卡片变灰的唯一触发是 ask.resolved 信封，本地点击不假装落定。
 */
function QuestionCard({
  msg,
  onAnswer,
}: {
  msg: ChatMessage;
  onAnswer: (id: string, answer: string) => Promise<void>;
}) {
  const info = msg.ask!;
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [freeText, setFreeText] = useState('');

  const answer = async (text: string) => {
    setSubmitting(true);
    setFailed(false);
    try {
      await onAnswer(info.id, text);
      // 成功投递：保持"提交中…"，等 ask.resolved 信封落定
    } catch {
      setSubmitting(false);
      setFailed(true);
    }
  };

  const settledText = (() => {
    if (!info.settled) return null;
    const { answer: a, by } = info.settled;
    if (by === 'phone') return `已回答（手机）：${a || '跳过'}`;
    if (by === 'cancelled') return '该提问已失效';
    return `已在别处作答：${a || '跳过'}`;
  })();

  return (
    <View style={[styles.approvalCard, styles.questionCard, info.settled ? styles.approvalCardSettled : null]}>
      <Text style={styles.questionTitle}>❓ 提问</Text>
      <ScrollView style={styles.questionBody} nestedScrollEnabled showsVerticalScrollIndicator>
        <MarkdownText text={info.question} baseStyle={styles.approvalSummary} />
      </ScrollView>
      {info.settled ? (
        <Text style={styles.approvalSettledText}>{settledText}</Text>
      ) : submitting ? (
        <Text style={styles.approvalCountdown}>提交中…</Text>
      ) : (
        <View>
          {failed ? <Text style={styles.approvalFailed}>投递失败，请重试</Text> : null}
          {info.options && info.options.length > 0 ? (
            <View style={styles.questionOptions}>
              {info.options.map((opt) => (
                <TouchableOpacity key={opt.label} style={styles.questionOptionBtn} onPress={() => void answer(opt.label)}>
                  <Text style={styles.approvalBtnText}>{opt.label}</Text>
                  {opt.description ? <Text style={styles.questionOptionDesc}>{opt.description}</Text> : null}
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
          {info.allowFreeText ? (
            <View style={styles.questionFreeRow}>
              <TextInput
                style={styles.questionFreeInput}
                value={freeText}
                onChangeText={setFreeText}
                placeholder={info.hint ?? '也可直接输入回答'}
                placeholderTextColor="#666"
                onSubmitEditing={() => freeText.trim() && void answer(freeText.trim())}
              />
              <TouchableOpacity
                style={[styles.sendBtn, !freeText.trim() && styles.questionBtnDisabled]}
                onPress={() => freeText.trim() && void answer(freeText.trim())}
              >
                <Text style={styles.sendText}>发送</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {info.options && info.options.length > 0 ? (
            <TouchableOpacity onPress={() => void answer('跳过')}>
              <Text style={styles.questionSkip}>跳过 — 不回答此问题</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** 字节数人类可读（卡片大小/进度行共用） */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * d→m 文件卡片（控件层，与审批/提问卡同骨架；对话流内联——不开专门的文件接收区，
 * 文件是该轮对话的产物，就长在该轮对话里）：
 * 相位分派唯一事实点 = syncUiLogic.fileCardPhase（推导，不发信号）——
 * 待接收[接收] / 暂停续传（断点可见）/ 准备中（不确定条）/ 下载中（确定进度）/ 校验落盘 /
 * 已保存[打开] / 失败原因+[重试] / 已过期灰显。
 * 状态唯一真相源 = receivedFiles 落库后的 session 事件；本地点击只发意图（receiveFile/cancelReceiveFile），不假落定。
 * 乐观层（pendingAck/pendingCancel）：点击的 0ms 本地回执贴纸——真相到达（state 落定变化）即让位，
 * 超时回退（闸门拒收/取消延迟的诚实表达）；贴纸永不写库、永不发协议。
 */
function FileCard({
  msg,
  onReceive,
  onCancel,
  onOpen,
}: {
  msg: ChatMessage;
  onReceive: (fileId: string) => void;
  onCancel: (fileId: string) => void;
  onOpen: (uri: string, mime: string) => void;
}) {
  const c = msg.fileCard!;
  const [pendingAck, setPendingAck] = useState(false);
  const [pendingCancel, setPendingCancel] = useState(false);
  // 让位：真相落定（state 变化）即清贴纸——offered→pulling 清接收贴纸，pulling→offered 清取消贴纸
  useEffect(() => {
    setPendingAck(false);
    setPendingCancel(false);
  }, [c.state]);
  // 超时回退：闸门拒收（接收 2s）/ 取消片边界延迟（最长一个分片的网络时间，5s）
  useEffect(() => {
    if (!pendingAck) return;
    const t = setTimeout(() => setPendingAck(false), 2000);
    return () => clearTimeout(t);
  }, [pendingAck]);
  useEffect(() => {
    if (!pendingCancel) return;
    const t = setTimeout(() => setPendingCancel(false), 5000);
    return () => clearTimeout(t);
  }, [pendingCancel]);

  const phase = fileCardPhase(c, Date.now());
  const handleReceive = () => {
    setPendingAck(true);
    onReceive(c.fileId);
  };
  const handleCancel = () => {
    setPendingCancel(true);
    onCancel(c.fileId);
  };
  const cancelBtn = (
    <TouchableOpacity style={styles.rejectBtn} onPress={handleCancel} disabled={pendingCancel}>
      <Text style={styles.approvalBtnText}>{pendingCancel ? '正在取消…' : '取消'}</Text>
    </TouchableOpacity>
  );
  const receiveBtn = (
    <TouchableOpacity style={[styles.approveBtn, styles.fileRecvBtn]} onPress={handleReceive} disabled={pendingAck}>
      {pendingAck ? <ActivityIndicator size="small" color="#fff" /> : null}
      <Text style={styles.approvalBtnText}>{pendingAck ? '正在接收…' : '接收'}</Text>
    </TouchableOpacity>
  );
  const settled = phase.kind === 'done' || phase.kind === 'expired';
  return (
    <View style={[styles.approvalCard, styles.fileCard, settled ? styles.approvalCardSettled : null, phase.kind === 'expired' ? styles.fileCardDim : null]}>
      <Text style={styles.fileTitle}>📄 {c.name}</Text>
      <Text style={styles.fileMeta}>{formatBytes(c.size)}{c.mime ? ` · ${c.mime}` : ''}</Text>
      {phase.kind === 'expired' ? (
        <Text style={styles.approvalSettledText}>已过期（48 小时保留期已过，请让桌面重新发送）</Text>
      ) : phase.kind === 'preparing' ? (
        <View>
          <IndeterminateBar />
          <Text style={styles.fileMeta}>准备中…</Text>
          <View style={styles.approvalBtns}>{cancelBtn}</View>
        </View>
      ) : phase.kind === 'downloading' ? (
        <View>
          <View style={styles.fileProgressTrack}>
            <View style={[styles.fileProgressFill, { width: `${phase.pct}%` }]} />
          </View>
          <Text style={styles.fileMeta}>{formatBytes(phase.received)} / {formatBytes(phase.total)} · {phase.pct}%</Text>
          <View style={styles.approvalBtns}>{cancelBtn}</View>
        </View>
      ) : phase.kind === 'verifying' ? (
        <View>
          <View style={styles.fileProgressTrack}>
            <View style={[styles.fileProgressFill, { width: '100%' }]} />
          </View>
          <Text style={styles.fileMetaPhase}>校验并写入下载目录…</Text>
        </View>
      ) : phase.kind === 'done' ? (
        <View>
          <Text style={styles.approvalSettledText}>已存到 下载/chill/</Text>
          {c.contentUri ? (
            <View style={styles.approvalBtns}>
              <TouchableOpacity style={styles.approveBtn} onPress={() => onOpen(c.contentUri!, c.mime)}>
                <Text style={styles.approvalBtnText}>打开</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      ) : phase.kind === 'failed' ? (
        <View>
          <Text style={styles.approvalFailed}>{phase.error ?? '接收失败'}</Text>
          <View style={styles.approvalBtns}>
            <TouchableOpacity style={[styles.questionOptionBtn, styles.fileRecvBtn]} onPress={handleReceive} disabled={pendingAck}>
              {pendingAck ? <ActivityIndicator size="small" color="#fff" /> : null}
              <Text style={styles.approvalBtnText}>{pendingAck ? '正在接收…' : '重试'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : phase.kind === 'paused' ? (
        <View>
          <View style={styles.fileProgressTrack}>
            <View style={[styles.fileProgressFill, styles.fileProgressPaused, { width: `${phase.pct}%` }]} />
          </View>
          <Text style={styles.fileMetaPaused}>已暂停 · 已完成 {phase.pct}% · 点接收继续</Text>
          <View style={styles.approvalBtns}>{receiveBtn}</View>
        </View>
      ) : (
        <View style={styles.approvalBtns}>{receiveBtn}</View>
      )}
    </View>
  );
}

/** 准备中不确定条（滑动光带；transform translateX 走 native driver，width/left 不动画） */
function IndeterminateBar() {
  const [trackW, setTrackW] = useState(0);
  const x = useSharedValue(0);
  useEffect(() => {
    if (trackW <= 0) return;
    x.value = -0.38 * trackW;
    x.value = withRepeat(withTiming(trackW, { duration: 1150 }), -1, false);
  }, [trackW, x]);
  const aStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View style={styles.fileProgressTrack} onLayout={(ev) => setTrackW(ev.nativeEvent.layout.width)}>
      {trackW > 0 ? <Animated.View style={[styles.fileProgressIndet, aStyle]} /> : null}
    </View>
  );
}

/**
 * media 行渲染（file.* 协议族）：
 * - 图片 + 本地副本 → 缩略图网格（持久渲染——落定历史与本机回显同形态）
 * - 文件/视频 → 芯片（名称+类型字形；永不降级）
 * - 图片无本地副本（换机/清数据/桌面侧媒体）→ 诚实降级占位行"🖼 请在桌面查看"
 */
function MediaRow({ msg, onLinkPress, onImagePress }: { msg: ChatMessage; onLinkPress: (url: string) => boolean; onImagePress: (uri: string) => void }) {
  void onLinkPress; // 预留：芯片内链接路由（当前芯片无链接，占位保持签名稳定）
  if (!msg.media || msg.media.items.length === 0) {
    return <Text style={styles.mediaLine}>{msg.text}</Text>;
  }
  const images = msg.media.items.filter((i) => i.kind === 'image' && i.localUri);
  const degradedImage = msg.media.items.some((i) => i.kind === 'image' && !i.localUri);
  const fileItems = msg.media.items.filter((i) => i.kind !== 'image');
  return (
    <View>
      {msg.text && msg.text.trim().length > 0 ? (
        <Text style={msg.dir === 'out' ? styles.outText : styles.mediaText}>{msg.text}</Text>
      ) : null}
      {images.length > 0 ? (
        <View style={styles.mediaGrid}>
          {images.map((i) => (
            <ImageGridThumb key={i.ref} localUri={i.localUri!} onPress={() => onImagePress(i.localUri!)} />
          ))}
        </View>
      ) : null}
      {fileItems.map((i) => (
        <View key={i.ref} style={styles.trayChip}>
          <Text style={styles.trayChipIcon}>{i.mime.startsWith('video/') ? '▶' : '▣'}</Text>
          <Text style={styles.trayChipName} numberOfLines={1}>
            {i.name}
          </Text>
        </View>
      ))}
      {degradedImage ? <Text style={styles.mediaLine}>🖼 部分图片请在桌面查看（本机无副本）</Text> : null}
    </View>
  );
}

/** 缩略图（托盘与 media 行共用；RN Image 只认带 scheme 的 URI——旧数据裸路径归一，真机实测教训） */
function ImageGridThumb({ localUri, onPress }: { localUri: string; onPress?: () => void }) {
  const uri = localUri.startsWith('file://') ? localUri : `file://${localUri}`;
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper onPress={onPress} activeOpacity={onPress ? 0.8 : 1}>
      <Image source={{ uri }} style={styles.thumb} resizeMode="cover" />
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0f14' },
  kavBody: { flex: 1 },
  // 恒渲染控显隐（display:none 保持节点在树内、下标永不平移——Fabric 竞态嫌犯类的构造性消除）
  hidden: { display: 'none' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, marginTop: 36, gap: 8 },
  backLink: { color: '#3b82f6', fontSize: 26, paddingHorizontal: 6 },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '600', flex: 1 },
  headerTitleCol: { flex: 1 },
  headerSubtitle: { color: '#6b7280', fontSize: 11, marginTop: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modeBadge: { color: '#9aa4b2', fontSize: 12, borderWidth: 1, borderColor: '#374151', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  planBadge: { color: '#a5b4fc', fontSize: 12, borderWidth: 1, borderColor: '#4338ca', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  modeBadgeDanger: { color: '#fbbf24', borderColor: '#b45309', fontWeight: '700' },
  headerLink: { color: '#3b82f6', fontSize: 15 },
  /** 头部图标按钮（＋/☰）：纯文字字形与 ＋ 同风格（不用 emoji 彩色大图标） */
  headerIcon: { color: '#3b82f6', fontSize: 18, paddingHorizontal: 3 },
  offlineBar: { backgroundColor: '#7c2d12', padding: 6, alignItems: 'center' },
  offlineText: { color: '#fdba74', fontSize: 12 },
  // M6c 桌面未在线条（已连中继但桌面无来信）：琥珀调，与"重连中"的橙红区分
  desktopOfflineBar: { backgroundColor: '#3f2d12', padding: 4, alignItems: 'center' },
  desktopOfflineText: { color: '#fbbf24', fontSize: 11 },
  // 附着未确认前的"同步中"条（请求-确认制，不假落定）
  syncingBar: { backgroundColor: '#1f2937', padding: 4, alignItems: 'center' },
  syncingText: { color: '#6b7280', fontSize: 11 },
  list: { flex: 1, paddingHorizontal: 12 },
  // 列表内容底部留白（自然时间序坐标系）
  listContent: { paddingBottom: 12 },
  // 回到底部浮钮（用户上翻离开底部时出现；克制的深色小圆钮）
  jumpBtn: {
    position: 'absolute',
    right: 16,
    bottom: 76,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1f2937',
    borderWidth: 1,
    borderColor: '#374151',
    alignItems: 'center',
    justifyContent: 'center',
  },
  jumpBtnText: { color: '#9ca3af', fontSize: 18, lineHeight: 22 },
  desktopBadge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(59,130,246,0.14)',
    borderColor: 'rgba(59,130,246,0.45)',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 6,
  },
  desktopBadgeText: { color: '#93c5fd', fontSize: 12, lineHeight: 16 },
  // 用户消息：蓝色气泡右对齐（唯一有色块、方向锚）
  outBubble: {
    backgroundColor: '#1d4ed8',
    borderRadius: 12,
    padding: 10,
    marginVertical: 4,
    maxWidth: '82%',
    alignSelf: 'flex-end',
  },
  outText: { color: '#fff', fontSize: 15, lineHeight: 21 },
  // assistant 正文：裸文本（无气泡、满宽）
  contentText: { color: '#e5e7eb', fontSize: 15, lineHeight: 22, marginVertical: 6 },
  // 思考区（灰区层）：浅灰小字（无竖线无三角，字体即区分度）
  thinkRegion: {
    paddingLeft: 2,
    marginVertical: 3,
  },
  thinkText: { color: '#6b7280', fontSize: 12, lineHeight: 17 },
  // 工具行（灰区层）：一行灰字，与其他元素左对齐（不缩进）
  toolLine: { color: '#4b5563', fontSize: 12, marginVertical: 2, paddingLeft: 2 },
  toolDetail: {
    borderLeftWidth: 2,
    borderLeftColor: '#374151',
    marginLeft: 12,
    paddingLeft: 10,
    marginBottom: 4,
  },
  toolDetailText: { color: '#6b7280', fontSize: 12, lineHeight: 17, marginVertical: 2 },
  // 系统提示行（最淡一行）；notice=合成消息提示行（同待遇）
  systemLine: { color: '#374151', fontSize: 11, marginVertical: 2, paddingLeft: 12 },
  // 媒体占位行（图/视频/音频：请在桌面查看）
  mediaLine: { color: '#4b5563', fontSize: 12, marginVertical: 2, paddingLeft: 12, fontStyle: 'italic' },
  // 审批卡（控件层，唯一有色卡片）
  approvalCard: {
    backgroundColor: '#1c1917',
    borderColor: '#b45309',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginVertical: 6,
    maxWidth: '92%',
  },
  approvalCardSettled: { borderColor: '#374151', opacity: 0.75 },
  approvalTitle: { color: '#fbbf24', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  approvalSummary: { color: '#e5e7eb', fontSize: 14, lineHeight: 20 },
  approvalPreviewToggle: { color: '#3b82f6', fontSize: 12, marginTop: 6 },
  approvalPreview: { color: '#9ca3af', fontSize: 12, lineHeight: 17, marginTop: 4, fontFamily: 'monospace' },
  approvalCountdown: { color: '#fbbf24', fontSize: 12, marginTop: 8 },
  approvalFailed: { color: '#ef4444', fontSize: 12, marginTop: 8 },
  approvalBtns: { flexDirection: 'row', gap: 12, marginTop: 10 },
  approveBtn: { backgroundColor: '#166534', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 24 },
  // 桌面操作「本次会话放行」：软绿描边款（区别于单次批准的实心绿，对齐桌面 UI 的次要动作视觉）
  sessionBtn: { backgroundColor: 'rgba(22, 101, 52, 0.25)', borderColor: '#166534', borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16 },
  rejectBtn: { backgroundColor: '#7f1d1d', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 24 },
  approvalBtnText: { color: '#fff', fontWeight: '600' },
  approvalSettledText: { color: '#9ca3af', fontSize: 13, marginTop: 8 },
  // 提问卡（M4e：蓝色调，与审批卡的琥珀色调区分）
  questionCard: { borderColor: '#1d4ed8' },
  // d→m 文件卡（青绿色调，与审批/提问卡区分；卡片=对话流内联产物）
  fileCard: { borderColor: '#0f766e' },
  fileCardDim: { opacity: 0.5 },
  fileTitle: { color: '#e5e7eb', fontSize: 14, fontWeight: '600' },
  fileMeta: { color: '#6b7280', fontSize: 12, marginTop: 3 },
  fileMetaPhase: { color: '#2dd4bf', fontSize: 12, marginTop: 6 },
  fileMetaPaused: { color: '#d29922', fontSize: 12, marginTop: 6 },
  fileProgressTrack: { height: 4, borderRadius: 2, backgroundColor: '#1f2937', marginTop: 10, overflow: 'hidden' },
  fileProgressFill: { height: 4, borderRadius: 2, backgroundColor: '#2dd4bf' },
  fileProgressPaused: { opacity: 0.45 },
  fileProgressIndet: { position: 'absolute', left: 0, top: 0, width: '38%', height: 4, borderRadius: 2, backgroundColor: '#2dd4bf' },
  fileRecvBtn: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // 文件 done 胶囊 toast（ChatScreen 顶部绝对定位，2s 消隐）
  fileToast: {
    position: 'absolute', top: 10, alignSelf: 'center', zIndex: 20,
    backgroundColor: '#10231a', borderColor: '#166534', borderWidth: 1, borderRadius: 16,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  fileToastText: { color: '#7ee787', fontSize: 12 },
  questionBody: { maxHeight: QUESTION_MAX_HEIGHT },
  questionTitle: { color: '#60a5fa', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  questionOptions: { gap: 8, marginTop: 10 },
  questionOptionBtn: { backgroundColor: '#1e3a5f', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14 },
  questionOptionDesc: { color: '#93c5fd', fontSize: 11, marginTop: 2 },
  questionFreeRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  questionFreeInput: { flex: 1, backgroundColor: '#151b24', color: '#fff', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  questionSkip: { color: '#6b7280', fontSize: 12, marginTop: 10 },
  questionBtnDisabled: { opacity: 0.4 },
  inputRow: { flexDirection: 'row', padding: 10, gap: 8, alignItems: 'center' },
  // ---------- file.* 附件 UI ----------
  attachBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: '#151b24',
    borderWidth: 1, borderColor: '#232c3a', alignItems: 'center', justifyContent: 'center',
  },
  attachBtnText: { color: '#3b82f6', fontSize: 20, lineHeight: 24 },
  tray: { maxHeight: 96, paddingLeft: 10 },
  trayContent: { flexDirection: 'row', gap: 8, paddingRight: 10, alignItems: 'flex-start' },
  trayItem: { width: 96, alignItems: 'center' },
  trayState: { color: '#6b7280', fontSize: 10, marginTop: 3, maxWidth: 96 },
  trayRm: {
    position: 'absolute', top: -4, right: 2, width: 20, height: 20, borderRadius: 10,
    backgroundColor: '#111827', borderWidth: 1, borderColor: '#374151',
    alignItems: 'center', justifyContent: 'center',
  },
  trayRmText: { color: '#9ca3af', fontSize: 12, lineHeight: 14 },
  thumb: { width: 84, height: 84, borderRadius: 8, backgroundColor: '#1a2230' },
  trayChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#151b24',
    borderWidth: 1, borderColor: '#232c3a', borderRadius: 8, paddingHorizontal: 10,
    paddingVertical: 8, marginVertical: 2, maxWidth: 260,
  },
  trayChipIcon: { color: '#3b82f6', fontSize: 14 },
  trayChipName: { color: '#e5e7eb', fontSize: 12, flexShrink: 1 },
  mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 4 },
  mediaText: { color: '#9ca3af', fontSize: 13, marginVertical: 2 },
  localPreviewBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  localPreviewCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  localPreviewImg: { width: '100%', height: '85%' },
  localPreviewHint: { color: '#6b7280', fontSize: 12, marginTop: 12 },
  attachBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  attachSheet: { backgroundColor: '#10161f', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 34, paddingTop: 18, paddingHorizontal: 20 },
  attachSheetTitle: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 4 },
  attachSheetMeta: { color: '#6b7280', fontSize: 12, marginBottom: 14 },
  attachSheetItem: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1a2230' },
  attachSheetItemIcon: { color: '#3b82f6', fontSize: 20, width: 26, textAlign: 'center' },
  attachSheetItemText: { color: '#e5e7eb', fontSize: 15 },
  attachSheetCancel: { marginTop: 14, backgroundColor: '#1a2230', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  attachSheetCancelText: { color: '#9ca3af', fontSize: 15 },
  input: { flex: 1, backgroundColor: '#151b24', color: '#fff', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  // 发送/停止：扁平圆钮，与 ＋ 同族（无投影）；发送=实心蓝 accent，停止=深灰细边+红 ■（克制点出语义）
  sendBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 18,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { color: '#fff', fontSize: 17, lineHeight: 20, fontWeight: '700', marginLeft: 1, marginTop: -1 },
  stopBtn: {
    backgroundColor: '#151b24',
    borderWidth: 1,
    borderColor: '#232c3a',
    borderRadius: 18,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopText: { color: '#ef4444', fontSize: 13, lineHeight: 15, fontWeight: '700' },
});
