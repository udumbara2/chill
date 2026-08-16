import { createWriteStream } from 'node:fs'
import { get } from 'node:https'
import * as http from 'node:http'

/**
 * 从 URL 下载文件到本地路径。支持 HTTP 3xx 重定向。
 * @param url 下载链接
 * @param destPath 目标文件路径
 * @param timeoutMs 超时毫秒数，默认 30000（大文件如下载视频可加大）
 */
export async function downloadFile(url: string, destPath: string, timeoutMs: number = 30000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const followRedirect = (currentUrl: string, maxRedirects: number = 5) => {
      if (maxRedirects <= 0) {
        reject(new Error('重定向次数过多'))
        return
      }

      const parsedUrl = new URL(currentUrl)
      const mod = parsedUrl.protocol === 'https:' ? get : http.get

      const req = mod(currentUrl, { headers: { 'User-Agent': 'chill' } }, (res) => {
        const status = res.statusCode || 0

        if (status >= 300 && status < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, currentUrl).href
          res.resume()
          followRedirect(redirectUrl, maxRedirects - 1)
          return
        }

        if (status < 200 || status >= 300) {
          res.resume()
          reject(new Error(`下载失败: HTTP ${status}`))
          return
        }

        const fileStream = createWriteStream(destPath)
        res.pipe(fileStream)

        fileStream.on('finish', () => {
          fileStream.close(() => resolve())
        })

        fileStream.on('error', (err) => {
          reject(err)
        })

        res.on('error', (err) => {
          reject(err)
        })
      })

      req.on('error', (err) => {
        reject(err)
      })

      req.setTimeout(timeoutMs, () => {
        req.destroy()
        reject(new Error('下载超时'))
      })
    }

    followRedirect(url)
  })
}
