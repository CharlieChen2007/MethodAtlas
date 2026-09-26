#!/usr/bin/env node
/**
 * build.mjs —— 生产构建包装器
 *
 * 用法：node scripts/build.mjs
 *
 * ── 为什么 `prisma generate && next build` 这种写法不够 ──
 *   实测：干净目录（没有 .env）下 `npm run build` 会在最后一步失败：
 *
 *     prisma:error  Invalid `prisma.project.findMany()` invocation:
 *                   error: Environment variable not found: DATABASE_URL.
 *     > Export encountered errors on following paths:
 *             /projects/page: /projects
 *
 *   原因：`/projects` 这个路由在构建期被 **静态预渲染**，渲染时会真的查库
 *   （`prisma.project.findMany()`）。所以 **构建阶段就需要 DATABASE_URL**，
 *   不只是运行时需要。而 shell 里的 `&&` 串联不会把"我们补的默认值"传给
 *   `next build` 这个独立进程。
 *
 *   本包装器在**同一个进程里先加载环境变量**，再依次派生子进程，
 *   子进程自然继承 process.env —— 两个阶段拿到的配置完全一致。
 *
 *   注意：这里**不覆盖**已存在的环境变量（load-env 的既定优先级），
 *   所以平台上注入的 DATABASE_URL 依然生效。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadEnv, reportEnv, ROOT } from './load-env.mjs'

// 先补齐环境变量，再让子进程继承
reportEnv(loadEnv())

function run(label, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n[build] ${label}`)
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      cwd: ROOT,
      shell: false,
      env: process.env,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${label} 被信号 ${signal} 终止`))
      else if (code === 0) resolve()
      else reject(new Error(`${label} 退出码 ${code}`))
    })
  })
}

const prismaCli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js')
const nextBin = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')

for (const [name, p] of [['prisma', prismaCli], ['next', nextBin]]) {
  if (!existsSync(p)) {
    console.error(
      `\n[build] 找不到 ${name}（${p}）—— 依赖还没装。\n        请先执行：npm install\n`
    )
    process.exit(1)
  }
}

try {
  // 1) 生成 Prisma Client（构建期渲染页面时要用）
  await run('prisma generate', [prismaCli, 'generate'])
  // 2) Next 生产构建
  await run('next build', [nextBin, 'build'])
  console.log('\n[build] 完成 ✅  下一步：npm run start\n')
} catch (e) {
  console.error(`\n[build] 失败：${e.message}\n`)
  process.exit(1)
}
