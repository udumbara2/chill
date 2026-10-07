/**
 * FloatingCards.tsx — 全局浮层（任何屏可见）；归因分流 v5 + 手风琴模型（2026-10-04）。
 *
 * 手风琴呈现契约：所有未落定卡逐张可见、各以自然体量垂直堆叠（按快照序：审批在前、提问在后）——
 * 审批=紧凑可操作卡（允许/拒绝就在卡上，零展开）；普通提问=紧凑卡（选项/自由文本）。
 * 裁决卡（无归因 ask + card 载荷）是唯一例外：它只应"受邀存在"——
 * - 到达一律隐匿（首达/冷启动重放/重连重推都不打扰），展开唯一来源=本机召唤回执信号；
 * - 展开态=完整点选卡（复用 TriageCard，translucent 半透明）；
 * - 收起=**完全隐去**（不卸载：display:none 保活，重唤时点选不丢），发现性由专属重唤手势
 *   兜底（再长按 💡——召唤链重推同 id 卡 + 展开信号强制回展开态）。
 * 归因卡（含模型开庭的裁决卡）跨会话浮出时走紧凑卡+跳转（v5 契约），不进二态壳。
 * 落定（resolved 信封驱动 App 重算快照）自然清场。
 * 卡外点击穿透（overlay pointerEvents="box-none"）——下方会话交互不受影响。
 */
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import type { ApprovalCardInfo, AskCardInfo, ChatMessage } from '../relay/session';
import type { AskDecisionEntry } from '../relay/envelope';
import { TriageCard, type PageTurnResult } from '../screens/TriageCard';
import { validateTriageCard } from '../screens/triageLogic';
import type { FloatingCardPhase } from '../screens/syncUiLogic';

export type FloatingCardData =
  | { kind: 'approval'; info: ApprovalCardInfo }
  | { kind: 'ask'; info: AskCardInfo };

export default function FloatingCards(props: {
  cards: FloatingCardData[];
  /** 裁决卡二态阶段表（App 受控持有——召唤回执要跨快照强制展开） */
  courtPhases: Record<string, FloatingCardPhase>;
  onSetCourtPhase: (id: string, phase: FloatingCardPhase) => void;
  onApprovalDecision: (id: string, decision: 'approve' | 'reject' | 'session') => Promise<void>;
  /** ask 卡内联作答（选项 label 原文 / 自由文本；裁决卡 decisions 结构化双通道） */
  onAskAnswer: (id: string, answer: string, decisions?: AskDecisionEntry[]) => Promise<void>;
  /** 裁决卡原地翻页（improve.page cmd 一次往返；缺省=旧桌面/未接线，卡内维持文本「下一批」路径） */
  onTurnPage?: (dir: 'next' | 'prev', decisions: AskDecisionEntry[]) => Promise<PageTurnResult>;
  /** 点卡身直达（有归因卡传归因会话 id；无归因卡不跳——卡内作答） */
  onJumpToChat: (sessionId?: string) => void;
}) {
  if (props.cards.length === 0) return null;
  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {props.cards.map((card) =>
        card.kind === 'approval' ? (
          <CompactApprovalCard
            key={`approval-${card.info.id}`}
            info={card.info}
            onDecision={props.onApprovalDecision}
            onJumpToChat={props.onJumpToChat}
          />
        ) : courtTriageOf(card.info) !== null ? (
          <CourtCardBlock
            key={`ask-${card.info.id}`}
            info={card.info}
            triage={courtTriageOf(card.info)!}
            phase={props.courtPhases[card.info.id] ?? 'expanded'}
            onSetPhase={props.onSetCourtPhase}
            onAnswer={props.onAskAnswer}
            onTurnPage={props.onTurnPage}
          />
        ) : (
          <CompactAskCard
            key={`ask-${card.info.id}`}
            info={card.info}
            onAnswer={props.onAskAnswer}
            onJumpToChat={props.onJumpToChat}
          />
        ),
      )}
    </View>
  );
}

/** 裁决卡载荷判定（card 存在且形状校验有效；仅限无归因卡——归因卡跨会话浮出走紧凑卡+跳转的 v5 契约；无效落回紧凑文本卡——降级链不动） */
function courtTriageOf(info: AskCardInfo) {
  return info.sessionId == null && info.card !== undefined ? validateTriageCard(info.card) : null;
}

