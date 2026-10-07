/**
 * markdown 解析器用例 —— 逐条覆盖设计纪律：
 * 全函数兜底 / 单换行即换行 / 代码段最先切 / 长标记优先 / 容器递归 / 链接白名单 / 图片排除 / 表格（CJK）
 */
import { parseInline, parseMarkdown, displayMarker, type Block, type Inline } from '../src/components/markdown';

// ----------  helpers ----------
const texts = (nodes: Inline[]): string =>
  nodes
    .map((n) => (n.t === 'text' || n.t === 'code' ? n.s : n.t === 'link' ? texts(n.c) : texts(n.c)))
    .join('');

// ---------- 行内 ----------

describe('parseInline', () => {
  it('纯文本原样', () => {
    expect(parseInline('你好 world')).toEqual([{ t: 'text', s: '你好 world' }]);
  });

  it('粗体/斜体/粗斜', () => {
    expect(parseInline('**b**')).toEqual([{ t: 'bold', c: [{ t: 'text', s: 'b' }] }]);
    expect(parseInline('*i*')).toEqual([{ t: 'italic', c: [{ t: 'text', s: 'i' }] }]);
    expect(parseInline('***bi***')).toEqual([{ t: 'boldItalic', c: [{ t: 'text', s: 'bi' }] }]);
  });

  it('长标记优先：*** 不会被切成 ** + *', () => {
    const n = parseInline('***x***');
    expect(n[0]!.t).toBe('boldItalic');
  });

  it('代码段最先切：里面的 ** 是字面量', () => {
    expect(parseInline('`**not bold**`')).toEqual([{ t: 'code', s: '**not bold**' }]);
  });

  it('容器递归：粗体里嵌代码段', () => {
    const n = parseInline('**把 `reasoning_content` 传回**');
    expect(n[0]!.t).toBe('bold');
    const inner = (n[0] as { c: Inline[] }).c;
    expect(inner.some((x) => x.t === 'code' && x.s === 'reasoning_content')).toBe(true);
  });

  it('未闭合标记按字面兜底（流式半截安全）', () => {
    expect(parseInline('**半截')).toEqual([{ t: 'text', s: '**半截' }]);
    expect(parseInline('一半的 `码')).toEqual([{ t: 'text', s: '一半的 `码' }]);
  });

  it('链接仅 http/https 入链；其他 scheme 整体字面', () => {
    const ok = parseInline('[官网](https://example.com)');
    expect(ok[0]).toEqual({ t: 'link', url: 'https://example.com', c: [{ t: 'text', s: '官网' }] });
    const bad = parseInline('[x](javascript:alert(1))');
    expect(bad.every((n) => n.t === 'text')).toBe(true);
    expect(texts(bad)).toBe('[x](javascript:alert(1))');
  });

  it('图片语法 → 字面文本（不发起外联请求）', () => {
    const n = parseInline('![跟踪](https://evil.example/t.png)');
    expect(n).toEqual([{ t: 'text', s: '![跟踪](https://evil.example/t.png)' }]);
  });

  it('混合行保持顺序', () => {
    const n = parseInline('前 **粗** 中 `码` 后');
    expect(n.map((x) => x.t)).toEqual(['text', 'bold', 'text', 'code', 'text']);
  });
});

// ---------- 块级 ----------

