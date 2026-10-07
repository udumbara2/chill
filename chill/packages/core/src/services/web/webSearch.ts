/**
 * 免 Key 网页搜索：使用 Bing 搜索（自动 302 到 cn.bing.com）。
 * 首个"网络可达且解析出 ≥1 条结果"的后端胜出；全部失败时抛出指明各后端原因的错误。
 * 零依赖：仅用 Node 18+ 全局 fetch 与正则解析。
 */

export interface WebSearchResult {
  rank: number
  title: string
  url: string
  snippet: string
}

/** 桌面 Chrome UA（Bing 对非浏览器 UA 会返回精简/反爬页面） */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 单次请求超时（与 htmlExtractor 保持一致） */
const FETCH_TIMEOUT_MS = 15000

/** max_results 上限 */
const MAX_RESULTS_LIMIT = 20

/** 常见命名 HTML 实体表（搜索摘要中高频出现的子集） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  para: '¶',
  sect: '§',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
}

/** 解码 HTML 实体：常见命名实体 + &#123; / &#x1f; 数值形式 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      if (Number.isFinite(code)) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return match
        }
      }
      return match
    }
    return NAMED_ENTITIES[body] ?? match
  })
}

/** 剥掉所有 HTML 标签，保留文本并压缩空白 */
function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

/** 带超时的 GET，返回响应文本；非 2xx 或超时抛错 */
async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    return await res.text()
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('请求超时')
    }
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析 Bing 搜索结果页（标记结构已实测）：
 * 每个结果是一个 <li class="b_algo" 块，标题与直链在 <h2 class=""><a ... href> 内，
 * 摘要在 <p class="b_lineclamp2"> 内。URL 为真实直链，无需解跳转。
 */
function parseBingResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = []
  // 按结果块切分（class 可能带额外修饰，按前缀切）
  const blocks = html.split('<li class="b_algo').slice(1)
  for (const block of blocks) {
    const h2Match = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)
    if (!h2Match) continue
    const anchorMatch = h2Match[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!anchorMatch) continue
    const url = decodeEntities(anchorMatch[1])
    const title = stripTags(anchorMatch[2])
    if (!url || !title || !/^https?:\/\//.test(url)) continue

    // 摘要优先取 b_lineclamp 段落，取不到则退化为块内第一个 <p>
    const snippetMatch =
      block.match(/<p[^>]*class="[^"]*b_lineclamp\d[^"]*"[^>]*>([\s\S]*?)<\/p>/) ??
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : ''

    results.push({ rank: results.length + 1, title, url, snippet })
  }
  return results
}

/** 后端定义：请求地址 + 解析器 */
interface SearchBackend {
  name: string
  buildUrl: (query: string, maxResults: number) => string
  parse: (html: string) => WebSearchResult[]
}

/**
 * 查询预处理：避免长查询导致搜索引擎退化。
 * - 有空格查询：按空格分词，超过 8 个词元时截取前 8 个
 * - 无空格 CJK 查询：超过 20 字符时截取前 20 字符（防止 Bing 只搜首 1-2 字）
 * - 通用限制：整体超过 200 字符时截断
 */
function preprocessQuery(query: string): string {
  const trimmed = query.trim()
  if (trimmed.length > 200) {
    return trimmed.slice(0, 200)
  }
  if (/\s+/.test(trimmed)) {
    const tokens = trimmed.split(/\s+/)
    if (tokens.length > 8) {
      return tokens.slice(0, 8).join(' ')
    }
  } else if (trimmed.length > 20) {
    // 无空格的长 CJK 查询：截取前 20 字符
    return trimmed.slice(0, 20)
  }
  return trimmed
}

const BACKENDS: SearchBackend[] = [
  {
    // www.bing.com → 302 cn.bing.com：正常查询最快最好，敏感词受区域合规策略影响
    name: 'Bing',
    buildUrl: (query, maxResults) =>
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
    parse: parseBingResults,
  },
]

/**
 * 执行网页搜索，按后端链依次尝试，首个可达且解析出结果的后端胜出。
 * @param query 搜索关键词
 * @param maxResults 期望返回的最大条数（上限 20）
 * @throws 全部后端失败时抛出 Error，信息中指明各后端的失败原因
 */
export async function searchWeb(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const processedQuery = preprocessQuery(query)
  const limit = Math.max(1, Math.min(Math.floor(maxResults) || 10, MAX_RESULTS_LIMIT))
  const failures: string[] = []

  for (const backend of BACKENDS) {
    try {
      const html = await fetchHtml(backend.buildUrl(processedQuery, limit))
      const results = backend.parse(html)
      if (results.length === 0) {
        failures.push(`${backend.name}：未解析到结果（页面结构可能已改版）`)
        continue
      }
      const sliced = results.slice(0, limit)
      sliced.forEach((r, i) => {
        r.rank = i + 1
      })
      return sliced
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      failures.push(`${backend.name}：${reason}`)
    }
  }

  throw new Error(`网页搜索失败，所有后端均不可用（${failures.join('；')}）`)
}
