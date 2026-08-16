const fs = require('fs')
const path = require('path')

const distDir = path.join(__dirname, '..', 'dist')

function addJsExtensions(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      addJsExtensions(fullPath)
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      let content = fs.readFileSync(fullPath, 'utf8')
      const original = content
      content = content.replace(
        /(from\s*['"])(\.\.?\/[^'"]+?)(['"])/g,
        (match, prefix, relPath, quote) => {
          if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) {
            return match
          }
          const resolved = path.resolve(path.dirname(fullPath), relPath)
          const jsFile = resolved + '.js'
          const dirIndex = path.join(resolved, 'index.js')
          if (fs.existsSync(dirIndex)) {
            return prefix + relPath + '/index.js' + quote
          }
          if (fs.existsSync(jsFile)) {
            return prefix + relPath + '.js' + quote
          }
          return match
        }
      )
      content = content.replace(
        /(import\s*\(\s*['"])(\.\.?\/[^'"]+?)(['"]\s*\))/g,
        (match, prefix, relPath, suffix) => {
          if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) {
            return match
          }
          const resolved = path.resolve(path.dirname(fullPath), relPath)
          const jsFile = resolved + '.js'
          const dirIndex = path.join(resolved, 'index.js')
          if (fs.existsSync(dirIndex)) {
            return prefix + relPath + '/index.js' + suffix
          }
          if (fs.existsSync(jsFile)) {
            return prefix + relPath + '.js' + suffix
          }
          return match
        }
      )
      if (content !== original) {
        fs.writeFileSync(fullPath, content, 'utf8')
      }
    }
  }
}

addJsExtensions(distDir)
