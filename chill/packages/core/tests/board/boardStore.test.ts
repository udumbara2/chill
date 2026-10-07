import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { block, claim, createBoard, post, settle } from '../../src/services/board/boardCore.ts'
import { BoardStore } from '../../src/services/board/boardStore.ts'
import { BoardError, type BoardState } from '../../src/services/board/boardTypes.ts'

async function makeStore(): Promise<{ store: BoardStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'board-store-'))
  return { store: new BoardStore(dir), dir }
}

test('save/load 存取往返 + exists', async () => {
  const { store, dir } = await makeStore()
  try {
    assert.equal(await store.exists('sess-1'), false)
    assert.equal(await store.load('sess-1'), undefined)

    let state = createBoard('sess-1')
    const p = post(state, { title: '调研', createdBy: 'lead', note: '提议' })
    state = p.state
    await store.save(state)

    assert.equal(await store.exists('sess-1'), true)
    const loaded = await store.load('sess-1')
    assert.equal(loaded!.boardId, 'sess-1')
    assert.equal(loaded!.revision, state.revision)
    assert.equal(loaded!.items.length, 1)
    assert.equal(loaded!.items[0].title, '调研')
    assert.equal(loaded!.items[0].note, '提议')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('原子写:tmp+rename,落盘后无 .tmp 残留', async () => {
  const { store, dir } = await makeStore()
  try {
    let state = createBoard('sess-1')
    state = post(state, { title: 'A', createdBy: 'lead' }).state
    await store.save(state)
    state = claim(state, state.items[0].id, { assignee: 'w1', claimedByTaskId: 't1' }).state
    await store.save(state)

    const files = await readdir(dir)
    assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), [])
    assert.deepEqual(files, ['sess-1.json'])
    const raw = JSON.parse(await readFile(join(dir, 'sess-1.json'), 'utf8')) as BoardState
    assert.equal(raw.items[0].status, 'in_progress')
    assert.equal(raw.items[0].claimedByTaskId, 't1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('目录不存在则建', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-store-'))
  const nested = join(dir, 'a', 'b', 'boards')
  try {
    const store = new BoardStore(nested)
    await store.save(createBoard('sess-2'))
    assert.equal(await store.exists('sess-2'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('结清快照保留:save 不因结清删除文件', async () => {
  const { store, dir } = await makeStore()
  try {
    let state = createBoard('sess-1')
    const p = post(state, { title: 'A', createdBy: 'lead' })
    state = p.state
    state = claim(state, p.item.id, { assignee: 'w1' }).state
    state = settle(state, p.item.id, 'completed', { result: '交付' }).state
    await store.save(state)
    assert.equal(await store.exists('sess-1'), true)
    const again = await store.save(state)
    assert.equal(again, undefined)
    assert.equal(await store.exists('sess-1'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('archiveBoard:在途条目全部 cancelItem 留痕,终态不动,落盘归档标记', async () => {
  const { store, dir } = await makeStore()
  try {
    let state = createBoard('sess-1')
    const p1 = post(state, { title: '待认领', createdBy: 'lead' })
    state = p1.state
    const p2 = post(state, { title: '进行中', createdBy: 'lead' })
    state = p2.state
    const p3 = post(state, { title: '已完成', createdBy: 'lead' })
    state = p3.state
    const p4 = post(state, { title: '受阻', createdBy: 'lead' })
    state = p4.state
    state = claim(state, p2.item.id, { assignee: 'w1', claimedByTaskId: 't1' }).state
    state = claim(state, p3.item.id, { assignee: 'w2' }).state
    state = settle(state, p3.item.id, 'completed', { result: '交付' }).state
    state = claim(state, p4.item.id, { assignee: 'w1' }).state
    state = block(state, p4.item.id, { reason: '等拍板' }, { role: 'worker', assignee: 'w1' }).state
    await store.save(state)

    const archived = await store.archiveBoard('sess-1', '会话删除')
    const byId = new Map(archived.items.map((i) => [i.id, i]))
    assert.equal(byId.get(p1.item.id)!.status, 'cancelled')
    assert.equal(byId.get(p2.item.id)!.status, 'cancelled')
    assert.equal(byId.get(p4.item.id)!.status, 'cancelled')
    assert.equal(byId.get(p3.item.id)!.status, 'completed') // 终态不动
    assert.match(byId.get(p2.item.id)!.releaseHistory!.at(-1)!.reason, /看板归档:会话删除/)
    assert.match(byId.get(p4.item.id)!.releaseHistory!.at(-1)!.reason, /看板归档:会话删除/)
    assert.equal(typeof archived.archivedAt, 'number')
    assert.equal(archived.archiveReason, '会话删除')

    // 落盘保留(归档标记已写入,文件不删)
    const loaded = await store.load('sess-1')
    assert.equal(loaded!.archiveReason, '会话删除')
    assert.equal(loaded!.items.length, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('archiveBoard:板不存在抛 ITEM_NOT_FOUND', async () => {
  const { store, dir } = await makeStore()
  try {
    await assert.rejects(store.archiveBoard('nope', 'x'), (err: unknown) => err instanceof BoardError && err.code === 'ITEM_NOT_FOUND')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('boardId 含非法字符抛 INVALID_INPUT;快照损坏响亮报错', async () => {
  const { store, dir } = await makeStore()
  try {
    await assert.rejects(store.load('a/b'), (err: unknown) => err instanceof BoardError && err.code === 'INVALID_INPUT')
    await writeFile(join(dir, 'bad.json'), '{ not json', 'utf8')
    await assert.rejects(store.load('bad'), /看板快照损坏/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
