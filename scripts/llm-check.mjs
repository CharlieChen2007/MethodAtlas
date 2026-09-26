#!/usr/bin/env node
/**
 * llm-check.mjs —— LLM 连通性自检（**只读，不写库、不启服务**）。
 *
 * 为什么需要它：
 *   以前要验证「真 LLM 到底通没通」，得先把服务起起来、再手动 curl 一个
 *   业务接口、再去翻 /api/llm-status —— 中间任何一步配错（端口、action 名、
 *   是否开了 ENABLE_PIPELINE_API）都会让人以为是「LLM 不通」。
 *
 *   本脚本把这件事压成一条命令：直接拿 .env 里的配置调一次真实接口，
 *   把 HTTP 状态、耗时、token 用量、模型回答原样打出来。
 *
 * 用法（在项目根执行）：
 *     node scripts/llm-check.mjs
 *     node scripts/llm-check.mjs --key sk-xxx         # 临时换 Key（不写盘）
 *     node scripts/llm-check.mjs --model hy3   # 临时换模型
 *     node scripts/llm-check.mjs --base https://xxx/v1
 *     node scripts/llm-check.mjs --no-probe           # 跳过「已知端点横比」
 *     node scripts/llm-check.mjs --json               # 只输出 JSON（给脚本用）
 *
 * 退出码：0 = 连通；1 = 不通（原因已在输出里）。
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const line = '─'.repeat(64)

/* ────────────────────────── 参数 ────────────────────────── */

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const AS_JSON = argv.includes('--json')
const NO_PROBE = argv.includes('--no-probe')

/* ───────────────────────── 读 .env ─────────────────────────
 * 不引 dotenv：旧 Node（<20.6 无 --env-file）也要能跑，
 * 手写解析几十行就够，且避免多一个依赖。
 * 值两端引号剥掉（引号内的 # 不当注释，避免密钥含 # 被截断）。
 * ────────────────────────────────────────────────────────── */

function loadEnv(file) {
  if (!existsSync(file)) return {}
  const out = {}
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = raw.trim()
    if (!s || s.startsWith('#')) continue
    const eq = s.indexOf('=')
    if (eq <= 0) continue
    const key = s.slice(0, eq).trim()
    let val = s.slice(eq + 1).trim()
    const quoted =
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    if (quoted) val = val.slice(1, -1)
    else {
      const h = val.indexOf(' #')
      if (h >= 0) val = val.slice(0, h).trim()
    }
    out[key] = val
  }
  return out
}

const env = loadEnv(path.join(ROOT, '.env'))

const provider = (flag('--provider') || env.LLM_PROVIDER || 'mock').trim()
const model = (flag('--model') || env.LLM_MODEL || '').trim()
const apiKey = (flag('--key') || env.LLM_API_KEY || '').trim()
const baseUrl = (flag('--base') || env.LLM_BASE_URL || 'https://api.openai.com/v1')
  .trim()
  .replace(/\/+$/, '')
const timeoutMs = Number(flag('--timeout') || env.LLM_TIMEOUT_MS || 120000)

/* ───────────────────── 已知端点（用于横比诊断）─────────────────────
 * 当主端点失败时，用同一把 Key 挨个打一遍：
 *   - 若另一个端点成功 → 不是 Key 坏，是**端点和 Key 不配套**
 *   - 若全部同样的错     → 是这把 Key 本身有问题（或没开通/欠费）
 * 这一步是「把 401 从'密钥无效'细分到'密钥用错了地方'」的关键。
 *
 * 腾讯系产品线的 Key 互不通用，且拒绝时报错几乎一模一样 —— 这是本项目
 * 实际踩过的最大一个坑，所以直接固化成探测集，不用每次靠对话排查。
 * ───────────────────────────────────────────────────────────────── */

