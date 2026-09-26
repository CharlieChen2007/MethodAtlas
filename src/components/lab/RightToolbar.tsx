'use client'

import { VIEW_IDS, VIEW_META, type ViewId } from '@/lib/lab/views'
import { viewColor, viewSemantic } from '@/lib/lab/palette'
import { stepMark, type Workflow } from '@/lib/lab/workflow'
import { ResetCluster } from './ResetCluster'

/**
 * 右侧工具栏 —— 6 个视图的纵向按钮 + 上传 + 论文切换器。
 *
 * 数据卡片感（产品要求）：
 *   - 每个视图一个主题色图标（复用 glyph，但按视图上色）
 *   - 数字徽标带彩色背景，不再是裸数字
 *   - 选中态加左侧 3px 色条
 *
 * P7-4 工作流串联（产品要求「6 个视图加编号 + 状态，让它像一条流程」）：
 *   每个按钮的标签列改成两行 —— 上行视图名，下行「第 N 步 · 状态」。
 *   状态来自 workflow.stepMark()，与顶部导航条**同一口径**，
 *   不会出现"导航条说完成、右栏说未开始"。
 *
 *   编号为什么 dna=第 1 步（不对齐导航条的第 2 步）：
 *   右栏从不显示「论文」项，天然是 1~6 连续编号。
 *   若编成"第 2 步"，会同屏出现两套编号 —— 那是错误信息。
 *   右栏的编号说的是"视图在流程里的次序"。
 *
 * 颜色纪律（三层隔离，见 palette 4.1 节）：
 *   视图主题色只落在 24px 的图标块和徽标胶囊上，不铺满按钮。
 *   选中态用「左侧色条 + 极浅主题底」表达，而不是整块填色 ——
 *   6 个按钮里只有 1 个选中，填色会让右栏看起来比画布还重。
 *
 * 语义标签（产品要求「颜色有语义」）：
 *   每个视图色的语义（结构/操作/时间/问题/生成/检验）直接显示在按钮上，
 *   并写进 title —— 颜色不再是纯装饰，悬停即可解释"它代表什么"。
 *
 * 不跳页：点击只改本地 state，URL 由 LabShell 用 history.replaceState 同步。
 */

export interface ToolbarPaper {
  id: string
  title: string
  blockCount: number
}

