import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { parseJsonArray, parseJsonObject } from '@/lib/enums'
import { LabShell, type LabData } from '@/components/lab/LabShell'
import type { BlockView, CrashTestView } from '@/lib/view-models'

/**
 * 单页画布 —— Server Component。
 *
 * 一次聚合查询取全「6 个视图」所需数据，映射成纯 JSON 可序列化结构后交给
 * 客户端 LabShell。注意不要把 Prisma 实例或 Date 直接传给客户端组件。
 *
 * 视图 ↔ 数据源（与产品方案一致）：
 *   方法DNA   MethodBlock（按 stage/order 分组）
 *   方法手术  Surgery + SurgeryLog
 *   方法演化  Relation
 *   研究债务  ResearchDebt + DebtSource + Attempt
 *   组合想法  CandidateIdea + CandidateIdeaDebt
 *   击穿测试  CrashTest
 */

export const dynamic = 'force-dynamic'

export default async function LabPage({ params }: { params: { pid: string } }) {
  const pid = params.pid

  const project = await prisma.project.findUnique({
    where: { id: pid },
    include: {
      papers: {
        orderBy: { createdAt: 'asc' },
        include: {
          methodDNA: {
            include: { blocks: { orderBy: [{ order: 'asc' }] } },
          },
          evidenceRefs: { orderBy: { createdAt: 'asc' } },
        },
      },
      researchDebts: {
        include: {
          sources: { include: { paper: true } },
          // 问题 3：演化详情按"每篇论文怎么处理"列出，需要 attempt 的论文标题
          attempts: { include: { paper: true } },
        },
      },
      candidateIdeas: {
        include: { fromDebts: true, crashTest: true },
      },
    },
  })

  if (!project) notFound()

  // Relation / Surgery 不在 Project 上挂反向关联，单独查
  const [relationRows, surgeryRows] = await Promise.all([
    prisma.relation.findMany({
      where: { sourcePaper: { projectId: pid } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.surgery.findMany({
      where: { method: { paper: { projectId: pid } } },
      orderBy: { createdAt: 'asc' },
      include: { logs: true },
    }),
  ])

  // ── 论文 + 方法结构 ──
  const papers: LabData['papers'] = project.papers.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    // 摘要供 DNA 视图"默认选中根节点 → 面板展开论文摘要"用
    abstract: p.abstract ?? '',
    // 抽取时标注的"未覆盖说明" —— 供面板解释"为什么图上少了某个阶段"
    uncertainties: parseJsonArray<string>(p.methodDNA?.uncertainties),
    // UI ③：演化时间线要年份
    year: p.year ?? null,
    blocks: (p.methodDNA?.blocks ?? []).map<BlockView>((b) => ({
      id: b.id,
      name: b.name,
      type: b.type,
      description: b.description,
      role: b.role,
      stage: b.stage,
      order: b.order,
      evidenceIds: parseJsonArray<string>(b.evidenceIds),
      evidenceStatus: b.evidenceStatus,
    })),
  }))

  // ── 证据字典（底部面板点击证据时查引用原文） ──
  const evidence: LabData['evidence'] = project.papers.flatMap((p) =>
    p.evidenceRefs.map((e) => ({
      id: e.id,
      paperId: p.id,
      paperTitle: p.title,
      source: e.source,
      status: e.status,
      quote: e.quote,
      section: e.section,
      pageNumber: e.pageNumber,
      confidence: e.confidence,
      summary: e.modelSummary,
    }))
  )

  // ── 方法演化 ──
  const relations: LabData['relations'] = relationRows.map((r) => ({
    id: r.id,
    sourcePaperId: r.sourcePaperId,
    targetPaperId: r.targetPaperId,
    type: r.type,
    reason: r.reason,
    confidence: r.confidence,
    evidenceIds: parseJsonArray<string>(r.evidenceIds),
    evidenceStatus: r.evidenceStatus,
  }))

  // ── 研究债务 ──
  const debts: LabData['debts'] = project.researchDebts.map((d) => ({
    id: d.id,
    title: d.title,
    description: d.description,
    category: d.category,
    currentStatus: d.currentStatus,
    occurrenceCount: d.occurrenceCount,
    evidenceIds: parseJsonArray<string>(d.evidenceIds),
    evidenceStatus: d.evidenceStatus,
    sources: d.sources.map((s) => ({
      id: s.id,
      paperId: s.paperId,
      paperTitle: s.paper.title,
      context: s.context,
      evidenceIds: parseJsonArray<string>(s.evidenceIds),
      provider: s.provider,
    })),
    attempts: d.attempts.map((a) => ({
      id: a.id,
      paperId: a.paperId,
      // 问题 3 的演化详情要按"每篇论文怎么处理"逐条列出，标题是那一行的主语
      paperTitle: a.paper.title,
      description: a.description,
      outcome: a.outcome,
      provider: a.provider,
    })),
  }))

  // ── 组合想法 ──
  /**
   * ── P11 问题 3：来源方法标签 ──
   * fromBlockIds → block → paper.title。击穿测试列表要求每项
   * "标题 + 来源方法"可区分，这里统一算好，客户端不用再做反查。
   * 最多列 2 篇论文名（超长截断），更多折进「等 N 篇」。
   */
  const blockPaperTitle = new Map<string, string>()
  for (const p of project.papers) {
    for (const b of p.methodDNA?.blocks ?? []) blockPaperTitle.set(b.id, p.title)
  }
  const sourceLabelOf = (blockIds: string[]): string | undefined => {
    const titles: string[] = []
    for (const id of blockIds) {
      const t = blockPaperTitle.get(id)
      if (t && !titles.includes(t)) titles.push(t)
    }
    if (titles.length === 0) {
      // P12 问题 2：手动输入的想法没有来源模块 —— 用「手动输入」标记，
      // 与「来自 A + B」的生成想法在击穿列表里一眼可分。
      return '手动输入'
    }
    const short = titles.slice(0, 2).map((t) => (t.length > 14 ? `${t.slice(0, 14)}…` : t))
    return `来自 ${short.join(' + ')}${titles.length > 2 ? ` 等 ${titles.length} 篇` : ''}`
  }

  const ideas: LabData['ideas'] = project.candidateIdeas.map((i) => ({
    id: i.id,
    title: i.title,
    description: i.description,
    fromBlockIds: parseJsonArray<string>(i.fromBlockIds),
    evidenceIds: parseJsonArray<string>(i.evidenceIds),
    evidenceStatus: i.evidenceStatus,
    debtIds: i.fromDebts.map((x) => x.debtId),
    // 问题 4：卡片要显示"一句话机制"（为什么能解决目标债务）
    mechanism: i.fromDebts.find((x) => x.why.trim())?.why ?? undefined,
    // P11 问题 3：列表项的"来源方法"区分标签
    sourceLabel: sourceLabelOf(parseJsonArray<string>(i.fromBlockIds)),
    crashTest: i.crashTest ? mapCrashTest(i.crashTest, i.id, i.title) : null,
  }))

  // ── 击穿测试（从 idea.crashTest 汇总，保证与组合想法同源） ──
  const crashTests: LabData['crashTests'] = project.candidateIdeas
    .filter((i) => i.crashTest)
    .map((i) => mapCrashTest(i.crashTest!, i.id, i.title))

  // ── 方法手术（Surgery 表当前为空，仍按 schema 读取，保证有数据时即可渲染） ──
  const surgeries: LabData['surgeries'] = surgeryRows.map((s) => ({
    id: s.id,
    methodId: s.methodId,
    title: s.title,
    description: s.description,
    result: s.result,
    verdict: s.verdict,
    evidenceIds: parseJsonArray<string>(s.evidenceIds),
    evidenceStatus: s.evidenceStatus,
    intervenedBlockIds: s.logs.map((l) => l.blockId),
  }))

  return (
    <LabShell
      data={{
        projectId: pid,
        projectName: project.name,
        papers,
        evidence,
        relations,
        debts,
        ideas,
        crashTests,
        surgeries,
      }}
    />
  )
}