const KNOWN_ENDPOINTS = [
  {
    name: 'DeepSeek 开放平台',
    base: 'https://api.deepseek.com/v1',
    note: '官方直连。Key 在 platform.deepseek.com → API keys 创建。模型名不带命名空间：deepseek-chat / deepseek-reasoner',
  },
  {
    name: 'TokenHub 在线推理',
    base: 'https://tokenhub.tencentmaas.com/v1',
    note: '按量付费。Key 在「TokenHub → API Key 管理」创建。模型名须带命名空间，如 deepseek/deepseek-flash',
  },
  {
    name: 'TokenHub Token Plan',
    base: 'https://api.lkeap.cloud.tencent.com/plan/v3',
    note: '包月套餐。Key 在「TokenHub → Token Plan」页创建',
  },
  {
    name: '混元原子能力',
    base: 'https://api.hunyuan.cloud.tencent.com/v1',
    note: '按量。Key 在「混元大模型 → API Key」页创建',
  },
]

/* ─────────────────────────── 工具 ─────────────────────────── */

const failures = []

function mask(key) {
  if (!key) return '(空)'
  if (key.length <= 12) return key.slice(0, 3) + '***'
  return `${key.slice(0, 8)}…${key.slice(-4)}（长度 ${key.length}）`
}

function fail(msg, hint) {
  failures.push({ msg, hint })
}

/** 一次 chat/completions 调用；永不抛，全部失败都归到返回值里 */
async function probe(base, key, mdl, ms) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  const t0 = Date.now()
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: mdl,
        messages: [{ role: 'user', content: '请只输出：ping' }],
        temperature: 0,
        max_tokens: 8,
      }),      signal: ctl.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON（HTML 错误页等） */
    }
    clearTimeout(timer)
    return { status: res.status, ok: res.ok, json, text, ms: Date.now() - t0 }
  } catch (err) {
    clearTimeout(timer)
    const aborted = err?.name === 'AbortError'
    return {
      status: 0,
      ok: false,
      json: null,
      text: aborted ? `请求超时（>${ms}ms）` : `网络层失败：${err?.message || err}`,
      ms: Date.now() - t0,
      network: true,
      aborted,
    }
  }
}

/** 把服务端错误翻译成「你该改什么」 */
function diagnose(status, payload, text) {
  const raw = JSON.stringify(payload ?? text ?? '').slice(0, 500)
  const code = payload?.error?.code || payload?.code || ''
  const map = {
    400: [
      '请求被拒（400）。常见原因：模型名不存在 / 参数不被支持。',
      '对照服务商文档核对 LLM_MODEL。**模型名的写法随端点而变**：' +
        'DeepSeek 官方（api.deepseek.com）用不带命名空间的 deepseek-chat / deepseek-reasoner；' +
        '腾讯 TokenHub 用带命名空间的 deepseek/deepseek-flash。端点与模型名不配套就会报错。',
    ],
    401: [
      `密钥无效或未授权（401${code ? ` · ${code}` : ''}）。`,
      '注意：腾讯两条产品线的 401 长得不一样 —— ' +
        '返回 {"code":"not_authorized"} 说明**这个端点不认这把 Key**（多半是端点/密钥不配套）；' +
        '返回 "Incorrect API key provided" 才是**密钥本身无效**。',
    ],
    403: [
      '已认证但无权限（403）。',
      '账号可能未开通该模型、欠费、或 IP 不在白名单。去控制台看该模型的「调用权限」。',
    ],
    404: [
      '端点不存在（404）。',
      'LLM_BASE_URL 可能少了或多了路径段。TokenHub 是 .../plan/v3，本脚本会拼 /chat/completions。',
    ],
    429: ['限流（429）。', '免费额度/速率打满，稍等再试，或去控制台提额。'],
  }
  const [msg, hint] = map[status] || [`服务端返回 ${status}`, '把上面的响应体贴给我，我来判断。']
  return { msg, hint, raw, code }
}

/* ═══════════════════════ ① 配置体检 ═══════════════════════ */

