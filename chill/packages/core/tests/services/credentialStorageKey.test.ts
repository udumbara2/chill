/**
 * 凭证存储键编解码 + 索引簿 单测（纯函数，Node-free 语义验证）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  storageKeyFor,
  storageKeyToLogical,
  isEncodedStorageKey,
  isSafeCardName,
} from '../../src/services/credentials/storageKey'
import {
  emptyCredentialIndex,
  normalizeCredentialIndex,
  upsertCredentialEntry,
  findLogicalByStorageKey,
  logicalNameForStorageStem,
  loadCredentialIndex,
  saveCredentialIndex,
  type CredentialIndexData,
  type KeyDirTextOps,
} from '../../src/services/credentials/credentialIndex'

test('storageKeyFor：任意字符集产出文件名安全 stem（大小写不敏感文件系统安全）', () => {
  const ids = [
    'xiaomi#token-plan-cn.xiaomimimo.com/v1',
    'zhipu',
    'relay.operatorKey',
    'mcp-metaso',
    '阿里云百炼',
    'my id/with:every*bad?char<>|"and space',
    '',
  ]
  for (const id of ids) {
    const stem = storageKeyFor(id)
    assert.match(stem, /^[B][A-Z0-9-]*$/, `stem 非法: ${id} -> ${stem}`)
    assert.equal(stem, stem.toUpperCase())
  }
})

test('storageKeyFor/ToLogical：编解码往返（完整式）', () => {
  const ids = [
    'xiaomi#token-plan-cn.xiaomimimo.com/v1',
    'zhipu',
    'relay.operatorKey',
    '阿里云百炼',
    'a/b',
    'a#b',
    'a@b-c.d',
  ]
  for (const id of ids) {
    const stem = storageKeyFor(id)
    assert.equal(storageKeyToLogical(stem), id, `往返失败: ${id}`)
    assert.equal(storageKeyFor(id), stem, `不确定: ${id}`)
  }
})

test('往返校验：存量裸名不被误解为编码名', () => {
  // 纯 base32 字面形态的裸名：解码出垃圾也必须被往返校验拒绝
  assert.equal(storageKeyToLogical('zhipu'), null)
  assert.equal(storageKeyToLogical('BABCDEF'), storageKeyToLogical('BABCDEF')) // 幂等无抛
  const fake = 'B' + 'A'.repeat(8)
  // 即便形态吻合，解码值重编码不等则拒绝（构造性验证：BAAAAAAA 解码为 NUL 串，重编码不同）
  const decoded = storageKeyToLogical(fake)
  if (decoded !== null) {
    assert.equal(storageKeyFor(decoded), fake)
  } else {
    assert.equal(isEncodedStorageKey(fake), true) // 形态识别与解码分离
  }
})

test('超长式：确定性、形态可识别、解码返回 null（展示走索引）', () => {
  const longId = 'customprovider#very-long-subdomain.example-company.com/api/v1/organization/projects/models/'
    + 'x'.repeat(200)
  const stem = storageKeyFor(longId)
  assert.ok(stem.length <= 190, `超长 stem 未截断: ${stem.length}`)
  assert.equal(storageKeyFor(longId), stem, '不确定')
  assert.equal(isEncodedStorageKey(stem), true)
  assert.equal(storageKeyToLogical(stem), null, '超长式不应可逆解码')
  // 含截断标记，且与另一个超长 id 区分
  const other = longId + '!'
  assert.notEqual(storageKeyFor(other), stem)
})

test('区分度：近似逻辑 ID 不撞键', () => {
  const pairs = [
    ['a/b', 'a_b'],
    ['a#b', 'a-b'],
    ['xiaomi#x/v1', 'xiaomi#x/v2'],
    ['zhipu', 'ZHIPU'], // 大小写不同逻辑 ID 也必须区分（编码输出均为大写但输入不同）
  ]
  for (const [a, b] of pairs) {
    assert.notEqual(storageKeyFor(a), storageKeyFor(b), `撞键: ${a} vs ${b}`)
  }
})

test('isSafeCardName：放行现存命名形态，拒绝路径/非法字符', () => {
  assert.equal(isSafeCardName('mimo-v2.6-pro'), true)
  assert.equal(isSafeCardName('mimo-v2.6-pro@token-plan-cn'), true)
  assert.equal(isSafeCardName('glm-5.3-coding'), true)
  assert.equal(isSafeCardName('foo/bar'), false)
  assert.equal(isSafeCardName('a b'), false)
  assert.equal(isSafeCardName('a:b'), false)
  assert.equal(isSafeCardName(''), false)
})

test('索引簿：upsert/回查/展示名回退，撕裂解析按空簿继续', () => {
  const data: CredentialIndexData = emptyCredentialIndex()
  upsertCredentialEntry(data, 'xiaomi#token-plan-cn.xiaomimimo.com/v1', 'BXYZ', 'MiMo Token Plan')
  assert.equal(findLogicalByStorageKey(data, 'BXYZ'), 'xiaomi#token-plan-cn.xiaomimimo.com/v1')
  assert.equal(logicalNameForStorageStem(storageKeyFor('zhipu'), data), 'zhipu', '完整式直接解码')
  assert.equal(logicalNameForStorageStem('zhipu', data), 'zhipu', '存量裸名原样（迁移期）')

  const longId = 'p#' + 'q'.repeat(300)
  const longStem = storageKeyFor(longId)
  upsertCredentialEntry(data, longId, longStem, '超长通道')
  assert.equal(logicalNameForStorageStem(longStem, data), longId, '超长式经索引回查逻辑名')

  assert.equal(normalizeCredentialIndex('坏 JSON 形态' as unknown).entries instanceof Object, true)
  const parsed = normalizeCredentialIndex(JSON.parse(JSON.stringify(data)))
  assert.equal(parsed.entries['xiaomi#token-plan-cn.xiaomimimo.com/v1']?.displayName, 'MiMo Token Plan')
})

test('索引簿 I/O：tmp+rename 写入与宽松读', () => {
  const files = new Map<string, string>()
  const ops: KeyDirTextOps = {
    readText: (n) => files.get(n) ?? null,
    writeText: (n, c) => {
      files.set(n, c)
      return true
    },
    rename: (from, to) => {
      const v = files.get(from)
      if (v === undefined) return false
      files.set(to, v)
      files.delete(from)
      return true
    },
    remove: (n) => {
      files.delete(n)
    },
  }
  const data = emptyCredentialIndex()
  upsertCredentialEntry(data, 'zhipu', storageKeyFor('zhipu'))
  assert.equal(saveCredentialIndex(ops, data), true)
  assert.equal(files.has('index.json'), true)
  assert.equal(files.has('index.json.tmp'), false, '应经 rename 收尾')
  const loaded = loadCredentialIndex(ops)
  assert.equal(loaded.entries['zhipu']?.storageKey, storageKeyFor('zhipu'))

  files.set('index.json', '{ 坏掉的')
  assert.deepEqual(loadCredentialIndex(ops), emptyCredentialIndex(), '撕裂索引按空簿，不抛')
})
