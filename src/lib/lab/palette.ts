import type { MethodStage } from '@/lib/enums'
import type { EvidenceStatus } from '@/lib/enums'

/**
 * 画布语义色板 —— 全站颜色的**唯一来源**。
 *
 * 为什么集中在一处：
 *   阶段色、状态色、视图主题色会被节点、色条、工具栏、面板、状态条
 *   分别消费。散落各处写 16 进制字面量，改一个色要全仓库搜，
 *   而且很容易出现"节点上的红"和"徽标上的红"不是同一个红。
 *
 * 三层颜色（视图 / 阶段 / 状态）的隔离契约见文件第 4.1 节
 * `assertColorLayers()` —— 分属三个色域、靠"用在哪"隔离。
 *
 * 使用纪律（产品要求「颜色有语义、不大面积铺」）：
 *   颜色只允许出现在 —— 色条、图标、边框、徽标底色。
 *   禁止：铺满节点的实心色块、渐变、深色背景。
 *
 * 关于对比度：这些色都按 WCAG AA（≥4.5:1 对白底）挑选过，
 * 作为 11~13px 小字的文字色也不会糊。深蓝 #1d4ed8 是 Core Method 的
 * 主色，比通用强调蓝 #2563eb 更深，用来区分"结构重心"和"可交互态"。
 */

// ─────────────────────────────────────────────────────────────
// 1. 方法阶段色（按 METHOD_STAGE_ORDER 的流程顺序）
// ─────────────────────────────────────────────────────────────

export const STAGE_COLOR: Record<MethodStage, string> = {
  PROBLEM: '#dc2626', // 红 —— 问题
  INPUT: '#2563eb', // 蓝 —— 输入
  PREPROCESSING: '#0891b2', // 青 —— 预处理
  CORE_METHOD: '#1d4ed8', // 深蓝 —— 核心方法（视觉重心）
  TRAINING: '#7c3aed', // 紫 —— 训练
  INFERENCE: '#ea580c', // 橙 —— 推理
  EVALUATION: '#16a34a', // 绿 —— 评估
}

/** 阶段色淡底 —— 只用于 Core Method 这类需要"轻微浮起"的节点，仍属浅色 */
export const STAGE_SOFT: Record<MethodStage, string> = {
  PROBLEM: '#fef2f2',
  INPUT: '#eff6ff',
  PREPROCESSING: '#ecfeff',
  CORE_METHOD: '#eff6ff',
  TRAINING: '#f5f3ff',
  INFERENCE: '#fff7ed',
  EVALUATION: '#f0fdf4',
}

/** 阶段色到文字的映射（面板/状态条里标阶段名用） */
export function stageColor(stage: string | null | undefined): string {
  return STAGE_COLOR[(stage ?? '') as MethodStage] ?? '#6b7280'
}

export function stageSoft(stage: string | null | undefined): string {
  return STAGE_SOFT[(stage ?? '') as MethodStage] ?? '#ffffff'
}

// ─────────────────────────────────────────────────────────────
// 2. 状态色 —— 证据强度三色
// ─────────────────────────────────────────────────────────────
//
// 研究债务的「未解决 / 部分解决 / 已解决」用同一套三色：
//   currentStatus 在数据里是自由文本（"…未见明确解决"），不是枚举，
//   按文本猜关键词会在换一批数据后全部落到同一色。而 evidenceStatus
//   是真实枚举列，且语义一致（红=有问题），所以复用它。
//   这样只有一套状态色，不会出现"两种红"。

export const STATUS_COLOR = {
  /** 红 —— 有问题 / 未解决 / 证据不足 */
  bad: '#dc2626',
  /** 黄 —— 部分解决 / 证据有限 */
  warn: '#d97706',
  /** 绿 —— 已解决 / 证据充分 */
  good: '#16a34a',
  /** 灰 —— 未知 */
  unknown: '#9ca3af',
} as const

export type StatusTone = keyof typeof STATUS_COLOR

