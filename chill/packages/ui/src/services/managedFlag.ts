import { ref } from 'vue'

/**
 * managed 布局旗标（闪念捕获 · 门控消费点）
 *
 * 事实源：main.ts 经 skill:builtin-dir IPC 的 bd.managed（electron-main 用
 * getOwnProjectPaths().projectPath !== null 判定——安装事实，非用户设置）。
 * 消费点：Home 的 Ctrl+I 捕获条绑定、药丸弹层捕获输入框等 npm 模式下"入口不存在"的呈现。
 * 默认 true（未探明前不隐藏——与 skillGetBuiltinDir 回调时序竞争时宁可短暂可见）。
 */
export const managedFlag = ref(true)
