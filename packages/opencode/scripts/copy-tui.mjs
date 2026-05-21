import { copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = resolve(__dirname, '..', 'src', 'tui.tsx')
const dest = resolve(__dirname, '..', 'dist', 'tui.tsx')
copyFileSync(src, dest)
console.log('copied tui.tsx to dist/')