#!/usr/bin/env node
/**
 * reseed-roles.mjs —— 用新的角色提炼规则刷新存量 Block（问题 2 的收尾）。
 *
 * ── 什么时候需要它 ──
 *
 * 问题 2 把 Block 的 role 从"三选一模板句"改成"从该模块自己的描述句提炼功能"。
 * 但**代码改了不会改库** —— 库里已有的 Block 仍存着旧模板文案，页面上看到的
 * 还是那句「【演示推断】从论文方法描述句中拆出的通用组件」。
 *
 * 所以需要跑一次本脚本：把每个 Block 的 description 重新过一遍
 * `deriveBlockRole()`，写回 role 字段。
 *
 * ── 为什么是"就地更新 role"，而不是重跑整条 DNA 抽取 ──
 * 重跑抽取要同时重写 block 集合、顺序、证据、以及所有 id，会让
 * 债务/想法/手术里保存的 blockId 引用全部失效。这里只改一个字段，
 * 不动任何 id —— **影响面最小**。
 *
 * 规则本身从 src/lib/lab/block-role.ts 引入（不是在本脚本里抄一份），
 * 保证"代码里的规则"和"脚本刷出来的结果"永远一致。
 *
 * 用法：
 *   node --experimental-strip-types scripts/reseed-roles.mjs --dry-run
 *   node --experimental-strip-types scripts/reseed-roles.mjs
 *
 * 退出码：0 = 成功；1 = 失败
 */

import { PrismaClient } from '@prisma/client'
import { deriveBlockRole } from '../src/lib/lab/block-role.ts'
import { normalizeBlockName } from '../src/lib/lab/block-name.ts'

const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m' }

async function main() {
  console.log('')
  console.log(C.cyan + 'MethodAtlas · 刷新 Block 角色文案（问题 2）' + C.reset)
  console.log(C.dim + '─'.repeat(56) + C.reset)
  if (DRY_RUN) console.log(C.yellow + '（dry-run：只报告，不写库）' + C.reset)
  console.log('')

  const blocks = await prisma.methodBlock.findMany({
    select: { id: true, name: true, description: true, role: true },
    orderBy: { order: 'asc' },
  })

  if (blocks.length === 0) {
    console.log(C.yellow + '库里没有 MethodBlock，无需处理。' + C.reset)
    return 0
  }

  let changed = 0
  let emptied = 0
  let same = 0
  let renamed = 0
  let dead = 0

  for (const b of blocks) {
    // 问题 1（P9）：名字也一并规范化 —— 规则来自 src/lib/lab/block-name.ts，
    // 不在这里抄一份。已经合格的名字（Fusion-in-Decoder / Self-RAG）原样返回。
    const rawName = (b.name || '').trim()
    const nextName = normalizeBlockName(rawName, b.description || '')
    // 问题 1（P9）：规范化后拿不到合格名字的历史遗留 Block（名字是被截断的英文
    // 原句片段，如「In this work we investigate how much」），**直接删除** ——
    // 画布上的节点名必须是可辨认的模块名，一段半截句子比少一个节点更糟。
    // 只删名字，不动其他 Block 的 id，影响面最小。
    if (!nextName) {
      dead++
      console.log(`  ${C.red}✖ 删除不合格 Block${C.reset}  ${C.dim}${rawName.slice(0, 60)}${C.reset}`)
      if (!DRY_RUN) {
        await prisma.methodBlock.delete({ where: { id: b.id } })
      }
      continue
    }
    const finalName = nextName
    if (finalName !== rawName) {
      renamed++
      console.log(`  ${C.cyan}✎ 改名${C.reset}`)
      console.log(`      ${C.dim}旧：${rawName.slice(0, 60)}${C.reset}`)
      console.log(`      新：${finalName}`)
      if (!DRY_RUN) {
        await prisma.methodBlock.update({ where: { id: b.id }, data: { name: finalName } })
      }
    }

    const next = deriveBlockRole(b.description || '')
    const prev = (b.role || '').trim()

    if (next === prev) {
      same++
      continue
    }

    if (!next) emptied++
    changed++

    const name = (finalName || '(无名)').slice(0, 40)
    console.log(`  · ${name}`)
    console.log(`      ${C.dim}旧：${prev || '(空)'}${C.reset}`)
    console.log(`      新：${next || C.yellow + '(留空 → 前端显示「未抽取到角色信息」)' + C.reset}`)

    if (!DRY_RUN) {
      await prisma.methodBlock.update({ where: { id: b.id }, data: { role: next } })
    }
  }

  console.log('')
  console.log(
    C.dim +
      `共 ${blocks.length} 个 Block：${changed} 个更新` +
      (emptied ? `（其中 ${emptied} 个提炼不出角色，置空）` : '') +
      `，${same} 个无需改动` +
      `；名字规范化 ${renamed} 个` +
      (dead ? `，删除不合格 ${dead} 个` : '') +
      C.reset
  )
  console.log('')

  // 写完后校验：不允许再有旧标记残留
  if (!DRY_RUN) {
    const leftover = await prisma.methodBlock.count({
      where: { role: { contains: '演示推断' } },
    })
    if (leftover > 0) {
      console.log(`  ${C.yellow}⚠ 仍有 ${leftover} 个 Block 带「演示推断」标记${C.reset}`)
      return 1
    }
    console.log(`  ${C.green}✓ 库内已无「演示推断」标记${C.reset}`)
    console.log('')
  }

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
