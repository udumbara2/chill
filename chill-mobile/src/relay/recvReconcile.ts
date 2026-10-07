/**
 * recvReconcile.ts — d→m 暂存目录（chill-recv/）对账谓词（纯函数，零 IO）。
 *
 * 职责：输入 ls 条目列表 + 非终态行 fileId 集合 + 在飞拉取集合，输出待删文件的
 * **归一化 basename 列表**（f123 / f123.part）。ls 条目仅用于判定，禁止透传进
 * 删除路径——调用方（session.ts sweepReceivedFiles）unlink 前统一自拼接
 * `${chillRecvDir}/${basename}`，删除路径由代码自构造，与 ls 返回形态彻底无关
 * （真机 Android File.list() 返回文件名形态；归一化内建使其对文件名/全路径两形态等价）。
 *
 * 判定序（fail-closed：任何环节拿不准 = 视为有主跳过，最坏退化=不清，永不误删）：
 *   归一化（非字符串过滤 → split('/').pop()）→ 形状防御 → 有主跳过 → 在飞跳过 → 待删。
 *
 * 形状防御与 mediaFetcher.ts validateIncomingOffer 的 fileId 白名单同源
 * （/^[A-Za-z0-9_-]{1,64}$/——"fileId 兼作暂存文件名，字符白名单防路径穿越"）：
 * 每个入库 fileId 都经过该验证，合法断点/staging 的 basename 必然通过——不存在
 * 误杀窗口；反过来，脏条目/形态漂移产物不满足形状即跳过。
 */

/** fileId 白名单（与 mediaFetcher validateIncomingOffer 同源——修改须两处同步） */
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** .part 断点后缀（staging 明文无后缀，文件名即 fileId） */
const PART_SUFFIX = '.part';

/**
 * 对账谓词。
 * @param entries      ls 返回的原始条目（unknown[]——脏条目防御进入类型面；文件名或全路径形态均可）
 * @param knownFileIds 非终态行（offered/pulling/failed）fileId 集合——有主判据；failed 的 .part 是
 *                     重试续拉断点，绝不可删
 * @param activePulls  在飞拉取 fileId 集合——无主但在飞的暂存跳过（留给下一轮，与"传输中删会话
 *                     照常交付"自洽）
 * @returns 待删文件的归一化 basename 列表（含可选 .part 后缀；无目录前缀、无路径分隔符）
 */
export function reconcileRecvDir(
  entries: readonly unknown[],
  knownFileIds: ReadonlySet<string>,
  activePulls: ReadonlySet<string>,
): string[] {
  const doomed: string[] = [];
  for (const raw of entries) {
    if (typeof raw !== 'string' || raw.length === 0) continue; // 脏条目：跳过（不进待删）
    const basename = raw.split('/').pop() ?? ''; // 归一化：文件名/全路径两形态等价
    const fileId = basename.endsWith(PART_SUFFIX) ? basename.slice(0, -PART_SUFFIX.length) : basename;
    if (!FILE_ID_RE.test(fileId)) continue; // 形状不满足：视为有主跳过（fail-closed）
    if (knownFileIds.has(fileId)) continue; // 有主：非终态行的断点/暂存，状态机自管
    if (activePulls.has(fileId)) continue; // 在飞：拉取进行中，留下一轮
    doomed.push(basename);
  }
  return doomed;
}
