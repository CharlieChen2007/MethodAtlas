'use client'

import { VIEW_IDS, VIEW_META, type ViewId } from '@/lib/lab/views'
import { viewColor } from '@/lib/lab/palette'
import { stepMark, type Workflow } from '@/lib/lab/workflow'
import { ResetCluster } from './ResetCluster'

/**
 * ── P19 减展示 2：左侧导航栏（默认折叠 48px）──
 *
 * 本轮把「右栏」整个删掉，导航与论文切换全部收进这一条左侧窄栏：
 *
 *   折叠态（默认，48px）  展开态（248px）
 *   ┌────────┐            ┌──────────────────────┐
 *   │   ○    │ ← 视图图标 │  流程                 │
 *   │   ○    │            │  ✓ 论文                │
 *   │   ○    │            │  ● 方法 DNA   ★        │
 *   │   ○    │            │  …                     │
 *   │   ○    │            │  论文                  │
 *   │  ↺     │ ← 重置     │  ▸ 论文 A · 12         │
 *   │  LOGO  │ ← 品牌     │  LOGO                  │
 *   └────────┘            └──────────────────────┘
 *
 * 为什么默认折叠：产品要求「一屏只有 1 个视觉焦点（画布/思维导图），
 * 其他全部收起来或降级」。导航是"我要去哪"的低频动作，不该常驻 25% 宽。
 *
 * ── 为什么 logo 放在这里（而不是画布上）──
 *
 * P18 把 logo 做成画布右下角的绝对定位图片，结果：① 浮在画布内容上、
 * 压住右下角；② 白色方块底与点阵背景不融合。本轮按要求把 logo
 * **移出画布**，放到左栏底部（品牌位置），画布上只保留功能控件。
 *
 * ── 折叠箭头方向纪律（本轮修正的问题 1）──
 *
 * 面板在左边时：
 *   · 折叠按钮画 `‹`（指向左）——"点了会往左边收"
 *   · 展开按钮画 `›`（指向右）——"点了会往右边长出来"
 * 旧版左侧栏用过 `▶`/`◀` 与 `<`/`>`，语义与位置不符（面板已在最左，
 * 再指向左会让人以为会被推出屏幕）。这里统一成指向"面板将要去的那一侧"。
 */

