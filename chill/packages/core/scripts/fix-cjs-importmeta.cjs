/**
 * CJS 后处理脚本：将 import.meta.url 替换为 CJS 兼容值
 *
 * TypeScript 的 CJS 编译器会原样输出 import.meta.url，
 * 但 CJS 模块加载器不支持该语法。因所有 import.meta.url
 * 引用都位于 `typeof __dirname === 'string'` 为 true 的分支之外
 * （在 CJS 中永远不执行），故替换为任意合法字面量即可。
 */
const fs = require('fs')
const path = require('path')

const cjsDistDir = path.join(__dirname, '..', 'dist', 'cjs')

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkDir(fullPath)
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      let content = fs.readFileSync(fullPath, 'utf8')
      if (content.includes('import.meta')) {
        const original = content
        // 替换 import.meta.url（包括可选链形式 import.meta?.url）
        content = content.replace(/\bimport\.meta\??\.url\b/g, "'file:///cjs-build-dummy-url'")
        if (content !== original) {
          fs.writeFileSync(fullPath, content, 'utf8')
          console.log(`[fix-cjs-importmeta] Patched: ${path.relative(cjsDistDir, fullPath)}`)
        }
      }
    }
  }
}

walkDir(cjsDistDir)
console.log('[fix-cjs-importmeta] Done')