if (!AS_JSON) {
  console.log('')
  console.log('MethodAtlas · LLM 连通性自检')
  console.log(line)
  console.log('① 配置')
  console.log(`   项目根   ${ROOT}`)
  console.log(`   provider ${provider}`)
  console.log(`   model    ${model || '(空)'}`)
  console.log(`   base     ${baseUrl}`)
  console.log(`   key      ${mask(apiKey)}`)
  console.log(`   timeout  ${timeoutMs}ms`)
  console.log('')
}

const VALID = ['mock', 'openai-compatible']
if (!VALID.includes(provider)) {
  fail(
    `LLM_PROVIDER=「${provider}」不是合法取值`,
    `只接受 ${VALID.join(' | ')}。想接腾讯云 TokenHub / DeepSeek / 通义千问等，` +
      `填 openai-compatible，用 LLM_BASE_URL 指定端点。`
  )
}

if (provider === 'mock') {
  if (!AS_JSON) {
    console.log('② 结果')
    console.log('   provider=mock —— 这是**本地演示模式**，不需要联网。')
    console.log('   想接真模型：把 .env 里 LLM_PROVIDER 改成 openai-compatible。')
    console.log('')
    console.log('✓ 配置本身是合法的（mock 是合法选项，只是不调用真模型）。')
    console.log('')
  } else {
    console.log(JSON.stringify({ ok: true, provider: 'mock', calledLLM: false }))
  }
  process.exit(0)
}

if (!apiKey || /^(REPLACE|YOUR|xxx|sk-xxxx)/i.test(apiKey)) {
  fail(
    'LLM_API_KEY 看起来还是占位符（或为空）',
    '打开项目根的 .env，把 LLM_API_KEY 换成你的真实密钥；' +
      '或者一条命令临时试：node scripts/llm-check.mjs --key sk-你的密钥'
  )
}
if (!model) {
  fail(
    'LLM_MODEL 为空',
    '按服务商文档填：DeepSeek 官方填 deepseek-chat（不带命名空间）；腾讯 TokenHub 填 deepseek/deepseek-flash（要带命名空间）。'
  )
}
if (!/^https?:\/\//.test(baseUrl)) {
  fail(`LLM_BASE_URL=「${baseUrl}」不是合法 URL`, '必须以 http:// 或 https:// 开头。')
}

if (failures.length) {
  if (!AS_JSON) {
    console.log('② 结果：✗ 配置就有问题，先修这个，不用往下测')
    console.log('')
    for (const f of failures) {
      console.log(`   ✗ ${f.msg}`)
      console.log(`     → ${f.hint}`)
    }
    console.log('')
  } else {
    console.log(JSON.stringify({ ok: false, stage: 'config', failures }))
  }
  process.exit(1)
}

/* ═══════════════════════ ② 真实调用 ═══════════════════════ */

if (!AS_JSON) {
  console.log('② 真实调用')
  console.log(`   POST ${baseUrl}/chat/completions`)
}

const res = await probe(baseUrl, apiKey, model, timeoutMs)

if (!AS_JSON) {
  console.log(
    res.network
      ? `   → ${res.text}  ·  ${res.ms}ms`
      : `   → HTTP ${res.status}  ·  ${res.ms}ms`
  )
  console.log('')
}

const succeeded = res.ok && res.json?.choices?.[0]?.message

/* ───── 失败时：跑「已知端点横比」，把 401 细分清楚 ───── */

