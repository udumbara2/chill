/**
 * ②B 迟到锚定（v9）测试：computeAnchorTs 纯函数（门 b 同钟系有效性 + 递增保序）、
 * receivedFileToMessage 排序键（anchorTs ?? createdAt）、R1 回归锁（已锚态显式判定，
 * 不依赖与尾条大小关系推导——锚值被后续消息超越仍用 anchorTs，绝不重锚/漂移）。
 * SQLite 迁移层（v9 双列 + 存量回填）与真机回归双例（已锚卡后续轮不跳位/存量卡首进不跳位）
 * 属真机验收面（本项目迁移无 jest 原生驱动覆盖的先例）。
 */
import { computeAnchorTs } from '../src/relay/session';
import { receivedFileToMessage } from '../src/screens/syncUiLogic';
import type { ReceivedFileRow } from '../src/db/syncDb';

const iso = (epoch: number) => new Date(epoch).toISOString();

function pendingRow(fileId: string, createdAtEpoch: number, floor: number | null) {
  return { fileId, createdAt: iso(createdAtEpoch), anchorFloorTs: floor };
}

test('computeAnchorTs：门 b 通过（last > floor）→ 锚 last+1；多卡按 createdAt 递增 +1/+2 保序', () => {
  const T0 = 1_000_000;
  const T2 = 1_005_000;
  // 两卡同 floor（同轮先后到达），createdAt 早者排前
  const out = computeAnchorTs(
    [pendingRow('f2', T0 + 200, T0), pendingRow('f1', T0 + 100, T0)],
    T2,
  );
  expect(out).toEqual([
    { fileId: 'f1', anchorTs: T2 + 1 },
    { fileId: 'f2', anchorTs: T2 + 2 },
  ]);
});

test('computeAnchorTs：门 b 不过——last == floor（同毫秒理论边）不锚；last < floor 不锚；floor=null（空会话首卡/存量卡）不锚', () => {
  const T0 = 1_000_000;
  expect(computeAnchorTs([pendingRow('f-same', T0, T0)], T0)).toEqual([]); // 同毫秒：接受不锚
  expect(computeAnchorTs([pendingRow('f-stale', T0, T0 + 50)], T0)).toEqual([]); // 尾条未推进过 floor
  expect(computeAnchorTs([pendingRow('f-null', T0, null)], T0 + 1000)).toEqual([]); // floor=null：不参与门
});

test('computeAnchorTs：混合输入只锚合格子集（门 b 过滤 + 递增只对合格者编号）', () => {
  const T0 = 1_000_000;
  const T2 = 1_004_000;
  const out = computeAnchorTs(
    [pendingRow('f-a', T0 + 100, T0), pendingRow('f-b', T0 + 200, null), pendingRow('f-c', T0 + 300, T2 + 1000)],
    T2,
  );
  expect(out).toEqual([{ fileId: 'f-a', anchorTs: T2 + 1 }]); // f-b floor null、f-c 尾条未超其 floor（T2 < floor）
});

function fullRow(fileId: string, anchorTs: number | null, createdAtEpoch = 1_000_000): ReceivedFileRow {
  return {
    fileId,
    sessionId: 's1',
    name: `${fileId}.bin`,
    mime: 'application/octet-stream',
    size: 1,
    sha256: 'a'.repeat(64),
    staticJson: '{}',
    expiresAt: null,
    state: 'offered',
    stagingPath: null,
    contentUri: null,
    error: null,
    createdAt: iso(createdAtEpoch),
    updatedAt: iso(createdAtEpoch),
    anchorFloorTs: null,
    anchorTs,
  };
}

test('receivedFileToMessage：anchorTs 优先；null 回退 createdAt（未锚定期现状位）', () => {
  expect(receivedFileToMessage(fullRow('f1', 5000)).ts).toBe(5000);
  expect(receivedFileToMessage(fullRow('f1', null, 123456)).ts).toBe(123456);
});

test('R1 回归锁：已锚卡锚值被后续消息超越仍用 anchorTs（显式态——绝不依赖与尾条大小关系推导，不重锚不漂移）', () => {
  const anchoredAt = 5000; // 锚定时归属轮末条 4999 + 1
  const laterRoundTs = 9000; // 后续轮消息 ts 已超越锚值——渲染排序键不变，卡片不被拖到新轮
  expect(receivedFileToMessage(fullRow('f1', anchoredAt)).ts).toBe(anchoredAt);
  expect(anchoredAt).toBeLessThan(laterRoundTs); // 前置：超越成立
});
