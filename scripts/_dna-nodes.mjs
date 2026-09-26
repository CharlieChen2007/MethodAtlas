#!/usr/bin/env node
/** 打印 DNA 视图默认那篇论文的画布节点名，供录制操作单核对。 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const papers = await prisma.paper.findMany({
  include: { methodDNA: { include: { blocks: true } } },
})
const t = papers.find((x) => (x.title || '').includes('WiFi Fingerprint Augmentation'))
if (!t) {
  console.log('没找到默认论文')
} else {
  console.log('DNA 视图默认论文：', (t.title || '').slice(0, 56))
  console.log('画布节点（按阶段）：')
  for (const b of t.methodDNA.blocks) console.log(`  [${b.stage}] ${b.name}`)
}
await prisma.$disconnect()
