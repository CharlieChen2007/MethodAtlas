import { METHOD_STAGE_ORDER, type MethodStage } from '@/lib/enums'
import type { BlockView } from '@/lib/view-models'

/**
 * 方法结构思维导图的布局算法（纯函数，无 React 依赖）。
 *
 * 设计约束（来自产品负责人）：
 *   - 根节点在左，向右延伸
 *   - 层级固定：论文标题 → Problem → Input → Preprocessing
 *               → Core Method（含若干 Block 子节点）→ Training → Inference → Evaluation
 *   - 每个节点只显示两行：类型标签 + 一行标题
 *   - 连线浅灰细线、不画箭头
 *
 * 关键取舍：Core Method 的 Block 子节点**直接放在 Core Method 这一列内纵向排列**，
 * 而不是再向右展开一层。后者会变成 9 列、画布更宽、缩放比更小、文字更小。
 * 列头用一个小灰标题表达归属关系，不需要额外的边。
 */

// ── 几何常量 ──
// P15 需求二：图表字体放大（标签 11→14、标题 13→17、摘要 11→14），
// 节点宽高同步加大，否则文字溢出/截断：
//   NODE_W 168→208（17px 标题容纳约 11 字）、NODE_H 48→62、NODE_H_TALL 68→86
//   （三行 18+22+18 + 行距 + padding 的最小包络）；
//   GAP_X/GAP_Y 适度回收（40→36 / 14→12），避免整体缩放档位掉太多。
export const NODE_W = 208
/** 紧凑节点：两行（类型标签 + 名称） */
export const NODE_H = 62
/**
 * 带摘要的节点：三行（类型标签 + 名称 + 一行摘要）。
 *
 * 只有 Core Method 阶段的节点用这个高度 —— 产品要求「主视觉加密度」，
 * 但不能让 20 个 Block 全部加高：树会变高 400px，缩放到 0.7 后
 * 纵向超出视口太多。把加高权限只给"视觉重心"那一列，
 * 既实现了主视觉的密度，又控制了整体尺寸。
 */
export const NODE_H_TALL = 86
export const GAP_X = 36
export const GAP_Y = 12
/** 空列也占的最小高度，保证连线视觉对齐 */
const MIN_COL_H = 120

/**
 * 缩放下限 —— 再小文字就不可读了，宁可让用户拖拽平移。
 *
 * 演进过程（都基于实测）：
 *   0.7  最初值。8 列等宽 1624px 时树高仅 335px，900px 画布里纵向
 *        只填 37%，上下各空 280px，视觉"太空"。
 *   0.8  配合「列宽按密度分配」后，总宽从 1624 降到 1376，按宽度适配
 *        刚好落在 0.784，取 0.8 几乎没有额外溢出（左 22px），
 *        整棵树一屏可见，同时字比 0.7 大 14%。
 *
 * 为什么不再继续上调：再大就会重新产生明显横向溢出，用户必须拖拽
 * 才能看到完整流程，而"一屏看全 8 个阶段"是这张图的核心价值。
 */
export const MIN_SCALE = 0.8

/**
 * 纵向硬下限 —— 只有"面板挤压视口"这类纵向压力才允许跌破 MIN_SCALE 时使用。
 *
 * 为什么需要它（P10 问题 1）：
 *   用户明确要求"面板展开后所有 Block 都必须在可视区内，不允许有块消失"。
 *   但 MIN_SCALE=0.8 是**按宽度场景**定的可读性下限 —— 当面板把画布高度
 *   从 510px 压到 268px 时，0.8 也放不下（RAG 的 6 个高节点需要 478px），
 *   两者直接冲突。
 *
 *   取舍：**内容的完整性优先于字号**。理由是"少一个块"会让用户误读方法结构
 *   （以为论文没有这个阶段），而字小一点仍然可读、且用户可以把面板收起来
 *   恢复大字号。所以纵向压力下允许往下缩。
 *
 * ── 实测所需 scale（boxH = 该论文最高的一列的高度）──
 *
 *   旧的 RAG 三篇（每篇 6~10 块）：
 *     RAG(478px) @950 → 1.02 | @700 → 0.69 | @560 → 0.51  ← 当时的最极端
 *     FiD(396px) @950 → 1.23 | @700 → 0.84 | @560 → 0.62
 *   → 当时取 0.5 恰好够用。
 *
 *   ── P10 Step6：换成 IPS 三篇后，高度普涨 ──
 *   IPS 每篇都抽出了全部 7 个阶段，CORE_METHOD 一列往往有 5~9 个块
 *   （其中带摘要的块高 68px，不带 48px）：
 *     CPD-PDR(396px) @560 → 0.62
 *     WiFi-Aug(314px) @560 → 0.78
 *     Pazl(642px)   @560 → 0.38  ← **跌破 0.5，实测越界 26px（真 bug）**
 *   所以 0.5 不再够用，下移到 **0.35**（比 Pazl 需要的 0.38 再留一点余量，
 *   且仍远高于"完全看不清"的界线 —— 0.35 时 48px 的节点约 17px 高，
 *   块名仍可辨认；用户随时可收起面板恢复原比例）。
 */
