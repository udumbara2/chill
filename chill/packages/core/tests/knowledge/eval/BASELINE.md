# 知识库检索质量评测：一期基线报告

- 运行日期：2026-08-17
- 运行方式：`cd chill/packages/core && pnpm test:knowledge-eval`
- 阶段：二期任务 2 完成时的一期管线基线（无摘要层、无 LLM 定位前缀，enhancements 全关）
- 环境：mock 词袋 hash embedding（512 维，Intl.Segmenter 分词，确定性）、rerank 关、similarityThreshold 0.05、top_k = 5
- 语料：6 篇文档（3 篇 Markdown 笔记 + 1 篇多章模拟书籍 + 2 条沉淀），16 个 chunk；用例 9 条

## 分类命中率

| 类别 | 命中率 |
| --- | --- |
| 局部细节 | 2/2 |
| 换说法语义 | 2/2 |
| 术语精确 | 2/2 |
| 全书综述 | 2/2 |
| 回归（摘要不挤占细节） | 1/1 |
| **总体** | **9/9（100%）** |

## 逐用例基线（期望文档的实际 top-5 分数）

| 用例 | 结果 | 期望文档分数（top-5 次名分数） |
| --- | --- | --- |
| detail-useeffect-empty-deps | 命中 | react-hooks 0.569（book 0.2013） |
| detail-mapo-tofu-pepper | 命中 | sichuan-cooking 0.4395（distilled-chill 0.126） |
| paraphrase-coffee-temp | 命中 | coffee 0.488（book 0.1647） |
| paraphrase-mount-once | 命中 | react-hooks 0.3985（distilled-chill 0.1782） |
| term-cave-wang | 命中 | book-silk-road 0.4261（react-hooks 0.1591） |
| term-release-window | 命中 | distilled-release-window 0.4588（book 0.2506） |
| overview-book-mainline | 命中 | book-silk-road **0.2669**（coffee 0.1960） |
| overview-book-viewpoint | 命中 | book-silk-road **0.3057**（react-hooks 0.1914） |
| regression-detail-not-crowded-by-summary | 命中 | sichuan-cooking 0.5411（book 0.1223） |

## 基线观察（任务 3/4 的改善对象）

- **全书综述类是最弱一环**：两条综述用例虽命中，但期望文档分数（0.267 / 0.306）与次名差距
  仅 0.07–0.11，远低于细节/术语类（差距 0.2–0.37），处于"压线命中"。这正是任务 3 摘要层
  （全书/章节摘要参与召回）要拉开差距的地方；任务 3 落地后重点看这两条用例的分数差是否显著扩大。
- mock 词袋 embedding 下换说法语义类 2/2 命中，但这是语料规模小（6 篇、主题区分度大）的结果；
  真实 embedding 的语义优势在本 mock 下体现不出来。

## mock embedding 的局限（必读）

本评测的 embedding 是**确定性的词袋 hash 向量替身**：同文本同向量、共享词越多向量越近，
但几乎没有语义近似能力（同义词、改写、跨表述匹配基本为零）。因此：

1. **绝对命中率不代表真实服务质量**——本基线的价值是固定标尺下的**回归对比**：
   每个增强任务落地后重跑本脚本，与本文件逐项对比命中与分数变化。
2. 词袋余弦量级远小于真实 embedding，评测把 similarityThreshold 从默认 0.5 下调到 0.05、
   关闭 rerank，均为适配 mock 的评测配置，不是对一期默认配置的改动。
3. 真实 embedding + 真实书籍 PDF 的综述类实测在二期任务 8 端到端验证进行。

## 评测集维护约定

- 用例集（cases.ts）是固定标尺：增强任务不得为求绿而修改用例或 fixtures；
  确需修订时须在本文件追加说明。
- 回归用例 `regression-detail-not-crowded-by-summary` 一期必然通过（索引无摘要块），
  任务 3 加入摘要块后它才真正起守护作用——细节文档必须仍在 top-k。

---

# 任务 3 摘要层：开启 summaryLayer 对比（2026-08-17）

- 运行方式：`KB_EVAL_SUMMARY=1 pnpm test:knowledge-eval`（同一用例集/fixtures/阈值，另装 mock LLM——
  确定性抽取式摘要替身，见 runEval.ts 文件头）
- 语料规模：16 → 24 chunk（4 篇 note/pdf 各出 章节/父块级 + 文档级 摘要，2 条 distilled 跳过）
- 命中率：9/9（100%），与基线持平，无回归

## 全书综述用例：分数差显著扩大（任务 3 的改善目标达成）

| 用例 | 基线（期望文档 vs 他文档次名） | 开摘要层 | 分数差 |
| --- | --- | --- | --- |
| overview-book-mainline | 0.2669 vs 0.196（差 0.07，压线） | **0.3906**（全书摘要块）vs 0.2102 | 0.07 → **0.18** |
| overview-book-viewpoint | 0.3057 vs 0.1914（差 0.11） | **0.3653**（全书摘要块）vs 0.1124 | 0.11 → **0.25** |

两条综述用例的 top-3 均变为「父块 + 章节摘要 + 全书摘要」包揽（期望文档独占前三），
综述问题的召回由"序章块压线"变为"摘要块明确领先"。

## 回归用例：细节不被摘要挤占

