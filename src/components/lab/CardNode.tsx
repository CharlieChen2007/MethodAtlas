'use client'

import { memo, useState } from 'react'
import type { CardSpec, LayoutNode } from '@/lib/lab/layout'
import { CARD_TONE_COLOR, statusColor } from '@/lib/lab/palette'

/**
 * 卡片节点 —— 列表型视图（手术/演化/债务/想法/击穿）的画布原语。
 *
 * 与 CanvasNode 的区别：卡片要承载"标题 + 摘要 + 脚注"，信息量更大，
 * 但依然遵守同一条纪律 —— 不放大段正文、不放按钮堆。
 *
 * 色调只用**左边框 3px**表达，不铺底色：
 * 产品要求"颜色只用在色条、图标、边框"，而列表型视图需要一眼分辨
 * "有问题/没问题"，左边框是同时满足两条约束的最小改动。
 *
 * 色值统一从 palette 取 —— 不在这里再定义一份，否则会出现
 * "卡片上的红"与"徽标上的红"不是同一个红。
 *
 * ── P7-3：每个视图的"特征块"──
 * 卡片高度固定 180px，内部版式按视图不同：
 *   债务   → 标签 / 标题 / 「为什么是债务」/ 论文列表 / 脚注
 *   想法   → 标签 / 标题 / `A + B × Debt = Idea` 小图 / 摘要 / 脚注
 *   击穿   → 标签 / 标题 / 摘要 / 6 项检查图标行 / 脚注
 *   演化   → 标签 / 标题 / 摘要 / 脚注（时间线感由画布层的虚线连接表达）
 *   手术   → 标签 / 标题 / 摘要 / 脚注
 * 特征块来自 CardSpec 上的可选字段，**有数据与空态共用同一套渲染**，
 * 所以不会出现"空态时好看、有数据时退回朴素卡片"的落差。
 */

export interface CardNodeProps {
  node: LayoutNode
  selected: boolean
  onClick?: (node: LayoutNode) => void
  onPointerDown?: (e: React.PointerEvent) => void
}

