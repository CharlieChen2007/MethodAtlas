#!/usr/bin/env node
/**
 * 打印 DEMO 录制时要用到的「第 N 项是哪一条」，避免照着操作单找不到东西。
 * 用法：node scripts/_demo-order.mjs
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const papers = await prisma.paper.findMany({
  orderBy: { year: 'asc' },
  select: { year: true, title: true },
})
console.log('演化时间线（按年份，从上到下）：')
papers.forEach((p, i) => {
  console.log(`  第 ${i + 1} 行  ${p.year}  ${(p.title || '').slice(0, 52)}`)
})

const debts = await prisma.researchDebt.findMany({ include: { sources: true } })
console.log('\n债务列表（从上到下）：')
debts.forEach((d, i) => {
  const n = new Set(d.sources.map((s) => s.paperId)).size
  console.log(`  第 ${i + 1} 条  [${n} 篇论文]  ${(d.title || '').slice(0, 42)}`)
})

const ideas = await prisma.candidateIdea.findMany({
  select: { title: true, crashTest: { select: { overallVerdict: true } } },
})
console.log('\n击穿视图左栏想法卡片（从上到下）：')
ideas.forEach((x, i) => {
  const v = x.crashTest ? `[${x.crashTest.overallVerdict}]` : '[未测]'
  console.log(`  第 ${i + 1} 张  ${v}  ${(x.title || '').slice(0, 46)}`)
})

const blocks = await prisma.methodBlock.groupBy({ by: ['stage'], _count: { _all: true } })
console.log('\n阶段分布（看板左侧图表，7 个阶段）：')
const order = ['PROBLEM', 'INPUT', 'PREPROCESSING', 'CORE_METHOD', 'TRAINING', 'INFERENCE', 'EVALUATION']
for (const s of order) {
  const hit = blocks.find((b) => b.stage === s)
  console.log(`  ${s.padEnd(14)} ${hit ? hit._count._all : 0}`)
}

await prisma.$disconnect()
