/**
 * TriageCard.tsx — 改进提案点选裁决卡（只渲染组件；ChatScreen ask 分支在 card 形状校验有效时挂载，
 * 否则落回 QuestionCard 文本卡）。
 *
 * 迭代 3（单卡原地翻页）：`card.inplace && card.batch` 时卡尾渲染「‹ 上一批 · 第 x/y 批 · 下一批 ›」
 * （边界页对应侧禁用；翻页在飞期间禁用翻页与收卷按钮——防连点双翻/翻页与收卷竞态）；
 * 翻页=编译本页点选 → onTurnPage（improve.page cmd，先落账再翻页）→ 新页卡过 validateTriageCard
 * → 就地换页清选择（decided 标注由新页卡承接）；失败→卡内错误行+停留本页。
 * 已决行（entry.decided）渲染落定行不可点（不制造"可重复决策"假象）。
 * 底部按钮语义：无任何决策（本页+累计）=「跳过本轮」、有=「完成本轮」；收卷=累计审计文本+本页
 * 点选经 sendAskResponse 落定。`inplace` 缺失（旧桌面）维持既有「下一批 ›」发文本路径。
 *
 * 迭代 2 既有：簇级三态点选 + 簇头展开逐条 + 本批批量行（全部关闭两段式确认）+ 逃生舱。
 * 不渲染 question 全文（digest 由 card 自带）。展开/收起是组件本地 UI 态，不进决策 reducer。
 * 卡片变灰的唯一触发是 ask.resolved 信封，本地点击绝不假装落定（与 QuestionCard 同纪律）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Dimensions, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { AskDecisionEntry, AskTriageCard } from '../relay/envelope';
import type { ChatMessage } from '../relay/session';
import {
  clearSelections,
  compileAnswerTrail,
  compileDecisions,
  DECIDED_LABEL,
  migratePage,
  selectAllClusters,
  toggleCluster,
  toggleEntry,
  validateTriageCard,
  type TriageAction,
  type TriageState,
} from './triageLogic';

/** 簇列表限高内滚（对齐 ChatScreen QuestionCard 的 QUESTION_MAX_HEIGHT 口径，防多簇撑爆聊天流） */
const CLUSTER_LIST_MAX_HEIGHT = Math.round(Dimensions.get('window').height * 0.55);

/** 「全部关闭」两段式确认的武装窗口（超时自动解除，防误触残留） */
const ARM_CLOSE_ALL_MS = 3000;

const ACTIONS: Array<{ key: TriageAction; label: string }> = [
  { key: 'confirm', label: '✓ 确认' },
  { key: 'skip', label: '⊘ 跳过' },
  { key: 'close', label: '✕ 关闭' },
];

/** 「下一批」固定文本（旧桌面路径：core 开庭收口 `trimmed === '下一批'` 精确短路识别，勿改字面） */
const NEXT_BATCH_TEXT = '下一批';

/** 翻页回执形状（onTurnPage 的返回；card 为未校验的原始载荷，组件内过 validateTriageCard） */
export interface PageTurnResult {
  ok: boolean;
  card?: unknown;
  error?: string;
}

