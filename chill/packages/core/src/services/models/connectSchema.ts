/**
 * connect 参数 schema（唯一契约，单一事实源）
 *
 * 「添加模型 = connect」只有一份参数契约：Agent 工具（add_model 兼容包装）、UI 表单、
 * CLI 命令全部是它的投影——壳不得自造字段（V3）。字段集与 add_model 工具定义强制一致
 * （tests/services/connectService.test.ts 断言防漂移）。
 *
 * 契约只收用户事实：凭证 + 启用哪些身份 + 端点/厂商声明；能力/方言/显示名/本地注册名
 * 全是可派生元数据（能缺省就缺省）。`model_name`/`request_model` 是存量兼容投影
 * （add_model 旧语义不破坏），新用法优先 `models` + `api_model_id`。
 */

export const CONNECT_PARAM_SCHEMA = {
  type: 'object',
  properties: {
    provider: {
      type: 'string',
      description: '供应商名称或稳定 id，如 小米MiMo / Anthropic。归属标签由首次连接自动登记'
    },
    api_key: {
      type: 'string',
      description: '凭证（API Key）。该凭证域已有 Key 时可省略（自动复用，传入值忽略）；匿名域（本地模型）可不提供。注意同一供应商不同域（如按量 API 与 Token Plan）的 Key 不通用'
    },
    models: {
      type: 'array',
      items: { type: 'string' },
      description: '要启用的模型身份清单（上游真实 API 模型 ID，一次勾选多项）。GET /models 探测命中可直接勾选；未命中可显式填写 API 模型 ID（能力标 declared）'
    },
    api_model_id: {
      type: 'string',
      description: '上游真实 API 模型 ID（单身份简写，与 models 互补）。请求体 model 字段永远取它，本地注册名永不进请求'
    },
    base_url: {
      type: 'string',
      description: 'API 基础 URL。内置供应商可缺省——取该厂商端点模板；非内置供应商必填。key 形态已定域时端点缺省取该域规范端点'
    },
    protocol: {
      type: 'string',
      description: '协议方言，如 openai-chat、openai-image。内置供应商可缺省——随端点模板派生；非内置供应商必填。protocol 速查：文本对话=openai-chat；生图=openai-image；TTS=openai-tts；火山视频=volc-ark-video；智谱视频=cogvideo；万相视频=dashscope-video；万相图像=dashscope-image；Veo=google-lro-video；FLUX 异步生图=bfl-image'
    },
    credential_realm: {
      type: 'string',
      description: '显式独立凭证域（个别绑定需独立 Key 时表达独立域）；缺省由 key 形态/端点自动定域'
    },
    anonymous: {
      type: 'boolean',
      description: '匿名域声明（本地模型等无凭证端点）：跳过凭证写入与鉴权。缺省 false'
    },
    model_name: {
      type: 'string',
      description: '本地注册名（存量兼容投影）；缺省按 api_model_id 自动派生消歧（apiModelId@域slug），一般无需填写。须为文件名安全字符（禁 / \\ : * ? " < > | 与空白）'
    },
    display_name: {
      type: 'string',
      description: '显示名；缺省可派生（同身份多绑定自动拼装「身份 · 通道短名」）'
    },
    supported_modalities: {
      type: 'string',
      description: '支持的能力模态，多个用逗号分隔。可选值: text, image, audio, video, function_calling, json_mode, thinking_mode, reasoning_mode, context_continuation, fim_completion。缺省时按探测/目录/保守缺省收敛（来源标记 declared/probed/catalog）'
    },
    max_context_tokens: {
      type: 'number',
      description: '最大上下文 Token 数；缺省时按探测/目录/保守缺省收敛'
    },
    max_output_tokens: {
      type: 'number',
      description: '最大输出 Token 数；缺省时按探测/目录/保守缺省收敛'
    },
    supports_thinking: {
      type: 'boolean',
      description: '是否支持思考模式；缺省时按探测/目录/保守缺省收敛'
    },
    supports_streaming: {
      type: 'boolean',
      description: '是否支持流式输出，默认 true'
    },
    supports_tools: {
      type: 'boolean',
      description: '是否支持工具调用，默认 true'
    },
    temperature: {
      type: 'number',
      description: '默认 temperature，缺省 0.7。部分模型仅接受固定值（如 kimi-k3 仅允许 1），添加此类模型时必须显式指定'
    },
    fixed_params: {
      type: 'object',
      description: '硬约束：强制覆盖的请求参数，最后应用（用户 /config 也压不过）。如 kimi 系模型传 { "temperature": 1 }'
    },
    unsupported_params: {
      type: 'array',
      items: { type: 'string' },
      description: '硬约束：从请求体剔除的参数名列表（该模型不支持的参数）'
    },
    alias_models: {
      type: 'string',
      description: '别名模型（上游 ID）清单，多个用逗号分隔；进 availableModels 元数据'
    },
    request_model: {
      type: 'string',
      description: '（存量兼容）请求时发送给 API 的上游模型编码，语义已并入 api_model_id；缺省用 model_name。当注册名与 API 编码不同时使用'
    },
    description: {
      type: 'string',
      description: '模型描述'
    },
    version: {
      type: 'string',
      description: '模型版本号'
    },
    documentation: {
      type: 'string',
      description: '模型文档 URL'
    }
  },
  required: ['provider']
} as const

/** schema 字段集（供防漂移断言与 UI 对齐消费） */
export type ConnectParamName = keyof (typeof CONNECT_PARAM_SCHEMA)['properties']
