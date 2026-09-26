#!/usr/bin/env node
/**
 * 只看当前库状态 + 调一次 /api/pipeline（输出用 Node 走，避免 PowerShell 中文乱码）。
 *
 * 用法：
 *   node scripts/_pipeline-call.mjs status
 *   node scripts/_pipeline-call.mjs crashtest
 *   node scripts/_pipeline-call.mjs crossbreed
 *   node scripts/_pipeline-call.mjs evolution | debt
 */
import { PrismaClient } from '@prisma/client'

const BASE = process.env.MA_BASE ?? 'http://127.0.0.1:3000'
const PROJECT_ID = process.env.MA_PROJECT ?? 'cmu9my2ie0000z6pko5sqr27s'
const action = process.argv[2] ?? 'status'

const prisma = new PrismaClient()

async function status() {
  const [pa, dna, blk, rel, de, id, cr, su] = await Promise.all([
    prisma.paper.count(), prisma.methodDNA.count(), prisma.methodBlock.count(),
    prisma.relation.count(), prisma.researchDebt.count(),
    prisma.candidateIdea.count(), prisma.crashTest.count(), prisma.surgeryLog.count(),
  ])
  console.log(`论文 ${pa} | DNA ${dna} | 模块 ${blk} | 关系 ${rel} | 债务 ${de} || 想法 ${id} | 击穿 ${cr} | 手术 ${su}`)

  console.log('\n论文：')
  const papers = await prisma.paper.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, title: true, year: true } })
  for (const p of papers) {
    const dna = await prisma.methodDNA.findFirst({ where: { paperId: p.id }, include: { blocks: { select: { stage: true } } } })
    const ev = await prisma.evidenceRef.count({ where: { paperId: p.id } })
    const st = new Set((dna?.blocks ?? []).map((b) => b.stage))
    console.log(`  ${String(p.year ?? '?').padEnd(4)} ${(p.title || '').slice(0, 50).padEnd(50)} 模块 ${String(dna?.blocks.length ?? 0).padStart(2)} 阶段 ${st.size} 证据 ${ev}`)
  }

  console.log('\n债务：')
  const debts = await prisma.researchDebt.findMany({ include: { sources: true } })
  for (const d of debts) {
    const papersN = new Set(d.sources.map((s) => s.paperId)).size
    console.log(`  [${papersN} 篇] ${d.title.slice(0, 56)}`)
  }

  console.log('\n想法：')
  const ideas = await prisma.candidateIdea.findMany({ select: { title: true, evidenceStatus: true, crashTest: { select: { overallVerdict: true } } } })
  for (const i of ideas) {
    console.log(`  ${i.crashTest ? `[${i.crashTest.overallVerdict}]` : '[未测]'} ${i.title.slice(0, 58)}  (${i.evidenceStatus})`)
  }
  if (ideas.length === 0) console.log('  （还没有想法）')

  console.log('\n演化关系：')
  const rels = await prisma.relation.findMany({
    include: { sourcePaper: { select: { title: true } }, targetPaper: { select: { title: true } } },
  })
  for (const r of rels) {
    console.log(`  ${(r.sourcePaper?.title || '').slice(0, 26)} --${r.type}--> ${(r.targetPaper?.title || '').slice(0, 26)}`)
  }
}

async function callPipeline(a) {
  const res = await fetch(`${BASE}/api/pipeline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: a, projectId: PROJECT_ID }),
  })
  const j = await res.json()
  console.log(`HTTP ${res.status}  ok=${j.ok}`)
  console.log(`  ${j.message}`)
  if (j.detail) console.log(j.detail.split('\n').map((l) => '    ' + l).join('\n'))
}

if (action === 'status') await status()
else { await callPipeline(action); await status() }

await prisma.$disconnect()
