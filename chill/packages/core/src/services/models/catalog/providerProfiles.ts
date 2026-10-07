/** 数据模块(原 providerProfiles.json 转换;vite/esbuild 不支持 import attribute,改 TS 数据模块,三端构建零障碍) */
const data = [
  {
    "id": "zhipu",
    "name": "智谱AI",
    "docUrl": "https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3",
    "endpoint": {
      "protocol": "openai-chat",
      "baseURL": "https://open.bigmodel.cn/api/paas/v4"
    },
    "constraints": {
      "extraBodyParams": { "tool_choice": "auto" }
    },
    "realms": [
      {
        "displayName": "按量付费",
        "endpoint": { "template": true }
      },
      {
        "displayName": "Coding Plan",
        "endpoint": { "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4" }
      }
    ]
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "docUrl": "https://api-docs.deepseek.com/zh-cn/",
    "endpoint": {
      "protocol": "openai-chat",
      "baseURL": "https://api.deepseek.com"
    }
  },
  {
    "id": "moonshot",
    "name": "Moonshot AI",
    "docUrl": "https://platform.moonshot.cn/docs",
    "endpoint": {
      "protocol": "openai-chat",
      "baseURL": "https://api.moonshot.cn/v1"
    },
    "constraints": {
      "fixedParams": { "temperature": 1 },
      "extraBodyParams": { "tool_choice": "auto" }
    }
  },
  {
    "id": "dashscope",
    "name": "阿里云百炼",
    "docUrl": "https://help.aliyun.com/zh/model-studio/qwen3-8-max",
    "endpoint": {
      "protocol": "openai-chat",
      "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1"
    }
  },
  {
    "id": "volcengine",
    "name": "火山方舟",
    "docUrl": "https://www.volcengine.com/docs/82379/1330310",
    "endpoint": {
      "protocol": "openai-chat",
      "baseURL": "https://ark.cn-beijing.volces.com/api/v3"
    }
  },
  {
    "id": "minimax",
    "name": "MiniMax",
    "docUrl": "https://platform.minimaxi.com/docs/guides/text-generation",
    "endpoint": {
      "protocol": "openai-chat",
      "baseURL": "https://api.minimaxi.com/v1"
    }
  },
  {
    "id": "xiaomi",
    "name": "小米MiMo",
    "docUrl": "https://mimo.mi.com/docs/zh-CN/api/chat/openai-api",
    "endpoint": {
      "protocol": "openai-chat",
      "baseURL": "https://api.xiaomimimo.com/v1"
    },
    "realms": [
      {
        "displayName": "按量付费",
        "endpoint": { "template": true },
        "keyPrefixHints": ["sk-"]
      },
      {
        "displayName": "Token Plan",
        "endpoint": { "baseURL": "https://token-plan-cn.xiaomimimo.com/v1" },
        "keyPrefixHints": ["tp-"]
      }
    ]
  }
]
export default data