export const ABS_MIN_SCALE = 0.35

export type NodeKind = 'root' | 'stage' | 'block' | 'empty' | 'card'

export interface LayoutNode {
  id: string
  kind: NodeKind
  /** 第一行：类型标签（小字灰色） */
  label: string
  /** 第二行：标题（一行，超出截断） */
  title: string
  x: number
  y: number
  w: number
  h: number
  /** 该列在画布中的索引，用于连线归组 */
  col: number
  /**
   * 所属方法阶段 —— 渲染层据此取阶段语义色（左侧色条）。
   * 根节点与空节点没有阶段，为 undefined。
   */
  stage?: MethodStage
  /**
   * 第三行灰色摘要（只有加高的节点才有）。
   *
   * 来源是现有字段（description），不新增数据模型字段。
   * 渲染层截断成一行，完整内容仍在底部面板里。
   */
  summary?: string
  /** 空节点的提示文案 */
  placeholder?: string
  /** 原始 block（block 节点才有） */
  block?: BlockView
  /**
   * 节点指向的实体 id（根节点 = paperId）。
   *
   * 用途：底部面板需要按 id 精确反查论文。**不能靠标题反查** ——
   * 库里存在同标题的两篇论文，标题匹配会命中错误的那一篇
   * （P10 问题 3 实测：两篇 Self-RAG 的 stage 覆盖不同）。
   */
  refId?: string
  /** 卡片内容（card 节点才有） */
  card?: CardSpec
  /**
   * 「预览态」标记 —— 方法手术的空态把真实结构图降对比度画出来，
   * 作为"刀要往哪落"的靶标底图。
   *
   * 渲染层据此：去掉阶段色条、边框改虚线灰、文字压暗。
   * 关键点是它**仍然是真实坐标**（复用 layoutStructure），
   * 所以预览与真实结构逐像素一致，只是配色不同 —— 不是示意图。
   */
  preview?: boolean
}

export interface LayoutEdge {
  from: string
  to: string
  /**
   * 终点锚点 y（可选）。
   *
   * 多节点列的目标节点在列首，但连线应指向「列中心」而不是列首节点中心，
   * 否则线会歪向顶部。渲染层优先用这个值，没有才回退到节点自身中心。
   */
  toAnchorY?: number
  /** 虚线 —— 用于"关系待建立"这类尚未证实的时间线连接 */
  dashed?: boolean
  /** 连线上的标签（如「关系待建立」），画在中点上方 */
  label?: string
}

export interface ListRow {
  /** 行 id（点击时回传，用于打开面板） */
  id: string
  /** 主标题（债务名） */
  title: string
  /** 左侧状态色条的颜色（语义色，由视图层决定） */
  barColor: string
  /** 行右侧的次要信息（如"3 篇论文提及 · 未解决"） */
  meta?: string
  /** 关联的原始数据 id */
  refId?: string
}

