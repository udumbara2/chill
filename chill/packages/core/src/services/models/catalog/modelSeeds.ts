/** 数据模块(原 modelSeeds.json 转换;vite/esbuild 不支持 import attribute,改 TS 数据模块,三端构建零障碍) */
const data = [
  {
    "type": "glm",
    "name": "glm-5.3",
    "displayName": "GLM-5.3",
    "provider": "智谱AI",
    "builtIn": true,
    "description": "智谱AI最新旗舰模型，与5.2同基座经后训练强化，100万Token上下文，代码能力提升约50%，新增网络安全能力",
    "adapterConfig": {
      "defaultModel": "glm-5.3",
      "defaultMaxTokens": 128000,
      "defaultTemperature": 0.7,
      "unsupportedParams": ["thinking"]
    },
    "supportedModalities": [
      "text",
      "function_calling",
      "json_mode"
    ],
    "availableModels": [
      "glm-5.3"
    ],
    "supportedParameters": [
      {
        "name": "model",
        "type": "string",
        "description": "模型名称，使用\"glm-5.3\"",
        "required": true
      },
      {
        "name": "messages",
        "type": "array",
        "description": "对话消息列表",
        "required": true
      },
      {
        "name": "temperature",
        "type": "number",
        "description": "控制输出的随机性，范围0-2",
        "required": false,
        "defaultValue": 0.7
      },
      {
        "name": "top_p",
        "type": "number",
        "description": "核采样参数，替代temperature，范围0-1",
        "required": false,
        "defaultValue": 0.9
      },
      {
        "name": "max_tokens",
        "type": "number",
        "description": "生成token的最大数量，最大128K",
        "required": true,
        "defaultValue": 1024
      },
      {
        "name": "stream",
        "type": "boolean",
        "description": "是否启用流式输出",
        "required": false,
        "defaultValue": false
      },
      {
        "name": "stop",
        "type": "array",
        "description": "停止生成的token序列，最多4个",
        "required": false
      },
      {
        "name": "presence_penalty",
        "type": "number",
        "description": "存在惩罚，范围-2.0到2.0",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "frequency_penalty",
        "type": "number",
        "description": "频率惩罚，范围-2.0到2.0",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "tools",
        "type": "array",
        "description": "可用工具列表",
        "required": false
      },
      {
        "name": "tool_choice",
        "type": "string",
        "description": "工具选择策略",
        "required": false,
        "defaultValue": "auto"
      },
      {
        "name": "response_format",
        "type": "object",
        "description": "响应格式，如{\"type\": \"json_object\"}",
        "required": false
      },
      {
        "name": "reasoning_effort",
        "type": "string",
        "description": "思考强度档位 low/high/max；GLM-5.3 思考始终开启、不可关闭（thinking 参数不受支持，已从请求体剔除）",
        "required": false,
        "defaultValue": "max",
        "enumValues": ["low", "high", "max"]
      }
    ],
    "maxOutputTokens": 128000,
    "maxContextTokens": 1000000,
    "supportsStreaming": true,
    "supportsTools": true,
    "supportsThinking": true,
    "version": "5.3",
    "documentation": "https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3"
  },
  {
    "type": "deepseek",
    "name": "deepseek-flash",
    "displayName": "DeepSeek-V4.1-Flash",
    "provider": "DeepSeek",
    "builtIn": true,
    "description": "DeepSeek V4.1 Flash 模型，全新模型结构系列最小尺寸，原生多模态视觉理解，支持非思考与思考模式，1M 上下文",
    "adapterConfig": {
      "defaultModel": "deepseek-flash",
      "defaultMaxTokens": 196608,
      "defaultTemperature": 0.7
    },
    "supportedModalities": [
      "text",
      "image",
      "function_calling",
      "json_mode",
      "context_continuation",
      "fim_completion",
      "thinking_mode"
    ],
    "availableModels": [
      "deepseek-flash"
    ],
    "supportedParameters": [
      {
        "name": "model",
        "type": "string",
        "description": "模型名称",
        "required": true
      },
      {
        "name": "messages",
        "type": "array",
        "description": "消息列表",
        "required": true
      },
      {
        "name": "temperature",
        "type": "number",
        "description": "控制随机性，0-2之间（思考模式下不生效）",
        "required": false,
        "defaultValue": 0.7
      },
      {
        "name": "top_p",
        "type": "number",
        "description": "核采样，范围0-1之间（思考模式下不生效）",
        "required": false,
        "defaultValue": 0.9
      },
      {
        "name": "max_tokens",
        "type": "number",
        "description": "最大输出token数，最大384K",
        "required": true,
        "defaultValue": 196608
      },
      {
        "name": "stream",
        "type": "boolean",
        "description": "是否流式输出",
        "required": false,
        "defaultValue": false
      },
      {
        "name": "stop",
        "type": "array",
        "description": "停止生成的token序列，最多4个",
        "required": false
      },
      {
        "name": "presence_penalty",
        "type": "number",
        "description": "存在惩罚，范围-2.0到2.0（思考模式下不生效）",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "frequency_penalty",
        "type": "number",
        "description": "频率惩罚，范围-2.0到2.0（思考模式下不生效）",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "response_format",
        "type": "object",
        "description": "响应格式，如{\"type\": \"json_object\"}",
        "required": false
      },
      {
        "name": "tools",
        "type": "array",
        "description": "工具定义列表",
        "required": false
      },
      {
        "name": "tool_choice",
        "type": "string",
        "description": "工具选择策略",
        "required": false,
        "defaultValue": "auto"
      },
      {
        "name": "logit_bias",
        "type": "object",
        "description": "修改指定token出现的概率",
        "required": false
      },
      {
        "name": "thinking",
        "type": "object",
        "description": "思考模式开关：{\"type\": \"enabled\"} 或 {\"type\": \"disabled\"}（默认enabled）",
        "required": false
      },
      {
        "name": "reasoning_effort",
        "type": "string",
        "description": "思考强度：none 等同关闭思考，low/high/max 逐档增强（仅思考模式生效，默认 high）",
        "required": false,
        "defaultValue": "high",
        "enumValues": ["none", "low", "high", "max"]
      }
    ],
    "maxOutputTokens": 393216,
    "maxContextTokens": 1048576,
    "supportsStreaming": true,
    "supportsTools": true,
    "supportsThinking": true,
    "version": "v4.1-flash",
    "documentation": "https://api-docs.deepseek.com/zh-cn/"
  },
  {
    "type": "kimi-k2",
    "name": "kimi-k3",
    "displayName": "Kimi-K3",
    "provider": "Moonshot AI",
    "builtIn": true,
    "description": "Moonshot AI 最新旗舰模型，2.8T MoE参数，100万Token上下文窗口，支持多模态（文本+图片）、函数调用与思考模式，在长周期编程和知识工作方面达到前沿水平",
    "adapterConfig": {
      "defaultModel": "kimi-k3",
      "defaultMaxTokens": 131072,
      "defaultTemperature": 1,
      "unsupportedParams": ["thinking"]
    },
    "supportedModalities": [
      "text",
      "image",
      "function_calling",
      "json_mode",
      "thinking_mode"
    ],
    "availableModels": [
      "kimi-k3",
      "kimi-k2.7-code"
    ],
    "supportedParameters": [
      {
        "name": "model",
        "type": "string",
        "description": "模型名称",
        "required": true
      },
      {
        "name": "messages",
        "type": "array",
        "description": "消息列表",
        "required": true
      },
      {
        "name": "temperature",
        "type": "number",
        "description": "控制随机性，K3仅支持1.0，固定为1",
        "required": false,
        "defaultValue": 1
      },
      {
        "name": "max_tokens",
        "type": "number",
        "description": "最大输出token数，最大128K",
        "required": true,
        "defaultValue": 131072
      },
      {
        "name": "top_p",
        "type": "number",
        "description": "另一种采样方法，默认0.9，范围0-1",
        "required": false,
        "defaultValue": 0.9
      },
      {
        "name": "n",
        "type": "number",
        "description": "生成结果数量，默认1，最大5",
        "required": false,
        "defaultValue": 1
      },
      {
        "name": "presence_penalty",
        "type": "number",
        "description": "存在惩罚，-2.0到2.0之间，默认0",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "frequency_penalty",
        "type": "number",
        "description": "频率惩罚，-2.0到2.0之间，默认0",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "response_format",
        "type": "object",
        "description": "响应格式，默认{\"type\": \"text\"}",
        "required": false,
        "defaultValue": {
          "type": "text"
        }
      },
      {
        "name": "stop",
        "type": "array",
        "description": "停止词，最多5个字符串",
        "required": false,
        "defaultValue": null
      },
      {
        "name": "stream",
        "type": "boolean",
        "description": "是否流式输出",
        "required": false,
        "defaultValue": false
      },
      {
        "name": "tools",
        "type": "array",
        "description": "工具定义列表",
        "required": false,
        "defaultValue": null
      },
      {
        "name": "tool_choice",
        "type": "string",
        "description": "控制模型何时调用工具",
        "required": false,
        "defaultValue": "auto"
      },
      {
        "name": "reasoning_effort",
        "type": "string",
        "description": "思考强度档位 low/high/max；K3 始终思考、无法关闭（thinking 参数不受支持，已从请求体剔除）",
        "required": false,
        "defaultValue": "max",
        "enumValues": ["low", "high", "max"]
      }
    ],
    "maxOutputTokens": 131072,
    "maxContextTokens": 1048576,
    "supportsStreaming": true,
    "supportsTools": true,
    "supportsThinking": true,
    "version": "k3",
    "documentation": "https://platform.moonshot.cn/docs"
  },
  {
    "type": "kimi-k2",
    "name": "kimi-k2.7-code",
    "displayName": "Kimi-K2.7-Code",
    "description": "Kimi 迄今最智能的 Coding 模型，在长上下文中更可靠地遵循指令，能以更高的成功率完成编程任务",
    "provider": "Moonshot AI",
    "builtIn": true,
    "adapterConfig": {
      "defaultModel": "kimi-k2.7-code",
      "defaultMaxTokens": 8000,
      "defaultTemperature": 1
    },
    "supportedModalities": [
      "text",
      "image",
      "function_calling",
      "json_mode"
    ],
    "availableModels": [
      "kimi-k3",
      "kimi-k2.7-code"
    ],
    "supportedParameters": [
      {
        "name": "model",
        "type": "string",
        "description": "模型名称",
        "required": true
      },
      {
        "name": "messages",
        "type": "array",
        "description": "消息列表",
        "required": true
      },
      {
        "name": "temperature",
        "type": "number",
        "description": "控制随机性，Code模型仅支持1.0，固定为1",
        "required": false,
        "defaultValue": 1
      },
      {
        "name": "max_tokens",
        "type": "number",
        "description": "最大输出token数，最大65,536",
        "required": true,
        "defaultValue": 8192
      },
      {
        "name": "top_p",
        "type": "number",
        "description": "另一种采样方法，默认0.9，范围0-1",
        "required": false,
        "defaultValue": 0.9
      },
      {
        "name": "n",
        "type": "number",
        "description": "生成结果数量，默认1，最大5",
        "required": false,
        "defaultValue": 1
      },
      {
        "name": "presence_penalty",
        "type": "number",
        "description": "存在惩罚，-2.0到2.0之间，默认0",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "frequency_penalty",
        "type": "number",
        "description": "频率惩罚，-2.0到2.0之间，默认0",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "response_format",
        "type": "object",
        "description": "响应格式，默认{\"type\": \"text\"}",
        "required": false,
        "defaultValue": {
          "type": "text"
        }
      },
      {
        "name": "stop",
        "type": "array",
        "description": "停止词，最多5个字符串",
        "required": false,
        "defaultValue": null
      },
      {
        "name": "stream",
        "type": "boolean",
        "description": "是否流式输出",
        "required": false,
        "defaultValue": false
      },
      {
        "name": "tools",
        "type": "array",
        "description": "工具定义列表",
        "required": false,
        "defaultValue": null
      },
      {
        "name": "tool_choice",
        "type": "string",
        "description": "控制模型何时调用工具",
        "required": false,
        "defaultValue": "auto"
      }
    ],
    "maxOutputTokens": 65536,
    "maxContextTokens": 262144,
    "supportsStreaming": true,
    "supportsTools": true,
    "supportsThinking": false,
    "version": "2.7-code",
    "documentation": "https://platform.moonshot.cn/docs"
  },
  {
    "type": "custom",
    "name": "qwen3.8-max",
    "displayName": "Qwen3.8-Max",
    "provider": "阿里云百炼",
    "builtIn": true,
    "description": "阿里云百炼 Qwen3.8 旗舰模型，原生多模态（文本/图像/视频输入），100万Token上下文，支持深度思考、函数调用与结构化输出",
    "adapterConfig": {
      "defaultModel": "qwen3.8-max",
      "defaultMaxTokens": 131072,
      "defaultTemperature": 0.7,
      "unsupportedParams": ["thinking"]
    },
    "supportedModalities": [
      "text",
      "image",
      "function_calling",
      "json_mode",
      "thinking_mode"
    ],
    "availableModels": [
      "qwen3.8-max",
      "qwen3.8-2.4t-a95b"
    ],
    "supportedParameters": [
      {
        "name": "model",
        "type": "string",
        "description": "模型名称，使用\"qwen3.8-max\"",
        "required": true
      },
      {
        "name": "messages",
        "type": "array",
        "description": "对话消息列表",
        "required": true
      },
      {
        "name": "temperature",
        "type": "number",
        "description": "控制输出的随机性，范围0-2",
        "required": false,
        "defaultValue": 0.7
      },
      {
        "name": "top_p",
        "type": "number",
        "description": "核采样参数，范围0-1",
        "required": false,
        "defaultValue": 0.9
      },
      {
        "name": "max_tokens",
        "type": "number",
        "description": "生成token的最大数量，最大131072",
        "required": true,
        "defaultValue": 131072
      },
      {
        "name": "stream",
        "type": "boolean",
        "description": "是否启用流式输出",
        "required": false,
        "defaultValue": false
      },
      {
        "name": "stop",
        "type": "array",
        "description": "停止生成的token序列",
        "required": false
      },
      {
        "name": "presence_penalty",
        "type": "number",
        "description": "存在惩罚，范围-2.0到2.0",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "frequency_penalty",
        "type": "number",
        "description": "频率惩罚，范围-2.0到2.0",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "response_format",
        "type": "object",
        "description": "响应格式，如{\"type\": \"json_object\"}",
        "required": false
      },
      {
        "name": "tools",
        "type": "array",
        "description": "可用工具列表",
        "required": false
      },
      {
        "name": "tool_choice",
        "type": "string",
        "description": "工具选择策略",
        "required": false,
        "defaultValue": "auto"
      },
      {
        "name": "enable_thinking",
        "type": "boolean",
        "description": "思考模式开关（Qwen系参数）",
        "required": false
      },
      {
        "name": "reasoning_effort",
        "type": "string",
        "description": "思考强度档位 low/medium/xhigh（与 thinking_budget 互斥，本卡只暴露档位）",
        "required": false,
        "defaultValue": "xhigh",
        "enumValues": ["low", "medium", "xhigh"]
      }
    ],
    "maxOutputTokens": 131072,
    "maxContextTokens": 1000000,
    "supportsStreaming": true,
    "supportsTools": true,
    "supportsThinking": true,
    "version": "3.8-max",
    "documentation": "https://help.aliyun.com/zh/model-studio/qwen3-8-max"
  },
  {
    "type": "custom",
    "name": "qwen3.8-2.4t-a95b",
    "displayName": "Qwen3.8-2.4T-A95B",
    "provider": "阿里云百炼",
    "builtIn": true,
    "description": "Qwen3.8 开源同源版本，2.4T MoE 参数（激活950亿），文本输入，100万Token上下文，支持思考模式、函数调用与结构化输出",
    "adapterConfig": {
      "defaultModel": "qwen3.8-2.4t-a95b",
      "defaultMaxTokens": 131072,
      "defaultTemperature": 0.7,
      "unsupportedParams": ["thinking"]
    },
    "supportedModalities": [
      "text",
      "function_calling",
      "json_mode",
      "thinking_mode"
    ],
    "availableModels": [
      "qwen3.8-max",
      "qwen3.8-2.4t-a95b"
    ],
    "supportedParameters": [
      {
        "name": "model",
        "type": "string",
        "description": "模型名称，使用\"qwen3.8-2.4t-a95b\"",
        "required": true
      },
      {
        "name": "messages",
        "type": "array",
        "description": "对话消息列表",
        "required": true
      },
      {
        "name": "temperature",
        "type": "number",
        "description": "控制输出的随机性，范围0-2",
        "required": false,
        "defaultValue": 0.7
      },
      {
        "name": "top_p",
        "type": "number",
        "description": "核采样参数，范围0-1",
        "required": false,
        "defaultValue": 0.9
      },
      {
        "name": "max_tokens",
        "type": "number",
        "description": "生成token的最大数量，最大131072",
        "required": true,
        "defaultValue": 131072
      },
      {
        "name": "stream",
        "type": "boolean",
        "description": "是否启用流式输出",
        "required": false,
        "defaultValue": false
      },
      {
        "name": "stop",
        "type": "array",
        "description": "停止生成的token序列",
        "required": false
      },
      {
        "name": "presence_penalty",
        "type": "number",
        "description": "存在惩罚，范围-2.0到2.0",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "frequency_penalty",
        "type": "number",
        "description": "频率惩罚，范围-2.0到2.0",
        "required": false,
        "defaultValue": 0
      },
      {
        "name": "response_format",
        "type": "object",
        "description": "响应格式，如{\"type\": \"json_object\"}",
        "required": false
      },
      {
        "name": "tools",
        "type": "array",
        "description": "可用工具列表",
        "required": false
      },
      {
        "name": "tool_choice",
        "type": "string",
        "description": "工具选择策略",
        "required": false,
        "defaultValue": "auto"
      },
      {
        "name": "reasoning_effort",
        "type": "string",
        "description": "思考强度档位 low/medium/xhigh；该模型仅支持思考模式（不可关闭）",
        "required": false,
        "defaultValue": "xhigh",
        "enumValues": ["low", "medium", "xhigh"]
      }
    ],
    "maxOutputTokens": 131072,
    "maxContextTokens": 1000000,
    "supportsStreaming": true,
    "supportsTools": true,
    "supportsThinking": true,
    "version": "3.8-2.4t-a95b",
    "documentation": "https://help.aliyun.com/zh/model-studio/qwen3-8-2-4t-a95b"
  },
  {
    "type": "custom",
    "name": "doubao-seed-2-1-pro-260628",
    "displayName": "Doubao-Seed-2.1-Pro",
    "provider": "火山方舟",
    "builtIn": true,
    "description": "火山方舟豆包 Seed 2.1 旗舰 Coding Agent 模型，256K上下文，视觉理解与深度思考，适合复杂编程与长链路Agent任务",
    "adapterConfig": {
      "defaultModel": "doubao-seed-2-1-pro-260628",
      "defaultMaxTokens": 32768,
      "defaultTemperature": 0.7
    },
    "supportedModalities": [
      "text",
      "image",
      "function_calling",
      "json_mode",
      "thinking_mode"
    ],
    "availableModels": [
      "doubao-seed-2-1-pro-260628",
      "doubao-seed-2-1-turbo-260628",
      "doubao-seed-2-0-pro-260215",
      "doubao-seed-2-0-lite-260428",
      "doubao-seed-2-0-mini-260428"
    ],
    "supportedParameters": [
      {
        "name": "model",
        "type": "string",
        "description": "模型名称，使用\"doubao-seed-2-1-pro-260628\"",
        "required": true
      },
      {
        "name": "messages",
        "type": "array",
        "description": "对话消息列表",
        "required": true
      },
      {
        "name": "temperature",
        "type": "number",
        "description": "控制输出的随机性，范围0-2",
        "required": false,
        "defaultValue": 0.7
      },
      {
        "name": "top_p",
        "type": "number",
        "description": "核采样参数，范围0-1",
        "required": false,
        "defaultValue": 0.9
      },
      {
        "name": "max_tokens",
        "type": "number",
        "description": "生成token的最大数量，最大256000",
        "required": true,
        "defaultValue": 32768
      },
      {
        "name": "stream",
        "type": "boolean",
        "description": "是否启用流式输出",
        "required": false,
        "defaultValue": false
      },
      {
        "name": "stop",
        "type": "array",
        "description": "停止生成的token序列",
        "required": false
      },
      {
        "name": "response_format",
        "type": "object",
        "description": "响应格式，如{\"type\": \"json_object\"}",
        "required": false
      },
      {
        "name": "tools",
        "type": "array",
        "description": "可用工具列表",
        "required": false
      },
      {
        "name": "tool_choice",
        "type": "string",
        "description": "工具选择策略",
        "required": false,
        "defaultValue": "auto"
      },
      {
        "name": "thinking",
        "type": "object",
        "description": "深度思考开关，如{\"type\": \"enabled\"}",
        "required": false
      },
      {
        "name": "reasoning_effort",
        "type": "string",
        "description": "思考强度档位 low/medium/high（minimal 及以下等同关闭思考）",
        "required": false,
        "defaultValue": "high",
        "enumValues": ["low", "medium", "high"]
      }
    ],
    "maxOutputTokens": 256000,
    "maxContextTokens": 256000,
    "supportsStreaming": true,
    "supportsTools": true,
    "supportsThinking": true,
    "version": "seed-2.1-pro",
    "documentation": "https://www.volcengine.com/docs/82379/1330310"
  },
  {
    "type": "custom",
    "name": "doubao-seed-2-1-turbo-260628",
    "displayName": "Doubao-Seed-2.1-Turbo",
    "provider": "火山方舟",
    "builtIn": true,
    "description": "火山方舟豆包 Seed 2.1 均衡版，256K上下文，效果与成本兼顾，编程、智能体与多模态能力全面升级，适合规模化生产场景",
    "adapterConfig": {
      "defaultModel": "doubao-seed-2-1-turbo-260628",
      "defaultMaxTokens": 32768,
      "defaultTemperature": 0.7
    },
    "supportedModalities": [
      "text",
      "image",
      "function_calling",
      "json_mode",
      "thinking_mode"
    ],
    "availableModels": [
      "doubao-seed-2-1-pro-260628",
      "doubao-seed-2-1-turbo-260628",
      "doubao-seed-2-0-pro-260215",
      "doubao-seed-2-0-lite-260428",
      "doubao-seed-2-0-mini-260428"
    ],
    "supportedParameters": [
      {
        "name": "model",
        "type": "string",
        "description": "模型名称，使用\"doubao-seed-2-1-turbo-260628\"",
        "required": true
      },
      {
        "name": "messages",
        "type": "array",
        "description": "对话消息列表",
        "required": true
      },
      {
        "name": "temperature",
        "type": "number",
        "description": "控制输出的随机性，范围0-2",
        "required": false,
        "defaultValue": 0.7
      },
      {
        "name": "top_p",
        "type": "number",
        "description": "核采样参数，范围0-1",
        "required": false,
        "defaultValue": 0.9
      },
      {
        "name": "max_tokens",
        "type": "number",
        "description": "生成token的最大数量，最大256000",
        "required": true,
        "defaultValue": 32768
      },
      {
        "name": "stream",
        "type": "boolean",
        "description": "是否启用流式输出",
        "required": false,
        "defaultValue": false
      },
      {
        "name": "stop",
        "type": "array",
        "description": "停止生成的token序列",
        "required": false
      },
      {
        "name": "response_format",
        "type": "object",
        "description": "响应格式，如{\"type\": \"json_object\"}",
        "required": false
      },
      {
        "name": "tools",
        "type": "array",
        "description": "可用工具列表",
        "required": false
      },
      {
        "name": "tool_choice",
        "type": "string",
        "description": "工具选择策略",
        "required": false,
        "defaultValue": "auto"
      },
      {
        "name": "thinking",
        "type": "object",
        "description": "深度思考开关，如{\"type\": \"enabled\"}",
        "required": false
      },
      {
        "name": "reasoning_effort",
        "type": "string",
        "description": "思考强度档位 low/medium/high（minimal 及以下等同关闭思考）",
        "required": false,
        "defaultValue": "high",
        "enumValues": ["low", "medium", "high"]
      }
    ],
    "maxOutputTokens": 256000,
    "maxContextTokens": 256000,
    "supportsStreaming": true,
    "supportsTools": true,
    "supportsThinking": true,
    "version": "seed-2.1-turbo",
    "documentation": "https://www.volcengine.com/docs/82379/1330310"
  },
  {
    "type": "custom",
    "name": "MiniMax-M3",
    "displayName": "MiniMax-M3",
    "provider": "MiniMax",
    "builtIn": true,
    "description": "MiniMax 旗舰模型，428B参数（激活23B），原生多模态（文本+图像输入），100万Token上下文，默认开启思考，支持函数调用与结构化输出",
    "adapterConfig": {
      "defaultModel": "MiniMax-M3",
      "defaultMaxTokens": 131072,
      "defaultTemperature": 0.7,
      "unsupportedParams": ["thinking"]
    },
    "supportedModalities": [
      "text",
      "image",
      "function_calling",
      "json_mode",
      "thinking_mode"
    ],
    "availableModels": [
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2"
    ],
    "supportedParameters": [
      {
        "name": "model",
        "type": "string",
        "description": "模型名称，使用\"MiniMax-M3\"",
        "required": true
      },
      {
        "name": "messages",
        "type": "array",
        "description": "对话消息列表",
        "required": true
      },
      {
        "name": "temperature",
        "type": "number",
        "description": "控制输出的随机性，范围0-2",
        "required": false,
        "defaultValue": 0.7
      },
      {
        "name": "top_p",
        "type": "number",
        "description": "核采样参数，范围0-1",
        "required": false,
        "defaultValue": 0.9
      },
      {
        "name": "max_tokens",
        "type": "number",
        "description": "生成token的最大数量，最大524288",
        "required": true,
        "defaultValue": 131072
      },
      {
        "name": "stream",
        "type": "boolean",
        "description": "是否启用流式输出",
        "required": false,
        "defaultValue": false
      },
      {
        "name": "stop",
        "type": "array",
        "description": "停止生成的token序列",
        "required": false
      },
      {
        "name": "response_format",
        "type": "object",
        "description": "响应格式，如{\"type\": \"json_object\"}",
        "required": false
      },
      {
        "name": "tools",
        "type": "array",
        "description": "可用工具列表",
        "required": false
      },
      {
        "name": "tool_choice",
        "type": "string",
        "description": "工具选择策略",
        "required": false,
        "defaultValue": "auto"
      }
    ],
    "maxOutputTokens": 524288,
    "maxContextTokens": 1048576,
    "supportsStreaming": true,
    "supportsTools": true,
    "supportsThinking": true,
    "version": "M3",
    "documentation": "https://platform.minimaxi.com/docs/guides/text-generation"
  },
  {
    "type": "custom",
    "name": "mimo-v2.6-pro",
    "displayName": "MiMo-V2.6-Pro",
    "provider": "小米MiMo",
    "builtIn": true,
    "description": "小米最新万亿参数旗舰（MoE 1.02T/激活42B），全模态理解：文本/图像/视频/音频输入，1M Token上下文，MIT开源，AA综合智能指数超越Kimi-K3与Qwen3.8-Max，Agent能力比肩国际旗舰",
    "adapterConfig": {
      "defaultModel": "mimo-v2.6-pro",
      "defaultMaxTokens": 131072,
      "defaultTemperature": 0.7
    },
    "supportedModalities": [
      "text",
      "image",
      "audio",
      "video",
      "function_calling",
      "json_mode",
      "thinking_mode"
    ],
    "availableModels": [
      "mimo-v2.6-pro",
      "mimo-v2.6-flash"
    ],
    "supportedParameters": [
      {
        "name": "model",
        "type": "string",
        "description": "模型名称，使用\"mimo-v2.6-pro\"",
        "required": true
      },
      {
        "name": "messages",
        "type": "array",
        "description": "对话消息列表",
        "required": true
      },
      {
        "name": "temperature",
        "type": "number",
        "description": "控制随机性，范围0-2（思考模式下服务端强制为1.0）",
        "required": false,
        "defaultValue": 0.7
      },
      {
        "name": "top_p",
        "type": "number",
        "description": "核采样参数，范围0-1（思考模式下服务端强制为0.95）",
        "required": false,
        "defaultValue": 0.9
      },
      {
        "name": "max_tokens",
        "type": "number",
        "description": "生成token的最大数量（思考与回答共享配额），最大131072",
        "required": true,
        "defaultValue": 131072
      },
      {
        "name": "stream",
        "type": "boolean",
        "description": "是否启用流式输出",
        "required": false,
        "defaultValue": false
      },
      {
        "name": "response_format",
        "type": "object",
        "description": "响应格式，如{\"type\": \"json_object\"}",
        "required": false
      },
      {
        "name": "tools",
        "type": "array",
        "description": "可用工具列表",
        "required": false
      },
      {
        "name": "tool_choice",
        "type": "string",
        "description": "工具选择策略（仅支持 auto，其余取值会被服务端移除）",
        "required": false,
        "defaultValue": "auto"
      },
      {
        "name": "thinking",
        "type": "object",
        "description": "深度思考开关：{\"type\": \"enabled\"}或{\"type\": \"disabled\"}（默认enabled；仅开/关两态，无强度档位）",
        "required": false
      }
    ],
    "maxOutputTokens": 131072,
    "maxContextTokens": 1048576,
    "supportsStreaming": true,
    "supportsTools": true,
    "supportsThinking": true,
    "version": "v2.6-pro",
    "documentation": "https://mimo.mi.com/models/zh-CN/mimo-v2.6-pro"
  },
  {
    "type": "custom",
    "name": "mimo-v2.6-flash",
    "displayName": "MiMo-V2.6-Flash",
    "provider": "小米MiMo",
    "builtIn": true,
    "description": "小米全模态高性价比模型（MoE 309B/激活15B），文本/图像/视频/音频输入，1M Token上下文，MIT开源，高频调用的均衡之选",
    "adapterConfig": {
      "defaultModel": "mimo-v2.6-flash",
      "defaultMaxTokens": 131072,
      "defaultTemperature": 0.7
    },
    "supportedModalities": [
      "text",
      "image",
      "audio",
      "video",
      "function_calling",
      "json_mode",
      "thinking_mode"
    ],
    "availableModels": [
      "mimo-v2.6-pro",
      "mimo-v2.6-flash"
    ],
    "supportedParameters": [
      {
        "name": "model",
        "type": "string",
        "description": "模型名称，使用\"mimo-v2.6-flash\"",
        "required": true
      },
      {
        "name": "messages",
        "type": "array",
        "description": "对话消息列表",
        "required": true
      },
      {
        "name": "temperature",
        "type": "number",
        "description": "控制随机性，范围0-2（思考模式下服务端强制为1.0）",
        "required": false,
        "defaultValue": 0.7
      },
      {
        "name": "top_p",
        "type": "number",
        "description": "核采样参数，范围0-1（思考模式下服务端强制为0.95）",
        "required": false,
        "defaultValue": 0.9
      },
      {
        "name": "max_tokens",
        "type": "number",
        "description": "生成token的最大数量（思考与回答共享配额），最大131072",
        "required": true,
        "defaultValue": 131072
      },
      {
        "name": "stream",
        "type": "boolean",
        "description": "是否启用流式输出",
        "required": false,
        "defaultValue": false
      },
      {
        "name": "response_format",
        "type": "object",
        "description": "响应格式，如{\"type\": \"json_object\"}",
        "required": false
      },
      {
        "name": "tools",
        "type": "array",
        "description": "可用工具列表",
        "required": false
      },
      {
        "name": "tool_choice",
        "type": "string",
        "description": "工具选择策略（仅支持 auto，其余取值会被服务端移除）",
        "required": false,
        "defaultValue": "auto"
      },
      {
        "name": "thinking",
        "type": "object",
        "description": "深度思考开关：{\"type\": \"enabled\"}或{\"type\": \"disabled\"}（默认enabled；仅开/关两态，无强度档位）",
        "required": false
      }
    ],
    "maxOutputTokens": 131072,
    "maxContextTokens": 1048576,
    "supportsStreaming": true,
    "supportsTools": true,
    "supportsThinking": true,
    "version": "v2.6-flash",
    "documentation": "https://mimo.mi.com/models/zh-CN/mimo-v2.6-flash"
  }
]
export default data
