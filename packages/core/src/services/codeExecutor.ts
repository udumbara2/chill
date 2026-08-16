import type { ICodeExecutor, SupportedLanguage, ExecutionResult, ExecutionOptions } from '../execution'

let executor: ICodeExecutor | null = null

export function setExecutor(exec: ICodeExecutor): void {
  executor = exec
}

export interface ParsedCode {
  language: 'javascript' | 'python' | 'typescript' | 'shell' | 'powershell' | 'html'
  code: string
}

export interface CodeExecutorOptions extends ExecutionOptions {
  memoryLimit?: number
  defaultLanguage?: 'javascript' | 'python' | 'typescript' | 'shell' | 'powershell' | 'html'
}

const LANGUAGE_ALIASES: Record<string, ParsedCode['language']> = {
  js: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  py: 'python',
  python: 'python',
  sh: 'shell',
  shell: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  powershell: 'powershell',
  html: 'html',
  htm: 'html'
}

function normalizeLanguage(lang: string): ParsedCode['language'] {
  const normalized = lang.toLowerCase().trim()
  return LANGUAGE_ALIASES[normalized] || 'javascript'
}

function parseJsonFormat(content: string): ParsedCode | null {
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.code === 'string') {
        return {
          language: normalizeLanguage(parsed.language || 'javascript'),
          code: parsed.code
        }
      }
      if (typeof parsed.script === 'string') {
        return {
          language: normalizeLanguage(parsed.language || 'javascript'),
          code: parsed.script
        }
      }
    }
    return null
  } catch {
    return null
  }
}

function parseMarkdownCodeBlock(content: string): ParsedCode | null {
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/
  const match = content.match(codeBlockRegex)

  if (match) {
    const language = normalizeLanguage(match[1] || 'javascript')
    const code = match[2].trim()
    return { language, code }
  }

  return null
}

export function parseCode(content: string, options?: CodeExecutorOptions): ParsedCode {
  const trimmed = content.trim()

  const jsonResult = parseJsonFormat(trimmed)
  if (jsonResult) {
    return jsonResult
  }

  const markdownResult = parseMarkdownCodeBlock(trimmed)
  if (markdownResult) {
    return markdownResult
  }

  return {
    language: options?.defaultLanguage || 'javascript',
    code: trimmed
  }
}

export async function executeInSandbox(
  content: string,
  options?: CodeExecutorOptions
): Promise<ExecutionResult> {
  if (!executor) {
    return {
      success: false,
      error: 'Code executor not initialized. Call setExecutor() first.'
    }
  }

  const parsed = parseCode(content, options)

  if (parsed.language === 'html') {
    return {
      success: true,
      output: parsed.code,
      logs: ['HTML 内容已作为文本输出传递']
    }
  }

  return executor.executeChildProcess(parsed.language as SupportedLanguage, parsed.code, {
    timeout: options?.timeout
  })
}

export const codeExecutor = {
  parseCode,
  executeInSandbox
}
