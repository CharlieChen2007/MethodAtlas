/**
 * 删除本会话测试产生的 2 篇重复论文（标题逐字符相同的 Self-RAG）。
 *
 * ── 为什么按 id 删 Paper 就够 ──
 * schema 里所有指向 Paper 的关系都是 `onDelete: Cascade`
 * （MethodDNA / EvidenceRef / Relation(source,target) / DebtSource / Attempt），
 * MethodBlock 又 cascade 自 MethodDNA。手写逐表删除反而容易漏表留孤儿。
 *
 * 用法：node scripts/_cleanup-duplicate-papers.mjs [--apply]
 *   不带 --apply = dry-run（只报告要删什么）
 */
import { PrismaClient } from '@prisma/client'

const APPLY = process.argv.includes('--apply')
const p = new PrismaClient()

// 只在此白名单里删 —— 绝不按"标题重复"泛化，避免误删真实语料
const TARGETS = ['cmuh956zx0059rgym5nfp1sch', 'cmuh98zil007qrgym8dmbq2st']

const papers = await p.paper.findMany({
  orderBy: { createdAt: 'asc' },
  select: { id: true, title: true, createdAt: true },
})
console.log(`当前论文数：${papers.length}`)

const doomed = papers.filter((x) => TARGETS.includes(x.id))
if (doomed.length === 0) {
  console.log('目标论文已不存在（可能已删过），无需清理。')
  await p.$disconnect()
  process.exit(0)
}

console.log(`\n将删除 ${doomed.length} 篇（及其全部派生数据）：\n`)
const sum = { dna: 0, blocks: 0, evid: 0, rel: 0, src: 0, att: 0 }
for (const d of doomed) {
  const dnaRows = await p.methodDNA.findMany({ where: { paperId: d.id }, select: { id: true } })
  const dnaIds = dnaRows.map((x) => x.id)
  const [evid, blocks, relS, relT, src, att] = await Promise.all([
    p.evidenceRef.count({ where: { paperId: d.id } }),
    dnaIds.length ? p.methodBlock.count({ where: { methodId: { in: dnaIds } } }) : 0,
    p.relation.count({ where: { sourcePaperId: d.id } }),
    p.relation.count({ where: { targetPaperId: d.id } }),
    p.debtSource.count({ where: { paperId: d.id } }),
    p.attempt.count({ where: { paperId: d.id } }),
  ])
  sum.dna += dnaRows.length
  sum.blocks += blocks
  sum.evid += evid
  sum.rel += relS + relT
  sum.src += src
  sum.att += att
  console.log(`  ${d.createdAt.toISOString().slice(0, 19)}  ${(d.title || '').slice(0, 46)}`)
  console.log(
    `     级联删： DNA ${dnaRows.length} / Block ${blocks} / 证据 ${evid} / 关系 ${
      relS + relT
    } / 债务来源 ${src} / 尝试 ${att}`,
  )
}
console.log(
  `\n合计： DNA ${sum.dna} / Block ${sum.blocks} / 证据 ${sum.evid} / 关系 ${sum.rel}` +
    ` / 债务来源 ${sum.src} / 尝试 ${sum.att}`,
)

if (!APPLY) {
  console.log('\n[dry-run] 没有改动。加 --apply 真删。')
  await p.$disconnect()
  process.exit(0)
}

// 删除前：用户动作必须已归零，否则说明有东西指着这些 block
const ideaN = await p.candidateIdea.count()
const surN = await p.surgeryLog.count()
const crN = await p.crashTest.count()
if (ideaN || surN || crN) {
  console.log(
    `\n⚠️ 库里还有用户动作（想法 ${ideaN} / 手术 ${surN} / 击穿 ${crN}）——` +
      ` 先跑 node scripts/reset-user-data.mjs 再删。`,
  )
  await p.$disconnect()
  process.exit(1)
}

for (const d of doomed) {
  await p.paper.delete({ where: { id: d.id } })
  console.log(`  已删 ${d.id}`)
}

// ── 一致性检查：不留孤儿 ──
const after = await p.paper.count()
const remaining = await p.paper.findMany({ select: { id: true } })
const idSet = new Set(remaining.map((x) => x.id))
const dnaRows = await p.methodDNA.findMany({ select: { id: true, paperId: true } })
const dnaIdSet = new Set(dnaRows.map((x) => x.id))
const blkRows = await p.methodBlock.findMany({ select: { id: true, methodId: true } })
const [evidAll] = await Promise.all([p.evidenceRef.count()])
const orphanDna = dnaRows.filter((x) => !idSet.has(x.paperId)).length
const orphanBlk = blkRows.filter((x) => !dnaIdSet.has(x.methodId)).length

console.log(`\n论文数：${papers.length} → ${after}`)
console.log(
  `一致性：DNA ${dnaRows.length}（孤儿 ${orphanDna}） / Block ${blkRows.length}` +
    `（孤儿 ${orphanBlk}） / 证据 ${evidAll}`,
)

await p.$disconnect()
