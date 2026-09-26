'use client'

import type { StatusCounts } from '@/lib/lab/views'
import type { Workflow } from '@/lib/lab/workflow'

/**
 * 底部状态条 —— 两行：流程进度 + 数据量。
 *
 * ── P7-4：从"一行数据"升级为"一行进度 + 一行数据" ──
 *
 * 产品要求：「显示：当前项目：xxx | 已完成 N/6 步 | 当前：xxx；
 *          保留数据统计，但放在第二行小字」
 *
 * 为什么第一行要放流程进度：
 *   单页画布没有页面导航，用户切视图时容易失去"我在整个流程的哪一步"的坐标。
 *   第一行用一句话回答三个问题：这是哪个项目、流程走了多少、我在哪一步。
 *   第二行保留原来的数据量统计 —— 那是"这个项目有多少料"的明细。
 *
 * 位置与层级：
 *   贴在画布底部居中，`pointer-events-none` 让它可以被"穿透"点击
 *   （否则点在状态条上不会触发画布的"点空白关闭面板"）。
 *
 * 为什么两行不会撑出滚动条（关键）：
 *   它是 `absolute bottom-0`，**不参与文档流** ——高度变化不影响
 *   文档的 scrollHeight，结构上就不可能撑出滚动条。
 *
 * 与详情面板的关系：
 *   详情面板从底部滑出（38vh），会盖住状态条。这是有意的 ——
 *   面板是"当前聚焦的东西"，状态条是"背景信息"，聚焦时应让位。
 *
 * 数字为 0 时压暗但不隐藏：科研工具里"0 条"本身是有信息量的
 * （比如"击穿 0"说明还没做验证），藏起来反而让人以为没这个指标。
 */

export function StatusBar({
  counts,
  workflow,
  projectName,
}: {
  counts: StatusCounts
  workflow: Workflow
  projectName: string
}) {
  const items: { label: string; value: number }[] = [
    { label: '论文', value: counts.papers },
    { label: '方法', value: counts.structuredPapers },
    { label: 'Block', value: counts.blocks },
    { label: '债务', value: counts.debts },
    { label: '想法', value: counts.ideas },
    { label: '击穿', value: counts.crashTests },
  ]

  // 当前步骤名 —— 「论文」不是视图，但状态条说的是"流程位置"，所以用 label
  const currentStep = workflow.steps.find((s) => s.id === workflow.currentStepId)
  const currentLabel = currentStep?.label ?? ''

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center pb-3">
      <div
        data-status-bar
        className="flex flex-col items-center gap-0.5 rounded-panel border border-line bg-white/85 px-4 py-1.5 backdrop-blur-sm"
      >
        {/* ── 第一行：流程进度 ── */}
        <div className="flex items-center gap-2 whitespace-nowrap text-[11px]">
          <span className="text-ink-muted">
            当前项目：<b className="font-semibold text-ink">{projectName}</b>
          </span>
          <span className="text-[10px] text-[#d1d5db]">|</span>
          <span className="text-ink-muted">
            已完成{' '}
            <b className="font-semibold tabular-nums text-ink">
              {workflow.doneCount}/{workflow.total}
            </b>{' '}
            步
          </span>
          <span className="text-[10px] text-[#d1d5db]">|</span>
          <span className="text-ink-muted">
            当前：<b className="font-semibold text-ink">{currentLabel}</b>
          </span>
        </div>

        {/* ── 第二行：数据量明细（更小的字） ── */}
        <div className="flex items-center gap-2">
          {items.map((it, i) => (
            <span key={it.label} className="flex items-center gap-1">
              {i > 0 && <span className="text-[9px] text-[#d1d5db]">·</span>}
              <span className="text-[10px] text-ink-faint">{it.label}</span>
              <span
                className="text-[10px] font-medium tabular-nums"
                style={{ color: it.value === 0 ? '#d1d5db' : '#4b5563' }}
              >
                {it.value}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
