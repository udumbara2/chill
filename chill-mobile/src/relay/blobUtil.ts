/**
 * blobUtil.ts — react-native-blob-util 获取三级链（default-real, test-override）：
 * ① globalThis.ReactNativeBlobUtil —— e2e/Node 注入的 fake（优先，e2e 行为零变化）
 * ② 惰性 require 真实模块 —— RN 真机默认实现（包本身 import 安全、不触原生；
 *    Node/tsx ESM 无 require，typeof 守卫跳过；require 抛错落 ③）
 * ③ null —— 无本地存储能力（调用方诚实报错）
 *
 * 2026-09-28 事故根因：曾只有 ①——真机无人注入，d→m 拉取暂存写入必败
 * （"暂存写入失败：无本地存储能力"，receipt io 14 连败）。纪律：默认值必须是
 * 真实实现，测试只能覆盖默认值；禁止"默认为空、各处自行注入"。
 */

// metro/CommonJS 模块作用域函数；Node/tsx ESM 下不存在（typeof 守卫跳过）
declare const require: ((id: string) => unknown) | undefined;

/** 本项目用到的 blob-util.fs 子集（结构化鸭子类型；真实模块与 e2e fake 同形） */
export interface BlobUtilFs {
  dirs: { DocumentDir: string };
  /** 目录列举（暂存目录对账用）。真机 Android 语义（已核 ReactNativeBlobUtilFS.java）：
   * 返回**文件名**数组（File.list()，无目录前缀）；目录不存在 reject ENOENT、非目录 reject ENOTDIR。
   * 消费方（recvReconcile/session 对账）已内建归一化，文件名/全路径两形态均安全 */
  ls(p: string): Promise<string[]>;
  readStream(
    path: string,
    encoding: string,
    start?: number,
    end?: number,
  ): {
    open(): void;
    onData(cb: (d: string) => void): void;
    onEnd(cb: () => void): void;
    onError(cb: (e: unknown) => void): void;
  };
  isDir(p: string): Promise<boolean>;
  mkdir(p: string): Promise<void>;
  appendFile(p: string, data: string, encoding: string): Promise<unknown>;
  stat(p: string): Promise<{ size: number | string }>;
  hash(p: string, algo: string): Promise<string>;
  mv(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
}

let realModule: { fs: BlobUtilFs } | null | undefined; // undefined=未尝试（惰性）

/** 取 blob-util：注入优先 → 真实模块兜底 → null（调用方按"无本地存储能力"诚实报错）。 */
export function resolveBlobUtil(): { fs: BlobUtilFs } | null {
  const injected = (globalThis as Record<string, unknown>)['ReactNativeBlobUtil'] as
    | { fs: BlobUtilFs }
    | undefined;
  if (injected) return injected;
  if (realModule !== undefined) return realModule;
  try {
    if (typeof require !== 'function') {
      realModule = null; // Node/tsx ESM 无 require
    } else {
      // ESM 互操作归一化：fs 挂在 default 导出上（index.js export default），
      // 裸 require 拿到的是 transpiled exports 对象——兼容两种形态
      const mod = require('react-native-blob-util') as { fs?: BlobUtilFs; default?: { fs?: BlobUtilFs } };
      realModule = mod?.fs ? (mod as { fs: BlobUtilFs }) : mod?.default?.fs ? (mod.default as { fs: BlobUtilFs }) : null;
    }
  } catch {
    realModule = null;
  }
  return realModule;
}
