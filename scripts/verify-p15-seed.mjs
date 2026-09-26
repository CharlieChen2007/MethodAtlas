// P15 验收前置：直写 SQLite 造 3 个想法（2 个已测：一档差对 + 多档差对）+ 1 个未测
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const PROJECT = 'cmu9my2ie0000z6pko5sqr27s'
const F = (finding, level) => JSON.stringify([{ finding, level, detail: `detail-${level}` }])
const base = {
  blockConflictCheck: F('无冲突', 'PASS'),
  dataRequirement: F('数据可得', 'PASS'),
  computeRequirement: F('算力可得', 'PASS'),
  experimentalDesign: '已有评测协议：3 数据集 × 5 种子。',
  findings: JSON.stringify({ fatalFlaws: [], conditionsToProceed: [], verdictReason: 'seed', isMockMode: true }),
  overallVerdict: 'GO',
  evidenceStatus: 'CONFIRMED',
}
await db.crashTest.deleteMany({ where: { idea: { projectId: PROJECT } } })
await db.candidateIdea.deleteMany({ where: { projectId: PROJECT } })
const mk = (title, desc, extra) => db.candidateIdea.create({ data: { projectId: PROJECT, title, description: desc, fromBlockIds: '[]', evidenceIds: '[]', evidenceStatus: 'UNCERTAIN', ...extra } })
// A：全 PASS（向量全 0）
const a = await mk('种子想法A：基线检索增强方案', 'seed A', { crashTest: { create: { noveltyCheck: F('常规组合', 'PASS'), ...base } } })
// B：仅新颖性 UNKNOWN（与 A 一档差，dist=1）
const b = await mk('种子想法B：检索增强加查询改写', 'seed B', { crashTest: { create: { noveltyCheck: F('新颖性未查清', 'UNKNOWN'), ...base } } })
// C：多维 BLOCKER + 实验设计空 + 致命弱点（与 A 多档差，dist=13）
const c = await mk('种子想法C：激进的无监督大改方案', 'seed C', {
  crashTest: { create: {
    noveltyCheck: F('非常新颖', 'PASS'),
    blockConflictCheck: F('模块互斥', 'BLOCKER'),
    dataRequirement: F('数据不可得', 'BLOCKER'),
    computeRequirement: F('算力不足', 'BLOCKER'),
    experimentalDesign: '',
    findings: JSON.stringify({ fatalFlaws: ['缺少可用的训练数据来源'], conditionsToProceed: [], verdictReason: 'seed', isMockMode: true }),
    overallVerdict: 'STOP',
    evidenceStatus: 'INSUFFICIENT',
  } },
})
// D：未测（不应参与相似度）
await mk('种子想法D：尚未测试的想法', 'seed D', {})
console.log('seeded:', a.id, b.id, c.id)
await db.$disconnect()
