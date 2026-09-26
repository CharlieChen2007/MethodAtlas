#!/usr/bin/env node
/**
 * prisma-cli.mjs —— Prisma CLI 的包装器（**解决"解压后 db:push 直接失败"**）
 *
 * 用法：
 *   node scripts/prisma-cli.mjs generate
 *   node scripts/prisma-cli.mjs push
 *   node scripts/prisma-cli.mjs studio
 *
 * ── 为什么不能直接写 `prisma db push` ──
 *   两个实测问题：
 *
 *   1) **缺 DATABASE_URL 就硬失败**（P1012）。
 *      干净目录解压后没有 .env，`npm run db:push` 直接报
 *      "Environment variable not found: DATABASE_URL" —— 用户第一步就卡住。
 *      本包装器先走 load-env.mjs 补齐默认值（file:./dev.db），保证能跑。
 *
 *   2) **`npx prisma` 会去网上拉一个新版本**（实测拉到 Prisma 8 rc），
 *      报 `CLI.UNKNOWN_COMMAND ... No command registered for 'push'`。
 *      这在使用者**还没跑 npm install** 时一定发生 —— 而那时他正需要
 *      `npm run db:push` 来建库，很容易误判成"项目坏了"。
 *      本包装器直接用 node_modules 里的 prisma CLI，不走 npx，不会漂版本。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadEnv, reportEnv, ROOT } from './load-env.mjs'

const sub = process.argv[2]
if (!sub) {
  console.error('[prisma-cli] 缺少子命令，用法：node scripts/prisma-cli.mjs <generate|push|studio>')
  process.exit(1)
}

reportEnv(loadEnv())

const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js')
if (!existsSync(cli)) {
  console.error(
    '\n[prisma-cli] 找不到 node_modules/prisma —— 依赖还没装。\n' +
      '            请先执行：npm install\n'
  )
  process.exit(1)
}

// `push` 在 CLI 里实际叫 `db push`；这里把常用简写映射到真实子命令
const argsMap = {
  generate: ['generate'],
  push: ['db', 'push'],
  studio: ['studio'],
}
const args = argsMap[sub]
if (!args) {
  console.error(`[prisma-cli] 不支持的子命令：${sub}（支持 generate / push / studio）`)
  process.exit(1)
}

const child = spawn(process.execPath, [cli, ...args], {
  stdio: 'inherit',
  cwd: ROOT,
  shell: false,
  env: process.env,
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
