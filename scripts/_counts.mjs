#!/usr/bin/env node
/**
 * _counts.mjs —— 打印项目关键计数（只读，不改任何数据）。
 *
 * 用法：node scripts/_counts.mjs
 *
 * 为什么自己解析 .env：这样在"没有 .env"的干净环境里也能跑，
 * 不用先手工复制模板（与 run-next/build 的行为保持一致）。
 */
import { PrismaClient } from '@prisma/client'
import { loadEnv, ROOT } from './load-env.mjs'
import path from 'node:path'

loadEnv()

const prisma = new PrismaClient()

const [paper, dna, block, relation, debt, idea, crash, surgery, evidence] = await Promise.all([
  prisma.paper.count(),
  prisma.methodDNA.count(),
  prisma.methodBlock.count(),
  prisma.relation.count(),
  prisma.researchDebt.count(),
  prisma.candidateIdea.count(),
  prisma.crashTest.count(),
  prisma.surgeryLog.count(),
  prisma.evidenceRef.count(),
])

console.log(
  `论文 ${paper} | DNA ${dna} | 模块 ${block} | 关系 ${relation} | 债务 ${debt} ` +
    `|| 想法 ${idea} | 击穿 ${crash} | 手术 ${surgery} | 证据 ${evidence}`
)

// 提示实际用的是哪个库文件，避免"看错目录"这类误判
const url = process.env.DATABASE_URL ?? ''
console.log(
  `数据库：${url}${url.startsWith('file:./') ? ` → ${path.join(ROOT, 'prisma', url.slice('file:./'.length))}` : ''}`
)

await prisma.$disconnect()