// ---------- 紧凑审批卡（自然形态=可操作；零展开概念） ----------

function CompactApprovalCard(props: {
  info: ApprovalCardInfo;
  onDecision: (id: string, decision: 'approve' | 'reject' | 'session') => Promise<void>;
  onJumpToChat: (sessionId?: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const decide = async (decision: 'approve' | 'reject' | 'session') => {
    setSubmitting(true);
    setFailed(false);
    try {
      await props.onDecision(props.info.id, decision);
      // 保持"提交中…"，等 resolved 落定消散（不假落定）
    } catch {
      setSubmitting(false);
      setFailed(true);
    }
  };
  const targetSid = props.info.sessionId ?? undefined;
  return (
    <View style={styles.card}>
      <TouchableOpacity
        onPress={() => (targetSid !== undefined ? props.onJumpToChat(targetSid) : undefined)}
        activeOpacity={targetSid !== undefined ? 0.8 : 1}
      >
        <Text style={styles.title}>
          {props.info.sessionGrantable === true ? '⚠️ 桌面操作' : '⚠️ 审批'}{targetSid !== undefined ? '（点击进入来源会话）' : ''}
        </Text>
        <Text style={styles.body} numberOfLines={2}>
          {props.info.summary}
        </Text>
      </TouchableOpacity>
      {failed ? <Text style={styles.failed}>投递失败，请重试</Text> : null}
      <View style={styles.btns}>
        <TouchableOpacity
          style={[styles.btn, styles.approve, submitting && styles.disabled]}
          onPress={() => void decide('approve')}
          disabled={submitting}
        >
          <Text style={styles.btnText}>{submitting ? '提交中…' : '允许'}</Text>
        </TouchableOpacity>
        {/* 桌面操作审批（sessionGrantable）：本次会话放行——对齐桌面 CLI [s]/桌面 UI 语义 */}
        {props.info.sessionGrantable === true ? (
          <TouchableOpacity
            style={[styles.btn, styles.session, submitting && styles.disabled]}
            onPress={() => void decide('session')}
            disabled={submitting}
          >
            <Text style={styles.btnText}>本次会话放行</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[styles.btn, styles.reject, submitting && styles.disabled]}
          onPress={() => void decide('reject')}
          disabled={submitting}
        >
          <Text style={styles.btnText}>拒绝</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---------- 紧凑提问卡（无裁决卡载荷的 ask；选项/自由文本就地作答） ----------

function CompactAskCard(props: {
  info: AskCardInfo;
  onAnswer: (id: string, answer: string, decisions?: AskDecisionEntry[]) => Promise<void>;
  onJumpToChat: (sessionId?: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [freeText, setFreeText] = useState('');
  const answer = async (a: string) => {
    setSubmitting(true);
    setFailed(false);
    setFreeText('');
    try {
      await props.onAnswer(props.info.id, a);
    } catch {
      setSubmitting(false);
      setFailed(true);
    }
  };
  const targetSid = props.info.sessionId ?? undefined;
  return (
    <View style={styles.card}>
      <TouchableOpacity
        onPress={() => (targetSid !== undefined ? props.onJumpToChat(targetSid) : undefined)}
        activeOpacity={targetSid !== undefined ? 0.8 : 1}
      >
        <Text style={styles.title}>
          ❓ 提问{targetSid !== undefined ? '（点击进入来源会话）' : ''}
        </Text>
        <Text style={styles.body} numberOfLines={4}>
          {props.info.question}
        </Text>
      </TouchableOpacity>
      {failed ? <Text style={styles.failed}>投递失败，请重试</Text> : null}
      <AskAnswerArea
        info={props.info}
        submitting={submitting}
        freeText={freeText}
        setFreeText={setFreeText}
        onAnswer={answer}
      />
    </View>
  );
}

// ---------- 裁决卡（唯一二态卡：完整点选 ⇄ 停靠 chip；折叠不卸载） ----------

function CourtCardBlock(props: {
  info: AskCardInfo;
  triage: NonNullable<ReturnType<typeof validateTriageCard>>;
  phase: FloatingCardPhase;
  onSetPhase: (id: string, phase: FloatingCardPhase) => void;
  onAnswer: (id: string, answer: string, decisions?: AskDecisionEntry[]) => Promise<void>;
  onTurnPage?: (dir: 'next' | 'prev', decisions: AskDecisionEntry[]) => Promise<PageTurnResult>;
}) {
  const parked = props.phase === 'parked';
  // TriageCard 只读 msg.ask（id/settled/hint 等由 AskCardInfo 供给）——以最小鸭子形状满足
  // 组件契约（复用唯一渲染器，不改 TriageCard 公共签名、不写第二套渲染）。
  // 壳不加自己的标题层（标题唯一出处=TriageCard）；收起钮经 headerAction 并入其标题行；
  // translucent=浮层形态半透明（时间线内嵌实底）。收起=display:none 保活不卸载，
  // 重唤=再长按 💡（召唤链重推同 id 卡 + 展开信号强制回展开态）——发现性由专属手势兜底。
  const msgShim = { id: props.info.id, dir: 'in', text: '', kind: 'ask', ts: 0, ask: props.info } as unknown as ChatMessage;
  return (
    <View style={parked ? styles.hidden : undefined}>
      <TriageCard
        msg={msgShim}
        card={props.triage}
        onAnswer={props.onAnswer}
        onTurnPage={props.onTurnPage}
        translucent
        headerAction={{ label: '收起 ▴', onPress: () => props.onSetPhase(props.info.id, 'parked') }}
      />
    </View>
  );
}

/** ask 内联作答区：选项按钮（label 原文作答）+ 自由文本（allowFreeText；裁决卡提示语法——走 answer 文本通道） */
function AskAnswerArea(props: {
  info: AskCardInfo;
  submitting: boolean;
  freeText: string;
  setFreeText: (t: string) => void;
  onAnswer: (answer: string) => void;
}) {
  const { info, submitting } = props;
  const hint =
    info.hint ?? (info.card !== undefined ? '文本指令作答（如 y C26 确认整簇 / s all 全部跳过）' : '输入回答…');
  return (
    <View>
      {info.options !== undefined && info.options.length > 0 ? (
        <View style={styles.btns}>
          {info.options.map((o) => (
            <TouchableOpacity
              key={o.label}
              style={[styles.btn, styles.optionBtn, submitting && styles.disabled]}
              onPress={() => props.onAnswer(o.label)}
              disabled={submitting}
            >
              <Text style={styles.btnText}>{submitting ? '提交中…' : o.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      {info.allowFreeText === true || info.options === undefined || info.options.length === 0 ? (
        <View style={styles.freeRow}>
          <TextInput
            style={styles.freeInput}
            value={props.freeText}
            onChangeText={props.setFreeText}
            placeholder={hint}
            placeholderTextColor="#6b7280"
            editable={!submitting}
          />
          <TouchableOpacity
            style={[styles.btn, styles.sendBtn, (submitting || props.freeText.trim().length === 0) && styles.disabled]}
            onPress={() => props.onAnswer(props.freeText.trim())}
            disabled={submitting || props.freeText.trim().length === 0}
          >
            <Text style={styles.btnText}>{submitting ? '…' : '回答'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 44, paddingHorizontal: 12, gap: 8 },
  card: {
    backgroundColor: '#1c1917',
    borderColor: '#b45309',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    // 深色浮层投影
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  title: { color: '#fbbf24', fontSize: 13, fontWeight: '700', marginBottom: 4 },
  body: { color: '#e5e7eb', fontSize: 13, lineHeight: 18 },
  btns: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10, alignItems: 'center' },
  btn: { borderRadius: 8, paddingVertical: 6, paddingHorizontal: 20 },
  approve: { backgroundColor: '#166534' },
  // 桌面操作「本次会话放行」：软绿描边款（次要动作视觉，与时间线内嵌卡同款）
  session: { backgroundColor: 'rgba(22, 101, 52, 0.25)', borderColor: '#166534', borderWidth: 1 },
  reject: { backgroundColor: '#7f1d1d' },
  optionBtn: { backgroundColor: '#374151' },
  sendBtn: { backgroundColor: '#1d4ed8' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  disabled: { opacity: 0.5 },
  failed: { color: '#ef4444', fontSize: 11, marginTop: 6 },
  freeRow: { flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' },
  freeInput: {
    flex: 1,
    backgroundColor: '#0c0a09',
    borderColor: '#57534e',
    borderWidth: 1,
    borderRadius: 8,
    color: '#e5e7eb',
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  // 裁决卡（壳零样式：标题/收起/半透明全在 TriageCard 内——唯一渲染器原则）
  hidden: { display: 'none' },
});
