import { ModelType, ModelModality, ParameterType, type ModelInfo } from '../../types/models';
import type { ISecureStorage } from '../../interfaces/ISecureStorage';
import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider';
import { providerManager } from './providerManager';
import * as path from 'path';

/**
 * 模型信息服务类
 * 负责存储和管理所有模型的信息
 *
 * 数据所有权划分（每份数据只有一个所有者）：
 * - 内置模型定义 = 代码所有：启动时从 getBuiltInSeedModels() 种子加载，不落盘、不读盘；
 *   版本演进（新增/改名/参数修正/退役）下次启动自动对齐。
 * - 自定义模型 = 用户所有：仅存 modelsDir 下的 *.json（builtIn:false）。
 * 内存始终为合并视图（种子内置 ∪ 磁盘自定义），消费方单一代码路径不变。
 */
export class ModelInfoService {
  private static instance: ModelInfoService;
  private modelInfos: Map<string, ModelInfo> = new Map();
  private secureStorage: ISecureStorage | null = null;
  private fileSystemProvider: IFileSystemProvider | null = null;
  private modelsDir: string = '';

  private constructor() {
    // 不在构造时加载模型，modelsDir 和 fileSystemProvider 尚未就绪
    // 由 loadAllModels() 在外部调用方就绪后统一加载
  }

  /**
   * 获取服务单例实例
   */
  static getInstance(): ModelInfoService {
    if (!ModelInfoService.instance) {
      ModelInfoService.instance = new ModelInfoService();
    }
    return ModelInfoService.instance;
  }

  setSecureStorage(storage: ISecureStorage): void {
    this.secureStorage = storage;
  }

  /**
   * 设置文件系统提供者，用于持久化自定义模型
   */
  setFileSystemProvider(provider: IFileSystemProvider): void {
    this.fileSystemProvider = provider;
  }

  /**
   * 设置模型存储目录
   */
  setModelsDir(dirPath: string): void {
    this.modelsDir = dirPath;
  }

