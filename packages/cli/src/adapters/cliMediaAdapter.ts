import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { AttachmentManager } from '@assistant-ai/core'
import type { MediaFileDescriptor, VideoStorageProvider } from '@assistant-ai/core'

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
}

export function pathToDescriptor(filePath: string): MediaFileDescriptor {
  const name = basename(filePath)
  const ext = extname(filePath).toLowerCase()
  const mimeType = MIME_MAP[ext] || 'application/octet-stream'
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
