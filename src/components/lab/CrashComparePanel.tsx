'use client'

import { useEffect, useState } from 'react'
import type { IdeaView } from '@/lib/view-models'
import { DIMENSIONS, LEVEL_SCORE, computeIdeaColors, dimsOf } from '@/lib/lab/crash-similarity'

/**
 * ── P19 问题 3：想法对比 —— 从"左栏常驻"改为"浮动按钮 + 抽屉" ──
 *
 * P18 把它做成了画布左侧的真实占位列（420px 常驻 / 36px 折叠竖条）。
 * 后果是击穿视图里同时出现 7 层框：左栏对比 + 中栏击穿卡片 + 右栏想法列表
 * + 顶部进度 + 底部 AI 讨论 + logo + 缩放条 —— 一屏找不到视觉焦点。
 *
 * 本轮按"一屏只有 1 个视觉焦点"重构：
 *   · 左侧常驻列**删掉**，对比降级为左下角一枚浮动按钮（`想法对比`）；
 *   · 点开是覆盖式抽屉（`<div role="dialog">`，绝不用 `<aside>`：
 *     verify-panel-toolbar 用裸 `aside` 量右栏，新浮层用 aside 会让它量错对象）；
 *   · 关闭 = 点背景 / 点 ✕ / 按 Esc。
 *
 * 对比内容与算法**零改动**（保持既有行为）：
 *   · 全流程对比：6 维度 × N 想法的完整表格；
 *   · 关键差异对比：从已有 CrashTest 结果纯前端算差异分（不调模型）。
 *
 * ── 数据钩子（验收契约，P12/P18 的钩子全部保留）──
 *   data-compare-toggle                 浮动的「想法对比」按钮（P19 新增）
 *   data-compare-panel                  抽屉根（打开时才在 DOM 里）
 *   data-compare-collapsed="0"|"1"      折叠状态（抽屉内为 '0'）
 *   data-compare-collapse/-expand       折叠 / 展开按钮
 *   data-compare-mode="full" | "diff"   当前模式
 *   data-compare-mode-full / -diff      两个模式切换按钮
 *   data-compare-disabled-hint          未选满两个时的提示
 *   data-compare-cell={key}:{ideaId}    全流程表格单元格
 *   data-diff-dim / data-diff-reason    关键差异维度行 / 原因文本
 */

const LEVEL_ICON: Record<string, string> = {
  PASS: '✓',
  CONCERN: '⚠',
  BLOCKER: '✗',
  UNKNOWN: '?',
}

const LEVEL_SHORT: Record<string, string> = {
  PASS: '通过',
  CONCERN: '有疑虑',
  BLOCKER: '阻断',
  UNKNOWN: '未查',
}

/** 条长：差异可视化的横条宽度（按数值比例） */
const LEVEL_BAR: Record<string, string> = {
  PASS: '28%',
  UNKNOWN: '52%',
  CONCERN: '74%',
  BLOCKER: '100%',
}

const LEVEL_COLOR: Record<string, string> = {
  PASS: '#16a34a',
  UNKNOWN: '#9ca3af',
  CONCERN: '#d97706',
  BLOCKER: '#dc2626',
}

