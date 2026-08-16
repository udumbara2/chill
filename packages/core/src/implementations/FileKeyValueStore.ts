import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { IKeyValueStore } from '../interfaces/IKeyValueStore'

export class FileKeyValueStore implements IKeyValueStore {
  private data: Map<string, string>
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    this.data = new Map()
    this.load()
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    const json = readFileSync(this.filePath, 'utf-8')
    const parsed = JSON.parse(json) as Record<string, string>
    for (const [key, value] of Object.entries(parsed)) {
      this.data.set(key, value)
    }
  }

  private persist(): void {
    const obj: Record<string, string> = {}
    for (const [key, value] of this.data) {
      obj[key] = value
    }
    writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf-8')
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
    this.persist()
  }

  removeItem(key: string): void {
    this.data.delete(key)
    this.persist()
  }

  clear(): void {
    this.data.clear()
    this.persist()
  }
}
