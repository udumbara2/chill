/**
 * mediaFetcher.test.ts — d→m 文件拉取器纯逻辑：
 * 快乐路径（加密→解密往返对账）/ 断点续拉 / 逐片篡改→corrupt / 404→expired /
 * sha256 不符 / 取消（断点保留）/ 形状校验 / 过期本地判（零网络请求）。
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  sealMediaChunk,
  newMediaFileKeys,
  b64uEncode,
  mediaChunkRange,
  mediaWireSize,
  MEDIA_CHUNK_BYTES,
  type FileOfferBody,
} from '../src/relay/envelope';
import { fetchOfferedFile, validateIncomingOffer, FetchHttpError } from '../src/relay/mediaFetcher';

// ---------- 测试辅助：内存密文服务器 + 内存暂存 ----------

function makePlain(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 13) % 251;
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 假中继静态通道：sealMediaChunk 逐片加密（与桌面发送器同原语）+ Range 读取 + 故障注入 */
class FakeRelayStatic {
  wire: Uint8Array;
  requests: Array<{ start: number; end: number }> = [];
  /** 下一次 getRange 抛此错误（一次性网络故障注入） */
  failNextWith: Error | null = null;
  /** 命中的 range 恒返此 HTTP 状态（404/410 清场注入） */
  failStatusFor: { start: number; status: number } | null = null;

  constructor(plain: Uint8Array, keyB64u: string, fileNonce: Uint8Array) {
    const chunks = Math.ceil(plain.length / MEDIA_CHUNK_BYTES);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < chunks; i++) {
      parts.push(
        sealMediaChunk(plain.subarray(i * MEDIA_CHUNK_BYTES, Math.min((i + 1) * MEDIA_CHUNK_BYTES, plain.length)), keyB64u, fileNonce, i),
      );
    }
    this.wire = concat(parts);
  }

  /** 篡改密文流中 offset 处的一个字节 */
  tamper(offset: number): void {
    this.wire[offset] = (this.wire[offset] ?? 0) ^ 0xff;
  }

  getRange = async (_url: string, start: number, end: number): Promise<Uint8Array> => {
    this.requests.push({ start, end });
    if (this.failNextWith) {
      const e = this.failNextWith;
      this.failNextWith = null;
      throw e;
    }
    if (this.failStatusFor && this.failStatusFor.start === start) throw new FetchHttpError(this.failStatusFor.status);
    return this.wire.subarray(start, end + 1);
  };
}

/** 假暂存（.part 语义：已认证明文追加；finalize 记录定稿路径） */
class FakeTempStore {
  parts = new Map<string, Uint8Array>();
  finals = new Map<string, string>();
  discarded: string[] = [];

  appendTemp = async (fileId: string, bytes: Uint8Array): Promise<void> => {
    this.parts.set(fileId, concat([this.parts.get(fileId) ?? new Uint8Array(0), bytes]));
  };
  tempSize = async (fileId: string): Promise<number> => this.parts.get(fileId)?.length ?? 0;
  hashTemp = async (fileId: string): Promise<string> => bytesToHex(sha256(this.parts.get(fileId) ?? new Uint8Array(0)));
  finalizeTemp = async (fileId: string): Promise<string> => {
    const p = `/staging/${fileId}`;
    this.finals.set(fileId, p);
    return p;
  };
  discardTemp = async (fileId: string): Promise<void> => {
    this.parts.delete(fileId);
    this.discarded.push(fileId);
  };
}

const MEDIA_NAME = 'a'.repeat(32) + '.bin';

function makeCase(size: number, offerOver?: Partial<FileOfferBody>) {
  const plain = makePlain(size);
  const { fileNonce, keyB64u } = newMediaFileKeys();
  const server = new FakeRelayStatic(plain, keyB64u, fileNonce);
  const temp = new FakeTempStore();
  const offer: FileOfferBody = {
    fileId: 'f-test-1',
    name: '报告.pdf',
    mime: 'application/pdf',
    size,
    sha256: bytesToHex(sha256(plain)),
    chunks: 0,
    static: {
      name: MEDIA_NAME,
      key: keyB64u,
      fmt: 2,
      wireSize: mediaWireSize(size),
      nonce: b64uEncode(fileNonce),
    },
    ...offerOver,
  };
  const deps = {
    offer,
    urlFor: (name: string) => `https://relay.example/static/media/${name}`,
    getRange: server.getRange,
    appendTemp: temp.appendTemp,
    tempSize: temp.tempSize,
    hashTemp: temp.hashTemp,
    finalizeTemp: temp.finalizeTemp,
    discardTemp: temp.discardTemp,
  };
  return { plain, server, temp, offer, deps };
}

