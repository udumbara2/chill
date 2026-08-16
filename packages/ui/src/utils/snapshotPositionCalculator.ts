import { normalizeText, generateNormalizedTextWithMapping } from '@assistant-ai/core'
import type { MappingItem } from '@assistant-ai/core'
import type { DocumentSnapshot } from './tipTapDocumentSnapshot'
import { plainTextIndexToTipTapPos } from './tipTapDocumentSnapshot'

const isMainThread = typeof window === 'undefined'

let webWorker: Worker | null = null
let workerPromise: Promise<Worker | null> | null = null

async function getWebWorker(): Promise<Worker | null> {
  if (isMainThread) return null
  if (webWorker) return webWorker
  if (workerPromise) return workerPromise
  
  workerPromise = (async () => {
    try {
      const WorkerModule = await import('./snapshotPositionCalculatorWorker?worker')
      webWorker = new WorkerModule.default()
      return webWorker
    } catch {
      return null
    }
  })()
  
  return workerPromise
}

async function runFuzzyMatchInWorker(
  normalizedSnapshot: string,
  normalizedTarget: string,
  threshold: number = 0.85
): Promise<Array<{ index: number; similarity: number }>> {
  const worker = await getWebWorker()
  if (!worker) {
    return findFuzzyMatchesSync(normalizedSnapshot, normalizedTarget, threshold)
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      worker.removeEventListener('message', handleResult)
      worker.removeEventListener('error', handleError)
      worker.terminate()
      webWorker = null
      workerPromise = null
      reject(new Error('Web Worker 超时'))
    }, 30000)

    const handleResult = (e: MessageEvent) => {
      clearTimeout(timeoutId)
      worker.removeEventListener('message', handleResult)
      worker.removeEventListener('error', handleError)
      resolve(e.data.results)
    }

    const handleError = (err: ErrorEvent) => {
      clearTimeout(timeoutId)
      worker.removeEventListener('message', handleResult)
      worker.removeEventListener('error', handleError)
      worker.terminate()
      webWorker = null
      workerPromise = null
      reject(new Error(`Web Worker 错误: ${err.message}`))
    }

    worker.addEventListener('message', handleResult)
    worker.addEventListener('error', handleError)
    worker.postMessage({ normalizedSnapshot, normalizedTarget, threshold })
  })
}

function trimWhitespace(s: string): string {
  return s.replace(/^[\s\n]+|[\s\n]+$/g, '')
}

function getOriginalPositionFromMapping(
  mapping: MappingItem[],
  normFrom: number,
  normTo: number
): { originalFrom: number; originalTo: number } | null {
  const startItem = mapping.find((m) => m.normIndex === normFrom)
  const endItem = mapping.find((m) => m.normIndex === normTo - 1)

  if (!startItem || !endItem) {
    return null
  }

  return {
    originalFrom: startItem.originalFrom,
    originalTo: endItem.originalTo
  }
}

export interface SnapshotPositionResultSuccess {
  success: true
  plainTextFrom: number
  plainTextTo: number
  from: number
  to: number
  matchedText: string
}

export interface CandidatePosition {
  index: number
  snippet: string
  suggested_context_before?: string
  suggested_context_after?: string
}

export interface SnapshotPositionResultFailure {
  success: false
  error: string
  candidates?: Array<CandidatePosition>
}

export type SnapshotPositionResult = SnapshotPositionResultSuccess | SnapshotPositionResultFailure

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }
  return matrix[b.length][a.length]
}

function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1
  const distance = levenshteinDistance(a, b)
  const maxLength = Math.max(a.length, b.length)
  return 1 - distance / maxLength
}

