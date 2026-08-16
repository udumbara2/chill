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

function findFuzzyMatches(
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

export type FuzzyMatchResult = Array<{ index: number; similarity: number }>

export interface WorkerInput {
  normalizedSnapshot: string
  normalizedTarget: string
  threshold: number
}

export interface WorkerOutput {
  results: FuzzyMatchResult
}

self.onmessage = (e: MessageEvent<WorkerInput>) => {
  const { normalizedSnapshot, normalizedTarget, threshold } = e.data
  const results = findFuzzyMatches(normalizedSnapshot, normalizedTarget, threshold)
  const output: WorkerOutput = { results }
  self.postMessage(output)
}
