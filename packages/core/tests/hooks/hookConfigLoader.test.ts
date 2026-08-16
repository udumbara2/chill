import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HookConfigLoader } from '../../src/services/hooks/HookConfigLoader.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

const CONFIG_PATH = '/home/user/.chill/hooks.json'

/** 内存假 fsProvider（同 IFileSystemProvider 形状），带 readFile 调用计数 */
function makeFakeFs(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles))
  const counters = { readFile: 0, fileExists: 0 }
  const fs: IFileSystemProvider = {
    readFile: async (p: string) => {
      counters.readFile++
      const content = files.get(p)
      return content === undefined ? { success: false, error: 'not found' } : { success: true, data: { content } }
    },
    writeFile: async (p: string, content: string) => {
      files.set(p, content)
      return { success: true }
    },
    deleteFile: async (p: string) => {
      files.delete(p)
      return { success: true }
    },
    listDirectory: async () => ({ success: true, data: { files: [] } }),
    getCurrentDirectory: () => null,
    fileExists: async (p: string) => {
      counters.fileExists++
      return { success: true, data: files.has(p) }
    },
    getPathType: async (p: string) => ({
      success: true,
      data: { type: files.has(p) ? ('file' as const) : ('not_found' as const) },
    }),
  }
  return { fs, files, counters }
}

/** 假 mtime provider：value 由测试手动拨动 */
function makeFakeMtime(initial: number | null = 1000) {
  const state = { value: initial as number | null, calls: 0 }
  return {
    state,
    provider: {
      getMtimeMs: async () => {
        state.calls++
        return state.value
      },
    },
  }
}

const VALID_CONFIG = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: 'execute_powershell',
        hooks: [{ name: 'guard', type: 'command', command: 'node guard.mjs', timeout: 5, failClosed: true }],
      },
    ],
  },
})

test('加载合法配置：结构解析正确，默认值补齐', async () => {
  const { fs } = makeFakeFs({ [CONFIG_PATH]: VALID_CONFIG })
  const mtime = makeFakeMtime()
  const loader = new HookConfigLoader(fs, CONFIG_PATH, mtime.provider)

  const config = await loader.checkReload()
  const groups = config.PreToolUse!
  assert.equal(groups.length, 1)
  assert.equal(groups[0].matcher, 'execute_powershell')
  const handler = groups[0].hooks[0]
  assert.equal(handler.name, 'guard')
  assert.equal(handler.command, 'node guard.mjs')
  assert.equal(handler.timeout, 5)
  assert.equal(handler.failClosed, true)
  assert.deepEqual(loader.getErrors(), [])
})

test('配置缺省字段：type 缺省 command，timeout 默认 30，failClosed 默认 false', async () => {
  const { fs } = makeFakeFs({
    [CONFIG_PATH]: JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node check.mjs' }] }] } }),
  })
  const loader = new HookConfigLoader(fs, CONFIG_PATH, makeFakeMtime().provider)

  const config = await loader.checkReload()
  const handler = config.Stop![0].hooks[0]
  assert.equal(handler.type, 'command')
  assert.equal(handler.timeout, 30)
  assert.equal(handler.failClosed, false)
})

test('文件不存在：视为空配置，无错误', async () => {
  const { fs } = makeFakeFs()
  const loader = new HookConfigLoader(fs, CONFIG_PATH, makeFakeMtime().provider)

  const config = await loader.checkReload()
  assert.deepEqual(config, {})
  assert.deepEqual(loader.getErrors(), [])
})

test('JSON 损坏：fail-open 视为无配置 + 收集错误', async () => {
  const { fs } = makeFakeFs({ [CONFIG_PATH]: '{ 这不是合法 JSON' })
  const loader = new HookConfigLoader(fs, CONFIG_PATH, makeFakeMtime().provider)

  const config = await loader.checkReload()
  assert.deepEqual(config, {})
  assert.equal(loader.getErrors().length, 1)
  assert.match(loader.getErrors()[0], /JSON 解析失败/)
})

