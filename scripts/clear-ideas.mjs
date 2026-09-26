#!/usr/bin/env node
/**
 * clear-ideas.mjs —— 清空「组合想法」及其派生产物（P9 问题 4 的收尾）。
 *
 * ── 为什么需要它 ──
 *
 * 问题 4 的病灶是：用户打开「组合想法」视图，看到「已生成的想法（2）」，
 * 但那两条**不是他点出来的** —— 是早期 `crossbreedAction` 跑出来后被
 * 固化进基线库的。代码里把生成门槛修好（至少选 2 个模块）只能拦住
 * **以后**的生成，拦不住**已经躺在库里**的这两条。
 *
 * 所以必须把库里已有的想法清掉，让视图恢复"打开时为空"的状态。
 *
 * ── 为什么删 crashTest 而不是只删 idea ──
 *
 * schema 里 CrashTest.ideaId 是 @unique 且 onDelete: Cascade，
 * CandidateIdeaDebt 也是 Cascade。理论上删 idea 会自动带走它们。
 * 但这里**仍然显式先删 crashTest**：
 *   1. SQLite 的外键约束默认是 **关闭** 的（PRAGMA foreign_keys=OFF），
 *      Prisma 建库时不一定打开 —— 依赖级联删除会留下孤儿行；
 *   2. 留下孤儿 crashTest 会让"击穿测试"视图显示一条指向不存在想法的记录，
 *      比多删一条更糟。
 *   显式删，是为了不依赖运行时的 PRAGMA 设置。
 *
 * 用法：
 *   node scripts/clear-ideas.mjs --dry-run
 *   node scripts/clear-ideas.mjs
 *
 * 退出码：0 = 成功；1 = 失败
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' }

async function main() {
  console.log('')
  console.log(C.cyan + 'MethodAtlas · 清空组合想法（问题 4）' + C.reset)
  console.log(C.dim + '─'.repeat(56) + C.reset)
  if (DRY_RUN) console.log(C.yellow + '（dry-run：只报告，不写库）' + C.reset)
  console.log('')

  const ideas = await prisma.candidateIdea.findMany({
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
  })

  if (ideas.length === 0) {
    console.log(C.green + '✓ 库里没有任何组合想法 —— 视图打开即为空。' + C.reset)
    console.log('')
    return 0
  }

  console.log(`  待删除 ${ideas.length} 条组合想法：`)
  for (const i of ideas) {
    console.log(`   · ${C.dim}${i.title.slice(0, 62)}${C.reset}`)
  }
  console.log('')

  const crashIds = await prisma.crashTest.findMany({
    where: { ideaId: { in: ideas.map((i) => i.id) } },
    select: { id: true },
  })
  console.log(C.dim + `  连带删除：${crashIds.length} 条击穿测试、` +
    `以及它们的「想法-债务」关联` + C.reset)
  console.log('')

  if (!DRY_RUN) {
    // 顺序：先派生物，再本体 —— 不依赖 SQLite 的外键级联
    const c1 = await prisma.crashTest.deleteMany({
      where: { ideaId: { in: ideas.map((i) => i.id) } },
    })
    const c2 = await prisma.candidateIdeaDebt.deleteMany({
      where: { ideaId: { in: ideas.map((i) => i.id) } },
    })
    const c3 = await prisma.candidateIdea.deleteMany({
      where: { id: { in: ideas.map((i) => i.id) } },
    })
    console.log(
      C.dim +
        `  已删除：crashTest ${c1.count} / candidateIdeaDebt ${c2.count} / candidateIdea ${c3.count}` +
        C.reset
    )
  }

  console.log('')
  const left = DRY_RUN ? ideas.length : await prisma.candidateIdea.count()
  if (left === 0) {
    console.log(C.green + '✓ 完成：视图打开时「已生成的想法」为空。' + C.reset)
  } else {
    console.log(C.yellow + `⚠ 仍剩 ${left} 条，请检查。` + C.reset)
    return 1
  }
  console.log('')
  return 0
}

main()
  .then(async (code) => {
    await prisma.$disconnect()
    process.exit(code)
  })
  .catch(async (e) => {
    console.error('\x1b[31m脚本异常：' + e.message + '\x1b[0m')
    await prisma.$disconnect()
    process.exit(1)
  })
