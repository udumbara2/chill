/**
 * bg.ts — 前台服务（react-native-background-actions 4.x，dataSync）。
 * 常驻通知"chill 连接中"：保住 JS 进程即保住 WS 长连；
 * 信箱拉取兜底永远成立（保活全灭也不丢消息——重连即补投）。
 */
import BackgroundService from 'react-native-background-actions';

const sleepTask = async () => {
  // JS 存活性锚点：任务本身不做任何事，前台服务存在期间 JS 引擎不被冻结
  await new Promise(() => {});
};

const options = {
  taskName: 'chill-relay',
  taskTitle: 'chill',
  taskDesc: 'chill 连接中',
  taskIcon: { name: 'ic_launcher', type: 'mipmap' },
  color: '#3b82f6',
  linkingURI: undefined,
  parameters: {},
  // targetSdk 34 必须显式声明 FGS 类型（库的默认是 type none，会被系统禁掉）
  foregroundServiceType: ['dataSync' as const],
};

export async function startRelayForegroundService(): Promise<void> {
  try {
    if (!BackgroundService.isRunning()) await BackgroundService.start(sleepTask, options);
  } catch (e) {
    console.warn('[bg] 前台服务启动失败（通知权限未授予时 Android 13+ 会拒）:', e);
  }
}

export async function stopRelayForegroundService(): Promise<void> {
  try {
    if (BackgroundService.isRunning()) await BackgroundService.stop();
  } catch {
    /* ignore */
  }
}
