/**
 * 手术结果的「四段式」解析（纯函数，容错）。
 *
 * 为什么需要一层解析：
 *   `Surgery.result` 在库里是一个 JSON 字符串（schema 注释写的是
 *   "结构化输出（预期影响、不确定性、相关证据）"），但面板最初只是把
 *   原始串 `JSON.stringify` 之后直接印出来 —— 用户看到的是一大坨
 *   `{"blockRole":"...","impacts":[...]}`，完全没有可读性。
 *
 *   数据其实是够的（blockRole / lostCapability / impacts[] /
 *   ablationEvidenceIds / dependencyRisk / verdictReason / uncertainties），
 *   缺的只是"把 JSON 翻译成四段可读的话"。
 *
 * 为什么要容错：
 *   1. result 可为 null（schema 可空）—— 旧记录或中断的写入
 *   2. 旧版本写入的 JSON 字段名可能不同（例如还没加 ablationEvidenceIds）
 *   3. 手工改库 / 迁移残留可能让 result 根本不是合法 JSON
 *   任何一种情况都不该让面板崩掉或显示 `[object Object]`。
 *   解析失败时返回 `null`，由调用方回退到"展示原始文本"这条降级路径。
 *
 * 段落设计（对齐方法的真实推理链，不是随便切四段）：
 *   这一段是"对谁动刀"     → 操作对象
 *   这一段是"失去什么"     → 能力损失
 *   这一段是"影响有多大"   → 逐条影响（带强度分级）
 *   这一段是"依据与不确定" → 证据 / 依赖风险 / 判定理由 / 不确定项
 */

export interface SurgeryImpact {
  effect: string
  severity: string
  severityLabel: string
  rationale: string
  /** 关联证据 id（可能为空 —— 找不到依据时服务端会留空并在 uncertainties 说明） */
  evidenceIds: string[]
}

export interface SurgeryParsed {
  /** 操作对象的模块名（可能缺省） */
  blockName?: string
  /** 操作动作（REMOVE / REPLACE / DISABLE） */
  action?: string
  /** 操作动作的英文原文（兜底显示） */
  actionLabel?: string
  /** 第一段：该模块在原方法中承担什么作用 */
  blockRole: string
  /** 第二段：移除后系统失去什么能力 */
  lostCapability: string
  /** 第三段：逐条影响 */
  impacts: SurgeryImpact[]
  /** 第四段之一：依赖风险 */
  dependencyRisk: string
  /** 第四段之二：是否有直接消融证据 */
  hasDirectAblation: boolean
  /** 第四段之二：消融证据 id */
  ablationEvidenceIds: string[]
  /** 第四段之三：判定理由 */
  verdictReason: string
  /** 第四段之四：不确定项 */
  uncertainties: string[]
  /** 是否是演示模式写入的（UI 必须显著标注） */
  isMockMode: boolean
  /** 明确声明这是模拟分析而非实验结论 */
  disclaimer?: string
}

/** 影响强度 → 中文（与 enums.IMPACT_SEVERITY_LABEL 同口径，这里不复用是为了保持纯函数无依赖） */
const SEVERITY_LABEL: Record<string, string> = {
  NONE: '无影响',
  MINOR: '轻微',
  MODERATE: '中等',
  SEVERE: '严重',
  CRITICAL: '致命',
}

/** 操作动作 → 中文 */
const ACTION_LABEL: Record<string, string> = {
  REMOVE: '移除',
  REPLACE: '替换',
  DISABLE: '禁用',
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

/**
 * 解析 `Surgery.result`。
 *
 * @param raw   库里取出的 JSON 字符串（可能为 null / 非法）
 * @returns     解析成功返回结构化结果；无法解析返回 null（调用方回退到原文）
 */
export function parseSurgeryResult(raw: string | null | undefined): SurgeryParsed | null {
  if (!raw || typeof raw !== 'string') return null

  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    // JSON 合法但不是对象（如 "null" / "[]" / "123"）同样视为不可解析
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    obj = parsed as Record<string, unknown>
  } catch {
    return null
  }

  // 逐条影响：字段名按当前写入格式，缺失即跳过；强度做归一化
  const rawImpacts = Array.isArray(obj.impacts) ? obj.impacts : []
  const impacts: SurgeryImpact[] = rawImpacts
    .map((it): SurgeryImpact | null => {
      if (!it || typeof it !== 'object') return null
      const o = it as Record<string, unknown>
      const effect = asString(o.effect)
      if (!effect) return null
      const severity = asString(o.severity).toUpperCase() || 'MODERATE'
      return {
        effect,
        severity,
        severityLabel: SEVERITY_LABEL[severity] ?? severity,
        rationale: asString(o.rationale),
        evidenceIds: asStringArray(o.evidenceIds),
      }
    })
    .filter((x): x is SurgeryImpact => Boolean(x))

  const action = asString(obj.action).toUpperCase()

  return {
    blockName: asString(obj.blockName) || undefined,
    action: action || undefined,
    actionLabel: action ? ACTION_LABEL[action] ?? action : undefined,
    blockRole: asString(obj.blockRole),
    lostCapability: asString(obj.lostCapability),
    impacts,
    dependencyRisk: asString(obj.dependencyRisk),
    hasDirectAblation: Boolean(obj.hasDirectAblation),
    ablationEvidenceIds: asStringArray(obj.ablationEvidenceIds),
    verdictReason: asString(obj.verdictReason),
    uncertainties: asStringArray(obj.uncertainties),
    isMockMode: Boolean(obj.isMockMode),
    disclaimer: asString(obj.disclaimer) || undefined,
  }
}

/**
 * 「四段式」段落标题 —— 面板按这个顺序渲染。
 *
 * 定义在这里而不是组件里：验证脚本与报告都要引用同一套标题，
 * 分散写会出现"报告里叫这个、面板里叫那个"。
 */
export const SURGERY_SECTION_TITLES = {
  target: '一、对谁动刀',
  lost: '二、失去什么能力',
  impacts: '三、影响有多大',
  basis: '四、依据与不确定',
} as const