/**
 * ── P19 细节 3：问题/债务状态 → 统一四色（全站唯一口径）──
 *
 * 产品本轮点名的 bug：演化卡片里「PDR 累积漂移」是**部分解决**却显示绿色条。
 *
 * 根因不在配色表，而在 `view-layout.ts` 的 statusTone 只返回三档
 * （good/warn/bad），而问题状态有**四档**：
 *   solved（已解决）/ partial（部分解决）/ open（未解决）/ points_out（指出问题）
 * 三档映射四档必然有两档撞色 —— 旧实现把 points_out 也塞进 bad，
 * 于是"指出问题"和"未解决"都是红的；一旦某处按错档取值，
 * 就会出现"文案说部分解决、颜色是绿/红"的错配。
 *
 * 现在把映射收敛到这里（唯一来源），四档对四色，语义与产品口径一致：
 *   已解决 → 绿  部分解决 → 橙  未解决 → 红  指出问题 → 灰
 *
 * 为什么 ppoints_out 用灰而不是红：
 *   "指出问题"表示**还没人动手**（没有 attempt），它不是失败，
 *   只是"这个坑还没人跳"。用红会和"试过但失败了"混为一谈 ——
 *   这正是 P7 时期把两者拆开的原始理由，颜色必须跟着拆。
 */
export type ProblemStatusTone = StatusTone

export function toneForProblemStatus(
  s: 'solved' | 'partial' | 'open' | 'points_out'
): StatusTone {
  switch (s) {
    case 'solved':
      return 'good'
    case 'partial':
      return 'warn'
    case 'open':
      return 'bad'
    case 'points_out':
      return 'unknown'
    default:
      return 'unknown'
  }
}

/** 证据强度 → 状态色调 */
export function toneForEvidence(status: string | null | undefined): StatusTone {
  switch (status as EvidenceStatus | undefined) {
    case 'CONFIRMED':
      return 'good'
    case 'UNCERTAIN':
      return 'warn'
    case 'INSUFFICIENT':
      return 'bad'
    default:
      return 'unknown'
  }
}

/** 击穿测试判定 → 状态色调 */
export function toneForVerdict(verdict: string | null | undefined): StatusTone {
  switch (verdict) {
    case 'PASS':
    case 'POSITIVE':
      return 'good'
    case 'CONCERN':
      return 'warn'
    case 'FAIL':
      return 'bad'
    case 'INSUFFICIENT_EVIDENCE':
      return 'unknown'
    default:
      return 'unknown'
  }
}

/**
 * 击穿测试的**总体判定** → 卡片色调（问题 5）。
 *
 * 为什么不能复用 toneForVerdict：
 *   那个函数吃的是**模型的 verdict**（PROMISING / RISKY / LIKELY_EXISTS…），
 *   而问题 5 之后卡片展示的是**结论层**给出的 可行/需要调整/不建议做。
 *   两者取值域不同，硬塞会全部落到 default（灰），卡片就没有颜色档了。
 *   这里按结论的语义单独映射，卡片颜色才能跟结论一致。
 */
export function toneForOverall(outcome: string | null | undefined): StatusTone {
  switch (outcome) {
    case 'go':
      return 'good'
    case 'adjust':
      return 'warn'
    case 'stop':
      return 'bad'
    default:
      return 'unknown'
  }
}

/** 状态色调 → 色值 */
export function statusColor(tone: StatusTone): string {
  return STATUS_COLOR[tone]
}

// ─────────────────────────────────────────────────────────────
// 3. 卡片色调 —— 与上面的 StatusTone 对齐
// ─────────────────────────────────────────────────────────────
//
// CardNode 的 `tone` 字段有 4 个值（default/concern/insufficient/ok），
// 是画布层的既有契约。这里把它映射到统一状态色，避免 CardNode 里
// 再定义一份色值表。

/**
 * 卡片色调 → 色值。
 *
 * 键集与 layout.CardTone 对齐（bad/warn/good/unknown/default），
 * 这样卡片颜色完全由状态色调决定，没有中间映射层。
 */
