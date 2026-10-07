module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['./jest.setup.js'],
  // 套件首个用例承担整棵组件树 babel 冷启编译（~13s，watchman 缺失时更慢），上限放宽；不影响正常用例速度
  testTimeout: 30000,
  // 键盘几何库的官方 jest mock 是 ESM，需纳入转译范围（默认忽略 node_modules）；
  // vision-camera V5 及其条码插件、nitro 运行时同为 ESM 发布形态，同例纳入；
  // file.* 附件依赖（image-picker / document-picker / blob-util / base64-js）同例
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|react-native-keyboard-controller|react-native-reanimated|react-native-worklets|react-native-vision-camera|react-native-vision-camera-barcode-scanner|react-native-nitro-modules|react-native-nitro-image|react-native-background-actions|@react-navigation|react-native-screens|react-native-safe-area-context|react-native-image-picker|react-native-document-picker|react-native-blob-util|base64-js)/)',
  ],
};