export interface LayoutResult {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  width: number
  height: number
  /** 节点真实纵向范围（不含留白），用于视口居中 */
  bounds: { minY: number; maxY: number }
  /**
   * ── UI ③：横向时间轴刻度 ──
   *
   * 演化视图要求"加一条横向时间线（年份），论文卡片挂在上面"。
   * 时间轴不是节点（不可点、不进面板），所以不能塞进 nodes ——
   * 那会让面板多出一堆"点了没反应"的假节点。
   *
   * 这里给出渲染所需的**最小信息**：
   *   · year  该刻度的年份文本（"2013" / "年份未知"）
   *   · x     刻度在画布坐标系里的横坐标（= 对应卡片中心）
   *   · anchor 该刻度锚定的是哪张卡片（渲染层据此可做高亮/对齐）
   *
   * 由 CanvasStage 画成一条带刻度的横线，位置在卡片行上方。
   * 没有年份数据时上游不传（退回纯卡片行，不画一条空轴）。
   */
  timeline?: { year: string; x: number; anchorId: string }[]
  /**
   * ── UI ③：列表型视图（研究债务）──
   *
   * 债务视图原本是"宽卡片"集合，每张卡塞三行（标题/为什么/论文列表）。
   * 产品要求改成**列表**：一行一条债务，左侧状态色条，右侧名称。
   *
   * 为什么用独立字段而不是继续用 CardSpec：
   *   列表的行高、行距、单行信息量都与卡片**根本不同** ——
   *   卡片是"一块块内容"，列表是"可扫读的条目流"。
   *   硬把列表塞进 CardSpec 会得到"假装是列表的卡片"，
   *   行高对不齐、色条位置也不对。所以给列表单独一条数据通道。
   *
   * 渲染层看到 list 非空时，渲染列表而**不**渲染 nodes（二选一），
   * 避免同一份数据画两遍。
   */
  list?: ListRow[]
  /** 空态：画布中央的一句话。有值时 nodes 必为空 */
  emptyTitle?: string
  /** 空态的补充说明 */
  emptyHint?: string
  /**
   * 空态主按钮文案。
   *
   * 注意：P7-3 起空态**可以同时有主体节点**（见 view-layout 的说明），
   * 所以 `emptyTitle` 不再意味着 `nodes` 为空 —— 它只表示"要额外渲染
   * 一个缩小的提示块"。按钮文案由视图可用性（getAvailability.action）决定，
   * 但个别视图（如手术空态）需要覆盖成更贴切的文案，所以这里也留一个口子。
   */
  emptyAction?: string
}

/**
 * 密度自适应列宽。
 *
 * 问题背景：
 *   原先 8 列等宽（每列 208px）。但真实数据里列的密度极不均匀 ——
 *   Core Method 一列塞 6 个节点，而问题/输入/预处理/训练/推理/评估
 *   这 6 列各只有 0~1 个。等宽的结果是：中间一座窄塔 + 两侧大片空白，
 *   整棵树横向铺开 1624px 却只有 42% 的纵向填充率，看起来"很空"。
 *
 * 解决思路：
 *   按列内实际节点数分配宽度 —— 内容多的列变宽、内容少的列压窄。
 *   这样横向总尺寸明显收缩，节点在画布里分布得更均匀。
 *
 * 宽度档位（两档，避免出现"每个列都不同宽"的锯齿感）：
 *   单节点列        SINGLE_W  —— 内容装得下即可，不需要整列宽
 *   多节点列        NODE_W    —— 保留标准宽，给长标题足够空间
 *
 * 为什么不再有"空列"档（S1）：
 *   空阶段列现在**根本不会被创建**（见下方 activeStages），
 *   所以原来给空列准备的 NARROW_W 已无用途，随之删除。
 *   留着它会让后来的人以为"还有一种空列要处理"。
 *
 * 为什么设下限而不是按内容精确伸缩：节点宽度还要保证 184px 才能容下
 * 截断后的标题（P15 字号放大后从 148 同步上调）；压得太窄会频繁把标题
 * 截成"…"，反而降低可读性。
 */
const SINGLE_W = 184
const COLUMN_LABEL: Record<MethodStage, string> = {
  PROBLEM: '问题',
  INPUT: '输入',
  PREPROCESSING: '预处理',
  CORE_METHOD: '核心方法',
  TRAINING: '训练',
  INFERENCE: '推理',
  EVALUATION: '评估',
}

