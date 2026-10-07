/**
 * blobUtil 三级链防回归（2026-09-28 事故：globalThis 鸭子类型是唯一来源，
 * 真机无人注入 → d→m 拉取暂存写入必败 io 14 连败，而 jest/e2e 全绿）。
 * 纪律：默认值必须是真实实现（②惰性 require），测试只能覆盖默认值（①注入优先）。
 */
import { resolveBlobUtil } from '../src/relay/blobUtil';

describe('resolveBlobUtil（default-real, test-override）', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['ReactNativeBlobUtil'];
  });

  it('globalThis 未注入时回退到真实 react-native-blob-util 模块（真机默认路径）', () => {
    delete (globalThis as Record<string, unknown>)['ReactNativeBlobUtil'];
    const m = resolveBlobUtil();
    expect(m).not.toBeNull();
    // 只断言 JS 面形状；dirs.DocumentDir 等原生常量不在 jest 触碰（取值即触原生）
    expect(typeof m!.fs).toBe('object');
    expect(typeof m!.fs.readStream).toBe('function');
    expect(typeof m!.fs.appendFile).toBe('function');
    expect(typeof m!.fs.stat).toBe('function');
    expect(typeof m!.fs.hash).toBe('function');
    expect(typeof m!.fs.mv).toBe('function');
    expect(typeof m!.fs.unlink).toBe('function');
    expect(typeof m!.fs.isDir).toBe('function');
    expect(typeof m!.fs.mkdir).toBe('function');
  });

  it('globalThis 注入优先（e2e fake 覆盖默认，行为零变化）', () => {
    const fake = { fs: { dirs: { DocumentDir: 'e2e://docs' } } };
    (globalThis as Record<string, unknown>)['ReactNativeBlobUtil'] = fake;
    expect(resolveBlobUtil()).toBe(fake);
  });
});
