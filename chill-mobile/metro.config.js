const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
// resolver.useWatchman: false——本机 watchman 对含中文的路径（…/助手/…）根解析失败（编码缺陷），
// 强制走 node crawler 文件监听（仅影响变更检测性能，不影响正确性）。
const config = {
  resolver: {
    useWatchman: false,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