/**
 * 单列高度：max(内容高, 最小高)
 * 内容高 = Σ 各节点高 + (n-1) × GAP_Y
 *
 * 注意这里必须按**每个节点的实际高度**逐个累加，不能用 n × NODE_H ——
 * Core Method 列的节点是加高的（NODE_H_TALL），继续按 NODE_H 算会让
 * 列高少算，最后一个节点溢出列底、连线锚点也对不上。
 */
function columnHeight(heights: number[]): number {
  if (heights.length === 0) return MIN_COL_H
  const sum = heights.reduce((s, h) => s + h, 0)
  return Math.max(sum + (heights.length - 1) * GAP_Y, MIN_COL_H)
}

/**
 * 构建方法结构树布局。
 *
 * @param paperTitle 论文标题 —— 作为根节点
 * @param blocks     该论文的方法模块（已按 stage/order 排好）
 */
/**
 * 缩放策略再审视：
 *   8 列固定宽度 = 8×168 + 7×40 = 1624px。
 *   视口 1440 减去右侧 25% 工具栏后剩约 1080px。
 *   1624 > 1080 → 若按"适配宽度"缩放会到 0.66，低于 MIN_SCALE 0.7。
 *   所以实际 scale = 0.7，内容仍比视口宽 57px，靠拖拽消化。
 *
 * 横向拖拽边界由此得出：overflowX = 1624×0.7 - 1080 ≈ 57px。
 * 也就是说 评估 列在最右时需要拖 57px 才能完整看到 —— 这是可接受的，
 * 因为"根节点在左"是首要视觉锚点，右侧是延伸方向。
 */
