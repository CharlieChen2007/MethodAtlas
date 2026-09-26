#!/usr/bin/env node
/**
 * seed-demo.mjs —— 一键灌入演示数据
 *
 * 为什么需要这个脚本：
 *   演示数据是手工一篇篇点出来的。换一台机器 / 重建数据库后，
 *   要重新演示就得手点 3 篇论文 × 5 个流水线阶段，非常容易出错，
 *   而且演示中途一旦哪一步失败，现场很难补救。
 *   这个脚本把「从零到可演示」压缩成一条命令。
 *
 * 用法：
 *   node scripts/seed-demo.mjs              # 灌数据（已有数据时跳过，幂等）
 *   node scripts/seed-demo.mjs --reset      # 先清空本项目再重灌
 *   node scripts/seed-demo.mjs --check      # 只体检现有数据，不写入
 *
 * 前置条件：
 *   1. 已执行 `pnpm db:push`（数据库文件存在）
 *   2. 解析服务在跑（默认 http://127.0.0.1:8000）
 *      —— 本脚本需要它来真实解析 PDF，不绕过它写假数据
 *   3. 三份样例 PDF 存在（不存在则自动调用生成器生成）
 *
 * 设计原则（与项目一致）：
 *   - 走**真实服务层**：脚本调用的是生产用的同一套 service，
 *     所以「seed 成功」等价于「流水线可用」，而不是「数据库里有行」
 *   - 不绑定模型：默认 LLM_PROVIDER=mock，无需 Key 即可跑通
 *   - 幂等：重复执行不会产生重复数据
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PrismaClient } from '@prisma/client'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const PARSER_URL = process.env.PARSER_SERVICE_URL || 'http://127.0.0.1:8000'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000'
const SAMPLE_DIR = path.join(ROOT, 'sample-papers')
const STORAGE_DIR = path.join(ROOT, 'storage', 'papers')

const PROJECT_NAME = '示例项目 · RAG 方法演进'

/** 三篇论文按时间顺序，刻意构成一条演化链：奠基 → 改进 → 组合式改进
 *  文件名必须与 parser-service/make_evolution_pdfs.py 里的 spec["file"] 完全一致，
 *  否则--reset 重灌时会在生成阶段就断掉。 */
const PAPERS = [
  { file: 'rag-2020.pdf', title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks' },
  { file: 'fusion-in-decoder-2020.pdf', title: 'Leveraging Passage Retrieval with Generative Models for Open Domain Question Answering' },
  { file: 'self-rag-2023.pdf', title: 'Self-RAG: Learning to Retrieve, Generate and Critique through Self-Reflection' },
]

const prisma = new PrismaClient()

// ===================== 小工具 =====================

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

function step(msg) {
  console.log(`\n${c.bold('▸')} ${msg}`)
}
function ok(msg) {
  console.log(`  ${c.ok('✓')} ${msg}`)
}
function skip(msg) {
  console.log(`  ${c.dim('·')} ${c.dim(msg)}`)
}
function warn(msg) {
  console.log(`  ${c.warn('!')} ${msg}`)
}
function fail(msg) {
  console.log(`  ${c.err('✗')} ${msg}`)
}

/** 探测解析服务是否存活 */
async function probeParser() {
  try {
    const res = await fetch(`${PARSER_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    // 有些版本没有 /health，退一步试根路径
    try {
      const res = await fetch(PARSER_URL, { signal: AbortSignal.timeout(3000) })
      return res.ok
    } catch {
      return false
    }
  }
}

/** 探测 Web 应用（流水线接口挂在它下面）是否存活 */
async function probeApp() {
  try {
    const res = await fetch(`${APP_URL}/api/pipeline`, {
      signal: AbortSignal.timeout(5000),
    })
    if (res.status === 403) return 'disabled'
    if (!res.ok) return false
    const data = await res.json()
    return data.ok ? true : false
  } catch {
    return false
  }
}

/**
 * 调一个流水线阶段。
 *
 * 注意这里调的是应用自己的 /api/pipeline，而不是直接写数据库 ——
 * 走真实服务层，seed 才有意义：它实际验证的是「流水线能不能跑」。
 */
async function runPipeline(action, params = {}) {
  const res = await fetch(`${APP_URL}/api/pipeline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
    signal: AbortSignal.timeout(180_000), // 真实模型下单阶段可能很慢
  })
  const data = await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }))
  return data
}