function findFuzzyMatchesSync(
  normalizedSnapshot: string,
  normalizedTarget: string,
  threshold: number = 0.85
): Array<{ index: number; similarity: number }> {
  const results: Array<{ index: number; similarity: number }> = []
  const targetLen = normalizedTarget.length

  for (let i = 0; i <= normalizedSnapshot.length - targetLen; i++) {
    const candidate = normalizedSnapshot.slice(i, i + targetLen)
    const sim = similarity(candidate, normalizedTarget)
    if (sim >= threshold) {
      results.push({ index: i, similarity: sim })
    }
  }

  const tolerance = Math.ceil(targetLen * 0.1)
  for (let delta = 1; delta <= tolerance; delta++) {
    for (let i = 0; i <= normalizedSnapshot.length - (targetLen + delta); i++) {
      const candidate = normalizedSnapshot.slice(i, i + targetLen + delta)
      const sim = similarity(candidate, normalizedTarget)
      if (sim >= threshold) {
        results.push({ index: i, similarity: sim })
      }
    }
    for (let i = 0; i <= normalizedSnapshot.length - (targetLen - delta); i++) {
      const candidate = normalizedSnapshot.slice(i, i + targetLen - delta)
      const sim = similarity(candidate, normalizedTarget)
      if (sim >= threshold) {
        results.push({ index: i, similarity: sim })
      }
    }
  }

  results.sort((a, b) => b.similarity - a.similarity)

  const uniqueResults: Array<{ index: number; similarity: number }> = []
  const seenIndices = new Set<number>()
  for (const result of results) {
    if (!seenIndices.has(result.index)) {
      seenIndices.add(result.index)
      uniqueResults.push(result)
    }
  }

  return uniqueResults
}