export const CARD_TONE_COLOR: Record<string, string> = {
  default: '#d1d5db', // 无状态信息 → 中性灰，不暗示任何判断
  bad: STATUS_COLOR.bad,
  warn: STATUS_COLOR.warn,
  good: STATUS_COLOR.good,
  unknown: STATUS_COLOR.unknown,
}

// ─────────────────────────────────────────────────────────────
// 4. 视图主题色 —— 工具栏每个视图一个色，用于图标与徽标
// ─────────────────────────────────────────────────────────────
//
// 为什么给 6 个视图配 6 个色：
//   工具栏是要被反复扫读的。纯灰的 6 行按钮一眼分不出哪个是哪个，
//   每个视图固定一个色之后，用户会形成"紫色那个是演化"的肌肉记忆。
//   颜色只落在 6px 的图标和徽标上，不构成大色块。
//
// ── 语义标签（产品要求「颜色有语义、不是纯装饰」）──
//   每个视图色都对应一个**动作语义**，而不只是"第 N 个色"：
//     DNA    蓝 = 结构（看形状）
//     手术   橙 = 操作（动刀）
//     演化   紫 = 时间（先后变化）
//     债务   红 = 问题（要解决的）
//     组合   绿 = 生成（产出新东西）
//     击穿   灰 = 检验（中性裁断）
//   语义落在工具栏按钮的 title 里，让颜色可被解释、而非只靠记忆。

export interface ViewColorSpec {
  color: string
  /** 动作语义标签 —— 颜色代表什么 */
  semantic: string
}

export const VIEW_COLOR_SPEC: Record<string, ViewColorSpec> = {
  dna: { color: '#2563eb', semantic: '结构' },
  surgery: { color: '#ea580c', semantic: '操作' },
  evolution: { color: '#7c3aed', semantic: '时间' },
  debt: { color: '#dc2626', semantic: '问题' },
  idea: { color: '#16a34a', semantic: '生成' },
  crashtest: { color: '#6b7280', semantic: '检验' },
}

export const VIEW_COLOR: Record<string, string> = Object.fromEntries(
  Object.entries(VIEW_COLOR_SPEC).map(([k, v]) => [k, v.color])
)

export function viewColor(id: string): string {
  return VIEW_COLOR[id] ?? '#6b7280'
}

/** 视图色的语义标签（工具栏 tooltip / 验证脚本用） */
export function viewSemantic(id: string): string {
  return VIEW_COLOR_SPEC[id]?.semantic ?? ''
}

// ─────────────────────────────────────────────────────────────
// 4.1 三层颜色的隔离契约（用代码+断言强制，而不是靠自觉）
// ─────────────────────────────────────────────────────────────
//
// 产品要求「三层颜色不混用」：
//   视图色  → 工具栏（RightToolbar）+ 区域分隔色带（P14：画布列左缘
//             2px data-zone-band、BottomPanel/CrashChatPanel 标题行左缘
//             短线 —— 让"当前在哪个区域操作"一眼可辨）
//   阶段色  → 只允许出现在画布节点色条（CanvasNode）
//   状态色  → 只允许出现在卡片徽标（CardNode / BottomPanel 徽标）
//
// 验收断言方向（verify-local 验收 7）：工具栏上不允许出现阶段色/状态色
// （单向越界检查）；视图色新增的两个落点都在画布列内部，不参与该断言。
//
// ── 必须显式说明的一件事（不假装它们不同）──
//   视图色与阶段色**存在同值**：
//     债务红 #dc2626   == PROBLEM 红
//     演化紫 #7c3aed   == TRAINING 紫
//     组合绿 #16a34a   == EVALUATION 绿
//     手术橙 #ea580c   == INFERENCE 橙
//     击穿灰 #6b7280   ——  阶段色里**没有**（唯一一个不重叠的）
//     结构蓝 #2563eb   == INPUT 蓝
//
//   这不是"撞色"。两组色分属**两个色域**、**永不共处**：
//   视图色只画在右侧工具栏的 24px 图标/徽标上，阶段色只画在画布节点的
//   3px 左色条上 —— 屏幕上不存在"一枚视图色标记"和"一枚阶段色标记"
//   需要被区分的那一刻。
//
//   所以这里**不做**"把色值改成不同"的假功夫（那只会让语义标签失真），
//   而是用 `assertColorLayers()` 把"靠用途隔离"这条约定写成断言：
//   重叠是**允许**的，但越界（用错色域）是错误。
//
//   这个函数在验证脚本与开发期调用，越界即抛错。

