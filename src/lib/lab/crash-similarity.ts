import type { IdeaView } from '@/lib/view-models'

/**
 * 击穿想法相似度色阶（P15 需求五）—— 纯函数、零 IO、零模型调用。
 *
 * ── 需求口径 ──
 *
 *   "想法越相似，方框颜色越接近；差异越大，颜色差距越明显。
 *    颜色映射基于已有 Crash Test 结果计算，不新增分析链路。"
 *
 * 数据原料只有 CrashTestView（跑击穿时模型已产出的结果）：
 *   · 6 维检查向量的 level（dimsOf —— 自 CrashComparePanel 迁移而来，
 *     单一口径：PASS=0 / UNKNOWN=1 / CONCERN=2 / BLOCKER=3）；
 *   · 未测的想法不参与（没有结果就没有相似度可言）。
 *
 * ── 算法（可验证的 1D 色相轴）──
 *
 *   1. 每个已测想法 → 6 维数值向量（缺维度记 UNKNOWN=1）；
 *   2. 两两曼哈顿距离 dist(a,b) = Σ|v[a][d] − v[b][d]| ∈ [0, 18]；
 *   3. 取"最异类"的想法（到其他所有想法距离之和最大者）作轴锚；
 *   4. 每个想法的轴坐标 axis(t) = dist(t, anchor)；
 *   5. 色相 hue = 200 + 140 × axis/maxAxis（青蓝 200° → 粉紫 340°）。
 *
 * 为什么用 1D 轴而不是把距离矩阵完整嵌入色环：想法数 N ≤ 6，
 * 任意距离结构无法在色环上无损保距；1D 轴保证"轴上相邻 ⇔ 色相相邻"，
 * 而"与锚点相似 ⇔ 色相接近锚点色"——验收可以直接用 pairDist
 * 复算单调性（一档差的色相差 < 多档差的色相差）。
 *
 * ── 色域归属 ──
 *
 * 相似度色不入 palette 的视图/阶段/状态三域：它是"分析结果呈现色"，
 * 色值由本文件公式生成、不枚举。色相段 [200°, 340°] 刻意避开
 * LEVEL 语义四色（绿≈145° / 琬珀≈35° / 红≈0° / 灰无色相），
 * 两套颜色同屏时不会互相误读。
 */

/** level → 数值（与差异分计算共用一份口径） */
export const LEVEL_SCORE: Record<string, number> = {
  PASS: 0,
  UNKNOWN: 1,
  CONCERN: 2,
  BLOCKER: 3,
}

/** 6 个维度定义：key 与 CrashTestView.checks + 2 项补充一致 */
export const DIMENSIONS: Array<{ key: string; label: string; diffLabel: string }> = [
  { key: 'noveltyCheck', label: '新颖性', diffLabel: '新颖性差距' },
  { key: 'blockConflictCheck', label: '模块冲突', diffLabel: '技术风险差距' },
  { key: 'dataRequirement', label: '数据需求', diffLabel: '数据需求差距' },
  { key: 'computeRequirement', label: '算力需求', diffLabel: '成本差距（算力）' },
  { key: 'experimentalDesign', label: '实验设计', diffLabel: '实验设计差距' },
  { key: 'fatalFlaws', label: '致命弱点', diffLabel: '致命弱点差距' },
]

/** 从一个想法的 CrashTestView 取 6 维度的 level + 文本 */
export function dimsOf(idea: IdeaView): Record<string, { level: string; text: string }> {
  const out: Record<string, { level: string; text: string }> = {}
  const ct = idea.crashTest
  if (!ct) return out
  for (const c of ct.checks) {
    out[c.key] = { level: c.level, text: c.finding || c.detail || '' }
  }
  out.experimentalDesign = {
    level: ct.experimentalDesign?.trim() ? 'PASS' : 'UNKNOWN',
    text: ct.experimentalDesign?.trim() ? ct.experimentalDesign.slice(0, 120) : '',
  }
  out.fatalFlaws = {
    level: ct.fatalFlaws.length > 0 ? 'BLOCKER' : 'PASS',
    text: ct.fatalFlaws.join('；'),
  }
  return out
}

