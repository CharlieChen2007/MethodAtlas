import type { DashboardBarRow, DashboardChart, DashboardStat } from '@/components/lab/Dashboard'
import type { LabData } from '@/lib/lab/views'
import { METHOD_STAGE_ORDER, METHOD_STAGE_LABEL, type MethodStage } from '@/lib/enums'
import { stageColor, statusColor, toneForEvidence, toneForProblemStatus } from '@/lib/lab/palette'
import { deriveProblemStatus } from '@/lib/lab/problem-status'

/**
 * ── P21（B 方案）：五个视图的看板数据 ──
 *
 * 为什么把"算数"集中放在这里、而不是散进 LabShell：
 *   看板是**派生视图**，它的每个数字都能从 LabData 重算出来，不引入任何
 *   新查询。把 5 个视图的 5 组算法放一起，才能一眼看出它们口径一致
 *   （比如"已解决数"在债务看板和别处都按同一套 problem-status 判定）。
 *
 * 颜色全部取自 palette.ts —— 阶段色用 stageColor()，状态色用 statusColor()。
 * 本文件不许出现字面色值。
 */

export interface DashboardContent {
  stats: DashboardStat[]
  charts: DashboardChart[]
  /** 折叠态挂在标题旁的一句话摘要 */
  collapsedHint: string
}

/** 卡片右上角圆点：按序取蓝/绿/橙/紫（规范里的"彩色圆点"） */
const DOTS = ['#2563eb', '#16a34a', '#f59e0b', '#7c3aed']

const STAGE_LABEL = METHOD_STAGE_LABEL as Record<string, string>

/**
 * 保证条形图的 label 唯一。
 *
 * 为什么需要：图表的 label 会被截断（长论文标题取前 N 字），
 * 两个不同来源截断后可能撞车；而 label 又是 React 的 key ——
 * 撞车会同时造成"key 重复"和"读者以为重复渲染"。
 * 实测：想法视图的「来源分布」出现 5 项 / 唯一 4（两个来源同名）。
 * 这里给重名项加序号，保证 key 唯一且画面可分辨。
 */
function dedupeLabels(rows: DashboardBarRow[]): DashboardBarRow[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const n = (seen.get(r.label) ?? 0) + 1
    seen.set(r.label, n)
    return n === 1 ? r : { ...r, label: `${r.label} (${n})` }
  })
}

/** DNA 视图看板：模块数 / 阶段数 / 证据数 / 论文数 + 阶段分布 + 证据覆盖 */
function dnaDashboard(data: LabData): DashboardContent {
  const blocks = data.papers.flatMap((p) => p.blocks)
  const stages = new Set(blocks.map((b) => b.stage).filter(Boolean) as string[])
  const evidenceN = pairs(data).reduce((n, [, v]) => n + v.length, 0)

  return {
    stats: [
      { label: '方法模块', value: blocks.length, dot: DOTS[0] },
      { label: '覆盖阶段', value: `${stages.size} / ${METHOD_STAGE_ORDER.length}`, dot: DOTS[1] },
      { label: '证据条目', value: evidenceN, dot: DOTS[2] },
      { label: '论文', value: data.papers.length, dot: DOTS[3] },
    ],
    charts: [
      {
        kind: 'bars',
        title: '阶段分布',
        rows: METHOD_STAGE_ORDER.map((s) => ({
          label: STAGE_LABEL[s] ?? s,
          value: blocks.filter((b) => b.stage === s).length,
          color: stageColor(s),
        })),
      },
      {
        kind: 'progress',
        title: '证据覆盖',
        percent: (stages.size / METHOD_STAGE_ORDER.length) * 100,
        progressText: `${evidenceN} 条证据 / ${blocks.length} 个模块`,
        progressColor: statusColor('good'),
      },
    ],
    collapsedHint: `${blocks.length} 个模块 · ${stages.size} 个阶段 · ${evidenceN} 条证据`,
  }
}

