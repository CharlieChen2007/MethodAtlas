/**
 * U3 回归测试 —— 证明 evolution / debt 的顺序倒置已修复。
 *
 * 旧行为：两者都判 debts.length，导致债务一合成，evolution 就永远
 *         不会再被"建议下一步"（被 debt 吃掉）。
 * 新行为：evolution 判"有 attempts 的债务数"，形成真实递进。
 *
 * 直接跑编译后的 workflow.js，用真实结构的 LabData 断言。
 */
const { buildWorkflow } = require('/tmp/step2test/lab/workflow.js')

let pass = 0, fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
}

/** 造一个最小可用的 LabData */
function mkData({ papers = 0, blocks = 0, debts = 0, debtsWithAttempts = 0, ideas = 0, crashTests = 0 }) {
  return {
    projectId: 'p', projectName: 'test',
    papers: Array.from({ length: papers }, (_, i) => ({
      id: `paper-${i}`, title: `Paper ${i}`,
      blocks: Array.from({ length: i < blocks ? 2 : 0 }, (_, j) => ({ id: `b-${i}-${j}` })),
    })),
    debts: Array.from({ length: debts }, (_, i) => ({
      id: `debt-${i}`, title: `债务 ${i}`,
      attempts: i < debtsWithAttempts ? [{ id: `att-${i}` }] : [],
      sources: [], evidenceIds: [],
    })),
    ideas: Array.from({ length: ideas }, (_, i) => ({ id: `idea-${i}`, fromBlockIds: [] })),
    crashTests: Array.from({ length: crashTests }, (_, i) => ({ id: `ct-${i}` })),
    relations: [], surgeries: [], blocks: [],
  }
}

function stepOf(wf, id) { return wf.steps.find((s) => s.id === id) }
function stateOf(wf, id) {
  const s = stepOf(wf, id)
  return s.done ? 'done' : 'todo'
}

console.log('\n═══ 场景 1：只有论文，什么都没有 ═══')
let wf = buildWorkflow(mkData({ papers: 3, blocks: 3 }), 'dna')
console.log(`   evolution=${stateOf(wf, 'evolution')}  debt=${stateOf(wf, 'debt')}  建议下一步=${wf.nextStepId}`)
ok('evolution 未完成', !stepOf(wf, 'evolution').done)
ok('debt 未完成', !stepOf(wf, 'debt').done)
ok('建议指向 evolution（债务之前的步骤）', wf.nextStepId === 'evolution', `实际 ${wf.nextStepId}`)

console.log('\n═══ 场景 2：债务合成完了，但还没有任何论文尝试解决 ═══')
wf = buildWorkflow(mkData({ papers: 3, blocks: 3, debts: 3, debtsWithAttempts: 0 }), 'debt')
console.log(`   evolution=${stateOf(wf, 'evolution')}  debt=${stateOf(wf, 'debt')}  建议下一步=${wf.nextStepId}`)
ok('debt 已完成', stepOf(wf, 'debt').done)
ok('evolution **仍未完成**（没有尝试就没有演进）', !stepOf(wf, 'evolution').done,
   '旧代码这里会是 done —— 顺序倒置的根源')
ok('★ 建议指向 evolution（不再被 debt 吃掉）', wf.nextStepId === 'evolution',
   `实际 ${wf.nextStepId} ← 旧代码会是 idea，跳过 evolution`)

console.log('\n═══ 场景 3：债务 + 论文尝试过 → 演进成立 ═══')
wf = buildWorkflow(mkData({ papers: 3, blocks: 3, debts: 3, debtsWithAttempts: 2 }), 'debt')
console.log(`   evolution=${stateOf(wf, 'evolution')}  debt=${stateOf(wf, 'debt')}  建议下一步=${wf.nextStepId}`)
ok('debt 已完成', stepOf(wf, 'debt').done)
ok('evolution 已完成（有 2 条带尝试的债务）', stepOf(wf, 'evolution').done)
ok('evolution 计数 = 2（有尝试的债务数）', stepOf(wf, 'evolution').count === 2,
   `实际 ${stepOf(wf, 'evolution').count}`)
ok('建议指向 idea（演化已完成，往后推进）', wf.nextStepId === 'idea', `实际 ${wf.nextStepId}`)

console.log('\n═══ 场景 4：旧代码与新代码的差异对照 ═══')
const oldJudge = (d) => d.debts.length > 0
const newJudge = (d) => d.debts.filter((x) => (x.attempts?.length ?? 0) > 0).length > 0
const cases = [
  { name: '无债务', d: mkData({ debts: 0, debtsWithAttempts: 0 }) },
  { name: '有债务、无尝试', d: mkData({ debts: 3, debtsWithAttempts: 0 }) },
  { name: '有债务、有尝试', d: mkData({ debts: 3, debtsWithAttempts: 2 }) },
]
console.log('   ┌──────────────┬──────────┬──────────┬────────┐')
console.log('   │ 场景         │ 旧判据   │ 新判据   │ 是否改变│')
console.log('   ├──────────────┼──────────┼──────────┼────────┤')
for (const c of cases) {
  const o = oldJudge(c.d), n = newJudge(c.d)
  console.log(`   │ ${c.name.padEnd(12)} │ ${String(o).padEnd(8)} │ ${String(n).padEnd(8)} │ ${(o !== n ? '★ 改变' : '相同').padEnd(6)} │`)
}
console.log('   └──────────────┴──────────┴──────────┴────────┘')
ok('旧判据在"有债务无尝试"时误判为已完成', oldJudge(cases[1].d) === true)
ok('新判据在"有债务无尝试"时正确判为未完成', newJudge(cases[1].d) === false)
ok('有尝试时新判据仍正确判为已完成', newJudge(cases[2].d) === true)

console.log('\n═══ 场景 5：全完成时的收尾 ═══')
wf = buildWorkflow(mkData({ papers: 3, blocks: 3, debts: 3, debtsWithAttempts: 3, ideas: 2, crashTests: 1 }), 'crashtest')
console.log(`   已完成 ${wf.doneCount}/${wf.total}  建议下一步=${wf.nextStepId}`)
ok('全部完成', wf.doneCount === wf.total, `${wf.doneCount}/${wf.total}`)
ok('没有待推进步骤时 nextStepId 为 null', wf.nextStepId === null)

console.log(`\n═══ 结果 ═══`)
console.log(`  通过 ${pass} · 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