  /**
   * 获取内置模型种子数据
   */
  static getBuiltInSeedModels(): ModelInfo[] {
    return [
      {
        type: ModelType.GLM,
        name: 'glm-5.3',
        displayName: 'GLM-5.3',
        provider: '智谱AI',
        builtIn: true,
        description: '智谱AI最新旗舰模型，与5.2同基座经后训练强化，100万Token上下文，代码能力提升约50%，新增网络安全能力',
        adapterConfig: { protocol: 'openai-chat', baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.3', defaultMaxTokens: 128000, defaultTemperature: 0.7, extraBodyParams: { tool_choice: 'auto' } },
        supportedModalities: [ModelModality.TEXT, ModelModality.FUNCTION_CALLING, ModelModality.JSON_MODE],
        apiURL: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        availableModels: ['glm-5.3'],
        supportedParameters: [
          { name: 'model', type: ParameterType.STRING, description: '模型名称，使用"glm-5.3"', required: true },
          { name: 'messages', type: ParameterType.ARRAY, description: '对话消息列表', required: true },
          { name: 'temperature', type: ParameterType.NUMBER, description: '控制输出的随机性，范围0-2', required: false, defaultValue: 0.7 },
          { name: 'top_p', type: ParameterType.NUMBER, description: '核采样参数，替代temperature，范围0-1', required: false, defaultValue: 0.9 },
          { name: 'max_tokens', type: ParameterType.NUMBER, description: '生成token的最大数量，最大128K', required: true, defaultValue: 1024 },
          { name: 'stream', type: ParameterType.BOOLEAN, description: '是否启用流式输出', required: false, defaultValue: false },
          { name: 'stop', type: ParameterType.ARRAY, description: '停止生成的token序列，最多4个', required: false },
          { name: 'presence_penalty', type: ParameterType.NUMBER, description: '存在惩罚，范围-2.0到2.0', required: false, defaultValue: 0 },
          { name: 'frequency_penalty', type: ParameterType.NUMBER, description: '频率惩罚，范围-2.0到2.0', required: false, defaultValue: 0 },
          { name: 'tools', type: ParameterType.ARRAY, description: '可用工具列表', required: false },
          { name: 'tool_choice', type: ParameterType.STRING, description: '工具选择策略', required: false, defaultValue: 'auto' },
          { name: 'response_format', type: ParameterType.OBJECT, description: '响应格式，如{"type": "json_object"}', required: false },
          { name: 'thinking', type: ParameterType.OBJECT, description: '深度思考配置，如{"type": "enabled"}或{"type": "disabled"}', required: false }
        ],
        maxOutputTokens: 128000,
        maxContextTokens: 1000000,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        version: '5.3',
        documentation: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3'
      },
      {
        type: ModelType.DEEPSEEK,
        name: 'deepseek-v4-flash',
        displayName: 'DeepSeek-V4-Flash',
        provider: 'DeepSeek',
        builtIn: true,
        description: 'DeepSeek V4 Flash模型，经济高效，支持非思考与思考模式，1M上下文',
        adapterConfig: { protocol: 'openai-chat', baseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-flash', defaultMaxTokens: 196608, defaultTemperature: 0.7 },
        supportedModalities: [ModelModality.TEXT, ModelModality.FUNCTION_CALLING, ModelModality.JSON_MODE, ModelModality.CONTEXT_CONTINUATION, ModelModality.FIM_COMPLETION, ModelModality.THINKING_MODE],
        apiURL: 'https://api.deepseek.com/chat/completions',
        availableModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        supportedParameters: [
          { name: 'model', type: ParameterType.STRING, description: '模型名称', required: true },
          { name: 'messages', type: ParameterType.ARRAY, description: '消息列表', required: true },
          { name: 'temperature', type: ParameterType.NUMBER, description: '控制随机性，0-2之间（思考模式下不生效）', required: false, defaultValue: 0.7 },
          { name: 'top_p', type: ParameterType.NUMBER, description: '核采样，范围0-1之间（思考模式下不生效）', required: false, defaultValue: 0.9 },
          { name: 'max_tokens', type: ParameterType.NUMBER, description: '最大输出token数，最大384K', required: true, defaultValue: 196608 },
          { name: 'stream', type: ParameterType.BOOLEAN, description: '是否流式输出', required: false, defaultValue: false },
          { name: 'stop', type: ParameterType.ARRAY, description: '停止生成的token序列，最多4个', required: false },
          { name: 'presence_penalty', type: ParameterType.NUMBER, description: '存在惩罚，范围-2.0到2.0（思考模式下不生效）', required: false, defaultValue: 0 },
          { name: 'frequency_penalty', type: ParameterType.NUMBER, description: '频率惩罚，范围-2.0到2.0（思考模式下不生效）', required: false, defaultValue: 0 },
          { name: 'response_format', type: ParameterType.OBJECT, description: '响应格式，如{"type": "json_object"}', required: false },
          { name: 'tools', type: ParameterType.ARRAY, description: '工具定义列表', required: false },
          { name: 'tool_choice', type: ParameterType.STRING, description: '工具选择策略', required: false, defaultValue: 'auto' },
          { name: 'logit_bias', type: ParameterType.OBJECT, description: '修改指定token出现的概率', required: false },
          { name: 'thinking', type: ParameterType.OBJECT, description: '思考模式开关：{"type": "enabled"} 或 {"type": "disabled"}（默认enabled）', required: false },
          { name: 'reasoning_effort', type: ParameterType.STRING, description: '思考强度：high 或 max（仅思考模式生效）', required: false }
        ],
        maxOutputTokens: 393216,
        maxContextTokens: 1048576,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        version: 'v4-flash',
        documentation: 'https://api-docs.deepseek.com/zh-cn/'
      },
      {
        type: ModelType.DEEPSEEK,
        name: 'deepseek-v4-pro',
        displayName: 'DeepSeek-V4-Pro',
        provider: 'DeepSeek',
        builtIn: true,
        description: 'DeepSeek V4 Pro模型，性能强劲，支持非思考与思考模式，1M上下文',
        adapterConfig: { protocol: 'openai-chat', baseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-pro', defaultMaxTokens: 196608, defaultTemperature: 0.7 },
        supportedModalities: [ModelModality.TEXT, ModelModality.FUNCTION_CALLING, ModelModality.JSON_MODE, ModelModality.CONTEXT_CONTINUATION, ModelModality.FIM_COMPLETION, ModelModality.THINKING_MODE],
        apiURL: 'https://api.deepseek.com/chat/completions',
        availableModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        supportedParameters: [
          { name: 'model', type: ParameterType.STRING, description: '模型名称', required: true },
          { name: 'messages', type: ParameterType.ARRAY, description: '消息列表', required: true },
          { name: 'temperature', type: ParameterType.NUMBER, description: '控制随机性，0-2之间（思考模式下不生效）', required: false, defaultValue: 0.7 },
          { name: 'top_p', type: ParameterType.NUMBER, description: '核采样，范围0-1之间（思考模式下不生效）', required: false, defaultValue: 0.9 },
          { name: 'max_tokens', type: ParameterType.NUMBER, description: '最大输出token数，最大384K', required: true, defaultValue: 4096 },
          { name: 'stream', type: ParameterType.BOOLEAN, description: '是否流式输出', required: false, defaultValue: false },
          { name: 'stop', type: ParameterType.ARRAY, description: '停止生成的token序列，最多4个', required: false },
          { name: 'presence_penalty', type: ParameterType.NUMBER, description: '存在惩罚，范围-2.0到2.0（思考模式下不生效）', required: false, defaultValue: 0 },
          { name: 'frequency_penalty', type: ParameterType.NUMBER, description: '频率惩罚，范围-2.0到2.0（思考模式下不生效）', required: false, defaultValue: 0 },
          { name: 'response_format', type: ParameterType.OBJECT, description: '响应格式，如{"type": "json_object"}', required: false },
          { name: 'tools', type: ParameterType.ARRAY, description: '工具定义列表', required: false },
          { name: 'tool_choice', type: ParameterType.STRING, description: '工具选择策略', required: false, defaultValue: 'auto' },
          { name: 'logit_bias', type: ParameterType.OBJECT, description: '修改指定token出现的概率', required: false },
          { name: 'thinking', type: ParameterType.OBJECT, description: '思考模式开关：{"type": "enabled"} 或 {"type": "disabled"}（默认enabled）', required: false },
          { name: 'reasoning_effort', type: ParameterType.STRING, description: '思考强度：high 或 max（仅思考模式生效）', required: false }
        ],
        maxOutputTokens: 393216,
        maxContextTokens: 1048576,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        version: 'v4-pro',
        documentation: 'https://api-docs.deepseek.com/zh-cn/'
      },
      {
        type: ModelType.KIMI_K2,
        name: 'kimi-k3',
        displayName: 'Kimi-K3',
        provider: 'Moonshot AI',
        builtIn: true,
        description: 'Moonshot AI 最新旗舰模型，2.8T MoE参数，100万Token上下文窗口，支持多模态（文本+图片）、函数调用与思考模式，在长周期编程和知识工作方面达到前沿水平',
        adapterConfig: { protocol: 'openai-chat', baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k3', defaultMaxTokens: 131072, defaultTemperature: 1, extraBodyParams: { tool_choice: 'auto' }, fixedParams: { temperature: 1 } },
        supportedModalities: [ModelModality.TEXT, ModelModality.IMAGE, ModelModality.FUNCTION_CALLING, ModelModality.JSON_MODE, ModelModality.THINKING_MODE],
        apiURL: 'https://api.moonshot.cn/v1/chat/completions',
        availableModels: ['kimi-k3', 'kimi-k2.7-code'],
        supportedParameters: [
          { name: 'model', type: ParameterType.STRING, description: '模型名称', required: true },
          { name: 'messages', type: ParameterType.ARRAY, description: '消息列表', required: true },
          { name: 'temperature', type: ParameterType.NUMBER, description: '控制随机性，K3仅支持1.0，固定为1', required: false, defaultValue: 1 },
          { name: 'max_tokens', type: ParameterType.NUMBER, description: '最大输出token数，最大128K', required: true, defaultValue: 131072 },
          { name: 'top_p', type: ParameterType.NUMBER, description: '另一种采样方法，默认0.9，范围0-1', required: false, defaultValue: 0.9 },
          { name: 'n', type: ParameterType.NUMBER, description: '生成结果数量，默认1，最大5', required: false, defaultValue: 1 },
          { name: 'presence_penalty', type: ParameterType.NUMBER, description: '存在惩罚，-2.0到2.0之间，默认0', required: false, defaultValue: 0 },
          { name: 'frequency_penalty', type: ParameterType.NUMBER, description: '频率惩罚，-2.0到2.0之间，默认0', required: false, defaultValue: 0 },
          { name: 'response_format', type: ParameterType.OBJECT, description: '响应格式，默认{"type": "text"}', required: false, defaultValue: {"type": "text"} },
          { name: 'stop', type: ParameterType.ARRAY, description: '停止词，最多5个字符串', required: false, defaultValue: null },
          { name: 'stream', type: ParameterType.BOOLEAN, description: '是否流式输出', required: false, defaultValue: false },
          { name: 'tools', type: ParameterType.ARRAY, description: '工具定义列表', required: false, defaultValue: null },
          { name: 'tool_choice', type: ParameterType.STRING, description: '控制模型何时调用工具', required: false, defaultValue: 'auto' }
        ],
        maxOutputTokens: 131072,
        maxContextTokens: 1048576,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        version: 'k3',
        documentation: 'https://platform.moonshot.cn/docs'
      },
      {
        type: ModelType.KIMI_K2,
        name: 'kimi-k2.7-code',
        displayName: 'Kimi-K2.7-Code',
        description: 'Kimi 迄今最智能的 Coding 模型，在长上下文中更可靠地遵循指令，能以更高的成功率完成编程任务',
        provider: 'Moonshot AI',
        builtIn: true,
        adapterConfig: { protocol: 'openai-chat', baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k2.7-code', defaultMaxTokens: 8000, defaultTemperature: 1, extraBodyParams: { tool_choice: 'auto' }, fixedParams: { temperature: 1 } },
        supportedModalities: [ModelModality.TEXT, ModelModality.IMAGE, ModelModality.FUNCTION_CALLING, ModelModality.JSON_MODE],
        apiURL: 'https://api.moonshot.cn/v1/chat/completions',
        availableModels: ['kimi-k3', 'kimi-k2.7-code'],
        supportedParameters: [
          { name: 'model', type: ParameterType.STRING, description: '模型名称', required: true },
          { name: 'messages', type: ParameterType.ARRAY, description: '消息列表', required: true },
          { name: 'temperature', type: ParameterType.NUMBER, description: '控制随机性，Code模型仅支持1.0，固定为1', required: false, defaultValue: 1 },
          { name: 'max_tokens', type: ParameterType.NUMBER, description: '最大输出token数，最大65,536', required: true, defaultValue: 8192 },
          { name: 'top_p', type: ParameterType.NUMBER, description: '另一种采样方法，默认0.9，范围0-1', required: false, defaultValue: 0.9 },
          { name: 'n', type: ParameterType.NUMBER, description: '生成结果数量，默认1，最大5', required: false, defaultValue: 1 },
          { name: 'presence_penalty', type: ParameterType.NUMBER, description: '存在惩罚，-2.0到2.0之间，默认0', required: false, defaultValue: 0 },
          { name: 'frequency_penalty', type: ParameterType.NUMBER, description: '频率惩罚，-2.0到2.0之间，默认0', required: false, defaultValue: 0 },
          { name: 'response_format', type: ParameterType.OBJECT, description: '响应格式，默认{"type": "text"}', required: false, defaultValue: {"type": "text"} },
          { name: 'stop', type: ParameterType.ARRAY, description: '停止词，最多5个字符串', required: false, defaultValue: null },
          { name: 'stream', type: ParameterType.BOOLEAN, description: '是否流式输出', required: false, defaultValue: false },
          { name: 'tools', type: ParameterType.ARRAY, description: '工具定义列表', required: false, defaultValue: null },
          { name: 'tool_choice', type: ParameterType.STRING, description: '控制模型何时调用工具', required: false, defaultValue: 'auto' }
        ],
        maxOutputTokens: 65536,
        maxContextTokens: 262144,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: false,
        version: '2.7-code',
        documentation: 'https://platform.moonshot.cn/docs'
      },
      {
        type: ModelType.CUSTOM,
        name: 'qwen3.8-max',
        displayName: 'Qwen3.8-Max',
        provider: '阿里云百炼',
        builtIn: true,
        description: '阿里云百炼 Qwen3.8 旗舰模型，原生多模态（文本/图像/视频输入），100万Token上下文，支持深度思考、函数调用与结构化输出',
        adapterConfig: { protocol: 'openai-chat', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen3.8-max', defaultMaxTokens: 131072, defaultTemperature: 0.7 },
        supportedModalities: [ModelModality.TEXT, ModelModality.IMAGE, ModelModality.FUNCTION_CALLING, ModelModality.JSON_MODE, ModelModality.THINKING_MODE],
        apiURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        availableModels: ['qwen3.8-max', 'qwen3.8-2.4t-a95b'],
        supportedParameters: [
          { name: 'model', type: ParameterType.STRING, description: '模型名称，使用"qwen3.8-max"', required: true },
          { name: 'messages', type: ParameterType.ARRAY, description: '对话消息列表', required: true },
          { name: 'temperature', type: ParameterType.NUMBER, description: '控制输出的随机性，范围0-2', required: false, defaultValue: 0.7 },
          { name: 'top_p', type: ParameterType.NUMBER, description: '核采样参数，范围0-1', required: false, defaultValue: 0.9 },
          { name: 'max_tokens', type: ParameterType.NUMBER, description: '生成token的最大数量，最大131072', required: true, defaultValue: 131072 },
          { name: 'stream', type: ParameterType.BOOLEAN, description: '是否启用流式输出', required: false, defaultValue: false },
          { name: 'stop', type: ParameterType.ARRAY, description: '停止生成的token序列', required: false },
          { name: 'presence_penalty', type: ParameterType.NUMBER, description: '存在惩罚，范围-2.0到2.0', required: false, defaultValue: 0 },
          { name: 'frequency_penalty', type: ParameterType.NUMBER, description: '频率惩罚，范围-2.0到2.0', required: false, defaultValue: 0 },
          { name: 'response_format', type: ParameterType.OBJECT, description: '响应格式，如{"type": "json_object"}', required: false },
          { name: 'tools', type: ParameterType.ARRAY, description: '可用工具列表', required: false },
          { name: 'tool_choice', type: ParameterType.STRING, description: '工具选择策略', required: false, defaultValue: 'auto' },
          { name: 'enable_thinking', type: ParameterType.BOOLEAN, description: '思考模式开关（Qwen系参数）', required: false }
        ],
        maxOutputTokens: 131072,
        maxContextTokens: 1000000,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        version: '3.8-max',
        documentation: 'https://help.aliyun.com/zh/model-studio/qwen3-8-max'
      },
      {
        type: ModelType.CUSTOM,
        name: 'qwen3.8-2.4t-a95b',
        displayName: 'Qwen3.8-2.4T-A95B',
        provider: '阿里云百炼',
        builtIn: true,
        description: 'Qwen3.8 开源同源版本，2.4T MoE 参数（激活950亿），文本输入，100万Token上下文，支持思考模式、函数调用与结构化输出',
        adapterConfig: { protocol: 'openai-chat', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen3.8-2.4t-a95b', defaultMaxTokens: 131072, defaultTemperature: 0.7 },
        supportedModalities: [ModelModality.TEXT, ModelModality.FUNCTION_CALLING, ModelModality.JSON_MODE, ModelModality.THINKING_MODE],
        apiURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        availableModels: ['qwen3.8-max', 'qwen3.8-2.4t-a95b'],
        supportedParameters: [
          { name: 'model', type: ParameterType.STRING, description: '模型名称，使用"qwen3.8-2.4t-a95b"', required: true },
          { name: 'messages', type: ParameterType.ARRAY, description: '对话消息列表', required: true },
          { name: 'temperature', type: ParameterType.NUMBER, description: '控制输出的随机性，范围0-2', required: false, defaultValue: 0.7 },
          { name: 'top_p', type: ParameterType.NUMBER, description: '核采样参数，范围0-1', required: false, defaultValue: 0.9 },
          { name: 'max_tokens', type: ParameterType.NUMBER, description: '生成token的最大数量，最大131072', required: true, defaultValue: 131072 },
          { name: 'stream', type: ParameterType.BOOLEAN, description: '是否启用流式输出', required: false, defaultValue: false },
          { name: 'stop', type: ParameterType.ARRAY, description: '停止生成的token序列', required: false },
          { name: 'presence_penalty', type: ParameterType.NUMBER, description: '存在惩罚，范围-2.0到2.0', required: false, defaultValue: 0 },
          { name: 'frequency_penalty', type: ParameterType.NUMBER, description: '频率惩罚，范围-2.0到2.0', required: false, defaultValue: 0 },
          { name: 'response_format', type: ParameterType.OBJECT, description: '响应格式，如{"type": "json_object"}', required: false },
          { name: 'tools', type: ParameterType.ARRAY, description: '可用工具列表', required: false },
          { name: 'tool_choice', type: ParameterType.STRING, description: '工具选择策略', required: false, defaultValue: 'auto' },
          { name: 'enable_thinking', type: ParameterType.BOOLEAN, description: '思考模式开关（Qwen系参数）', required: false }
        ],
        maxOutputTokens: 131072,
        maxContextTokens: 1000000,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        version: '3.8-2.4t-a95b',
        documentation: 'https://help.aliyun.com/zh/model-studio/qwen3-8-2-4t-a95b'
      },
      {
        type: ModelType.CUSTOM,
        name: 'doubao-seed-2-1-pro-260628',
        displayName: 'Doubao-Seed-2.1-Pro',
        provider: '火山方舟',
        builtIn: true,
        description: '火山方舟豆包 Seed 2.1 旗舰 Coding Agent 模型，256K上下文，视觉理解与深度思考，适合复杂编程与长链路Agent任务',
        adapterConfig: { protocol: 'openai-chat', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-seed-2-1-pro-260628', defaultMaxTokens: 32768, defaultTemperature: 0.7 },
        supportedModalities: [ModelModality.TEXT, ModelModality.IMAGE, ModelModality.FUNCTION_CALLING, ModelModality.JSON_MODE, ModelModality.THINKING_MODE],
        apiURL: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
        availableModels: ['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-lite-260428', 'doubao-seed-2-0-mini-260428'],
        supportedParameters: [
          { name: 'model', type: ParameterType.STRING, description: '模型名称，使用"doubao-seed-2-1-pro-260628"', required: true },
          { name: 'messages', type: ParameterType.ARRAY, description: '对话消息列表', required: true },
          { name: 'temperature', type: ParameterType.NUMBER, description: '控制输出的随机性，范围0-2', required: false, defaultValue: 0.7 },
          { name: 'top_p', type: ParameterType.NUMBER, description: '核采样参数，范围0-1', required: false, defaultValue: 0.9 },
          { name: 'max_tokens', type: ParameterType.NUMBER, description: '生成token的最大数量，最大256000', required: true, defaultValue: 32768 },
          { name: 'stream', type: ParameterType.BOOLEAN, description: '是否启用流式输出', required: false, defaultValue: false },
          { name: 'stop', type: ParameterType.ARRAY, description: '停止生成的token序列', required: false },
          { name: 'response_format', type: ParameterType.OBJECT, description: '响应格式，如{"type": "json_object"}', required: false },
          { name: 'tools', type: ParameterType.ARRAY, description: '可用工具列表', required: false },
          { name: 'tool_choice', type: ParameterType.STRING, description: '工具选择策略', required: false, defaultValue: 'auto' },
          { name: 'thinking', type: ParameterType.OBJECT, description: '深度思考开关，如{"type": "enabled"}', required: false }
        ],
        maxOutputTokens: 256000,
        maxContextTokens: 256000,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        version: 'seed-2.1-pro',
        documentation: 'https://www.volcengine.com/docs/82379/1330310'
      },
      {
        type: ModelType.CUSTOM,
        name: 'doubao-seed-2-1-turbo-260628',
        displayName: 'Doubao-Seed-2.1-Turbo',
        provider: '火山方舟',
        builtIn: true,
        description: '火山方舟豆包 Seed 2.1 均衡版，256K上下文，效果与成本兼顾，编程、智能体与多模态能力全面升级，适合规模化生产场景',
        adapterConfig: { protocol: 'openai-chat', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-seed-2-1-turbo-260628', defaultMaxTokens: 32768, defaultTemperature: 0.7 },
        supportedModalities: [ModelModality.TEXT, ModelModality.IMAGE, ModelModality.FUNCTION_CALLING, ModelModality.JSON_MODE, ModelModality.THINKING_MODE],
        apiURL: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
        availableModels: ['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-lite-260428', 'doubao-seed-2-0-mini-260428'],
        supportedParameters: [
          { name: 'model', type: ParameterType.STRING, description: '模型名称，使用"doubao-seed-2-1-turbo-260628"', required: true },
          { name: 'messages', type: ParameterType.ARRAY, description: '对话消息列表', required: true },
          { name: 'temperature', type: ParameterType.NUMBER, description: '控制输出的随机性，范围0-2', required: false, defaultValue: 0.7 },
          { name: 'top_p', type: ParameterType.NUMBER, description: '核采样参数，范围0-1', required: false, defaultValue: 0.9 },
          { name: 'max_tokens', type: ParameterType.NUMBER, description: '生成token的最大数量，最大256000', required: true, defaultValue: 32768 },
          { name: 'stream', type: ParameterType.BOOLEAN, description: '是否启用流式输出', required: false, defaultValue: false },
          { name: 'stop', type: ParameterType.ARRAY, description: '停止生成的token序列', required: false },
          { name: 'response_format', type: ParameterType.OBJECT, description: '响应格式，如{"type": "json_object"}', required: false },
          { name: 'tools', type: ParameterType.ARRAY, description: '可用工具列表', required: false },
          { name: 'tool_choice', type: ParameterType.STRING, description: '工具选择策略', required: false, defaultValue: 'auto' },
          { name: 'thinking', type: ParameterType.OBJECT, description: '深度思考开关，如{"type": "enabled"}', required: false }
        ],
        maxOutputTokens: 256000,
        maxContextTokens: 256000,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        version: 'seed-2.1-turbo',
        documentation: 'https://www.volcengine.com/docs/82379/1330310'
      },
      {
        type: ModelType.CUSTOM,
        name: 'MiniMax-M3',
        displayName: 'MiniMax-M3',
        provider: 'MiniMax',
        builtIn: true,
        description: 'MiniMax 旗舰模型，428B参数（激活23B），原生多模态（文本+图像输入），100万Token上下文，默认开启思考，支持函数调用与结构化输出',
        adapterConfig: { protocol: 'openai-chat', baseURL: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-M3', defaultMaxTokens: 131072, defaultTemperature: 0.7 },
        supportedModalities: [ModelModality.TEXT, ModelModality.IMAGE, ModelModality.FUNCTION_CALLING, ModelModality.JSON_MODE, ModelModality.THINKING_MODE],
        apiURL: 'https://api.minimaxi.com/v1/chat/completions',
        availableModels: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2'],
        supportedParameters: [
          { name: 'model', type: ParameterType.STRING, description: '模型名称，使用"MiniMax-M3"', required: true },
          { name: 'messages', type: ParameterType.ARRAY, description: '对话消息列表', required: true },
          { name: 'temperature', type: ParameterType.NUMBER, description: '控制输出的随机性，范围0-2', required: false, defaultValue: 0.7 },
          { name: 'top_p', type: ParameterType.NUMBER, description: '核采样参数，范围0-1', required: false, defaultValue:0.9 },
          { name: 'max_tokens', type: ParameterType.NUMBER, description: '生成token的最大数量，最大524288', required: true, defaultValue: 131072 },
          { name: 'stream', type: ParameterType.BOOLEAN, description: '是否启用流式输出', required: false, defaultValue: false },
          { name: 'stop', type: ParameterType.ARRAY, description: '停止生成的token序列', required: false },
          { name: 'response_format', type: ParameterType.OBJECT, description: '响应格式，如{"type": "json_object"}', required: false },
          { name: 'tools', type: ParameterType.ARRAY, description: '可用工具列表', required: false },
          { name: 'tool_choice', type: ParameterType.STRING, description: '工具选择策略', required: false, defaultValue: 'auto' }
        ],
        maxOutputTokens: 524288,
        maxContextTokens: 1048576,
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        version: 'M3',
        documentation: 'https://platform.minimaxi.com/docs/guides/text-generation'
      }
    ];
  }

  /**
   * 初始化模型信息（将种子数据加载到内存 Map）
   */
  private initializeModelInfos(): void {
    const seedModels = ModelInfoService.getBuiltInSeedModels();
    for (const model of seedModels) {
      this.modelInfos.set(model.name, model);
    }
  }

  /**
   * 列出 models 目录下的模型 JSON 文件（排除 providers.json）
   */
  private async listModelJsonFiles(dir: string): Promise<{ name: string }[]> {
    const listResult = await this.fileSystemProvider!.listDirectory(dir);
    if (!listResult.success || !listResult.data) return [];
    let entries: { name: string }[] = [];
    if (Array.isArray(listResult.data)) {
      entries = listResult.data.map((f: any) => (typeof f === 'string' ? { name: f } : f));
    } else if (listResult.data.files) {
      entries = listResult.data.files;
    }
    return entries.filter((e: { name: string }) =>
      e.name.endsWith('.json') && e.name !== 'providers.json'
    );
  }

  /**
   * 读取并解析单个模型 JSON，失败返回 undefined
   */
  private async readModelJson(dir: string, name: string): Promise<ModelInfo | undefined> {
    const readResult = await this.fileSystemProvider!.readFile(path.join(dir, name));
    if (!readResult.success || !readResult.data) return undefined;
    try {
      const content = typeof readResult.data === 'string'
        ? readResult.data
        : readResult.data.content || '';
      return JSON.parse(content) as ModelInfo;
    } catch (e) {
      console.error(`解析模型文件 ${name} 失败:`, e);
      return undefined;
    }
  }

  /**
   * 内置文件迁移（幂等）：旧版本曾把内置种子播种到磁盘，那些文件是过时快照。
   * - builtIn:true 且名称在当前种子里 → 删除（内容本就是代码副本，种子接管）
   * - builtIn:true 且名称已不在种子里 → 以 builtIn:false 重写保留
   *   （退役 = 所有权移交用户；直接删除会让 state.json 中选中它的用户报「模型未注册」）
   * - builtIn:false → 用户数据，不动
   */
  private async migrateBuiltInFiles(dir: string): Promise<void> {
    const seedNames = new Set(ModelInfoService.getBuiltInSeedModels().map((m) => m.name));
    let entries: { name: string }[] = [];
    try {
      entries = await this.listModelJsonFiles(dir);
    } catch {
      return; // 目录不存在：无迁移对象
    }
    for (const entry of entries) {
      try {
        const modelInfo = await this.readModelJson(dir, entry.name);
        if (!modelInfo || modelInfo.builtIn !== true) continue;
        const filePath = path.join(dir, entry.name);
        if (seedNames.has(modelInfo.name)) {
          await this.fileSystemProvider!.deleteFile(filePath);
        } else {
          modelInfo.builtIn = false;
          await this.fileSystemProvider!.writeFile(filePath, JSON.stringify(modelInfo, null, 2));
        }
      } catch (e) {
        console.error(`内置模型文件迁移 ${entry.name} 失败:`, e);
      }
    }
  }

  /**
   * 获取所有模型信息
   */
  getAllModelInfos(): ModelInfo[] {
    return Array.from(this.modelInfos.values());
  }

  /**
   * 根据模型类型获取模型信息（别名方法）
   */
  getModelsByType(modelType: ModelType): ModelInfo[] {
    return Array.from(this.modelInfos.values()).filter(info => info.type === modelType);
  }

  /**
   * 根据模型名称列表获取模型信息
   */
  getModelsByNames(modelNames: string[]): ModelInfo[] {
    return Array.from(this.modelInfos.values()).filter(info => modelNames.includes(info.name));
  }

  /**
   * 根据供应商获取模型信息
   */
  getModelInfosByProvider(provider: string): ModelInfo[] {
    return Array.from(this.modelInfos.values()).filter(info => info.provider === provider);
  }

  /**
   * 根据模型名称获取模型信息
   */
  getModelInfoByName(modelName: string): ModelInfo | undefined {
    return this.modelInfos.get(modelName);
  }

  /**
   * 获取默认模型信息
   * 从所有已注册模型中返回第一个可用模型
   */
  getDefaultModelInfo(): ModelInfo | undefined {
    return this.modelInfos.values().next().value;
  }

  getDefaultModelName(): string {
    return this.getDefaultModelInfo()?.name || this.getAllModelInfos()[0]?.name || ''
  }

  /**
   * 获取支持特定模态的模型信息
   */
  getModelInfosByModality(modality: ModelModality): ModelInfo[] {
    return Array.from(this.modelInfos.values()).filter(info => info.supportedModalities.includes(modality));
  }

  /**
   * 添加新的模型信息
   */
  addModelInfo(modelInfo: ModelInfo): void {
    this.modelInfos.set(modelInfo.name, modelInfo);
  }

  /**
   * 持久化保存自定义模型信息到文件
   */
  async saveCustomModel(modelInfo: ModelInfo): Promise<void> {
    if (!this.fileSystemProvider) {
      console.warn('saveCustomModel: fileSystemProvider 未设置，跳过保存');
      return;
    }
    const dir = this.modelsDir;
    if (!dir) {
      throw new Error('saveCustomModel: modelsDir 未设置，请先调用 setModelsDir()');
    }
    const filePath = path.join(dir, `${modelInfo.name}.json`);
    const result = await this.fileSystemProvider.writeFile(filePath, JSON.stringify(modelInfo, null, 2));
    if (!result.success) {
      console.error(`保存自定义模型 ${modelInfo.name} 失败: ${result.error}`);
    }
  }

  async deleteCustomModelFile(modelName: string): Promise<void> {
    if (!this.fileSystemProvider) {
      console.warn('deleteCustomModelFile: fileSystemProvider 未设置，跳过删除');
      return;
    }
    const dir = this.modelsDir;
    if (!dir) {
      throw new Error('deleteCustomModelFile: modelsDir 未设置，请先调用 setModelsDir()');
    }
    const filePath = path.join(dir, `${modelName}.json`);
    try {
      await this.fileSystemProvider.deleteFile(filePath);
    } catch (error) {
      console.error(`删除自定义模型文件 ${modelName} 失败:`, error);
    }
  }

  /**
   * 统一加载全部模型：种子内置（代码所有，不落盘）→ 内置文件迁移 → 磁盘自定义 → Key 迁移
   */
  async loadAllModels(): Promise<void> {
    // 内置模型 = 代码所有：无条件以种子初始化（版本演进即时生效）
    this.initializeModelInfos();

    if (!this.fileSystemProvider) {
      console.warn('loadAllModels: fileSystemProvider 未设置，仅加载内置模型');
      return;
    }
    const dir = this.modelsDir;
    if (!dir) {
      throw new Error('loadAllModels: modelsDir 未设置，请先调用 setModelsDir()');
    }

    // 内置文件迁移（幂等）：清理旧版本播种的内置模型磁盘快照
    await this.migrateBuiltInFiles(dir);

    // 从磁盘加载自定义模型：仅 builtIn:false 且不与种子同名（同名影子自定义种子赢，文件忽略不删）
    try {
      const entries = await this.listModelJsonFiles(dir);
      for (const entry of entries) {
        const modelInfo = await this.readModelJson(dir, entry.name);
        if (!modelInfo || modelInfo.builtIn === true) continue;
        if (this.modelInfos.has(modelInfo.name)) continue;
        this.addModelInfo(modelInfo);
      }
    } catch (e) {
      console.error('加载模型文件失败:', e);
    }

    // 迁移旧 Key：按 ModelType 存储的旧 Key 迁移到按 provider 名称存储
    await this.migrateKeys();
  }

  /**
   * 从磁盘重新加载（外部修改 models 目录后热更新内存，无需重启）
   * 重建规则与 loadAllModels 一致：种子内置（代码所有）+ 磁盘自定义（builtIn:false 且不与种子同名）
   */
  async reloadFromDisk(): Promise<void> {
    if (!this.fileSystemProvider || !this.modelsDir) return;
    const dir = this.modelsDir;
    try {
      const fresh = new Map<string, ModelInfo>();
      for (const model of ModelInfoService.getBuiltInSeedModels()) {
        fresh.set(model.name, model);
      }
      const entries = await this.listModelJsonFiles(dir);
      for (const entry of entries) {
        const modelInfo = await this.readModelJson(dir, entry.name);
        if (!modelInfo || modelInfo.builtIn === true || fresh.has(modelInfo.name)) continue;
        fresh.set(modelInfo.name, modelInfo);
      }
      // 种子保底，fresh 永不为空（旧实现"目录空则保留旧内存"的守卫已无必要）
      this.modelInfos = fresh;
    } catch (e) {
      console.error('重新加载模型文件失败:', e);
    }
  }

  /**
   * 迁移按 ModelType 存储的旧 API Key 到按 provider 名称存储
   * 仅当新 Key 不存在时才迁移，避免覆盖
   */
  private async migrateKeys(): Promise<void> {
    if (!this.secureStorage) return;

    // 从种子数据构建 oldKey → providerName 映射
    const typeToProvider: Record<string, string> = {};
    const seedModels = ModelInfoService.getBuiltInSeedModels();
    for (const m of seedModels) {
      if (!typeToProvider[m.type]) {
        typeToProvider[m.type] = m.provider;
      }
    }

    for (const [oldKey, providerName] of Object.entries(typeToProvider)) {
      try {
        // 大小写不同的同名 Key（如 "deepseek" vs "DeepSeek"），
        // 在 Windows 不区分大小写的文件系统上是同一个文件，跳过迁移
        if (oldKey.toLowerCase() === providerName.toLowerCase()) {
          continue;
        }

        // 统一落到稳定 id 命名空间（如 智谱AI → zhipu）
        const providerId = providerManager.resolveId(providerName);

        const oldKeyExists = await this.secureStorage.hasApiKey(oldKey);
        if (!oldKeyExists) continue;

        const newKeyExists = await this.secureStorage.hasApiKey(providerId);
        if (newKeyExists) {
          await this.secureStorage.deleteApiKey(oldKey);
          continue;
        }

        // 将旧 Key 迁移到新位置
        const keyValue = await this.secureStorage.getApiKey(oldKey);
        if (keyValue) {
          await this.secureStorage.storeApiKey(providerId, keyValue);
          await this.secureStorage.deleteApiKey(oldKey);
        }
      } catch {
        // 忽略迁移失败
      }
    }
  }

  /**
   * 更新模型信息
   */
  updateModelInfo(modelName: string, updatedInfo: Partial<ModelInfo>): boolean {
    const modelInfo = this.modelInfos.get(modelName);
    if (!modelInfo) {
      return false;
    }
    Object.assign(modelInfo, updatedInfo);
    return true;
  }

  /**
   * 删除模型信息
   */
  removeModelInfo(modelName: string): boolean {
    return this.modelInfos.delete(modelName);
  }

  /**
   * 清除所有模型信息
   */
  clearAllModelInfos(): void {
    this.modelInfos.clear();
  }

  /**
   * 重新初始化模型信息
   */
  reinitializeModelInfos(): void {
    this.clearAllModelInfos();
    this.initializeModelInfos();
  }

  /**
   * 获取所有已配置 API Key 的模型
   * @returns Promise<ModelInfo[]> 已配置 API Key 的模型列表
   */
  async getModelsWithApiKeys(): Promise<ModelInfo[]> {
    const allModels = this.getAllModelInfos();
    const modelsWithApiKeys: ModelInfo[] = [];

    for (const model of allModels) {
      const hasApiKey = await this.secureStorage?.hasApiKey(providerManager.resolveId(model.provider)) ?? false;
      if (hasApiKey) {
        modelsWithApiKeys.push(model);
      }
    }

    return modelsWithApiKeys;
  }

  /**
   * 获取所有模型及其 API Key 配置状态
   * @returns Promise<Array<{model: ModelInfo, hasApiKey: boolean}>> 所有模型列表，包含 API Key 状态
   */
  async getAllModelsWithApiKeyStatus(): Promise<Array<{ model: ModelInfo; hasApiKey: boolean }>> {
    const allModels = this.getAllModelInfos();
    const result: Array<{ model: ModelInfo; hasApiKey: boolean }> = [];

    for (const model of allModels) {
      const hasApiKey = await this.secureStorage?.hasApiKey(providerManager.resolveId(model.provider)) ?? false;
      result.push({ model, hasApiKey });
    }

    return result;
  }
}

// 导出服务实例
export const modelInfoService = ModelInfoService.getInstance();

/**
 * 取提供商的注册/文档链接（单一事实源 = 种子卡 documentation 字段）。
 * 返回该提供商第一张种子卡的 documentation；非种子提供商（用户自定义）返回 undefined，
 * 调用方自行决定不显示链接行（不引入空占位状态）。
 * 首跑向导与 /key list 的"获取 API Key"行共用；提供商端点模板同理由种子卡派生
 * （getProviderEndpointTemplate 落地时与此函数同模式相邻添加）。
 */
export function getProviderDocUrl(providerName: string): string | undefined {
  for (const m of ModelInfoService.getBuiltInSeedModels()) {
    if (m.provider === providerName && m.documentation) {
      return m.documentation;
    }
  }
  return undefined;
}

/**
 * 取提供商的端点模板（单一事实源 = 第一张种子卡的 adapterConfig；baseURL 只存在于卡上，
 * provider 层不另存副本）。add_model 未显式给 base_url/protocol 时由此派生默认值；
 * 非种子提供商返回 undefined，调用方要求用户显式提供。
 */
export function getProviderEndpointTemplate(providerName: string): { baseURL: string; protocol: string } | undefined {
  for (const m of ModelInfoService.getBuiltInSeedModels()) {
    if (m.provider === providerName && m.adapterConfig?.baseURL && m.adapterConfig?.protocol) {
      return { baseURL: m.adapterConfig.baseURL, protocol: m.adapterConfig.protocol };
    }
  }
  return undefined;
}