describe('parseMarkdown', () => {
  it('单换行即换行：两行两个段落（不做 CommonMark 折叠）', () => {
    const b = parseMarkdown('第一行\n第二行');
    expect(b).toHaveLength(2);
    expect(b[0]!.t).toBe('para');
    expect(b[1]!.t).toBe('para');
  });

  it('标题级别', () => {
    const b = parseMarkdown('## 问题根因');
    expect(b[0]).toMatchObject({ t: 'heading', level: 2 });
  });

  it('分隔线', () => {
    expect(parseMarkdown('---')[0]!.t).toBe('hr');
    expect(parseMarkdown('***')[0]!.t).toBe('hr');
  });

  it('列表：标记按原文保留，编号不重排', () => {
    const b = parseMarkdown('- 甲\n1. 乙\n1. 丙');
    expect(b.map((x) => (x.t === 'list' ? x.marker : ''))).toEqual(['-', '1.', '1.']);
  });

  it('displayMarker：无序标记映射点号，有序标记原样保留', () => {
    expect(displayMarker('-')).toBe('•');
    expect(displayMarker('*')).toBe('•');
    expect(displayMarker('+')).toBe('•');
    expect(displayMarker('1.')).toBe('1.');
    expect(displayMarker('12.')).toBe('12.');
  });

  it('嵌套列表缩进按行首空格映射', () => {
    const b = parseMarkdown('- 父\n  - 子');
    expect(b[1]).toMatchObject({ t: 'list', indent: 1 });
  });

  it('代码围栏：内部的 # 不是标题、- 不是列表', () => {
    const b = parseMarkdown('```\n# 不是标题\n- 不是列表\n```');
    expect(b).toHaveLength(1);
    expect(b[0]).toEqual({ t: 'code', s: '# 不是标题\n- 不是列表' });
  });

  it('流式未闭合围栏：到文末全是代码块', () => {
    const b = parseMarkdown('```\ncode line');
    expect(b).toEqual([{ t: 'code', s: 'code line' }]);
  });

  it('表格：分隔行被丢弃，表头与数据行解析（CJK 内容）', () => {
    const b = parseMarkdown('| 文件夹 | 说明 |\n|---|---|\n| 助手 | chill 项目主目录 |');
    expect(b).toHaveLength(1);
    const t = b[0] as Extract<Block, { t: 'table' }>;
    expect(t.t).toBe('table');
    expect(t.header).toHaveLength(2);
    expect(t.rows).toHaveLength(1);
    expect(texts(t.rows[0]![0]!)).toBe('助手');
  });

  it('表格单元格内的行内标记照常解析', () => {
    const b = parseMarkdown('| 路径 | 说明 |\n|---|---|\n| `chill\\packages\\core` | **核心** |');
    const t = b[0] as Extract<Block, { t: 'table' }>;
    expect(t.rows[0]![0]![0]!.t).toBe('code');
    expect(t.rows[0]![1]![0]!.t).toBe('bold');
  });

  it('缺分隔行的竖线行降级为段落', () => {
    const b = parseMarkdown('| a | b |\n| c | d |');
    expect(b.every((x) => x.t === 'para')).toBe(true);
  });

  it('引用块：> 前缀剥离，行内标记照常解析', () => {
    const b = parseMarkdown('> 引用一\n> **重点**\n正文');
    expect(b.map((x) => x.t)).toEqual(['quote', 'quote', 'para']);
    expect(texts((b[0] as Extract<Block, { t: 'quote' }>).c)).toBe('引用一');
    expect((b[1] as Extract<Block, { t: 'quote' }>).c[0]!.t).toBe('bold');
  });

  it('引用块：代码围栏内不解释，空引用行不产出块', () => {
    const b = parseMarkdown('```\n> not quote\n```\n>\n> 真引用');
    expect(b.map((x) => x.t)).toEqual(['code', 'quote']);
  });

  it('空输入 → 空块列', () => {
    expect(parseMarkdown('')).toEqual([]);
  });

  it('空行 = 段落分隔：跟在空行后的块打 gap 标记，单换行与首块不打', () => {
    const b = parseMarkdown('第一段\n紧邻行\n\n第二段\n\n\n第三段');
    expect(b.map((x) => (x.t === 'para' ? texts(x.c) : ''))).toEqual(['第一段', '紧邻行', '第二段', '第三段']);
    expect(b.map((x) => x.gap === true)).toEqual([false, false, true, true]); // 连续空行与单个空行同效
  });

  it('gap 标记覆盖所有块类型（标题/列表/代码围栏/表格）', () => {
    const b = parseMarkdown('起\n\n## 题\n\n- 项\n\n```\nx\n```\n\n| a |\n|---|');
    expect(b.map((x) => x.t)).toEqual(['para', 'heading', 'list', 'code', 'table']);
    expect(b.map((x) => x.gap === true)).toEqual([false, true, true, true, true]);
  });

  it('真实语料抽样（经验总结回复片段）端到端', () => {
    const src =
      '桌面上确实有这个文件（`经验总结.txt`，共 37 行），内容是一份**技术问题排查记录**。核心内容如下：\n\n## 问题根因\nDeepSeek v4-pro 默认开启 thinking 模式：\n1. 有 tool_calls 但没有 reasoning 文本的消息\n2. 没有工具调用的纯文本最终回复';
    const b = parseMarkdown(src);
    expect(b.map((x) => x.t)).toEqual(['para', 'heading', 'para', 'list', 'list']);
  });
});
