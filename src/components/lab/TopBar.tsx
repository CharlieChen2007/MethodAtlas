'use client'

import { useEffect, useRef, useState } from 'react'
import { VIEW_IDS, VIEW_META, type ViewId } from '@/lib/lab/views'
import { viewColor } from '@/lib/lab/palette'
import { ResetCluster } from './ResetCluster'

/**
 * ── P19 减展示 1：顶部紧凑工具栏（一行）──
 *
 * 产品要求「顶部从"一排按钮"变成"一行紧凑工具栏"」：
 *
 *   [logo] MethodAtlas   [ 方法 DNA ▾ ]   论文标题         ＋上传  ⚙分析  ↺重置
 *   └── 品牌 ──┘         └─ 视图切换 ─┘   └─ 当前论文 ─┘  └──── 操作 ────┘
 *
 * ── 为什么视图切换是下拉而不是 7 个并排按钮 ──
 *
 * 5 个视图标签（方法 DNA / 方法演化 / 研究债务 / 组合想法 / 击穿测试）
 * 并排至少 400px，再叠上论文标题与三个操作按钮，一行放不下 ——
 * 只能换行或缩字号，两者都违背"一行紧凑"与"字号下限 12px"。
 * 收成一个下拉后，顶栏宽度与视图数量**解耦**（将来加视图也不会变宽）。
 *
 * ── 导航出口纪律（很重要）──
 *
 * 下拉是"视图切换"的第二出口，**不是唯一出口**：左侧导航栏（LeftRail）
 * 里 5 个视图按钮常驻。历史教训：曾经为了美观把右栏藏掉，导致某个视图里
 * 用户没有任何办法切走（实测脚本都点不到）。所以这里即使下拉渲染失败，
 * 用户也永远有第二条路。
 *
 * ── 关闭行为 ──
 *
 * 点外部 / 按 Esc / 选中项 → 关闭。原生 details 做不到"点外部关闭"，
 * 所以用受控 state + document 监听（无 UI 库，符合项目零依赖纪律）。
 */

export interface TopBarPaper {
  id: string
  title: string
  /** 方法模块数（下拉里显示徽标；0 条显示「无结构」） */
  blockCount: number
}