export function LeftRail({
  collapsed,
  onToggle,
  view,
  onViewChange,
  counts,
  workflow,
  pending,
  onResetRun,
  onResetData,
  resetNonce,
}: {
  collapsed: boolean
  onToggle: () => void
  view: ViewId
  onViewChange: (v: ViewId) => void
  counts: Record<ViewId, number>
  workflow: Workflow
  pending?: boolean
  onResetRun: () => void
  onResetData: () => void
  resetNonce?: number
}) {
  return (
    <aside
      data-nav
      data-nav-collapsed={collapsed ? '1' : '0'}
      className="flex h-full shrink-0 flex-col overflow-hidden border-r border-line bg-white transition-[width] duration-150"
      style={{ width: collapsed ? 48 : 248 }}
    >      {/* ── 顶部：展开 / 折叠按钮（常驻，两个状态都在同一位置）── */}
      <div className={collapsed ? 'flex justify-center pt-2' : 'flex justify-end px-2 pt-2'}>
        <button
          type="button"
          data-rail-toggle
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开导航栏' : '收起导航栏'}
          title={collapsed ? '展开导航栏（流程 / 论文 / 设置）' : '收起导航栏（把宽度让给画布）'}
          onClick={onToggle}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-[13px] leading-none text-ink-muted transition-colors hover:bg-[#f3f4f6]"
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      {collapsed ? (
        /* ═══════════ 折叠态：48px —— 视图字形 + 重置 ═══════════ */
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-hidden py-2">
          {VIEW_IDS.map((id) => {
            const meta = VIEW_META[id]
            const active = view === id
            const color = viewColor(id)
            return (
              <button
                key={id}
                type="button"
                data-view={id}
                data-view-color={color}
                /* ── P19：折叠态也要带 data-view-state ──
                   展开态的流程按钮带这个属性（current/done/todo），折叠态原来没有。
                   后果不只是"少个属性"：验收脚本用
                   `[data-nav] button[data-view][data-view-state="current"]`
                   判断"当前视图是哪个"，折叠态下这个查询恒为空数组 ——
                   "URL 回读后左栏当前视图=X" 三条断言全假失败。
                   折叠态只有 5 个视图按钮，能进这个映射的必然就是当前视图。 */
                data-view-state={active ? 'current' : undefined}
                aria-current={active ? 'page' : undefined}
                aria-label={meta.label}
                title={`${meta.label}｜${meta.question}`}
                onClick={() => onViewChange(id)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-[11px] font-medium transition-colors"
                style={{
                  background: active ? `${color}1f` : 'transparent',
                  color: active ? color : '#6b7280',
                  borderTop: active ? `1px solid ${color}40` : '1px solid transparent',
                  borderRight: active ? `1px solid ${color}40` : '1px solid transparent',
                  borderBottom: active ? `1px solid ${color}40` : '1px solid transparent',
                  borderLeft: active ? `1px solid ${color}40` : '1px solid transparent',
                }}
              >
                {meta.glyph}
              </button>
            )
          })}

          {/* 折叠态的重置入口：48px 放不下两枚，只留高频的「重置」。
              破坏性大的「彻底重置」需要先展开导航栏（多走一步是刻意的）。 */}
          <button
            type="button"
            data-reset-cluster-mini
            aria-label="重置"
            title="重置：清空目标债务、已选模块、跑过标记与击穿选中（展开导航栏可用彻底重置）"
            onClick={onResetRun}
            disabled={pending}
            className="mt-1 flex h-8 w-8 items-center justify-center rounded-md text-[13px] leading-none text-ink-muted transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-50"
          >
            ↺
          </button>
        </div>
      ) : (
        /* ═══════════ 展开态：248px —— 流程 + 论文 + 重置 ═══════════ */
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* ── 流程（7 步，与 TopBar / 工作流同一口径）── */}
          <div className="shrink-0 px-3 pt-3">
            <p className="mb-2 text-meta text-ink-faint">流程</p>
            <div className="flex flex-col gap-0.5">
              {workflow.steps.map((s) => {
                const mark = stepMark(s, workflow)
                const active = s.view != null && s.view === view
                const color = s.view ? viewColor(s.view) : '#6b7280'
                const isView = s.view != null
                return (
                  <button
                    key={s.id}
                    type="button"
                    /* 视图步骤才带 data-view —— 脚本按 [data-nav] button[data-view] 找导航 */
                    {...(isView ? { 'data-view': s.view as string } : {})}
                    data-view-step={s.stepNo ?? undefined}
                    data-view-state={mark.state}
                    disabled={!isView || Boolean(pending)}
                    title={
                      isView
                        ? `第 ${s.stepNo} 步 · ${mark.stateText}｜${VIEW_META[s.view as ViewId].question}`
                        : `论文：本项目已收录 ${s.count} 篇`
                    }
                    onClick={() => {
                      if (s.view) onViewChange(s.view)
                    }}
                    className="relative flex w-full items-center gap-2 rounded-block py-1.5 pl-2.5 pr-2 text-left transition-colors disabled:cursor-default"
                    style={{
                      background: active ? `${color}12` : 'transparent',
                      color: active ? color : '#1a1a1a',
                    }}
                  >
                    {active && (
                      <span
                        aria-hidden
                        className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full"
                        style={{ background: color }}
                      />
                    )}
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px] font-medium"
                      style={{
                        background: active ? `${color}1f` : '#f3f4f6',
                        color: active ? color : '#6b7280',
                      }}
                    >
                      {s.glyph}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-meta">{s.label}</span>
                    {/* 状态符号 + 角色标记（★ 当前 / → 建议），与旧右栏同口径 */}
                    <span
                      className="shrink-0 text-[10px] tabular-nums"
                      style={{ color: mark.state === 'current' ? color : '#9ca3af' }}
                      title={mark.stateText}
                    >
                      {mark.stateSymbol}
                      {mark.roleSymbol}
                    </span>
                    {s.count > 0 && (
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
                        style={{
                          background: active ? `${color}1f` : '#f3f4f6',
                          color: active ? color : '#6b7280',
                        }}
                      >
                        {s.count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* ── 设置：两级重置（并排小按钮，P18 问题 4 的形态保留）── */}
            <p className="mb-2 mt-3 text-meta text-ink-faint">设置</p>
            <div className="mb-1 flex w-fit">
              <ResetCluster
                onResetRun={onResetRun}
                onResetData={onResetData}
                pending={pending}
                animNonce={resetNonce}
              />
            </div>
          </div>

        </div>
      )}

      {/* ── 底部：品牌 logo（P19 从画布右下角迁来；画布上不再有任何 logo）──
          折叠态只留图形部分（窄条放不下字标），展开态显示完整 logo。 */}
      <div
        className={`shrink-0 border-t border-line ${collapsed ? 'flex justify-center py-2' : 'px-3 py-3'}`}
      >
        <img
          src="/logo.png"
          alt="MethodAtlas"
          draggable={false}
          data-rail-logo
          className={
            collapsed
              ? 'h-8 w-8 select-none rounded-md object-contain'
              : 'h-auto w-full max-w-[140px] select-none object-contain'
          }
        />
      </div>
    </aside>
  )
}
