'use client'

import type { IdeaView } from '@/lib/view-models'
import { computeIdeaColors } from '@/lib/lab/crash-similarity'
import { statusColor, toneForEvidence } from '@/lib/lab/palette'

/**
 * ── P21（B 方案）：击穿视图左栏 = 想法卡片列表 ──
 *
 * 产品要求：左 40% 每个想法一张卡片（带状态色条），右 60% 选中卡片的击穿报告。
 *
 * ── 与顶部 CrashIdeaTabs 的分工（重要，别合并）──
 * 顶部那条 tab 是**横向的一行**，5 套验收脚本按
 * `[data-crash-run-card]` / `[data-run-crash]` / `[data-crash-idea-option]`
 * 定位它，契约不能动。本组件是**左栏的纵向列表**，补的是产品要的
 * "每个想法一张卡片"这个形态。
 * 两者**共用同一个选中态**（`activeId` / `onActiveChange`）——
 * 点左栏卡片 = 点顶部 tab，不会出现"两处选中不一致"。
 *
 * ── 为什么卡片列表面板化放在左栏而不是只留 tab ──
 * 想法多了以后，横向 tab 会挤成一条需要横向滚动的小标签，
 * 看不清"哪些已经击穿过"。纵向卡片能同时给出标题 + 状态，
 * 这才是"选哪个想法看报告"该有的形态。
 */
export function CrashIdeaCards({
  ideas,
  activeId,
  onActiveChange,
  pending,
}: {
  ideas: IdeaView[]
  activeId: string | null
  onActiveChange: (ideaId: string) => void
  pending: boolean
}) {
  const sim = computeIdeaColors(ideas)

  if (ideas.length === 0) {
    return (
      <div
        data-crash-idea-cards
        className="flex h-full items-center justify-center px-6"
      >
        <p className="max-w-[240px] text-center text-meta leading-6 text-ink-faint">
          还没有生成任何想法。先去「组合想法」生成候选方案，再回来做击穿测试。
        </p>
      </div>
    )
  }

  return (
    <div
      data-crash-idea-cards
      className="flex h-full flex-col gap-2 overflow-y-auto px-4 py-3"
    >
      {ideas.map((it) => {
        const active = it.id === activeId
        const ran = it.crashTest != null
        const simColor = ran ? sim.colorOf[it.id] : undefined
        /**
         * 状态色条：已击穿 → 用相似度色阶（P15 需求五，与对比面板同源）；
         * 未击穿 → 灰色（"还没测"，不是"没问题"）。
         */
        const barColor = simColor ?? '#d1d5db'
        // 判定用证据/结论色，与报告一致
        const verdictTone = statusColor(toneForEvidence(it.evidenceStatus))

        return (
          <button
            key={it.id}
            type="button"
            data-crash-idea-card={it.id}
            data-crash-idea-card-active={active ? '1' : '0'}
            data-already-ran={ran ? '1' : '0'}
            disabled={pending}
            onClick={() => onActiveChange(it.id)}
            title={it.title}
            /* P20：列表交错淡入（复用 .ma-list-item 的 12px/70ms 口径） */
            className="ma-list-item relative flex shrink-0 items-start gap-3 rounded-block border py-2.5 pl-4 pr-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              borderColor: active ? '#2563eb' : '#e5e7eb',
              background: active ? '#eff6ff' : '#ffffff',
            }}
          >
            {/* 左侧 3px 状态色条 */}
            <span
              aria-hidden
              className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full"
              style={{ background: barColor }}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-meta font-medium leading-5 text-ink">
                {it.title}
              </span>
              <span className="mt-1 flex items-center gap-2">
                {/* 状态：已击穿 / 待击穿 —— 两件事，颜色也不同 */}
                <span
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  style={{
                    color: ran ? statusColor('good') : statusColor('unknown'),
                    background: ran ? `${statusColor('good')}14` : `${statusColor('unknown')}14`,
                  }}
                >
                  {ran ? '已击穿' : '待击穿'}
                </span>
                {it.sourceLabel && (
                  <span className="truncate text-[11px] text-ink-faint" title={it.sourceLabel}>
                    {it.sourceLabel}
                  </span>
                )}
                {ran && it.crashTest?.overallVerdict && (
                  <span
                    className="shrink-0 text-[10px]"
                    style={{ color: verdictTone }}
                    title={`总体判定：${it.crashTest.overallVerdict}`}
                  >
                    {verdictWord(it.crashTest.overallVerdict)}
                  </span>
                )}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** overallVerdict 的中文短标签（与 p4-actions 里的口径一致，只取短词） */
function verdictWord(v: string): string {
  switch (v) {
    case 'PROMISING':
      return '有前景'
    case 'RISKY':
      return '有风险'
    case 'LIKELY_EXISTS':
      return '已见相似'
    case 'INFEASIBLE':
      return '不可行'
    case 'INSUFFICIENT_EVIDENCE':
      return '证据不足'
    default:
      return v
  }
}
