'use client'

import { useEffect, useRef, useState } from 'react'
import type { PanelContent } from '@/lib/lab/panel'
import { EVIDENCE_STATUS_LABEL } from '@/lib/enums'
import { statusColor, toneForEvidence } from '@/lib/lab/palette'

/**
 * 底部详情面板 —— 默认高度 0，点击画布节点后从底部滑出。
 *
 * 设计约束（产品要求）：
 *   - 默认不占位（高度 0），保持画布最大化
 *   - 点节点滑出，约 35% 高
 *   - 圆角 12px
 *   - 关闭：× 按钮，或点击画布空白
 *
 * 面板内部**自己滚动**（overflow-y-auto），页面整体依然不出现滚动条。
 * 这是"永不滚动"约束下的关键：滚动被关进面板里，而不是让整页变长。
 *
 * 动效用 transform: translateY 而不是 height，因为 height 动画会触发
 * 逐帧重排（面板内有长文本时更明显），translateY 只走合成层。
 */

/**
 * 面板高度。
 *
 * ── 为什么拆成「数值 + 单位」两个常量 ──
 *
 * 挤压布局要求外层占位高度 = 面板高度 + 上下留白，所以必须做加法。
 * 旧代码只有 `PANEL_H = '38vh'`（字符串），写成 `PANEL_H + 24` 会得到
 * `'38vh24'` —— 一个**非法 CSS 值**，浏览器直接忽略整个 height 声明，
 * 外层高度退化成 auto，挤压布局静默失效（面板又变成遮挡）。
 * 这个 bug 不会报错、不会崩，只在视觉上表现为"改了没用"，
 * 所以把数值和单位分开，用 calc() 相加，从类型上杜绝。
 */
const PANEL_H_NUM = 38

/**
 * ── P10 问题 1：给面板加高度上限 ──
 *
 * 纯 38vh 在矮窗口上会把画布压到不足以显示整棵树：
 *   950px 窗口 → 面板 361px，画布 510px  ✔ 够用
 *   560px 窗口 → 面板 213px，画布 268px  ✘ 6 个高节点的列放不下（需 478px）
 *
 * 上限取 320px：常见窗口（≥842px）不受影响，保持原来的 38vh 观感；
 * 矮窗口则让面板让出空间给画布。配合 CanvasStage 的纵向自适应缩放，
 * 保证"面板一开不会有 Block 消失"。
 *
 * 用 min() 而不是直接写死 px：宽屏上依旧是 38vh（面板可以更宽敞），
 * 只有矮窗口才被 320px 截断 —— 两边都不牺牲。
 */
const PANEL_H_MAX_PX = 320
const PANEL_H = `min(${PANEL_H_NUM}vh, ${PANEL_H_MAX_PX}px)`
/** 外层占位 = 面板高度 + 上边距 8px + 下边距 16px。从同一个表达式推导，改一处即可。 */
const PANEL_H_PX = `calc(${PANEL_H} + 24px)`