export function CrashComparePanel({
  ideas,
  selectedIds,
  pending,
  onOpenChange,
}: {
  /** 全部想法（含未选中的，用于取数据） */
  ideas: IdeaView[]
  /** 当前选中的想法 id（面板只对比选中的） */
  selectedIds: string[]
  pending: boolean
  /**
   * ── P19：把抽屉的开合状态上报给 LabShell ──
   *
   * 抽屉是覆盖式中栏的**模态**层，打开时下面的击穿报告既不可见也不该可点。
   * LabShell 据此给报告容器加 `inert` —— 被 inert 的子树会从可交互集合里
   * 整体摘掉（Chrome 支持），这样"零重叠扫描"看到的就是真实的可见层，
   * 而不是"被盖住但仍在 DOM 里"的幽灵元素（实测：不加 inert 会报 5 处
   * 假阳性交叠）。
   */
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)

  const setOpenAndNotify = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

  // 没有选中任何想法 → 连入口按钮都不渲染（与旧行为一致：面板不出现）
  if (selectedIds.length === 0) return null

  const picked = ideas.filter((i) => selectedIds.includes(i.id))
  const tested = picked.filter((i) => i.crashTest != null)
  const canDiff = tested.length >= 2 && !pending

  return (
    <>
      {/* ── 触发按钮：浮动在中栏右上角（tab 条下方）──
          位置纪律（都是实测踩出来的）：
            · 左下角压住报告底部的动作按钮（「查看关联想法」等）—— 交叠 98×32px；
            · 正右上角（top-3）压住报告标题行的 ✕ 关闭键 —— 交叠 14×20px；
            所以推到 top-14：报告标题行固定高约 57px，浮标落在标题行**下方**
            的正文留白区，既不挡关闭键也不挡左下动作按钮，也不与右下角的
            「共同探索」浮标争位。
          必须与抽屉**同级**挂在同一个 relative 容器上 —— 按钮是 absolute，
          套在里面的 inset-0 抽屉只会铺满按钮那么大（实测抓到的 bug）。 */}
      <button
        type="button"
        data-compare-toggle
        onClick={() => setOpenAndNotify(true)}
        title="打开多想法对比（全流程对比 / 关键差异对比）"
        className="ma-card-in absolute right-3 top-14 z-20 flex items-center gap-1.5 rounded-block border border-line bg-white/95 px-2.5 py-1.5 text-meta text-ink-soft backdrop-blur-sm transition-colors hover:border-accent hover:text-accent"
      >
        <span aria-hidden className="text-[11px] leading-none">
          ⇄
        </span>
        想法对比
        <span className="rounded-full bg-[#f3f4f6] px-1.5 text-[10px] tabular-nums text-ink-muted">
          {picked.length}
        </span>
      </button>

      {open && (
        <Drawer
          picked={picked}
          testedCount={tested.length}
          canDiff={canDiff}
          onClose={() => setOpenAndNotify(false)}
        />
      )}
    </>
  )
}

/** 覆盖式抽屉：左缘滑入，点背景 / ✕ / Esc 关闭 */
function Drawer({
  picked,
  testedCount,
  canDiff,
  onClose,
}: {
  picked: IdeaView[]
  testedCount: number
  canDiff: boolean
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-label="想法对比"
      data-compare-overlay
      className="absolute inset-0 z-30 flex"
    >
      {/* 背景遮罩：点击关闭。
          ── P19 修正：从"几乎透明"改成不透明（+ inert 兄弟层）──
          原来写 bg-black/[0.03]，下面的报告完全透出来，于是"抽屉里的按钮"
          与"报告底部的动作按钮"在几何上仍然同时存在 —— 零重叠扫描会如实
          报出它们交叠（实测 5 处）。抽屉是**模态**：打开时下面的报告既不
          可见也不该可点，所以这里给它一个不透明底色。
          真正把下层从可点击集合里摘掉的，是父容器上的 `inert`（见 LabShell）。 */}
      <button
        type="button"
        aria-label="关闭想法对比"
        data-compare-backdrop
        onClick={onClose}
        className="min-w-0 flex-1 cursor-default bg-[#f9fafb]"
      />
      <CompareBody
        picked={picked}
        testedCount={testedCount}
        canDiff={canDiff}
        onClose={onClose}
      />
    </div>
  )
}

