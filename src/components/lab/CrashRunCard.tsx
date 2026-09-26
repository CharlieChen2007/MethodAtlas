'use client'

import type { IdeaView } from '@/lib/view-models'
import { computeIdeaColors } from '@/lib/lab/crash-similarity'

/**
 * 击穿测试的「已生成想法」浮动卡片（P11 问题 2）。
 *
 * ── 与旧 CrashRunBar 的关系 ──
 *
 * 旧实现是画布**下方**的一条横向选择条（静态 shrink-0 flex 兄弟）。
 * 产品在 P11 问题 2 里明确：画布底部不再有任何运行区 ——
 * 运行按钮、状态文字、结果占位全部删掉，**唯一入口**是画布内的
 * 蓝色主按钮。所以本组件：
 *
 *   · 位置：画布右上角浮动层（重置簇正下方，`absolute right-4 top-14`）
 *     —— 注意：与底部面板不同，浮动卡片**不会**伸进右侧工具栏，
 *     因为它的定位参照物是画布列 wrapper（relative），右边缘 ≤ 画布右缘。
 *   · 结构：标题行 → 想法清单（竖排、可滚动）→ 蓝色主按钮。
 *   · 空态：清单位置显示引导 + 「去组合想法 →」。
 *   · 未选想法：主按钮禁用 + hint「请先选择至少一个已生成想法」。
 *
 * ── P11 问题 3：清单同步 ──
 *
 * 每一次生成的想法都会出现在这份清单里（累积语义，后端不再删旧），
 * 列表项 = 标题 + 来源方法（sourceLabel），刷新由 LabShell 的
 * refreshData() 驱动 —— action 成功回调里已经调用，无需额外订阅。
 *
 * ── 数据钩子（验收脚本契约，勿改名）──
 *   data-crash-run-card            卡片根
 *   data-crash-idea-list           清单容器
 *   data-crash-idea-option={id}    单个想法（data-picked=1/0、data-already-ran）
 *   data-crash-ideas-empty         空态容器
 *   data-goto-idea                 去组合想法按钮
 *   data-run-crash                 蓝色主按钮（data-disabled=1/0）
 *   data-run-crash-hint            未选想法的提示文字
 *   data-crash-selected-count      已选数量
 *   data-crash-idea-count          想法总数
 */