export function BottomPanel({
  content,
  onClose,
  onAction,
  pending = false,
  isActionBusy,
  accent,
  borderColor,
  prefillDebtTitle,
  onPrefillConsumed,
  variant = 'slide',
}: {
  content: PanelContent | null
  onClose: () => void
  /**
   * ── P19 问题 3：新增 `dock` 形态 ──
   *
   * 击穿测试视图改成"tab + 报告"结构后，报告需要**常驻中栏**（不是从
   * 底部滑出的详情面板）。两种形态复用同一套内容渲染（标题行 + 小节 +
   * 动作按钮），只有外层尺寸与行为不同：
   *
   *   slide（默认）  高度 0 ↔ min(38vh,320px)，底部滑出，受画布列宽限制
   *   dock           高度 100%（填满父级），无内外边距，圆角更小
   *
   * 为什么复用而不是新写一个报告组件：
   *   面板内容（crashPanel）已经包含结论、6 项检查、证据、以及
   *   「运行击穿测试 / 查看证据」等动作按钮 —— 再写一份必然与底部
   *   面板漂移（同一份数据两处渲染，措辞迟早不一致）。
   */
  variant?: 'slide' | 'dock'
  onAction: (kind: string, content: PanelContent) => void
  /** 有动作正在跑 —— 动作按钮统一 disable，避免并发触发两个 pipeline */
  pending?: boolean
  /**
   * P14 分区锁：按动作 kind 查"它所属区域是否忙"。
   * 提供时按钮的 disabled 用它（逐钮分区判定：手术忙只禁手术钮，
   * 击穿忙只禁击穿钮）；缺省回退旧的全局 pending（行为与 P13 一致）。
   * 口径与 LabShell 的 handlePanelAction case 标注同源，见 zones.ts。
   */
  isActionBusy?: (kind: string) => boolean
  /**
   * P14 区域分隔：标题行左缘 2px 色线（当前视图的视图色）。
   * 与画布列左缘的 data-zone-band 同色同源 —— 面板属于哪个区域，一眼可辨。
   */
  accent?: string
  /**
   * P15 需求二：面板四边边框色（当前视图的浅色边框 VIEW_SOFT_BORDER[view]）。
   * 缺省回退 class 的 border-line（行为与 P14 一致）。
   * 实现注意：class 保留 `border border-line`（shorthand 类），这里用内联
   * style 只覆写 longhand 的 borderColor/borderWidth —— 同一 style 对象内
   * 不混写 shorthand/longhand，不会触发 React 告警（回归套件有零告警断言）。
   */
  borderColor?: string
  /**
   * 从债务跳过来时预填的债务**标题**（「围绕它生成组合想法」用）。
   * 传标题而不是 id —— 用户看不懂 cuid，提示里要显示人能读的东西。
   */
  prefillDebtTitle?: string | null
  /** 预填提示被消费后回调（清掉 reducer 里的 contextDebtId） */
  onPrefillConsumed?: () => void
}) {
  const open = Boolean(content)
  const isDock = variant === 'dock'

  /**
   * 保留最后一次的非空内容 —— 关闭动画期间 content 会变 null，
   * 若直接渲染 null 面板会先闪空再滑下去。用 lastRef 让它滑出时还有内容。
   */
  const [shown, setShown] = useState<PanelContent | null>(content)
  const lastRef = useRef<PanelContent | null>(content)
  useEffect(() => {
    if (content) {
      lastRef.current = content
      setShown(content)
    } else {
      // 延迟清空，等滑出动画（180ms）走完
      const t = setTimeout(() => setShown(null), 200)
      return () => clearTimeout(t)
    }
  }, [content])

  return (
    /**
     * ── U2 修复：从「悬浮遮挡」改成「挤压占位」──
     *
     * 旧实现是 `absolute inset-x-0 bottom-0` —— 面板浮在画布之上，
     * 只把空态提示块上移避让（CanvasStage 的 liftedByPanel）。
     * 后果：**有数据时画布上的节点和连线会被面板压住**，用户看不到
     * 自己刚点的那个卡片，也无法判断"面板里讲的东西在图上哪个位置"。
     *
     * 现在改成 flex 布局里的**真实占位元素**：面板展开时占据
     * PANEL_H + padding 的高度，画布随之收缩（父级 flex-1 + min-h-0），
     * 内容全部可见，不再互相遮挡。
     *
     * 保留 `pointer-events-none` 的外层包裹是**必要**的：面板收起时
     * 高度为 0，但过渡动画期间仍有一小段残留区域，不能让它吞掉
     * 画布的点击。内层 section 加上 `pointer-events-auto` 恢复交互。
     *
     * 为什么用 height 而不是 translateY 做动画：
     *   挤压布局下"面板高度"就是"画布让出的高度"，必须真实变化才能
     *   让画布跟着重排。translateY 不改变占位，画布不会收缩。
     *   代价是触发重排，所以过渡时间压到 160ms 并锁死 will-change，
     *   避免长文本下掉帧。
     */
    <div
      className="pointer-events-none relative w-full shrink-0 overflow-hidden"
      style={
        isDock
          ? /* dock：真实占满父级高度，不做高度动画（它不存在"收起"语义） */
            { height: '100%' }
          : {
              // 收起时高度归零 —— 画布拿回全部空间，和"没有面板"完全一致。
              // 用 calc() 而非字符串拼接（见 PANEL_H_PX 的注释）。
              height: open ? PANEL_H_PX : 0,
              transition: 'height 160ms ease-out',
            }
      }
      aria-hidden={!open}
    >
      <section
        /**
         * ── P10 Step6：面板宽度对齐画布，不再用 max-w-3xl 居中 ──
         *
         * 旧写法 `mx-auto w-full max-w-3xl` 是"按整页宽度把一个 768px 的
         * 卡片居中"。问题有两层：
         *   ① 面板自身挂在整页宽度上（越界压工具栏，见 LabShell 注释）；
         *   ② 即使收窄容器，max-w-3xl 也让它既不贴画布左边、也够不到画布右边，
         *      "面板左边缘对齐画布左边缘、右边缘对齐画布右边缘"无法成立。
         *
         * 现在外层容器已经是**画布列**（宽度 = 画布宽度），这里只要铺满
         * 容器、留一点左右内边距即可：左边缘 = 画布左 + 8px，
         * 右边缘 = 工具栏左 - 8px，视觉上"在画布里展开"，零越界。
         */
        className={
          (isDock
            ? 'pointer-events-auto w-full overflow-hidden border-t border-line bg-white'
            : 'pointer-events-auto mx-2 w-[calc(100%-16px)] overflow-hidden border border-line bg-white') +
          /**
           * ── P20：展开时从下方滑入（16px + 淡入，300ms 弹性缓动）──
           * 只在展开态挂这个类：收起时挂上去会反向播一次"向上缩"，
           * 而收起的语义是"让出空间"（外层高度归零），不需要额外动作。
           *
           * 注意这里**没有**给外层 wrapper 加 key —— 加了会重挂载
           * wrapper，把它自己的 height 过渡一起打断（实测：面板会"跳"出来
           * 而不是滑出）。动画挂在内层 section 上就不会碰布局占位。
           */
          (open && !isDock ? ' ma-panel-up' : '')
        }
        data-panel
        data-panel-variant={variant}
        data-panel-label={shown?.label ?? undefined}
        style={{
          height: isDock ? '100%' : PANEL_H,
          marginTop: isDock ? 0 : 8,
          marginBottom: isDock ? 0 : 16,
          borderRadius: isDock ? 0 : 12,
          // P15 需求二：边框异色（有传参时覆写 class 的 border-line 灰）。
          // 宽度取整数 2px —— 1.5px 会被 Chromium 布局取整回 1px（实测）。
          ...(borderColor && !isDock ? { borderColor, borderWidth: 2 } : {}),
          opacity: open ? 1 : 0,
          transition: 'opacity 140ms ease-out',
          /**
           * 投影只用于表达"这是一块浮起的详情区"，不做阴影堆叠。
           * 因为不再遮挡画布，投影的层级语义弱化了，可以更淡。
           * dock 形态是常驻区，不是浮起层 —— 无投影。
           */
          boxShadow: isDock ? 'none' : open ? '0 2px 12px rgba(0, 0, 0, 0.06)' : 'none',
        }}
      >
        {shown && (
          <div className="flex h-full flex-col">
            {/* ── 头部：区域色线 + 标签 + 标题 + 关闭 ── */}
            <header className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-3.5">
              {accent && (
                <span
                  data-panel-accent
                  aria-hidden
                  className="mt-0.5 block h-10 w-0.5 shrink-0 rounded-full"
                  style={{ backgroundColor: accent }}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-ink-faint">{shown.label}</span>
                  {shown.evidenceStatus && (
                    <span
                      className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        // 证据强度用全局状态色：绿=充分、黄=有限、红=不足。
                        // 底色是极浅的同色系（12% 透明度），不是色块。
                        color: statusColor(toneForEvidence(shown.evidenceStatus)),
                        background: `${statusColor(toneForEvidence(shown.evidenceStatus))}14`,
                      }}
                    >
                      {
                        EVIDENCE_STATUS_LABEL[
                          shown.evidenceStatus as keyof typeof EVIDENCE_STATUS_LABEL
                        ] ?? shown.evidenceStatus
                      }
                    </span>
                  )}
                  {shown.subtitle && (
                    <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-faint">
                      {shown.subtitle}
                    </span>
                  )}
                </div>
                <h2 className="mt-1 text-[15px] font-semibold leading-6 text-ink">
                  {shown.title}
                </h2>
              </div>

              <button
                type="button"
                onClick={onClose}
                aria-label="关闭详情"
                className="shrink-0 rounded-md px-2 py-1 text-meta text-ink-muted transition-colors hover:bg-[#f3f4f6] hover:text-ink"
              >
                ✕
              </button>
            </header>

            {/* ── 正文：自己滚动，页面依然不滚 ── */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {/* ── 预填提示：从「研究债务」跳过来时，告诉用户"目标债务已带上" ── */}
              {prefillDebtTitle && (
                <div
                  data-prefill-debt
                  className="mb-4 flex items-start gap-2 rounded-block border px-3 py-2"
                  style={{ borderColor: '#bbf7d0', background: '#f0fdf4' }}
                >
                  <span className="mt-[2px] shrink-0 text-[12px] leading-none" style={{ color: '#16a34a' }} aria-hidden>
                    ✓
                  </span>
                  <p className="min-w-0 flex-1 text-[11px] leading-4" style={{ color: '#15803d' }}>
                    已带上目标债务「{prefillDebtTitle}」。点下方的「重新生成组合」，让新方案围绕它生成。
                  </p>
                  <button
                    type="button"
                    onClick={onPrefillConsumed}
                    aria-label="清除预填提示"
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] leading-none text-ink-faint transition-colors hover:bg-white hover:text-ink"
                  >
                    ✕
                  </button>
                </div>
              )}

              <div className="space-y-4">
                {shown.sections.map((s, i) => (
                  <div key={i}>
                    {/**
                     * ── 问题 7：「查看详情」折叠区 ──
                     *
                     * 带 `查看详情 ·` 前缀的小节是**展开信息**，不是必读内容。
                     * 用原生 `<details>` 折叠：默认收起，用户点开才看到。
                     * 选原生标签而不是手写 state —— 它自带可访问性语义
                     * （键盘可操作、屏幕阅读器能朗读展开状态），零副作用。
                     *
                     * 为什么用标题前缀而不是在 PanelSection 上加字段：
                     *   前缀是纯展示约定，数据层不必知道"UI 要不要折叠"。
                     *   将来要把某个小节改成折叠，改标题即可，不动类型。
                     */}
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

            {/* ── 底部动作 ── */}
            {shown.actions.length > 0 && (
              <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-3">
                {shown.actions.map((a) => (
                  <button
                    key={a.kind}
                    type="button"
                    // 测试钩子：验收脚本按 kind 精确点到某个动作按钮
                    data-panel-action={a.kind}
                    // 进行中 disable —— 不做"点了还在转"的假象。
                    // P14：有 isActionBusy 时按动作分区判定（本区忙只锁本区按钮），
                    //      或回退旧的全局 pending。
                    disabled={isActionBusy ? isActionBusy(a.kind) : pending}
                    onClick={() => onAction(a.kind, shown)}
                    className="rounded-block border border-line px-3 py-1.5 text-meta text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-line disabled:hover:text-ink"
                  >
                    {a.label}
                  </button>
                ))}

                {/* 有动作在跑时，在按钮行给一句状态文字（不是转圈动画） */}
                {pending && (
                  <span className="text-[11px] text-ink-faint">正在执行…</span>
                )}
              </footer>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