function CardNodeImpl({ node, selected, onClick, onPointerDown }: CardNodeProps) {
  const card = node.card
  /**
   * ── UI ②：卡片摘要默认收起 ──
   *
   * 与 CanvasNode 同一套交互语言（小图标原地展开），保证画布上
   * 两种节点行为一致 —— 用户学会一次即可通用。
   *
   * 卡片的"摘要"就是 excerpt。收起时只留 1 行，点图标就地展开到完整高度。
   * 卡片是固定高 180px 的绝对定位元素，展开不能改卡片高度（会压住邻居），
   * 所以在卡片内部把 excerpt 区域从 1 行变多行，并让其可内部滚动。
   */
  const [expanded, setExpanded] = useState(false)

  if (!card) return null

  const toneColor = CARD_TONE_COLOR[card.tone] ?? CARD_TONE_COLOR.default

  // 特征块的存在会挤压摘要行的高度，这里按"有没有特征块"分配行高
  const hasFormula = Boolean(card.formula)
  const hasChecks = Boolean(card.checks?.length)
  const hasDebtRows = Boolean(card.why || card.papers?.length)

  // 摘要区高度（3 行 = 54px；被特征块挤压时收到 2 行 = 36px）
  const fullExcerptH = hasChecks ? 36 : hasFormula && !hasDebtRows ? 36 : hasDebtRows ? 36 : 54
  /**
   * UI ②：收起态固定 1 行（18px）；展开态回到原本的完整高度。
   * 用 flex-1 + minHeight 0 让展开时吃掉卡片剩余空间，而不是溢出卡片。
   */
  const excerptH = expanded ? fullExcerptH : 18
  const canExpand = Boolean(card.excerpt) && card.excerpt.length > 0

  return (
    <button
      type="button"
      data-node={node.id}
      data-card={card.refId ?? node.id}
      /* P9：把卡片标题原样挂到属性上 —— 验收脚本要断言画布上的
         Block 名字是否规范化。从 textContent 取会混进标签/徽标/摘要，
         读不到干净的名字。 */
      data-node-label={card.title}
      onPointerDown={onPointerDown}
      onClick={() => onClick?.(node)}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: node.w,
        height: node.h,
        border: selected ? '2px solid #2563eb' : '1px solid #e5e7eb',
        borderLeft: `3px solid ${selected ? '#2563eb' : toneColor}`,
        background: '#ffffff',
        borderRadius: 12,
        boxShadow: selected ? '0 1px 4px rgba(37, 99, 235, 0.12)' : 'none',
        cursor: 'pointer',
        textAlign: 'left',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        /**
         * ── P20：选中时轻微放大（150ms）──
         *
         * 与 CanvasNode 同一套反馈语言：点中的节点"抬起来一点"，
         * 让用户确认"我点的是它"。幅度 1.02（不是 1.1）——
         * 卡片是绝对定位的，放大过头会压住邻居。
         * 过渡由 globals.css 的 [data-node] 规则统一提供。
         */
        transform: selected ? 'scale(1.02)' : 'scale(1)',
        zIndex: selected ? 2 : 1,
        overflow: 'hidden',
      }}
      title={card.title}
    >
      {/* ── 统一语义徽标（问题 5/7）──
          产品要求「需要标注时用统一 UI 元素，不要混进句子」。
          这里固定在右上角，是卡片上唯一允许出现的"标注型"元素：
            · 信息密度不变（原来那句话 20+ 字，现在 3 个字）
            · 视觉噪音最低（小胶囊，不铺色、不抢标题）
          文案与色调都由 CardSpec.badge 决定，渲染只有这一处。 */}
      {card.badge && (
        <span
          data-card-badge={card.badge.text}
          style={{
            position: 'absolute',
            right: 10,
            top: 10,
            fontSize: 10,
            lineHeight: '14px',
            padding: '0 5px',
            borderRadius: 999,
            border: `1px solid ${CARD_TONE_COLOR[card.badge.tone] ?? CARD_TONE_COLOR.warn}55`,
            background: `${CARD_TONE_COLOR[card.badge.tone] ?? CARD_TONE_COLOR.warn}12`,
            color: CARD_TONE_COLOR[card.badge.tone] ?? CARD_TONE_COLOR.warn,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {card.badge.text}
        </span>
      )}

      {/* 第一行：小标签 */}
      <span
        style={{
          fontSize: 11,
          lineHeight: '14px',
          color: '#6b7280',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexShrink: 0,
        }}
      >
        {card.label}
      </span>

      {/* 第二行：标题（最多两行，有特征块时收到一行） */}
      <span
        style={{
          marginTop: 6,
          fontSize: 14,
          lineHeight: '20px',
          fontWeight: 600,
          color: '#1a1a1a',
          // 标题行数：有特征块时只留 1 行（给特征块腾空间），否则 2 行
          height: hasChecks || hasFormula ? 20 : 40,
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {card.title}
      </span>

      {/* ── 特征块一：研究债务的第二行「为什么是债务」+ 第三行论文列表 ── */}
      {hasDebtRows && (
        <div style={{ marginTop: 6, flexShrink: 0 }}>
          {card.why && (
            <span
              style={{
                fontSize: 11,
                lineHeight: '15px',
                color: '#6b7280',
                height: 15,
                overflow: 'hidden',
              }}
            >
              {card.why}
            </span>
          )}
          {card.papers && card.papers.length > 0 && (
            <span
              style={{
                display: 'block',
                marginTop: 4,
                fontSize: 10,
                lineHeight: '14px',
                color: '#9ca3af',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              论文：{card.papers.map((t) => shorten(t, 18)).join(' · ')}
            </span>
          )}
        </div>
      )}

      {/* ── 特征块二：组合想法的 `A + B × Debt = Idea` 小图 ── */}
      {hasFormula && card.formula && (
        <FormulaStrip formula={card.formula} />
      )}

      {/* ── UI ②：摘要默认收起（1 行）+ 展开图标 ──
          收起时高度 18px（1 行），点图标展开回完整高度。
          图标同样用 span+role=button —— card 本身是 <button>，不能嵌套。
          阻止冒泡，否则点图标会连带打开底部面板。 */}
      <span
        style={{
          marginTop: 6,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 4,
          flexShrink: expanded ? 1 : 0,
          minHeight: 0,
        }}
      >
        {canExpand && (
          <span
            role="button"
            tabIndex={0}
            data-card-summary-toggle={expanded ? '1' : '0'}
            aria-label={expanded ? '收起摘要' : '展开摘要'}
            title={expanded ? '收起摘要' : '展开摘要'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                setExpanded((v) => !v)
              }
            }}
            style={{
              flexShrink: 0,
              marginTop: 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 14,
              height: 14,
              borderRadius: 4,
              border: '1px solid #e5e7eb',
              background: '#fff',
              color: '#9ca3af',
              fontSize: 9,
              lineHeight: 1,
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            {expanded ? '▾' : '▸'}
          </span>
        )}
        <span
          data-card-summary-collapsed={expanded ? '0' : '1'}
          style={{
            fontSize: 12,
            lineHeight: '18px',
            color: '#6b7280',
            // 固定高度 + overflow hidden 做截断。
            // 刻意不用 -webkit-box + line-clamp：React 会对
            // display:'-webkit-box' 与 WebkitBoxOrient 同帧设置发出
            // "conflicting style property" 警告（验证脚本判为 JS 错误）。
            height: excerptH,
            overflowY: expanded ? 'auto' : 'hidden',
            overflowX: 'hidden',
            flex: expanded ? '1 1 auto' : '0 0 auto',
            minWidth: 0,
          }}
        >
          {card.excerpt}
        </span>
      </span>

      {/* ── 特征块三：击穿测试的 6 项检查图标状态行 ── */}
      {hasChecks && card.checks && <CheckStrip checks={card.checks} />}

      {/* 最后一行：脚注（固定在卡片底部） */}
      <span
        style={{
          marginTop: 'auto',
          fontSize: 11,
          lineHeight: '14px',
          color: '#9ca3af',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexShrink: 0,
        }}
      >
        {card.footnote ?? ''}
      </span>
    </button>
  )
}

/**
 * `A + B × Debt = Idea` 小图。
 *
 * 版式：三个小方框用运算符连接，第四个方框是结果（加粗）。
 * 用方框而不是纯文字，是为了让"这是一个组合式"一眼可见 ——
 * 纯文字 `A + B × Debt = Idea` 需要读，方框需要看。
 *
 * 缺任一操作数就画成灰色虚框的 `—`，不编造名字。
 */
function FormulaStrip({ formula }: { formula: CardSpec['formula'] }) {
  if (!formula) return null
  return (
    <div
      style={{
        marginTop: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10,
        lineHeight: '14px',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      <Operand text={formula.a} tone="a" />
      <Operator>+</Operator>
      <Operand text={formula.b} tone="b" />
      <Operator>×</Operator>
      <Operand text={formula.debt} tone="debt" />
      <Operator>=</Operator>
      <Operand text={formula.idea} tone="result" />
    </div>
  )
}

const OPERAND_COLOR: Record<string, { border: string; bg: string; fg: string }> = {
  a: { border: '#bfdbfe', bg: '#eff6ff', fg: '#1d4ed8' },
  b: { border: '#bfdbfe', bg: '#eff6ff', fg: '#1d4ed8' },
  debt: { border: '#fecaca', bg: '#fef2f2', fg: '#b91c1c' },
  result: { border: '#bbf7d0', bg: '#f0fdf4', fg: '#15803d' },
}

function Operand({ text, tone }: { text?: string; tone: string }) {
  const c = OPERAND_COLOR[tone] ?? OPERAND_COLOR.a
  const missing = !text
  return (
    <span
      style={{
        display: 'inline-block',
        maxWidth: 74,
        padding: '1px 5px',
        borderRadius: 4,
        border: `1px solid ${missing ? '#e5e7eb' : c.border}`,
        background: missing ? '#fafafa' : c.bg,
        color: missing ? '#9ca3af' : c.fg,
        fontWeight: tone === 'result' ? 600 : 400,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flexShrink: 0,
      }}
      title={text}
    >
      {text ? shorten(text, 10) : '—'}
    </span>
  )
}

function Operator({ children }: { children: string }) {
  return (
    <span style={{ color: '#9ca3af', flexShrink: 0 }} aria-hidden>
      {children}
    </span>
  )
}

/**
 * 6 项检查图标状态行。
 *
 * 每格 = 一个图标 + 一个 2~4 字标签。
 * 图标语义：✓ 通过 / ⚠ 有疑虑或未覆盖 / ✗ 致命
 * 颜色从 palette 的状态色取（这是状态色域，不是视图色、也不是阶段色）。
 *
 * 为什么用"图标 + 标签"而不是只画 6 个图标：
 *   6 个图标挤在一起，用户得逐个 hover 才知道每格是什么。
 *   加 2~4 字标签后，一行就能扫完 6 项 —— 这正是状态行存在的意义。
 */
function CheckStrip({
  checks,
}: {
  checks: { key: string; label: string; level: string; icon: string }[]
}) {
  return (
    <div
      style={{
        marginTop: 6,
        display: 'flex',
        flexWrap: 'nowrap',
        gap: 6,
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      {checks.slice(0, 6).map((c) => {
        /**
         * ── 问题 8：UNKNOWN 是独立一档（"没查"），不是"有疑虑" ──
         * PASS=绿 / CONCERN=黄 / UNKNOWN=灰 / BLOCKER=红
         * 灰色是"无信息"的通用语义，正好对应"这一项没有数据"。
         */
        const tone =
          c.level === 'PASS'
            ? 'good'
            : c.level === 'BLOCKER'
              ? 'bad'
              : c.level === 'UNKNOWN'
                ? 'unknown'
                : 'warn'
        const color = statusColor(tone)
        return (
          <span
            key={c.key}
            title={`${c.label}：${LEVEL_TEXT[c.level] ?? c.level}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              padding: '1px 4px',
              borderRadius: 4,
              border: `1px solid ${color}33`,
              background: `${color}0f`,
              color,
              fontSize: 10,
              lineHeight: '14px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <span aria-hidden>{c.icon}</span>
            <span>{c.label}</span>
          </span>
        )
      })}
    </div>
  )
}

const LEVEL_TEXT: Record<string, string> = {
  PASS: '通过',
  CONCERN: '有疑虑',
  BLOCKER: '致命弱点',
  UNKNOWN: '未覆盖',
}

function shorten(t: string, n: number): string {
  return t.length > n ? `${t.slice(0, n)}…` : t
}

export const CardNode = memo(CardNodeImpl)
