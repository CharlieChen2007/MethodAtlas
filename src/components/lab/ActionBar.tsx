'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LabZone } from '@/lib/lab/zones'

/**
 * 动作反馈条 —— 把 server action 的真实结果呈现给用户。
 *
 * ── 为什么需要它（产品红线：「不做假动画」）──
 *
 * 常见的笨做法是：点击按钮 → 显示一个转圈 → 800ms 后显示"完成 ✓"。
 * 这个动画**与后端毫无关系**，无论 action 是成功、失败还是压根没跑，
 * 用户看到的都是同一个"完成"。这是在骗人。
 *
 * 本组件的做法：
 *   - 成功 → 绿色条，显示 action 返回的 **真实 message**（带真实计数，
 *     如"建立 3 条演化关系，5 条证据"）
 *   - 失败 → 红色条，显示 message + detail（真实错误原因）
 *   - 进行中 → 按钮文案变成进行时短语（如"正在分析…"），
 *     **不是转圈动画**，而是状态文字；按钮 disabled
 *
 * 没有"转圈→完成"这个伪造的中间态。用户看到的每一句话都来自后端返回。
 *
 * ── 为什么不用 toast 库 ──
 * 项目零 UI 依赖（连图库都没引）。一个固定在画布顶部、可手动关闭的
 * 提示条就够用，且不打断视线（不覆盖画布中心）。
 */

export type ActionPhase = 'idle' | 'pending' | 'ok' | 'error'

export interface ActionFeedback {
  phase: ActionPhase
  /** 正在做什么（pending 时显示，如"正在梳理演化关系…"） */
  pendingText?: string
  /**
   * 本次 pending 是什么时候开始的（epoch ms）。
   * 用于在长时间等待时显示已耗时秒数 —— 见下方 `hint`。
   */
  pendingStartedAt?: number
  /**
   * pending 期间的补充说明（如"推理模型较慢，预计 1-3 分钟"）。
   * 长任务的等待必须解释清楚"在等什么、还要多久"，
   * 否则用户看到的就是一个不动的界面，会以为卡死并去点别的地方。
   */
  hint?: string
  /** 后端返回的真实结果（ok / error 时显示） */
  message?: string
  /** 失败时的详细原因 */
  detail?: string
  /** 成功后自动消失的时间（ms）。失败不自动消失 —— 错误需要被看到 */
  autoHideMs?: number
}

export interface ActionFeedbackApi {
  feedback: ActionFeedback
  /** 执行一个真实动作：pending → await → ok/error */
  run: (opts: {
    pendingText: string
    /** pending 期间的补充说明，讲清"在等什么、大概多久" */
    hint?: string
    /** 真正调用 server action 的函数，返回 { ok, message, detail } */
    exec: () => Promise<{ ok: boolean; message: string; detail?: string }>
    /**
     * 成功后额外的本地动作（如切视图）。
     *
     * P14 起带第二个参数 `meta.superseded`：若本动作的结果展示已被
     * 更晚触发的动作顶替（反馈条单例，只显示最新的），此值为 true。
     * 刷新数据类回调（refreshData）应无条件执行；**切视图/选中**
     * 类回调应检查 `!superseded`，否则并发下会出现"迟到的跳转"。
     */
    onSettled?: (
      result: { ok: boolean; message: string; detail?: string },
      meta: { superseded: boolean }
    ) => void
    autoHideMs?: number
    /**
     * P14：本动作所属功能区域（分区锁）。缺省 'global' —— 与旧版
     * 全局锁行为完全一致，未标注 zone 的调用点不需要跟着改。
     *
     * 锁规则：
     *   · global 忙        → 全站锁定（论文切换/上传/重置影响全部数据）
     *   · 本区域忙          → 只锁本区域，其他区域照常可用
     *   · 入口守卫          → global 忙时拒绝新动作；同区域忙时拒绝重入
     *                        （按钮 disabled 的第二道防线，连点兜底）
     */
    zone?: LabZone
  }) => Promise<void>
  /** 手动清除反馈 */
  clear: () => void
  /** 当前是否正在跑某个动作（任一区域忙即为 true —— global 类按钮继续用它） */
  pending: boolean
  /**
   * P14 分区锁查询：本区域是否被锁定。
   * 区域按钮的 disabled 应该用它而不是 pending —— 一个区域忙不再连坐全站。
   */
  isBusy: (zone: LabZone) => boolean
}

/**
 * 动作反馈的状态机。
 *
 * 用 ref 记住"当前这一轮"的序号：如果用户在 action 跑完之前又点了别的
 * 按钮，旧 action 的回调不应该覆盖新 action 的提示（否则会出现
 * "点了演化，结果显示手术成功"的错乱）。序号对不上就直接丢弃结果。
 *
 * ── P14 分区锁 ──
 *
 * 旧版只有一个 pending 布尔量，天然全局互斥。P14 把"哪些区域忙"
 * 记在一个 Set 里（busyZones）：
 *   · run({ zone }) 把自己的 zone 加进 Set，finally 里无条件摘除；
 *   · 入口守卫：global 忙 → 拒绝一切新动作；同 zone 忙 → 拒绝重入
 *     （这是按钮 disabled 之外的第二道防线，兜住键盘触发/连点竞态）；
 *   · 允许不同 zone 并发 —— 这正是需求要的"一个区域忙，其他区域照常可用"。
 *
 * 反馈条仍是单例：并发时只显示**最新**动作的提示（seqRef 门控），
 * 被顶替的动作照常执行 onSettled（数据刷新不能丢），只是不再抢反馈条。
 */