export async function calculatePositionInSnapshotAsync(
  snapshot: DocumentSnapshot,
  targetText: string,
  contextBefore: string = '',
  contextAfter: string = ''
): Promise<SnapshotPositionResult> {
  const docNorm = generateNormalizedTextWithMapping(snapshot.plainText)
  const normalizedSnapshot = docNorm.normalizedText
  const mapping = docNorm.mapping

  const normalizedTarget = normalizeText(targetText)
  const normalizedBefore = normalizeText(contextBefore)
  const normalizedAfter = normalizeText(contextAfter)

  const matches: number[] = []
  let currentIndex = normalizedSnapshot.indexOf(normalizedTarget)
  while (currentIndex !== -1) {
    matches.push(currentIndex)
    currentIndex = normalizedSnapshot.indexOf(normalizedTarget, currentIndex + normalizedTarget.length)
  }

  if (matches.length === 0) {
    const fuzzyMatches = await runFuzzyMatchInWorker(normalizedSnapshot, normalizedTarget, 0.85)

    if (fuzzyMatches.length === 0) {
      return {
        success: false,
        error: `未找到匹配的文本：${targetText}`
      }
    }

    const validFuzzyMatches = fuzzyMatches.filter((match) => {
      const estimatedEnd = match.index + normalizedTarget.length
      const actualBefore = normalizedSnapshot.slice(Math.max(0, match.index - normalizedBefore.length), match.index)
      const beforeValid = normalizedBefore === '' || actualBefore.endsWith(normalizedBefore)
      const actualAfter = normalizedSnapshot.slice(estimatedEnd, estimatedEnd + normalizedAfter.length)
      const afterValid = normalizedAfter === '' || actualAfter.startsWith(normalizedAfter)

      return beforeValid && afterValid
    })

    if (validFuzzyMatches.length > 1) {
      const candidates = validFuzzyMatches.map((match) => {
        const posResult = getOriginalPositionFromMapping(mapping, match.index, match.index + normalizedTarget.length)
        const matchEnd = posResult ? posResult.originalTo : match.index + targetText.length
        const matchStart = posResult ? posResult.originalFrom : match.index
        return {
          index: match.index,
          snippet: snapshot.plainText.slice(Math.max(0, matchStart - 20), matchEnd + 20),
          suggested_context_before: snapshot.plainText.slice(Math.max(0, matchStart - 30), matchStart),
          suggested_context_after: snapshot.plainText.slice(matchEnd, matchEnd + 30)
        }
      })
      return {
        success: false,
        error: '找到多个模糊匹配位置，请补充更精确的上下文',
        candidates
      }
    }

    if (validFuzzyMatches.length === 0) {
      return {
        success: false,
        error: `未找到匹配的文本：${targetText}`
      }
    }

    const bestMatch = validFuzzyMatches[0]
    const normalizedStart = bestMatch.index
    const normalizedEnd = normalizedStart + normalizedTarget.length

    const posResult = getOriginalPositionFromMapping(mapping, normalizedStart, normalizedEnd)
    if (!posResult) {
      return {
        success: false,
        error: '无法映射到原始位置'
      }
    }

    const tipTapFrom = plainTextIndexToTipTapPos(snapshot, posResult.originalFrom)
    const tipTapTo = plainTextIndexToTipTapPos(snapshot, posResult.originalTo)

    if (tipTapFrom === null || tipTapTo === null) {
      return {
        success: false,
        error: '无法映射到 TipTap 位置'
      }
    }

    return {
      success: true,
      plainTextFrom: posResult.originalFrom,
      plainTextTo: posResult.originalTo,
      from: tipTapFrom,
      to: tipTapTo,
      matchedText: snapshot.plainText.slice(posResult.originalFrom, posResult.originalTo)
    }
  }

  const validMatches = matches.filter((startIndex) => {
    const endIndex = startIndex + normalizedTarget.length
    const actualBefore = normalizedSnapshot.slice(Math.max(0, startIndex - normalizedBefore.length), startIndex)
    const trimmedExpectedBefore = trimWhitespace(normalizedBefore)
    const trimmedActualBefore = trimWhitespace(actualBefore)
    const beforeValid = trimmedExpectedBefore === '' || trimmedActualBefore.includes(trimmedExpectedBefore)
    const actualAfter = normalizedSnapshot.slice(endIndex, endIndex + normalizedAfter.length)
    const trimmedExpectedAfter = trimWhitespace(normalizedAfter)
    const trimmedActualAfter = trimWhitespace(actualAfter)
    const afterValid = trimmedExpectedAfter === '' || trimmedActualAfter.includes(trimmedExpectedAfter)

    return beforeValid && afterValid
  })

  if (validMatches.length > 1) {
    const candidates = validMatches.map((index) => {
      const posResult = getOriginalPositionFromMapping(mapping, index, index + normalizedTarget.length)
      const matchEnd = posResult ? posResult.originalTo : index + targetText.length
      const matchStart = posResult ? posResult.originalFrom : index
      return {
        index,
        snippet: snapshot.plainText.slice(Math.max(0, matchStart - 20), matchEnd + 20),
        suggested_context_before: snapshot.plainText.slice(Math.max(0, matchStart - 30), matchStart),
        suggested_context_after: snapshot.plainText.slice(matchEnd, matchEnd + 30)
      }
    })
    return {
      success: false,
      error: '找到多个匹配位置，请补充更精确的上下文',
      candidates
    }
  }

  if (validMatches.length === 0) {
    if (matches.length === 1) {
      const normalizedStart = matches[0]
      const normalizedEnd = normalizedStart + normalizedTarget.length

      const posResult = getOriginalPositionFromMapping(mapping, normalizedStart, normalizedEnd)
      if (!posResult) {
        return {
          success: false,
          error: '无法映射到原始位置'
        }
      }

      const tipTapFrom = plainTextIndexToTipTapPos(snapshot, posResult.originalFrom)
      const tipTapTo = plainTextIndexToTipTapPos(snapshot, posResult.originalTo)

      if (tipTapFrom === null || tipTapTo === null) {
        return {
          success: false,
          error: '无法映射到 TipTap 位置'
        }
      }

      return {
        success: true,
        plainTextFrom: posResult.originalFrom,
        plainTextTo: posResult.originalTo,
        from: tipTapFrom,
        to: tipTapTo,
        matchedText: snapshot.plainText.slice(posResult.originalFrom, posResult.originalTo)
      }
    }

    if (matches.length > 0) {
      const candidates = matches.map((index) => {
        const posResult = getOriginalPositionFromMapping(mapping, index, index + normalizedTarget.length)
        const matchEnd = posResult ? posResult.originalTo : index + targetText.length
        const matchStart = posResult ? posResult.originalFrom : index
        return {
          index,
          snippet: snapshot.plainText.slice(Math.max(0, matchStart - 20), matchEnd + 20),
          suggested_context_before: snapshot.plainText.slice(Math.max(0, matchStart - 30), matchStart),
          suggested_context_after: snapshot.plainText.slice(matchEnd, matchEnd + 30)
        }
      })
      return {
        success: false,
        error: '找到匹配文本但上下文校验失败，请使用建议的上下文重新调用',
        candidates
      }
    }
    return {
      success: false,
      error: '匹配到的文本不符合上下文校验'
    }
  }

  const normalizedStart = validMatches[0]
  const normalizedEnd = normalizedStart + normalizedTarget.length

  const posResult = getOriginalPositionFromMapping(mapping, normalizedStart, normalizedEnd)
  if (!posResult) {
    return {
      success: false,
      error: '无法映射到原始位置'
    }
  }

  const tipTapFrom = plainTextIndexToTipTapPos(snapshot, posResult.originalFrom)
  const tipTapTo = plainTextIndexToTipTapPos(snapshot, posResult.originalTo)

  if (tipTapFrom === null || tipTapTo === null) {
    return {
      success: false,
      error: '无法映射到 TipTap 位置'
    }
  }

  return {
    success: true,
    plainTextFrom: posResult.originalFrom,
    plainTextTo: posResult.originalTo,
    from: tipTapFrom,
    to: tipTapTo,
    matchedText: snapshot.plainText.slice(posResult.originalFrom, posResult.originalTo)
  }
}

