/// <reference types="vite/client" />

// 宿主合同（WebUI 规划 M0.1）：原 ElectronAPI 内联声明已升格为
// host/hostApi.ts 的 HostAPI（共享层拥有，桌面/Web 双宿主实现，含连接态类型）。
// 本文件仅保留 window 注入点的 ambient 声明与 vite 环境类型。
import type { HostAPI } from './host/hostApi'

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string
  // 更多环境变量...
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare global {
  interface Window {
    electronAPI: HostAPI
  }
}

export {}