export function TopBar({
  view,
  onViewChange,
  counts,
  papers,
  paperId,
  onPaperChange,
  pending,
  uploadingName,
  onRequestUpload,
  onAnalyze,
  analyzeLabel,
  onResetRun,
  onResetData,
  resetNonce,
}: {
  view: ViewId
  onViewChange: (v: ViewId) => void
  /** 每个视图的数据条数（下拉里显示徽标） */
  counts: Record<ViewId, number>
  /** ── P21：论文切换下拉的数据 ── */
  papers: TopBarPaper[]
  paperId: string
  onPaperChange: (id: string) => void
  pending?: boolean
  uploadingName?: string | null
  onRequestUpload: () => void
  onAnalyze: () => void
  /** 「分析」按钮的文案随当前视图变化（点下去跑的是这条链路的 pipeline） */
  analyzeLabel: string
  onResetRun: () => void
  onResetData: () => void
  resetNonce?: number
}) {
  const [open, setOpen] = useState(false)
  /** P21：论文切换下拉的开合（与视图下拉互斥 —— 同时开两个会叠在一起） */
  const [paperOpen, setPaperOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const paperWrapRef = useRef<HTMLDivElement>(null)
  const meta = VIEW_META[view]
  const color = viewColor(view)
  const currentPaper = papers.find((p) => p.id === paperId) ?? null

  useEffect(() => {
    if (!open && !paperOpen) return
    const onDoc = (e: MouseEvent) => {
      if (open && !wrapRef.current?.contains(e.target as Node)) setOpen(false)
      if (paperOpen && !paperWrapRef.current?.contains(e.target as Node)) setPaperOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setPaperOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, paperOpen])

  return (
    <header
      data-top-bar
      className="relative z-30 flex h-11 shrink-0 items-center gap-2 border-b border-line bg-white px-3"
    >
      {/* ── 品牌 ── */}
      <span className="flex shrink-0 items-center gap-1.5">
        <img src="/logo-graphic.png" alt="" aria-hidden className="h-5 w-5 select-none object-contain" />
        <span className="hidden text-meta font-semibold tracking-tight text-ink sm:inline">
          MethodAtlas
        </span>
      </span>

      <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />

      {/* ── 当前视图切换（下拉）── */}
      <div ref={wrapRef} className="relative shrink-0">
        <button
          type="button"
          data-view-menu-toggle
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 rounded-block border px-2.5 py-1.5 text-meta transition-colors hover:bg-[#f9fafb]"
          style={{ borderColor: `${color}40`, color }}
          title={`${meta.label}｜${meta.question}`}
        >
          <span aria-hidden className="text-[11px] font-medium">
            {meta.glyph}
          </span>
          <span className="font-medium">{meta.label}</span>
          <span aria-hidden className="text-[9px] leading-none text-ink-faint">
            ▾
          </span>
        </button>

        {open && (
          <div
            data-view-menu
            role="listbox"
            className="ma-card-in absolute left-0 top-[calc(100%+4px)] z-40 w-[228px] overflow-hidden rounded-block border border-line bg-white py-1 shadow-md"
          >
            {VIEW_IDS.map((id) => {
              const m = VIEW_META[id]
              const active = id === view
              const c = viewColor(id)
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  /* 与左栏同钩子：脚本 querySelectorAll('[data-view]').first 命中的就是这里 */
                  data-view={id}
                  data-view-color={c}
                  onClick={() => {
                    onViewChange(id)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[#f9fafb]"
                  style={{ background: active ? `${c}12` : 'transparent' }}
                >
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px] font-medium"
                    style={{ background: active ? `${c}1f` : '#f3f4f6', color: active ? c : '#6b7280' }}
                  >
                    {m.glyph}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-meta"
                    style={{ color: active ? c : '#1a1a1a' }}
                  >
                    {m.label}
                  </span>
                  {counts[id] > 0 && (
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
                      style={{ background: active ? `${c}1f` : '#f3f4f6', color: active ? c : '#6b7280' }}
                    >
                      {counts[id]}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* ── 当前论文（P21：可点击切换，原左栏的论文列表已删除）──
          为什么做成下拉而不是保留左栏列表：
            论文切换是"换一篇看"的中频动作，而左栏是导航。列表放左栏时
            它自己滚动、把 logo 挤下去，展开态又只有 248px 宽（长标题要折 3 行）。
            收进顶栏后：标题就在当前视图旁边，切换入口和"我在看哪一篇"
            在同一处，左栏也腾出来只放导航。 */}
      <div ref={paperWrapRef} className="relative min-w-0 flex-1">
        <button
          type="button"
          data-top-paper
          data-paper-menu-toggle
          aria-haspopup="listbox"
          aria-expanded={paperOpen}
          disabled={papers.length === 0}
          onClick={() => setPaperOpen((o) => !o)}
          title={currentPaper ? `当前论文：${currentPaper.title}（点击切换）` : '选择论文'}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-block px-2 py-1.5 text-left transition-colors hover:bg-[#f9fafb] disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span aria-hidden className="shrink-0 text-[10px] text-ink-faint">
            论文
          </span>
          {/* 标题用 max-w 而不是 flex-1：flex-1 会把 ▾ 推到顶栏最右端，
              离标题很远（实测截图里那个孤零零的箭头就是这么来的）。 */}
          <span className="min-w-0 max-w-[46vw] truncate text-meta text-ink-muted">
            {currentPaper?.title ?? '未选择论文'}
          </span>
          {papers.length > 0 && (
            <span aria-hidden className="shrink-0 text-[9px] leading-none text-ink-faint">
              ▾
            </span>
          )}
        </button>

        {paperOpen && (
          <div
            data-paper-menu
            role="listbox"
            className="ma-card-in absolute left-0 top-[calc(100%+4px)] z-40 w-[420px] max-w-[70vw] overflow-hidden rounded-block border border-line bg-white py-1 shadow-md"
          >
            {papers.map((p) => {
              const active = p.id === paperId
              const noBlocks = p.blockCount === 0
              return (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  /* 钩子沿用旧名（验收脚本按它定位论文项），只是宿主从左栏换成顶栏下拉 */
                  data-paper-item={p.id}
                  data-paper-blocks={p.blockCount}
                  data-paper-active={active ? '1' : '0'}
                  disabled={Boolean(pending)}
                  onClick={() => {
                    onPaperChange(p.id)
                    setPaperOpen(false)
                  }}
                  title={p.title}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-60"
                  style={{ background: active ? '#eff6ff' : 'transparent' }}
                >
                  <span
                    className="min-w-0 flex-1 text-meta leading-5"
                    style={{ color: active ? '#2563eb' : noBlocks ? '#9ca3af' : '#1a1a1a' }}
                  >
                    {p.title}
                  </span>
                  {noBlocks ? (
                    <span className="mt-0.5 shrink-0 whitespace-nowrap text-[10px] text-ink-faint">
                      无结构
                    </span>
                  ) : (
                    <span
                      className="mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
                      style={{
                        background: active ? '#dbeafe' : '#f3f4f6',
                        color: active ? '#2563eb' : '#6b7280',
                      }}
                    >
                      {p.blockCount}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <span className="min-w-0 flex-1 lg:hidden" />

      {/* ── 操作：上传 / 分析 / 重置（重置与左栏同一条确认链路）── */}
      <div className="flex shrink-0 items-center gap-1.5">
        {uploadingName ? (
          <span
            data-upload-status
            className="hidden max-w-[180px] truncate text-micro text-ink-faint md:inline"
          >
            正在解析 {uploadingName}…
          </span>
        ) : null}

        <button
          type="button"
          data-upload-toggle
          data-upload-pending={uploadingName ? '1' : '0'}
          onClick={onRequestUpload}
          disabled={Boolean(uploadingName)}
          title="上传一篇 PDF 论文：解析 → 抽取方法结构"
          className="flex items-center gap-1 rounded-block border border-line px-2.5 py-1.5 text-meta text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span aria-hidden className="text-[11px] leading-none">
            ＋
          </span>
          上传
        </button>

        <button
          type="button"
          data-top-analyze
          onClick={onAnalyze}
          disabled={Boolean(pending)}
          title={`运行当前视图的分析链路：${analyzeLabel}`}
          className="flex items-center gap-1 rounded-block border border-line px-2.5 py-1.5 text-meta text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span aria-hidden className="text-[11px] leading-none">
            ▶
          </span>
          {analyzeLabel}
        </button>

        <ResetCluster
          onResetRun={onResetRun}
          onResetData={onResetData}
          pending={pending}
          animNonce={resetNonce}
        />
      </div>
    </header>
  )
}
