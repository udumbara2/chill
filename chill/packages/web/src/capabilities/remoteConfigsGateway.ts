/**
 * 远程 Agent 配置存取（M1 增补：治预期降级噪音——真实现而非假成功）
 *
 * 桌面主进程的三个 handler（electron-main.ts L1150-1210）就是朴素 fs 读写
 * ~/.chill/agents/remote/*.json——白名单内的能力，daemon 同款实现，Web 端
 * 远程 Agent 配置真实持久化、与桌面互通。notify-agents-changed 的模板再生成
 * 属编排态（RemoteAgentRegistrar+templateManager），归 M4——M1 数据面已持久化，
 * 通知受理为成功空操作（不伪装：数据落盘为真，模板面 M4 接线）。
 */
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

export class RemoteConfigsGateway {
  private dir: string

  constructor(userDataPath: string) {
    this.dir = join(userDataPath, 'agents', 'remote')
  }

  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
  }

  /** 扫描 remote/*.json → RemoteAgentConfig[]（与桌面 electron-main 同形状） */
  async list(): Promise<unknown> {
    try {
      await this.ensureDir()
      const files = await fsp.readdir(this.dir)
      const configs = await Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map(async (f) => JSON.parse(await fsp.readFile(join(this.dir, f), 'utf-8'))),
      )
      return { success: true, configs }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '读取远程配置失败' }
    }
  }

  /** 写 remote/{key}.json（key 清洗防路径出圈） */
  async save(key: string, config: unknown): Promise<unknown> {
    try {
      await this.ensureDir()
      const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, '_')
      await fsp.writeFile(join(this.dir, `${safe}.json`), JSON.stringify(config, null, 2), 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '写入远程配置失败' }
    }
  }

  async remove(key: string): Promise<unknown> {
    try {
      const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, '_')
      await fsp.unlink(join(this.dir, `${safe}.json`))
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '删除远程配置失败' }
    }
  }
}
