/**
 * load-env.mjs —— 启动期环境变量加载（**零配置可跑的关键**）
 *
 * ── 为什么需要它 ──
 *   实测：把交付包解压到干净目录后**不创建 .env**，结果
 *     · `npm run db:push` → P1012 "Environment variable not found: DATABASE_URL"
 *     · `npm run dev`     → 页面 500（Prisma Client 拿不到 DATABASE_URL）
 *   也就是说"解压就能跑"其实是假的 —— 必须先手工 `cp .env.example .env`。
 *   而这**恰好是最容易被忽略的一步**（README 里那句话在"从源码开发"一节，
 *   不是"快速开始"里最显眼的位置）。
 *
 *   这里把"缺环境变量"从**硬失败**改成**可用默认值**：
 *     · DATABASE_URL 默认指向 prisma/dev.db（相对 schema 所在目录解析，
 *       正是 Prisma 的既有约定，和 .env.example 里的写法一致）；
 *     · LLM_PROVIDER 默认 mock（调用层本来就是这个默认，这里显式写出来，
 *       避免"以为接上了真模型"）。
 *
 * ── 优先级 ──
 *   **已存在的环境变量一律不覆盖。** 平台控制台注入的值 > .env 文件 > 这里的默认值。
 *   这条很重要：部署时密钥是平台注入的，不能被默认值或文件盖掉。
 *
 * ── 为什么自己解析 .env 而不用 node --env-file-if-exists ──
 *   那个 flag 要 Node 22.9+。本项目 README 写的是 Node ≥18，
 *   用 flag 会让低版本 Node 直接起不来。自己解析十几行，兼容性更好。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '..')

/** 解析 .env 文本 → {KEY: value}（不覆盖已存在的 process.env） */
function parseEnvFile(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let val = line.slice(eq + 1).trim()
    // 去掉成对引号（.env.example 里的值是带引号的）
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/**
 * 加载 .env 并补齐必要默认值。
 * @returns {{source: string|null, defaults: string[]}} 供调用方打印诊断信息
 */
export function loadEnv() {
  const applied = []
  const envPath = path.join(ROOT, '.env')
  let source = null

  if (existsSync(envPath)) {
    source = envPath
    const parsed = parseEnvFile(readFileSync(envPath, 'utf8'))
    for (const [k, v] of Object.entries(parsed)) {
      // 已有值（平台注入 / 命令行传入）优先，绝不覆盖
      if (process.env[k] === undefined || process.env[k] === '') {
        process.env[k] = v
        applied.push(k)
      }
    }
  }

  // ── 兜底默认值：保证"没有任何配置也能起来" ──
  const defaults = []
  if (!process.env.DATABASE_URL) {
    // Prisma 把 file:./xxx 解析为**相对 schema.prisma 所在目录**，
    // 所以这就是 <项目根>/prisma/dev.db —— 与 .env.example 完全一致
    process.env.DATABASE_URL = 'file:./dev.db'
    defaults.push('DATABASE_URL=file:./dev.db')
  }
  if (!process.env.LLM_PROVIDER) {
    process.env.LLM_PROVIDER = 'mock'
    defaults.push('LLM_PROVIDER=mock')
  }

  return { source, applied, defaults }
}

/** 打印一条简短诊断（只在有默认值兜底时提示，避免正常启动时刷屏） */
export function reportEnv({ source, defaults }) {
  if (defaults.length > 0) {
    console.log(
      `\n  [env] 未找到可用配置，已使用默认值：${defaults.join('、')}\n` +
        `        数据来自包内自带的演示库，界面可正常浏览。\n` +
        `        想接真模型：把 .env.example 复制为 .env，填 LLM_PROVIDER / LLM_API_KEY 等。\n`
    )
  } else if (source) {
    // 正常情况不刷屏，只有显式要详细时才打（DBG_ENV=1）
    if (process.env.DBG_ENV === '1') {
      console.log(`  [env] 已加载 ${source}`)
    }
  }
}