- `regression-detail-not-crowded-by-summary`：细节父块 0.5411 仍居 **top-1**，sichuan 摘要块
  （0.308 / 0.2961）排其后——细节文档与细节段落都在 top-k 前部。
- 局部细节/换说法/术语类用例的 top-1 均为期望文档的细节父块（分数与基线一致），摘要块跟排。

## 召回结构决策记录（重要）

实现过程中验证过两种摘要召回结构，评测暴露出关键差异：

1. **摘要块同时进 vector/BM25 主路 + summary 路（已否决）**：RRF 按名次积分，摘要块三路计分、
   细节块只有两路，导致细节查询（回锅肉用例）下 5 个弱匹配摘要（0.06–0.31）把 0.54 的细节块
   挤出 top-5——回归用例名存实亡（docId 靠摘要命中，细节段落丢失）。
2. **现行：摘要块只走 summary 提升路，权重 2**：摘要路第一名积 2/(k+1)，与主路双料第一同分、
   同分时主路先入列排前；第二名起的摘要恒低于主路双料命中。效果：综述问题摘要进前列、
   细节问题细节第一，两者兼得。

mock 词袋 embedding 会夸大摘要拥挤（无关文档摘要也有 0.06–0.31 的词面重叠分），真实 embedding
下无关摘要通常低于 0.5 阈值被滤除，但结构 2 的防护不依赖该假设。

## mock LLM 的局限

评测的"摘要"是抽取式替身（原文前 120 字 + 概要前缀），与原文共享词汇是必然——词袋 mock 下
摘要块的分数优势会被放大。真实 LLM 摘要是改写式浓缩，综述类收益需任务 8 的真实 API 实测确认。

---

# 任务 4 LLM 定位前缀：开启 contextualPrefix 对比（2026-08-17）

- 运行方式：`KB_EVAL_CONTEXTUAL=1 pnpm test:knowledge-eval`（同一用例集/fixtures/阈值；mock LLM 为
  确定性定位前缀替身——"此块出自「章节」，讲的是<块内容开头 40 字>"，见 runEval.ts 文件头）
- 语料规模：16 chunk（定位前缀只改写子块的 contextPrefix 字段，不新增 chunk；2 条 distilled 跳过增强）
- 命中率：9/9（100%），与基线持平，无回归

## 逐用例分数对比（期望文档分数 vs 他文档次名，分差变化）

| 用例 | 基线 | 开定位前缀 | 分差 |
| --- | --- | --- | --- |
| detail-useeffect-empty-deps | 0.569 vs 0.2013 | 0.506 vs 0.1545 | 0.37 → 0.35（持平） |
| detail-mapo-tofu-pepper | 0.4395 vs 0.126 | 0.3817 vs 0.126 | 0.31 → 0.26（略收） |
| paraphrase-coffee-temp | 0.488 vs 0.1647 | 0.5543 vs 0.1264 | 0.32 → **0.43**（扩大） |
| paraphrase-mount-once | 0.3985 vs 0.1782 | 0.3591 vs 0.1782 | 0.22 → 0.18（略收） |
| term-cave-wang | 0.4261 vs 0.1591 | 0.5192 vs 0.1568 | 0.27 → **0.36**（扩大） |
| term-release-window | 0.4588 vs 0.2506 | 0.4588 vs 0.2115 | 期望文档分不变（distilled 跳过增强），次名降 |
| overview-book-mainline | 0.2669 vs 0.196 | 0.3255 vs 0.2185 | 0.07 → 0.11（扩大） |
| overview-book-viewpoint | 0.3057 vs 0.1914 | 0.3566 vs 0.1816 | 0.11 → 0.18（扩大） |
| regression-detail-not-crowded-by-summary | 0.5411 vs 0.1223 | 0.5722 vs 0.1044 | 0.42 → 0.47（扩大） |

## 换说法语义类表现（任务 4 的重点观察对象）

两条换说法用例一升一降，机制清晰可见：

- `paraphrase-coffee-temp` 分差 0.32 → 0.43：前缀把章节语境词（「手冲参数」等）与块开头浓缩句
  补进 embedding 文本，与查询的换说法表述产生新的词汇重叠——正是 Contextual Retrieval 的设计意图。
- `paraphrase-mount-once` 分差 0.22 → 0.18：前缀引入的额外词项稀释了正文匹配词的相对权重
  （词袋余弦的固有特性：向量维度被更多非匹配词摊薄）。真实 embedding 下定位前缀与查询语义相关、
  稀释效应弱得多，但"前缀不是越长越好"这一点在 mock 下同样成立。

## mock 替身的局限（解读必读）

- 替身前缀是**模板句**（每条都含"讲的是"），综述类查询含"讲"字产生系统性词面重叠，overview 两条
  的分差扩大有这部分虚高成分；真实 LLM 前缀是逐块改写的，不会如此整齐。
- 标题路径前缀本就在一期 embedding 文本里，mock 前缀的主要增量是"章节"措辞与块开头浓缩；
  真实 LLM 前缀的核心收益（跨段落指代消解、背景补全）词袋 mock 无法体现，留待任务 8 真实 API 实测。
- 结论限定为：机制接通、无回归、开关/降级契约成立；质量收益的真实量化以任务 8 为准。
