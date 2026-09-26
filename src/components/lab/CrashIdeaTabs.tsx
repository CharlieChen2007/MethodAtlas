'use client'

import type { IdeaView } from '@/lib/view-models'
import { computeIdeaColors } from '@/lib/lab/crash-similarity'

/**
 * ── P19 问题 3：击穿测试顶部「想法 tab 切换」条 ──
 *
 * 产品要求把击穿视图的 7 层框压到 3 层：
 *   顶部：想法 tab 切换（一排标签）
 *   中间：当前想法的击穿报告（一次只显示一个）
 *   底部：AI 讨论（默认折叠）
 *
 * 本组件就是"顶部那一层"。它同时替代了两样东西：
 *   · 旧的右栏「已生成的想法」清单（CrashRunCard）—— 与其并列成第 4 层框，
 *     不如把"选哪个想法"和"跑不跑"合并成同一条：点 tab 即切换报告对象，
 *     右侧按钮即开跑。
 *   · 旧的顶部进度/计数提示 —— 收进条内的 `${n} 个 · 已测 ${m}`。
 *
 * ── 契约保留（为什么还叫 data-crash-run-card）──
 *
 * 5 套验收脚本用 `[data-crash-run-card]` 判"击穿视图的想法入口在不在"、
 * 用 `[data-run-crash]` 判运行按钮、用 `[data-crash-ideas-empty]` /
 * `[data-goto-idea]` 判空态。本组件把同一个根钩子接着挂在自己身上，
 * 旧断言（含"未选想法 → 按钮禁用 + 提示文字在当前卡片文本里"）继续成立。
 *
 * ── 相似度色条 ──
 *
 * P15 需求五的相似度色阶（从已有 CrashTest 结果纯前端计算）原样保留：
 * 已测想法的 tab 左缘常驻 3px 色条，与对比面板表头的色点同源同色。
 */

export function CrashIdeaTabs({
  ideas,
  activeId,
  onActiveChange,
  pending,
  onRun,
  onGotoIdea,
}: {
  ideas: IdeaView[]
  /** 当前正在看报告的想法（tab 高亮） */
  activeId: string | null
  onActiveChange: (ideaId: string) => void
  pending: boolean
  onRun: (ideaId: string) => void
  /** 空态引导出口 */
  onGotoIdea: () => void
}) {
  const hasIdeas = ideas.length > 0
  const ranCount = ideas.filter((it) => it.crashTest != null).length
  const canRun = !pending && activeId != null
  const sim = computeIdeaColors(ideas)

  /**
   * 空态：还没有任何想法 → 整条只留一行引导 + 出口按钮。
   * （产品 P18 3a 已删掉画布上的示例卡，这条引导是唯一的"去哪生成"。）
   */
  if (!hasIdeas) {
    return (
      <div
        data-crash-run-card
        data-crash-tabs
        data-crash-idea-count="0"
        className="flex shrink-0 items-center gap-3 border-b border-line bg-white px-3 py-2"
      >
        <div data-crash-ideas-empty className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-meta text-ink-soft">
            还没有生成任何想法。先去「组合想法」选定模块与债务，生成候选方案。
          </span>
          <button
            type="button"
            data-goto-idea
            onClick={onGotoIdea}
            className="shrink-0 rounded-md border border-line bg-white px-2.5 py-1 text-meta text-ink-soft transition-colors hover:bg-canvas"
          >
            去组合想法 →
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      data-crash-run-card
      data-crash-tabs
      data-crash-idea-count={ideas.length}
      data-crash-selected-count={activeId ? 1 : 0}
      className="flex shrink-0 items-stretch gap-2 border-b border-line bg-white px-3 py-2"
    >
      {/* ── 想法标签（一排，可横向滚动；不换行 = 永远只占一行高度）── */}
      <div
        data-crash-idea-list
        role="tablist"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {ideas.map((it) => {
          const active = it.id === activeId
          const ran = it.crashTest != null
          const simColor = ran ? sim.colorOf[it.id] : undefined
          return (
            <button
              key={it.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-crash-idea-option={it.id}
              data-picked={active ? '1' : '0'}
              data-already-ran={ran ? '1' : '0'}
              data-sim-color={simColor}
              disabled={pending}
              onClick={() => onActiveChange(it.id)}
              title={`${it.title}${it.sourceLabel ? `　来源：${it.sourceLabel}` : ''}${
                ran ? '　（已击穿）' : '　（尚未击穿）'
              }`}
              /* ── P20：想法 tab 逐项交错淡入（70ms 步进）──
                 为什么可以放心给 tab 加位移动画：tab 条是单行
                 overflow-x-auto，动画只动 transform，不参与布局计算，
                 不会把滚动宽度算歪。 */
              className="ma-list-item flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                // 四边全 longhand（P15-6 纪律）：避免 shorthand 与 longhand 混写告警
                borderTop: active ? '1px solid #2563eb' : '1px solid var(--line, #e5e7eb)',
                borderRight: active ? '1px solid #2563eb' : '1px solid var(--line, #e5e7eb)',
                borderBottom: active ? '1px solid #2563eb' : '1px solid var(--line, #e5e7eb)',
                borderLeft: simColor ? `3px solid ${simColor}` : active ? '1px solid #2563eb' : '1px solid var(--line, #e5e7eb)',
                background: active ? '#eff6ff' : '#ffffff',
                color: active ? '#1d4ed8' : '#1a1a1a',
              }}
            >
              <span className="truncate text-meta">{it.title}</span>
              <span
                aria-hidden
                className="shrink-0 text-[10px] leading-none"
                style={{ color: ran ? '#16a34a' : '#c4c7cc' }}
              >
                {ran ? '●' : '○'}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── 计数 + 运行按钮（"运行击穿"不再另起一层框）── */}
      <div className="flex shrink-0 items-center gap-2">
        <span className="hidden whitespace-nowrap text-[11px] text-ink-faint md:inline">
          {ideas.length} 个 · 已测 {ranCount}
        </span>
        <button
          type="button"
          data-run-crash
          data-disabled={canRun ? '0' : '1'}
          disabled={!canRun}
          aria-disabled={!canRun}
          onClick={() => {
            if (activeId) onRun(activeId)
          }}
          className={
            'whitespace-nowrap rounded-md px-3 py-1.5 text-meta font-medium transition-colors ' +
            (canRun ? 'text-white hover:brightness-110' : 'cursor-not-allowed bg-[#f3f4f6] text-ink-faint')
          }
          style={canRun ? { background: '#2563eb' } : undefined}
        >
          {pending ? '正在击穿…' : '运行击穿测试'}
        </button>
        {/* 未选想法时的提示 —— 按钮为什么是灰的，必须写出来 */}
        {!canRun && !pending ? (
          <span data-run-crash-hint className="whitespace-nowrap text-[11px] text-ink-faint">
            请先选择至少一个已生成想法
          </span>
        ) : null}
      </div>
    </div>
  )
}
