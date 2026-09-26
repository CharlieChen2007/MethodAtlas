'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { type LayoutNode, MIN_SCALE, ABS_MIN_SCALE } from '@/lib/lab/layout'
import { VIEW_PATTERN, ZOOM_BORDER } from '@/lib/lab/palette'
import { CanvasNode } from './CanvasNode'
import { CardNode } from './CardNode'
import { CanvasEdges } from './CanvasEdges'
import { EmptyCanvas } from './EmptyCanvas'

/**
 * 画布容器 —— 负责「永不滚动 + 拖拽平移 + 缩放适配 + 点击/拖拽区分」。
 *
 * 核心机制：
 *   1. 容器 overflow:hidden（不是 auto）→ 页面上永远不出现滚动条
 *   2. 内容用 transform: translate(x,y) scale(s) 定位
 *   3. 位移超过 DRAG_THRESHOLD 才算拖拽，否则算点击空白处
 *
 * 缩放策略：scale = clamp(可用宽/内容宽, MIN_SCALE, 1)。
 * 内容比视口宽时，超出部分靠拖拽平移消化，而不是缩小到不可读。
 */

/** 判定为"拖拽"而非"点击"的位移阈值（px） */
const DRAG_THRESHOLD = 4

/**
 * 纵向安全边距（px）。缩放适配高度时上下各留这么多，
 * 避免节点紧贴画布上下边缘、也让"看起来是居中的"更自然。
 */
const V_PAD = 12

export interface CanvasStageProps {
  nodes: LayoutNode[]
  edges: { from: string; to: string }[]
  contentW: number
  contentH: number
  /** 节点真实纵向范围（不含画布留白），用于视口居中 */
  bounds: { minY: number; maxY: number }
  /**
   * ── UI ③：横向时间轴刻度（演化视图用）──
   *
   * 由 view-layout 的 evolutionLayout 算出（年份 + 横坐标 + 锚定卡片）。
   * CanvasStage 只负责把这条轴画出来 —— 它是**纯展示**，
   * 不可点、不进面板、不参与选中。
   */
  timeline?: { year: string; x: number; anchorId: string }[]
  /**
   * ── UI ③：列表型内容（研究债务）──
   *
   * 与 nodes/timeline 并列的第三种内容通道。非空时渲染为可扫读的
   * 行列表（左色条 + 名称），**不**渲染 nodes。
   */
  list?: {
    id: string
    title: string
    barColor: string
    meta?: string
    refId?: string
  }[]
  selectedId: string | null
  /**
   * P15 需求六：当前视图 id —— 画布底图图案按视图选取（palette.VIEW_PATTERN）。
   * 纯视觉 prop，缺省回退 dna 的灰点阵（与 P15 之前的唯一底图行为一致）。
   */
  viewId?: string
  intervenedIds?: Set<string>
  uncertainIds?: Set<string>
  onNodeClick: (node: LayoutNode) => void
  /** 点击画布空白处（用于关闭详情面板） */
  onBackgroundClick?: () => void
  /** 空态：中央一句话 + 主按钮（有值时 nodes 必为空） */
  emptyTitle?: string
  emptyHint?: string
  /** 空态主按钮文案与回调 */
  emptyAction?: string
  onEmptyAction?: () => void
  /**
   * 底部详情面板是否已滑出（用于空态提示块上移避让，P7-5 缺陷 1）。
   */
  panelOpen?: boolean
  /** 有数据但很少时的角落提示（如「当前仅识别到 1 条跨论文债务…」） */
  cornerNote?: string
  /**
   * 画布顶部的上下文横条（P7-4 工作流串联）。
   *
   * 承载"跨步骤传来的动态上下文"，例如：
   *   手术 → 演化：本次手术干预了 N 个 Block
   *   想法 → 击穿：本次击穿测试针对想法「X」
   *
   * 与 cornerNote 是**两个槽位**：cornerNote 是数据层面的静态建议，
   * 这个是流程层面的动态继承，语义不同，不能合并。
   */
  contextStrip?: { text: string } | null
  /**
   * ── 手术（剪刀）模式（问题 2）──
   *
   * 产品把手术从"右栏的一个步骤"改成了"画布上的一个动作"：
   * 点右上角剪刀进入模式 → 光标变剪刀、可动刀的 Block 高亮 →
   * 点某个 Block 就地对它动刀。所以这里需要知道：
   *   surgeryMode    当前是否在剪刀模式（决定光标 + 是否渲染剪刀按钮）
   * onToggleSurgery  点剪刀按钮
   * onSurgeryPick    在剪刀模式下点中了某个 Block（node 为该节点）
   */
  surgeryMode?: boolean
  onToggleSurgery?: () => void
  onSurgeryPick?: (node: LayoutNode) => void
  /** 是否显示剪刀按钮（没有可用 Block 时不显示，避免点了没反应） */
  surgeryAvailable?: boolean
  surgeryPending?: boolean
  /**
   * ── 上传论文（问题 1）──
   *
   * 上传按钮从右栏搬到了画布**左上角**（固定图标按钮）。
   * CanvasStage 本身不碰文件与网络 —— 它只负责"被点了"这件事，
   * 真正的 file input 与 /api/upload 调用留在 LabShell。
   *
   * 为什么不让画布自己去触发 `document.querySelector('input[type=file]')`：
   *   那是隐式全局查找，页面上一旦多一个 file input 就点错。
   *   这里显式回调，数据流是单向的（画布 → LabShell → input.click）。
   *
   *   onRequestUpload  点按钮（LabShell 收到后转发给隐藏 input）
   *   uploadPending    是否正在解析（决定按钮是否禁用 + 显示 …）
   *   uploadNote       正在解析的文件名（按钮下方回显）
   *   传 undefined 表示不显示该按钮（例如已无上传能力时）
   */
  onRequestUpload?: () => void
  uploadPending?: boolean
  uploadNote?: string | null
  /**
   * 降级原因 —— 非 null 时在画布右上角显示「离线模式」徽标。
   *
   * ── 为什么需要它 ──
   *
   * 真模型调用失败时会自动降级到 mock（保证页面不崩），但**降级必须可见**：
   * 演示场景下如果 API 失效而界面毫无表示，演示者会把启发式输出当成
   * 真模型结果讲 —— 那正是这个项目最反对的事（把 mock 当模型产出）。
   *
   * 用"原因字符串"而不是布尔值：一来非空即显示、天然是个开关；
   * 二来鼠标悬停能直接看到为什么降级，排查不用翻日志。
   * 调用正常时由上层传 null，徽标完全不渲染。
   */
  degradedReason?: string | null
}

