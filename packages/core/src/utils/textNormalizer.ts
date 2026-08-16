/**
 * 文本规范化工具函数
 * 统一处理换行符和空白字符，解决文本匹配和位置映射问题
 */

export interface MappingItem {
  normIndex: number
  originalFrom: number
  originalTo: number
  originalChars: string
}

export interface NormalizedTextWithMapping {
  normalizedText: string
  mapping: MappingItem[]
  originalLength: number
}

const PUNCTUATION_MAP: Record<string, string> = {
  '，': ',', '。': '.', '！': '!', '？': '?', '：': ':', '；': ';',
  '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'",
  '（': '(', '）': ')', '【': '[', '】': ']', '《': '<', '》': '>',
}

function normalizeChar(char: string): string {
  if (char === '\r') return '\n'
  if (/[\u00A0\u2000-\u200B\u3000\t]/.test(char)) return ' '
  return PUNCTUATION_MAP[char] || char
}

export function generateNormalizedTextWithMapping(text: string): NormalizedTextWithMapping {
  if (!text) {
    return { normalizedText: '', mapping: [], originalLength: 0 }
  }

  const mapping: MappingItem[] = []
  const normalizedChars: string[] = []
  let normIndex = 0
  let originalIndex = 0
  let inWhitespaceRun = false
  let whitespaceStart = -1
  let whitespaceChars = ''

  while (originalIndex < text.length) {
    const char = text[originalIndex]
    const normalizedChar = normalizeChar(char)
    const isWhitespace = /\s/.test(normalizedChar)

    if (isWhitespace) {
      if (!inWhitespaceRun) {
        inWhitespaceRun = true
        whitespaceStart = originalIndex
        whitespaceChars = char
      } else {
        whitespaceChars += char
      }
    } else {
      if (inWhitespaceRun) {
        const hasNewline = /[\r\n]/.test(whitespaceChars) || whitespaceChars.includes('\n')
        normalizedChars.push(hasNewline ? '\n' : ' ')
        mapping.push({
          normIndex,
          originalFrom: whitespaceStart,
          originalTo: originalIndex,
          originalChars: whitespaceChars
        })
        normIndex++
        inWhitespaceRun = false
        whitespaceStart = -1
        whitespaceChars = ''
      }

      normalizedChars.push(normalizedChar)
      mapping.push({
        normIndex,
        originalFrom: originalIndex,
        originalTo: originalIndex + 1,
        originalChars: char
      })
      normIndex++
    }

    originalIndex++
  }

  if (inWhitespaceRun) {
    const hasNewline = /[\r\n]/.test(whitespaceChars) || whitespaceChars.includes('\n')
    normalizedChars.push(hasNewline ? '\n' : ' ')
    mapping.push({
      normIndex,
      originalFrom: whitespaceStart,
      originalTo: originalIndex,
      originalChars: whitespaceChars
    })
  }

  return {
    normalizedText: normalizedChars.join(''),
    mapping,
    originalLength: text.length
  }
}

/**
 * 规范化文本
 * 统一处理换行符、空白字符和标点符号
 */
export function normalizeText(text: string): string {
  if (!text) return ''
  return generateNormalizedTextWithMapping(text).normalizedText
}

/**
 * 规范化文本用于匹配
 * 去除所有空白字符，仅保留可见文本
 */
export function normalizeTextForMatching(text: string): string {
  return normalizeText(text).replace(/\s/g, '')
}
