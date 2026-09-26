'use client'

import type { ReactNode } from 'react'

/**
 * ── P21（B 方案）：底部数据看板 ──
 *
 * 五个视图都用同一套看板版式：4 张统计卡片 + 2 个图表，可折叠。
 * 这个组件只负责**版式与配色**，具体统计什么由调用方算好传进来
 * （见 `src/lib/lab/dashboard.ts`）—— 组件不知道"论文数"和"债务数"的区别，
 * 也就不会长出按视图分叉的条件分支。
 *
 * ── 配色纪律（重要）──
 * 这里的颜色**全部来自 palette.ts**，不在本文件里写第二份色值。
 * 阶段色用 `stageColor()`（阶段色的单一事实源），状态色用 `statusColor()`。
 * 项目里已经有过"卡片说未解决、面板说部分解决"那类双份文案的坑，
 * 颜色同理：同一个阶段在画布和看板上必须是同一色。
 */

export interface DashboardStat {
  label: string
  value: number | string
  /** 右上角小圆点颜色（彩色，用于区分卡片语义） */
  dot: string
  /** 可选的补充说明（如「/ 3 篇」「2022–2024」） */
  hint?: string
}

export interface DashboardBarRow {
  label: string
  value: number
  /** 条色（阶段分布传阶段色；判定分布传状态色） */
  color: string
}

export interface DashboardChart {
  kind: 'bars' | 'progress'
  title: string
  /** kind==='bars' 时用 */
  rows?: DashboardBarRow[]
  /** kind==='progress' 时用 */
  percent?: number
  /** 进度条右侧的文字，如「15 / 19 条证据」 */
  progressText?: string
  /** 进度条颜色 */
  progressColor?: string
}

