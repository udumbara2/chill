import { register } from 'node:module'
register('./tsImportHook.mjs', import.meta.url)
