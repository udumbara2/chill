export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'react-native-keychain') {
    return { url: new URL('./keychain-stub.mts', import.meta.url).href, shortCircuit: true };
  }
  // session.ts 的设备自报名读 Platform——Node 裸跑时给最小桩（真机/Metro/jest 走 RN 真身）
  if (specifier === 'react-native') {
    return { url: new URL('./react-native-stub.mts', import.meta.url).href, shortCircuit: true };
  }
  // RN/Metro 风格的无扩展相对导入 → node 侧补扩展（先 .ts 后 .js——op-sqlite 的 node 构建内部是无扩展 ESM）
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.(ts|mts|js|mjs)$/.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context);
    } catch {
      try {
        return await nextResolve(specifier + '.js', context);
      } catch {
        /* 落回默认解析 */
      }
    }
  }
  return nextResolve(specifier, context);
}