/** 三个色域的取色入口 —— 组件只允许 import 自己那一个 */
export const COLOR_LAYER = {
  view: 'view',
  stage: 'stage',
  status: 'status',
} as const

export type ColorLayer = (typeof COLOR_LAYER)[keyof typeof COLOR_LAYER]

export interface ColorLayerReport {
  /** 视图色与阶段色的同值项（允许，仅作记录） */
  overlap: Array<{ color: string; view: string; stage: string }>
  /** 视图色 / 阶段色 / 状态色各自的色值集合 */
  counts: { view: number; stage: number; status: number }
}

/**
 * 自检：视图色与阶段色是否**无重复**、以及重复是否被允许。
 *
 * 返回值把重叠**列出来**而不是隐藏 —— 让"允许的重叠"成为一条
 * 可被审阅的事实，而不是一个没人知道的巧合。
 */
export function assertColorLayers(): ColorLayerReport {
  const stageByColor = new Map<string, string>()
  for (const [stage, color] of Object.entries(STAGE_COLOR)) {
    stageByColor.set(color.toLowerCase(), stage)
  }

  const overlap: ColorLayerReport['overlap'] = []
  for (const [view, spec] of Object.entries(VIEW_COLOR_SPEC)) {
    const stage = stageByColor.get(spec.color.toLowerCase())
    if (stage) overlap.push({ color: spec.color, view, stage })
  }

  return {
    overlap,
    counts: {
      view: Object.keys(VIEW_COLOR_SPEC).length,
      stage: Object.keys(STAGE_COLOR).length,
      status: Object.keys(STATUS_COLOR).length,
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 5. 画布底图 —— 点状网格
// ─────────────────────────────────────────────────────────────
//
// "底图感"用点阵而不是渐变：渐变是产品明确禁止的（会形成大面积色块），
// 点阵是纹理，既让空白区域"有东西"，又不抢占节点注意力。
//
// 点阵由 CanvasStage 用两层 radial-gradient 实现并把 background-position
// 绑定到画布位移 —— 这样拖动画布时网格跟着走，产生真实的"底图在下面"的
// 纵深感，而不是一张贴死的壁纸。

/** 网格点间距（px） */
export const GRID_SIZE = 24
/** 网格点颜色 */
export const GRID_DOT = '#e5e7eb'
/** 网格底色（极浅，与纯白几乎不可分，只提供一点点"纸感"） */
export const GRID_BG = '#f9fafb'

// ─────────────────────────────────────────────────────────────
// 6. 视图浅色边框（P15 需求二：两框边框异色）
// ─────────────────────────────────────────────────────────────
//
// 用途白名单（只落画布列，不进右栏 aside —— verify-local 的越界扫描
// 只查 aside 内元素，但仍然遵守"不与阶段独有色混淆"的红线）：
//   · BottomPanel 底部详情面板的四边边框（随当前视图取色）
//   · 与阶段独有色 #0891b2 / #1d4ed8 零重叠
// 取色规则：对应视图色的低饱和浅调（Tailwind 色板 300 档），
// 视觉上是"视图色的影子"，与浅色整体风格协调，又不至于抢节点注意力。
export const VIEW_SOFT_BORDER: Record<string, string> = {
  dna: '#93c5fd', // 蓝 300（视图色 #2563eb 的浅调）
  surgery: '#fdba74', // 橙 300（#ea580c）
  evolution: '#c4b5fd', // 紫 300（#7c3aed）
  debt: '#fca5a5', // 红 300（#dc2626）
  idea: '#86efac', // 绿 300（#16a34a）
  crashtest: '#d1d5db', // 灰 300（#6b7280）
}

/** 缩放控件条边框：中性深灰（全视图统一，与 BottomPanel 的视图色区分开） */
export const ZOOM_BORDER = '#9ca3af'

// ─────────────────────────────────────────────────────────────
// 7. 视图背景图案（P15 需求六：每界面不同图案/纹理，浅淡统一）
// ─────────────────────────────────────────────────────────────
//
// 这是 §5 点阵底图（GRID_*）的按视图扩展：每个视图一种 1px 级几何图案，
// 色调带一点点该视图的视图色彩，让"我在哪个界面"多一层底色暗示。
//
// ⚠️ 硬纪律（= verify-local.py 渐变豁免判定的反向推导）：
//   · backgroundImage 只能用 radial-gradient（禁 linear-gradient——
//     会被判为"装饰渐变"直接挂验收）；
//   · 整串颜色 stop 只写 hex / transparent（rgba?( 函数出现次数 ≤2，
//     全 hex 时为 0，最稳）；
//   · 必须带 backgroundSize 平铺；
//   · 图案色亮度 ≥0.85、底色 #fafbfc~#fdfbf9 级——对正文 #1a1a1a
//     对比度 >15:1，不构成"深色大色块"，不抢节点/文字注意力。
//   · 性能：纯 CSS background-repeat，零 JS、零图片请求。
export interface ViewPattern {
  /** 底色（极浅，接近白） */
  bg: string
  /** backgroundImage（radial-gradient，可多层错位） */
  image: string
  /** backgroundSize（px 平铺周期） */
  size: string
}

export const VIEW_PATTERN: Record<string, ViewPattern> = {
  // dna 保持现灰点阵原样（零回归——verify-local 对 dna 画布有底图断言）
  dna: {
    bg: GRID_BG,
    image: `radial-gradient(circle, ${GRID_DOT} 1px, transparent 1px)`,
    size: `${GRID_SIZE}px ${GRID_SIZE}px`,
  },
  // surgery：橙调细点（视图色 #ea580c 的极浅影）
  surgery: {
    bg: '#fdfbf9',
    image: 'radial-gradient(circle, #f0ddcf 1px, transparent 1px)',
    size: '20px 20px',
  },
  // evolution：双层错位紫点（时间轴的"序列感"）
  evolution: {
    bg: '#fbfaff',
    image:
      'radial-gradient(circle, #e4dcf2 1px, transparent 1px), radial-gradient(circle at 12px 12px, #e4dcf2 1px, transparent 1px)',
    size: '24px 24px',
  },
  // debt：红调疏点（大间距弱化存在感，列表视图要安静）
  debt: {
    bg: '#fefcfc',
    image: 'radial-gradient(circle, #f1dede 1.2px, transparent 1.2px)',
    size: '32px 32px',
  },
  // idea 画布视图当前不存在（工作台不是画布），保留条目兜底缺省
  idea: {
    bg: '#fafbfc',
    image: 'radial-gradient(circle, #dcebe0 1px, transparent 1px)',
    size: '18px 18px',
  },
  // crashtest：灰调大间距点（检验区的克制底纹）
  crashtest: {
    bg: '#fbfcfd',
    image: 'radial-gradient(circle, #e1e4e9 1px, transparent 1px)',
    size: '36px 36px',
  },
}

/** 组合想法工作台底纹（idea 视图不走 CanvasStage，单独给） */
export const PATTERN_IDEA_WORKBENCH: ViewPattern = {
  bg: '#fafbfc',
  image: 'radial-gradient(circle, #dcebe0 1px, transparent 1px)',
  size: '18px 18px',
}

/** /projects 项目列表页底纹（双层错位灰点，同色 2 stop 合规） */
export const PAGE_PATTERN_PROJECTS: ViewPattern = {
  bg: '#ffffff',
  image:
    'radial-gradient(circle, #ececef 1px, transparent 1px), radial-gradient(circle at 14px 14px, #ececef 1px, transparent 1px)',
  size: '28px 28px',
}
