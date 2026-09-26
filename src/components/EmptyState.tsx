import type { ReactNode } from 'react'

/**
 * EmptyState —— 统一的空状态组件
 *
 * 为什么不各页各写一套：空状态是这个项目里**最常出现的界面**之一 ——
 * 每个阶段在还没跑、或跑了但没结果时都会显示它。散落各处会导致：
 *   1. 视觉不一致（边框虚实、内边距、文字颜色各不相同）
 *   2. 更糟的是**语义不一致**：有的空状态在说"你还没开始"，
 *      有的在说"跑了但没有结果"，这两件事对用户的意义完全不同
 *
 * 所以这里用 `tone` 把三类空状态区分开：
 *   - `idle`    还没开始做（中性灰，引导去操作）
 *   - `empty`   做了，但没有结果（蓝色，强调"这是一个有效结论"）
 *   - `blocked` 前置条件不满足（虚线 + 提示缺什么）
 *
 * 这个区分本身就是产品态度的一部分：本系统里「没有结果」是一个正当结论，
 * 不应该被渲染成失败。
 */
export type EmptyStateTone = 'idle' | 'empty' | 'blocked'

const TONE_STYLE: Record<EmptyStateTone, { box: string; title: string }> = {
  idle: {
    box: 'border-dashed border-slate-300 bg-white',
    title: 'text-slate-600',
  },
  empty: {
    box: 'border-line bg-accent-soft',
    title: 'text-ink',
  },
  blocked: {
    box: 'border-dashed border-amber-300 bg-amber-50/50',
    title: 'text-amber-800',
  },
}

export function EmptyState({
  tone = 'idle',
  title,
  hint,
  action,
  className = '',
}: {
  tone?: EmptyStateTone
  title: ReactNode
  hint?: ReactNode
  /** 可选的操作按钮 / 链接 */
  action?: ReactNode
  className?: string
}) {
  const style = TONE_STYLE[tone]

  return (
    <div
      className={`block-card ${style.box} p-8 text-center ${className}`.trim()}
    >
      <p className={`text-sm font-medium ${style.title}`}>{title}</p>
      {hint && (
        <p className="mx-auto mt-2 max-w-2xl text-xs leading-relaxed text-slate-500">
          {hint}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