export function layoutStructure(
  paperTitle: string,
  blocks: BlockView[],
  options?: { intervenedBlockIds?: string[]; paperId?: string }
): LayoutResult {
  const intervened = new Set(options?.intervenedBlockIds ?? [])
  const nodes: LayoutNode[] = []
  const edges: LayoutEdge[] = []

  // ── 1. 按 stage 分桶 ──
  const bucket = new Map<MethodStage, BlockView[]>()
  for (const stage of METHOD_STAGE_ORDER) bucket.set(stage, [])

  for (const b of blocks) {
    const stage = (b.stage as MethodStage) ?? 'CORE_METHOD'
    // 未知 stage 归入 CORE_METHOD，避免丢数据
    const key = bucket.has(stage) ? stage : 'CORE_METHOD'
    bucket.get(key)!.push(b)
  }
  // 列内按 order 升序
  for (const stage of METHOD_STAGE_ORDER) {
    bucket.get(stage)!.sort((a, b) => a.order - b.order)
  }

  /**
   * ── S1：只渲染"真的出现过"的阶段（P1 拍板：不额外调 LLM）──
   *
   * 旧行为：固定渲染全部 7 个阶段列，空列画一个虚线的
   * 「原文未描述」占位，理由是要"保证连线贯通"。
   *
   * 为什么这是错的：
   *   ① **视觉噪音**。一篇论文通常只覆盖 3~4 个阶段，另外 3~4 列
   *      全是灰色虚线框，画布一半是"我们没有的东西"。用户第一眼
   *      看到的是缺失，而不是这篇论文做了什么。
   *   ② **信息误读**。「原文未描述」在一列里连续出现四次，
   *      读者会怀疑是抽取失败，而不是"这篇论文本来就不涉及"。
   *   ③ **连线为空而连**。为了贯通而画的线把"有内容"和"没内容"
   *      视觉上拉平了 —— 线本身携带的信息量归零。
   *
   * 新行为：按 METHOD_STAGE_ORDER 的**规范顺序**过滤出非空阶段，
   * 只渲染这些列。列数等于"这篇论文实际覆盖的阶段数"，
   * 连线天然只在有内容的列之间走，不再需要空节点做锚点。
   *
   * 为什么这是"忠实渲染"而不是"隐瞒信息"：
   *   阶段是论文方法的内在结构（问题/输入/核心方法/…），
   *   "某阶段没有 block"表达的是**该阶段在原文中未被识别为独立步骤**，
   *   而不是"我们查失败了"。把没识别到的阶段画成灰框，
   *   反而是把"识别结果"和"识别失败"混为一谈。
   *
   * 顺序仍按 METHOD_STAGE_ORDER 常量（不是按出现顺序），
   * 这样跨论文对比时列序稳定 —— 这是"动态列"能用的前提。
   */
  const activeStages = METHOD_STAGE_ORDER.filter((s) => bucket.get(s)!.length > 0)

  // ── 2. 列宽（密度自适应）+ 列高 ──
  //
  // Core Method 列用加高节点（带摘要），其余阶段用紧凑节点。
  // 这里先按「每个节点的实际高度」算出列高数组，后面建节点时复用同一份
  // 决策（nodeHeightFor 函数），保证"算高度"和"放节点"用的是同一套规则 ——
  // 否则很容易出现列高与节点实际占用不一致的错位。
  const colHeights = activeStages.map((stage) =>
    columnHeight(bucket.get(stage)!.map((b) => nodeHeightFor(stage, b)))
  )
  const contentH = Math.max(...colHeights, MIN_COL_H)

  /**
   * 每列宽度：按节点数分档（见文件上方 SINGLE_W / NODE_W 的说明）。
   * 根节点（第 0 列）固定标准宽。
   */
  const colWidths: number[] = [
    NODE_W, // 列 0：根节点（论文标题可能很长，给足宽度）
    // activeStages 里每列至少 1 个 block，所以不存在 n === 0 分支
    ...activeStages.map((stage) => {
      const n = bucket.get(stage)!.length
      return n === 1 ? SINGLE_W : NODE_W
    }),
  ]

  /**
   * 每列的起点 x —— 由前面的列宽 + 间距累加而来。
   *
   * 这是本次改造的核心：列 x 不再能用 `i * (NODE_W + GAP_X)` 这种等距公式，
   * 因为列宽已经不等。改成前缀和之后，任意列宽组合都能正确排布，
   * 连线两端也就自动对齐了（连线读的是节点自身的 x / w）。
   */
  const colOffsets: number[] = []
  {
    let cursor = 0
    for (const w of colWidths) {
      colOffsets.push(cursor)
      cursor += w + GAP_X
    }
  }
  const width = colOffsets[colOffsets.length - 1] + colWidths[colWidths.length - 1]
  const cols = colWidths.length
  // 上下各留一点余量，避免节点贴边
  const height = contentH + 80

  // 所有列共用同一条中线 —— 这样连线是水平的，视觉上是一棵树而不是扇形
  const centerY = height / 2

  /**
   * 真实内容边界。
   *
   * 注意 `height = contentH + 80` 里那 80px 是上下各 40 的留白，而节点只占
   * contentH 那一段。视口居中必须按「节点的实际包围盒」算，否则短列居中在
   * contentH 里、contentH 又居中在 height 里，两次居中叠加会让整棵树视觉偏上。
   * 这里返回节点真实范围，交给 CanvasStage 做居中。
   */
  const bounds = {
    minY: centerY - contentH / 2,
    maxY: centerY + contentH / 2,
  }

  /** 某列起点 x（前缀和，支持不等宽列） */
  const colX = (i: number) => colOffsets[i] ?? 0
  /** 某列宽度 */
  const colW = (i: number) => colWidths[i] ?? NODE_W

  /**
   * 某列第一个节点的中心 y —— 用于连线端点。
   *
   * 注意：这里记录的是「该列的垂直中心」，而不是"第一个节点的中心"。
   * 因为列的节点是围绕 centerY 对称分布的，锚点取列中心才能让连线水平、
   * 不让线歪向列首节点。单节点列与空列的中心恰好就是节点中心，无需特判。
   */
  const colAnchorY = new Map<string, number>()
  const colFirstId = new Map<string, string>()

  // ── 3. 根节点（第 0 列，垂直居中） ──
  const rootId = 'root'
  nodes.push({
    id: rootId,
    kind: 'root',
    label: '论文',
    title: paperTitle,
    /**
     * ── P10 问题 3：根节点必须带上 paperId ──
     *
     * 面板原本靠 `papers.find(p => p.title === node.title)` 反查论文，
     * 但**同标题的论文真实存在**（实测 Self-RAG 有两篇，stage 覆盖不同）。
     * 反查会命中列表里的第一篇，于是"未抽取阶段说明"列的是**另一篇**的阶段 ——
     * 数据看着对，其实张冠李戴。
     * 带上 id 之后按 id 精确匹配，从根上消除这个歧义。
     */
    refId: options?.paperId,
    x: colX(0),
    y: centerY - NODE_H / 2,
    w: colW(0),
    h: NODE_H,
    col: 0,
  })

  // ── 4. 七个阶段列 ──
  activeStages.forEach((stage, i) => {
    const col = i + 1
    const list = bucket.get(stage)!
    const colH = columnHeight(list.map((b) => nodeHeightFor(stage, b)))
    // 列内垂直居中
    const top = centerY - colH / 2
    const label = COLUMN_LABEL[stage] ?? stage
    const isCore = stage === 'CORE_METHOD'

    /**
     * ── S1：空阶段分支已删除 ──
     *
     * 这里原来有一段 `if (list.length === 0)`，画虚线节点
     * 「原文未描述」来"保证连线贯通"。
     * 因为 activeStages 已经过滤掉空阶段，这段永远进不来，
     * 留着会让后来的人以为还应该处理空列 —— 所以直接删掉，
     * 而不是留个 `// unreachable` 注释。
     * （连带 NARROW_W 也失去唯一用途，已在常量定义处删除。）
     */

    // 逐节点累加 y —— 每个节点高度可能不同（Core Method 列有加高节点），
    // 所以不能再用 j * (NODE_H + GAP_Y) 这种等距公式。
    let cursor = top
    list.forEach((b, j) => {
      const id = `block-${b.id}`
      const h = nodeHeightFor(stage, b)
      const y = cursor
      cursor += h + GAP_Y

      const showSummary = isCore && hasSummary(b)
      nodes.push({
        id,
        kind: 'block',
        // 第一行标签：阶段名（Core Method 列用类型名，信息量更大）
        label: isCore ? columnLabelForType(b.type) : label,
        title: b.name,
        x: colX(col),
        y,
        w: colW(col),
        h,
        col,
        stage,
        // 第三行摘要：只有加高的节点才带（渲染层据此决定画不画第三行）
        summary: showSummary ? summarize(b.description) : undefined,
        block: b,
      })
      if (j === 0) {
        // 锚点用列中心（centerY），不是首节点中心 —— 多节点列才不会让线歪
        colAnchorY.set(id, centerY)
        colFirstId.set(stage, id)
      }
      // 被手术干预的节点标记（用于红色边框）
      if (intervened.has(b.id)) {
        // 标记放在 block 上，渲染层读 intervenedSet
      }
    })
  })

  // ── 5. 连线：根 → 每个阶段列的锚点（第一个节点/空节点） ──
  // 用"干线 + 分支"的方式：根右边中点 → 各列左边中点
  const targets: string[] = activeStages.map((stage) => colFirstId.get(stage)).filter(
    (v): v is string => typeof v === 'string'
  )
  for (const target of targets) {
    edges.push({ from: rootId, to: target, toAnchorY: colAnchorY.get(target) })
  }

  return { nodes, edges, width, height, bounds }
}

