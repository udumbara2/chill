import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IPathProvider } from '../interfaces/IPathProvider'

export class NodePathProvider implements IPathProvider {
  getUserDataPath(): string {
    return join(homedir(), '.chill')
  }

  getUserHomePath(): string {
    return homedir()
  }
}
