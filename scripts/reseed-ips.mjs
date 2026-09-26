#!/usr/bin/env node
/**
 * reseed-ips.mjs —— 把示例项目从「RAG 三篇」替换为「IPS 三篇」并跑完整链路。
 *
 * 为什么单独写一个脚本而不是改 seed-demo.mjs：
 *   seed-demo.mjs 是**通用演示灌入器**（硬编码 RAG 三篇 + 项目名「示例项目 · RAG
 *   方法演进」），它同时被 pnpm prepack / 文档引用。这一轮的需求是"换掉内置论文"，
 *   属于**内容替换**而不是"改灌入器"—— 直接改 seed-demo 会让它不再能重置演示库，
 *   也会让文档里的命令失真。所以：
 *     · seed-demo.mjs   保持不动（还能重置 RAG 演示库，回滚用）
 *     · reseed-ips.mjs  本脚本，专门做"清旧 → 换 IPS → 跑全链"
 *
 * 它做的事（严格按用户要求）：
 *   1. 删除旧的 RAG 三篇论文**及其所有派生数据**
 *      （DNA、Blocks、Evidence、Relation、Debt、Idea、CrashTest、Surgery）
 *      —— 走 Prisma 级联删项目，一次到位，不留孤儿行。
 *   2. 上传并解析三篇 IPS 论文（走真实解析器 lib/pdf-parse，不伪造数据）。
 *   3. 跑完整链路：DNA → 演化 → 债务 → 想法 → 击穿（全部经 /api/pipeline，
 *      调的是与 UI 完全相同的服务函数）。
 *   4. 体检：逐篇确认 DNA 完整、演化关系、债务都有数据。
 *
 * 用法：
 *   node scripts/reseed-ips.mjs            # 全流程（清旧 + 换新 + 跑链）
 *   node scripts/reseed-ips.mjs --check    # 只体检，不写入
 *   node scripts/reseed-ips.mjs --keep-llm # 不覆盖 LLM_PROVIDER（默认用 .env 的真模型）
 *
 * 前置：
 *   · pnpm db:push 已执行
 *   · 3000 端口有 `ENABLE_PIPELINE_API=1 pnpm start` 在跑
 *   · sample-papers/ips-*.pdf 存在
 *
 * 设计原则（与项目一致）：
 *   -- 走真实服务层：解析用 lib/pdf-parse，抽取用 /api/pipeline 的真实服务函数。
 *      「脚本跑通」等价于「流水线可用」，而不是「数据库里有行」。
 *   -- 幂等：同名项目已存在时默认先删再建（--check 除外）。
 *   -- 不把任何 Key 写进代码：模型配置一律读 .env。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PrismaClient } from '@prisma/client'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const APP_URL = process.env.APP_URL || 'http://localhost:3000'
const SAMPLE_DIR = path.join(ROOT, 'sample-papers')
const STORAGE_DIR = path.join(ROOT, 'storage', 'papers')

/** IPS 三篇 —— 按时间/逻辑排成一条演化链 */
const PROJECT_NAME = '示例项目 · IPS 室内定位方法演进'
const PROJECT_DESC =
  '由 scripts/reseed-ips.mjs 生成：三篇室内定位（IPS）论文，构成一条"单模态→多模态协同→众包扩展"的方法演化链'

const PAPERS = [
  {
    file: 'ips-1-cpd-pdr-wifi.pdf',
    title:
      'A Practical Indoor Positioning System Based on Collaborative PDR and Wi-Fi Fingerprinting',
  },
  {
    file: 'ips-2-wifi-crowdsourced-3d.pdf',
    title:
      'A WiFi Fingerprint Augmentation Method for 3-D Crowdsourced Indoor Positioning Systems',
  },
  {
    file: 'ips-3-pazl-crowdsensing.pdf',
    title: "Pazl: A mobile crowdsensing based indoor WiFi monitoring system",
  },
]

const prisma = new PrismaClient()

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
}