/**
 * CrashTest 行 → CrashTestView。
 *
 * 4 个检查列各存一个 JSON 数组，取第一项作为该检查的代表结论。
 * 第 5、6 个检查项（实验设计 / 致命弱点）不在这里造 ——
 * 它们由 view-layout 的 buildCrashChecks() 从 experimentalDesign
 * 与 findings.fatalFlaws 这两个真实字段推导，避免这里出现两套口径。
 */
function mapCrashTest(
  t: {
    id: string
    noveltyCheck: string
    blockConflictCheck: string
    dataRequirement: string
    computeRequirement: string
    experimentalDesign: string
    findings: string
    evidenceStatus: string
    overallVerdict: string
  },
  ideaId: string,
  ideaTitle: string
): CrashTestView {
  const findingsObj = parseJsonObject<{
    fatalFlaws?: unknown
    conditionsToProceed?: unknown
    verdictReason?: unknown
    isMockMode?: unknown
  }>(t.findings)
  const rawFlaws = findingsObj?.fatalFlaws
  const rawConditions = findingsObj?.conditionsToProceed

  return {
    id: t.id,
    ideaId,
    ideaTitle,
    overallVerdict: t.overallVerdict,
    checks: [
      { key: 'noveltyCheck', label: '新颖性', raw: t.noveltyCheck },
      { key: 'blockConflictCheck', label: '模块冲突', raw: t.blockConflictCheck },
      { key: 'dataRequirement', label: '数据可行性', raw: t.dataRequirement },
      { key: 'computeRequirement', label: '算力可行性', raw: t.computeRequirement },
    ].map((c) => {
      const arr = parseJsonArray<{
        finding?: string
        level?: string
        detail?: string
        suggestion?: string
      }>(c.raw)
      const first = arr[0]
      return {
        key: c.key,
        label: c.label,
        finding: first?.finding ?? '',
        level: first?.level ?? 'UNKNOWN',
        detail: first?.detail ?? '',
        /**
         * 模型给的针对性改法。**缺失时给空串、不给兜底文案** ——
         * 空串在这里是有意义的信号（"模型没给"），
         * crash-summary.ts 据此回落到静态表。若在这里就填上兜底文案，
         * 回落链就断了：分会把兜底文案当成"模型给的"照直用。
         */
        suggestion: typeof first?.suggestion === 'string' ? first.suggestion : '',
        /**
         * 全量带上这一项的发现 —— 原实现只取 arr[0] 会静默丢弃其余。
         * 每条都归一成 {finding, level, detail}，缺失字段给空串而不是 undefined，
         * 避免渲染层到处判空。
         */
        allFindings: arr.map((f) => ({
          finding: typeof f.finding === 'string' ? f.finding : '',
          level: typeof f.level === 'string' ? f.level : 'UNKNOWN',
          detail: typeof f.detail === 'string' ? f.detail : '',
        })),
      }
    }),
    experimentalDesign: t.experimentalDesign,
    findings: t.findings,
    evidenceStatus: t.evidenceStatus,
    // 致命弱点取自 findings JSON —— 真实字段，不是为凑够 6 项编的
    fatalFlaws: Array.isArray(rawFlaws)
      ? rawFlaws.filter((x): x is string => typeof x === 'string')
      : [],
    // 引擎侧写下的 isMockMode / conditionsToProceed / verdictReason
    isMockMode: findingsObj?.isMockMode === true,
    conditionsToProceed: Array.isArray(rawConditions)
      ? rawConditions.filter((x): x is string => typeof x === 'string')
      : [],
    verdictReason:
      typeof findingsObj?.verdictReason === 'string' ? findingsObj.verdictReason : undefined,
  }
}
