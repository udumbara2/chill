/**
 * attachmentStore.ts — file.* 协议族的采集与登记（选择器 → 压缩 → 拷贝私有目录 → sentAttachments 登记）。
 *
 * 职责边界：只管"字节从哪来、放哪去、怎么登记"；协议编排（offer/chunk/receipt）在 session。
 * - 图片：react-native-image-picker（includeBase64 直出字节 + 最长边 1568/质量 0.75 压缩——模型友好）
 * - 视频（相册入口）：picker 对视频不返 base64——asset.uri 是库拷好的 App 缓存副本（file://），
 *   走磁盘路径模型（stat → >5MB 不进内存 → mv 登记），与 document 分支同构
 * - 文件/视频：react-native-document-picker copyTo（原生 ContentResolver 流式拷出缓存副本
 *   ——content:// 是能力句柄不是磁盘路径，stat/readFile 直接用必炸）→ blob-util 对副本 stat/读字节
 *   → 缓存副本 mv 原子入位登记（免一次 base64 全量回写）
 * - 登记字节一律拷入 App 私有目录（防系统清缓存丢副本——历史缩略图的本地真相源）
 * 上限纪律：文档入口 MEDIA_MAX_BYTES（100MB，>5MB 走 v2 分片路径——localPath 供流式读，字节不进内存）；
 * 图片 gallery/camera 仍 FILE_MAX_BYTES（5MB，内存字节路径）——超限在选择时即拒绝并给替代路提示。
 */
import { launchImageLibrary, launchCamera, type Asset } from 'react-native-image-picker';
import { pickSingle, types as docTypes } from 'react-native-document-picker';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { toByteArray as b64ToBytes, fromByteArray as bytesToB64 } from 'base64-js';
import { FILE_MAX_BYTES, MEDIA_MAX_BYTES } from './envelope';
import { getSyncDb } from '../db/syncDb';

export interface PickedAttachment {
  fileId: string;
  name: string;
  mime: string;
  /** 上传用字节（图片=picker 压缩产物；文件=blob-util 读取；大文件=空数组——字节不进内存，v2 分片读 localPath） */
  bytes: Uint8Array;
  /** 登记副本的本地 URI（历史缩略图/芯片渲染源） */
  localUri: string;
  /** 登记副本裸磁盘路径（v2 分片上传的流式读源；无 file:// 前缀） */
  localPath?: string;
  kind: 'image' | 'file';
  size: number;
}

export type PickSource = 'gallery' | 'camera' | 'document';

const uuid = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

/** Android Uri.toString() 会对路径做 percent 编码（真机实测：中文名文件编码形态 stat 必失败）——
 *  解码回磁盘真实路径；非法编码序列（孤立 % 等）按原样返回（让后续 stat 报原路径，错误可读） */
function decodeUriPath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** App 私有附件目录（不存在则建） */
async function ensurePrivateDir(): Promise<string> {
  const dir = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/chill-attachments`;
  const exists = await ReactNativeBlobUtil.fs.isDir(dir);
  if (!exists) await ReactNativeBlobUtil.fs.mkdir(dir);
  return dir;
}

/** 字节落私有目录 + sentAttachments 登记（历史渲染联查的登记侧）。
 *  localUri 必须带 file:// 前缀——RN <Image> 只认带 scheme 的 URI（真机实测教训：裸路径=空白方框）。
 *  srcPath：已有磁盘副本（document 分支的缓存副本）时 mv 原子入位（同分区 rename，零拷贝）；
 *  缺省 bytes 走 writeFile（gallery/camera 分支字节在内存）。 */
async function registerAttachment(a: Omit<PickedAttachment, 'localUri'>, srcPath?: string): Promise<string> {
  const dir = await ensurePrivateDir();
  const barePath = `${dir}/${a.fileId}`;
  if (srcPath) await ReactNativeBlobUtil.fs.mv(srcPath, barePath);
  else await ReactNativeBlobUtil.fs.writeFile(barePath, bytesToB64(a.bytes), 'base64');
  const localUri = `file://${barePath}`;
  await getSyncDb().putSentAttachment({
    fileId: a.fileId,
    kind: a.kind,
    name: a.name,
    mime: a.mime,
    size: a.size,
    localUri,
    sentAt: new Date().toISOString(),
  });
  return localUri;
}

/** 超限错误（调用方转成含替代路的提示；maxBytes 随入口分档——文档 100MB / 媒体 5MB） */
export class AttachmentTooLargeError extends Error {
  constructor(name: string, size: number, maxBytes: number = FILE_MAX_BYTES) {
    super(`「${name}」${(size / 1024 / 1024).toFixed(1)}MB 超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限`);
  }
}

function assetToBytes(asset: Asset): Uint8Array | null {
  if (!asset.base64) return null;
  return b64ToBytes(asset.base64);
}

/**
 * 采集一个附件（source 决定入口；gallery 支持照片+短视频 mixed）。
 * 返回 null = 用户取消（非错误）；超限抛 AttachmentTooLargeError；其他失败抛 Error。
 */
