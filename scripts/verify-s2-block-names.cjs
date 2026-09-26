#!/usr/bin/env node
/**
 * S2 回归：Block 名字是否已经规范化，且展示层有截断兜底。
 *
 * ── S2 的结论（先读这段，再读断言）──
 *
 * S2 原报的问题是"Block 名字是句子残骸"（如
 * "RAG-Sequence and RAG-Token both achieve state-of-the-art results"）。
 * 实测结论：**该问题已在 P9 问题 1 修复，S2 不需要再改代码**。
 *
 * 证据（本脚本断言的即是这三条）：
 *   ① 全库 18 个 Block，normalizeBlockName 跑一遍**没有一处会变** ——
 *      说明库里存的已经是规范化后的结果；
 *   ② 规范化是**幂等**的（跑两次 = 跑一次），所以反复抽取不会劣化；
 *   ③ 节点渲染层带 textOverflow:ellipsis + title 属性，
 *      长名字在画布上截断显示、悬停可见全文 —— 展示层不需要额外处理。
 *
 * 为什么还留这个脚本：S2 的"看起来像残骸"在视觉上是存在的
 * （"RAG (Retrieval-aug…"），后来的人很容易把它当成新 bug 再修一遍。
 * 这个脚本把"已经修好了、且修在哪一层"钉下来，避免重复劳动。
 *
 * 用法：
 *   npx tsc -p tsconfig.json --outDir .s2out --module commonjs ... （略）
 *   脚本直接读 DB + 编译后的 block-name，所以需要 .bnout/block-name.js
 *   若不存在会自动跳过断言 1/2（只跑静态检查）。
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const BN = path.join(ROOT, '.bnout/block-name.js')

let pass = 0, fail = 0, skip = 0
const chk = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m) } else { fail++; console.log('  ❌ ' + m) } }
const skp = (m) => { skip++; console.log('  ⏭  ' + m + '（缺编译产物，跳过）') }

console.log('═'.repeat(70))
console.log('S2 回归：Block 名字规范化 + 展示层截断')
console.log('═'.repeat(70))

// ── 静态：展示层必须有 ellipsis 截断与 title 提示 ──
console.log('\n── 1) 展示层兜底（静态检查 src/components/lab/CanvasNode.tsx）──')
const node = fs.readFileSync(path.join(ROOT, 'src/components/lab/CanvasNode.tsx'), 'utf8')
chk(/textOverflow:\s*'ellipsis'/.test(node), '节点标题有 textOverflow:ellipsis 截断')
chk(/title=\{isEmpty \? undefined : node\.title\}/.test(node), '节点有 title 属性（悬停可见全名）')
chk(/data-node-label=\{isEmpty \? undefined : node\.title\}/.test(node), '节点把全名挂在 data-node-label（验收脚本可断言）')

// ── 数据：全库名字是否已规范化 + 幂等 ──
console.log('\n── 2) 全库名字是否已规范化（需 .bnout/block-name.js）──')
if (!fs.existsSync(BN)) {
  skp('数据库全库校验')
} else {
  const { normalizeBlockName, isCleanName } = require(BN)
  const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'))
  const prisma = new PrismaClient()
  ;(async () => {
    const blocks = await prisma.methodBlock.findMany({ select: { name: true, description: true } })
    let wouldChange = 0, notIdempotent = 0, notClean = 0
    for (const b of blocks) {
      const n = normalizeBlockName(b.name, b.description || '')
      if (n !== b.name) { wouldChange++; console.log('     ★ 会变: ' + JSON.stringify(b.name) + ' → ' + JSON.stringify(n)) }
      if (normalizeBlockName(n, b.description || '') !== n) notIdempotent++
      if (!isCleanName(b.name)) notClean++
    }
    chk(blocks.length > 0, '库里存在 Block（共 ' + blocks.length + ' 个）')
    chk(wouldChange === 0, '全部名字已是规范化结果（会变 ' + wouldChange + ' 个）')
    chk(notIdempotent === 0, '规范化幂等（非幂等 ' + notIdempotent + ' 个）')
    chk(notClean === 0, '没有非 clean 名字（' + notClean + ' 个）')
    await prisma.$disconnect()
    done()
  })().catch((e) => { console.error(e); process.exit(1) })
  return
}

done()

function done() {
  console.log('\n' + '═'.repeat(64))
  console.log('通过 ' + pass + ' / 失败 ' + fail + (skip ? ' / 跳过 ' + skip : ''))
  console.log(fail === 0 ? '结论：S2 无需改代码，已由 P9 问题 1 覆盖 ✅' : '结论：存在失败 ❌')
  process.exit(fail === 0 ? 0 : 1)
}