export function CanvasStage({
  nodes,
  edges,
  contentW,
  contentH,
  bounds,
  timeline,
  list,
  selectedId,
  viewId = 'dna',
  intervenedIds,
  uncertainIds,
  onNodeClick,
  onBackgroundClick,
  emptyTitle,
  emptyHint,
  emptyAction,
  onEmptyAction,
  panelOpen = false,
  cornerNote,
  contextStrip,
  surgeryMode = false,
  onToggleSurgery,
  onSurgeryPick,
  surgeryAvailable = false,
  surgeryPending = false,
  onRequestUpload,
  uploadPending = false,
  uploadNote = null,
  degradedReason = null,
}: CanvasStageProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  // P15 需求六：底图图案按视图选取（未知 id 回退 dna 灰点阵）
  const pattern = VIEW_PATTERN[viewId] ?? VIEW_PATTERN.dna
  const [view, setView] = useState({ w: 0, h: 0 })
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  /**
   * 是否正在拖拽 —— 只用来切光标（grab ↔ grabbing）。
   *
   * 为什么这个用 state 而不用 ref：光标是**渲染输出**，必须触发重渲染；
   * 而 offset 是高频更新所以走 ref + setOffset。两者目的不同。
   * 这个 state 每个拖拽周期只变 2 次（按下→拖拽、松手），开销可忽略。
   */
  const [dragging, setDragging] = useState(false)

  /**
   * 是否已完成首次客户端测量。
   *
   * SSR 时拿不到容器尺寸（view.w = 0），此时不该渲染内容层 —— 否则服务端
   * HTML 是「空容器」而客户端首帧是「带 svg 的容器」，React 会报 hydration
   * 不匹配（"Did not expect server HTML to contain a <svg> in <div>"）。
   * 用 mounted 把内容层的渲染推迟到测量完成之后，两端就一致了。
   */
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // 拖拽中间态放 ref，避免高频 setState 造成逐帧重渲染
  const dragRef = useRef<{
    active: boolean
    moved: boolean
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)

  // ── 观测容器尺寸，用于算缩放与居中 ──
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setView({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setView({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  /**
   * ── 缩放：同时按**宽和高**适配 ──
   *
   * 为什么必须带上高度（P10 问题 1）：
   *   原来只按宽度算（view.w / contentW）。宽度够宽时 scale 就是 1，
   *   此时**纵向完全不受约束** —— 只要可视区变矮（比如面板展开把画布
   *   从 645px 压到 355px），节点包围盒（358px）立刻超出，顶部节点被
   *   顶出视口。用户看到的就是"面板一开，Block 消失"。
   *
   * 两个下限的分工（重要）：
   *   · 横向：保持 MIN_SCALE(0.8) —— 逼用户拖拽是横向的既定取舍
   *   · 纵向：允许降到 ABS_MIN_SCALE(0.6) —— 用户明确要求
   *     "所有 Block 都必须在可视区内"，完整性优先于字号
   *
   * 纵向留白 V_PAD：包围盒上下各留 12px，避免节点贴住画布上下边。
   */
  const scale = (() => {
    if (!view.w || !view.h || !contentW || !contentH) return 1
    const boxH = bounds.maxY - bounds.minY
    // 横向适配：下限 MIN_SCALE
    const scaleW = Math.max(MIN_SCALE, view.w / contentW)
    // 纵向适配：下限 ABS_MIN_SCALE（更宽松，保证内容放得下）
    const scaleH = Math.max(ABS_MIN_SCALE, (view.h - V_PAD * 2) / boxH)
    return Math.min(1, scaleW, scaleH)
  })()

  /**
   * ── UI ④：用户可控缩放 ──
   *
   * 上面那个 `scale` 是"自动适配"的结果。它解决"内容放得下"，
   * 但用户还有别的诉求：
   *   · 节点太挤看不清 → 想放大（哪怕要拖拽）
   *   · 想看全貌 → 想缩小
   *   · 拖乱了/缩歪了 → 想一键回到"刚进来的样子"
   *
   * 于是引入 `zoom` 倍率（乘在自动 scale 之上）：
   *   最终缩放 = autoScale × zoom
   *
   * 为什么用"倍率"而不是直接存一个绝对 scale：
   *   绝对 scale 会在容器尺寸变化（面板开合、窗口缩放）后失效 ——
   *   用户调到 1.3，窗口一变，1.3 可能就太大或太小了。
   *   倍率是**相对意图**："我比默认大 30%"，容器怎么变都成立。
   *
   * 取值纪律：
   *   · 区间 [0.5, 2.5] —— 再小节点名称不可读，再大只是徒增拖拽量
   *   · 「适应/重置」= 1（回到自动适配），不是"恢复上次" ——
   *     用户按这个键的意图永远是"回到正常"，不是"撤销我的最后一次点击"
   */
  const [zoom, setZoom] = useState(1)

  const finalScale = scale * zoom

  const ZOOM_MIN = 0.5
  const ZOOM_MAX = 2.5
  const ZOOM_STEP = 0.2
  const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z.toFixed(2))))

  const zoomIn = () => setZoom((z) => clampZoom(z + ZOOM_STEP))
  const zoomOut = () => setZoom((z) => clampZoom(z - ZOOM_STEP))
  /** 适应视图 / 重置：两者都回到自动适配倍率 1，只是语义命名不同 */
  const zoomReset = () => {
    setZoom(1)
    // 顺便把平移也摆正 —— "重置"应当把视角完全还原，不只还原缩放
    setOffset(clampOffset(0, 0, { resetY: true }))
  }

  const scaledW = contentW * finalScale

  /**
   * 平移边界。
   *
   * 纵向按「节点真实包围盒」算居中，而不是按画布盒子 —— 因为盒子上下有留白，
   * 按盒子居中会让整棵树视觉偏上。
   */
  const clampOffset = useCallback(
    (x: number, y: number, opts?: { resetY?: boolean }) => {
      /**
       * 横向定位。
       *
       * 内容比容器**窄**时 → 居中（留白均分两侧）。
       *
       * 内容比容器**宽**时 → 把溢出全部让给右侧（x 的可行区间是
       * [-(overflow), 0]，初始取 0 即"左边缘对齐画布左边缘"）。
       *
       * 为什么不做左右对称裁切（-overflow/2）：
       *   这是一张"根在左、向右延伸"的结构图。左右各裁一半的结果是
       *   根节点（阅读起点，论文标题）被切掉一截 —— 用户看到的第一眼
       *   是"标题残缺"，会以为布局坏了。而右侧被裁掉时，用户的直觉是
       *   "往右拖还有内容"，这是符合预期的。所以溢出只给右侧。
       */
      const overflowX = scaledW - view.w
      const nx =
        overflowX <= 0
          ? -overflowX / 2
          : Math.min(0, Math.max(-overflowX, x))

      // 纵向：把节点包围盒（已缩放）的中线对齐视口中线。
      //
      // offset.y 作用在整个内容层上，节点在屏幕上的实际范围是
      // [boxTop + y, boxBottom + y]。
      //
      // 只有当节点包围盒比视口**高**时才需要夹取（否则拖出去就看不见了）；
      // 比视口矮时直接居中，不夹 —— 否则会被"图层顶边贴 0"这种与节点无关的
      // 约束带偏，让整棵树视觉偏上。
      const boxTop = bounds.minY * finalScale
      const boxBottom = bounds.maxY * finalScale
      const boxCenter = (boxTop + boxBottom) / 2
      const desired = view.h / 2 - boxCenter
      const boxH = boxBottom - boxTop

      /**
       * ── U2 二次修复：视口变矮时必须重新居中，不能沿用旧 y ──
       *
       * 踩过的坑（P10 问题 1）：
       *   原来这个函数**只有一条纵向逻辑**，且总把当前的 y 带进去
       *   （`desired + y`）。于是当面板展开、画布可视高从 645 掉到 355 时，
       *   旧 y 被原样保留，内容只是被"夹"进更小的盒子，**整体并不重新居中**，
       *   顶部节点直接被推到视口上方（实测 RAG 这篇 top = -69）。
       *
       *   更隐蔽的是：这个 bug 只在 `boxH >= view.h` 时才暴露。
       *   RAG 这篇 boxH=358，面板关时 view.h=645（走居中分支，正常），
       *   面板一开 view.h=355 恰好跌破 358 → 切到夹取分支 → 立刻翻车。
       *   所以用 950 高的视口怎么测都是好的，必须用矮视口才能复现。
       *
       * 现在的语义：
       *   resetY=true  → 丢弃旧 y，**强制重新居中**（容器尺寸变化时走这条）
       *   resetY=false → 保留旧 y 并夹取（只用于用户主动拖拽）
       */
      let ny: number
      if (boxH >= view.h) {
        // 包围盒高于视口：允许上下拖动，但边界必须贴住视口
        const lowerBound = view.h - boxBottom // 包围盒底贴视口底 → y 的最小值
        const upperBound = -boxTop // 包围盒顶贴视口顶 → y 的最大值
        if (opts?.resetY) {
          /**
           * 视口变小后**不能**再居中（居中会让上下两半都超出），
           * 但也不能沿用旧 y。正确做法是"让包围盒顶贴视口顶"，
           * 保证用户第一眼看到的是内容的最上面（阅读起点）。
           */
          ny = Math.min(upperBound, Math.max(lowerBound, desired))
        } else {
          ny = Math.min(upperBound, Math.max(lowerBound, desired + y))
        }
      } else {
        // 矮于视口：始终居中，不响应纵向拖拽
        ny = desired
      }
      return { x: nx, y: ny }
    },
    [scaledW, view.w, view.h, finalScale, bounds.minY, bounds.maxY]
  )

  /**
   * 尺寸/缩放变化后重新夹取 —— 关键是**丢弃旧 y 重新居中**。
   *
   * 为什么不能沿用旧 y：面板展开/收起、浏览器窗口缩放都会改变 view.h，
   * 此时内容高度没变，唯一正确的响应就是"按新的可视区重新摆正"。
   * 沿用旧 y 会让内容整体偏离中心（见 clampOffset 里的 U2 二次修复注释）。
   */
  useEffect(() => {
    setOffset((o) => clampOffset(o.x, o.y, { resetY: true }))
  }, [clampOffset])

  // 首次布局完成时，把视图初始化到「根节点在左 + 内容垂直居中」。
  //
  // 横向初始值取 0，即"内容层左边缘对齐画布左边缘"。
  // 内容比容器窄时 clampOffset 会自动居中；比容器宽时停在 0，
  // 保证根节点（论文标题）完整可见，溢出全部落在右侧。
  const didInitRef = useRef(false)
  useEffect(() => {
    if (didInitRef.current) return
    if (!view.w || !view.h || !contentW) return
    didInitRef.current = true
    // 初始定位：x 交给 clampOffset 决定（窄则居中、宽则左贴），y 一律重新居中
    setOffset(clampOffset(0, 0, { resetY: true }))
  }, [view.w, view.h, contentW, clampOffset])

  /**
   * ── 拖拽处理：为什么 capture 要延后到"确认是拖拽"之后 ──
   *
   * 这里踩过一个真实的坑（P7-5 修）：
   *   原来在 pointerdown 就 `setPointerCapture()`。指针捕获会把**后续所有
   *   指针事件**（含 pointerup）重定向到画布容器，于是画布内部的按钮
   *   （空态主按钮「运行演化分析」等）永远接不到配对的 pointerup，
   *   浏览器就不会派发 click —— 按钮看起来"完全没反应"，但它其实
   *   既没被遮挡、也不是没接线。
   *
   *   现在改成两段式：
   *     pointerdown  → 只记录起点，**不 capture**（click 能正常走完）
   *     pointermove  → 位移超过阈值、确认是拖拽了，**这时才 capture**
   *     pointerup    → 没超过阈值 = 点空白（交给 onBackgroundClick）；
   *                    超过阈值 = 平移结束
   *
   *   这样"点按钮"和"拖画布"互不干扰：点按钮时位移为 0，从不 capture，
   *   click 正常触发；拖画布时一旦超过阈值就 capture，光标移出画布
   *   也不会丢事件。
   */
  const onPointerDown = (e: React.PointerEvent) => {
    // 只处理主键 / 触摸
    if (e.button !== 0) return
    dragRef.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      originX: offset.x,
      originY: offset.y,
    }
    // ⚠️ 此处刻意**不** setPointerCapture —— 见上方注释。
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d?.active) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      d.moved = true
      // 确认是拖拽了，这才接管指针 —— 拖拽过程中鼠标移出画布也不丢事件
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
      setDragging(true)
    }
    if (d.moved) {
      // 拖拽时**保留**用户的 y 偏移（resetY: false）—— 这是用户主动表达的位置意图
      setOffset(clampOffset(d.originX + dx, d.originY + dy, { resetY: false }))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    setDragging(false)
    if (d?.active && d.moved) {
      // 拖拽结束：释放指针捕获
      ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      return
    }
    if (d?.active && !d.moved) {
      // 位移未超阈值 → 视为点击空白处
      onBackgroundClick?.()
    }
  }

  return (
    <div
      ref={hostRef}
      data-canvas-stage
      className="relative h-full w-full overflow-hidden"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        /**
         * 光标 —— 三种状态，语义各不相同：
         *   剪刀模式   → crosshair（"点哪里就切哪里"）
         *   拖拽中     → grabbing（闭合的抓手）
         *   空闲       → grab（张开的抓手，"这里可以拖"）
         * 剪刀优先于拖拽：在剪刀模式下即使按住拖，用户注意力也在"切哪块"上。
         */
        cursor: surgeryMode ? 'crosshair' : dragging ? 'grabbing' : 'grab',
        /**
         * ── 禁止在画布上选中文字（P7-5 修）──
         *
         * 不禁止的话，拖动平移时浏览器会把它当成"划选文本"，
         * 屏幕上铺满蓝色选中高亮，既难看又让拖拽断续。
         *
         * 为什么整个画布都禁（而不是只禁背景）：
         *   画布上没有任何"需要选中"的东西 —— 节点是按钮（点它=选中节点，
         *   不是选文字），连线是 svg。真要复制文字，去底部详情面板里复制，
         *   那里的正文是可选的（面板不在这个容器里）。
         *
         * userSelect + WebkitUserSelect 都写：Safari 仍需要带前缀的那个。
         */
        userSelect: 'none',
        WebkitUserSelect: 'none',
        // 拖拽时也别弹出"长按选词/打开链接"这类触摸侧的默认行为
        touchAction: 'none',
        /**
         * 底图：极浅点状网格。
         *
         * 两层 radial-gradient 叠出点阵：
         *   第一层画 1px 的浅灰点（#e5e7eb），半径 1px
         *   第二层只是底色（#f9fafb），提供一点"纸感"
         *
         * backgroundPosition 绑定 offset：拖动画布时网格跟着走。
         * 这一个细节是"有底图感"和"贴了张壁纸"的分界 —— 网格随内容
         * 一起平移，用户才会感到节点是浮在一张更大的图纸上，
         * 而不是画布背景被固定住了。
         *
         * 为什么用点阵不用渐变：渐变会在视觉上形成大面积色带，
         * 违反"禁止渐变、禁止大色块"。点阵是纹理，只增加"密度感"。
         */
        backgroundColor: pattern.bg,
        backgroundImage: pattern.image,
        backgroundSize: pattern.size,
        // 网格跟着画布位移走（不跟着缩放 —— 缩放是内容的事，底图是"地面"）
        backgroundPosition: `${offset.x}px ${offset.y}px`,
      }}
    >
      {/* ── 内容层 ──
          注意本轮改动：空态**不再**是"要么画空卡、要么画内容"的二选一。
          现在两者可以同时存在 —— 空态用缩小的提示块（EmptyCanvas）
          下沉到底部，画布主体照常渲染。这样用户既能看到"将来长什么样"，
          也能看到"现在还没数据"。 */}
      {!mounted || (!view.w && nodes.length > 0) ? null : (
        <div
          /* P16：内容层钩子 —— 验收脚本区分"画布内容（可平移，bbox 会被
             stage 的 overflow:hidden 裁剪）"与"画布上的浮动控件/外部区域"，
             前者与后者的 bbox 相交属裁剪假象/既有设计，不算遮挡。 */
          data-canvas-layer
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: contentW,
            height: contentH,
            transformOrigin: '0 0',
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${finalScale})`,
          }}
        >
          <CanvasEdges
            nodes={nodes}
            edges={edges}
            width={contentW}
            height={contentH}
          />

          {/* ── UI ③：横向时间轴 ──
              画在卡片行**上方**（y 取负值，落在内容层顶部留白里）。
              坐标系与卡片一致（都用内容层坐标），所以随拖拽/缩放一起动，
              不会出现"卡片动了、时间轴没动"的割裂感。

              为什么用 SVG 而不是 DOM 节点：
                时间轴是一条连续横线 + 若干刻度，SVG 一个 line + 若干
                小竖线就画完了，且天然对齐、不参与布局（绝对定位的 div
                会与卡片抢 z-index，还得逐个对齐，反而更麻烦）。 */}
          {timeline && timeline.length > 0 && (() => {
            const axisY = -28
            const first = timeline[0]
            const last = timeline[timeline.length - 1]
            const x1 = first.x
            const x2 = last.x
            return (
              <svg
                data-canvas-timeline
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: contentW,
                  height: contentH,
                  overflow: 'visible',
                  pointerEvents: 'none',
                }}
              >
                {/* 主轴线 */}
                <line
                  x1={x1}
                  y1={axisY}
                  x2={x2}
                  y2={axisY}
                  stroke="#d1d5db"
                  strokeWidth={1.5}
                />
                {timeline.map((t) => (
                  <g key={t.anchorId}>
                    {/* 刻度小竖线 */}
                    <line
                      x1={t.x}
                      y1={axisY - 5}
                      x2={t.x}
                      y2={axisY + 5}
                      stroke="#9ca3af"
                      strokeWidth={1.5}
                    />
                    {/* 年份文字 */}
                    <text
                      x={t.x}
                      y={axisY - 12}
                      textAnchor="middle"
                      fontSize={14}
                      fill="#6b7280"
                    >
                      {t.year}
                    </text>
                    {/* 由轴线向下牵到卡片顶部的细引线 —— 明确"这个年份对应哪张卡" */}
                    <line
                      x1={t.x}
                      y1={axisY + 5}
                      x2={t.x}
                      y2={0}
                      stroke="#e5e7eb"
                      strokeWidth={1}
                      strokeDasharray="2 3"
                    />
                  </g>
                ))}
              </svg>
            )
          })()}

          {/* ── UI ③：列表型内容（研究债务）──
              非空时渲染列表、不渲染卡片节点（list 与 nodes 互斥）。
              行点击 = 选中该债务，底部面板随之展开详情 —— 与卡片一致。 */}
          {list && list.length > 0 && (
            <div
              data-canvas-list
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: contentW,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {list.map((row) => {
                const active = selectedId === row.id
                return (
                  <button
                    key={row.id}
                    type="button"
                    data-list-row={row.id}
                    data-list-active={active ? '1' : '0'}
                    /**
                     * ── P20：列表交错出场 ──
                     * 每行从下往上 12px + 淡入，逐项 +70ms（见 globals.css
                     * 的 .ma-list-item）。列表整体随视图 key 重挂载，
                     * 所以切到债务/演化的瞬间就会重播一次 —— 这正是
                     * "新内容进场"的注意力引导，而不是装饰性循环动画。
                     */
                    className="ma-list-item"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onNodeClick({ id: row.id } as LayoutNode)}
                    style={{
                      display: 'flex',
                      alignItems: 'stretch',
                      gap: 12,
                      height: 72, // P15 需求二：行高 56→72（字号放大联动，view-layout LIST_ROW_H 同步）
                      padding: '0 16px 0 0',
                      /**
                       * ⚠️ 这里刻意用 borderTop/Right/Bottom 三条长写，
                       *    而不是 shorthand `border`。
                       *
                       * 原因：下面还要单独写 `borderLeft`（左侧 3px 状态色条）。
                       *   如果同时出现 shorthand `border` 与 longhand `borderLeft`，
                       *   且 `border` 的值在 rerender 时变化（选中 2px ↔ 未选中 1px），
                       *   React 会发出告警：
                       *     "Updating border borderLeft ... don't mix shorthand and
                       *      non-shorthand properties for the same value"
                       *   而回归套件里有一条「全程无控制台报错」的断言，会因此失败。
                       *   拆成三条长写之后，四条边互不覆盖，告警消失，视觉完全一致。
                       */
                      borderTop: active ? '2px solid #2563eb' : '1px solid #e5e7eb',
                      borderRight: active ? '2px solid #2563eb' : '1px solid #e5e7eb',
                      borderBottom: active ? '2px solid #2563eb' : '1px solid #e5e7eb',
                      // 左侧 3px 状态色条 —— 列表上唯一的饱和色块
                      borderLeft: `3px solid ${row.barColor}`,
                      borderRadius: 8,
                      background: active ? '#eff6ff' : '#ffffff',
                      cursor: 'pointer',
                      textAlign: 'left',
                      overflow: 'hidden',
                    }}
                    title={row.title}
                  >
                    <span
                      style={{
                        minWidth: 0,
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        gap: 3,
                        paddingLeft: 13,
                      }}
                    >
                      {/* 名称 —— 列表的主信息，单行截断（完整名在面板里） */}
                      <span
                        style={{
                          fontSize: 18,
                          lineHeight: '24px',
                          fontWeight: 600,
                          color: active ? '#1d4ed8' : '#1a1a1a',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {row.title}
                      </span>
                      {row.meta && (
                        <span
                          style={{
                            fontSize: 14,
                            lineHeight: '19px',
                            color: '#9ca3af',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {row.meta}
                        </span>
                      )}
                    </span>
                    <span
                      aria-hidden
                      style={{
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        color: '#c4c7cc',
                        fontSize: 13,
                      }}
                    >
                      ›
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {!list?.length &&
            nodes.map((n) =>
              n.kind === 'card' ? (
                <CardNode
                  key={n.id}
                  node={n}
                  selected={selectedId === n.id}
                  onClick={onNodeClick}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              ) : (
                <CanvasNode
                  key={n.id}
                  node={n}
                  selected={selectedId === n.id}
                  intervened={intervenedIds?.has(n.block?.id ?? '') ?? false}
                  uncertain={uncertainIds?.has(n.block?.id ?? '') ?? false}
                  /**
                   * 剪刀模式下把点击路由给 onSurgeryPick。
                   * 只有"真的能动手"的节点才转交 —— 空节点、预览节点、根节点
                   * 点了不该有任何反应（否则用户会以为点了没生效）。
                   */
                  onClick={
                    surgeryMode && n.block && onSurgeryPick ? onSurgeryPick : onNodeClick
                  }
                  surgeryMode={surgeryMode && Boolean(n.block)}
                  surgeryPending={surgeryPending}
                  // 在节点上按下不应触发画布拖拽，否则拖节点会平移画布
                  onPointerDown={(e) => e.stopPropagation()}
                />
              )
            )}
        </div>
      )}

      {/* ── 空态提示块（缩小 + 下沉，不遮挡主体） ── */}
      {emptyTitle && (
        <EmptyCanvas
          title={emptyTitle}
          hint={emptyHint}
          action={emptyAction}
          onAction={onEmptyAction}
          liftedByPanel={panelOpen}
        />
      )}

      {/* 角落提示：数据能算出内容、但量很少时，一行小字说明"可以补" —— 不遮挡画布。
          位置抬到 bottom-12，给底部状态条让出空间，两者不重叠。 */}
      {cornerNote && !emptyTitle && (
        <p className="pointer-events-none absolute bottom-12 left-4 max-w-[420px] text-[11px] leading-4 text-ink-faint">
          {cornerNote}
        </p>
      )}

      {/* ── 上传按钮 —— 问题 1 ──
          固定在画布**左上角**，做成图标按钮（不随拖拽平移、不被底部面板顶走）。

          为什么从右栏搬到这里：
            ① 上传论文是"往画布加料"的**动作**，不是"切换视图"；
               它和剪刀按钮是同一类东西（对画布的操作），所以放在同一层，
               一左一右对称（左=加进来，右=切出去），语义上互相呼应。
            ② 之前在右栏最底部：右栏是可滚动的（论文切换器 flex-1 overflow-y-auto），
               论文一多，上传按钮就被顶出视口 —— 用户找不到"怎么加论文"。
               固定在画布上就永远不会消失。
            ③ 产品要求"底部面板滑出时按钮位置不变" —— 绝对定位在画布层，
               面板滑出是覆盖在它之上的另一个层，位置天然不变。

          z-20 与剪刀按钮同级（都低于动作反馈条 z-30）。
          图标用「＋」字形（产品禁止装饰性图标，单字字形是允许的）。 */}
      {onRequestUpload && (
        <div className="absolute left-4 top-3 z-20">
          <button
            type="button"
            data-upload-toggle
            data-upload-pending={uploadPending ? '1' : '0'}
            onClick={onRequestUpload}
            disabled={uploadPending}
            title={
              uploadPending
                ? `正在解析 ${uploadNote ?? 'PDF'}…`
                : '上传一篇 PDF 论文：解析 → 抽取方法结构'
            }
            aria-label="上传论文"
            className="flex h-8 w-8 items-center justify-center rounded-block border text-[15px] leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              borderColor: 'var(--line, #e5e7eb)',
              color: uploadPending ? '#9ca3af' : '#4b5563',
              background: 'rgba(255,255,255,0.92)',
            }}
          >
            {/* 上传中把「＋」换成状态字（解析/…），仍不用转圈动画 */}
            {uploadPending ? <span className="text-[10px]">…</span> : <span aria-hidden>＋</span>}
          </button>
          {/* 上传中：在按钮下方贴一行文件名，用户知道"在处理哪个" */}
          {uploadPending && uploadNote && (
            <p className="mt-1.5 max-w-[190px] truncate rounded-block border border-line bg-white/92 px-2 py-1 text-[11px] leading-4 text-ink-faint">
              {uploadNote}
            </p>
          )}
        </div>
      )}

      {/* ── 手术（剪刀）按钮 —— 问题 2 ──
          固定在画布**右上角**，不随拖拽平移、不被底部面板影响。
          为什么放右上角而不是右栏：
            ① 右栏是"流程站点"（DNA/演化/债务…），手术是"对当前画布的操作"，
               两者不是一类东西，混在一起用户会以为手术也是一个视图；
            ② 固定在画布上，用户不需要先跑到某个视图再翻按钮。
          z-20：低于动作反馈条（z-30），高于画布内容。 */}
      {/* ── 离线模式徽标（右上角）──
          真模型调用失败、已降级到 mock 时才出现。设计取舍：
            · 可见但不打断 —— 是个小徽标，不是弹窗/横幅，不抢画布的视觉重心
            · 琥珀色（warning 语义）而非红色 —— 降级不是错误，页面照常可用，
              用红色会让用户以为系统坏了
            · 不设 pointer-events 拦截 —— 悬停给原因，但不挡住下面的手术按钮
          z-20：与手术按钮同级，都低于动作反馈条（z-30）。 */}
      {degradedReason && (
        <div
          data-llm-degraded
          className="absolute left-4 top-14 z-20 sm:left-4"
          title={`真模型调用失败，已降级到本地演示模式。原因：${degradedReason}`}
        >
          <span
            className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium"
            style={{
              borderColor: '#fcd34d',
              background: '#fffbeb',
              color: '#b45309',
            }}
          >
            <span aria-hidden className="text-[10px] leading-none">
              ●
            </span>
            离线模式
          </span>
        </div>
      )}

      {/* ── 右上角动作簇（P16 后只剩手术按钮）──
          · 手术按钮：仅 dna 视图且存在可用 Block 时显示
          · 重置簇已迁往右栏工具栏（P16 问题一）—— 画布不再有重置入口，
            这个浮动容器只剩手术一个动作。
          验收口径同步变化：重置簇的几何断言（P16 E 组）改为
          「cluster ⊆ aside 且在击穿测试按钮下方」，与画布无关。 */}
      <div className="absolute right-4 top-3 z-20 flex items-start gap-2">
        {surgeryAvailable && (
          <div>
            <button
              type="button"
              data-surgery-toggle
              data-surgery-active={surgeryMode ? '1' : '0'}
              onClick={onToggleSurgery}
              disabled={surgeryPending}
              title={surgeryMode ? '退出手术模式' : '进入手术模式：点选一个模块，就地拿掉它'}
              aria-pressed={surgeryMode}
              className="flex items-center gap-1.5 rounded-block border px-2.5 py-1.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              style={{
                // 激活态用红框 —— 与"被手术干预的节点"同一套语义色，前后呼应
                borderColor: surgeryMode ? '#dc2626' : 'var(--line, #e5e7eb)',
                color: surgeryMode ? '#dc2626' : '#4b5563',
                background: surgeryMode ? '#fef2f2' : 'rgba(255,255,255,0.92)',
              }}
            >
              <span aria-hidden className="text-[13px] leading-none">
                ✂
              </span>
              <span>{surgeryMode ? '手术模式：点选模块' : '方法手术'}</span>
            </button>
            {/* 模式说明：一句话告诉用户"现在该干什么"，而不是让他猜光标为什么变了。
                问题 4 后必须讲清楚"点两下能来回切" —— 否则用户点完变红会以为不可逆。 */}
            {surgeryMode && (
              <p
                data-surgery-hint
                className="mt-1.5 max-w-[230px] rounded-block border px-2 py-1.5 text-[11px] leading-4"
                style={{ borderColor: '#fecaca', background: '#fff7f7', color: '#b91c1c' }}
              >
                点一个模块就把它拿掉；再点同一个模块可以恢复。再次点击 ✂ 退出。
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── P19 细节 2：缩放控件条已整体删除 ──
          原来它固定在画布右下角（bottom-4 right-4），而 P18 又把 logo
          也放在同一角落 —— 两者互相压叠，产品明确要求「logo 移走后，
          缩放条保留。或者两个都不放」。本轮把**两个都撤出画布**：
            · logo → 左栏底部（全站唯一品牌位）
            · 缩放条 → 删除
          依据：产品本轮的总原则是"一屏只有 1 个视觉焦点（思维导图），
          其他全部收起来或降级"，而画布已经自动适应视口（autoScale +
          纵向包围盒居中），手动缩放在这个画布上是低频动作；真正需要
          放大看细节时，浏览器缩放（Ctrl +/-）是通用且不需要学的手法。
          保留的画布内控件只剩两个语义明确的：左上「＋上传」、右上「✂手术」。 */}

      {/* ── 上下文横条（P7-4）：跨步骤传来的动态上下文，贴在画布顶部 ──
          层级别高于画布内容、低于动作反馈条（z-20 < ActionBar z-30），
          这样用户跑完动作时看到的仍是动作结果，不被上下文挤到下位。
          空态时也显示 —— 上下文是"流程层面"的信息，与画布有没有数据无关。 */}
      {contextStrip && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-3">
          <div
            data-context-strip
            className="flex items-center gap-1.5 rounded-full border border-line bg-white/90 px-3 py-1.5 backdrop-blur-sm"
          >
            <span aria-hidden className="text-[11px]" style={{ color: '#2563eb' }}>
              ↳
            </span>
            <span className="text-[11px] text-ink-muted">{contextStrip.text}</span>
          </div>
        </div>
      )}
    </div>
  )
}
