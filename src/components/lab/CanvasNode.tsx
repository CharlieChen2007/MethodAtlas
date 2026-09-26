'use client'

import { memo, useState } from 'react'
import type { LayoutNode } from '@/lib/lab/layout'
import { stageColor, stageSoft, STATUS_COLOR } from '@/lib/lab/palette'

/**
 * 画布节点 —— 结构树的一环。
 *
 * 版式（紧凑 / 加高两档）：
 *   紧凑（48px）  类型标签 + 名称
 *   加高（68px）  类型标签 + 名称 + 一行灰色摘要
 *   只有 Core Method 列会加高（见 layout.ts 的 nodeHeightFor），
 *   其余阶段保持紧凑 —— 加高权限只给视觉重心，避免整棵树纵向膨胀。
 *
 * 颜色语义（产品要求「颜色只用在色条、图标、边框」）：
 *   左侧 3px 色条 = 方法阶段色。这是节点上唯一的饱和色块，
 *   宽度 3px 不构成"大面积铺色"。用户扫一眼色条就能按阶段分组，
 *   比读 11px 的阶段名快得多。
 *
 * 视觉状态：
 *   默认      1px 边框 #e5e7eb
 *   选中      2px 边框 #2563eb
 *   被干预    2px 边框 #dc2626（红 = 被手术干预）
 *   不确定    虚线边框
 *   空阶段    虚线 + 灰字
 *
 * 注意：Chromium 不支持亚像素边框，`1.5px` 会被向下取整成 1px，
 * 和默认态完全没区别。所以选中/被干预一律用 2px。
 */

export interface CanvasNodeProps {
  node: LayoutNode
  selected: boolean
  /** 被手术干预（红框） */
  intervened?: boolean
  /** 证据不足 → 虚线边框 */
  uncertain?: boolean
  /**
   * ── 手术（剪刀）模式（问题 2）──
   *
   * 为 true 时该节点"可以被切"：加一圈红色虚线轮廓 + 轻微抬升，
   * 让用户一眼看出"哪些模块能点"。空格子/预览节点不参与，所以它们
   * 不会有这个轮廓 —— 视觉上直接告诉用户"这里不能切"。
   */
  surgeryMode?: boolean
  /** 有手术正在跑：disable 交互，避免连点触发两次 */
  surgeryPending?: boolean
  onClick?: (node: LayoutNode) => void
  onPointerDown?: (e: React.PointerEvent) => void
}