export function RightToolbar({
  view,
  onViewChange,
  papers,
  paperId,
  onPaperChange,
  /** 只有 dna 视图需要选论文（其他视图是跨论文的），传 false 时隐藏切换器 */
  showPaperSwitcher,
  counts,
  /** 工作流：拿每步的编号、完成状态、当前步 */
  workflow,
  /** 是否有动作正在进行（进行中统一 disable，避免并发点击） */
  pending,
  /** 正在上传解析的文件名（进行中显示状态文字，不是转圈动画） */
  uploadingName,
  /**
   * ── P16 问题一：重置簇迁入右栏 ──
   *
   * 挂在视图列表末尾（击穿测试按钮正下方）。为什么放这里：
   *   · 右栏是"全局动作 + 流程导航"的固定家，任何视图都在同一位置；
   *   · aside 是 flex-col 真实占位 —— 内容多了把论文切换器往下压，
   *     切换器自己 overflow-y-auto，重置簇永远不会盖住可点元素
   *     （旧浮动挂法 absolute 才有遮挡风险，这正是问题三要消灭的）。
   * 组件只上报"被点了"，二次确认（ConfirmDialog）与清理逻辑在 LabShell。
   */
  onResetRun,
  onResetData,
  resetPending,
  resetNonce,
}: {
  view: ViewId
  onViewChange: (v: ViewId) => void
  papers: ToolbarPaper[]
  paperId: string
  onPaperChange: (id: string) => void
  showPaperSwitcher: boolean
  /** 每个视图的数据条数，用于按钮右侧显示徽标（0 条时显示为灰点） */
  counts: Record<ViewId, number>
  workflow: Workflow
  pending?: boolean
  uploadingName?: string | null
  onResetRun?: () => void
  onResetData?: () => void
  resetPending?: boolean
  resetNonce?: number
}) {
  return (
    <aside className="flex h-full w-full flex-col overflow-hidden">
      {/* ── 6 个视图按钮 ── */}
      <div className="shrink-0 px-5 pt-6">
        <p className="mb-3 text-meta text-ink-faint">视图</p>
        <div className="flex flex-col gap-1">
          {VIEW_IDS.map((id) => {
            const meta = VIEW_META[id]
            const active = view === id
            const n = counts[id]
            const color = viewColor(id)
            const semantic = viewSemantic(id)
            const step = workflow.steps.find((s) => s.id === id)
            const mark = step ? stepMark(step, workflow) : null
            const stepNo = step?.stepNo ?? null
            // 状态小字色：当前用主题色，已完成中性灰，未开始浅灰
            const stateColor = !mark
              ? '#c4c7cc'
              : mark.state === 'current'
                ? color
                : mark.state === 'done'
                  ? '#9ca3af'
                  : '#c4c7cc'
            return (
              <button
                key={id}
                type="button"
                onClick={() => onViewChange(id)}
                // 语义标签 + 步骤写进 title —— 颜色有含义，步骤有位置
                title={`第 ${stepNo} 步 · ${mark?.stateText ?? ''}｜${meta.question}（色彩语义：${semantic}）`}
                data-view={id}
                data-view-color={color}
                data-view-semantic={semantic}
                data-view-state={mark?.state}
                data-view-step={stepNo}
                className="group relative flex w-full items-center gap-2.5 rounded-block py-2 pl-3.5 pr-3 text-left transition-colors"
                style={{
                  // 选中：极浅主题底。未选中：透明
                  background: active ? `${color}12` : 'transparent',
                  color: active ? color : '#1a1a1a',
                }}
              >
                {/* 选中态：左侧 3px 主题色条。
                    用绝对定位而不是 borderLeft —— border 会影响按钮内宽，
                    切换选中时文字会横向抖动。 */}
                {active && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full"
                    style={{ background: color }}
                  />
                )}

                {/* 主题色图标块：单字字形代替图标（产品禁止装饰性图标） */}
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-medium"
                  style={{
                    background: active ? `${color}1f` : '#f3f4f6',
                    color: active ? color : '#6b7280',
                    border: active ? `1px solid ${color}40` : '1px solid transparent',
                  }}
                >
                  {meta.glyph}
                </span>

                {/* 标签列：两行 —— 上行视图名，下行「第 N 步 · 状态」 */}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body">{meta.label}</span>
                  {mark && (
                    <span
                      className="truncate text-[10px] leading-3"
                      style={{ color: stateColor }}
                    >
                      第 {stepNo} 步 · {mark.stateText}
                    </span>
                  )}
                </span>

                {/* 语义标签（小字）—— 让"颜色代表什么"直接可读 */}
                <span
                  className="shrink-0 text-[10px]"
                  style={{ color: active ? color : '#c4c7cc' }}
                >
                  {semantic}
                </span>

                {/* 条数徽标 —— 有数据时用主题色胶囊，0 条用灰点（不写 0，避免视觉噪音） */}
                {n === 0 ? (
                  <span className="shrink-0 text-[11px] text-[#d1d5db]">·</span>
                ) : (
                  <span
                    className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
                    style={{
                      background: active ? `${color}1f` : '#f3f4f6',
                      color: active ? color : '#6b7280',
                    }}
                  >
                    {n}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* ── P16 问题一：重置簇（击穿测试按钮正下方）──
            条件挂载与旧 CanvasStage 挂法同口径：两个回调都传了才渲染。
            P18 问题 4：外框 w-fit 自适应内容宽（原来被 flex-col 的
            stretch 撑满整栏，视觉上"太大"）；两按钮并排不变。 */}
        {onResetRun && onResetData && (
          <div className="mt-1.5 flex w-fit">
            <ResetCluster
              onResetRun={onResetRun}
              onResetData={onResetData}
              pending={resetPending}
              animNonce={resetNonce}
            />
          </div>
        )}
      </div>

      {/* ── 分隔 ── */}
      <div className="mx-5 my-5 shrink-0 border-t border-line" />

      {/* ── 上传论文（问题 1：已迁到画布左上角）──
          原来这里是「＋ 上传论文」按钮。它有两个问题：
            ① 语义错位：右栏是"流程站点导航"，上传是"对画布加料"的动作；
            ② 可用性差：右栏下部是可滚动的论文切换器，论文一多这个按钮
               就被顶出视口，用户找不到入口。
          现在它固定在画布左上角（data-upload-toggle），
          与右上角的剪刀按钮左右对称 —— 左加右减，都在画布上。
          此处只留一行提示文字，告诉用户按钮去哪了，避免老用户找不到。 */}
      {uploadingName ? (
        <div className="shrink-0 px-5">
          <p className="mb-2 text-meta text-ink-faint">论文</p>
          <p
            data-upload-status
            className="rounded-block border border-dashed px-3 py-2 text-micro leading-4 text-ink-muted"
            style={{ borderColor: '#d1d5db' }}
          >
            正在解析 {truncate(uploadingName, 18)}…
          </p>
        </div>
      ) : null}

      {/* ── 论文切换器 ── */}
      {showPaperSwitcher ? (
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          <div className="flex flex-col gap-1">
            {papers.map((p) => {
              const active = p.id === paperId
              const noBlocks = p.blockCount === 0
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onPaperChange(p.id)}
                  /**
                   * 测试钩子：底部状态条删除后，验收脚本改用这里的条数
                   * 判断"项目数据已加载"。它是论文数据的真实出口，
                   * 不会因为 UI 调整而消失（对比状态条那种"可被删的展示层"）。
                   */
                  data-paper-item={p.id}
                  data-paper-blocks={p.blockCount}
                  data-paper-active={active ? '1' : '0'}
                  /**
                   * pending 时禁用切换 —— 上传/抽取进行中，正在写库与刷新，
                   * 此刻切论文会让"读哪篇"和"写哪篇"错位。
                   * （问题 1 之前这个 pending 是给上传按钮用的，
                   *   上传按钮搬走后把这份保护转给了论文切换器。）
                   */
                  disabled={Boolean(pending)}
                  className="relative flex w-full items-start gap-2 rounded-block border py-2 pl-3.5 pr-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  style={{
                    borderColor: active ? '#2563eb' : '#e5e7eb',
                    background: active ? '#eff6ff' : '#ffffff',
                    color: active ? '#2563eb' : noBlocks ? '#9ca3af' : '#1a1a1a',
                  }}
                >
                  {/* 与视图按钮一致的选中语言：左侧 3px 色条 */}
                  {active && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-accent"
                    />
                  )}
                  <span className="min-w-0 flex-1 text-meta leading-5">{p.title}</span>
                  {/* 有结构时显示 block 数，让"这篇论文有多少料"一眼可见 */}
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
        </div>
      ) : (
        <div className="min-h-0 flex-1" />
      )}
    </aside>
  )
}

function truncate(t: string, n: number): string {
  return t.length > n ? `${t.slice(0, n)}…` : t
}