export function calculatePositionInSnapshot(
  snapshot: DocumentSnapshot,
  targetText: string,
  contextBefore: string = '',
  contextAfter: string = ''
): SnapshotPositionResult {
  const docNorm = generateNormalizedTextWithMapping(snapshot.plainText)
  const normalizedSnapshot = docNorm.normalizedText
  const mapping = docNorm.mapping

  const normalizedTarget = normalizeText(targetText)
  const normalizedBefore = normalizeText(contextBefore)
  const normalizedAfter = normalizeText(contextAfter)

  const matches: number[] = []
  let currentIndex = normalizedSnapshot.indexOf(normalizedTarget)
  while (currentIndex !== -1) {
    matches.push(currentIndex)
    currentIndex = normalizedSnapshot.indexOf(normalizedTarget, currentIndex + normalizedTarget.length)
  }

  if (matches.length === 0) {
    const fuzzyMatches = findFuzzyMatchesSync(normalizedSnapshot, normalizedTarget, 0.85)

    if (fuzzyMatches.length === 0) {
      return {
        success: false,
        error: `未找到匹配的文本：${targetText}`
      }
    }

    const validFuzzyMatches = fuzzyMatches.filter((match) => {
      const estimatedEnd = match.index + normalizedTarget.length
      const actualBefore = normalizedSnapshot.slice(Math.max(0, match.index - normalizedBefore.length), match.index)
      const beforeValid = normalizedBefore === '' || actualBefore.endsWith(normalizedBefore)
      const actualAfter = normalizedSnapshot.slice(estimatedEnd, estimatedEnd + normalizedAfter.length)
      const afterValid = normalizedAfter === '' || actualAfter.startsWith(normalizedAfter)

      return beforeValid && afterValid
    })

    if (validFuzzyMatches.length > 1) {
      const candidates = validFuzzyMatches.map((match) => {
        const posResult = getOriginalPositionFromMapping(mapping, match.index, match.index + normalizedTarget.length)
        const matchEnd = posResult ? posResult.originalTo : match.index + targetText.length
        const matchStart = posResult ? posResult.originalFrom : match.index
        return {
          index: match.index,
          snippet: snapshot.plainText.slice(Math.max(0, matchStart - 20), matchEnd + 20),
          suggested_context_before: snapshot.plainText.slice(Math.max(0, matchStart - 30), matchStart),
          suggested_context_after: snapshot.plainText.slice(matchEnd, matchEnd + 30)
        }
      })
      return {
        success: false,
        error: '找到多个模糊匹配位置，请补充更精确的上下文',
        candidates
      }
    }

    if (validFuzzyMatches.length === 0) {
      return {
        success: false,
        error: `未找到匹配的文本：${targetText}`
      }
    }

    const bestMatch = validFuzzyMatches[0]
    const normalizedStart = bestMatch.index
    const normalizedEnd = normalizedStart + normalizedTarget.length

    const posResult = getOriginalPositionFromMapping(mapping, normalizedStart, normalizedEnd)
    if (!posResult) {
      return {
        success: false,
        error: '无法映射到原始位置'
      }
    }

    const tipTapFrom = plainTextIndexToTipTapPos(snapshot, posResult.originalFrom)
    const tipTapTo = plainTextIndexToTipTapPos(snapshot, posResult.originalTo)

    if (tipTapFrom === null || tipTapTo === null) {
      return {
        success: false,
        error: '无法映射到 TipTap 位置'
      }
    }

    return {
      success: true,
      plainTextFrom: posResult.originalFrom,
      plainTextTo: posResult.originalTo,
      from: tipTapFrom,
      to: tipTapTo,
      matchedText: snapshot.plainText.slice(posResult.originalFrom, posResult.originalTo)
    }
  }

  const validMatches = matches.filter((startIndex) => {
    const endIndex = startIndex + normalizedTarget.length
    const actualBefore = normalizedSnapshot.slice(Math.max(0, startIndex - normalizedBefore.length), startIndex)
    const trimmedExpectedBefore = trimWhitespace(normalizedBefore)
    const trimmedActualBefore = trimWhitespace(actualBefore)
    const beforeValid = trimmedExpectedBefore === '' || trimmedActualBefore.includes(trimmedExpectedBefore)
    const actualAfter = normalizedSnapshot.slice(endIndex, endIndex + normalizedAfter.length)
    const trimmedExpectedAfter = trimWhitespace(normalizedAfter)
    const trimmedActualAfter = trimWhitespace(actualAfter)
    const afterValid = trimmedExpectedAfter === '' || trimmedActualAfter.includes(trimmedExpectedAfter)

    return beforeValid && afterValid
  })

  if (validMatches.length > 1) {
    const candidates = validMatches.map((index) => {
      const posResult = getOriginalPositionFromMapping(mapping, index, index + normalizedTarget.length)
      const matchEnd = posResult ? posResult.originalTo : index + targetText.length
      const matchStart = posResult ? posResult.originalFrom : index
      return {
        index,
        snippet: snapshot.plainText.slice(Math.max(0, matchStart - 20), matchEnd + 20),
        suggested_context_before: snapshot.plainText.slice(Math.max(0, matchStart - 30), matchStart),
        suggested_context_after: snapshot.plainText.slice(matchEnd, matchEnd + 30)
      }
    })
    return {
      success: false,
      error: '找到多个匹配位置，请补充更精确的上下文',
      candidates
    }
  }

  if (validMatches.length === 0) {
    if (matches.length === 1) {
      const normalizedStart = matches[0]
      const normalizedEnd = normalizedStart + normalizedTarget.length

      const posResult = getOriginalPositionFromMapping(mapping, normalizedStart, normalizedEnd)
      if (!posResult) {
        return {
          success: false,
          error: '无法映射到原始位置'
        }
      }

      const tipTapFrom = plainTextIndexToTipTapPos(snapshot, posResult.originalFrom)
      const tipTapTo = plainTextIndexToTipTapPos(snapshot, posResult.originalTo)

      if (tipTapFrom === null || tipTapTo === null) {
        return {
          success: false,
          error: '无法映射到 TipTap 位置'
        }
      }

      return {
        success: true,
        plainTextFrom: posResult.originalFrom,
        plainTextTo: posResult.originalTo,
        from: tipTapFrom,
        to: tipTapTo,
        matchedText: snapshot.plainText.slice(posResult.originalFrom, posResult.originalTo)
      }
    }

    if (matches.length > 0) {
      const candidates = matches.map((index) => {
        const posResult = getOriginalPositionFromMapping(mapping, index, index + normalizedTarget.length)
        const matchEnd = posResult ? posResult.originalTo : index + targetText.length
        const matchStart = posResult ? posResult.originalFrom : index
        return {
          index,
          snippet: snapshot.plainText.slice(Math.max(0, matchStart - 20), matchEnd + 20),
          suggested_context_before: snapshot.plainText.slice(Math.max(0, matchStart - 30), matchStart),
          suggested_context_after: snapshot.plainText.slice(matchEnd, matchEnd + 30)
        }
      })
      return {
        success: false,
        error: '找到匹配文本但上下文校验失败，请使用建议的上下文重新调用',
        candidates
      }
    }
    return {
      success: false,
      error: '匹配到的文本不符合上下文校验'
    }
  }

  const normalizedStart = validMatches[0]
  const normalizedEnd = normalizedStart + normalizedTarget.length

  const posResult = getOriginalPositionFromMapping(mapping, normalizedStart, normalizedEnd)
  if (!posResult) {
    return {
      success: false,
      error: '无法映射到原始位置'
    }
  }

  const tipTapFrom = plainTextIndexToTipTapPos(snapshot, posResult.originalFrom)
  const tipTapTo = plainTextIndexToTipTapPos(snapshot, posResult.originalTo)

  if (tipTapFrom === null || tipTapTo === null) {
    return {
      success: false,
      error: '无法映射到 TipTap 位置'
    }
  }

  return {
    success: true,
    plainTextFrom: posResult.originalFrom,
    plainTextTo: posResult.originalTo,
    from: tipTapFrom,
    to: tipTapTo,
    matchedText: snapshot.plainText.slice(posResult.originalFrom, posResult.originalTo)
  }
}

