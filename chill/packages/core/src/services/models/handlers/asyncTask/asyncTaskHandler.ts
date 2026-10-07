import type { ProtocolHandler, ProtocolHandlerContext } from '../../protocolHandler'
import type { Message, ToolDefinition, ModelConfig, ModelResponse } from '../../../../types/models'
import { normalizeBody } from '../../normalizeBody'
import { downloadFile } from '../../../../utils/downloadFile'
import { AttachmentManager } from '../../../attachmentManager'
import { eventBus, EVENTS } from '../../../../utils/eventBus'
import { generationFamilies, type GenerationFamilyConfig, type GenerationKind } from './generationFamilies'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * GenerationEngine：统一生成引擎（同步=轮询零次的异步）
 * 生命周期：buildBody → POST createPath → [pollPath 存在则轮询] → 取产物 → 落盘 → 返回
 * 家族差异 = generationFamilies.ts 里的纯数据注册项，新供应商 = 加一行数据。
 */

export type { GenerationFamilyConfig, GenerationKind } from './generationFamilies'
export { generationFamilies } from './generationFamilies'

/** 向后兼容：旧名别名 */
export type AsyncTaskFamilyConfig = GenerationFamilyConfig
export const asyncTaskFamilies = generationFamilies

/** 点路径 + 数组下标取值（content.video_url、video_result[0].url） */
function getByPath(obj: any, path: string): any {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}

const POLL_INTERVAL_MS = 5000
const TOTAL_TIMEOUT_MS = 10 * 60 * 1000
const DOWNLOAD_TIMEOUT_MS = 120000

const OUTPUT_TYPE_BY_KIND: Record<GenerationKind, 'image' | 'video' | 'audio'> = {
  'image-gen': 'image',
  'video-gen': 'video',
  'audio-gen': 'audio',
}

const FILE_NAME_BY_KIND: Record<GenerationKind, string> = {
  'image-gen': 'image.png',
  'video-gen': 'video.mp4',
  'audio-gen': 'audio.mp3',
}

/** 配置校验：poll 三字段全有或全无；同步家族必须有 response */
function validateFamily(family: GenerationFamilyConfig): void {
  const pollFields = [family.pollPath, family.statusField, family.statusValues]
  const hasAll = pollFields.every(Boolean)
  const hasNone = pollFields.every(f => !f)
  if (!hasAll && !hasNone) {
    throw new Error(`家族 ${family.protocol} 配置错误：pollPath/statusField/statusValues 必须全有或全无`)
  }
  if (hasNone && !family.response) {
    throw new Error(`同步家族 ${family.protocol} 缺少 response 产物提取配置`)
  }
}

function extractPrompt(messages: Message[]): string {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const userContent = lastUser?.content
  const prompt = typeof userContent === 'string'
    ? userContent
    : (Array.isArray(userContent) ? userContent.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : '')
  if (!prompt.trim()) throw new Error('生成任务需要非空 prompt')
  return prompt
}

async function saveArtifact(buffer: Buffer, family: GenerationFamilyConfig): Promise<string> {
  const fileId = await AttachmentManager.saveAttachment(buffer, FILE_NAME_BY_KIND[family.kind])
  return AttachmentManager.getAttachmentPath(fileId)
}

