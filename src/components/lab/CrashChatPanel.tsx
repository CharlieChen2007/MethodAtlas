'use client'

import { useEffect, useRef, useState } from 'react'
import type { IdeaView } from '@/lib/view-models'

/**
 * 击穿测试 AI 对话 dock（P12 问题 3 建立，P13 问题 2 改为画布下方）。
 *
 * ── 它是什么 ──
 *
 * 就「当前选中的想法」与 AI 多轮讨论的对话框。上下文（想法 /
 * 目标债务 / 来源方法 / CrashTest 结果）由服务端从库里组装 ——
 * 前端只传会话历史与新消息，伪造不了上下文。
 *
 * ── P13 布局改造：浮动卡片 → 画布下方真实区块 ──
 *
 * 旧实现是画布内的浮动层（absolute left-4 bottom-4，浮在画布之上）：
 * 挡内容、且"浮着"不等于需求说的"画布下方"。现在改为画布列 flex
 * 布局里的**真实占位元素**（与 BottomPanel 同一模式，挂载点在画布
 * 容器与 BottomPanel 之间）：
 *
 *   · 标题行常驻（36px）：折叠钮 + 标题 + 上下文提示 + 话题切换
 *     —— 把旧版独立的"上下文状态行"合并进来，一行顶两行；
 *   · 展开区用 height 过渡（不是 translateY：高度必须真实变化，
 *     画布才能跟着收缩，理由见 BottomPanel 的同款注释）；
 *   · 收起时只剩标题行，画布拿回全部空间。
 *
 * ── 会话历史与隔离 ──
 *
 * 历史按 ideaId 分桶，存在 LabShell 的 state（不放 URL：会话是
 * 过程数据，不属于可分享的页面状态）。切到另一个想法 → 显示
 * 那个想法自己的桶，互不污染；重置（resetRun）时全部清空。
 *
 * ── 发送中的三态 ──
 *
 *   输入为空        → 发送按钮置灰（disabled）
 *   发送中          → 本地气泡显示"正在思考…"的呼吸态 + 输入框只读
 *   失败            → 反馈条报错 + 对话框内出现「重试」按钮（重发上一条）
 *
 * ── 数据钩子（验收契约，P12 起保持不变）──
 *   data-crash-chat              根（收起时 data-collapsed="1"）
 *   data-chat-collapse           标题行的折叠按钮
 *   data-chat-idea-select        想法切换下拉
 *   data-chat-input              输入框（textarea）
 *   data-chat-send               发送按钮（data-disabled=1/0）
 *   data-chat-loading            发送中提示
 *   data-chat-retry              失败后的重试按钮
 *   data-chat-msg                一条气泡（data-role=user/assistant）
 *   data-chat-empty              无想法时的空态
 */

/** 展开区高度：消息列表 + 重试行 + 输入区。150/…/54 的预算（px 字符串，
 *  与 BottomPanel 的 PANEL_H_PX 同风格 —— 布局值集中可查）。 */
const DOCK_H_PX = '224px'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  /** 发送失败的标记（dock 据此渲染重试按钮） */
  failed?: boolean
}