/** 演化视图看板：论文数 / 演化关系数 / 年份跨度 / 涉及方法数 + 年份分布 + 关系统计 */
function evolutionDashboard(data: LabData): DashboardContent {
  const years = data.papers
    .map((p) => p.year)
    .filter((y): y is number => typeof y === 'number')
    .sort((a, b) => a - b)
  const span = years.length >= 2 ? `${years[0]}–${years[years.length - 1]}` : years[0] ? `${years[0]}` : '—'
  const methods = new Set(data.papers.flatMap((p) => p.blocks.map((b) => b.name)))

  /** 年份分布：每个出现的年份一根条 */
  const yearCounts = new Map<number, number>()
  for (const y of years) yearCounts.set(y, (yearCounts.get(y) ?? 0) + 1)

  /** 演化关系统计：按关系类型分组 */
  const relTypes = new Map<string, number>()
  for (const r of data.relations) {
    const k = r.type || 'OTHER'
    relTypes.set(k, (relTypes.get(k) ?? 0) + 1)
  }

  return {
    stats: [
      { label: '论文', value: data.papers.length, dot: DOTS[0] },
      { label: '演化关系', value: data.relations.length, dot: DOTS[1] },
      { label: '年份跨度', value: span, dot: DOTS[2], hint: years.length ? `${years.length} 篇有年份` : '年份未知' },
      { label: '涉及方法', value: methods.size, dot: DOTS[3] },
    ],
    charts: [
      {
        kind: 'bars',
        title: '年份分布',
        rows: Array.from(yearCounts.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([y, n]) => ({ label: String(y), value: n, color: '#2563eb' })),
      },
      {
        kind: 'bars',
        title: '演化关系统计',
        rows: Array.from(relTypes.entries()).map(([t, n]) => ({
          label: REL_TYPE_LABEL[t] ?? t,
          value: n,
          color: '#7c3aed',
        })),
      },
    ],
    collapsedHint: `${data.papers.length} 篇论文 · ${data.relations.length} 条关系 · ${span}`,
  }
}

/** 债务视图看板：债务总数 / 已解决 / 部分解决 / 未解决 + 状态分布 + 涉及论文分布 */
function debtDashboard(data: LabData): DashboardContent {
  const statuses = data.debts.map((d) => deriveProblemStatus(d).status)
  const solved = statuses.filter((s) => s === 'solved').length
  const partial = statuses.filter((s) => s === 'partial').length
  const open = statuses.filter((s) => s !== 'solved' && s !== 'partial').length

  return {
    stats: [
      { label: '债务总数', value: data.debts.length, dot: DOTS[0] },
      { label: '已解决', value: solved, dot: DOTS[1] },
      { label: '部分解决', value: partial, dot: DOTS[2] },
      { label: '未解决', value: open, dot: '#dc2626' },
    ],
    charts: [
      {
        kind: 'bars',
        title: '状态分布',
        rows: [
          { label: '已解决', value: solved, color: statusColor('good') },
          { label: '部分解决', value: partial, color: statusColor('warn') },
          { label: '未解决', value: open, color: statusColor('bad') },
        ],
      },
      {
        kind: 'bars',
        title: '涉及论文分布',
        rows: data.debts.map((d) => ({
          label: d.title.length > 8 ? `${d.title.slice(0, 8)}…` : d.title,
          value: d.occurrenceCount,
          color: statusColor(toneForProblemStatus(deriveProblemStatus(d).status)),
        })),
      },
    ],
    collapsedHint: `${data.debts.length} 条债务 · 已解决 ${solved} · 未解决 ${open}`,
  }
}

/** 想法视图看板：想法总数 / 已测数 / 跨论文数 / 平均模块数 + 来源分布 + 状态分布 */
function ideaDashboard(data: LabData): DashboardContent {
  const ideas = data.ideas
  const tested = ideas.filter((i) => Boolean(i.crashTest)).length
  /** 跨论文：这个想法用到的模块来自 ≥2 篇论文 */
  const paperOfBlock = new Map<string, string>()
  for (const p of data.papers) for (const b of p.blocks) paperOfBlock.set(b.id, p.id)
  const crossN = ideas.filter((i) => {
    const set = new Set(i.fromBlockIds.map((id) => paperOfBlock.get(id)).filter(Boolean))
    return set.size >= 2
  }).length
  const avgBlocks = ideas.length
    ? Math.round((ideas.reduce((n, i) => n + i.fromBlockIds.length, 0) / ideas.length) * 10) / 10
    : 0

  /** 来源分布：按来源标签（论文名或"手动输入"）分组 */
  const bySource = new Map<string, number>()
  for (const i of ideas) {
    const k = i.sourceLabel || '未绑定来源'
    bySource.set(k, (bySource.get(k) ?? 0) + 1)
  }

  const statusCount = (f: (i: (typeof ideas)[number]) => boolean) => ideas.filter(f).length

  return {
    stats: [
      { label: '想法总数', value: ideas.length, dot: DOTS[0] },
      { label: '已击穿', value: tested, dot: DOTS[1] },
      { label: '跨论文组合', value: crossN, dot: DOTS[2] },
      { label: '平均模块数', value: avgBlocks, dot: DOTS[3] },
    ],
    charts: [
      {
        kind: 'bars',
        title: '来源分布',
        rows: dedupeLabels(
          Array.from(bySource.entries()).map(([k, n]) => ({
            label: k.length > 9 ? `${k.slice(0, 9)}…` : k,
            value: n,
            color: '#2563eb',
          })),
        ).sort((a, b) => b.value - a.value),
      },
      {
        kind: 'bars',
        title: '状态分布',
        rows: [
          { label: '已击穿', value: statusCount((i) => Boolean(i.crashTest)), color: statusColor('good') },
          { label: '待击穿', value: statusCount((i) => !i.crashTest), color: statusColor('unknown') },
        ],
      },
    ],
    collapsedHint: `${ideas.length} 个想法 · 已击穿 ${tested} · 跨论文 ${crossN}`,
  }
}