export interface InsertPositionResultSuccess {
  success: true
  plainTextPos: number
  pos: number
  matchedText: string
}

export type InsertPositionResult = InsertPositionResultSuccess | SnapshotPositionResultFailure

export function calculateInsertPositionInSnapshot(
  snapshot: DocumentSnapshot,
  anchor: string,
  position: 'before' | 'after' = 'after'
): InsertPositionResult {
  const docNorm = generateNormalizedTextWithMapping(snapshot.plainText)
  const normalizedSnapshot = docNorm.normalizedText
  const mapping = docNorm.mapping

  const normalizedAnchor = normalizeText(anchor)

  const matches: number[] = []
  let currentIndex = normalizedSnapshot.indexOf(normalizedAnchor)
  while (currentIndex !== -1) {
    matches.push(currentIndex)
    currentIndex = normalizedSnapshot.indexOf(normalizedAnchor, currentIndex + normalizedAnchor.length)
  }

  if (matches.length === 0) {
    return {
      success: false,
      error: `未找到锚点文本：${anchor}`
    }
  }

  if (matches.length > 1) {
    const candidates = matches.map((index) => {
      const posResult = getOriginalPositionFromMapping(mapping, index, index + normalizedAnchor.length)
      const matchEnd = posResult ? posResult.originalTo : index + anchor.length
      const matchStart = posResult ? posResult.originalFrom : index
      return {
        index,
        snippet: snapshot.plainText.slice(Math.max(0, matchStart - 20), matchEnd + 20),
        suggested_context_before: snapshot.plainText.slice(Math.max(0, matchStart - 30), matchStart),
        suggested_context_after: snapshot.plainText.slice(matchEnd, matchEnd + 30)
      }
    })
    return {
      success: false,
      error: '找到多个匹配位置，请补充更精确的上下文',
      candidates
    }
  }

  const normalizedStart = matches[0]
  const normalizedEnd = normalizedStart + normalizedAnchor.length

  const posResult = getOriginalPositionFromMapping(mapping, normalizedStart, normalizedEnd)
  if (!posResult) {
    return {
      success: false,
      error: '无法映射到原始位置'
    }
  }

  let insertPlainTextPos: number
  const originalText = snapshot.plainText

  if (position === 'after') {
    insertPlainTextPos = posResult.originalTo
    // 跳过锚点行末尾的换行符，使插入位置在下一行开头
    while (insertPlainTextPos < originalText.length && (originalText[insertPlainTextPos] === '\r' || originalText[insertPlainTextPos] === '\n')) {
      insertPlainTextPos++
    }
  } else {
    insertPlainTextPos = posResult.originalFrom
    // 回退到锚点所在行的行首
    while (insertPlainTextPos > 0 && originalText[insertPlainTextPos - 1] !== '\n' && originalText[insertPlainTextPos - 1] !== '\r') {
      insertPlainTextPos--
    }
  }

  const tipTapPos = plainTextIndexToTipTapPos(snapshot, insertPlainTextPos)

  if (tipTapPos === null) {
    return {
      success: false,
      error: '无法映射到 TipTap 位置'
    }
  }

  return {
    success: true,
    plainTextPos: insertPlainTextPos,
    pos: tipTapPos,
    matchedText: snapshot.plainText.slice(posResult.originalFrom, posResult.originalTo)
  }
}