async function downloadToBuffer(url: string, ext: string): Promise<Buffer> {
  const tmp = mkdtempSync(join(tmpdir(), 'chill-gen-'))
  const tmpFile = join(tmp, 'result' + ext)
  try {
    await downloadFile(url, tmpFile, DOWNLOAD_TIMEOUT_MS)
    return readFileSync(tmpFile)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export async function runAsyncTask(
  family: GenerationFamilyConfig,
  messages: Message[],
  config: ModelConfig,
  adapterConfig: ProtocolHandlerContext['adapterConfig'],
): Promise<ModelResponse> {
  validateFamily(family)
  const prompt = extractPrompt(messages)

  const rawBody = family.buildBody
    ? family.buildBody(prompt, config, adapterConfig)
    : { model: config.model, prompt }
  const body = normalizeBody(rawBody, adapterConfig)
  const authHeaders = family.authStrategy
    ? family.authStrategy(config.apiKey)
    : { Authorization: `Bearer ${config.apiKey}` }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders,
    ...(family.headers || {}),
    ...(adapterConfig.headers || {}),
  }

  // createPath 占位替换（{voice}，如 ElevenLabs）
  const createPath = family.createPath.replace('{voice}', encodeURIComponent((config as any).voice ?? ''))

  const createResp = await fetch(`${adapterConfig.baseURL}${createPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!createResp.ok) {
    const text = await createResp.text().catch(() => '')
    throw new Error(`创建生成请求失败: HTTP ${createResp.status} ${text.slice(0, 300)}`)
  }

  // ===== 同步分支：pollPath 缺省，从 create 响应直接取产物 =====
  if (!family.pollPath) {
    const resp = family.response!
    let buffer: Buffer
    if (resp.kind === 'binary') {
      buffer = Buffer.from(await createResp.arrayBuffer())
    } else {
      const data: any = await createResp.json()
      if (resp.kind === 'jsonBase64') {
        const b64 = getByPath(data, resp.path!)
        if (!b64) throw new Error(`响应中未找到 base64 产物（${resp.path}）: ${JSON.stringify(data).slice(0, 200)}`)
        buffer = Buffer.from(String(b64), 'base64')
      } else if (resp.kind === 'jsonHex') {
        const hex = getByPath(data, resp.path!)
        if (!hex) throw new Error(`响应中未找到 hex 产物（${resp.path}）: ${JSON.stringify(data).slice(0, 200)}`)
        buffer = Buffer.from(String(hex), 'hex')
      } else if (resp.kind === 'jsonUrl') {
        const url = getByPath(data, resp.path!)
        if (!url) throw new Error(`响应中未找到产物 URL（${resp.path}）: ${JSON.stringify(data).slice(0, 200)}`)
        buffer = await downloadToBuffer(String(url), resp.ext)
      } else {
        // jsonB64OrUrl：先试 b64 再 url（OpenAI Images 双形态）
        const b64 = getByPath(data, resp.b64Path!)
        if (b64) {
          buffer = Buffer.from(String(b64), 'base64')
        } else {
          const url = getByPath(data, resp.urlPath!)
          if (!url) throw new Error(`响应既无 b64 也无 url: ${JSON.stringify(data).slice(0, 200)}`)
          buffer = await downloadToBuffer(String(url), resp.ext)
        }
      }
    }
    if (buffer.length === 0) throw new Error('生成响应产物为空')
    const filePath = await saveArtifact(buffer, family)
    const label = family.kind === 'image-gen' ? '图片' : family.kind === 'video-gen' ? '视频' : '音频'
    return {
      content: `${label}已生成并保存: ${filePath}`,
      output: { type: OUTPUT_TYPE_BY_KIND[family.kind], url: filePath } as any,
    }
  }

  // ===== 异步分支：轮询 =====
  const createData: any = await createResp.json()
  const taskId = getByPath(createData, family.idField!)
  if (!taskId) {
    throw new Error(`创建任务响应中未找到任务 id（${family.idField}）: ${JSON.stringify(createData).slice(0, 300)}`)
  }

  const start = Date.now()
  const pollUrl = `${adapterConfig.baseURL}${family.pollPath.replace('{id}', encodeURIComponent(taskId))}`
  for (;;) {
    const elapsedMs = Date.now() - start
    if (elapsedMs > TOTAL_TIMEOUT_MS) {
      return {
        content: `生成任务超时（已等待 ${Math.round(elapsedMs / 1000)}s），任务仍在进行中。任务 ID: ${taskId}（可稍后重试或查询）`,
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    eventBus.emit(EVENTS.GENERATION_PROGRESS, { kind: family.kind, elapsedSec: Math.round(elapsedMs / 1000), taskId })

    const pollResp = await fetch(pollUrl, { headers })
    if (!pollResp.ok) continue // 单次轮询失败忽略，继续等
    const pollData: any = await pollResp.json()
    const status = String(getByPath(pollData, family.statusField!) ?? '')

    if (status === family.statusValues!.succeeded) {
      const resultUrl = getByPath(pollData, family.resultUrlPath!)
      if (!resultUrl) {
        throw new Error(`任务成功但未找到结果 URL（${family.resultUrlPath}）: ${JSON.stringify(pollData).slice(0, 300)}`)
      }
      const ext = String(resultUrl).split('?')[0].match(/\.\w+$/)?.[0] ?? '.mp4'
      const buffer = await downloadToBuffer(String(resultUrl), ext)
      const filePath = await saveArtifact(buffer, family)
      return {
        content: `视频已生成并保存: ${filePath}`,
        output: { type: OUTPUT_TYPE_BY_KIND[family.kind], url: filePath } as any,
      }
    }
    const failedValues = Array.isArray(family.statusValues!.failed)
      ? family.statusValues!.failed
      : [family.statusValues!.failed]
    if (failedValues.includes(status)) {
      const reason = pollData?.failure_reason ?? pollData?.error ?? JSON.stringify(pollData).slice(0, 200)
      throw new Error(`生成任务失败: ${reason}`)
    }
    // running 状态：继续轮询
  }
}

/** 为家族创建 protocol handler 门面（引擎本体不进 protocolHandlers） */
export function createAsyncTaskFacade(family: GenerationFamilyConfig): ProtocolHandler {
  const outputModality = family.kind === 'image-gen' ? 'image' : family.kind === 'video-gen' ? 'video' : 'audio'
  return {
    capabilities: {
      chat: false,
      toolCalling: false,
      streaming: false,
      outputModalities: [outputModality],
      ...(family.pollPath ? { asyncTask: true } : {}),
    },
    call: async (
      messages: Message[],
      _tools: ToolDefinition[],
      config: ModelConfig,
      context: ProtocolHandlerContext,
    ): Promise<ModelResponse> => runAsyncTask(family, messages, config, context.adapterConfig),
  }
}

/** 将全部已注册家族的门面挂到 protocolHandlers（四入口调用） */
export function registerAsyncTaskFamilies(register: (protocol: string, handler: ProtocolHandler) => void): void {
  for (const family of Object.values(generationFamilies)) {
    register(family.protocol, createAsyncTaskFacade(family))
  }
}
