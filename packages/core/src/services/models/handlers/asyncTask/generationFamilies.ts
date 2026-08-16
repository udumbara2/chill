/**
 * 生成家族统一注册表（纯数据，无 node 依赖——供引擎、deriveModelKind、UI renderer 共用）
 *
 * 同步家族：pollPath 缺省，create 响应直接取产物（response 配置）
 * 异步家族：pollPath 必填，轮询后从 poll 响应取产物（resultUrlPath）
 * 新供应商 = 在此加一行数据。
 */

export type GenerationKind = 'image-gen' | 'video-gen' | 'audio-gen'

export interface GenerationFamilyConfig {
  protocol: string
  /** 产物类型（→ ModelOutput.type 与 deriveModelKind 单一事实源） */
  kind: GenerationKind
  /** 创建请求路径（POST，拼在 baseURL 后；支持 {voice} 占位，如 ElevenLabs） */
  createPath: string
  /** 查询任务路径（GET，含 {id} 占位符）；同步家族缺省 */
  pollPath?: string
  /** create 响应中取任务 id 的字段（仅异步家族需要） */
  idField?: string
  /** poll 响应中取状态的字段（支持点路径；仅异步家族需要） */
  statusField?: string
  statusValues?: { succeeded: string; failed: string | string[]; running: string[] }
  /** poll 响应中取结果 URL 的路径（仅异步家族需要，支持点路径与数组下标） */
  resultUrlPath?: string
  /** 同步家族的产物提取配置（从 create 响应取） */
  response?: {
    kind: 'binary' | 'jsonBase64' | 'jsonUrl' | 'jsonB64OrUrl' | 'jsonHex'
    /** jsonBase64/jsonHex/jsonUrl 的取值路径（jsonB64OrUrl 用 b64Path/urlPath） */
    path?: string
    b64Path?: string
    urlPath?: string
    ext: string
  }
  /** 可选：自定义请求体构造（复杂形状时用；缺省为 { model, prompt }） */
  buildBody?: (prompt: string, config: any, adapterConfig?: any) => Record<string, any>
  /** 可选：认证策略（缺省 bearer） */
  authStrategy?: (apiKey: string) => Record<string, string>
  /** 可选：协议级固定请求头（如 DashScope 必带的 X-DashScope-Async: enable） */
  headers?: Record<string, string>
  /** 备注（待实测等标注用） */
  note?: string
}