export function CrashRunCard({
  ideas,
  selectedIds,
  pending,
  onSelectionChange,
  onRun,
  onGotoIdea,
}: {
  ideas: IdeaView[]
  /** 已选中的想法 id（真值在 LabShell → URL） */
  selectedIds: string[]
  pending: boolean
  onSelectionChange: (ideaIds: string[]) => void
  onRun: (ideaIds: string[]) => void
  /** 「去组合想法生成」—— 空态时的引导出口 */
  onGotoIdea: () => void
}) {
  const picked = new Set(selectedIds)
  const hasIdeas = ideas.length > 0
  const canRun = !pending && selectedIds.length > 0
  /** 已跑过击穿的想法数 —— 变化（新结果落库）时标题徽标播一次完成动画 */
  const ranCount = ideas.filter((it) => it.crashTest != null).length
  /**
   * P15 需求五：相似度色阶（纯前端，从已有 CrashTest 结果算）。
   * 已测想法条目加 3px 左色条 —— 与对比面板表头的色点同源同色，
   * 用户在清单里就能看出"哪两个想法长得像"。
   */
  const sim = computeIdeaColors(ideas)

  function toggle(id: string) {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectionChange(Array.from(next))
  }

  return (
    <div
      data-crash-run-card
      data-crash-selected-count={selectedIds.length}
      data-crash-idea-count={ideas.length}
      className="ma-card-in absolute right-4 top-14 z-20 flex w-[232px] flex-col rounded-xl border border-line bg-white/95 shadow-sm backdrop-blur-sm"
    >
      {/* ── 标题行（运行完成后徽标播 ma-run-done 短闪，P11 问题 4）── */}
      <div className="flex items-baseline gap-2 border-b border-line px-3 pb-2 pt-2.5">
        <span className="text-meta font-medium text-ink">已生成的想法</span>
        <span
          key={`${ideas.length}-${ranCount}`}
          data-crash-run-done={pending ? '0' : '1'}
          className={`text-meta text-ink-faint${ranCount > 0 ? ' ma-run-done' : ''}`}
        >
          {hasIdeas ? `（${ideas.length}）` : ''}
          {ranCount > 0 ? ` · 已测 ${ranCount}` : ''}
        </span>
      </div>

      {hasIdeas ? (
        <>
          {/* ── 想法清单：竖排、可滚动；每项 = 标题 + 来源方法 ──
              P18 问题 3b：卡片整体收窄（288→232px）、清单高度收小
              （34vh→24vh）—— 原尺寸占满右上角一大块，与竖排的击穿
              卡片、左侧对比面板挤在一起。 */}
          <div
            data-crash-idea-list
            className="flex max-h-[24vh] flex-col gap-1 overflow-y-auto px-2 py-1.5"
          >
            {ideas.map((it) => {
              const on = picked.has(it.id)
              const ran = it.crashTest != null
              const simColor = ran ? sim.colorOf[it.id] : undefined
              return (
                <button
                  key={it.id}
                  type="button"
                  data-crash-idea-option={it.id}
                  data-picked={on ? '1' : '0'}
                  data-already-ran={ran ? '1' : '0'}
                  data-sim-color={simColor}
                  aria-pressed={on}
                  disabled={pending}
                  onClick={() => toggle(it.id)}
                  title={it.description || it.title}
                  className="rounded-md border px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    // 四边全 longhand（P15-6 修复）：此前 borderColor(shorthand color)
                    // 与 borderLeft(shorthand) 混写，rerender 时 React 按序重置会
                    // 冲掉左色条颜色并告警 —— 与 CanvasStage 债务行同一纪律。
                    // 选中态三边加粗蓝框；已测想法左缘相似度色条常驻（选中/未选同色）。
                    borderTop: on ? '2px solid #2563eb' : '1px solid var(--line, #e5e7eb)',
                    borderRight: on ? '2px solid #2563eb' : '1px solid var(--line, #e5e7eb)',
                    borderBottom: on ? '2px solid #2563eb' : '1px solid var(--line, #e5e7eb)',
                    borderLeft: simColor
                      ? `3px solid ${simColor}`
                      : on
                        ? '2px solid #2563eb'
                        : '1px solid var(--line, #e5e7eb)',
                    background: on ? '#eff6ff' : '#ffffff',
                    color: on ? '#1d4ed8' : '#1a1a1a',
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    {/* 勾选态方块（不用图标库，字符即可） */}
                    <span
                      aria-hidden
                      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[9px] leading-none"
                      style={{
                        borderColor: on ? '#2563eb' : '#d1d5db',
                        background: on ? '#2563eb' : '#ffffff',
                        color: '#ffffff',
                      }}
                    >
                      {on ? '✓' : ''}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-meta">{it.title}</span>
                    {ran ? (
                      <span
                        data-crash-idea-ran
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none"
                        style={{ background: '#f3f4f6', color: '#6b7280' }}
                      >
                        已测
                      </span>
                    ) : null}
                  </span>
                  {/* 来源方法 —— P11 问题 3 的区分标签（后端已算好） */}
                  {it.sourceLabel ? (
                    <span
                      data-crash-idea-source={it.id}
                      className="mt-0.5 block truncate pl-5 text-[10px] leading-4 text-ink-faint"
                    >
                      {it.sourceLabel}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>

          {/* ── 蓝色主按钮：唯一运行入口 ── */}
          <div className="border-t border-line px-3 py-2">
            <button
              type="button"
              data-run-crash
              data-disabled={canRun ? '0' : '1'}
              disabled={!canRun}
              aria-disabled={!canRun}
              onClick={() => onRun(selectedIds)}
              className={
                'w-full rounded-md px-3 py-2 text-meta font-medium transition-colors ' +
                (canRun
                  ? 'text-white hover:brightness-110'
                  : 'cursor-not-allowed bg-[#f3f4f6] text-ink-faint')
              }
              style={canRun ? { background: '#2563eb' } : undefined}
            >
              {pending ? '正在击穿…' : `运行击穿测试${selectedIds.length > 0 ? `（${selectedIds.length}）` : ''}`}
            </button>
            {/* 未选想法时的提示 —— 按钮为什么是灰的，必须写出来 */}
            {!canRun && !pending ? (
              <p data-run-crash-hint className="mt-1.5 text-center text-[11px] text-ink-faint">
                请先选择至少一个已生成想法
              </p>
            ) : null}
          </div>
        </>
      ) : (
        /* ── 空态：还没有任何想法 —— 引导去组合想法生成 ── */
        <div data-crash-ideas-empty className="flex flex-col gap-2 px-3 py-2.5">
          <p className="text-meta leading-5 text-ink-soft">
            还没有生成任何想法。先去「组合想法」选定模块与债务，生成候选方案。
          </p>
          <button
            type="button"
            data-goto-idea
            onClick={onGotoIdea}
            className="rounded-md border border-line bg-white px-2.5 py-1.5 text-meta text-ink-soft transition-colors hover:bg-canvas"
          >
            去组合想法 →
          </button>
        </div>
      )}
    </div>
  )
}
