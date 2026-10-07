import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IPathProvider } from '@assistant-ai/core'

export class ElectronPathProvider implements IPathProvider {
  getUserDataPath(): string {
    return join(homedir(), '.chill')
  }

  getUserHomePath(): string {
    return homedir()
  }
}
