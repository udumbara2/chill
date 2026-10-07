/**
 * fileUploader.test.ts — 上传器纯逻辑 jest 单测：
 * 分片尺寸/sha256 指纹透传、串行保序、429 退避重试、退避序列封顶、取消、超限、attachments 组装。
 */
import { uploadFile, nextChunkRetryMs, buildAttachments } from '../src/relay/fileUploader';
import { FILE_CHUNK_BYTES, FILE_MAX_BYTES } from '../src/relay/envelope';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const fakeBytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;
  return b;
};

describe('fileUploader', () => {
  it('分片尺寸与 sha256 指纹随 offer 透传；chunk 串行且 seq 连续', async () => {
    const bytes = fakeBytes(FILE_CHUNK_BYTES * 2 + 9); // 3 块
    const posted: Array<{ type: string; body: Record<string, unknown> }> = [];
    const out = await uploadFile({
      fileId: 'f1', name: 'a.bin', mime: 'application/octet-stream', bytes,
      post: async (env) => {
        posted.push(env);
        return 201;
      },
      sleep: async () => {},
    });
    expect(out).toBe('ok');
    const offer = posted.find((p) => p.type === 'file.offer')!;
    expect(offer.body['size']).toBe(bytes.length);
    expect(offer.body['chunks']).toBe(3);
    expect(offer.body['sha256']).toBe(bytesToHex(sha256(bytes)));
    const chunks = posted.filter((p) => p.type === 'file.chunk');
    expect(chunks.map((c) => c.body['seq'])).toEqual([0, 1, 2]);
    // 投递顺序严格串行（offer 在最前，chunk 依次）
    expect(posted[0]!.type).toBe('file.offer');
  });

  it('进度回调按分块推进（0→100）', async () => {
    const progress: number[] = [];
    const out = await uploadFile({
      fileId: 'f2', name: 'b.bin', mime: '', bytes: fakeBytes(FILE_CHUNK_BYTES + 1),
      post: async () => 201,
      onProgress: (p) => progress.push(p),
      sleep: async () => {},
    });
    expect(out).toBe('ok');
    expect(progress).toEqual([0, 50, 100]);
  });

  it('429 触发固定 35s 等待（非指数退避）；恢复后继续', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    let retriedOnce = false;
    const out = await uploadFile({
      fileId: 'f3', name: 'c.bin', mime: '', bytes: fakeBytes(10),
      post: async () => {
        calls++;
        if (!retriedOnce && calls <= 1) {
          retriedOnce = true;
          return 429;
        }
        return 201;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(out).toBe('ok');
    expect(sleeps).toEqual([35_000]); // 429 → 固定 35s（真机实测：指数退避 31s 总量不够等 60s 窗口重置）
    expect(nextChunkRetryMs(0)).toBe(1000);
    expect(nextChunkRetryMs(1)).toBe(2000);
    expect(nextChunkRetryMs(4)).toBe(16000);
    expect(nextChunkRetryMs(10)).toBe(30000);
  });

  it('429 重试耗尽 → post-failed', async () => {
    const out = await uploadFile({
      fileId: 'f4', name: 'd.bin', mime: '', bytes: fakeBytes(10),
      post: async () => 429,
      sleep: async () => {},
      maxRetries: 2,
    });
    expect(out).toBe('post-failed');
  });

  it('非 429 拒绝（如 403）→ 立即 post-failed（不退避）', async () => {
    let calls = 0;
    const out = await uploadFile({
      fileId: 'f5', name: 'e.bin', mime: '', bytes: fakeBytes(10),
      post: async () => {
        calls++;
        return 403;
      },
      sleep: async () => {},
    });
    expect(out).toBe('post-failed');
    expect(calls).toBe(1);
  });

  it('取消旗标在下一分块前生效', async () => {
    let cancel = false;
    const out = await uploadFile({
      fileId: 'f6', name: 'g.bin', mime: '', bytes: fakeBytes(FILE_CHUNK_BYTES * 3),
      post: async () => 201,
      isCancelled: () => cancel,
      sleep: async () => {},
    });
    void out; // 先跑通基线
    cancel = true;
    const out2 = await uploadFile({
      fileId: 'f7', name: 'h.bin', mime: '', bytes: fakeBytes(FILE_CHUNK_BYTES * 3),
      post: async () => 201,
      isCancelled: () => cancel,
      sleep: async () => {},
    });
    expect(out2).toBe('cancelled');
  });

  it('超单文件帽 → too-large（不投递任何信封）', async () => {
    let posted = 0;
    const out = await uploadFile({
      fileId: 'f8', name: 'big.bin', mime: '', bytes: new Uint8Array(FILE_MAX_BYTES + 1),
      post: async () => {
        posted++;
        return 201;
      },
      sleep: async () => {},
    });
    expect(out).toBe('too-large');
    expect(posted).toBe(0);
  });

  it('buildAttachments 截断到 5 个', () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ fileId: `f${i}`, name: `n${i}`, mime: 'x' }));
    expect(buildAttachments(files)).toHaveLength(5);
    expect(buildAttachments(files)[0]).toEqual({ fileId: 'f0', name: 'n0', mime: 'x' });
  });
});
