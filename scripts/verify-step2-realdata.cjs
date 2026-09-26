/**
 * P10 Step2 · Problem A 真实数据验收
 *
 * 直接用数据库里的真实记录构造 LabData，调用 buildPanelContent()，
 * 检查「涉及的论文」「已有尝试」两个区块的渲染结果。
 *
 * 关键要证明的两件事：
 *   1. provider="" 的历史数据（英文 context）→ 被归纳成中文（不是贴英文原句）
 *   2. provider="hy3" 的中文 context → 原样使用（不被规则二次加工）
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const debt = await prisma.researchDebt.findFirst({
    include: {
      sources: { include: { paper: true } },
      attempts: { include: { paper: true } },
    },
  })
  if (!debt) { console.log('没有债务数据'); return }

  // 构造一个含两种来源的混合数据集：
  // 前 2 条的 provider 保持库里的真实值（""），
  // 后 1 条**注入** provider='hy3' + 中文 context，模拟真模型写入的数据。
  const REAL_ZH =
    '现有的 RAG 方法在检索到无关段落时仍会强行生成，因为它们缺少对检索结果是否支持生成内容的自我判断环节。'

  const labData = {
    debts: [
      {
        id: debt.id,
        description: debt.description,
        currentStatus: debt.currentStatus,
        sources: [
          ...debt.sources.map((s) => ({
            id: s.id,
            paperId: s.paperId,
            paperTitle: s.paper.title,
            context: s.context,
            evidenceIds: [],
            provider: s.provider, // 库里是 ""
          })),
          // ── 注入一条真模型数据 ──
          {
            id: 'injected-real-1',
            paperId: 'injected',
            paperTitle: 'Self-RAG: Learning to Retrieve, Generate and Critique',
            context: REAL_ZH,
            evidenceIds: [],
            provider: 'hy3',
          },
        ],
        attempts: debt.attempts.map((a) => ({
          id: a.id,
          paperId: a.paperId,
          paperTitle: a.paper.title,
          description: a.description,
          outcome: a.outcome,
          provider: a.provider,
        })),
      },
    ],
    blocks: [],
    surgeries: [],
    relations: [],
    ideas: [],
  }

  const { buildPanelContent } = require('/tmp/step2test/lab/panel.js')

  // debt 面板要求节点是 kind='card'，且 card.refId 指向这条债务 id
  const node = {
    id: 'node-debt',
    kind: 'card',
    label: '研究债务',
    title: (debt.description || '').slice(0, 40),
    x: 0, y: 0, w: 200, h: 100, col: 0,
    card: {
      id: 'card-debt',
      label: '研究债务',
      title: (debt.description || '').slice(0, 40),
      excerpt: '',
      tone: 'amber',
      refId: debt.id,
    },
  }

  const content = buildPanelContent(debt.id, node, 'debt', labData)
  if (!content) { console.log('buildPanelContent 返回 null'); return }

  console.log('\n═══ 「涉及的论文」区块 ═══\n')
  const sec1 = content.sections.find((s) => /涉及的论文/.test(s.heading))
  console.log(sec1 ? sec1.body : '(未找到)')

  console.log('\n\n═══ 「已有尝试」区块 ═══\n')
  const sec2 = content.sections.find((s) => /已有尝试/.test(s.heading))
  console.log(sec2 ? sec2.body : '(未找到)')

  // ── 断言 ──
  console.log('\n═══ 断言 ═══\n')
  let pass = 0, fail = 0
  const ok = (n, c, d) => {
    if (c) { pass++; console.log(`  ✅ ${n}`) }
    else { fail++; console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`) }
  }

  const body = sec1 ? sec1.body : ''
  const lines = body.split('\n').filter((l) => l.trim())

  ok('历史数据（英文）已被归纳成中文', !lines.some((l) => /^《[^》]*》However,/.test(l)),
     '仍出现「《论文》However,...」—— 说明分流没生效')
  ok('真模型中文数据原样保留', body.includes('缺少对检索结果是否支持生成内容的自我判断'),
     '模型原文被改写')
  ok('真模型数据没有被套上「指出了」模板', !body.includes('指出了「缺少对检索结果'),
     '被规则二次加工了')
  ok('每行都带论文名', lines.filter((l) => l.includes('《')).length >= 3,
     `只有 ${lines.filter((l) => l.includes('《')).length} 行带论文名`)

  console.log('\n  逐行对比：')
  lines.forEach((l, i) => {
    const kind = l.includes('自我判断环节') ? '真模型' : '历史/规则'
    console.log(`   [${i}] (${kind}) ${l}`)
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1) })