let stepN = 0
function step(t) {
  stepN += 1
  console.log('\n' + c.bold(`── ${t} ──`))
}
const ok = (s) => console.log('  ' + c.green('✔') + ' ' + s)
const warn = (s) => console.log('  ' + c.yellow('!') + ' ' + s)
const fail = (s) => console.log('  ' + c.red('✘') + ' ' + s)

/** 调 /api/pipeline —— 与 UI 完全相同的服务函数 */
async function runPipeline(action, payload) {
  const res = await fetch(`${APP_URL}/api/pipeline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const json = await res.json().catch(() => null)
  return json ?? { ok: false, message: `HTTP ${res.status}` }
}

/**
 * 走真实的 /api/upload —— 与用户在界面上「上传论文」点的是同一条路。
 *
 * 为什么不用 seed-demo 那个 python 解析服务：
 *   ① 那需要额外起 parser-service，本地没有；
 *   ② 更关键 —— 应用真正的上传链路是 `/api/upload → lib/pdf-parse`。
 *      用 UI 同款入口，「脚本跑通」才等价于「界面上传可用」。
 */
async function uploadPaper(projectId, absPath, filename) {
  const buf = readFileSync(absPath)
  const fd = new FormData()
  fd.append('projectId', projectId)
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), filename)

  const res = await fetch(`${APP_URL}/api/upload`, { method: 'POST', body: fd })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.ok) {
    throw new Error(json?.message ?? `上传失败 HTTP ${res.status}`)
  }
  return json
}

async function probeApp() {
  try {
    const res = await fetch(`${APP_URL}/api/pipeline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: '__probe__' }),
    })
    if (res.status === 403) return 'disabled'
    return res.ok || res.status === 400 ? 'ok' : false
  } catch {
    return false
  }
}

/** 读 .env 里真正生效的 LLM 配置（只读，不打印 Key） */
function readEnvModel() {
  const p = path.join(ROOT, '.env')
  if (!existsSync(p)) return null
  const txt = readFileSync(p, 'utf8')
  const lines = txt.split('\n').map((l) => l.trim())
  const effective = lines.filter((l) => /^LLM_MODEL=/.test(l))
  // .env 里有多处注释示例，真正生效的是最后一次赋值
  const last = effective[effective.length - 1]
  return last ? last.replace('LLM_MODEL=', '') : null
}

async function report(projectId) {
  step('数据体检')
  const project = await prisma.project.findFirst({
    where: projectId ? { id: projectId } : { name: PROJECT_NAME },
  })
  if (!project) {
    warn('项目不存在')
    return { ok: false }
  }

  const papers = await prisma.paper.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: 'asc' },
    include: {
      methodDNA: { include: { blocks: true } },
    },
  })

  console.log(c.dim(`  项目：${project.name}（${project.id}）\n`))

  let allGood = papers.length > 0
  for (const p of papers) {
    const ev = await prisma.evidenceRef.count({ where: { paperId: p.id } })
    const blocks = p.methodDNA?.blocks ?? []
    const stages = [...new Set(blocks.map((b) => b.stage))]
    let unc = []
    try {
      unc = JSON.parse(p.methodDNA?.uncertainties ?? '[]')
    } catch {
      unc = []
    }
    console.log(c.bold(`  ▸ ${p.title.slice(0, 70)}`))
    console.log(
      c.dim(`      ${p.pageCount ?? '?'} 页 · DNA=${p.methodDNA ? '有' : '无'} · `) +
        `Blocks=${blocks.length} · Evidence=${ev} · 覆盖阶段=${stages.length} [${stages.join(', ')}]`
    )
    if (unc.length) console.log(c.dim(`      未抽取说明 ${unc.length} 条`))
    if (!p.methodDNA || blocks.length === 0) {
      fail('      这篇没有方法结构')
      allGood = false
    }
    console.log()
  }

  const [relations, debts, debtSources, ideas, tests] = await Promise.all([
    prisma.relation.count({ where: { projectId: project.id } }),
    prisma.researchDebt.count({ where: { projectId: project.id } }),
    prisma.debtSource.count({ where: { debt: { projectId: project.id } } }),
    prisma.candidateIdea.count({ where: { projectId: project.id } }),
    prisma.crashTest.count({ where: { idea: { projectId: project.id } } }),
  ])

  const row = (k, v, need) =>
    console.log(
      `  ${v > 0 || !need ? c.green('✔') : c.red('✘')} ${k.padEnd(14)} ${v}` +
        (need ? c.dim(v > 0 ? '' : '（要求 > 0）') : '')
    )
  row('论文', papers.length, true)
  row('方法结构', papers.filter((p) => p.methodDNA).length, true)
  row('方法模块', papers.reduce((n, p) => n + (p.methodDNA?.blocks.length ?? 0), 0), true)
  row('演化关系', relations, true)
  row('研究债务', debts, true)
  row('债务来源', debtSources, false)
  row('组合想法', ideas, true)
  row('击穿测试', tests, true)

  if (ideas === 0) allGood = false
  if (relations === 0) allGood = false
  if (tests === 0) allGood = false

  return { ok: allGood, papers }
}

