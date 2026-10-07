// 模块重定向 hook：node 裸跑 App 的 session.ts 时，把 react-native-keychain 换成内存桩，
// WebSocket 全局换成 ws 包（与 RN 内置 WS 同握手 header 语义）。
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./resolve-hook.mjs', import.meta.url), pathToFileURL('./'));
