// node --test 直接跑源码 .ts 时的解析兜底：源码内部相对 import 不带扩展名，
// Node ESM 解析失败，这里依次尝试补 .ts 与 /index.ts
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) {
      try { return await nextResolve(specifier + '.ts', context) } catch { /* 继续尝试 */ }
      try { return await nextResolve(specifier + '/index.ts', context) } catch { /* 抛原始错误 */ }
    }
    throw err
  }
}