function CanvasNodeImpl({
  node,
  selected,
  intervened = false,
  uncertain = false,
  surgeryMode = false,
  surgeryPending = false,
  onClick,
  onPointerDown,
}: CanvasNodeProps) {
  const isRoot = node.kind === 'root'
  const isEmpty = node.kind === 'empty'
  const isPreview = Boolean(node.preview)
  // Core Method 是结构重心：加高、浅蓝底、深蓝边框
  const isCore = node.stage === 'CORE_METHOD'

  /**
   * ── UI ②：首屏摘要默认收起 ──
   *
   * 节点上原本**直接**渲染一行灰色摘要。问题在于：进画布时满屏都是
   * 两行文字，节点看起来像"小作文"，真正的信息（模块名）被摘要稀释，
   * 扫读效率反而下降。产品要求"首屏摘要默认收起"。
   *
   * 采用的方案：**节点上一个小图标原地展开**（而不是把摘要挪到底部面板）。
   *   理由：底部面板在点节点时**已经**会打开并显示完整详情 ——
   *   "点节点 → 看面板"这条路本来就通。如果摘要也走那条路，
   *   收起的收益是"少一行字"，但用户想看摘要必须先把面板顶开，
   *   上下文切换成本更高。小图标原地展开则是"就地偷看"：
   *   不离开画布、不改变选中态、也不影响其他节点。
   *
   * 图标只在**真的有摘要**时出现 —— 没摘要还显示一个点了没反应的图标，
   * 就是死按钮。
   */
  const [expanded, setExpanded] = useState(false)

  // 抽屉/展开态会临时顶开节点高度，但节点是绝对定位，撑高会压住邻居。
  // 所以展开时不改高度，而是**覆盖**出一个小浮层承载完整摘要。

  // ── 边框与底色 ──
  // 这里是**逐边**表达（borderTop/Right/Bottom/Left），不用 `border` 简写。
  // 原因：阶段色条只改左边，若同时写 `border`（简写，覆盖四边）
  // 和 `borderLeft`（长写），React 会在重渲染时警告
  // 「conflicting property … don't mix shorthand and non-shorthand」，
  // 且两者的生效顺序不稳定 —— 实测会把"被干预红框"吃掉。
  // 逐边表达后，四条边各有明确归属，没有任何覆盖关系。
  let bw = 1
  let bs: 'solid' | 'dashed' = 'solid'
  let bc = '#e5e7eb'
  let background = '#ffffff'

  if (isEmpty) {
    bs = 'dashed'
    background = '#fafafa'
  } else if (isPreview) {
    /**
     * 预览态：方法手术空态把真实结构图降对比度画出来，作为"刀往哪落"的靶标。
     *
     * 为什么是虚线灰而不是半透明：
     *   半透明会与底下的点阵网格叠色，看起来像渲染错误；
     *   虚线灰是"尚未生效"的通用视觉语言，且不依赖透明度，
     *   在不同屏幕上表现一致。
     */
    bs = 'dashed'
    bc = '#d1d5db'
    background = '#fcfcfd'
  } else if (intervened) {
    // 被手术干预 → 红框。宽度 2px，在灰色的树里足够跳出来。
    //
    // ⚠️ 这一支必须在 isCore 之前判断：
    //   最常被拿来做手术的恰恰是 Core Method 列（那是方法的命门），
    //   如果先判 isCore，红框就会被深蓝边框"吃掉" ——
    //   用户跑完手术回到 DNA 视图，画布上完全看不出哪块被动过。
    //   "被干预"是比"是重心"更具体、更该被看见的状态，优先级更高。
    bw = 2
    bc = '#dc2626'
    background = '#fef2f2'
  } else if (isCore) {
    // 重心节点：深蓝细边框 + #eff6ff 浅底。
    // 底色是极浅蓝（与白几乎同亮度），只做"这里更重要"的暗示，
    // 不是色块 —— 大面积铺色的禁令针对的是饱和填充。
    bc = '#1d4ed8'
    background = stageSoft('CORE_METHOD')
  } else if (uncertain) {
    bs = 'dashed'
    bc = '#d1d5db'
  }

  // 选中态优先级最高，压过上面所有
  if (selected) {
    bw = 2
    bs = 'solid'
    bc = '#2563eb'
    background = isCore ? stageSoft('CORE_METHOD') : '#ffffff'
  }

  // 左侧色条：阶段语义色。空节点、根节点、预览节点不显示
  //  —— 预览节点刻意去掉阶段色条，否则它会看起来像"真实的结构"。
  //
  // 被干预节点**仍保留**色条：色条表达"它是什么阶段的模块"，
  // 红框表达"它被手术动过" —— 两个语义正交，都不能丢。
  // 因此被干预节点 = 红色上/右/下三边（2px）+ 阶段色左条（3px）。
  const barColor = node.stage ? stageColor(node.stage) : undefined
  const showBar = !isEmpty && !isRoot && !isPreview && Boolean(barColor)

  const borderSides = showBar
    ? {
        borderTop: `${bw}px ${bs} ${bc}`,
        borderRight: `${bw}px ${bs} ${bc}`,
        borderBottom: `${bw}px ${bs} ${bc}`,
        borderLeft: `3px solid ${barColor}`,
      }
    : {
        borderTop: `${bw}px ${bs} ${bc}`,
        borderRight: `${bw}px ${bs} ${bc}`,
        borderBottom: `${bw}px ${bs} ${bc}`,
        borderLeft: `${bw}px ${bs} ${bc}`,
      }

  // 预览态文字压暗，与真实节点区分
  const titleColor = isEmpty || isPreview ? '#9ca3af' : '#1a1a1a'

  /**
   * 剪刀模式下"可切"的节点加一圈轮廓（outline）。
   *
   * 为什么用 outline 而不是再改 border：
   *   border 已经被四个状态（默认/选中/被干预/不确定）占满，
   *   再挤进去会和「被干预红框」抢视觉 —— 而"可以切"和"已经被切过"
   *   是两件事，必须能同时看到（一个模块可以被切过、也仍然可以再切）。
   *   outline 画在边框外侧、不参与布局，正好承载这个正交语义。
   *
   * ── 问题 4 修正：可切轮廓必须**弱于**已摘除红框 ──
   *   原来可切也用 `2px dashed #dc2626`，结果满屏红虚线，和"已摘除"的
   *   实线红框几乎分不清 —— 用户以为所有模块都被摘掉了。
   *   现在：可切 = 浅红虚线 1px（只是"这里能点"的暗示）；
   *        已摘除 = 2px 实线红边框 + 浅红底（强状态，唯一的重红）。
   *   已摘除的节点不再叠可切轮廓，避免两层红叠在一起。
   */
  const surgeryOutline =
    surgeryMode && !intervened
      ? { outline: '1px dashed #fca5a5', outlineOffset: 2 }
      : {}

  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onClick={() => onClick?.(node)}
      disabled={surgeryPending}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: node.w,
        height: node.h,
        ...borderSides,
        ...surgeryOutline,
        background,
        borderRadius: 8,
        // 选中时轻微放大 —— 用 transform 不触发邻居重排。
        // P20：幅度收到 1.02、时长 150ms（原 1.04 / 120ms），
        // 与 CardNode 统一，也符合"轻、克制"的口径。过渡由 globals.css
        // 的 [data-node] 规则统一提供，这里不再各自写 transition。
        transform: selected ? 'scale(1.02)' : 'scale(1)',
        // 几乎不用阴影：只给选中态一点点浮起感
        boxShadow: selected ? '0 1px 4px rgba(37, 99, 235, 0.12)' : 'none',
        // 剪刀模式下改用 crosshair，与画布容器一致 —— "点哪里就切哪里"
        cursor: surgeryMode ? 'crosshair' : 'pointer',
        textAlign: 'left',
        padding: showBar ? '7px 10px 7px 9px' : '7px 10px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 2,
        zIndex: selected ? 2 : 1,
        overflow: 'hidden',
      }}
      title={isEmpty ? undefined : node.title}
      // 测试钩子：verify-local.py 用它确认"被干预节点确实标红了"。
      // 只读属性，不影响渲染与交互。
      data-node={node.id}
      /* P9：把节点标题原样挂到属性上 —— 验收脚本据此断言
         Block 名字已规范化（不依赖 textContent，避免混进标签/徽标）。 */
      data-node-label={isEmpty ? undefined : node.title}
      data-surgery-target={surgeryMode ? '1' : '0'}
      data-block={node.block?.id}
      data-intervened={intervened ? '1' : '0'}
    >
      {/* 第一行：类型标签（小字灰色） */}
      {node.label && (
        <span
          style={{
            // P15 需求二：图表字体整体放大（11→14），布局常量已同步加宽加高
            fontSize: 14,
            lineHeight: '18px',
            // Core Method 的标签用阶段色，强化"这是重心"
            color: isEmpty || isPreview ? '#9ca3af' : isCore ? STATUS_COLOR.unknown : '#6b7280',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flexShrink: 0,
          }}
        >
          {node.label}
        </span>
      )}

      {/* 第二行：一行标题 */}
      <span
        style={{
          fontSize: 17,
          lineHeight: '22px',
          color: titleColor,
          fontWeight: isEmpty || isPreview ? 400 : isRoot || isCore ? 600 : 400,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexShrink: 0,
        }}
      >
        {node.title}
      </span>

      {/* ── UI ②：摘要默认收起 ──
          默认只显示一行（截断）+ 一个「展开」小图标。
          点图标 → 在节点下方浮出一层显示完整摘要（最多 4 行）。
          浮层是绝对定位的子元素，**不影响节点自身高度** ——
          否则展开一个节点会把下面所有节点顶开，整棵树重排、视线丢失。 */}
      {node.summary && !isPreview && (
        <span
          style={{
            fontSize: 14,
            lineHeight: '18px',
            color: '#9ca3af',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flexShrink: 0,
            // 收起时摘要占用空间极小：图标与摘要同一行
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            maxWidth: '100%',
          }}
        >
          {/*
            展开/收起图标 —— 必须是**独立按钮**而不是让整块摘要可点：
            节点本身已经是一个 <button>（点击=选中），HTML 不允许 button 嵌 button。
            用一个 span 加 role="button" + onClick + stopPropagation 实现，
            并阻止冒泡，否则点图标会连带触发"选中节点"。
          */}
          <span
            role="button"
            tabIndex={0}
            data-summary-toggle={expanded ? '1' : '0'}
            aria-label={expanded ? '收起摘要' : '展开摘要'}
            title={expanded ? '收起摘要' : '展开摘要'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
            onKeyDown={(e) => {
              // 键盘可达：Enter / Space 等同于点击（可访问性缺口补齐）
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                setExpanded((v) => !v)
              }
            }}
            style={{
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              borderRadius: 5,
              border: '1px solid #e5e7eb',
              background: '#fff',
              color: '#9ca3af',
              fontSize: 12,
              lineHeight: 1,
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            {expanded ? '▾' : '▸'}
          </span>
          {/* 收起态：摘要截断成一行 */}
          {!expanded && (
            <span
              data-summary-collapsed="1"
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {node.summary}
            </span>
          )}
        </span>
      )}

      {/* ── UI ②：展开态浮层 —— 完整摘要（最多 4 行，超出滚动）──
          为什么用绝对定位的浮层而不是撑高节点：
            节点在画布上是绝对定位的，撑高会与下方节点重叠/重排。
            浮层浮在上面（zIndex 高于节点本身），展开一个不动全局布局。 */}
      {node.summary && !isPreview && expanded && (
        <span
          data-summary-expanded="1"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            left: 6,
            right: 6,
            top: '100%',
            marginTop: 4,
            zIndex: 5,
            background: '#ffffff',
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            padding: '6px 8px',
            fontSize: 14,
            lineHeight: '19px',
            color: '#6b7280',
            textAlign: 'left',
            whiteSpace: 'normal',
            // 4 行以内完整显示；超出则内部滚动（节点摘要本来就不该是长文）
            maxHeight: 4 * 19 + 12,
            overflowY: 'auto',
          }}
        >
          {node.summary}
        </span>
      )}

      {/* ── 问题 4：剪刀模式下的「这一下会发生什么」角标 ──
          用户要求改成"点两次切换"，但如果不告诉他"这个已经拿掉了、再点能恢复"，
          他点完一个变红的模块会以为不可逆，不敢再点。
          所以：已摘除 → 「↩ 可恢复」；未摘除 → 不打扰（可切轮廓已经说明了）。

          位置改到**右上角外侧**：
            先前挂在右下角，被第三行摘要文字压住，糊成一团看不清。
            右上角是节点的"空白角落"（标题最多到右边框，没有内容占用），
            且贴在外沿，任何节点高度下都不会与正文重叠。 */}
      {surgeryMode && !isEmpty && !isPreview && intervened && (
        <span
          data-surgery-action="restore"
          style={{
            position: 'absolute',
            right: -1,
            top: -9,
            fontSize: 13,
            lineHeight: '17px',
            color: '#b91c1c',
            background: '#fff',
            border: '1px solid #fecaca',
            borderRadius: 4,
            padding: '0 4px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          ↩ 可恢复
        </span>
      )}
    </button>
  )
}

export const CanvasNode = memo(CanvasNodeImpl)
