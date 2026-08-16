export * from './types'
export * from './IHookProcessRunner'
export { HookConfigLoader } from './HookConfigLoader'
export type { HookConfigLoaderOptions } from './HookConfigLoader'
export { TRUSTED_KV_KEY, trustKeyOf, computeHandlerTrustHash } from './hookTrust'
export {
  HookRunner,
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  MAX_HOOK_INVOCATIONS,
} from './HookRunner'
export type { HookDispatchContext, HookDispatchResult, HookRunnerDeps } from './HookRunner'
export { DecisionPipeline } from './DecisionPipeline'
export type { SyncPolicyLink } from './DecisionPipeline'
// 通知轨映射表（阶段 4）：eventBus → Notification/GoalTransition，装配时统一订阅
export { attachHookNotificationBridge } from './notificationBridge'
// Worker MCP 工具的 hooks 派发通道（阶段 4）：宿主网关经此过 PreToolUse/PostToolUse
export { setWorkerMcpHookDispatcher, getWorkerMcpHookDispatcher } from './workerMcpHooks'
export type { WorkerMcpHookCall, WorkerMcpHookOutcome, WorkerMcpHookDispatcher } from './workerMcpHooks'
