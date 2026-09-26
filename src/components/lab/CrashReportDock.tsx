'use client'

import type { PanelContent } from '@/lib/lab/panel'
import type { IdeaView } from '@/lib/view-models'
import { BottomPanel } from './BottomPanel'

/**
 * ── P19 问题 3：击穿测试的"当前想法报告"（中栏常驻）──
 *
 * 击穿视图新结构（最多 3 层框）：
 *   ① CrashIdeaTabs      顶部：想法 tab 切换 + 运行按钮
 *   ② CrashReportDock    中栏：当前 tab 的击穿报告（本组件）
 *   ③ CrashChatPanel     底部：AI 讨论（默认折叠）
 *
 * 本组件是**壳**：真正的内容渲染复用 BottomPanel 的 `variant="dock"`，
 * 因为报告的小节结构、证据动作、结论措辞都已经在 `crashPanel` 里定好了，
 * 重写一份必然与底部面板漂移。
 *
 * ── 三态 ──
 *   · 没有想法            → 不渲染中栏，画布空态负责引导（"去组合想法"）
 *   · 有想法但未击穿      → 渲染想法卡：标题 + 描述 + 一句话说明怎么跑
 *   · 已击穿              → 渲染完整击穿报告（结论 / 6 项检查 / 证据 / 动作）
 */

/** 未击穿时的想法占位卡 */
function IdeaBrief({ idea, pending }: { idea: IdeaView; pending: boolean }) {
  return (
    <section
      data-report-untested={idea.id}
      className="flex h-full w-full flex-col overflow-hidden border-t border-line bg-white"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
        <span className="text-micro text-ink-faint">击穿测试 · 尚未运行</span>
        <span className="ml-auto flex h-5 items-center rounded-full bg-[#fffbeb] px-2 text-[10px] font-medium text-[#92400e]">
          未击穿
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <h2 className="text-[15px] font-semibold leading-6 text-ink">{idea.title}</h2>
        {idea.sourceLabel ? (
          <p className="mt-1 text-micro text-ink-faint">来源方法：{idea.sourceLabel}</p>
        ) : null}
        {idea.description ? (
          <p className="mt-3 whitespace-pre-line text-body leading-6 text-ink-muted">
            {idea.description}
          </p>
        ) : null}
        <div
          className="mt-4 rounded-block border px-3 py-2.5"
          style={{ borderColor: '#dbeafe', background: '#eff6ff' }}
        >
          <p className="text-meta leading-5" style={{ color: '#1d4ed8' }}>
            {pending
              ? '正在对这个想法做击穿测试，结论出来后会显示在这里。'
              : '这个想法还没有做击穿测试。点上方的「运行击穿测试」，系统会从新颖性、模块冲突、数据与算力可行性四个维度给出结论与改法。'}
          </p>
        </div>
      </div>
    </section>
  )
}

export function CrashReportDock({
  activeIdea,
  content,
  onClose,
  onAction,
  pending,
  isActionBusy,
  prefillDebtTitle,
  onPrefillConsumed,
  contextStrip,
}: {
  /** 当前 tab 选中的想法（null = 没有理想法可看） */
  activeIdea: IdeaView | null
  /** 已击穿时由 LabShell 预算好的报告内容（crashPanel 的产物） */
  content: PanelContent | null
  onClose: () => void
  onAction: (kind: string, content: PanelContent) => void
  pending: boolean
  isActionBusy?: (kind: string) => boolean
  prefillDebtTitle?: string | null
  onPrefillConsumed?: () => void
  /**
   * ── P19：跨步骤上下文横条 ──
   *
   * "想法 → 击穿"这条链要在画布顶部显示「本次击穿测试针对想法「X」」。
   * 旧实现里这个横条由 CanvasStage 渲染，而 P19 的击穿视图**不再有画布**
   * —— 横条跟着一起消失了，验收里"URL 带 ideaId 落到 crashtest 显示横条"
   * 与"切走后横条消失"两条都失败（后者连 had_strip 都是 False）。
   * 所以把横条交给中栏的报告组件渲染：位置语义不变（内容区顶部居中），
   * 只是宿主从中栏画布换成了中栏报告。
   */
  contextStrip?: { text: string } | null
}) {
  if (!activeIdea) return null

  const strip = contextStrip ? (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-2">
      <div
        data-context-strip
        className="flex items-center gap-1.5 rounded-full border border-line bg-white/90 px-3 py-1.5 backdrop-blur-sm"
      >
        <span aria-hidden className="text-[11px]" style={{ color: '#2563eb' }}>
          ↳
        </span>
        <span className="text-[11px] text-ink-muted">{contextStrip!.text}</span>
      </div>
    </div>
  ) : null

  if (!content) {
    return (
      <div className="relative h-full w-full">
        {strip}
        <IdeaBrief idea={activeIdea} pending={pending} />
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      {strip}
      <BottomPanel
        variant="dock"
        content={content}
        onClose={onClose}
        onAction={onAction}
        pending={pending}
        isActionBusy={isActionBusy}
        prefillDebtTitle={prefillDebtTitle}
        onPrefillConsumed={onPrefillConsumed}
      />
    </div>
  )
}
