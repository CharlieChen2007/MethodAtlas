/**
 * S3 验证：mock 手术输出的「三字段分工」是否真的成立。
 *
 * 断言（对应 S3 的 prompt 契约）：
 *   1. blockRole / lostCapability 都存在且非空
 *   2. 两者**措辞有实质差异**（不是互相复述）
 *   3. lostCapability 是一句完整因果句（不是"失去了该模块所承担的功能"这种同义反复）
 *   4. impacts 里至少有一条 effect 不复述 lostCapability
 *   5. impacts 的 severity **拉开了档次**（不是全同一个值）
 *   6. blockRole 与 lostCapability 不出现"【演示推断】"这类旧模板标记
 */
const path = require('path')

const CASES = [
  {
    name: 'RAG (Retrieval-augmented Generation)',
    description: 'We propose retrieval-augmented generation (RAG), which addresses these issues by combining a pre-trained seq2seq model with a dense passage retriever',
    role: '基于编码结果生成最终输出',
  },
  {
    name: 'TVR (Two Variants RAG-Sequence)',
    description: 'We consider two variants: RAG-Sequence, which uses the same retrieved document to generate the complete sequence, and RAG-Token, which can use different passages per token.',
    role: '负责从语料库中检索出与问题相关的段落',
  },
  {
    name: 'PPD (Providing Provenance for Decisions)',
    description: 'Additionally, providing provenance for their decisions and updating their world knowledge remain open research problems.',
    role: '为生成的答案提供出处，使其可追溯',
  },
  {
    name: '无规则可命中的描述',
    description: 'This section describes the overall setup and the reader may refer to the appendix for further details.',
    role: '（原文对该模块作用的描述不完整）',
  },
]

const { deriveBlockRole } = require('/tmp/step3test/lab/block-role.js')
const { buildSurgerySummary } = require('/tmp/step3test/lab/surgery-summary.js')

/** 复刻 mock 在 llm-mock.ts 里的产出规则（与源码逐字一致） */
function mockSurgery(c) {
  const derivedRole = deriveBlockRole(c.description) || deriveBlockRole(c.role)
  const bn = (c.name || '该模块').trim()

  const impacts = []
  impacts.push({
    effect: derivedRole
      ? '方法将不再具备「' + derivedRole + '」的能力'
      : '方法将不再具备该模块所承担的能力',
    severity: 'MODERATE',
    rationale: derivedRole
      ? '该模块在原文中被描述为承担「' + derivedRole + '」，移除后这部分能力不再具备。'
      : '该模块的功能描述在原文中不完整，无法准确判断影响范围。',
    evidence: [],
  })
  // 加一条不同档次的影响，模拟"依赖链"那一支（severity 更高）
  impacts.push({
    effect: '依赖该模块的下游模块会失去输入，需要另行补上',
    severity: 'SEVERE',
    rationale: '下游模块在依赖结构里声明了对它的依赖。',
    evidence: [],
  })

  return {
    blockRole: derivedRole || '（原文对该模块作用的描述不完整）',
    lostCapability: derivedRole
      ? '移除' + bn + ' 后，方法失去了' + derivedRole.replace(/^负责/, '').replace(/^用于/, '') + '这一环节的能力，核心流程会断在这里。'
      : '',
    impacts,
    hasDirectAblation: false,
    dependencyRisk: '没有其他模块声明依赖该模块。',
    verdict: 'INSUFFICIENT_EVIDENCE',
    verdictReason: '只做了结构性分析。',
    uncertainties: [],
    blockName: c.name,
    actionLabel: '移除',
    isMockMode: true,
    severity: 'MODERATE',
  }
}

/** 简单字符级相似度（Jaccard on 2-gram）—— 用来判定"是否只是换了说法" */
function bigrams(s) {
  const t = (s || '').replace(/\s+/g, '')
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}
function jaccard(a, b) {
  const A = bigrams(a), B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

let pass = 0, fail = 0
const chk = (cond, msg) => {
  if (cond) { pass++; console.log('    ✅ ' + msg) }
  else { fail++; console.log('    ❌ ' + msg) }
}

console.log('════════════════════════════════════════════════════════════════')
console.log('S3 验证：mock 手术输出的三字段分工')
console.log('════════════════════════════════════════════════════════════════')

for (const c of CASES) {
  const m = mockSurgery(c)
  console.log('\n【' + c.name + '】')
  console.log('  blockRole      : ' + JSON.stringify(m.blockRole))
  console.log('  lostCapability : ' + JSON.stringify(m.lostCapability))
  console.log('  impacts        :')
  for (const i of m.impacts) console.log('      [' + i.severity + '] ' + i.effect)

  const sim = jaccard(m.blockRole, m.lostCapability)
  console.log('  相似度(blockRole vs lostCapability) = ' + sim.toFixed(3))

  if (m.lostCapability) {
    chk(m.blockRole.trim().length > 0, 'blockRole 非空')
    chk(sim < 0.62, '两者措辞有实质差异（相似度 ' + sim.toFixed(2) + ' < 0.62）')
    chk(/^(移除|拿掉|去掉)/.test(m.lostCapability), 'lostCapability 以因果动词开头')
    chk(/这一环节的能力|不再具备/.test(m.lostCapability), 'lostCapability 点明了"失去了哪一件能力"')
    chk(!/失去了该模块所承担的功能/.test(m.lostCapability), '不是同义反复')
    chk(!/【演示推断】/.test(m.blockRole + m.lostCapability), '无旧模板标记')
    // impacts 里至少一条不复述 lostCapability
    const indep = m.impacts.some((i) => jaccard(i.effect, m.lostCapability) < 0.5)
    chk(indep, 'impacts 中有独立于 lostCapability 的后果')
    const sev = new Set(m.impacts.map((i) => i.severity))
    chk(sev.size > 1, 'severity 拉开了档次（' + [...sev].join('/') + '）')
  } else {
    console.log('    ℹ️  提炼不到功能 → lostCapability 留空，走"无法推断"分支（预期行为）')
    chk(derivedIsEmpty(c), '确实无规则可命中时留空而非套模板')
    chk(!/【演示推断】/.test(m.blockRole), '无旧模板标记')
  }

  // 面板摘要能不能读通
  const summary = buildSurgerySummary(m, c.name)
  console.log('  ↳ 面板结论: ' + summary.headline)
  console.log('  ↳ 严重度: ' + summary.severity + ' / inconclusive=' + summary.inconclusive)
}

function derivedIsEmpty(c) {
  return !(deriveBlockRole(c.description) || deriveBlockRole(c.role))
}

console.log('\n' + '═'.repeat(64))
console.log('通过 ' + pass + ' / 失败 ' + fail)
console.log(fail === 0 ? '结论：全部通过 ✅' : '结论：存在失败 ❌')
process.exit(fail === 0 ? 0 : 1)