describe('fetchOfferedFile', () => {
  it('快乐路径：多片逐拉+进度+密文解回与原文逐字节相等（sealMediaChunk→openMediaChunk 往返对账）', async () => {
    const size = MEDIA_CHUNK_BYTES * 2 + 12345; // 3 片
    const { plain, server, temp, deps } = makeCase(size);
    const progress: Array<[number, number]> = [];

    const r = await fetchOfferedFile({ ...deps, onProgress: (a, b) => progress.push([a, b]) });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stagingPath).toBe('/staging/f-test-1');
    expect(r.size).toBe(size);
    expect(r.safeName).toBe('报告.pdf'); // sanitizeFileName 清洗后（本无害）
    expect(server.requests.length).toBe(3);
    expect(server.requests[0]).toEqual({ start: 0, end: mediaChunkRange(size, 0).end });
    expect(progress.length).toBe(3);
    expect(progress[progress.length - 1]).toEqual([size, size]);
    expect(temp.parts.get('f-test-1')).toEqual(plain); // 解密拼装 = 原文
  });

  it('断点续拉：中途网络断 → io 保留断点；重试从断点片续拉（Range offset 对齐）', async () => {
    const size = MEDIA_CHUNK_BYTES * 2 + 100; // 3 片
    const { plain, server, temp, deps } = makeCase(size);
    const resumeStart = mediaChunkRange(size, 2).start;
    server.failStatusFor = null;
    // 第一轮：拉到第 3 片时网络断（failNextWith 在第 3 次请求触发）
    let calls = 0;
    const flaky = async (url: string, start: number, end: number): Promise<Uint8Array> => {
      calls++;
      if (calls === 3) throw new Error('network down');
      return server.getRange(url, start, end);
    };

    const r1 = await fetchOfferedFile({ ...deps, getRange: flaky });
    expect(r1).toMatchObject({ ok: false, error: 'io' });
    expect(await temp.tempSize('f-test-1')).toBe(MEDIA_CHUNK_BYTES * 2); // 断点=已认证 2 片
    expect(temp.discarded).toEqual([]); // io 不清场

    // 第二轮：从断点续拉
    const r2 = await fetchOfferedFile(deps);
    expect(r2.ok).toBe(true);
    const run2Requests = server.requests.slice(2); // 第一轮成功请求 2 次（第 3 次是 flaky 短路，未进 server）
    expect(run2Requests.length).toBe(1);
    expect(run2Requests[0]!.start).toBe(resumeStart); // Range offset = 断点续拉
    expect(temp.parts.get('f-test-1')).toEqual(plain);
  });

  it('逐片篡改 → corrupt：认证失败不推进断点并清场', async () => {
    const size = MEDIA_CHUNK_BYTES * 2;
    const { server, temp, deps } = makeCase(size);
    // 篡改片 1 密文区一个字节（nonce 区 24B 之后的 ct）
    const chunk1 = mediaChunkRange(size, 1);
    server.tamper(chunk1.start + 30);

    const r = await fetchOfferedFile(deps);
    expect(r).toMatchObject({ ok: false, error: 'corrupt' });
    expect(temp.discarded).toEqual(['f-test-1']);
    expect(await temp.tempSize('f-test-1')).toBe(0);
  });

  it('404 → expired：清场且不再续拉', async () => {
    const size = MEDIA_CHUNK_BYTES + 100;
    const { server, temp, deps } = makeCase(size);
    server.failStatusFor = { start: 0, status: 404 };

    const r = await fetchOfferedFile(deps);
    expect(r).toMatchObject({ ok: false, error: 'expired' });
    expect(temp.discarded).toEqual(['f-test-1']);
  });

  it('410 → expired（同上，过期语义）', async () => {
    const { server, deps } = makeCase(100);
    server.failStatusFor = { start: 0, status: 410 };
    const r = await fetchOfferedFile(deps);
    expect(r).toMatchObject({ ok: false, error: 'expired' });
  });

  it('整文件 sha256 不符 → corrupt（清场）', async () => {
    const { temp, deps } = makeCase(500, { sha256: '0'.repeat(64) });
    const r = await fetchOfferedFile(deps);
    expect(r).toMatchObject({ ok: false, error: 'corrupt' });
    expect(temp.discarded).toEqual(['f-test-1']);
  });

  it('取消：片边界生效 → aborted，断点保留（不丢弃已拉字节）', async () => {
    const size = MEDIA_CHUNK_BYTES * 3;
    const { temp, deps } = makeCase(size);
    let appended = 0;
    const r = await fetchOfferedFile({
      ...deps,
      appendTemp: async (id, bytes) => {
        appended++;
        await temp.appendTemp(id, bytes);
      },
      isCancelled: () => appended >= 1,
    });
    expect(r).toEqual({ ok: false, error: 'aborted' });
    expect(await temp.tempSize('f-test-1')).toBe(MEDIA_CHUNK_BYTES); // 断点保留
    expect(temp.discarded).toEqual([]);
  });

  it('过期要约本地判 → expired（零网络请求 + 清场）', async () => {
    const { server, temp, deps } = makeCase(100);
    const r = await fetchOfferedFile({
      ...deps,
      offer: { ...deps.offer, expiresAt: 1000 },
      now: () => 2000,
    });
    expect(r).toMatchObject({ ok: false, error: 'expired' });
    expect(server.requests.length).toBe(0); // 不消耗必然失败的请求
    expect(temp.discarded).toEqual(['f-test-1']);
  });

  it('半截断点（非整片边界）→ 丢弃重来', async () => {
    const size = MEDIA_CHUNK_BYTES + 50;
    const { server, temp, deps } = makeCase(size);
    temp.parts.set('f-test-1', new Uint8Array(123)); // 非整片边界的脏断点

    const r = await fetchOfferedFile(deps);
    expect(r.ok).toBe(true);
    expect(temp.discarded).toEqual(['f-test-1']);
    expect(server.requests[0]!.start).toBe(0); // 从头重拉
  });

  it('断点已完整（拉齐后中断于对账前）→ 跳过拉取直进对账定稿（零网络请求）', async () => {
    const size = MEDIA_CHUNK_BYTES + 50; // 末片不满——tempSize 非整片但 == size 的合法边界
    const { plain, server, temp, deps } = makeCase(size);
    temp.parts.set('f-test-1', plain); // 完整断点

    const r = await fetchOfferedFile(deps);
    expect(r.ok).toBe(true);
    expect(server.requests.length).toBe(0);
    expect(temp.finals.get('f-test-1')).toBe('/staging/f-test-1');
  });

  it('形状校验：非 v2 分片形态 → corrupt（诚实报错，本方向不产生 v1）', async () => {
    const { deps } = makeCase(100);
    const v1Offer: FileOfferBody = {
      ...deps.offer,
      static: { name: MEDIA_NAME, key: deps.offer.static!.key },
    };
    const r = await fetchOfferedFile({ ...deps, offer: v1Offer });
    expect(r).toMatchObject({ ok: false, error: 'corrupt' });
  });
});

describe('validateIncomingOffer', () => {
  it('合法 v2 要约通过；fileId 字符白名单（路径穿越防御）；wireSize 精确等值', () => {
    const { offer } = makeCase(100);
    expect(validateIncomingOffer(offer).ok).toBe(true);
    expect(validateIncomingOffer({ ...offer, fileId: '../evil' }).ok).toBe(false);
    expect(validateIncomingOffer({ ...offer, fileId: '' }).ok).toBe(false);
    const badWire = { ...offer, static: { ...offer.static!, wireSize: offer.size + 999 } };
    expect(validateIncomingOffer(badWire).ok).toBe(false);
    const badName = { ...offer, static: { ...offer.static!, name: 'guessable.bin' } };
    expect(validateIncomingOffer(badName).ok).toBe(false);
  });
});