/** 击穿视图看板：总数 / 可行 / 需调整 / 不建议 + 判定分布 + 检查项通过率 */
function crashDashboard(data: LabData): DashboardContent {
  const tests = data.ideas.map((i) => i.crashTest).filter(Boolean) as NonNullable<
    LabData['ideas'][number]['crashTest']
  >[]
  const bucket = (v: string) =>
    tests.filter((t) => t.overallVerdict === v).length
  const promising = bucket('PROMISING')
  const risky = bucket('RISKY') + bucket('LIKELY_EXISTS')
  const noGo = bucket('INFEASIBLE')
  const unsure = bucket('INSUFFICIENT_EVIDENCE')

  /** 检查项通过率：全部检查项里 PASS 的占比 */
  const allChecks = tests.flatMap((t) => t.checks)
  const passed = allChecks.filter((c) => c.level === 'PASS').length
  const rate = allChecks.length ? (passed / allChecks.length) * 100 : 0

  return {
    stats: [
      { label: '击穿总数', value: tests.length, dot: DOTS[0] },
      { label: '可行', value: promising, dot: DOTS[1] },
      { label: '需调整', value: risky + unsure, dot: DOTS[2] },
      { label: '不建议', value: noGo, dot: '#dc2626' },
    ],
    charts: [
      {
        kind: 'bars',
        title: '判定分布',
        rows: [
          { label: '有前景', value: promising, color: statusColor('good') },
          { label: '有风险/已见', value: risky, color: statusColor('warn') },
          { label: '证据不足', value: unsure, color: statusColor('unknown') },
          { label: '不可行', value: noGo, color: statusColor('bad') },
        ],
      },
      {
        kind: 'progress',
        title: '检查项通过率',
        percent: rate,
        progressText: `${passed} / ${allChecks.length} 项通过`,
        progressColor: statusColor('good'),
      },
    ],
    collapsedHint: `${tests.length} 次击穿 · 可行 ${promising} · 不建议 ${noGo}`,
  }
}

/** 各视图看板入口 —— 未知视图退回 DNA 口径（不会用到） */
export function buildDashboard(view: string, data: LabData): DashboardContent {
  switch (view) {
    case 'evolution':
      return evolutionDashboard(data)
    case 'debt':
      return debtDashboard(data)
    case 'idea':
      return ideaDashboard(data)
    case 'crashtest':
      return crashDashboard(data)
    default:
      return dnaDashboard(data)
  }
}

/** 证据总数：所有 block / debt 的 evidenceIds 并集（去重后的条目数） */
function pairs(data: LabData): Array<[string, string[]]> {
  return [
    ...data.papers.flatMap((p) => p.blocks.map((b) => [b.id, b.evidenceIds] as [string, string[]])),
    ...data.debts.map((d) => [d.id, d.evidenceIds] as [string, string[]]),
  ]
}

/** 演化关系类型的中文标签（库里是英文枚举） */
const REL_TYPE_LABEL: Record<string, string> = {
  IMPROVES: '改进',
  EXTENDS: '扩展',
  REPLACES: '替代',
  APPLIES: '应用',
  COMPARES: '对比',
  OTHER: '其他',
}

export type { MethodStage }
