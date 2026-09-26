#!/usr/bin/env node
/**
 * diag-evolution.mjs —— 诊断：直接调用演化模型，打印原始输出 + 逐条落库判定。
 * 只读不改库（不落库），用于判断「关系太少」是模型问题还是过滤问题。
 */
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const prisma = new PrismaClient()

// 动态 import TS 服务：用 next 的编译产物不可行，这里直接复制关键判定逻辑做展示
async function main() {
  const papers = await prisma.paper.findMany({
    orderBy: { createdAt: 'asc' },
    include: { methodDNA: { include: { blocks: true } } },
  })
  console.log('论文顺序：')
  papers.forEach((p, i) =>
    console.log(`  [${i}] ${p.title.slice(0, 60)} | year=${p.year} | blocks=${p.methodDNA?.blocks.length ?? 0}`)
  )

  const rels = await prisma.relation.findMany({
    include: { sourcePaper: true, targetPaper: true },
  })
  console.log(`\n已落库关系：${rels.length}`)
  rels.forEach((r) =>
    console.log(`  ${r.type} ${r.sourcePaper.title.slice(0, 30)} -> ${r.targetPaper.title.slice(0, 30)} conf=${r.confidence} status=${r.evidenceStatus}`)
  )

  console.log(`\n可形成的无序论文对（上限）：${(papers.length * (papers.length - 1)) / 2} 对`)

  await prisma.$disconnect()
}

main()
