'use client'

import { useEffect } from 'react'

/**
 * 二次确认对话框。
 *
 * ── 为什么要自己写，而不是 window.confirm ──
 *
 * window.confirm 在前端自动化（Playwright）里会挡住整个 JS 主线程：
 * 页面脚本停顿，直到有人点掉那个原生弹窗。一旦测试里忘了注册 dialog
 * handler，断言就会以"超时"这种毫无信息量的方式失败。
 * 自己渲染一个 DOM 对话框，测试可以直接点它的按钮，链路可测。
 *
 * ── 为什么是 <div role="dialog"> 而不是 <aside> ──
 *
 * ⚠️ 这是本项目的一个硬约束，不是风格偏好。
 *   scripts/verify-panel-toolbar.py:88 用 `document.querySelector('aside')`
 *   取「右侧工具栏」来量它的 boundingBox.left；而折叠态右栏本身就是一个
 *   <aside>，展开态 RightToolbar 的根节点也是 <aside>。
 *   如果这个对话框也用 <aside>，一旦它先于右栏出现在 DOM 里，
 *   验收脚本量到的就是对话框的左边 —— 几何断言会莫名其妙地失败。
 *   所以：**新增浮层一律用 <div role="dialog">**。
 *
 * ── 交互纪律 ──
 *   · Esc 关闭：在 **捕获阶段** 监听。为什么不是冒泡阶段：
 *     画布上有自己的 Esc 处理（退出剪刀模式等），冒泡阶段可能被
 *     stopPropagation 截住，导致"按了 Esc 但对话框不关"。
 *     捕获阶段先于所有冒泡处理器执行，最可靠。
 *   · 点遮罩关闭：点在遮罩自身上才算（e.target === e.currentTarget），
 *     点内容区不关 —— 否则用户想复制一段说明文字，手一抖就关掉了。
 *   · 危险操作（删数据）用红色确认按钮，且默认焦点不给确认按钮。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作（不可逆的清空/删除）→ 确认按钮变红 */
  danger?: boolean
  /** 确认动作进行中 → 禁用两个按钮，避免重复提交 */
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    // 捕获阶段：详见文件头注释
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
      // 遮罩点击关闭：只有点在遮罩本身才关
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        data-confirm-dialog
        data-confirm-danger={danger ? '1' : '0'}
        className="w-full max-w-[420px] overflow-hidden rounded-xl border border-line bg-white shadow-xl"
      >
        <div className="px-5 pt-5">
          <h2 id="confirm-dialog-title" data-confirm-title className="text-body font-semibold text-ink">
            {title}
          </h2>
          <p data-confirm-desc className="mt-2 text-meta leading-relaxed text-ink-soft">
            {description}
          </p>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          <button
            type="button"
            data-confirm-cancel
            disabled={pending}
            onClick={onCancel}
            className="rounded-md border border-line px-3 py-1.5 text-meta text-ink-soft transition-colors hover:bg-canvas disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-confirm-ok
            disabled={pending}
            onClick={onConfirm}
            className={
              danger
                ? 'rounded-md bg-red-600 px-3 py-1.5 text-meta font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50'
                : 'rounded-md bg-ink px-3 py-1.5 text-meta font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50'
            }
          >
            {pending ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