test('结构非法：根节点非对象 / hooks 字段非对象 / 事件值非数组逐项容错', async () => {
  const { fs, files } = makeFakeFs({ [CONFIG_PATH]: JSON.stringify(['不是对象']) })
  const mtime = makeFakeMtime()
  const loader = new HookConfigLoader(fs, CONFIG_PATH, mtime.provider)

  assert.deepEqual(await loader.checkReload(), {})
  assert.match(loader.getErrors()[0], /根节点必须是对象/)

  files.set(CONFIG_PATH, JSON.stringify({ hooks: { PreToolUse: '不是数组' } }))
  mtime.state.value = 2000
  assert.deepEqual(await loader.checkReload(), {})
  assert.match(loader.getErrors()[0], /必须是 matcher 组数组/)
})

test('未知事件名跳过并记录错误，合法事件不受影响', async () => {
  const { fs } = makeFakeFs({
    [CONFIG_PATH]: JSON.stringify({
      hooks: {
        NotAnEvent: [{ hooks: [{ command: 'x' }] }],
        SessionEnd: [{ hooks: [{ command: 'node backup.mjs' }] }],
      },
    }),
  })
  const loader = new HookConfigLoader(fs, CONFIG_PATH, makeFakeMtime().provider)

  const config = await loader.checkReload()
  assert.equal(config.NotAnEvent, undefined)
  assert.equal(config.SessionEnd!.length, 1)
  assert.equal(loader.getErrors().length, 1)
  assert.match(loader.getErrors()[0], /未知 hook 事件/)
})

test('非法 handler（缺 command / type 非法）跳过，同组合法 handler 保留', async () => {
  const { fs } = makeFakeFs({
    [CONFIG_PATH]: JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'write_file',
            hooks: [
              { command: '' },
              { type: 'http', command: 'x' },
              { command: 'node fmt.mjs' },
            ],
          },
        ],
      },
    }),
  })
  const loader = new HookConfigLoader(fs, CONFIG_PATH, makeFakeMtime().provider)

  const config = await loader.checkReload()
  const handlers = config.PostToolUse![0].hooks
  assert.equal(handlers.length, 1)
  assert.equal(handlers[0].command, 'node fmt.mjs')
  assert.equal(loader.getErrors().length, 2)
})

test('mtime 惰性重载：mtime 不变零读盘，变化才重读重解析', async () => {
  const { fs, files, counters } = makeFakeFs({ [CONFIG_PATH]: VALID_CONFIG })
  const mtime = makeFakeMtime(1000)
  const loader = new HookConfigLoader(fs, CONFIG_PATH, mtime.provider)

  await loader.checkReload()
  assert.equal(counters.readFile, 1, '首次加载读一次')

  // mtime 不变：连续派发不再读盘
  await loader.checkReload()
  await loader.checkReload()
  assert.equal(counters.readFile, 1, 'mtime 未变不得重读')
  assert.ok(mtime.state.calls >= 3, '每次都廉价 stat')

  // mtime 变化：重读并生效新配置
  files.set(CONFIG_PATH, JSON.stringify({ hooks: { Notification: [{ hooks: [{ command: 'node n.mjs' }] }] } }))
  mtime.state.value = 2000
  const config = await loader.checkReload()
  assert.equal(counters.readFile, 2)
  assert.equal(config.PreToolUse, undefined, '旧配置被替换')
  assert.equal(config.Notification!.length, 1)

  // 文件被删除：mtime 变 null，重读后视为空配置
  files.delete(CONFIG_PATH)
  mtime.state.value = null
  const afterDelete = await loader.checkReload()
  assert.deepEqual(afterDelete, {})
})

test('无 mtimeProvider 时退化为每次重读（仍是动作触发，无轮询）', async () => {
  const { fs, counters } = makeFakeFs({ [CONFIG_PATH]: VALID_CONFIG })
  const loader = new HookConfigLoader(fs, CONFIG_PATH)

  await loader.checkReload()
  await loader.checkReload()
  assert.equal(counters.readFile, 2, '无 mtime 能力时保守重读')
})
