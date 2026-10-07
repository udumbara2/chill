/**
 * engine 模块出口（T2：ChatEngine 统一对话路径）
 *
 * 本出口全部为平台无关代码（引擎本体经注入的适配器工作），渲染进程可安全导入；
 * Node 侧装配（nodeFactory，依赖 SessionPersistence/fs 与模型服务单例群）
 * 只从 core 的 index.ts 导出，不经本出口。
 */

export * from './types'
export * from './media'
export * from './agentMention'
export * from './mediaMention'
export * from './fileRef'
export * from './delegationGuide'
export * from './ContextAssembler'
export * from './ChatEngine'
export * from './GoalEvaluator'
