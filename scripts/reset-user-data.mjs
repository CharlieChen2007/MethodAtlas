#!/usr/bin/env node
/**
 * ── 清空「用户动作产生」的数据，保留「论文解析 + 方法结构」的演示底座 ──
 *
 * 为什么需要这个脚本（P10 问题 2）：
 *   打包交付时把 dev.db 一起带上（可运行快照），但库里残留了上一次
 *   验收时**真实跑出来的用户动作数据**（组合想法 / 手术 / 击穿测试）。
 *   用户打开就看到"已经有 3 条想法"，会误以为是系统预置的 ——
 *   而 CandidateIdea 全仓只有 crossbreeder.ts 一处写入点，根本没有预置逻辑。
 *   所以问题不在代码，在**交付前没有归零**。这个脚本把这件事固化成一步。
 *
 * 分级：数据分两类，只清第二类。
 *
 *   ① 演示底座（保留）—— 让用户一进去就有东西可看
 *      Project / Paper / EvidenceRef / MethodDNA / MethodBlock /
 *      Relation（方法演化）/ ResearchDebt + DebtSource + Attempt（研究债务）
 *
 *   ② 用户动作（清除）—— 只有用户点了按钮才会产生
 *      CandidateIdea + CandidateIdeaDebt（组合想法）
 *      Surgery + SurgeryLog（方法手术）
 *      CrashTest（击穿测试）
 *
 * 为什么债务（②的例外）保留：它是"方法演化分析"的产物，属于论文级
 * 结构信息（跨论文的共性缺陷），不是某个用户的一次性动作；而且
 * 它有 3 篇论文的跨论文证据，清掉后演示价值大幅下降。
 * 若确实需要全清，用 --all（连债务一起清，演化视图会回到空态）。
 *
 * 用法：
 *   node scripts/reset-user-data.mjs           # 只清用户动作（默认，推荐）
 *   node scripts/reset-user-data.mjs --all     # 连研究债务一起清
 *   node scripts/reset-user-data.mjs --dry-run # 只报告不删除
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const args = process.argv.slice(2)
const ALL = args.includes('--all')
const DRY = args.includes('--dry-run')

/** 要清空的表 —— 顺序很重要：先清关联表，再清主表（外键约束） */
const USER_ACTION_TABLES = [
  'crashTest', // 依赖 candidateIdea
  'candidateIdeaDebt', // 连接表，先于两边
  'candidateIdea', // 依赖 project
  'surgeryLog', // 依赖 surgery
  'surgery', // 依赖 methodDNA
]

/**
 * ── P18 问题 2 例外：手动添加的模块也属"用户动作" ──
 *
 * 「手动添加模块」落的是 MethodBlock（默认分级为演示底座），
 * 但 role='手动添加' 的行是用户点按钮产生的 —— 与论文解析出的
 * 结构块有本质区别。若不清：
 *   · 每轮验收/演示后 P0 论文的方法结构被测试残留模块污染
 *     （fallback 挂第一篇 methodDNA），dna 画布节点越积越多；
 *   · 打包交付时用户会看到"自己没加过的模块"，语义与想法残留相同。
 * 所以用条件删除（按 role 过滤）而不是清整表 —— 论文解析的块保留。
 */
async function deleteUserBlocks() {
  const r = await prisma.methodBlock.deleteMany({ where: { role: '手动添加' } })
  return r.count
}

/** --all 时额外清空的演示底座（有外键顺序） */
const DEMO_TABLES = ['attempt', 'debtSource', 'researchDebt']

async function report() {
  const counts = {}
  for (const t of [...USER_ACTION_TABLES, ...DEMO_TABLES]) {
    try {
      counts[t] = await prisma[t].count()
    } catch {
      counts[t] = 'n/a'
    }
  }
  return counts
}

async function main() {
  console.log('='.repeat(64))
  console.log('清空用户动作数据' + (ALL ? '（--all：含研究债务）' : '（保留演示底座）'))
  if (DRY) console.log('模式：DRY-RUN（只报告，不删除）')
  console.log('='.repeat(64))

  const before = await report()
  console.log('\n【清理前】')
  for (const [k, v] of Object.entries(before)) {
    console.log(`  ${k.padEnd(20)} ${v}`)
  }

  if (DRY) {
    console.log('\nDRY-RUN 结束，未做任何修改。')
    await prisma.$disconnect()
    return
  }

  const targets = ALL
    ? [...USER_ACTION_TABLES, ...DEMO_TABLES]
    : USER_ACTION_TABLES

  console.log('\n【开始清理】')
  let total = 0
  for (const t of targets) {
    try {
      const r = await prisma[t].deleteMany({})
      total += r.count
      console.log(`  ${t.padEnd(20)} 删除 ${r.count} 行`)
    } catch (e) {
      console.log(`  ${t.padEnd(20)} 跳过（${e.message.split('\n')[0]}）`)
    }
  }
  // P18：手动添加的模块（role='手动添加'）随用户动作一起清
  try {
    const n = await deleteUserBlocks()
    total += n
    console.log(`  methodBlock(手动)  删除 ${n} 行`)
  } catch (e) {
    console.log(`  methodBlock(手动)  跳过（${e.message.split('\n')[0]}）`)
  }

  const after = await report()
  console.log('\n【清理后】')
  for (const [k, v] of Object.entries(after)) {
    const mark = v === 0 && targets.includes(k) ? ' ✅' : ''
    console.log(`  ${k.padEnd(20)} ${v}${mark}`)
  }

  // ── 关键断言：用户动作表必须全部归零，否则"冷启动"是假的 ──
  const notZero = targets.filter((t) => typeof after[t] === 'number' && after[t] !== 0)
  console.log('\n' + '='.repeat(64))
  if (notZero.length === 0) {
    console.log(`结论：共删除 ${total} 行，用户动作表已全部归零 ✅`)
    console.log('冷启动基线：组合想法 0 条、手术 0 条、击穿测试 0 条。')
  } else {
    console.log(`⚠️  以下表未归零，请检查：${notZero.join(', ')}`)
    process.exitCode = 1
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('执行失败：', e.message)
  await prisma.$disconnect()
  process.exit(1)
})
