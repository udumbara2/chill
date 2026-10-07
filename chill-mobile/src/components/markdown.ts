/**
 * markdown.ts — 聊天语料 Markdown 子集解析器（纯函数，不依赖 RN，jest 可测）。
 *
 * 设计纪律（第一性原理定稿）：
 * - 全函数：任何输入都有输出，未闭合/不识别的一律按字面文本兜底，不存在错误态（流式半截输入天然安全）
 * - 单换行即换行：不遵循 CommonMark 的段落折叠（聊天语料的事实语义）
 * - 行内顺序纪律：代码段最先切（`` `**` `` 里的星号是字面量），长标记优先（*** 先于 ** 先于 *）
 * - 安全：链接仅 http/https（pattern 构造上排除其他 scheme）；图片语法渲染为字面文本（不向任意 URL 发请求）
 * - 容器 token（粗/斜/链）内容递归解析（`**粗 `码`**` 正确嵌套；内容严格变短，递归必终止）
 */

export type Inline =
  | { t: 'text'; s: string }
  | { t: 'code'; s: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'italic'; c: Inline[] }
  | { t: 'boldItalic'; c: Inline[] }
  | { t: 'link'; url: string; c: Inline[] };

export type Block =
  | { t: 'para'; c: Inline[]; gap?: boolean }
  | { t: 'heading'; level: number; c: Inline[]; gap?: boolean }
  | { t: 'hr'; gap?: boolean }
  | { t: 'list'; indent: number; marker: string; c: Inline[]; gap?: boolean }
  | { t: 'code'; s: string; gap?: boolean }
  | { t: 'table'; header: Inline[][]; rows: Inline[][][]; gap?: boolean }
  | { t: 'quote'; c: Inline[]; gap?: boolean };
// gap：源文本中本块前面有空行（段落分隔）→ 渲染层给段落级上边距；紧跟的行（单换行）不标记，保持紧凑

// ---------- 行内 ----------

/**
 * 列表标记的显示映射：无序标记（-、*、+）不携带信息，渲染为排版惯例的点号 •；
 * 有序标记（1. 等）携带作者编号意图，原样保留（模型常发 "1. 1. 1."，重排即篡改）。
 */
export function displayMarker(marker: string): string {
  return marker === '-' || marker === '*' || marker === '+' ? '•' : marker;
}

type InlineKind = 'code' | 'image' | 'link' | 'boldItalic' | 'bold' | 'italic';

/** 顺序即同位置优先级：代码段 > 图片 > 链接 > 粗斜 > 粗 > 斜 */
const INLINE_PATTERNS: { kind: InlineKind; re: RegExp }[] = [
  { kind: 'code', re: /`([^`\n]+)`/ },
  { kind: 'image', re: /!\[[^\]\n]*\]\([^)\n]*\)/ },
  { kind: 'link', re: /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/ },
  { kind: 'boldItalic', re: /\*\*\*([^*\n]+)\*\*\*/ },
  { kind: 'bold', re: /\*\*([^*\n]+)\*\*/ },
  { kind: 'italic', re: /\*([^*\n]+)\*/ },
];

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let rest = s;
  while (rest.length > 0) {
    // 找所有模式里位置最早的命中（同位置时列表序优先）
    let hit: { idx: number; end: number; kind: InlineKind; m: RegExpExecArray } | null = null;
    for (const p of INLINE_PATTERNS) {
      p.re.lastIndex = 0;
      const m = p.re.exec(rest);
      if (m && (hit === null || m.index < hit.idx)) {
        hit = { idx: m.index, end: m.index + m[0].length, kind: p.kind, m };
      }
    }
    if (!hit) {
      out.push({ t: 'text', s: rest });
      break;
    }
    if (hit.idx > 0) out.push({ t: 'text', s: rest.slice(0, hit.idx) });
    const m = hit.m;
    switch (hit.kind) {
      case 'code':
        out.push({ t: 'code', s: m[1]! });
        break;
      case 'image':
        out.push({ t: 'text', s: m[0] }); // 安全纪律：图片语法 → 字面文本（不发起任何外联请求）
        break;
      case 'link':
        out.push({ t: 'link', url: m[2]!, c: parseInline(m[1]!) });
        break;
      case 'boldItalic':
        out.push({ t: 'boldItalic', c: parseInline(m[1]!) });
        break;
      case 'bold':
        out.push({ t: 'bold', c: parseInline(m[1]!) });
        break;
      case 'italic':
        out.push({ t: 'italic', c: parseInline(m[1]!) });
        break;
    }
    rest = rest.slice(hit.end);
  }
  return out;
}

// ---------- 块级 ----------

const FENCE_RE = /^\s*```/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|.+/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/** 表格块：需第二行为分隔行才成立（CommonMark 同规），否则各行降级为普通段落 */
function buildTable(lines: string[]): Block[] {
  if (lines.length >= 2 && isSeparatorRow(lines[1]!)) {
    const header = splitTableRow(lines[0]!).map((c) => parseInline(c));
    const rows = lines.slice(2).map((l) => splitTableRow(l).map((c) => parseInline(c)));
    return [{ t: 'table', header, rows }];
  }
  return lines.map((l) => ({ t: 'para', c: parseInline(l) }) as Block);
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  let afterBlank = false; // 刚越过 ≥1 个空行（段落分隔）；首个块不标记（顶部不需要间距）
  const push = (b: Block) => {
    if (afterBlank && blocks.length > 0) b.gap = true;
    afterBlank = false;
    blocks.push(b);
  };
  while (i < lines.length) {
    const line = lines[i]!;
    // 代码围栏（围栏状态机：内部一切不做块级解释；流式未闭合 → 到文末全是代码块）
    if (FENCE_RE.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // 跳过闭合行（未闭合则已自然到文末）
      push({ t: 'code', s: buf.join('\n') });
      continue;
    }
    if (/^\s*$/.test(line)) {
      afterBlank = true; // 空行 = 段落分隔（不产出自愈间距块，标记给下一个块）
      i++;
      continue;
    }
    if (TABLE_ROW_RE.test(line)) {
      const tbl: string[] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]!)) {
        tbl.push(lines[i]!);
        i++;
      }
      const tblBlocks = buildTable(tbl);
      tblBlocks.forEach(push);
      continue;
    }
    const q = QUOTE_RE.exec(line);
    if (q) {
      const inner = q[1]!;
      i++;
      if (inner.trim() === '') {
        afterBlank = true; // 空引用行（">"）视同空行
        continue;
      }
      push({ t: 'quote', c: parseInline(inner) });
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      push({ t: 'heading', level: h[1]!.length, c: parseInline(h[2]!) });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      push({ t: 'hr' });
      i++;
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      // 缩进按行首空格映射；标记按原文显示（不重编号——模型常发 "1. 1. 1."，重排即乱）
      push({ t: 'list', indent: Math.floor(li[1]!.length / 2), marker: li[2]!, c: parseInline(li[3]!) });
      i++;
      continue;
    }
    push({ t: 'para', c: parseInline(line) });
    i++;
  }
  return blocks;
}