export const generationFamilies: Record<string, GenerationFamilyConfig> = {
  // ===== 异步家族 =====
  cogvideo: {
    protocol: 'cogvideo',
    kind: 'video-gen',
    createPath: '/videos/generations',
    pollPath: '/async-result/{id}',
    idField: 'id',
    statusField: 'task_status',
    statusValues: { succeeded: 'SUCCESS', failed: 'FAIL', running: ['PROCESSING'] },
    resultUrlPath: 'video_result[0].url',
  },
  'volc-ark-video': {
    protocol: 'volc-ark-video',
    kind: 'video-gen',
    createPath: '/contents/generations/tasks',
    pollPath: '/contents/generations/tasks/{id}',
    idField: 'id',
    statusField: 'status',
    statusValues: { succeeded: 'succeeded', failed: 'failed', running: ['queued', 'running'] },
    resultUrlPath: 'content.video_url',
    buildBody: (prompt, config) => ({
      model: config.model,
      content: [{ type: 'text', text: prompt }],
      ...(config.duration !== undefined ? { duration: config.duration } : {}),
      ...(config.resolution ? { resolution: config.resolution } : {}),
    }),
  },
  'dashscope-video': {
    protocol: 'dashscope-video',
    kind: 'video-gen',
    createPath: '/services/aigc/video-generation/video-synthesis',
    pollPath: '/tasks/{id}',
    idField: 'output.task_id',
    statusField: 'output.task_status',
    statusValues: { succeeded: 'SUCCEEDED', failed: 'FAILED', running: ['PENDING', 'RUNNING'] },
    resultUrlPath: 'output.video_url',
    headers: { 'X-DashScope-Async': 'enable' },
    buildBody: (prompt, config) => ({
      model: config.model,
      input: { prompt },
      parameters: {
        ...(config.resolution ? { resolution: config.resolution } : {}),
        ...(config.ratio ? { ratio: config.ratio } : {}),
        ...(config.duration !== undefined ? { duration: config.duration } : {}),
      },
    }),
    note: '阿里百炼视频系（Happy Horse happyhorse-1.1-t2v / 万相 wan2.x）；X-DashScope-Async 头为协议级固定，已内置，用户无需配置',
  },
  'minimax-video': {
    protocol: 'minimax-video',
    kind: 'video-gen',
    createPath: '/v2/video_generation',
    pollPath: '/v2/query/video_generation/{id}',
    idField: 'task_id',
    statusField: 'task.status',
    statusValues: { succeeded: 'succeeded', failed: ['failed', 'cancelled', 'expired'], running: ['queued', 'running'] },
    resultUrlPath: 'task.content.url',
    buildBody: (prompt, config) => ({
      model: config.model,
      content: [{ type: 'text', text: prompt }],
      resolution: config.resolution ?? '2K',
      duration: config.duration ?? 5,
      ratio: config.ratio ?? '16:9',
    }),
    note: 'MiniMax H3（Hailuo-03）T2V，国内版 api.minimaxi.com；官方 docs/guides/video-generation；T2V 的 ratio 必填非 adaptive，兜底 16:9；2K 0.80 元/秒，视频资源包暂不支持 H3',
  },

  // ===== 同步家族 =====
  'openai-image': {
    protocol: 'openai-image',
    kind: 'image-gen',
    createPath: '/images/generations',
    response: { kind: 'jsonB64OrUrl', b64Path: 'data[0].b64_json', urlPath: 'data[0].url', ext: '.png' },
    buildBody: (prompt, config) => ({
      model: config.model,
      prompt,
      ...(config.size ? { size: config.size } : {}),
    }),
  },
  'openai-tts': {
    protocol: 'openai-tts',
    kind: 'audio-gen',
    createPath: '/audio/speech',
    response: { kind: 'binary', ext: '.mp3' },
    buildBody: (prompt, config) => ({
      model: config.model,
      input: prompt,
      response_format: 'mp3',
      ...(config.voice ? { voice: config.voice } : {}),
    }),
  },
  'elevenlabs-tts': {
    protocol: 'elevenlabs-tts',
    kind: 'audio-gen',
    createPath: '/v1/text-to-speech/{voice}',
    response: { kind: 'binary', ext: '.mp3' },
    buildBody: (prompt, config) => ({
      text: prompt,
      model_id: config.model,
    }),
    authStrategy: (apiKey) => ({ 'xi-api-key': apiKey }),
  },
  'google-tts': {
    protocol: 'google-tts',
    kind: 'audio-gen',
    createPath: '/v1/text:synthesize',
    response: { kind: 'jsonBase64', path: 'audioContent', ext: '.mp3' },
    buildBody: (prompt, config) => ({
      input: { text: prompt },
      voice: {
        languageCode: config.languageCode ?? 'cmn-CN',
        ...(config.voice ? { name: config.voice } : {}),
      },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  },
  'dashscope-tts': {
    protocol: 'dashscope-tts',
    kind: 'audio-gen',
    createPath: '/services/aigc/multimodal-generation/generation',
    response: { kind: 'jsonUrl', path: 'output.audio.url', ext: '.wav' },
    buildBody: (prompt, config) => ({
      model: config.model,
      input: {
        text: prompt,
        ...(config.voice ? { voice: config.voice } : {}),
        ...(config.language_type ? { language_type: config.language_type } : {}),
      },
    }),
    note: 'Qwen-TTS / MiniMax 托管系；SpeechSynthesizer 系（CosyVoice/Qwen-Audio-TTS）响应路径未证实，待实测后另补注册项',
  },
  'volcano-tts': {
    protocol: 'volcano-tts',
    kind: 'audio-gen',
    createPath: '/api/v1/tts',
    response: { kind: 'jsonBase64', path: 'data', ext: '.mp3' },
    buildBody: (prompt, config) => ({
      app: config.app ?? {},
      text: prompt,
      audio: {
        ...(config.voice ? { voice_type: config.voice } : {}),
        encoding: 'mp3',
      },
    }),
    note: '待实测：响应字段路径（data 是否为 base64 音频）与 app 字段构造未从官方文档逐字核实；自定义 auth 头经 adapterConfig.headers 传入',
  },
}
