#!/usr/bin/env node
/**
 * db-reset.mjs —— 重置数据库（跨平台）。
 *
 * 为什么需要这层包装：
 *   原 package.json 里写的是 `rm -f prisma/dev.db && prisma db push`。
 *   `rm` 在 Windows 的 cmd 里不存在；PowerShell 里 `rm` 虽然是
 *   Remove-Item 的别名，但 `-f` 参数语义不同，同样会失败。
 *   所以这条脚本在 Windows 上必然跑不通。
 *
 *   用 Node 的 fs 删除文件，三个平台行为一致。
 *
 * 用法：pnpm db:reset
 */

import { rmSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DB = path.join(ROOT, 'prisma', 'dev.db')

if (existsSync(DB)) {
  rmSync(DB, { force: true })
  // SQLite 的 WAL / 日志文件也一并清掉，避免残留导致 schema 不一致
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const extra = DB + suffix
    if (existsSync(extra)) rmSync(extra, { force: true })
  }
  console.log('[db-reset] 已删除 prisma/dev.db')
} else {
  console.log('[db-reset] prisma/dev.db 不存在，跳过删除')
}

const prismaBin = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js')
const child = spawn(process.execPath, [prismaBin, 'db', 'push'], {
  stdio: 'inherit',
  cwd: ROOT,
})

child.on('exit', (code) => {
  if (code === 0) {
    console.log('\n[db-reset] 数据库已重建。如需演示数据，请执行：pnpm seed')
  }
  process.exit(code ?? 0)
})
