'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * 重置簇 —— 「↺ 重置」+「彻底重置」两枚按钮（P11 问题 1）。
 *
 * 挂载位置（P16 问题一后只有一处，所有视图都能找到同一个入口）：
 *   · RightToolbar（右栏工具栏）：视图列表末尾、击穿测试按钮正下方，
 *     真实占位（flex 布局兄弟），不是浮层 —— 论文一多只会压缩
 *     下方的论文切换器，绝不遮挡可点元素。
 *
 * 为什么抽成组件而不是复制两份 JSX：
 *   data-reset-run / data-reset-cluster / data-reset-anim 是验收契约，
 *   两份手抄必然漂移（P11 验收脚本就靠这些属性定位）。
 *
 * 两层确认弹窗（ConfirmDialog）不在本组件里 —— 组件只上报"被点了"，
 * 真正确认与清理逻辑在 LabShell（handleResetRun / handleResetData）。
 *
 * ── P14：重置动画本地化 ──
 *
 * 旧版动画由 LabShell 持一个布尔 state + 450ms 定时器驱动（`anim` prop）。
 * 现在改为 `animNonce`：LabShell 只在每次重置发生时把计数 +1，本组件
 * 自己监听 nonce 变化、自己置位 450ms、自己清理定时器。
 *
 * 为什么这样改：
 *   · 动画是纯表现层状态，生命周期应与组件共存亡（卸载即停），
 *     不该由父级替它管定时器；
 *   · nonce 是单调递增计数，天然支持"上一次动画还没播完又触发一次"
 *     的重入 —— 旧布尔置位对连续触发不敏感（true→true 无变化），
 *     nonce 每次都变，动画可靠重播。
 * 验收契约不变：data-reset-anim 仍是 '1'/'0'，断言口径不受影响。
 *
 * ── P15 曾整体放大 2 倍；P16 问题一：恢复原始尺寸并迁入右栏 ──
 *
 * 尺寸已还原为 P15 之前的原值（px-1 py-1 / text-[12px] / 13px 图标 /
 * h-4 分隔线 / rounded-block）。挂载点也变了：
 *   · 展开态：RightToolbar 视图列表末尾（击穿测试按钮正下方），
 *     随 aside flex-col 真实占位 —— 论文多时切换器被压缩滚动，
 *     重置簇永远不会盖住任何可点元素；
 *   · 折叠态：56px 窄条里只放一枚 32px ↺ 小按钮
 *     （data-reset-cluster-mini，见 LabShell renderRightRail），
 *     点击等同「重置」（二次确认照旧）。
 * 旧注释里"挂在画布/工作台右上角"的描述已过时，几何核算随之作废
 * （verify-p16 的 E 组断言改为：cluster ⊆ aside、在击穿测试按钮下方）。
 * 死类修复（text-ink-soft → text-ink-muted）保留。
 */
export function ResetCluster({
  onResetRun,
  onResetData,
  pending = false,
  animNonce = 0,
}: {
  onResetRun: () => void
  onResetData: () => void
  pending?: boolean
  /** 重置发生次数（每次 +1）；变化时本地播放一次 450ms 的动画 */
  animNonce?: number
}) {
  const [anim, setAnim] = useState(false)
  const animTimer = useRef<number | null>(null)
  const firstRender = useRef(true)

  useEffect(() => {
    // 首帧不播：nonce 的初值（可能是历史次数）不代表"刚刚发生了重置"
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (animNonce <= 0) return
    setAnim(true)
    if (animTimer.current !== null) window.clearTimeout(animTimer.current)
    animTimer.current = window.setTimeout(() => setAnim(false), 450)
    return () => {
      if (animTimer.current !== null) window.clearTimeout(animTimer.current)
    }
  }, [animNonce])

  return (
    <div
      data-reset-cluster
      data-reset-anim={anim ? '1' : '0'}
      className={`flex w-fit shrink-0 items-center gap-0.5 self-start rounded-block border border-line bg-white/92 px-1 py-1 backdrop-blur-sm${
        anim ? ' anim-reset' : ''
      }`}
    >
      <button
        type="button"
        data-reset-run
        disabled={pending}
        onClick={onResetRun}
        title="清空目标债务、已选模块、跑过标记与击穿选中，论文与结构数据保留"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] leading-none text-ink-muted transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span aria-hidden className="text-[13px] leading-none">
          ↺
        </span>
        <span>重置</span>
      </button>
      <span aria-hidden className="h-4 w-px bg-line" />
      <button
        type="button"
        data-reset-data
        disabled={pending}
        onClick={onResetData}
        title="在重置的基础上，进一步删除已生成的想法与击穿结果（需要二次确认）"
        className="rounded-md px-2 py-1 text-[12px] leading-none transition-colors hover:bg-[#fef2f2] disabled:cursor-not-allowed disabled:opacity-50"
        style={{ color: '#b91c1c' }}
      >
        彻底重置
      </button>
    </div>
  )
}