/** Core Method 列内节点第一行用类型名（比"核心方法"更有信息量） */
function columnLabelForType(type: string): string {
  const map: Record<string, string> = {
    ENCODER: '编码器',
    DECODER: '解码器',
    ATTENTION: '注意力',
    LOSS: '损失函数',
    REGULARIZATION: '正则化',
    SAMPLING: '采样策略',
    PRETRAIN: '预训练',
    FINETUNE: '微调',
    AUGMENTATION: '数据增强',
    ARCHITECTURE: '整体架构',
    POSTPROCESS: '后处理',
    OTHER: '核心方法',
  }
  return map[type] ?? '其他'
}

/**
 * 某个阶段下的节点该用多高。
 *
 * 规则：只有「有摘要可显示」的节点才加高 —— 加高但第三行是空的，
 * 就只是徒增留白，与「不要留大片空白」的目标相反。
 * 摘要取自 block.description（现有字段，不新增数据模型字段）。
 *
 * 按产品决策，加高权限只给 Core Method 这一列（视觉重心）。
 */
function nodeHeightFor(stage: MethodStage, b: BlockView): number {
  if (stage !== 'CORE_METHOD') return NODE_H
  return hasSummary(b) ? NODE_H_TALL : NODE_H
}

/**
 * 是否有一行可用的摘要。
 *
 * 为什么要判空而不直接用 description：
 *   description 可能是空串、也可能是一整段论文原句（几百字符）。
 *   截断由渲染层做，这里只判断"有没有东西可显示"。
 *   阈值取 8 字符 —— 更短的（如 "test"）当摘要没有信息量。
 */
