import type { ContentPart } from '../types'

export interface MediaFileDescriptor {
  name: string
  mimeType: string
  getBytes(): Promise<Uint8Array>
}

export interface VideoStorageProvider {
  save(name: string, bytes: Uint8Array): Promise<string>
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export async function buildContentParts(
  text: string,
  imageFiles: MediaFileDescriptor[],
  videoFiles: MediaFileDescriptor[],
  videoStorage: VideoStorageProvider
): Promise<ContentPart[]> {
  const contentParts: ContentPart[] = []

  if (text.trim()) {
    contentParts.push({ type: 'text', text })
  }

  for (const img of imageFiles) {
    const bytes = await img.getBytes()
    const base64 = bytesToBase64(bytes)
    contentParts.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${base64}` }
    })
  }

  for (const vid of videoFiles) {
    const bytes = await vid.getBytes()
    const fileId = await videoStorage.save(vid.name, bytes)
    if (fileId) {
      contentParts.push({
        type: 'video_url',
        video_url: { url: fileId }
      })
    } else {
      const base64 = bytesToBase64(bytes)
      contentParts.push({
        type: 'video_url',
        video_url: { url: `data:${vid.mimeType};base64,${base64}` }
      })
    }
  }

  return contentParts
}
