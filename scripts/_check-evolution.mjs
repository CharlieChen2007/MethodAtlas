#!/usr/bin/env node
/**
 * 检查 8 篇论文是否都进了演化链（验收：演化视图要显示 8 篇论文的演化链）。
 * 用法：node scripts/_check-evolution.mjs
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const papers = await prisma.paper.findMany({
  orderBy: { year: 'asc' },
  select: { id: true, title: true, year: true },
})
const rels = await prisma.relation.findMany({
  select: { sourcePaperId: true, targetPaperId: true, type: true, confidence: true },
})

const inChain = new Set()
for (const r of rels) { inChain.add(r.sourcePaperId); inChain.add(r.targetPaperId) }

console.log(`论文 ${papers.length} 篇 / 关系 ${rels.length} 条\n`)
console.log('论文是否进链：')
const missing = []
for (const p of papers) {
  const n = rels.filter((r) => r.sourcePaperId === p.id || r.targetPaperId === p.id).length
  const ok = n > 0
  if (!ok) missing.push(p)
  console.log(`  ${ok ? '✓' : '✗'} ${String(p.year ?? '?').padEnd(4)} ${(p.title || '').slice(0, 48).padEnd(48)} 参与 ${n} 条关系`)
}
console.log(`\n未进链的论文：${missing.length} 篇` + (missing.length ? ' → ' + missing.map((m) => m.title.slice(0, 30)).join(' / ') : ''))

// 按年份看能否读出一条链
console.log('\n按年份排序的关系：')
const byId = new Map(papers.map((p) => [p.id, p]))
for (const r of rels.sort((a, b) => (byId.get(a.sourcePaperId)?.year ?? 0) - (byId.get(b.sourcePaperId)?.year ?? 0))) {
  const s = byId.get(r.sourcePaperId)
  const t = byId.get(r.targetPaperId)
  console.log(`  ${s?.year ?? '?'} ${(s?.title || '').slice(0, 24).padEnd(24)} --${r.type.padEnd(8)}--> ${t?.year ?? '?'} ${(t?.title || '').slice(0, 24)}`)
}

await prisma.$disconnect()