export function hasSummary(b: BlockView): boolean {
  const d = (b.description ?? '').trim()
  return d.length >= 8
}

/**
 * 把 block.description 压成一行摘要。
 *
 * 真实数据里 description 常常是一整段论文原句（如
 * "We propose retrieval-augmented generation for knowledge-intensive NLP tasks…"），
 * 直接塞进 168px 宽的节点会溢出。这里做三件事：
 *   1. 折掉换行与连续空白，避免把多段挤成一行时出现双重空格
 *   2. 硬截断到 max 字符 —— 渲染层还有 textOverflow:ellipsis 兜底，
 *      两处都设是刻意的：CSS 截断发生在像素级，JS 截断保证 DOM 里的
 *      文本长度可控（大量长文本会拖慢布局）
 *   3. 截断处补省略号，明确告诉用户"这里还有更多"
 *
 * 注意摘要**不替代**描述：完整原文仍在底部详情面板里。节点摘要是
 * "扫一眼知道这列在干什么"的导航信息，不是阅读材料。
 */
export function summarize(desc: string, max = 46): string {
  const flat = (desc ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max).trimEnd()}…`
}

/**
 * 空状态布局：中央一句话 + 一个动作按钮。
 *
 * 注意这里**不返回节点**，而是返回空 nodes 并带上 `emptyTitle`/`hint`。
 * 空态由专门的 EmptyCanvas 组件渲染成居中的一句话 + 主按钮，
 * 不用画布节点假装 —— 节点意味着"结构里的一环"，空态不是。
 */
export function layoutEmpty(title: string, hint?: string): LayoutResult {
  return {
    nodes: [],
    edges: [],
    width: CARD_GAP,
    height: MIN_COL_H,
    bounds: { minY: 0, maxY: MIN_COL_H },
    emptyTitle: title,
    emptyHint: hint,
  }
}

// ─────────────────────────────────────────────────────────────
// 卡片列布局 —— 给「手术 / 债务 / 想法 / 击穿」这类列表型视图用
// ─────────────────────────────────────────────────────────────
//
// 为什么不做成结构树：这 4 个视图的数据不是"层级结构"而是"若干张卡片"，
// 强行画成树会捏造并不存在的父子关系。它们共用一个横向排列的卡片画布，
// 每张卡片是节点的一种 kind，从而复用同一套拖拽/缩放/选中机制。

/** 卡片尺寸（比节点大，因为要放标题 + 摘要） */
export const CARD_W = 300
export const CARD_H = 180
export const CARD_GAP = 28

/**
 * 卡片色调 —— 直接复用全局状态色调（palette.StatusTone）。
 *
 * 早先这里有一套独立的 4 值词汇（default/concern/insufficient/ok），
 * 与 palette 的 bad/warn/good/unknown 是并行两套，需要一层映射。
 * 现在统一成后者：少一套词汇、少一处映射、也少一个"两种红"的来源。
 */
export type CardTone = 'bad' | 'warn' | 'good' | 'unknown' | 'default'

/** 一张卡片的内容，渲染层按 kind 决定版式 */
export interface CardSpec {
  id: string
  /** 第一行小标签 */
  label: string
  /** 主标题 */
  title: string
  /** 2~3 行摘要（渲染时截断） */
  excerpt: string
  /** 语义色调 —— 决定左边框颜色，不用大面积色块 */
  tone: CardTone
  /** 卡片右下角的次要信息（如"3 篇论文提及"） */
  footnote?: string
  /** 关联的原始数据 id，用于底部面板取详情 */
  refId?: string

  /**
   * ── 统一的语义徽标（问题 5/7 新增）──
   *
   * 产品要求：禁止把「【演示推断】」「待验证」这类标注**混进句子**，
   * 需要标注时用统一的 UI 元素。这个字段就是那个元素的唯一数据出口：
   * 卡片渲染成一个小胶囊（如「待验证」），而不是在文案里写一长句免责声明。
   *
   * 为什么放在 CardSpec 而不是各视图自己往里塞文字：
   *   同一类标注（"这条是推断，未经实验"）出现在多处时，各写各的措辞
   *   必然不一致。收敛成一个字段 + 一个渲染样式，口径与视觉都统一。
   */
  badge?: { text: string; tone: CardTone }

  // ── 以下是各视图的"特征块"（P7-3 新增）──
  //
  // 产品要求 5 个视图各有画布主体。有数据与空态**复用同一套 CardSpec**，
  // 所以特征块不是"空态专用的装饰"，而是这个视图卡片版式的一部分。

  /** 研究债务：第二行「为什么是债务」 */
  why?: string
  /** 研究债务：第三行「涉及的论文」 */
  papers?: string[]
  /** 组合想法：`A + B × Debt = Idea` 小图的四个操作数 */
  formula?: { a?: string; b?: string; debt?: string; idea?: string }
  /** 击穿测试：6 个检查项的图标状态行 */
  checks?: { key: string; label: string; level: string; icon: string }[]
}

/** layoutCards 的可选参数 */
export interface LayoutCardsOptions {
  /** 卡片间距 —— 不传用 CARD_GAP；组合视图要求收紧到 14 */
  gap?: number
  /** 宽卡模式（480px）—— 研究债务的三行结构需要更宽的自证空间 */
  wide?: boolean
  /**
   * 竖向堆叠（P18 问题 3c）—— 卡片沿 y 轴排成一列而不是横向一行。
   *
   * 为什么给选项而不是新写一个函数：竖排与横排只差 x/y 两个坐标
   * 的算法，节点的其余字段（尺寸/列号/卡片负载）完全一致；
   * 分家成两个函数会让"改卡片尺寸"这类变更要改两处。
   * 目前只有击穿测试视图用它（卡片数随想法数增长，横排会把
   * 画布拉得越来越宽，竖排更符合"逐个往下读"的阅读动线）。
   */
  vertical?: boolean
}

/** 宽卡尺寸 —— 研究债务专用 */
export const CARD_W_WIDE = 480

/**
 * 把一组卡片排成一行（默认横向；vertical 时竖向一列）。
 *
 * 之所以是"一行"而不是"网格"：画布永不同时出现纵向滚动与横向滚动，
 * 单向排布让拖拽方向唯一，用户的肌肉记忆不会混乱。
 */
export function layoutCards(cards: CardSpec[], options?: LayoutCardsOptions): LayoutResult {
  const gap = options?.gap ?? CARD_GAP
  const w = options?.wide ? CARD_W_WIDE : CARD_W
  const vertical = options?.vertical === true

  const nodes: LayoutNode[] = cards.map((c, i) => ({
    id: c.id,
    kind: 'card',
    label: c.label,
    title: c.title,
    x: vertical ? 0 : i * (w + gap),
    y: vertical ? i * (CARD_H + gap) : 0,
    w,
    h: CARD_H,
    col: i,
    card: c,
  }))

  const width = vertical ? w : Math.max(1, cards.length) * (w + gap) - gap
  const height = vertical
    ? Math.max(1, cards.length) * (CARD_H + gap) - gap
    : CARD_H
  return {
    nodes,
    edges: [],
    width,
    height,
    // 单列/单行卡片：包围盒就是排布本身，画布据此居中
    bounds: vertical
      ? { minY: 0, maxY: Math.max(height, CARD_H) }
      : { minY: 0, maxY: CARD_H },
  }
}