export function useActionFeedback(): ActionFeedbackApi {
  const [feedback, setFeedback] = useState<ActionFeedback>({ phase: 'idle' })
  const [busyZones, setBusyZones] = useState<ReadonlySet<LabZone>>(() => new Set())
  const seqRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const clear = useCallback(() => {
    clearTimer()
    seqRef.current += 1 // 作废在途请求的结果
    setFeedback({ phase: 'idle' })
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  /** 分区锁查询：本区域忙，或任一 global 动作忙（全站锁） */
  const isBusy = useCallback(
    (zone: LabZone) => busyZones.has(zone) || busyZones.has('global'),
    [busyZones]
  )

  const run = useCallback<ActionFeedbackApi['run']>(
    async ({ pendingText, hint, exec, onSettled, autoHideMs = 6000, zone = 'global' }) => {
      // ── 入口守卫（P14）：被锁时静默拒绝，按钮 disabled 之外的兜底 ──
      if (busyZones.has('global') || busyZones.has(zone)) return

      const mySeq = ++seqRef.current
      clearTimer()

      setBusyZones((prev) => new Set(prev).add(zone))
      setFeedback({ phase: 'pending', pendingText, hint, pendingStartedAt: Date.now() })

      let result: { ok: boolean; message: string; detail?: string }
      try {
        result = await exec()
      } catch (err) {
        // server action 本身抛错（网络/序列化失败）—— 也是真实失败，照实报
        result = {
          ok: false,
          message: '调用未完成',
          detail: (err as Error)?.message ?? String(err),
        }
      } finally {
        // 无条件摘自己的锁：即使结果已被更新动作顶替，这把锁也必须归还，
        // 否则该区域被一个"没有反馈显示"的幽灵动作永久锁死。
        setBusyZones((prev) => {
          if (!prev.has(zone)) return prev
          const next = new Set(prev)
          next.delete(zone)
          return next
        })
      }

      // ── P14 seq 修正 ──
      // 旧版在这里 `if (mySeq !== seqRef.current) return` 把 onSettled 一并
      // 丢弃 —— 全局锁下并发不可能，所以无害；分区锁放开并发后，后完成的
      // 区域会吞掉先完成区域的 refreshData（画布不刷新）。因此改为：
      // onSettled 无条件执行（带 superseded 标志让回调自己决定 UI 跳转），
      // 仅反馈条的更新受 seq 门控。
      const superseded = mySeq !== seqRef.current
      onSettled?.(result, { superseded })

      if (superseded) return

      setFeedback({
        phase: result.ok ? 'ok' : 'error',
        message: result.message,
        detail: result.detail,
        autoHideMs,
      })

      // 只有成功才自动消失。失败留在屏幕上等用户处理。
      if (result.ok && autoHideMs > 0) {
        timerRef.current = setTimeout(() => {
          if (mySeq === seqRef.current) setFeedback({ phase: 'idle' })
        }, autoHideMs)
      }
    },
    [clearTimer, busyZones]
  )

  return {
    feedback,
    run,
    clear,
    pending: busyZones.size > 0,
    isBusy,
  }
}

/**
 * 把状态色按极低比例混进白色，得到"同色系浅底"。
 *
 * 手算而不是用 CSS 颜色函数（color-mix），因为：
 *   1. 验证脚本用 getComputedStyle 读 backgroundColor，color-mix
 *      在部分 Chromium 版本下会返回未解析的表达式
 *   2. 手算的结果是确定的 hex，截图与断言都稳定
 */
function tint(hex: string, ratio = 0.06): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#ffffff'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const mix = (c: number) => Math.round(c * ratio + 255 * (1 - ratio))
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}

/**
 * 反馈条 UI。
 *
 * 位置：画布顶部居中，不覆盖中心区域（主体在那里）。
 * 颜色：成功绿 / 失败红 / 进行中灰 —— 用的是**状态色域**，
 *       与视图色、阶段色分属三层，不混用。
 */
/**
 * 把秒数格式化成人类读着舒服的形式。
 * 90 → "1 分 30 秒"；45 → "45 秒"。
 * 超过 3 分钟就提示可能需要更久 —— 推理模型在长论文上确实会到这个量级。
 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`
}

export function ActionBar({
  feedback,
  onClear,
  /**
   * 需求 B：随反馈条一起出现的「下一步」入口。
   *
   * 典型用法：组合想法生成成功后，「去击穿测试 →」出现在这条成功提示里。
   * 为什么要挂在提示条上而不是单独飘一个按钮：
   *   生成成功是一个**瞬时事件**，用户此刻的注意力就在这条提示上。
   *   把"下一步去哪"直接放在他正在看的地方，这条链才走得顺；
   *   另起一个常驻按钮反而会变成界面噪音。
   *
   * 为什么是可选 prop 而不是新组件：提示条的位置/配色/出现时机
   *   已经是一套调好的东西，复制一份必然漂移。加个插槽最省事也最一致。
   */
  action,
}: {
  feedback: ActionFeedback
  onClear: () => void
  action?: { label: string; onClick: () => void; testId?: string }
}) {
  /**
   * 已耗时秒数。
   *
   * 为什么必须有这个：推理模型单次抽取要 30~110 秒，而界面原来在
   * pending 期间是完全静止的 —— 用户唯一能做的事就是盯着一个不动的
   * 提示条猜"是不是卡死了"，然后可能去刷新页面、重复提交。
   *
   * 一个每秒 +1 的计数器不具备任何"进度"含义，但它诚实地传达了
   * 一件关键的事：**系统还活着，还在等模型**。成本极低，消除的困惑很大。
   */
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (feedback.phase !== 'pending') return
    const started = feedback.pendingStartedAt ?? Date.now()
    setElapsed(Math.floor((Date.now() - started) / 1000))
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [feedback.phase, feedback.pendingStartedAt])

  if (feedback.phase === 'idle') return null

  const isPending = feedback.phase === 'pending'
  const isOk = feedback.phase === 'ok'
  const color = isPending ? '#6b7280' : isOk ? '#16a34a' : '#dc2626'
  const text = isPending ? feedback.pendingText : feedback.message

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-4 pt-4">
      <div
        /**
         * ── P11 问题 4 ──
         * data-feedback-state：验收脚本用截图/属性对比五种状态
         * （idle 时本组件不渲染，其余 pending/ok/error 直接可断言）。
         * 动画 class：
         *   pending → ma-pulse（圆点呼吸，"正在跑"）
         *   ok      → ma-ok-flash（绿色短闪，"刚完成"）
         *   error   → ma-shake-x（一次轻微左右位移，"出问题了"）
         * 均为一次性播放，150–300ms 量级，科学工具风格。
         */
        data-feedback-state={feedback.phase}
        className={`pointer-events-auto flex max-w-2xl items-start gap-3 rounded-panel border px-4 py-2.5 ${
          isOk ? 'ma-ok-flash' : !isPending ? 'ma-shake-x' : ''
        }`}
        style={{
          borderColor: `${color}55`,
          /**
           * 底色：白色 + 同色系 6% 叠色。
           *
           * 刻意**不用** linear-gradient —— 验证脚本禁止渐变条
           * （点阵底纹除外），用纯色 + borderRadius 同样能做出
           * 极浅的提示底，且不会触发"无渐变"断言失败。
           */
          backgroundColor: tint(color),
          boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
        }}
        role={isOk ? 'status' : 'alert'}
      >
        {/* 图标：进行中用方点（呼吸动画表示"活着"），完成用 ✓ / ✕ */}
        <span
          className={`mt-[3px] shrink-0 text-[12px] leading-none${isPending ? ' ma-pulse' : ''}`}
          style={{ color }}
          aria-hidden
        >
          {isPending ? '●' : isOk ? '✓' : '✕'}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-meta leading-5" style={{ color }}>
            {text}
            {isPending && elapsed >= 1 && (
              <span className="ml-2 tabular-nums text-[11px] text-ink-faint">
                已等待 {formatElapsed(elapsed)}
              </span>
            )}
          </p>
          {/* pending 期间显示"在等什么"，让长等待有解释 */}
          {isPending && feedback.hint && (
            <p className="mt-0.5 text-[11px] leading-4 text-ink-muted">{feedback.hint}</p>
          )}
          {feedback.detail && (
            <p className="mt-0.5 whitespace-pre-line text-[11px] leading-4 text-ink-muted">
              {feedback.detail}
            </p>
          )}
        </div>

        {/* 需求 B：成功后的「下一步」入口（如生成成功 → 去击穿测试）。
            只在非 pending 时出现 —— 动作还在跑就引导用户走开是错的。

            ⚠️ 样式纪律：这里**不能**在 className 里写 shorthand `border`
               的同时在 style 里写 longhand `borderColor`。
               React 在 rerender 时会因"简写与长写混用"发出
               「a style property during rerender」告警 —— 而验收里有一条
               「全程无控制台报错」的断言，会因此失败。
               所以边框统一走 longhand（borderWidth + borderStyle + borderColor）。 */}
        {!isPending && action && (
          <button
            type="button"
            data-action-link={action.testId ?? action.label}
            onClick={action.onClick}
            className="shrink-0 self-center rounded-md px-2.5 py-1 text-[11px] leading-none transition-colors hover:bg-[#f3f4f6]"
            style={{
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: `${color}55`,
              color,
            }}
          >
            {action.label}
          </button>
        )}

        {/* 进行中不给关闭按钮 —— 动作还在跑，关掉提示不等于停掉它，会造成误解 */}
        {!isPending && (
          <button
            type="button"
            onClick={onClear}
            aria-label="关闭提示"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] leading-none text-ink-faint transition-colors hover:bg-[#f3f4f6] hover:text-ink"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
}
