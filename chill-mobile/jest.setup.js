// 键盘几何库在 jest 环境无原生模块，用官方自带的 jest mock（库随包发布，见 installation 文档）
jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
// vision-camera V5 依赖原生 NitroModules（jest 环境不存在），按 PairingScreen 实际用到的导出面打桩
jest.mock('react-native-vision-camera', () => ({
  Camera: 'Camera',
  useCameraPermission: () => ({ hasPermission: false, requestPermission: jest.fn() }),
}));
jest.mock('react-native-vision-camera-barcode-scanner', () => ({
  useBarcodeScannerOutput: () => ({}),
}));
// worklets（reanimated v4 的运行时底座）在 jest 环境无原生模块，用库自带 mock
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
// background-actions 是纯原生模块（NativeEventEmitter 底座），jest 环境打桩
jest.mock('react-native-background-actions', () => ({
  __esModule: true,
  default: { start: jest.fn(), stop: jest.fn(), isRunning: () => false, on: jest.fn() },
}));
// file.* 附件依赖（原生模块在 jest 环境不存在——按 attachmentStore 实际用到的导出面打桩）
jest.mock('react-native-document-picker', () => ({
  pickSingle: jest.fn(),
  types: { allFiles: 'allFiles' },
}));
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));
jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: {
      dirs: { DocumentDir: '/tmp/jest-documents' },
      isDir: jest.fn(async () => true),
      mkdir: jest.fn(async () => undefined),
      writeFile: jest.fn(async () => undefined),
      readFile: jest.fn(async () => ''),
      stat: jest.fn(async () => ({ size: 0 })),
      // file.* d→m 暂存五件套 + 上传切片（blobUtil.ts 三级链的 jest 默认实现，形状须与真机一致）
      appendFile: jest.fn(async () => undefined),
      hash: jest.fn(async () => ''),
      mv: jest.fn(async () => undefined),
      unlink: jest.fn(async () => undefined),
      readStream: jest.fn(() => ({
        open: () => {},
        onData: () => {},
        onEnd: () => {},
        onError: () => {},
      })),
    },
  },
}));
// op-sqlite 是 JSI 原生库（模块加载即安装原生绑定），jest 环境无原生模块；
// open 抛错 → session.ts 的 db() 捕获降级（同步功能关闭，聊天主路径不受影响）。
// DB 落库逻辑的单测走 syncReducer + 内存 fake SyncDb（__tests__/syncReducer.test.ts），不 mock 本模块行为。
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    throw new Error('jest 环境无 op-sqlite 原生模块');
  },
}));
// reanimated 在 jest 环境无原生动画运行时（库自带 mock 会经 CSS proxy 触达 JSReanimated 抛错），
// 按本仓库实际用到的导出面打桩（Animated 组件映射为 RN 原语、hooks/动画函数原样透传）
jest.mock('react-native-reanimated', () => {
  const RN = require('react-native');
  const Animated = {
    View: RN.View,
    Text: RN.Text,
    ScrollView: RN.ScrollView,
    FlatList: RN.FlatList,
    Image: RN.Image,
    createAnimatedComponent: (c: unknown) => c,
  };
  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useAnimatedProps: (fn: () => unknown) => fn(),
    useSharedValue: (init: unknown) => ({ value: init }),
    useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
    withTiming: (v: unknown) => v,
    withSpring: (v: unknown) => v,
    withDelay: (_ms: number, v: unknown) => v,
    runOnJS: (fn: unknown) => fn,
    interpolate: (v: unknown) => v,
  };
});