export async function pickAttachment(source: PickSource): Promise<PickedAttachment | null> {
  if (source === 'gallery' || source === 'camera') {
    const r =
      source === 'gallery'
        ? await launchImageLibrary({
            mediaType: 'mixed',
            selectionLimit: 1,
            includeBase64: true,
            maxWidth: 1568,
            maxHeight: 1568,
            quality: 0.7,
          })
        : await launchCamera({ mediaType: 'photo', includeBase64: true, maxWidth: 1568, maxHeight: 1568, quality: 0.7 });
    if (r.didCancel || r.errorCode) return null;
    const asset = r.assets?.[0];
    if (!asset) return null;
    const isImage = (asset.type ?? '').startsWith('image/');
    if (isImage) {
      const bytes = assetToBytes(asset);
      if (!bytes) throw new Error('无法读取所选媒体的字节');
      if (bytes.length > FILE_MAX_BYTES) throw new AttachmentTooLargeError(asset.fileName ?? '照片', bytes.length);
      const base = {
        fileId: uuid(),
        name: asset.fileName ?? 'photo.jpg',
        mime: asset.type ?? 'image/jpeg',
        bytes,
        kind: 'image' as const,
        size: bytes.length,
      };
      const localUri = await registerAttachment(base);
      return { ...base, localUri };
    }
    // 视频：picker 对视频不返回 base64（getVideoResponseMap 无 includeBase64 分支——视频不可应用尺寸/质量
    // 压缩，全量 base64 进内存更是 OOM 死路）；asset.uri 是库拷好的 App 缓存副本（file://），走磁盘路径模型
    if (!asset.uri) throw new Error('无法获取所选视频的本地路径');
    const videoPath = decodeUriPath(asset.uri.replace('file://', ''));
    const stat = await ReactNativeBlobUtil.fs.stat(videoPath);
    if (stat.size > MEDIA_MAX_BYTES) {
      await ReactNativeBlobUtil.fs.unlink(videoPath).catch(() => {});
      throw new AttachmentTooLargeError(asset.fileName ?? '视频', stat.size, MEDIA_MAX_BYTES);
    }
    // >5MB 不读字节（OOM 红线）——空数组占位，上传走 v2 分片路径流式读登记副本
    const big = stat.size > FILE_MAX_BYTES;
    const bytes = big ? new Uint8Array(0) : b64ToBytes(await ReactNativeBlobUtil.fs.readFile(videoPath, 'base64'));
    const base = {
      fileId: uuid(),
      name: asset.fileName ?? 'video.mp4',
      mime: asset.type ?? 'video/mp4',
      bytes,
      kind: 'file' as const,
      size: stat.size,
    };
    const localUri = await registerAttachment(base, videoPath);
    return { ...base, localUri, localPath: localUri.replace('file://', '') };
  }
  // document：文档/视频（不压缩——MVP 无视频转码；统一 5MB 帽兜底）。
  // Android SAF 返回的是 content:// 能力句柄——不是磁盘路径：blob-util 内部 PathResolver 转真实路径
  // 在 Android 10+ 分区存储下大多失败返 null（实测报 "failed to stat path `null`"，readFile 同链同炸）。
  // copyTo 让原生在选择时用 ContentResolver 流式拷出缓存副本（真实 file:// 路径），
  // 此后 stat/读字节/登记全对副本操作——iOS 安全作用域资源同路受益。
  const doc = await pickSingle({ type: [docTypes.allFiles], copyTo: 'cachesDirectory' });
  // 原生拷贝失败不 reject（fileCopyUri=null + copyError 带 reason）——必须显式拦截，防 null 再漏进下游
  if (!doc.fileCopyUri) {
    throw new Error(doc.copyError ? `文件拷贝失败：${doc.copyError}` : '无法获取所选文件的本地副本');
  }
  const copyPath = decodeUriPath(doc.fileCopyUri.replace('file://', ''));
  const stat = await ReactNativeBlobUtil.fs.stat(copyPath);
  if (stat.size > MEDIA_MAX_BYTES) {
    // 超限即清缓存副本（UUID 空目录留系统清缓存回收），再拒
    await ReactNativeBlobUtil.fs.unlink(copyPath).catch(() => {});
    throw new AttachmentTooLargeError(doc.name ?? '文件', stat.size, MEDIA_MAX_BYTES);
  }
  // >5MB 不读字节（OOM 红线：bytes 全量进内存 + b64 桥传输）——空数组占位，
  // 上传走 v2 分片路径（session.uploadAttachment 分叉），流式哈希/分片读直取登记副本 localPath
  const big = stat.size > FILE_MAX_BYTES;
  const bytes = big ? new Uint8Array(0) : b64ToBytes(await ReactNativeBlobUtil.fs.readFile(copyPath, 'base64'));
  const base = {
    fileId: uuid(),
    name: doc.name ?? 'attachment',
    mime: doc.type ?? 'application/octet-stream',
    bytes,
    kind: 'file' as const,
    size: stat.size,
  };
  const localUri = await registerAttachment(base, copyPath);
  return { ...base, localUri, localPath: localUri.replace('file://', '') };
}