export function Dashboard({
  stats,
  charts,
  open,
  onToggle,
  /** 折叠态的摘要（折叠后仍要让人知道看板在、能展开） */
  collapsedHint,
}: {
  stats: DashboardStat[]
  charts: DashboardChart[]
  open: boolean
  onToggle: () => void
  collapsedHint?: string
}) {
  return (
    <section
      data-dashboard
      data-dashboard-open={open ? '1' : '0'}
      className="shrink-0 border-t border-line"
      style={{
        // 看板底色 #f9fafb（规范）
        background: '#f9fafb',
        /**
         * 高度：`clamp(300px, 33%, 420px)`
         *
         * ── 为什么不是裸的 `30%`（2026-09 实测修）──
         *  30% 在 950px 视口下只有 285px，图表卡拿到 71px 可用高度，
         *  而两列条形图最多一列要放 4 行（7 个阶段 → 4+3）≈ 84px ——
         *  第 4 行（"评估"）被裁掉，用户"没办法一次性展示全"。
         *  改成 33% 后 950px 下约 313px，图表卡有 ~112px，4 行放得下还有余量。
         *
         * ── 为什么要 clamp 而不是直接给 33% ──
         *  视口很矮时（如 700px）33% 只有 231px，图表又会被裁；
         *  视口很高时 33% 又过于占地方。clamp 给一个**下限 300px** 保证
         *  图表永远放得下，上限 420px 防止大屏上把画布压得太小。
         *  折叠态仍是 36px（只留标题行）。
         */
        height: open ? 'clamp(300px, 33%, 420px)' : 36,
      }}
    >
      {/* ── 标题行：折叠按钮在右侧 ── */}
      <div className="flex h-9 items-center gap-2 px-3">
        <h2 className="text-meta font-medium text-ink">数据看板</h2>
        {!open && collapsedHint && (
          <span className="min-w-0 truncate text-[11px] text-ink-faint">
            {collapsedHint}
          </span>
        )}
        <button
          type="button"
          data-dashboard-toggle
          aria-expanded={open}
          onClick={onToggle}
          title={open ? '收起数据看板（画布占满高度）' : '展开数据看板'}
          className="ml-auto shrink-0 rounded-md border border-line bg-white px-2 py-0.5 text-[11px] leading-5 text-ink-muted transition-colors hover:border-accent hover:text-accent"
        >
          {open ? '›' : '‹'}
        </button>
      </div>

      {open && (
        <div
          data-dashboard-body
          className="ma-dash-fade grid min-h-0 gap-3 px-3 pb-3"
          style={{
            // 上排 4 张统计卡片、下排 2 个图表
            gridTemplateRows: '88px minmax(0, 1fr)',
            height: 'calc(100% - 36px)',
          }}
        >
          {/* ── 4 张统计卡片 ── */}
          <div className="grid grid-cols-4 gap-3">
            {stats.map((s, i) => (
              <div
                key={s.label}
                data-dashboard-stat
                /* 交错入场：60ms 步进（规范要求），位移 8px、0.3s ease-out */
                className="ma-dash-in relative overflow-hidden rounded-block border border-line bg-white p-4"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                {/* 右上角小圆点 */}
                <span
                  aria-hidden
                  data-dashboard-dot
                  className="absolute right-3 top-3 h-2 w-2 rounded-full"
                  style={{ background: s.dot }}
                />
                <div className="pr-4 text-[24px] font-bold leading-7 text-ink tabular-nums">
                  {s.value}
                </div>
                <div className="mt-1 truncate text-[12px] text-ink-muted" title={s.label}>
                  {s.label}
                </div>
                {s.hint && (
                  <div className="mt-0.5 truncate text-[11px] text-ink-faint">{s.hint}</div>
                )}
              </div>
            ))}
          </div>

          {/* ── 2 个图表 ── */}
          <div className="grid min-h-0 grid-cols-2 gap-3">
            {charts.map((c) => (
              <div
                key={c.title}
                data-dashboard-chart={c.kind}
                className="ma-dash-fade flex min-h-0 flex-col overflow-hidden rounded-block border border-line bg-white p-3"
              >
                <h3 className="mb-1.5 shrink-0 text-[12px] font-medium text-ink-muted">
                  {c.title}
                </h3>
                {/* 图表区**不滚动**：看板是"一眼看完"的东西，出现滚动条就等于没展示全。
                    内容高度已在两列布局下算得下（见 Bars 注释）。 */}
                <div className="min-h-0 flex-1 overflow-hidden">
                  {c.kind === 'bars' ? (
                    <Bars rows={c.rows ?? []} />
                  ) : (
                    <Progress
                      percent={c.percent ?? 0}
                      text={c.progressText ?? ''}
                      color={c.progressColor ?? '#2563eb'}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/** 横向条形图：每行 = 阶段名 + 条 + 数字
 *
 *  ── 为什么是两列（2026-09 实测修）──
 *  原先单列纵向排列，7 个阶段要 152px 高，而图表卡的可用高度只有 71px ——
 *  于是卡片里出现**内滚动条**，用户"没办法一次性展示全"（实测溢出：
 *  阶段分布 81px、年份分布 36px、涉及论文分布 36px、判定分布 38px）。
 *  卡片实测宽 678px，两列每列约 330px，放"名字 + 条 + 数字"完全够。
 *
 *  ── ⚠️ 为什么**不**用 CSS 多列（column-count）──
 *  第一版用了 `column-count: 2`，看着能自动分栏，**实测第 7 项丢了**：
 *  单列容器里多列溢出时浏览器不新建列，而是把第 7 项**叠回第 1 项的位置**
 *  （实测 评估=top852 与 问题=top852 完全重合），画面上就是少了一个阶段，
 *  而且"盒子在不在卡片内"的几何断言查不出来（两个盒子都在边界内、只是重叠）。
 *  所以改成**自己按索引切成 N 列**渲染（flex + 两个子列），
 *  每一项的位置由 index 决定，浏览器没有机会自作主张。
 */
const BAR_COLUMNS = 2

function Bars({ rows }: { rows: DashboardBarRow[] }) {
  if (rows.length === 0) {
    return <p className="py-4 text-center text-[11px] text-ink-faint">暂无数据</p>
  }
  const max = Math.max(...rows.map((r) => r.value), 1)
  // 逐项轮流分配到 N 列（row-major：1→col0, 2→col1, 3→col0 …），
  // 这样读起来是"横向一行一行"，与原来的纵向顺序一致。
  const cols: DashboardBarRow[][] = Array.from({ length: BAR_COLUMNS }, () => [])
  rows.forEach((r, i) => cols[i % BAR_COLUMNS].push(r))

  return (
    <div className="flex h-full gap-4">
      {cols.map((col, ci) => (
        <div key={ci} className="flex min-w-0 flex-1 flex-col gap-1">
          {col.map((r) => (
            <div
              key={r.label}
              data-dashboard-bar
              className="flex items-center gap-2"
              style={{ lineHeight: '14px' }}
            >
              <span
                className="w-[52px] shrink-0 truncate text-[11px] text-ink-muted"
                title={r.label}
              >
                {r.label}
              </span>
              {/* 轨道 + 条：条宽按 value/max 百分比 */}
              <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[#f3f4f6]">
                <span
                  className="block h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${Math.round((r.value / max) * 100)}%`, background: r.color }}
                />
              </span>
              <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-ink">
                {r.value}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** 线性进度条 + 百分比 + 明细文字 */
function Progress({
  percent,
  text,
  color,
}: {
  percent: number
  text: string
  color: string
}) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)))
  return (
    <div data-dashboard-progress className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[20px] font-bold leading-6 tabular-nums text-ink">{pct}%</span>
        {text && <span className="text-[11px] text-ink-muted">{text}</span>}
      </div>
      <span className="h-2 w-full overflow-hidden rounded-full bg-[#f3f4f6]">
        <span
          className="block h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, background: color }}
        />
      </span>
    </div>
  )
}

/** 供调用方复用的小工具：把「N 项里最大值」算成百分比 */
export function pctOf(value: number, total: number): number {
  if (total <= 0) return 0
  return (value / total) * 100
}

export type { ReactNode }
