'use client'

import type { ReactNode } from 'react'
import { useEffect } from 'react'

export interface RightDrawerProps {
  open: boolean
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

export function RightDrawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: RightDrawerProps) {
  /**
   * ── 问题 5：Esc 关闭抽屉 ──
   *
   * 抽屉是全屏遮罩 + 右侧浮层，点遮罩、点右上角「关闭」都能关，
   * 但**键盘用户没有任何出路** —— 这是可访问性缺口，也是肌肉记忆缺口
   * （几乎所有人都会先本能按 Esc）。
   *
   * 为什么只在 open 时挂监听：抽屉关着时挂一个全局 keydown 处理器
   * 会让页面上多个抽屉/弹层争抢同一个按键，按下 Esc 出现"关了别的层"。
   * 只在 open 期间监听，谁开着谁负责收键。
   *
   * 为什么用捕获阶段（capture: true）：保证在冒泡到任何子元素之前
   * 就处理掉 —— 否则抽屉里若有输入框自己处理 Esc，会导致"要按两次"。
   */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="关闭侧边面板"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/20 backdrop-blur-[1px]"
      />

      <aside className="relative flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-snug text-slate-900">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-sm text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            关闭
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="border-t border-slate-200 px-5 py-3">{footer}</footer>
        )}
      </aside>
    </div>
  )
}