export function TriageCard({
  msg,
  card,
  onAnswer,
  onTurnPage,
  translucent = false,
  headerAction,
}: {
  msg: ChatMessage;
  card: AskTriageCard;
  onAnswer: (id: string, answer: string, decisions?: AskDecisionEntry[]) => Promise<void>;
  /** 原地翻页（improve.page cmd 一次往返；缺省=旧桌面/未接线，维持文本「下一批」路径） */
  onTurnPage?: (dir: 'next' | 'prev', decisions: AskDecisionEntry[]) => Promise<PageTurnResult>;
  /** 浮层形态：容器面改半透明（透出下方会话文字）；时间线内嵌形态保持实底——底下没有要透的内容 */
  translucent?: boolean;
  /** 标题行右侧动作（浮层收起钮；时间线不传=无）。标题只在 TriageCard 一处，壳层不得再叠标题 */
  headerAction?: { label: string; onPress: () => void };
}) {
  const info = msg.ask!;
  // 页态（单卡原地翻页）：pageCard=当前页载荷；trail=翻段落账的累计审计文本
  const [pageCard, setPageCard] = useState<AskTriageCard>(card);
  const [state, setState] = useState<TriageState>(clearSelections);
  const [trail, setTrail] = useState<string[]>([]);
  const [turning, setTurning] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  /** 批量行「本批全部关闭」两段式确认：true = 已武装，再点一次才生效 */
  const [armCloseAll, setArmCloseAll] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [escapeOpen, setEscapeOpen] = useState(false);
  const [freeText, setFreeText] = useState('');
  /** 簇头展开（组件本地 UI 态，不进决策 reducer） */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  // ask 重推（断线重连 resync：卡回第一批且无已决标注——规划明示的已知行为）→ 页态归位，
  // 已落账决策不受影响（再翻一页即拿回带标注的页卡自愈）
  useEffect(() => {
    setPageCard(card);
    setState(clearSelections());
    setTrail([]);
    setPageError(null);
    setExpanded({});
  }, [card]);

  const compiled = compileDecisions(pageCard, state);
  const selectedCount = compiled.decisions.length;
  const hasAnyDecision = selectedCount > 0 || trail.length > 0;

  const disarmCloseAll = () => {
    setArmCloseAll(false);
    if (armTimer.current) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  };

  const send = async (answer: string, decisions?: AskDecisionEntry[]) => {
    setSubmitting(true);
    setFailed(false);
    try {
      await onAnswer(info.id, answer, decisions);
      // 成功投递：保持"提交中…"，等 ask.resolved 信封落定
    } catch {
      setSubmitting(false);
      setFailed(true);
    }
  };

  /** 收卷：有任何决策（含翻页已落账的累计段）→ 完成本轮（累计审计文本+本页点选落定）；无 → 跳过本轮 */
  const finish = () => {
    if (turning) return; // 翻页在飞禁收卷（竞态防护）
    const answerText = compileAnswerTrail(trail, compiled.text);
    if (answerText === null) {
      void send('跳过本轮');
      return;
    }
    void send(answerText, compiled.decisions.length > 0 ? compiled.decisions : undefined);
  };

  /** 旧桌面路径（无 inplace）：发文本「下一批」连同本页点选（先落账再翻页由桌面收口承担） */
  const nextBatchLegacy = () => {
    void send(NEXT_BATCH_TEXT, compiled.decisions.length > 0 ? compiled.decisions : undefined);
  };

  /** 原地翻页：编译本页点选随 cmd 先落账 → 新页卡过校验就地换页；失败停留本页+错误行 */
  const turnPage = (dir: 'next' | 'prev') => {
    if (!onTurnPage || turning || submitting) return;
    const pageCompiled = compileDecisions(pageCard, state);
    setTurning(true);
    setPageError(null);
    void onTurnPage(dir, pageCompiled.decisions)
      .then((r) => {
        setTurning(false);
        const next = r.ok && r.card !== undefined ? validateTriageCard(r.card) : null;
        if (!r.ok || next === null) {
          setPageError(!r.ok ? `翻页失败：${r.error ?? '未知原因'}` : '新页卡数据无效，停留本页');
          return;
        }
        const mig = migratePage(trail, pageCompiled.text);
        setState(mig.state);
        setTrail(mig.trail);
        setPageCard(next);
        setExpanded({});
      })
      .catch((err: unknown) => {
        setTurning(false);
        setPageError(`翻页失败：${err instanceof Error ? err.message : String(err)}`);
      });
  };

  const batchCloseAll = () => {
    if (!armCloseAll) {
      // 第一段：武装（按钮变确认态），窗口内再点才生效
      setArmCloseAll(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => {
        armTimer.current = null;
        setArmCloseAll(false);
      }, ARM_CLOSE_ALL_MS);
      return;
    }
    disarmCloseAll();
    setState(selectAllClusters(pageCard, 'close'));
  };

  // 分页：原地翻页（inplace+batch）优先；旧桌面（无 inplace）维持文本「下一批」路径
  const inPlace = pageCard.inplace === true && pageCard.batch !== undefined && onTurnPage !== undefined;
  const batch = pageCard.batch;
  const hiddenClusters = batch ? batch.total - batch.offset - pageCard.clusters.length : 0;
  // 真实页码（core 布局前置下发，pageCount 恒定）：在场直读——页码显示与翻页边界都用它；
  // 字段缺失（旧桌面）回退 offset 边界推算 + 省略页码指示（干扰最小，不复活估算）
  const hasRealPage = batch?.pageIndex !== undefined && batch?.pageCount !== undefined;
  const hasPrev = batch !== undefined && (hasRealPage ? batch.pageIndex! > 0 : batch.offset > 0);
  const hasNext = batch !== undefined && (hasRealPage ? batch.pageIndex! + 1 < batch.pageCount! : hiddenClusters > 0);

  const settledText = (() => {
    if (!info.settled) return null;
    const { answer: a, by } = info.settled;
    if (by === 'phone') return `已回答（手机）：${a || '跳过'}`;
    if (by === 'cancelled') return '该提问已失效';
    return `已在别处作答：${a || '跳过'}`;
  })();

  return (
    <View style={[styles.card, translucent && styles.cardT, info.settled ? styles.cardSettled : null]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>📬 改进提案决策</Text>
        {headerAction ? (
          <TouchableOpacity hitSlop={8} onPress={headerAction.onPress}>
            <Text style={styles.headerActionText}>{headerAction.label}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <Text style={styles.digest}>{pageCard.digest}</Text>
      {info.settled ? (
        <Text style={styles.settledText}>{settledText}</Text>
      ) : submitting ? (
        <Text style={styles.countdown}>提交中…</Text>
      ) : (
        <View>
          {failed ? <Text style={styles.failedText}>投递失败，请重试</Text> : null}
          {pageError ? <Text style={styles.failedText}>{pageError}</Text> : null}
          {/* 批量行（本批语义；全部关闭两段式确认防误触） */}
          <View style={styles.batchRow}>
            <TouchableOpacity
              style={[styles.batchChip, translucent && styles.surfaceT]}
              onPress={() => {
                disarmCloseAll();
                setState(selectAllClusters(pageCard, 'confirm'));
              }}
            >
              <Text style={styles.batchChipText}>本批全部确认</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.batchChip, translucent && styles.surfaceT]}
              onPress={() => {
                disarmCloseAll();
                setState(selectAllClusters(pageCard, 'skip'));
              }}
            >
              <Text style={styles.batchChipText}>本批全部跳过</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.batchChip, translucent && styles.surfaceT, armCloseAll ? styles.batchChipArmed : null]}
              onPress={batchCloseAll}
            >
              <Text style={[styles.batchChipText, armCloseAll ? styles.batchChipArmedText : null]}>
                {armCloseAll ? '确认全部关闭？' : '本批全部关闭'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.batchChip, translucent && styles.surfaceT]}
              onPress={() => {
                disarmCloseAll();
                setState(clearSelections());
              }}
            >
              <Text style={styles.batchChipText}>清空</Text>
            </TouchableOpacity>
          </View>
          {/* 簇块列表（限高内滚） */}
          <ScrollView style={styles.clusterList} nestedScrollEnabled showsVerticalScrollIndicator>
            {pageCard.clusters.map((c) => {
              const sel = state.clusters[c.id];
              const meta =
                `${c.count} 条` +
                (c.recent > 0 ? ` · 近期+${c.recent}` : '') +
                (c.difficulty ? ` · 难度${c.difficulty}` : '') +
                (c.latest ? ` · ${c.latest}` : '');
              const entries = c.entries ?? [];
              const isOpen = expanded[c.id] === true;
              return (
                <View
                  key={c.id}
                  style={[
                    styles.cluster,
                    translucent && styles.surfaceT,
                    sel === 'confirm' ? styles.clusterConfirm : null,
                    sel === 'close' ? styles.clusterClose : null,
                    sel === 'skip' ? styles.clusterSkip : null,
                  ]}
                >
                  <TouchableOpacity
                    style={styles.clusterHead}
                    activeOpacity={entries.length > 0 ? 0.7 : 1}
                    onPress={() => {
                      if (entries.length === 0) return; // 无 entries（未携详情档）：簇头不可展开
                      disarmCloseAll();
                      setExpanded((prev) => ({ ...prev, [c.id]: !prev[c.id] }));
                    }}
                  >
                    <Text style={styles.clusterId}>{c.id === '__ungrouped__' ? '未分组' : c.id}</Text>
                    <Text style={styles.clusterName} numberOfLines={1}>
                      {c.name}
                    </Text>
                    <Text style={styles.clusterMeta}>{meta}</Text>
                    {entries.length > 0 ? (
                      <Text style={[styles.clusterCaret, isOpen ? styles.clusterCaretOpen : null]}>▶</Text>
                    ) : null}
                  </TouchableOpacity>
                  <View style={styles.clusterActs}>
                    {ACTIONS.map((a) => (
                      <TouchableOpacity
                        key={a.key}
                        style={[
                          styles.act,
                          a.key === 'confirm' ? styles.actConfirm : null,
                          a.key === 'skip' ? styles.actSkip : null,
                          a.key === 'close' ? styles.actClose : null,
                          sel === a.key && a.key === 'confirm' ? styles.actConfirmOn : null,
                          sel === a.key && a.key === 'skip' ? styles.actSkipOn : null,
                          sel === a.key && a.key === 'close' ? styles.actCloseOn : null,
                        ]}
                        onPress={() => {
                          disarmCloseAll();
                          setState((prev) => toggleCluster(prev, pageCard, c.id, a.key));
                        }}
                      >
                        <Text
                          style={[
                            styles.actText,
                            a.key === 'confirm' ? styles.actConfirmText : null,
                            a.key === 'skip' ? styles.actSkipText : null,
                            a.key === 'close' ? styles.actCloseText : null,
                            sel === a.key ? styles.actOnText : null,
                          ]}
                        >
                          {a.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {/* 展开区：逐条 理由灰底块 + 难度/收益/来源标签 + 单条三态行（单条覆盖簇级）；
                      已决行（decided 标注）落定渲染不可点 */}
                  {isOpen && entries.length > 0 ? (
                    <View style={styles.entries}>
                      {entries.map((e) => {
                        if (e.decided !== undefined) {
                          return (
                            <View key={e.title} style={styles.entry}>
                              <Text style={[styles.entryTitle, styles.entryDecidedTitle]}>
                                <Text style={styles.entryNo}>#{e.n} </Text>
                                {e.title}
                              </Text>
                              <Text style={styles.entryDecided}>{DECIDED_LABEL[e.decided]}</Text>
                            </View>
                          );
                        }
                        const eSel = state.entries[e.title];
                        return (
                          <View key={e.title} style={styles.entry}>
                            <Text style={styles.entryTitle}>
                              <Text style={styles.entryNo}>#{e.n} </Text>
                              {e.title}
                            </Text>
                            {e.reason ? <Text style={[styles.entryReason, translucent && styles.surfaceT]}>{e.reason}</Text> : null}
                            {e.difficulty || e.benefit || e.source ? (
                              <View style={styles.entryTags}>
                                {e.difficulty ? (
                                  <Text style={[styles.entryTag, translucent && styles.surfaceT]}>难度 {e.difficulty}</Text>
                                ) : null}
                                {e.benefit ? (
                                  <Text style={[styles.entryTag, translucent && styles.surfaceT, e.benefit === '高' ? styles.entryTagHi : null]}>
                                    收益 {e.benefit}
                                  </Text>
                                ) : null}
                                {e.source ? <Text style={[styles.entryTag, translucent && styles.surfaceT]}>{e.source}</Text> : null}
                              </View>
                            ) : null}
                            <View style={styles.entryActs}>
                              {ACTIONS.map((a) => (
                                <TouchableOpacity
                                  key={a.key}
                                  style={[
                                    styles.entryAct,
                                    a.key === 'confirm' ? styles.actConfirm : null,
                                    a.key === 'skip' ? styles.actSkip : null,
                                    a.key === 'close' ? styles.actClose : null,
                                    eSel === a.key && a.key === 'confirm' ? styles.actConfirmOn : null,
                                    eSel === a.key && a.key === 'skip' ? styles.actSkipOn : null,
                                    eSel === a.key && a.key === 'close' ? styles.actCloseOn : null,
                                  ]}
                                  onPress={() => {
                                    disarmCloseAll();
                                    setState((prev) => toggleEntry(prev, c.id, e.title, a.key));
                                  }}
                                >
                                  <Text
                                    style={[
                                      styles.entryActText,
                                      a.key === 'confirm' ? styles.actConfirmText : null,
                                      a.key === 'skip' ? styles.actSkipText : null,
                                      a.key === 'close' ? styles.actCloseText : null,
                                      eSel === a.key ? styles.actOnText : null,
                                    ]}
                                  >
                                    {a.label}
                                  </Text>
                                </TouchableOpacity>
                              ))}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
          {/* 分页：原地翻页行（inplace）/ 旧桌面文本「下一批」（非 inplace 维持既有路径） */}
          {inPlace && batch ? (
            <View style={styles.pagerRow}>
              <TouchableOpacity
                style={[styles.pagerBtn, translucent && styles.surfaceT, (!hasPrev || turning) && styles.pagerBtnDisabled]}
                disabled={!hasPrev || turning}
                onPress={() => turnPage('prev')}
              >
                <Text style={[styles.pagerBtnText, (!hasPrev || turning) && styles.pagerBtnTextDisabled]}>‹ 上一批</Text>
              </TouchableOpacity>
              <Text style={styles.pagerText}>
                {turning ? '翻页中…' : hasRealPage ? `第 ${batch.pageIndex! + 1}/${batch.pageCount} 批` : ''}
              </Text>
              <TouchableOpacity
                style={[styles.pagerBtn, translucent && styles.surfaceT, (!hasNext || turning) && styles.pagerBtnDisabled]}
                disabled={!hasNext || turning}
                onPress={() => turnPage('next')}
              >
                <Text style={[styles.pagerBtnText, (!hasNext || turning) && styles.pagerBtnTextDisabled]}>下一批 ›</Text>
              </TouchableOpacity>
            </View>
          ) : !pageCard.inplace && hasNext ? (
            <View style={styles.pagerRow}>
              <Text style={styles.pagerText}>其余 {hiddenClusters} 簇已在桌面就绪</Text>
              <TouchableOpacity style={[styles.pagerBtn, translucent && styles.surfaceT]} onPress={nextBatchLegacy}>
                <Text style={styles.pagerBtnText}>{NEXT_BATCH_TEXT} ›</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {/* 提交 dock：指令预览 + 收卷钮 + 跳过本轮（inplace 下收卷钮变形兜底，跳过行隐去）+ 逃生舱 */}
          <View style={styles.dock}>
            <Text style={[styles.cmdPreview, translucent && styles.surfaceT]} numberOfLines={3}>
              {compiled.text ? `→ ${compiled.text}` : '点选后在此生成决策指令…'}
            </Text>
            {inPlace ? (
              <TouchableOpacity
                style={[styles.submitBtn, hasAnyDecision && !turning ? styles.submitReady : null]}
                disabled={turning}
                onPress={finish}
              >
                <Text style={styles.submitText}>{hasAnyDecision ? '完成本轮' : '跳过本轮'}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.submitBtn, selectedCount > 0 ? styles.submitReady : null]}
                disabled={selectedCount === 0}
                onPress={() => {
                  if (selectedCount === 0) return;
                  void send(compiled.text, compiled.decisions);
                }}
              >
                <Text style={styles.submitText}>
                  {selectedCount > 0 ? `提交决策（已选 ${selectedCount} 项）` : '提交决策'}
                </Text>
              </TouchableOpacity>
            )}
            {!inPlace ? (
              <TouchableOpacity onPress={() => void send('跳过本轮')}>
                <Text style={styles.skipLine}>跳过 — 本轮不处理</Text>
              </TouchableOpacity>
            ) : null}
            {/* 逃生舱：折叠的自由文本入口（点选覆盖不了的决策组合，发送原文走文本解析回退） */}
            <TouchableOpacity onPress={() => setEscapeOpen((v) => !v)}>
              <Text style={styles.escapeToggle}>{escapeOpen ? '收起 ▲' : '其他决策…'}</Text>
            </TouchableOpacity>
            {escapeOpen ? (
              <View style={styles.escapeRow}>
                <TextInput
                  style={[styles.escapeInput, translucent && styles.surfaceT]}
                  value={freeText}
                  onChangeText={setFreeText}
                  placeholder={info.hint ?? '直接输入决策，如 y C26 del C30'}
                  placeholderTextColor="#666"
                  onSubmitEditing={() => freeText.trim() && void send(freeText.trim())}
                />
                <TouchableOpacity
                  style={[styles.escapeSend, !freeText.trim() && styles.escapeSendDisabled]}
                  onPress={() => freeText.trim() && void send(freeText.trim())}
                >
                  <Text style={styles.escapeSendText}>发送</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // 卡容器（对齐 QuestionCard：#1c1917 + 蓝边 12 圆角）
  card: {
    backgroundColor: '#1c1917',
    borderColor: '#1d4ed8',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginVertical: 6,
    maxWidth: '96%',
  },
  // 浮层形态（translucent）：容器与面块改半透明透出下方会话文字；时间线内嵌保持实底
  cardT: { backgroundColor: 'rgba(28,25,23,0.82)' },
  surfaceT: { backgroundColor: 'rgba(21,27,36,0.75)' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerActionText: { color: '#9ca3af', fontSize: 12, fontWeight: '600' },
  cardSettled: { borderColor: '#374151', opacity: 0.75 },
  title: { color: '#60a5fa', fontSize: 14, fontWeight: '700', marginBottom: 2 },
  digest: { color: '#9ca3af', fontSize: 11.5, marginBottom: 10 },
  settledText: { color: '#9ca3af', fontSize: 13, marginTop: 8 },
  countdown: { color: '#fbbf24', fontSize: 12, marginTop: 8 },
  failedText: { color: '#ef4444', fontSize: 12, marginTop: 8 },
  // 批量行
  batchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  batchChip: {
    backgroundColor: '#151b24',
    borderWidth: 1,
    borderColor: '#292524',
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  batchChipText: { color: '#9ca3af', fontSize: 11 },
  batchChipArmed: { backgroundColor: '#2a1715', borderColor: '#ea4335' },
  batchChipArmedText: { color: '#ea4335', fontWeight: '700' },
  // 簇块
  clusterList: { maxHeight: CLUSTER_LIST_MAX_HEIGHT },
  cluster: {
    backgroundColor: '#151b24',
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  clusterConfirm: { borderColor: '#34a853' },
  clusterClose: { borderColor: '#ea4335' },
  clusterSkip: { borderColor: '#6b7280' },
  clusterHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 6 },
  clusterId: {
    backgroundColor: '#1e3a5f',
    color: '#93c5fd',
    fontSize: 11,
    fontWeight: '700',
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderRadius: 6,
    overflow: 'hidden',
  },
  clusterName: { flex: 1, color: '#e5e7eb', fontSize: 13.5, fontWeight: '600' },
  clusterMeta: { color: '#6b7280', fontSize: 10.5 },
  clusterCaret: { color: '#4b5563', fontSize: 10 },
  clusterCaretOpen: { transform: [{ rotate: '90deg' }] },
  clusterActs: { flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingBottom: 10, paddingTop: 2 },
  act: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8 },
  actConfirm: { backgroundColor: '#14261a' },
  actSkip: { backgroundColor: '#1f242c' },
  actClose: { backgroundColor: '#2a1715' },
  actText: { fontSize: 12, fontWeight: '600' },
  actConfirmText: { color: '#34a853' },
  actSkipText: { color: '#8a8f98' },
  actCloseText: { color: '#ea4335' },
  // 选中态：按动作着色实心（原型：confirm 绿 / skip 灰 / close 红），文本反白
  actConfirmOn: { backgroundColor: '#34a853' },
  actSkipOn: { backgroundColor: '#6b7280' },
  actCloseOn: { backgroundColor: '#ea4335' },
  actOnText: { color: '#fff' },
  // 展开区（逐条）
  entries: { borderTopWidth: 1, borderTopColor: '#292524', paddingHorizontal: 10, paddingBottom: 8 },
  entry: { paddingTop: 9, paddingBottom: 3, borderBottomWidth: 1, borderBottomColor: '#1f242c' },
  entryTitle: { fontSize: 12.5, fontWeight: '600', color: '#d1d5db' },
  entryNo: { fontSize: 10, color: '#4b5563', fontWeight: '400' },
  entryReason: {
    fontSize: 11.5,
    color: '#9ca3af',
    lineHeight: 17,
    marginTop: 4,
    backgroundColor: '#10141b',
    borderRadius: 7,
    paddingVertical: 6,
    paddingHorizontal: 9,
  },
  entryTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 6 },
  entryTag: {
    fontSize: 10,
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderRadius: 5,
    backgroundColor: '#1f242c',
    color: '#8a8f98',
    overflow: 'hidden',
  },
  entryTagHi: { backgroundColor: '#2a2113', color: '#fbbf24' },
  entryActs: { flexDirection: 'row', gap: 5, marginTop: 7, marginBottom: 6 },
  entryAct: { flex: 1, alignItems: 'center', paddingVertical: 5, borderRadius: 7 },
  entryActText: { fontSize: 11, fontWeight: '600' },
  // 已决行（落定渲染，不可点）
  entryDecidedTitle: { color: '#6b7280' },
  entryDecided: { color: '#4b5563', fontSize: 11, marginTop: 3 },
  // 分页行
  pagerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 6, paddingBottom: 2 },
  pagerText: { color: '#6b7280', fontSize: 11 },
  pagerBtn: { backgroundColor: '#151b24', borderWidth: 1, borderColor: '#292524', borderRadius: 10, paddingVertical: 3, paddingHorizontal: 10 },
  pagerBtnText: { color: '#60a5fa', fontSize: 11, fontWeight: '600' },
  pagerBtnDisabled: { opacity: 0.4 },
  pagerBtnTextDisabled: { color: '#4b5563' },
  // 提交 dock
  dock: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#292524', paddingTop: 10 },
  cmdPreview: {
    fontFamily: 'monospace',
    fontSize: 10.5,
    color: '#8a8f98',
    backgroundColor: '#10141b',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 9,
    marginBottom: 8,
    minHeight: 26,
  },
  submitBtn: { backgroundColor: '#2a2f38', borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  submitReady: { backgroundColor: '#3b82f6' },
  submitText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  skipLine: { color: '#6b7280', fontSize: 12, marginTop: 9, textAlign: 'center' },
  escapeToggle: { color: '#4b5563', fontSize: 11, marginTop: 8, textAlign: 'center' },
  escapeRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  escapeInput: {
    flex: 1,
    backgroundColor: '#151b24',
    color: '#fff',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  escapeSend: { backgroundColor: '#3b82f6', borderRadius: 16, paddingHorizontal: 14, justifyContent: 'center' },
  escapeSendDisabled: { opacity: 0.4 },
  escapeSendText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
