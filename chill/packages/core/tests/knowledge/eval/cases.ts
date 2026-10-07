/**
 * 固定评测用例集（二期任务 2，设计见 iDream/知识管理.md 第八节"质量可度量"）
 *
 * 四类用例：局部细节 / 换说法语义 / 术语精确 / 全书综述，
 * 外加一条回归用例：细节问题不应被摘要块挤占 top-k（为任务 3 摘要层准备——
 * 一期索引没有摘要块，该用例当前必然通过，任务 3 落地后它才真正起到回归作用）。
 *
 * 用例是评测的"固定标尺"：增强任务做前后对比时不得为用例绿而改评测集本身，
 * 个别用例不命中如实记录为基线缺口（尤其全书综述类，正是任务 3 要改善的对象）。
 */

/** 用例类别 */
export type EvalCategory = '局部细节' | '换说法语义' | '术语精确' | '全书综述' | '回归'

export interface EvalCase {
  id: string
  category: EvalCategory
  query: string
  /** 期望命中的文档（fixtures.ts 里的 key） */
  expectDocKey: string
  /** 可选：命中结果的 headingPath 应包含该片段（只对 Markdown 笔记类文档有意义） */
  expectHeadingPath?: string
  /** 备注（设计意图 / 已知缺口说明） */
  note?: string
}

export const EVAL_CASES: EvalCase[] = [
  // ---------- 局部细节：问某节里的具体事实 ----------
  {
    id: 'detail-useeffect-empty-deps',
    category: '局部细节',
    query: 'useEffect 的依赖数组传空数组会怎样？',
    expectDocKey: 'react-hooks',
    expectHeadingPath: 'useEffect',
  },
  {
    id: 'detail-mapo-tofu-pepper',
    category: '局部细节',
    query: '麻婆豆腐起锅前要撒什么？',
    expectDocKey: 'sichuan-cooking',
    expectHeadingPath: '麻婆豆腐',
  },

  // ---------- 换说法语义：同义改写提问，保留领域名词、换掉原句表述 ----------
  {
    id: 'paraphrase-coffee-temp',
    category: '换说法语义',
    query: '冲手冲咖啡的时候水加热到多少度比较合适？',
    expectDocKey: 'coffee',
    note: '原文表述是"水温控制在 92 摄氏度"，问法换了个说法',
  },
  {
    id: 'paraphrase-mount-once',
    category: '换说法语义',
    query: '组件第一次渲染完之后只想执行一次副作用，写法上要注意什么？',
    expectDocKey: 'react-hooks',
    note: '"挂载完成后执行一次"的换说法提问；与原文词汇重叠较少，对词袋 mock 偏难',
  },

  // ---------- 术语精确：含专有名词 ----------
  {
    id: 'term-cave-wang',
    category: '术语精确',
    query: '敦煌藏经洞是谁发现的？',
    expectDocKey: 'book-silk-road',
  },
  {
    id: 'term-release-window',
    category: '术语精确',
    query: '生产环境的发布窗口安排在什么时候？',
    expectDocKey: 'distilled-release-window',
  },

  // ---------- 全书综述 ----------
  {
    id: 'overview-book-mainline',
    category: '全书综述',
    query: '《丝路小史》这本书整体上讲了什么？帮我概括一下全书的主线。',
    expectDocKey: 'book-silk-road',
    note: '"这本书/丝路/讲"与序章有少量词汇重叠，基线下以低分压线命中；摘要层应显著拉开差距',
  },
  {
    id: 'overview-book-viewpoint',
    category: '全书综述',
    query: '这本历史读物想传达的核心观点是什么？作者是按什么脉络组织内容的？',
    expectDocKey: 'book-silk-road',
    note: '刻意压低与任何单一章节块的词汇重叠，是任务 3 摘要层要改善的基线缺口候选',
  },

  // ---------- 回归：细节问题不应被摘要块挤占 top-k（任务 3 摘要层的守护用例） ----------
  {
    id: 'regression-detail-not-crowded-by-summary',
    category: '回归',
    query: '回锅肉为什么要先煮后炒？',
    expectDocKey: 'sichuan-cooking',
    note: '只校验 docId：一期检索返回父块，父块 headingPath 取首子块的标题路径（chunker 行为），'
      + '细节所在节的标题路径不会透传，故此处不校验 headingPath；任务 3 加入摘要块后细节文档仍须留在 top-k',
  },
]
