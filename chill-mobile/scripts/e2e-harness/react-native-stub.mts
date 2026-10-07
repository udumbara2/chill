/**
 * react-native 的 Node 侧最小桩：e2e 手机侧（e2e-node.mts）裸跑 session.ts 时，
 * resolve-hook 把 'react-native' 重定向到这里。session.ts 只用 Platform.constants
 * （设备自报名：厂商+型号）；RN 真身在设备/Metro/jest（RN preset）侧照常解析。
 */
export const Platform = {
  OS: 'android',
  // 与 Android Build 字段同名的最小集；e2e 只关心形状，值用于在配对名里可辨识来源
  constants: { Manufacturer: 'e2e', Model: 'node-stub' } as Record<string, string>,
  select: <T>(objs: { android?: T; ios?: T; default?: T }): T =>
    (objs.android ?? objs.default) as T,
};

/** 原生模块注册表桩（d→m 交付层 deliverFile 读 NativeModules.MediaStoreModule——
 *  Node 无原生模块，e2e 场景把内存交付实现挂到这里；真机=Kotlin MediaStoreModule） */
export const NativeModules: Record<string, unknown> = {};