/** 确认 / 生成样例 PDF */
function ensureSamplePdfs() {
  const missing = PAPERS.filter((p) => !existsSync(path.join(SAMPLE_DIR, p.file)))
  if (missing.length === 0) {
    ok(`样例 PDF 齐备（${PAPERS.length} 篇）`)
    return true
  }

  warn(`缺 ${missing.length} 份样例 PDF，尝试调用生成器…`)
  mkdirSync(SAMPLE_DIR, { recursive: true })

  const gen = path.join(ROOT, '..', 'parser-service', 'make_evolution_pdfs.py')
  if (!existsSync(gen)) {
    fail(`找不到生成器 ${gen}`)
    return false
  }

  const r = spawnSync('python3', [gen, SAMPLE_DIR], { encoding: 'utf8' })
  if (r.status !== 0) {
    fail(`生成失败：${r.stderr || r.stdout}`)
    return false
  }

  const still = PAPERS.filter((p) => !existsSync(path.join(SAMPLE_DIR, p.file)))
  if (still.length > 0) {
    fail(`生成后仍缺：${still.map((p) => p.file).join(', ')}`)
    return false
  }
  ok(`已生成 ${PAPERS.length} 篇样例 PDF`)
  return true
}

/** 调解析服务拿到结构化文本 */
async function parsePdf(absPath, filename) {
  const buf = readFileSync(absPath)
  const fd = new FormData()
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), filename)

  const res = await fetch(`${PARSER_URL}/parse`, { method: 'POST', body: fd })
  if (!res.ok) {
    throw new Error(`解析服务返回 ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  return res.json()
}

// ===================== 主流程 =====================

async function main() {
  const args = process.argv.slice(2)
  const doReset = args.includes('--reset')
  const checkOnly = args.includes('--check')

  console.log(c.bold('\nMethodAtlas 演示数据灌入'))
  console.log(c.dim(`  项目根目录：${ROOT}`))
  console.log(c.dim(`  解析服务：  ${PARSER_URL}`))
  console.log(c.dim(`  Web 应用：  ${APP_URL}`))
  console.log(c.dim(`  模式：      ${checkOnly ? '仅体检' : doReset ? '重置后重灌' : '幂等灌入'}`))

  if (!process.env.LLM_PROVIDER) {
    process.env.LLM_PROVIDER = 'mock'
  }
  console.log(
    c.dim(`  LLM：       ${process.env.LLM_PROVIDER}`) +
      (process.env.LLM_PROVIDER === 'mock'
        ? c.dim('（演示模式，无需 API Key）')
        : '')
  )

  // ---------- 0) 环境自检 ----------
  step('0/7 环境自检')
  if (!existsSync(path.join(ROOT, 'prisma', 'dev.db'))) {
    fail('找不到 prisma/dev.db，请先运行 pnpm db:push')
    process.exit(1)
  }
  ok('数据库文件存在')

  const parserAlive = await probeParser()
  if (!parserAlive && !checkOnly) {
    fail(`解析服务不可达：${PARSER_URL}`)
    console.log(
      c.dim('    启动方式：cd parser-service && uvicorn main:app --port 8000 --host 127.0.0.1')
    )
    process.exit(1)
  }
  if (parserAlive) ok('解析服务可达')

  // 灌数据（非体检）时必须有 Web 应用，否则 3/7 之后的阶段全都跑不了
  if (!checkOnly) {
    const appAlive = await probeApp()
    if (appAlive === 'disabled') {
      fail(`流水线接口未启用（${APP_URL}/api/pipeline）`)
      console.log(c.dim('    该接口默认关闭。启用方式（仅演示环境）：'))
      console.log(c.dim('      ENABLE_PIPELINE_API=1 pnpm start      # Linux / macOS'))
      console.log(c.dim('      $env:ENABLE_PIPELINE_API=1; pnpm start  # PowerShell'))
      process.exit(1)
    }
    if (!appAlive) {
      fail(`Web 应用不可达或流水线接口未就绪：${APP_URL}`)
      console.log(c.dim('    启动方式：pnpm dev（另开一个终端）'))
      process.exit(1)
    }
    ok('流水线接口可用')
  }

  if (checkOnly) {
    await report()
    return
  }

  if (!ensureSamplePdfs()) process.exit(1)
  mkdirSync(STORAGE_DIR, { recursive: true })

  // ---------- 1) 项目 ----------
  step('1/7 准备项目')
  if (doReset) {
    const old = await prisma.project.findFirst({ where: { name: PROJECT_NAME } })
    if (old) {
      // 先记下这个项目占用的 PDF 目录 —— Prisma 级联只删数据库行，
      // storage 里的文件不会跟着走，不清就会越积越多（实测跑三次留下 9 个空目录）
      const oldPapers = await prisma.paper.findMany({
        where: { projectId: old.id },
        select: { id: true },
      })

      await prisma.project.delete({ where: { id: old.id } })

      let removed = 0
      for (const p of oldPapers) {
        const dir = path.join(STORAGE_DIR, p.id)
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true })
          removed++
        }
      }
      ok(`已删除旧项目 ${c.dim(old.id)}（含 ${removed} 个 PDF 存储目录）`)
    }
  }

  let project = await prisma.project.findFirst({ where: { name: PROJECT_NAME } })
  if (project) {
    const n = await prisma.paper.count({ where: { projectId: project.id } })
    skip(`项目已存在（${n} 篇论文）—— 幂等跳过抓取，直接进入体检`)
    await report(project.id)
    return
  }

  project = await prisma.project.create({
    data: {
      name: PROJECT_NAME,
      description: '由 scripts/seed-demo.mjs 生成：三篇 RAG 系列论文，构成一条可演示的方法演化链',
    },
  })
  ok(`已创建项目 ${c.dim(project.id)}`)

  // ---------- 2) 上传 + 解析 ----------
  step('2/7 上传并解析论文（走真实解析服务）')
  const paperIds = []
  for (const spec of PAPERS) {
    const abs = path.join(SAMPLE_DIR, spec.file)
    const parsed = await parsePdf(abs, spec.file)

    // 与 workspace/actions.ts 的 uploadPaper 保持一致：
    // 先建记录拿 id → 按 id 建目录 → 落盘 → 回填解析结果
    const paper = await prisma.paper.create({
      data: { projectId: project.id, title: spec.title, pdfPath: '', status: 'UPLOADED' },
    })

    const relDir = path.join('storage', 'papers', paper.id)
    const absDir = path.join(ROOT, relDir)
    mkdirSync(absDir, { recursive: true })

    const relPath = path.join(relDir, 'paper.pdf')
    copyFileSync(abs, path.join(ROOT, relPath))

    const updated = await prisma.paper.update({
      where: { id: paper.id },
      data: {
        pdfPath: relPath,
        title: parsed.title || spec.title,
        authors: JSON.stringify(parsed.authors || []),
        year: parsed.year ?? null,
        abstract: parsed.abstract || null,
        rawText: JSON.stringify(parsed.paragraphs || []),
        pageCount: parsed.pageCount ?? null,
        status: 'PARSED',
      },
    })

    paperIds.push(updated.id)
    ok(`${(parsed.title || spec.title).slice(0, 62)}  ${c.dim(`${parsed.pageCount ?? '?'} 页`)}`)
  }

  // ---------- 3) Method DNA ----------
  step('3/7 抽取 Method DNA')
  for (const pid of paperIds) {
    const r = await runPipeline('dna', { paperId: pid })
    if (r.ok) {
      ok(r.message)
    } else {
      fail(r.message)
      console.log(c.dim('    后续阶段依赖方法结构，已停止。'))
      await report(project.id)
      process.exit(2)
    }
  }

  // ---------- 4) 方法手术（演示样本） ----------
  step('4/7 跑一次方法手术（演示样本）')
  {
    const r = await runPipeline('surgery', { paperId: paperIds[0] })
    // 手术只是演示样本，失败不影响后续价值链，所以只告警不中断
    r.ok ? ok(r.message) : warn(`跳过：${r.message}`)
  }

  // ---------- 5) 技术演进 + 研究债务 ----------
  step('5/7 梳理技术演进关系')
  {
    const r = await runPipeline('evolution', { projectId: project.id })
    r.ok ? ok(r.message) : warn(`跳过：${r.message}`)
  }

  step('6/7 识别研究债务')
  {
    const r = await runPipeline('debt', { projectId: project.id })
    // 债务是候选方案的合法性来源；这步失败会让 7/7 必然失败，所以要说明
    r.ok ? ok(r.message) : warn(`跳过：${r.message}（候选方案将无从生成）`)
  }

  // ---------- 6) 候选方案 + 撞车测试 ----------
  step('7/7 生成候选方案并做撞车测试')
  {
    const r = await runPipeline('crossbreed', { projectId: project.id })
    if (r.ok) {
      ok(r.message)
      const t = await runPipeline('crashtest', { projectId: project.id })
      t.ok ? ok(t.message) : warn(t.message)
      if (t.detail) {
        for (const line of t.detail.split('\n')) console.log(c.dim(`    ${line}`))
      }
    } else {
      warn(`跳过：${r.message}`)
    }
  }

  await report(project.id)
}

/** 体检：把库里现有数据如实列出来，作为「能不能演示」的依据 */
async function report(projectId) {
  step('数据体检')

  const where = projectId ? { id: projectId } : { name: PROJECT_NAME }
  const project = await prisma.project.findFirst({ where })
  if (!project) {
    warn('项目不存在 —— 尚未灌入演示数据')
    return
  }

  const [papers, dnas, blocks, relations, debts, ideas, tests, evidence] = await Promise.all([
    prisma.paper.count({ where: { projectId: project.id } }),
    prisma.methodDNA.count({ where: { paper: { projectId: project.id } } }),
    prisma.methodBlock.count({ where: { method: { paper: { projectId: project.id } } } }),
    prisma.relation.count({ where: { projectId: project.id } }),
    prisma.researchDebt.count({ where: { projectId: project.id } }),
    prisma.candidateIdea.count({ where: { projectId: project.id } }),
    prisma.crashTest.count({ where: { idea: { projectId: project.id } } }),
    prisma.evidenceRef.count({ where: { paper: { projectId: project.id } } }),
  ])

  const rows = [
    ['论文', papers, papers >= 3],
    ['Method DNA', dnas, dnas >= 3],
    ['方法模块', blocks, blocks > 0],
    ['演化关系', relations, relations > 0],
    ['研究债务', debts, debts > 0],
    ['候选方案', ideas, ideas > 0],
    ['撞车测试', tests, tests > 0],
    ['可回溯证据', evidence, evidence > 0],
  ]

  console.log('')
  for (const [name, n, good] of rows) {
    const mark = good ? c.ok('✓') : c.warn('!')
    console.log(`  ${mark} ${name.padEnd(12, '　')} ${String(n).padStart(4)}`)
  }

  // 区分「还没跑」和「能力缺失」—— 这两件事对用户的意义不同
  const gaps = rows.filter(([, , good]) => !good).map(([n]) => n)
  console.log('')
  if (gaps.length === 0) {
    console.log(c.ok('  全链路数据齐备，可直接演示。'))
    console.log(c.dim(`  项目页：/projects/${project.id}/workspace`))
  } else {
    console.log(c.warn(`  尚缺：${gaps.join('、')}`))
    if (papers >= 3 && dnas >= 3) {
      console.log(c.dim('  论文与方法结构已就绪，后续阶段可在 UI 上依次点击触发：'))
      console.log(c.dim(`    /projects/${project.id}/evolution/graph      技术演进`))
      console.log(c.dim(`    /projects/${project.id}/research-debt        研究债务`))
      console.log(c.dim(`    /projects/${project.id}/crossbreeder         方法组合器`))
    }
  }
}

main()
  .catch((e) => {
    console.error(c.err(`\n灌入失败：${e.message}`))
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
