/**
 * 媒体处理（T2 上收，纯逻辑，渲染进程可安全导入）
 *
 * 两处现状逻辑的裁定版：
 * - 输入侧能力过滤（逻辑参考 CLI CliChatService.ts:215-240）：
 *   用户消息并入历史前，当前模型不支持的媒体块替换为占位符文本。
 * - 历史旧轮次占位符替换 + fileId→base64（逻辑参考 UI Home.vue:2207-2265）：
 *   发给模型前，仅最近 RECENT_ROUNDS 轮保留媒体内容，旧轮次替换为占位符；
 *   最近轮次的视频 fileId 经宿主注入的 MediaProvider 转换为 base64 data URL。
 */

import type { ContentPart, Message } from '../types/models'
import type { MediaProvider, ModelMediaCapabilities } from './types'

/** 保留完整媒体内容的最近轮次数（与 UI 现状一致：一轮按 user+assistant 两条计） */
const RECENT_ROUNDS = 2

/** 视频扩展名 → MIME 映射（UI 现状逻辑的迁移，provider 未给出 mimeType 时兜底） */
const VIDEO_MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
}

/** 输入侧能力过滤：当前模型不支持的图片/视频块替换为占位符文本（CLI 现状语义） */
export function filterInputContentParts(
  parts: ContentPart[],
  capabilities: ModelMediaCapabilities
): { parts: ContentPart[]; filtered: boolean } {
  let filtered = false
  const mapped = parts.map((part) => {
    if (part.type === 'image_url' && !capabilities.supportsImage) {
      filtered = true
      return { type: 'text' as const, text: '[图片]' }
    }
    if (part.type === 'video_url' && !capabilities.supportsVideo) {
      filtered = true
      return { type: 'text' as const, text: '[视频]' }
    }
    return part
  })
  return { parts: mapped, filtered }
}

/**
 * 历史消息发送前处理（不改动权威历史，返回新数组）：
 * - capabilities 缺省（模型能力未知）→ 原样透传（CLI 现状：无模型信息时不过滤）；
 * - 最近 RECENT_ROUNDS 轮：模型支持的媒体保留（视频 fileId 经 provider 转 base64），
 *   不支持的替换为占位符；
 * - 更早轮次：图片/视频一律替换为占位符文本。
 */
export async function prepareHistoryForSend(
  history: Message[],
  capabilities: ModelMediaCapabilities | undefined,
  mediaProvider?: MediaProvider,
  recentRounds: number = RECENT_ROUNDS
): Promise<Message[]> {
  if (!capabilities) {
    return history.map((m) => ({ ...m }))
  }

  const recentStartIndex = Math.max(0, history.length - recentRounds * 2)
  const prepared: Message[] = []

  for (let i = 0; i < history.length; i++) {
    const message = history[i]
    if (!Array.isArray(message.content)) {
      prepared.push({ ...message })
      continue
    }
    const isRecent = i >= recentStartIndex
    const newContent = await Promise.all(
      message.content.map(async (part) => {
        if (part.type === 'image_url') {
          // 只有最近轮次且模型支持图片时才保留，否则替换为占位符
          if (isRecent && capabilities.supportsImage) return part
          return { type: 'text' as const, text: '[图片]' }
        }
        if (part.type === 'video_url' && part.video_url?.url) {
          if (isRecent && capabilities.supportsVideo) {
            return await resolveVideoPart(part, mediaProvider)
          }
          return { type: 'text' as const, text: '[视频]' }
        }
        return part
      })
    )
    prepared.push({ ...message, content: newContent })
  }

  return prepared
}

/** 最近轮次的视频块：fileId 引用经 provider 转 base64 data URL；已是 data: 或转换失败保持原样 */
async function resolveVideoPart(part: ContentPart, mediaProvider?: MediaProvider): Promise<ContentPart> {
  const url = part.video_url?.url
  if (!url || url.startsWith('data:') || !mediaProvider) {
    return part
  }
  try {
    const result = await mediaProvider.readAsBase64(url)
    if (result?.base64) {
      const ext = url.split('.').pop()?.toLowerCase() || 'mp4'
      const mimeType = result.mimeType || VIDEO_MIME_TYPES[ext] || 'video/mp4'
      return { ...part, video_url: { url: `data:${mimeType};base64,${result.base64}` } }
    }
  } catch (error) {
    console.error('Failed to convert video fileId to base64:', error)
  }
  return part
}
