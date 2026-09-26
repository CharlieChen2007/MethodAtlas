'use client'

import type { PanelContent } from '@/lib/lab/panel'
import { EVIDENCE_STATUS_LABEL } from '@/lib/enums'
import { statusColor, toneForEvidence } from '@/lib/lab/palette'

/**
 * ── P21：右侧详情栏（DNA / 演化 / 债务三个视图共用）──
 *
 * 产品本轮指出的共同问题：
 *   「这三个视图都是"一条内容 + 大画布"，右侧或上下 70% 是空的。」
 * 共同改法：改成「左内容 + 右详情」两栏，详情面板只在选中时显示内容，
 * 未选中时给一句提示语。
 *
 * ── 为什么复用 PanelContent 而不是新写一套详情 ──
 *
 * 详情该显示什么（标题 / 证据强度 / 分节 / 动作按钮）与底部面板**完全同源**：
 * 都来自 `buildPanelContent()`。如果这里另写一套渲染，同一份数据会出现
 * 两种措辞（历史踩过的坑：卡片说"未解决"、面板说"部分解决"）。
 * 所以这里只做**版式**：把底部面板的横向宽版改成右侧的纵向窄版。
 *
 * ── 三态 ──
 *   未选中 → 占位提示（placeholder，由调用方给，如「点击画布上的模块查看详情」）
 *   选中   → 标题区 + 可滚动正文 + 底部动作
 *
 * ── 动画纪律（P20 口径）──
 *   挂载时整栏淡入（.ma-view-fade 同款 200ms，无位移）；
 *   切换选中项时正文用 .ma-list-item 的交错淡入（12px / 400ms）——
 *   这正是"内容换了"的注意力引导，且不违反"不做大幅位移"。
 */
export function DetailRail({
  content,
  onClose,
  onAction,
  pending,
  isActionBusy,
  placeholder,
  accent,
  borderColor,
  width = '30%',
}: {
  content: PanelContent | null
  onClose: () => void
  onAction: (kind: string, content: PanelContent) => void
  pending: boolean
  isActionBusy?: (kind: string) => boolean
  /** 未选中时的提示语，如「点击画布上的模块查看详情」 */
  placeholder: string
  /** 左缘 2px 视图色线（与画布列的 data-zone-band 同源） */
  accent?: string
  /** 详情面板的边框色（视图浅色，来自 VIEW_SOFT_BORDER）；不传则沿用 accent */
  borderColor?: string
  /** 栏宽，默认 30%（债务视图给 60%） */
  width?: string
}) {
  return (
    <aside
      data-detail-rail
      data-detail-empty={content ? '0' : '1'}
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-l border-line bg-white"
      style={{ width }}
    >
      {accent && (
        <span
          aria-hidden
          className="absolute left-0 top-0 z-10 h-full w-0.5"
          style={{ backgroundColor: accent }}
        />
      )}

      {!content ? (
        /* ── 未选中：一句提示，不画空框 ── */
        <div
          data-detail-placeholder
          className="flex h-full items-center justify-center px-6"
        >
          <p className="max-w-[220px] text-center text-meta leading-6 text-ink-faint">
            {placeholder}
          </p>
        </div>
      ) : (
        <section
          /* ── 面板契约：与 BottomPanel 的 <section> 保持**同一组钩子** ──
             为什么这里也要挂 data-panel / data-panel-label：
               验收脚本里的「详情面板」断言（边框色 2px、label 含区域名、
               动作按钮 data-panel-action）原本只认底部面板。P21 把
               dna/evolution/debt 的详情搬到右栏后，如果右栏不提供同一组
               契约，那些断言就会以"右栏里没有 [data-panel]"的样子失败 ——
               它们守的**不变量没变**（"详情是一块有视图色边框、带区域标签、
               带动作按钮的区域"），只是宿主换了位置。
             边框宽度取整数 2px：1.5px 会被 Chromium 布局取整回 1px（P15 实测）。 */
          data-panel
          data-panel-variant="rail"
          data-panel-label={content.label}
          className="ma-view-fade flex h-full flex-col bg-white"
          /* 四边同色 2px：不在 style 里写 borderTop:none 之类的单边覆盖 ——
             那会把 borderTopWidth 归零，而验收会读它（P15 B7）。颜色取
             borderColor（视图浅色），没传则退回 accent。 */
          style={{ borderColor: borderColor ?? accent, borderWidth: 2, borderStyle: 'solid' }}
          key={content.title}
        >
          {/* ── 标题区 ── */}
          <header className="shrink-0 border-b border-line px-5 py-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-ink-faint">{content.label}</span>
              {content.evidenceStatus && (
                <span
                  className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    color: statusColor(toneForEvidence(content.evidenceStatus)),
                    background: `${statusColor(toneForEvidence(content.evidenceStatus))}14`,
                  }}
                >
                  {EVIDENCE_STATUS_LABEL[
                    content.evidenceStatus as keyof typeof EVIDENCE_STATUS_LABEL
                  ] ?? content.evidenceStatus}
                </span>
              )}
              {content.subtitle && (
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
                  {content.subtitle}
                </span>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭详情"
                title="取消选中"
                className="ml-auto shrink-0 rounded-md px-2 py-1 text-meta text-ink-muted transition-colors hover:bg-[#f3f4f6] hover:text-ink"
              >
                ✕
              </button>
            </div>
            <h2 className="mt-1 text-[15px] font-semibold leading-6 text-ink">
              {content.title}
            </h2>
          </header>

          {/* ── 正文：自己滚动，整页依然不滚 ── */}
          <div
            data-detail-body
            className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          >
            <div className="space-y-4">
              {content.sections.map((s, i) => (
                <div key={i} className="ma-list-item">
                  {s.heading?.startsWith('查看详情') ? (
                    <details className="group">
                      <summary className="cursor-pointer list-none text-meta font-medium text-ink-muted transition-colors hover:text-ink">
                        <span className="inline-block transition-transform group-open:rotate-90">
                          ▸
                        </span>{' '}
                        {s.heading}
                      </summary>
                      <p className="whitespace-pre-line pl-4 pt-1.5 text-body leading-6 text-ink">
                        {s.body}
                      </p>
                    </details>
                  ) : (
                    <>
                      {s.heading && (
                        <h3 className="mb-1.5 text-meta font-medium text-ink-muted">
                          {s.heading}
                        </h3>
                      )}
                      {s.quote ? (
                        <blockquote className="border-l-2 border-line-strong py-1 pl-3 text-body leading-6 text-ink">
                          {s.body}
                        </blockquote>
                      ) : (
                        <p className="whitespace-pre-line text-body leading-6 text-ink">
                          {s.body}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* ── 底部动作（与底部面板同一套 kind → action 映射）── */}
          {content.actions.length > 0 && (
            <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-3">
              {content.actions.map((a) => (
                <button
                  key={a.kind}
                  type="button"
                  data-panel-action={a.kind}
                  disabled={isActionBusy ? isActionBusy(a.kind) : pending}
                  onClick={() => onAction(a.kind, content)}
                  className="rounded-block border border-line px-3 py-1.5 text-meta text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-line disabled:hover:text-ink"
                >
                  {a.label}
                </button>
              ))}
              {pending && (
                <span className="text-[11px] text-ink-faint">正在执行…</span>
              )}
            </footer>
          )}
        </section>
      )}
    </aside>
  )
}
