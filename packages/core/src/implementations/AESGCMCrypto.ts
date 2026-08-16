import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const MASTER_KEY_FILE = '.master_key'
const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const NONCE_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export class AESGCMCrypto {
  static initMasterKey(dirPath: string): Buffer {
    mkdirSync(dirPath, { recursive: true })
    const keyPath = join(dirPath, MASTER_KEY_FILE)
    if (existsSync(keyPath)) {
      return readFileSync(keyPath)
    }
    const key = randomBytes(KEY_LENGTH)
    writeFileSync(keyPath, key)
    chmodSync(keyPath, 0o600)
    return key
  }

  static encrypt(masterKey: Buffer, plaintext: string): Uint8Array {
    const nonce = randomBytes(NONCE_LENGTH)
    const cipher = createCipheriv(ALGORITHM, masterKey, nonce)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return new Uint8Array(Buffer.concat([nonce, authTag, encrypted]))
  }

  static decrypt(masterKey: Buffer, data: Buffer): string {
    const nonce = data.subarray(0, NONCE_LENGTH)
    const authTag = data.subarray(NONCE_LENGTH, NONCE_LENGTH + AUTH_TAG_LENGTH)
    const ciphertext = data.subarray(NONCE_LENGTH + AUTH_TAG_LENGTH)
    const decipher = createDecipheriv(ALGORITHM, masterKey, nonce)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }

  static keyExists(dirPath: string): boolean {
    return existsSync(join(dirPath, MASTER_KEY_FILE))
  }
}
