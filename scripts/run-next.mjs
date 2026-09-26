#!/usr/bin/env node
/**
 * run-next.mjs —— 跨平台启动 Next.js（dev / start）。
 *
 * 为什么需要这层包装：
 *   原来 package.json 里写的是
 *       next start -p ${PORT:-3000} -H 0.0.0.0
 *   这是 **Linux/macOS 的 shell 语法**（默认值展开）。
 *   Windows 的 cmd / PowerShell **不认** `${PORT:-3000}`，
 *   会原样把它当成端口号传给 next，直接报：
 *       error: option '-p, --port <port>' argument '${PORT:-3000}' is invalid.
 *   也就是说「在 Windows 上 clone 下来根本起不来」。
 *
 *   注意：Windows 下由 npm/pnpm 执行 script 时走的是 cmd.exe，
 *   即便用户用的是 PowerShell，`${VAR:-default}` 一样不会生效 ——
 *   不能指望用户手动配环境变量绕过，必须从代码层面解决。
 *
 * 解决方式：
 *   把端口解析搬到 Node 里（Node 在所有平台行为一致），
 *   再以子进程方式调起 next 的 CLI。这样 `pnpm start` 在
 *   Windows / macOS / Linux 上都只需要这一条命令。
 *
 * 用法：
 *   node scripts/run-next.mjs dev      # 开发模式
 *   node scripts/run-next.mjs start    # 生产模式
 *
 * 端口优先级：PORT 环境变量 > 3000（默认）
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv, reportEnv, ROOT } from './load-env.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const mode = process.argv[2]
if (mode !== 'dev' && mode !== 'start') {
  console.error(`[run-next] 未知模式: ${mode ?? '(空)'}，只支持 dev / start`)
  process.exit(1)
}

// 端口：显式 PORT 优先；解析失败或非法则回退 3000，不因环境变量写错而起不来
const rawPort = process.env.PORT ?? ''
const parsed = Number.parseInt(rawPort, 10)
const port = Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3000
if (rawPort && String(port) !== rawPort.trim()) {
  console.warn(`[run-next] PORT="${rawPort}" 不是合法端口，已回退到 ${port}`)
}

// 生产模式要求先 build 过，否则 next start 会报找不到 .next
if (mode === 'start' && !existsSync(path.join(ROOT, '.next'))) {
  console.error(
    '\n[run-next] 还没构建过，找不到 .next 目录。\n' +
      '           请先执行：npm run build\n'
  )
  process.exit(1)
}

/**
 * ── 加载环境变量（零配置可跑的关键）──
 *
 * 实测过的两个坑：
 *   1) `next start` **不会**自动读 .env（只有 `next dev` 会），
 *      而 DATABASE_URL 来自 env → 没设值就 500。
 *   2) 干净目录解压后**根本没有 .env** → `next dev` 同样 500。
 *
 * 所以这里统一由 load-env.mjs 处理：
 *   · 有 .env 就加载（**已存在的环境变量优先**，平台注入的值不会被盖掉）；
 *   · 没有就补默认值（DATABASE_URL=file:./dev.db、LLM_PROVIDER=mock），
 *     保证"解压 → npm install → 起服务"就能看到包内自带的演示数据。
 */
reportEnv(loadEnv())

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)
const nodeMinor = Number.parseInt(process.versions.node.split('.')[1] ?? '0', 10)
const supportsEnvFileIfExists = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 9)
const envFile = path.join(ROOT, '.env')

const nextBin = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')

const args = []
// 有 .env 且 Node 支持时，再用原生 flag 兜一层：
// 这样 Next 自己的子进程（如 middleware / server components 里读 process.env）
// 也能拿到，与 load-env 互补，不冲突（同样是"已存在的不覆盖"）。
if (existsSync(envFile) && supportsEnvFileIfExists) {
  args.push('--env-file-if-exists=' + envFile)
}
args.push(nextBin, mode, '-p', String(port), '-H', '0.0.0.0')

console.log(`\n  ▲ MethodAtlas · next ${mode}\n  - Local:   http://localhost:${port}\n`)

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  cwd: ROOT,
  // Windows 下 next 的 CLI 是 JS，用 node 直接跑最稳，不依赖 shell 解析
  shell: false,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