async function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')

  console.log(c.bold('\nMethodAtlas · 替换内置论文为 IPS 三篇'))
  console.log(c.dim(`  应用：  ${APP_URL}`))
  console.log(c.dim(`  模型：  ${readEnvModel() ?? '（未读到 .env）'}`))
  console.log(c.dim(`  模式：  ${checkOnly ? '仅体检' : '清旧 + 换新 + 跑全链'}`))

  // ---------- 0) 环境自检 ----------
  step('0/5 环境自检')
  if (!existsSync(path.join(ROOT, 'prisma', 'dev.db'))) {
    fail('找不到 prisma/dev.db，请先运行 pnpm db:push')
    process.exit(1)
  }
  ok('数据库文件存在')

  if (checkOnly) {
    await report()
    await prisma.$disconnect()
    return
  }

  const appAlive = await probeApp()
  if (appAlive === 'disabled') {
    fail(`流水线接口未启用（${APP_URL}/api/pipeline）`)
    console.log(c.dim('    启动方式：ENABLE_PIPELINE_API=1 pnpm start'))
    process.exit(1)
  }
  if (!appAlive) {
    fail(`应用不可达：${APP_URL}`)
    process.exit(1)
  }
  ok('流水线接口可用')

  for (const p of PAPERS) {
    if (!existsSync(path.join(SAMPLE_DIR, p.file))) {
      fail(`样例 PDF 缺失：sample-papers/${p.file}`)
      process.exit(1)
    }
  }
  ok(`三篇 IPS PDF 就位（${PAPERS.length} 份）`)

  // ---------- 1) 清旧 ----------
  step('1/5 删除旧的 RAG 三篇论文及其全部派生数据')
  const oldProjects = await prisma.project.findMany({
    where: {
      // 旧项目名 + 任何含"RAG"的示例项目，都清掉，避免残留
      OR: [{ name: '示例项目 · RAG 方法演进' }, { name: { contains: 'RAG' } }],
    },
    select: { id: true, name: true },
  })

  // 顺带清掉本脚本上次跑出来的同名项目（幂等重跑）
  const existing = await prisma.project.findFirst({ where: { name: PROJECT_NAME } })
  if (existing && !oldProjects.some((p) => p.id === existing.id)) {
    oldProjects.push(existing)
  }

  if (oldProjects.length === 0) {
    warn('没有找到需要删除的旧项目')
  }
  for (const proj of oldProjects) {
    const oldPapers = await prisma.paper.findMany({
      where: { projectId: proj.id },
      select: { id: true },
    })
    // Prisma 级联会删掉 DNA/Blocks/Evidence/Relation/Debt/Idea/CrashTest/Surgery
    await prisma.project.delete({ where: { id: proj.id } })
    // storage 里的 PDF 目录不会被级联删，手动清
    let removed = 0
    for (const p of oldPapers) {
      const dir = path.join(STORAGE_DIR, p.id)
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
        removed++
      }
    }
    ok(`已删除「${proj.name}」(${proj.id})，含 ${oldPapers.length} 篇论文 / ${removed} 个存储目录`)
  }

  // 断言：库里不再有 RAG 论文
  const leftover = await prisma.paper.count({ where: { title: { contains: 'Self-RAG' } } })
  if (leftover > 0) {
    fail(`仍有 ${leftover} 篇 RAG 论文残留`)
    process.exit(1)
  }
  ok('已确认库内无 RAG 论文残留')

  // ---------- 2) 建新项目 + 上传解析 IPS 三篇 ----------
  step('2/5 上传并解析 IPS 三篇论文（走 /api/upload，与界面同一条路）')
  const project = await prisma.project.create({
    data: { name: PROJECT_NAME, description: PROJECT_DESC },
  })
  ok(`已创建项目 ${c.dim(project.id)}`)

  const paperIds = []
  for (const spec of PAPERS) {
    const abs = path.join(SAMPLE_DIR, spec.file)
    const r = await uploadPaper(project.id, abs, spec.file)
    // 上传接口返回的真实结果里带 paperId（如未带，回查最新一篇）
    let pid = r.paperId
    if (!pid) {
      const latest = await prisma.paper.findFirst({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      pid = latest?.id
    }
    paperIds.push(pid)
    ok(
      `${(r.title || spec.title).slice(0, 60)}  ${c.dim(
        `${r.pageCount ?? '?'} 页 · ${r.blockCount ?? '?'} 模块`
      )}`
    )
  }

  // ---------- 3) Method DNA（逐篇） ----------
  //
  // 注意：/api/upload 已经跑过一次 DNA 抽取（返回 blockCount 就是那次的产物）。
  // 所以这里**不重复抽**——重复抽等于同样的论文花两次模型调用。
  // 只有当某篇上传时 DNA 抽取失败（blockCount 为 0）才补跑一次。
  step('3/5 确认 Method DNA（上传时已抽取；缺失的补跑）')
  for (const pid of paperIds) {
    const has = await prisma.methodBlock.count({
      where: { method: { paperId: pid } },
    })
    if (has > 0) {
      ok(`已有 ${has} 个方法模块（上传时抽取，跳过重复调用）`)
      continue
    }
    const r = await runPipeline('dna', { paperId: pid })
    if (r.ok) {
      ok(`补抽：${r.message}`)
    } else {
      fail(r.message)
      console.log(c.dim('    后续阶段依赖方法结构，已停止。'))
      await report(project.id)
      process.exit(2)
    }
  }

  // ---------- 4) 演化 → 债务 ----------
  step('4/5 梳理技术演进关系 + 识别研究债务')
  {
    const r = await runPipeline('evolution', { projectId: project.id })
    r.ok ? ok(r.message) : warn(`跳过：${r.message}`)
  }
  {
    const r = await runPipeline('debt', { projectId: project.id })
    r.ok ? ok(r.message) : warn(`跳过：${r.message}（候选方案将无从生成）`)
  }

  // ---------- 5) 想法 → 击穿 ----------
  step('5/5 生成组合想法 + 运行击穿测试')
  {
    const r = await runPipeline('crossbreed', { projectId: project.id })
    if (r.ok) {
      ok(r.message)
      const t = await runPipeline('crashtest', { projectId: project.id })
      t.ok ? ok(t.message) : warn(t.message)
      if (t.detail) for (const line of t.detail.split('\n')) console.log(c.dim(`    ${line}`))
    } else {
      warn(`跳过：${r.message}`)
    }
  }

  // ---------- 体检并给出结论 ----------
  const res = await report(project.id)

  console.log('\n' + '='.repeat(60))
  if (res.ok) {
    console.log(c.green('DONE —— IPS 三篇已替换完成，全链路有数据。'))
  } else {
    console.log(c.yellow('PARTIAL —— 替换完成，但部分链路数据缺失（见上方 ✘）。'))
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(c.red('脚本异常：'), e)
  await prisma.$disconnect()
  process.exit(1)
})