function CompareBody({
  picked,
  testedCount,
  canDiff,
  onClose,
}: {
  picked: IdeaView[]
  testedCount: number
  canDiff: boolean
  onClose: () => void
}) {
  /** 初始模式 = 全流程对比（保持现有行为）；差异模式由用户主动切换 */
  const [mode, setMode] = useState<'full' | 'diff'>('full')
  /** 折叠态：收成 36px 竖条（保留既有交互与钩子） */
  const [collapsed, setCollapsed] = useState(false)

  const tested = picked.filter((i) => i.crashTest != null)

  // ---- P15 需求五：相似度色阶（纯前端，从已有 CrashTest 结果算）----
  const sim = computeIdeaColors(tested)

  // ---- 关键差异计算（纯前端，从已有 CrashTest 结果算）----
  const diffs = canDiff
    ? DIMENSIONS.map((dim) => {
        const scores = tested.map((i) => {
          const d = dimsOf(i)[dim.key]
          return d ? (LEVEL_SCORE[d.level] ?? 1) : null
        })
        const valid = scores.filter((s): s is number => s !== null)
        const max = valid.length ? Math.max(...valid) : 0
        const min = valid.length ? Math.min(...valid) : 0
        return { dim, score: max - min, texts: tested.map((i) => dimsOf(i)[dim.key]?.text ?? '') }
      })
        .filter((d) => d.score >= 1)
        .sort((a, b) => b.score - a.score)
    : []

  const hint = !canDiff
    ? testedCount < 2
      ? '至少选择两个想法（且都已运行击穿测试）'
      : '动作进行中'
    : ''

  if (collapsed) {
    return (
      <div
        data-compare-panel
        data-compare-mode={mode}
        data-compare-collapsed="1"
        className="ma-card-in flex h-full w-9 shrink-0 flex-col items-center gap-3 border-l border-line bg-white/95 py-3 backdrop-blur-sm"
      >
        <button
          type="button"
          data-compare-expand
          onClick={() => setCollapsed(false)}
          title="展开想法对比"
          aria-label="展开想法对比"
          className="flex h-6 w-6 items-center justify-center rounded-md border border-line text-[10px] text-ink-soft transition-colors hover:bg-canvas"
        >
          ▶
        </button>
        <span
          aria-hidden
          className="select-none text-[11px] font-medium tracking-widest text-ink-faint"
          style={{ writingMode: 'vertical-rl' }}
        >
          想法对比
        </span>
      </div>
    )
  }

  return (
    <div
      data-compare-panel
      data-compare-mode={mode}
      data-compare-collapsed="0"
      className="ma-card-in flex h-full w-[420px] max-w-[46%] shrink-0 flex-col overflow-hidden border-l border-line bg-white/95 backdrop-blur-sm"
    >
      {/* ── 标题 + 模式切换 + 折叠 / 关闭 ── */}
      <div className="flex items-center gap-2 border-b border-line px-3.5 pb-2 pt-3">
        <span className="text-meta font-medium text-ink">想法对比</span>
        <span className="text-meta text-ink-faint">
          （{tested.length}/{picked.length} 已测）
        </span>
        <div className="ml-auto flex overflow-hidden rounded-md border border-line">
          <button
            type="button"
            data-compare-mode-full
            aria-pressed={mode === 'full'}
            onClick={() => setMode('full')}
            className="px-2 py-1 text-[11px] transition-colors"
            style={{
              background: mode === 'full' ? '#1f2937' : '#ffffff',
              color: mode === 'full' ? '#ffffff' : '#4b5563',
            }}
          >
            全流程对比
          </button>
          <button
            type="button"
            data-compare-mode-diff
            data-diff-disabled={canDiff ? '0' : '1'}
            aria-pressed={mode === 'diff'}
            disabled={!canDiff}
            title={canDiff ? '只看差异最大的维度' : hint}
            onClick={() => setMode('diff')}
            className="px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: mode === 'diff' && canDiff ? '#1f2937' : '#ffffff',
              color: mode === 'diff' && canDiff ? '#ffffff' : '#4b5563',
            }}
          >
            关键差异对比
          </button>
        </div>
        <button
          type="button"
          data-compare-collapse
          onClick={() => setCollapsed(true)}
          title="折叠成竖条"
          aria-label="折叠想法对比面板"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-line text-[10px] text-ink-soft transition-colors hover:bg-canvas"
        >
          ▶
        </button>
        <button
          type="button"
          data-compare-close
          onClick={onClose}
          title="关闭对比（Esc）"
          aria-label="关闭想法对比"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] leading-none text-ink-muted transition-colors hover:bg-[#f3f4f6] hover:text-ink"
        >
          ✕
        </button>
      </div>

      {/* 未选满两个：关键差异模式的置灰提示 */}
      {!canDiff && (
        <p
          data-compare-disabled-hint
          className="border-b border-line bg-[#fffbeb] px-3.5 py-1.5 text-[11px] leading-4 text-[#92400e]"
        >
          {hint}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2.5">
        {mode === 'full' ? (
          /* ═══ 全流程对比：6 维度 × N 想法 的完整表格 ═══ */
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr>
                <th className="w-[86px] border-b border-line pb-1 pr-2 text-left font-normal text-ink-faint">
                  维度
                </th>
                {picked.map((i) => {
                  const simColor = sim.colorOf[i.id]
                  return (
                    <th
                      key={i.id}
                      data-compare-idea-color={i.id}
                      className="border-b border-line pb-1 text-left align-bottom font-medium text-ink"
                    >
                      <span className="flex items-center gap-1.5">
                        {simColor && (
                          <span
                            aria-hidden
                            data-sim-color={simColor}
                            className="inline-block h-2 w-2 shrink-0 rounded-full"
                            style={{ background: simColor }}
                            title="颜色按击穿结果相似度映射：越接近越相似"
                          />
                        )}
                        <span className="line-clamp-2 leading-4">{i.title}</span>
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {DIMENSIONS.map((dim) => (
                <tr key={dim.key}>
                  <td className="border-b border-line/60 py-1.5 pr-2 align-top text-ink-soft">
                    {dim.label}
                  </td>
                  {picked.map((i) => {
                    const d = dimsOf(i)[dim.key]
                    if (!d) {
                      return (
                        <td
                          key={i.id}
                          data-compare-cell={`${dim.key}:${i.id}`}
                          className="border-b border-line/60 py-1.5 align-top text-ink-faint"
                        >
                          未测试
                        </td>
                      )
                    }
                    return (
                      <td
                        key={i.id}
                        data-compare-cell={`${dim.key}:${i.id}`}
                        data-cell-level={d.level}
                        className="border-b border-line/60 py-1.5 align-top leading-4"
                        style={{ color: LEVEL_COLOR[d.level] ?? '#6b7280' }}
                      >
                        {LEVEL_ICON[d.level] ?? '⚠'} {LEVEL_SHORT[d.level] ?? d.level}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          /* ═══ 关键差异对比：差异分排序的维度行 ═══ */
          <div className="flex flex-col gap-3">
            {diffs.length === 0 ? (
              <p className="py-3 text-center text-[11px] text-ink-faint">
                所选想法在 6 个维度上判定一致 —— 没有值得突出的差异。
              </p>
            ) : (
              diffs.map(({ dim, score, texts }) => (
                <div
                  key={dim.key}
                  data-diff-dim={dim.key}
                  data-diff-score={score}
                  className="rounded-md border border-line px-2.5 py-2"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-meta font-medium text-ink">{dim.diffLabel}</span>
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                      style={{ background: '#fef2f2', color: '#b91c1c' }}
                    >
                      相差 {score} 档
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-col gap-1">
                    {picked.map((i) => {
                      const d = dimsOf(i)[dim.key]
                      if (!d) return null
                      const simColor = sim.colorOf[i.id]
                      return (
                        <div key={i.id} className="flex items-center gap-2">
                          <span className="flex w-[110px] shrink-0 items-center gap-1.5">
                            {simColor && (
                              <span
                                aria-hidden
                                data-sim-color={simColor}
                                className="inline-block h-2 w-2 shrink-0 rounded-full"
                                style={{ background: simColor }}
                              />
                            )}
                            <span className="truncate text-[10px] text-ink-muted">{i.title}</span>
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className="block h-[7px] rounded-full"
                              style={{
                                width: LEVEL_BAR[d.level] ?? '52%',
                                background: LEVEL_COLOR[d.level] ?? '#9ca3af',
                              }}
                            />
                          </span>
                          <span
                            className="shrink-0 text-[10px] tabular-nums"
                            style={{ color: LEVEL_COLOR[d.level] ?? '#6b7280' }}
                          >
                            {LEVEL_SHORT[d.level] ?? d.level}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  {texts.filter(Boolean).length > 0 && (
                    <p
                      data-diff-reason
                      className="mt-1.5 border-t border-line/60 pt-1.5 text-[10px] leading-4 text-ink-muted"
                    >
                      {texts
                        .map((t, idx) => (t ? `${picked[idx].title.slice(0, 12)}：${t.slice(0, 60)}` : ''))
                        .filter(Boolean)
                        .join(' ｜ ')}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