export function CrashChatPanel({
  ideas,
  selectedIds,
  activeId,
  onActiveChange,
  chats,
  onSend,
  sending,
  open,
  onOpenChange,
}: {
  ideas: IdeaView[]
  /** 击穿列表当前选中的想法（dock 默认讨论它） */
  selectedIds: string[]
  /** dock 当前讨论的想法 id（面板自己记住，切换列表不强制切话题） */
  activeId: string | null
  onActiveChange: (ideaId: string) => void
  /** 全部会话历史：ideaId → 消息数组（LabShell 持有） */
  chats: Record<string, ChatTurn[]>
  onSend: (ideaId: string, text: string, history: ChatTurn[]) => void
  sending: boolean
  /**
   * ── P19 减展示 5：展开态由外部控制，**默认折叠** ──
   *
   * 产品要求「底部：AI 讨论（默认折叠）」+「右下角浮动按钮
   * 『与MethodAtlas共同探索』点击打开 AI 讨论面板」。
   * 既然开关在画布右下角，展开态就必须提升到 LabShell ——
   * 组件内部再各存一份 state 会出现"点了浮标但面板没动"。
   */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  /** 受控/非受控兼容：传了 open 就完全听父级（缺省 false = 默认折叠） */
  const [collapsedLocal, setCollapsedLocal] = useState(true)
  const collapsed = open === undefined ? collapsedLocal : !open
  const setCollapsed = (next: boolean) => {
    if (open === undefined) setCollapsedLocal(next)
    else onOpenChange?.(!next)
  }
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const discussable = ideas // 全部想法都可讨论（含未跑击穿的）
  const active = discussable.find((i) => i.id === activeId) ?? null
  const history = activeId ? (chats[activeId] ?? []) : []
  const canSend = !sending && activeId != null && draft.trim().length > 0

  // 消息列表变化时滚到底部（新回复到达时保持可视）
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history.length, sending])

  function send() {
    if (!activeId || !canSend) return
    const text = draft.trim()
    onSend(activeId, text, history.filter((m) => !m.failed))
    setDraft('')
  }

  /** 失败后重试：取历史里最后一条失败的用户消息重发 */
  function retry() {
    if (!activeId || sending) return
    const lastFailed = [...history].reverse().find((m) => m.role === 'user' && m.failed)
    if (!lastFailed) return
    onSend(activeId, lastFailed.content, history.filter((m) => !m.failed))
  }

  const hasFailed = history.some((m) => m.failed)

  return (
    <div
      data-crash-chat
      data-collapsed={collapsed ? '1' : '0'}
      className="flex w-full shrink-0 flex-col border-t border-line bg-white"
    >
      {/* ── 标题行（常驻）：折叠 + 标题 + 上下文 + 话题切换 ── */}
      <div className="relative flex h-9 shrink-0 items-center gap-2 px-3">
        {/**
         * P14 区域分隔：左缘 2px 色线（击穿区视图色，与画布列色带同源）。
         * 让"对话 dock 属于击穿测试区域"在视觉上可辨，也标出 dock 的左边界。
         */}
        <span
          data-chat-accent
          aria-hidden
          className="absolute left-0 top-0 h-full w-0.5"
          style={{ backgroundColor: '#6b7280' }}
        />
        <button
          type="button"
          data-chat-collapse
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? '展开 AI 讨论' : '收起 AI 讨论'}
          className="text-[12px] leading-none text-ink-muted transition-colors hover:text-ink"
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="shrink-0 text-meta font-medium text-ink">AI 讨论</span>

        {/* 上下文提示（旧版独立状态行合并到此）：正在讨论谁、带没带击穿结果 */}
        {active && (
          <span className="min-w-0 flex-1 truncate text-[10px] leading-4 text-ink-faint">
            正在讨论：{active.title}
            {active.crashTest ? ' · 已带击穿结果' : ' · 尚未击穿'}
          </span>
        )}

        {discussable.length > 0 && (
          <select
            data-chat-idea-select
            value={activeId ?? ''}
            onChange={(e) => onActiveChange(e.target.value)}
            disabled={sending}
            className="ml-auto max-w-[170px] shrink-0 truncate rounded-md border border-line bg-white px-1.5 py-0.5 text-[11px] text-ink-soft"
          >
            {selectedIds.length > 0 && activeId && !selectedIds.includes(activeId) && (
              <option value={activeId}>（列表外）{active?.title ?? activeId}</option>
            )}
            {discussable.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* ── 展开区：height 过渡（不是 translateY —— 高度必须真实变化，
             上面的画布 flex-1 + min-h-0 才会跟着收缩/拿回空间） ── */}
      <div
        className="overflow-hidden"
        style={{ height: collapsed ? 0 : DOCK_H_PX, transition: 'height 160ms ease-out' }}
        aria-hidden={collapsed}
      >
        <div className="flex h-full flex-col">
          {/* ── 空态：还没有想法可讨论 ── */}
          {discussable.length === 0 ? (
            <div
              data-chat-empty
              className="flex items-center gap-2 px-3.5 py-3 text-[11px] leading-4 text-ink-faint"
            >
              还没有想法可讨论。先去「组合想法」生成或手动添加一个想法。
            </div>
          ) : (
            <>
              {/* ── 消息列表 ── */}
              <div
                ref={scrollRef}
                className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2"
              >
                {history.length === 0 && !sending && (
                  <p className="py-1 text-[11px] leading-4 text-ink-faint">
                    问这个想法的问题…
                  </p>
                )}
                {history.map((m, idx) => (
                  <div
                    key={idx}
                    data-chat-msg
                    data-role={m.role}
                    /* P20：对话气泡逐条淡入上移（70ms 交错）。
                       只对新出现的消息播一次 —— React 按 index 复用已有气泡，
                       已播过动画的元素 class 不变、不会重播。 */
                    className={`ma-list-item max-w-[72%] rounded-md border px-2 py-1.5 text-[11px] leading-4 ${
                      m.role === 'user'
                        ? 'self-end border-[#dbeafe] bg-[#eff6ff] text-ink'
                        : 'self-start border-line bg-white text-ink-soft'
                    }`}
                    style={m.failed ? { borderColor: '#fecaca', background: '#fff7f7' } : undefined}
                  >
                    {m.content}
                    {m.failed && <span className="mt-0.5 block text-[10px] text-[#b91c1c]">发送失败</span>}
                  </div>
                ))}
                {sending && (
                  <div
                    data-chat-loading
                    className="self-start rounded-md border border-line bg-white px-2 py-1.5 text-[11px] text-ink-faint"
                  >
                    <span className="ma-pulse">正在思考…</span>
                  </div>
                )}
              </div>

              {/* ── 失败重试 ── */}
              {hasFailed && !sending && (
                <div className="border-t border-line px-3 py-1.5">
                  <button
                    type="button"
                    data-chat-retry
                    onClick={retry}
                    className="rounded-md border border-line bg-white px-2 py-1 text-[11px] text-ink-soft transition-colors hover:bg-canvas disabled:opacity-50"
                  >
                    重试上一条
                  </button>
                </div>
              )}

              {/* ── 输入区 ── */}
              <div className="flex shrink-0 items-end gap-2 border-t border-line px-3 py-2">
                <textarea
                  data-chat-input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter 发送 / Shift+Enter 换行 —— 与常见聊天一致
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      send()
                    }
                  }}
                  disabled={sending || activeId == null}
                  rows={2}
                  maxLength={2000}
                  placeholder="问这个想法的问题…"
                  className="min-h-[34px] min-w-0 flex-1 resize-none rounded-md border border-line px-2 py-1 text-[11px] leading-4 text-ink placeholder:text-[#9ca3af] focus:border-accent focus:outline-none disabled:bg-[#f9fafb] disabled:opacity-60"
                />
                <button
                  type="button"
                  data-chat-send
                  data-disabled={canSend ? '0' : '1'}
                  disabled={!canSend}
                  onClick={send}
                  title={draft.trim() ? '发送' : '输入为空时不可发送'}
                  className="shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                  style={{ background: canSend ? '#2563eb' : '#cbd5e1' }}
                >
                  发送
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