if (!succeeded) {
  let probeRows = null

  if (!res.network && !NO_PROBE) {
    if (!AS_JSON) console.log('③ 诊断：用同一把 Key 横比已知端点')

    probeRows = []
    for (const ep of KNOWN_ENDPOINTS) {
      const r = await probe(ep.base, apiKey, model, Math.min(timeoutMs, 60000))
      probeRows.push({
        name: ep.name,
        base: ep.base,
        note: ep.note,
        status: r.network ? 0 : r.status,
        network: Boolean(r.network),
        code: r.json?.error?.code || r.json?.code || '',
      })
      if (!AS_JSON) {
        const mark = r.ok ? '✓' : '✗'
        const label = r.network ? '网络失败' : `HTTP ${r.status}${probeRows.at(-1).code ? ` · ${probeRows.at(-1).code}` : ''}`
        console.log(`   ${mark} ${ep.name.padEnd(22)} ${label.padEnd(28)} ${ep.base}`)
      }
    }

    // 结论：是否有「换端点就成功」的情况
    const winner = probeRows.find((r) => r.status >= 200 && r.status < 300)
    if (!AS_JSON) {
      console.log('')
      if (winner) {
        console.log(`   🎯 找到能用的端点了：${winner.base}`)
        console.log(`      说明 Key 没坏 —— 是「端点与密钥不配套」。`)
        console.log(`      改 .env：LLM_BASE_URL=${winner.base}`)
      } else if (probeRows.every((r) => r.status === 401)) {
        console.log('   → 三个端点全部 401。Key 本身未授权（或未开通/欠费）。')
        console.log('     去控制台确认：① Key 属于哪个产品；② 该产品是否已开通；③ 是否欠费。')
      } else if (probeRows.some((r) => r.network)) {
        console.log('   → 有端点网络不可达，可能是公司代理/防火墙只放通了部分域名。')
      }
      console.log('')
    }
  }

  const d = res.network
    ? {
        msg: res.text,
        hint: res.aborted
          ? '端点可达但没在超时内返回。可调大 LLM_TIMEOUT_MS。'
          : '多半是端点写错、被代理拦、或 DNS 解析不了。',
        raw: '',
      }
    : diagnose(res.status, res.json, res.text)

  if (!AS_JSON) {
    console.log('④ 结果：✗ 未连通')
    console.log('')
    console.log(`   ✗ ${d.msg}`)
    console.log(`     → ${d.hint}`)
    if (d.raw) {
      console.log('')
      console.log('   服务端原话（前 500 字）：')
      console.log(`   ${d.raw}`)
    }
    console.log('')
    if (!res.network) {
      console.log('   注：能拿到业务错误码 = 网络与协议都没问题，只差配置。')
      console.log('')
    }
  } else {
    console.log(
      JSON.stringify({
        ok: false,
        stage: res.network ? 'network' : 'http',
        status: res.network ? null : res.status,
        ...d,
        probes: probeRows,
      })
    )
  }
  process.exit(1)
}

/* ═══════════════════════ ③ 成功 ═══════════════════════ */

const usage = res.json?.usage || null
const answer = res.json.choices[0].message.content ?? null
const tokens = usage
  ? {
      prompt: usage.prompt_tokens ?? 0,
      completion: usage.completion_tokens ?? 0,
      total: usage.total_tokens ?? 0,
    }
  : { prompt: 0, completion: 0, total: 0 }

if (!AS_JSON) {
  console.log('③ 结果：✓ 连通成功')
  console.log('')
  console.log(`   模型回答   ${JSON.stringify(answer)}`)
  console.log(`   耗时       ${res.ms}ms`)
  console.log(
    `   token 用量 prompt=${tokens.prompt} completion=${tokens.completion} total=${tokens.total}`
  )
  if (!usage) console.log('   （响应里没有 usage 字段 —— 有的网关会省略，不影响使用）')
  console.log('')
  console.log(line)
  console.log('下一步：')
  // 统一用 npm：本机 Node 24 上 pnpm 会崩（thread overflow），交付包带的是 package-lock.json
  console.log('   npm install')
  console.log('   npm run db:push')
  console.log('   npm run build')
  console.log('   npm run start')
  console.log('')
  console.log('   然后打开 http://localhost:3000/projects')
  console.log('   （注意：根路径 / 本身没有页面，会 404，这是正常的）')
  console.log('')
} else {
  console.log(
    JSON.stringify({
      ok: true,
      stage: 'done',
      model,
      baseUrl,
      elapsedMs: res.ms,
      answer,
      tokens,
    })
  )
}
process.exit(0)
