'use client'

import { useState } from 'react'
import type { DebtView, PaperView } from '@/lib/view-models'
import { statusColor, toneForEvidence, toneForProblemStatus } from '@/lib/lab/palette'
import { deriveProblemStatus, summarizeProblem } from '@/lib/lab/problem-status'

/**
 * ── P21：演化视图的左栏 =「纵向时间线」──
 *
 * 产品要求：
 *   每个年份一行；每行 = 年份 + 论文名 + 一句话问题；
 *   点某行展开：方法 + 结果。
 *
 * ── 数据从哪来 ──
 *   年份 / 论文名 → `PaperView.year` / `PaperView.title`
 *   一句话问题   → 该项目**研究债务**里 `sources` 提到这篇论文的那条的摘要
 *                （复用 problem-status 的 summarizeProblem：取第一句完整的话）
 *   方法 + 结果  → 这条债务在**这篇论文**上的 Attempt（谁尝试过、结果如何）
 *
 * 为什么以"论文"为行单位而不是以"问题"：
 *   产品这一栏给的是"时间线"——时间的主语是年份与论文。
 *   以问题为单位会把同一年出现多次，时间线就读不出先后了。
 *
 * ── 为什么排序按年份升序、无年份排最后 ──
 *   时间线要能读出"演进"。没有年份的论文（数据缺失）放到最后，
 *   并在行上标「年份未知」，而不是伪造成某一年。
 */