export interface SimilarityResult {
  /** 已测想法 id → 相似度色（hex）。未测想法不出现在映射里 */
  colorOf: Record<string, string>
  /** "idA|idB"（字典序）→ 曼哈顿距离（验收复算单调性用） */
  pairDist: Record<string, number>
  /** 色相轴排序后的已测 ideaId 序列（相似 ⇒ 相邻 ⇒ 色近） */
  order: string[]
}

/** 相似度色统一饱和度/亮度：中等饱和、中等明度，浅色界面上清晰且不刺眼 */
const SIM_S = 62
const SIM_L = 46
/** 色相轴范围：青蓝 200° → 粉紫 340° */
const HUE_MIN = 200
const HUE_SPAN = 140
/** 全同距/单想法时的兜底色相 */
const HUE_FALLBACK = 260

/** hsl → hex（文件内私有工具，十来行，不引依赖） */
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100
  const ln = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = sn * Math.min(ln, 1 - ln)
  const f = (n: number) => {
    const v = ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
    return Math.round(255 * v)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/**
 * 计算已测想法的相似度色。输入全部想法（内部过滤已测者），
 * 输出 colorOf 映射 + 两两距离 + 轴序（组件落色与验收脚本共用）。
 */
export function computeIdeaColors(ideas: IdeaView[]): SimilarityResult {
  const tested = ideas.filter((i) => i.crashTest != null)

  // 1. 6 维数值向量（缺维度记 UNKNOWN=1，与差异分的缺省一致）
  const vec = new Map<string, number[]>()
  for (const t of tested) {
    const dims = dimsOf(t)
    vec.set(
      t.id,
      DIMENSIONS.map((d) => {
        const lv = dims[d.key]?.level
        return lv != null ? (LEVEL_SCORE[lv] ?? 1) : 1
      }),
    )
  }

  // 2. 两两曼哈顿距离
  const pairDist: Record<string, number> = {}
  const dist = (a: string, b: string): number => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (key in pairDist) return pairDist[key]
    const va = vec.get(a)!
    const vb = vec.get(b)!
    let sum = 0
    for (let i = 0; i < va.length; i++) sum += Math.abs(va[i] - vb[i])
    pairDist[key] = sum
    return sum
  }
  for (let i = 0; i < tested.length; i++) {
    for (let j = i + 1; j < tested.length; j++) {
      dist(tested[i].id, tested[j].id)
    }
  }

  const colorOf: Record<string, string> = {}

  // 3. 单想法 / 全同距：所有想法同一个色（无所谓"相似度梯度"）
  const ids = tested.map((t) => t.id)
  if (ids.length <= 1) {
    if (ids.length === 1) colorOf[ids[0]] = hslToHex(HUE_FALLBACK, SIM_S, SIM_L)
    return { colorOf, pairDist, order: ids }
  }

  // 4. 轴锚 = 到其他想法距离之和最大者（最"异类"）
  let anchor = ids[0]
  let bestSum = -1
  for (const a of ids) {
    let sum = 0
    for (const b of ids) if (b !== a) sum += dist(a, b)
    if (sum > bestSum) {
      bestSum = sum
      anchor = a
    }
  }

  // 5. 轴坐标 + 归一化色相
  const axis = new Map<string, number>(ids.map((id) => [id, dist(id, anchor)]))
  const maxAxis = Math.max(...Array.from(axis.values()))
  const order = [...ids].sort((a, b) => axis.get(a)! - axis.get(b)!)
  for (const id of ids) {
    const hue = maxAxis === 0 ? HUE_FALLBACK : HUE_MIN + (HUE_SPAN * axis.get(id)!) / maxAxis
    colorOf[id] = hslToHex(hue, SIM_S, SIM_L)
  }

  return { colorOf, pairDist, order }
}
