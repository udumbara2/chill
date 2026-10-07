import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { AttachmentManager, MEDIA_EXTENSIONS, parseMediaMentions, parseFileRefMentions, classifyFileRef, decideIntake, renderFileRefLine, renderInlineRef, renderLargeTextRef, buildContentParts, SPILL_PREVIEW_CHARS } from '@assistant-ai/core'
import type { ContentPart, MediaFileDescriptor, VideoStorageProvider } from '@assistant-ai/core'

/** 单文件体积护栏（防 base64 爆炸）；超限进 missing 不阻断发送 */
const MAX_MEDIA_BYTES = 20 * 1024 * 1024

export function pathToDescriptor(filePath: string): MediaFileDescriptor {
  const name = basename(filePath)
  const ext = extname(filePath).toLowerCase()
  const mimeType = MEDIA_EXTENSIONS[ext]?.mime || 'application/octet-stream'
  const fileBytes = readFileSync(filePath)

  return {
    name,
    mimeType,
    getBytes: async () => new Uint8Array(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength),
  }
}

export const cliVideoStorage: VideoStorageProvider = {
  save: async (name: string, bytes: Uint8Array): Promise<string> => {
    try {
      return await AttachmentManager.saveAttachment(Buffer.from(bytes), name)
    } catch {
      return ''
    }
  },
}

export interface ResolvedMediaMentions {
  /** 剔除已识别（且文件存在）mention 后的文本；missing 的 mention 保留在文本中（@ 提及统一降级规则） */
  text: string
  /** 有媒体命中时构建好的 contentParts（文本块在前），无媒体为 undefined */
  contentParts?: ContentPart[]
  /** 已成功附加的文件路径 */
  attached: string[]
  /** 提及了但不可用（不存在/超限）的文件 */
  missing: Array<{ path: string; reason: string }>
}

/**
 * 解析并落实 `@文件路径` 媒体提及（行模式/TUI/-p 三入口共用）：
 * core 纯词法解析 → 壳侧存在性/体积校验 + 读字节 → contentParts。
 * 文件不可用的 mention 不阻断：保留在文本中（模型有 fs 工具仍可行动），由调用方回显警告。
 */
/** 大文本预览：范围读头尾窗口（禁止整读——GB 级文件不得炸内存） */
function readTextHeadTail(filePath: string, size: number): { head: string; tail: string } {
  const W = SPILL_PREVIEW_CHARS
  const fd = openSync(filePath, 'r')
  try {
    const headBuf = Buffer.alloc(Math.min(W, size))
    readSync(fd, headBuf, 0, headBuf.length, 0)
    const tailBuf = Buffer.alloc(Math.min(W, size))
    readSync(fd, tailBuf, 0, tailBuf.length, Math.max(0, size - tailBuf.length))
    return { head: headBuf.toString('utf-8'), tail: tailBuf.toString('utf-8') }
  } finally {
    closeSync(fd)
  }
}

/**
 * 解析并落实 `@文件路径` 提及（行模式/TUI/-p 三入口共用）：
 * ①媒体提及（parseMediaMentions）→ 字节多模态 contentParts（现状不变）；
 * ②非媒体提及（parseFileRefMentions）→ 按 decideIntake 内联/引用（小文本内联、大文本头尾预览、其余 `[附件]` 行）。
 * missing 的 mention 不阻断：保留在文本中（模型有 fs 工具仍可行动），由调用方回显警告。
 */
export async function resolveMediaMentions(input: string): Promise<ResolvedMediaMentions> {
  const { text, mentions } = parseMediaMentions(input)
  const attached: string[] = []
  const missing: Array<{ path: string; reason: string }> = []
  const imageDescs: MediaFileDescriptor[] = []
  const videoDescs: MediaFileDescriptor[] = []
  // missing 的 mention 要保留回文本：从清理后文本出发逐个补回
  let finalText = text

  for (const m of mentions) {
    if (!existsSync(m.path)) {
      missing.push({ path: m.path, reason: '文件不存在' })
      finalText = `${finalText} ${m.raw}`.trim()
      continue
    }
    if (statSync(m.path).size > MAX_MEDIA_BYTES) {
      missing.push({ path: m.path, reason: '超过 20MB' })
      finalText = `${finalText} ${m.raw}`.trim()
      continue
    }
    const desc = pathToDescriptor(m.path)
    ;(m.kind === 'image' ? imageDescs : videoDescs).push(desc)
    attached.push(m.path)
  }

  // ②非媒体文件提及：文件引用管线（T3）——内联或引用渲染，固定拼在文本尾部
  const { text: textAfterFileParse, mentions: fileMentions } = parseFileRefMentions(finalText)
  finalText = textAfterFileParse
  const refBlocks: string[] = []
  for (const m of fileMentions) {
    if (!existsSync(m.path)) {
      missing.push({ path: m.path, reason: '文件不存在' })
      finalText = `${finalText} ${m.raw}`.trim()
      continue
    }
    const size = statSync(m.path).size
    const ref = classifyFileRef({ name: basename(m.path), path: m.path, size })
    try {
      if (decideIntake(ref) === 'inline') {
        refBlocks.push(renderInlineRef(ref, readFileSync(m.path, 'utf-8')))
      } else if (ref.kind === 'text') {
        const { head, tail } = readTextHeadTail(m.path, size)
        refBlocks.push(renderLargeTextRef(ref, head, tail))
      } else {
        refBlocks.push(renderFileRefLine(ref))
      }
      attached.push(m.path)
    } catch {
      missing.push({ path: m.path, reason: '读取失败' })
      refBlocks.push(renderFileRefLine(ref))
    }
  }
  if (refBlocks.length > 0) {
    finalText = finalText ? `${finalText}\n\n${refBlocks.join('\n\n')}` : refBlocks.join('\n\n')
  }

  const hasMedia = imageDescs.length > 0 || videoDescs.length > 0
  return {
    text: finalText,
    contentParts: hasMedia ? await buildContentParts(finalText, imageDescs, videoDescs, cliVideoStorage) : undefined,
    attached,
    missing,
  }
}
