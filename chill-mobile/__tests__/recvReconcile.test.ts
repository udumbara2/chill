/**
 * recvReconcile.test.ts — 暂存目录对账谓词全组合直测。
 *
 * 会删文件的代码，谓词必须被 jest 全组合锁定：
 * ls 条目形态（文件名/全路径）× 文件类型（.part/staging）× 归属（有主/无主/在飞）× 脏条目。
 * 硬契约：输出恒为归一化 basename（无路径分隔符、无目录前缀——禁止透传 ls 条目）；
 * 有主（含 failed 断点）与在飞文件永不进待删。
 */
import { reconcileRecvDir } from '../src/relay/recvReconcile';

const KNOWN = new Set(['aaa', 'bbb', 'ccc']); // 非终态行 fileId（bbb 模拟 failed 断点也在集合内）
const PULLS = new Set(['fly1']); // 在飞拉取

describe('reconcileRecvDir 全组合', () => {
  test('文件名形态（真机形态）：无主 .part/staging 进待删，输出恒为 basename', () => {
    const out = reconcileRecvDir(['orphan1.part', 'orphan2', 'aaa.part', 'bbb', 'fly1.part'], KNOWN, PULLS);
    expect(out).toEqual(['orphan1.part', 'orphan2']);
  });

  test('全路径形态：归一化后等价（纵深防御——其他平台/版本形态漂移）', () => {
    const out = reconcileRecvDir(
      ['/data/user/0/files/chill-recv/orphan1.part', '/data/user/0/files/chill-recv/orphan2', '/data/user/0/files/chill-recv/aaa'],
      KNOWN,
      PULLS,
    );
    expect(out).toEqual(['orphan1.part', 'orphan2']);
  });

  test('有主永不进待删：offered/pulling/failed（断点续拉）一律保留', () => {
    const out = reconcileRecvDir(['aaa.part', 'aaa', 'bbb.part', 'bbb', 'ccc.part', 'ccc'], KNOWN, PULLS);
    expect(out).toEqual([]);
  });

  test('在飞跳过：activePulls 的文件留下一轮（与"传输中删会话照常交付"自洽）', () => {
    const out = reconcileRecvDir(['fly1.part', 'fly1', 'other1.part'], KNOWN, PULLS);
    expect(out).toEqual(['other1.part']);
  });

  test('脏条目防御：非字符串/空串/空 fileId/非法字符 一律跳过（fail-closed=不清，永不误删）', () => {
    const out = reconcileRecvDir(
      [123, null, undefined, '', '.part', 'orphan.part.part', 'has.dot.part', 'a b.part', 'a+b.part', '文件.part', {}],
      KNOWN,
      PULLS,
    );
    // '.part'→fileId 空；'orphan.part.part'→'orphan.part' 含点；'has.dot' 含点；'a b' 含空格；
    // 'a+b' 含加号、'文件' 含中文（白名单仅 A-Za-z0-9_-，大小写均合法）；{} 非字符串
    expect(out).toEqual([]);
  });

  test('fileId 形状边界：64 字符通过、65 字符拒绝、下划线连字符与大小写字母通过', () => {
    const id64 = 'x'.repeat(64);
    const id65 = 'x'.repeat(65);
    const out = reconcileRecvDir([`${id64}.part`, `${id65}.part`, 'a-b_C9.part', 'UPPER9.part'], KNOWN, PULLS);
    expect(out).toEqual([`${id64}.part`, 'a-b_C9.part', 'UPPER9.part']);
  });

  test('basename 契约：输出不含路径分隔符与目录前缀（锁定禁止透传）', () => {
    const out = reconcileRecvDir(['/any/dir/orphan1.part', 'orphan2'], KNOWN, PULLS);
    for (const b of out) {
      expect(b).not.toContain('/');
      expect(b).not.toContain('\\');
    }
    expect(out).toEqual(['orphan1.part', 'orphan2']);
  });
});
