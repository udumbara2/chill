/**
 * 网页正文提取器：抓取 URL，本地管线将 HTML 正文转为 Markdown。
 * 零依赖，仅使用 Node 18+ 全局 fetch 与标准库。
 *
 * 管线：URL 校验 → fetch（15s 超时、5MB 上限）→ Content-Type 分流
 * → HTML 正文提取（块级元素打分 + 标签→Markdown 映射 + 实体解码）
 */

/** 桌面 Chrome UA：部分站点对非浏览器 UA 返回反爬占位页 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 15000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_URL_LENGTH = 2048

/** 作为正文候选参与打分的块级容器标签 */
const CANDIDATE_TAGS = new Set(['div', 'article', 'main', 'section', 'td'])
/** 计为"段落"的标签：用于候选块的段落数统计 */
const PARAGRAPH_TAGS = new Set(['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
/** 候选块文本长度低于该值时判定为非文章页，降级为 body 全量 */
const MIN_ARTICLE_TEXT_LEN = 200

/** 常见命名实体表（数值形式 &#123; / &#x1f; 另行处理） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  middot: '·', bull: '•', hellip: '…',
  mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™',
  deg: '°', plusmn: '±', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  sect: '§', para: '¶', micro: 'µ', dagger: '†', permil: '‰',
}

/**
 * 抓取 URL 并返回提取后的内容（HTML 转 Markdown，纯文本/Markdown/JSON 原样返回）。
 * 失败时抛出带中文原因的 Error（超时、非 2xx、响应过大、不支持的类型等）。
 * @param url 目标网页地址，仅支持 http/https
 */
export async function fetchPageContent(url: string): Promise<string> {
  const safeUrl = validateUrl(url)
  const { contentType, body } = await fetchWithLimit(safeUrl)
  const mime = contentType.split(';')[0].trim().toLowerCase()

  // Content-Type 分流：HTML 走正文提取；纯文本/Markdown/JSON 直接返回；其余拒绝
  if (mime === 'text/html' || mime === 'application/xhtml+xml' || mime === '') {
    const markdown = extractMarkdownFromHtml(body, safeUrl)
    if (!markdown) {
      throw new Error('未能从页面提取到文本内容')
    }
    return detectJsRequirement(markdown)
  }
  if (mime === 'text/plain' || mime === 'text/markdown' || mime === 'application/json' || mime.endsWith('+json')) {
    if (!body.trim()) {
      throw new Error('页面内容为空')
    }
    return detectJsRequirement(body)
  }
  throw new Error(`不支持的内容类型: ${mime}（仅支持 HTML / 纯文本 / Markdown / JSON）`)
}

/** JS 渲染页面检测：提取内容含降级占位文本时附加标注 */
function detectJsRequirement(content: string): string {
  const lower = content.toLowerCase()
  const indicators = ['please enable javascript', 'error while loading', 'uh oh!', 'requires javascript']
  if (indicators.some(s => lower.includes(s))) {
    return `[注意：此页面可能需要 JavaScript 渲染，以下提取内容可能不完整]\n\n${content}`
  }
  return content
}

/** URL 校验：仅 http/https、剥离 user:pass@ 凭证、限长 2048 */
function validateUrl(raw: string): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) {
    throw new Error('URL 不能为空')
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new Error(`URL 过长（超过 ${MAX_URL_LENGTH} 字符）`)
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`无效的 URL: ${trimmed}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`仅支持 http/https 链接，当前协议为 ${parsed.protocol.replace(':', '')}`)
  }
  // 剥离 user:pass@，避免凭证随请求泄露给对端
  parsed.username = ''
  parsed.password = ''
  return parsed.href
}

/** 发起请求并受限读取响应体：AbortController + setTimeout 超时，响应上限 5MB */
async function fetchWithLimit(url: string): Promise<{ contentType: string; body: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/plain,application/json,*/*;q=0.8',
        },
        signal: controller.signal,
        redirect: 'follow',
      })
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`抓取超时（${FETCH_TIMEOUT_MS / 1000} 秒）: ${url}`)
      }
      throw new Error(`网络请求失败: ${(err as Error).message}`)
    }
    if (!res.ok) {
      throw new Error(`抓取失败: HTTP ${res.status} ${res.statusText}`.trim())
    }
    const contentType = res.headers.get('content-type') || ''
    const contentLength = Number(res.headers.get('content-length') || 0)
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new Error('响应过大（超过 5MB），已放弃抓取')
    }
    const body = await readBodyWithLimit(res)
    return { contentType, body }
  } finally {
    clearTimeout(timer)
  }
}

/** 分块读取响应体，累计超过 5MB 即中断 */
async function readBodyWithLimit(res: Response): Promise<string> {
  if (!res.body) {
    return res.text()
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value) {
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('响应过大（超过 5MB），已中断读取')
      }
      chunks.push(value)
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  // 按 UTF-8 解码；GBK 等非 UTF-8 页面会乱码，属已知限制（MVP 不做编码嗅探）
  return new TextDecoder('utf-8').decode(merged)
}

/** HTML → Markdown 正文提取：预清理 → 候选块打分 → 标签映射 → 实体解码 */
function extractMarkdownFromHtml(html: string, baseUrl?: string): string {
  const cleaned = precleanHtml(html)
  const best = findBestBlock(cleaned)
  // 得分过低判定为非文章页，降级为 body 全量
  const fragment = best ? cleaned.slice(best.contentStart, best.contentEnd) : extractBodyFragment(cleaned)
  return normalizeMarkdown(fragmentToMarkdown(fragment, baseUrl))
}

/** 预清理：剔除 script/style/noscript/template/head 整块及 HTML 注释 */
function precleanHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|noscript|template|head)\b[^>]*\/?>/gi, '')
}

/** 正文候选块：扫描时累计统计量，闭合时按内容区间结算 */
interface BlockCandidate {
  tag: string
  attrs: string
  /** 内容区间：开标签结束处 → 闭标签开始处 */
  contentStart: number
  contentEnd: number
  textLen: number
  linkTextLen: number
  paragraphs: number
}

/**
 * 标签流单趟扫描：维护块级容器栈，累计各容器的文本长度、链接内文本长度、段落数，
 * 取 得分 = 文本长度 × 语义权重 × (1 - 链接密度) 最高的候选块。
 * 返回 null 表示没有像样的正文候选（非文章页）。
 */
function findBestBlock(html: string): BlockCandidate | null {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  const stack: BlockCandidate[] = []
  let anchorDepth = 0
  let best: BlockCandidate | null = null
  let bestScore = 0
  let lastIndex = 0

  const finalize = (candidate: BlockCandidate, contentEnd: number) => {
    candidate.contentEnd = contentEnd
    if (candidate.textLen <= 0) {
      return
    }
    const linkDensity = candidate.linkTextLen / candidate.textLen
    const score = candidate.textLen * (1 - linkDensity) * semanticWeight(candidate.tag, candidate.attrs)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }

  let match: RegExpExecArray | null
  while ((match = tagRe.exec(html)) !== null) {
    // 统计标签间文本：计入栈内所有候选块（子块文本同时计入祖先）
    if (stack.length > 0) {
      const text = html.slice(lastIndex, match.index).replace(/\s+/g, ' ').trim()
      if (text.length > 0) {
        for (const candidate of stack) {
          candidate.textLen += text.length
          if (anchorDepth > 0) {
            candidate.linkTextLen += text.length
          }
        }
      }
    }
    lastIndex = tagRe.lastIndex

    const isClose = match[1] === '/'
    const tag = match[2].toLowerCase()
    const attrs = match[3] || ''

    if (isClose) {
      if (tag === 'a') {
        anchorDepth = Math.max(0, anchorDepth - 1)
      } else if (CANDIDATE_TAGS.has(tag)) {
        // 从栈顶向下找同名候选结算；其上未闭合的候选一并按此处闭合（容错残缺嵌套）
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tag === tag) {
            while (stack.length > i) {
              finalize(stack.pop()!, match.index)
            }
            break
          }
        }
      }
      continue
    }

    if (tag === 'a') {
      if (/\bhref\s*=/i.test(attrs)) {
        anchorDepth++
      }
    } else if (PARAGRAPH_TAGS.has(tag)) {
      for (const candidate of stack) {
        candidate.paragraphs++
      }
    } else if (CANDIDATE_TAGS.has(tag) && !/\/\s*$/.test(attrs)) {
      stack.push({
        tag,
        attrs,
        contentStart: tagRe.lastIndex,
        contentEnd: -1,
        textLen: 0,
        linkTextLen: 0,
        paragraphs: 0,
      })
    }
  }
  // 收尾：始终未闭合的候选按 HTML 末尾结算
  for (const candidate of stack) {
    finalize(candidate, html.length)
  }

  // 得分过低（文本太少或被链接密度/负向语义压垮）判定非文章页
  // 注：best 在 finalize 闭包内赋值，控制流分析会窄化为 null，这里显式还原类型
  const winner = best as BlockCandidate | null
  if (!winner || winner.textLen < MIN_ARTICLE_TEXT_LEN || bestScore < 50) {
    return null
  }
  return winner
}

/** class/id 语义加权：article|content|main|post 等加分，nav|sidebar|comment|footer|ad 等减分 */
function semanticWeight(tag: string, attrs: string): number {
  let weight = 1
  if (tag === 'article' || tag === 'main') {
    weight += 0.5
  }
  const classId = (attrs.match(/(?:class|id)\s*=\s*(?:"[^"]*"|'[^']*')/gi) || []).join(' ').toLowerCase()
  if (classId) {
    const positive = classId.match(/article|content|main|post|entry|story|detail/g)
    const negative = classId.match(/nav|sidebar|comment|footer|header|promo|related|menu|recommend|breadcrumb|\bads?\b/g)
    if (positive) {
      weight += positive.length * 0.25
    }
    if (negative) {
      weight -= negative.length * 0.25
    }
  }
  return Math.max(0.1, weight)
}

/** 降级路径：取 body 全量，无 body 则取整篇 */
function extractBodyFragment(html: string): string {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  return match ? match[1] : html
}

/**
 * 标签→Markdown 映射：
 * h1-h6→#、p/div→换行、a→[文字](href)、li→- 、pre/code→围栏、img 丢弃、其余剥标签留文本。
 */
function fragmentToMarkdown(fragment: string, baseUrl?: string): string {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let out = ''
  let lastIndex = 0
  let preDepth = 0
  // 当前 <a> 的 href；null 表示不在链接内（锚点实际不嵌套，单层即可）
  let anchorHref: string | null = null

  const emitText = (raw: string) => {
    if (!raw) {
      return
    }
    const decoded = decodeEntities(raw)
    // pre 内保留原始空白，其余折叠为单个空格
    out += preDepth > 0 ? decoded : decoded.replace(/\s+/g, ' ')
  }

  let match: RegExpExecArray | null
  while ((match = tagRe.exec(fragment)) !== null) {
    emitText(fragment.slice(lastIndex, match.index))
    lastIndex = tagRe.lastIndex

    const isClose = match[1] === '/'
    const tag = match[2].toLowerCase()
    const attrs = match[3] || ''

    if (tag === 'pre') {
      out += isClose ? '\n```\n\n' : '\n\n```\n'
      preDepth = Math.max(0, preDepth + (isClose ? -1 : 1))
    } else if (tag === 'code') {
      // pre 内的 code 不再加反引号，避免围栏内出现行内代码标记
      if (preDepth === 0) {
        out += '`'
      }
    } else if (/^h[1-6]$/.test(tag)) {
      const level = '#'.repeat(Number(tag[1]))
      out += isClose ? '\n\n' : `\n\n${level} `
    } else if (tag === 'p') {
      out += isClose ? '\n' : '\n\n'
    } else if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'tr') {
      out += '\n'
    } else if (tag === 'br') {
      out += '\n'
    } else if (tag === 'li') {
      if (!isClose) {
        out += '\n- '
      }
    } else if (tag === 'blockquote') {
      if (!isClose) {
        out += '\n\n> '
      } else {
        out += '\n\n'
      }
    } else if (tag === 'td' || tag === 'th') {
      // 表格无 Markdown 映射，单元格间补空格防止文字粘连
      if (!isClose) {
        out += ' '
      }
    } else if (tag === 'a') {
      if (!isClose && anchorHref === null) {
        anchorHref = resolveHref(extractAttr(attrs, 'href'), baseUrl)
        if (anchorHref) {
          out += '['
        }
      } else if (isClose && anchorHref !== null) {
        out += `](${anchorHref})`
        anchorHref = null
      }
    }
    // img 及其余标签一律剥掉只留文本
  }
  emitText(fragment.slice(lastIndex))
  return out
}

/** 提取开标签属性值（支持双引号 / 单引号 / 无引号三种写法） */
function extractAttr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  if (!match) {
    return null
  }
  return match[1] ?? match[2] ?? match[3] ?? null
}

/** 解析链接 href：过滤 javascript: 等危险协议，相对链接按页面 URL 补全 */
function resolveHref(href: string | null, baseUrl?: string): string | null {
  if (!href) {
    return null
  }
  const trimmed = decodeEntities(href).trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return null
  }
  try {
    const resolved = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null
    }
    return resolved.href
  } catch {
    return null
  }
}

/** HTML 实体解码：常见命名实体 + &#123; / &#x1f; 数值形式 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (raw, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10)
      if (Number.isNaN(code) || code > 0x10ffff) {
        return raw
      }
      try {
        return String.fromCodePoint(code)
      } catch {
        return raw
      }
    }
    return NAMED_ENTITIES[entity] ?? raw
  })
}

/** 收尾规整：去行尾空白、折叠连续空行、整体 trim */
function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