export function TimelineList({
  papers,
  debts,
  selectedPaperId,
  onSelectPaper,
}: {
  papers: PaperView[]
  debts: DebtView[]
  /** 当前选中的论文 id（右栏详情跟着它走） */
  selectedPaperId: string | null
  onSelectPaper: (paperId: string) => void
}) {
  /** 展开的行（产品要求"点某行展开：方法 + 结果"），可同时展开多行 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 按年份升序；无年份的排最后 */
  const ordered = [...papers].sort((a, b) => {
    if (a.year == null && b.year == null) return 0
    if (a.year == null) return 1
    if (b.year == null) return -1
    return a.year - b.year
  })

  /** 这篇论文"碰到过"的债务（sources 里有它） */
  const debtsOfPaper = (paperId: string) =>
    debts.filter((d) => d.sources.some((s) => s.paperId === paperId))

  return (
    <div
      data-timeline-list
      className="flex h-full flex-col overflow-y-auto px-4 py-3"
    >
      {ordered.map((p, idx) => {
        const related = debtsOfPaper(p.id)
        const head = related[0]
        const isOpen = expanded.has(p.id)
        const active = selectedPaperId === p.id
        const info = head ? deriveProblemStatus(head) : null
        /** 这篇论文在每条相关问题上的尝试（方法 + 结果） */
        const attempts = related.flatMap((d) =>
          d.attempts
            .filter((a) => a.paperId === p.id)
            .map((a) => ({ debt: d, attempt: a }))
        )

        return (
          <div
            key={p.id}
            /* P20：时间线逐行交错滑入（从上到下，14px 位移 + 淡入）。
               为什么这里不复用 .ma-list-item 的 12px：产品对本视图的要求是
               "从上到下交错滑入"，所以位移取 14px（仍在 8–16px 内）。 */
            className="ma-timeline-row"
            style={{ animationDelay: `${Math.min(idx, 6) * 60}ms` }}
          >
            <div className="relative">
              {/* 时间线竖轴 + 年份刻度点 */}
              <span
                aria-hidden
                className="absolute left-[-13px] top-[19px] h-2 w-2 rounded-full"
                style={{ background: active ? '#2563eb' : '#d1d5db' }}
              />
              <button
                type="button"
                data-timeline-row={p.id}
                data-timeline-active={active ? '1' : '0'}
                onClick={() => onSelectPaper(p.id)}
                className="mb-1.5 flex w-full items-start gap-2.5 rounded-block border px-3 py-2 text-left transition-colors"
                style={{
                  borderColor: active ? '#2563eb' : '#e5e7eb',
                  background: active ? '#eff6ff' : '#ffffff',
                }}
              >
                <span
                  className="mt-0.5 shrink-0 text-meta font-semibold tabular-nums"
                  style={{ color: p.year == null ? '#9ca3af' : '#1a1a1a' }}
                >
                  {p.year ?? '年份未知'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-meta text-ink" title={p.title}>
                    {p.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] leading-4 text-ink-muted">
                    {head ? summarizeProblem(head, 46) : '（这篇论文尚未关联到研究问题）'}
                  </span>
                </span>
                {/* 状态色点：与债务视图同一套四档语义色 */}
                {info && (
                  <span
                    aria-hidden
                    className="mt-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px]"
                    style={{
                      color: statusColor(toneForProblemStatus(info.status)),
                      background: `${statusColor(toneForProblemStatus(info.status))}14`,
                    }}
                  >
                    {info.label}
                  </span>
                )}
              </button>

              {/* 展开：方法 + 结果 */}
              <div className="mb-1.5 pl-1">
                <button
                  type="button"
                  data-timeline-expand={p.id}
                  aria-expanded={isOpen}
                  onClick={() => toggle(p.id)}
                  className="rounded-md px-2 py-0.5 text-[11px] text-ink-muted transition-colors hover:bg-[#f3f4f6] hover:text-ink"
                >
                  {isOpen ? '▾ 收起' : '▸ 方法 + 结果'}
                </button>
                {isOpen && (
                  <div
                    data-timeline-detail={p.id}
                    className="ma-list-item mt-1.5 space-y-2 rounded-block border border-line bg-[#fafafa] px-3 py-2"
                  >
                    {attempts.length === 0 ? (
                      <p className="text-[11px] leading-4 text-ink-faint">
                        收录内容里没有记录这篇论文的方法与结果（只有提及）。
                      </p>
                    ) : (
                      attempts.map(({ debt, attempt }, i) => (
                        <div key={`${debt.id}-${i}`}>
                          <p className="text-[11px] font-medium leading-4 text-ink-muted">
                            {debt.title}
                          </p>
                          <p className="mt-0.5 text-[11px] leading-4 text-ink">
                            <span className="text-ink-faint">方法：</span>
                            {attempt.description || '（未记录）'}
                          </p>
                          <p className="mt-0.5 text-[11px] leading-4 text-ink">
                            <span className="text-ink-faint">结果：</span>
                            {attempt.outcome || '（未说明）'}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}

      {ordered.length === 0 && (
        <p className="px-6 py-8 text-center text-meta text-ink-faint">
          还没有收录任何论文。
        </p>
      )}
    </div>
  )
}

/**
 * ── P21：债务视图的左栏 =「债务列表」──
 *
 * 产品要求：每条 = 状态色条 + 标题 + 涉及论文数（左 40%）。
 * 选中后右栏（60%）显示详情。
 */
export function DebtList({
  debts,
  selectedDebtId,
  onSelectDebt,
}: {
  debts: DebtView[]
  selectedDebtId: string | null
  onSelectDebt: (debtId: string) => void
}) {
  return (
    <div
      data-debt-list
      className="flex h-full flex-col gap-2 overflow-y-auto px-4 py-3"
    >
      {debts.map((d, idx) => {
        const active = selectedDebtId === d.id
        const info = deriveProblemStatus(d)
        const tone = statusColor(toneForProblemStatus(info.status))
        return (
          <button
            key={d.id}
            type="button"
            data-debt-list-item={d.id}
            data-debt-list-active={active ? '1' : '0'}
            onClick={() => onSelectDebt(d.id)}
            title={d.title}
            /* P20：债务项逐项交错滑入（12px + 淡入，70ms 步进封顶 100ms） */
            className="ma-list-item relative flex shrink-0 items-start gap-3 rounded-block border py-2.5 pl-4 pr-3 text-left transition-colors"
            style={{
              borderColor: active ? '#2563eb' : '#e5e7eb',
              background: active ? '#eff6ff' : '#ffffff',
            }}
          >
            {/* 左侧 3px 状态色条（与画布列表行同一套语义色） */}
            <span
              aria-hidden
              className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full"
              style={{ background: tone }}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-meta font-medium leading-5 text-ink">
                {d.title}
              </span>
              <span className="mt-1 flex items-center gap-2">
                <span
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ color: tone, background: `${tone}14` }}
                >
                  {info.label}
                </span>
                <span className="truncate text-[11px] text-ink-faint">
                  {/* 「篇论文提及」这个措辞是**验收契约**：
                      verify-local 的历史断言按它判定"项内能看到涉及论文数"。
                      换布局时刻意保留原字面，否则断言会以"产品缺数据"的样子失败。 */}
                  {d.occurrenceCount} 篇论文提及
                </span>
                {/* 证据强度独立成一枚小胶囊：与状态是两件事，不能混成一个色 */}
                <span
                  className="shrink-0 text-[10px]"
                  style={{ color: statusColor(toneForEvidence(d.evidenceStatus)) }}
                >
                  证据{evidenceWord(d.evidenceStatus)}
                </span>
              </span>
            </span>
          </button>
        )
      })}

      {debts.length === 0 && (
        <p className="px-6 py-8 text-center text-meta text-ink-faint">
          尚未识别出跨论文的研究债务。
        </p>
      )}
    </div>
  )
}

function evidenceWord(s: string): string {
  switch (s) {
    case 'CONFIRMED':
      return '充分'
    case 'UNCERTAIN':
      return '有限'
    case 'INSUFFICIENT':
      return '不足'
    default:
      return '未知'
  }
}
