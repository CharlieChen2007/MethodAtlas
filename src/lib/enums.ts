/**
 * MethodAtlas 应用层枚举
 *
 * SQLite 不支持 Prisma 原生 enum，因此数据库用 String 存储，
 * 这里用 TS 常量 + 联合类型在应用层保证取值合法。
 * 将来迁移到 Postgres 时可改回 Prisma enum。
 */

// ===================== Paper 状态 =====================

export const PaperStatus = {
  UPLOADED: 'UPLOADED',
  PARSED: 'PARSED',
  DNA_EXTRACTED: 'DNA_EXTRACTED',
  FAILED: 'FAILED',
} as const
export type PaperStatus = (typeof PaperStatus)[keyof typeof PaperStatus]

export const PAPER_STATUS_LABEL: Record<PaperStatus, string> = {
  UPLOADED: '已上传',
  PARSED: '已解析',
  DNA_EXTRACTED: '已抽取方法',
  FAILED: '解析失败',
}

export const PAPER_STATUS_COLOR: Record<PaperStatus, string> = {
  UPLOADED: 'bg-slate-100 text-slate-700 border-slate-200',
  PARSED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  DNA_EXTRACTED: 'bg-blue-50 text-blue-700 border-blue-200',
  FAILED: 'bg-red-50 text-red-700 border-red-200',
}

// ===================== Evidence =====================

export const EvidenceSource = {
  PAPER_FACT: 'PAPER_FACT',
  LLM_SYNTHESIS: 'LLM_SYNTHESIS',
  LLM_INFERENCE: 'LLM_INFERENCE',
} as const
export type EvidenceSource = (typeof EvidenceSource)[keyof typeof EvidenceSource]

export const EVIDENCE_SOURCE_LABEL: Record<EvidenceSource, string> = {
  PAPER_FACT: '论文事实',
  LLM_SYNTHESIS: '多论文综合',
  LLM_INFERENCE: '模型推断',
}

/**
 * 证据来源图标。
 *
 * 用几何符号（U+25xx 区）而不是 emoji（📌🔗💭）：
 * 本项目的运行环境（容器 / CI / 无 emoji 字体的 Linux）里，
 * emoji 经常渲染成「豆腐块」方框，一个本应用来表达可信度的标签
 * 变成方框，正好毁掉它要传达的信息。
 * 这些符号在 DejaVu / Noto Sans Symbols 等基础字体里都有覆盖，稳定。
 */
export const EVIDENCE_SOURCE_ICON: Record<EvidenceSource, string> = {
  PAPER_FACT: '◆', // 实心菱形 —— 硬事实
  LLM_SYNTHESIS: '◇', // 空心菱形 —— 综合得来，不如事实硬
  LLM_INFERENCE: '△', // 三角 —— 推断，最需要用户自己判断
}

export const EvidenceStatus = {
  CONFIRMED: 'CONFIRMED',
  UNCERTAIN: 'UNCERTAIN',
  INSUFFICIENT: 'INSUFFICIENT',
} as const
export type EvidenceStatus = (typeof EvidenceStatus)[keyof typeof EvidenceStatus]

export const EVIDENCE_STATUS_LABEL: Record<EvidenceStatus, string> = {
  CONFIRMED: '证据充分',
  UNCERTAIN: '证据有限',
  INSUFFICIENT: '证据不足',
}

export const EVIDENCE_STATUS_COLOR: Record<EvidenceStatus, string> = {
  CONFIRMED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  UNCERTAIN: 'bg-amber-50 text-amber-700 border-amber-200',
  INSUFFICIENT: 'bg-red-50 text-red-700 border-red-200',
}

// ===================== Method Block 类型 =====================

export const BlockType = {
  ENCODER: 'ENCODER',
  DECODER: 'DECODER',
  ATTENTION: 'ATTENTION',
  LOSS: 'LOSS',
  REGULARIZATION: 'REGULARIZATION',
  SAMPLING: 'SAMPLING',
  PRETRAIN: 'PRETRAIN',
  FINETUNE: 'FINETUNE',
  AUGMENTATION: 'AUGMENTATION',
  ARCHITECTURE: 'ARCHITECTURE',
  POSTPROCESS: 'POSTPROCESS',
  OTHER: 'OTHER',
} as const
export type BlockType = (typeof BlockType)[keyof typeof BlockType]

export const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
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
  OTHER: '其他',
}

/** 积木色板：低饱和度科研风，按 Block 类型区分 */
export const BLOCK_TYPE_COLOR: Record<BlockType, string> = {
  ENCODER: 'bg-blue-100 border-blue-300 text-blue-900',
  DECODER: 'bg-indigo-100 border-indigo-300 text-indigo-900',
  ATTENTION: 'bg-violet-100 border-violet-300 text-violet-900',
  LOSS: 'bg-rose-100 border-rose-300 text-rose-900',
  REGULARIZATION: 'bg-amber-100 border-amber-300 text-amber-900',
  SAMPLING: 'bg-cyan-100 border-cyan-300 text-cyan-900',
  PRETRAIN: 'bg-emerald-100 border-emerald-300 text-emerald-900',
  FINETUNE: 'bg-teal-100 border-teal-300 text-teal-900',
  AUGMENTATION: 'bg-orange-100 border-orange-300 text-orange-900',
  ARCHITECTURE: 'bg-slate-200 border-slate-400 text-slate-900',
  POSTPROCESS: 'bg-fuchsia-100 border-fuchsia-300 text-fuchsia-900',
  OTHER: 'bg-gray-100 border-gray-300 text-gray-800',
}

// ===================== Method Stage（方法阶段，P7-0） =====================
//
// 用于把 MethodBlock 挂到方法流程的正确位置上，是绘制方法结构图的前提。
// 依据是**论文章节顺序**这类可可靠读出的信息；不依赖 dependencies
// （该字段当前无数据支撑，且不主张靠 LLM 猜测填充）。
// 数组顺序即流程顺序，绘制结构图时应按此顺序排列阶段。

export const METHOD_STAGE_ORDER = [
  'PROBLEM',
  'INPUT',
  'PREPROCESSING',
  'CORE_METHOD',
  'TRAINING',
  'INFERENCE',
  'EVALUATION',
] as const

export const MethodStage = {
  PROBLEM: 'PROBLEM',
  INPUT: 'INPUT',
  PREPROCESSING: 'PREPROCESSING',
  CORE_METHOD: 'CORE_METHOD',
  TRAINING: 'TRAINING',
  INFERENCE: 'INFERENCE',
  EVALUATION: 'EVALUATION',
} as const
export type MethodStage = (typeof MethodStage)[keyof typeof MethodStage]

export const METHOD_STAGE_LABEL: Record<MethodStage, string> = {
  PROBLEM: '问题',
  INPUT: '输入',
  PREPROCESSING: '预处理',
  CORE_METHOD: '核心方法',
  TRAINING: '训练',
  INFERENCE: '推理',
  EVALUATION: '评估',
}

/** 阶段的实际含义，用于结构图节点的补充说明 */
export const METHOD_STAGE_HINT: Record<MethodStage, string> = {
  PROBLEM: '这篇论文要解决什么',
  INPUT: '输入是什么',
  PREPROCESSING: '输入如何被处理',
  CORE_METHOD: '核心方法（视觉重心）',
  TRAINING: '如何训练',
  INFERENCE: '如何推理',
  EVALUATION: '如何评估 / 在什么数据上评估',
}

/**
 * 把任意字符串规整为合法的 MethodStage。
 * 非法值（含空值）退化为 CORE_METHOD —— 与 schema 默认值保持一致，
 * 避免因抽取噪声把模块丢到未知阶段而在结构图中消失。
 */
export function normalizeMethodStage(raw: string | null | undefined): MethodStage {
  const upper = (raw ?? '').toString().trim().toUpperCase().replace(/[\s-]+/g, '_')
  return (METHOD_STAGE_ORDER as readonly string[]).includes(upper)
    ? (upper as MethodStage)
    : MethodStage.CORE_METHOD
}

// ===================== Surgery =====================

export const SurgeryAction = {
  REMOVE: 'REMOVE',
  REPLACE: 'REPLACE',
  DISABLE: 'DISABLE',
} as const
export type SurgeryAction = (typeof SurgeryAction)[keyof typeof SurgeryAction]

export const SURGERY_ACTION_LABEL: Record<SurgeryAction, string> = {
  REMOVE: '移除',
  REPLACE: '替换',
  DISABLE: '禁用',
}

export const SurgeryVerdict = {
  PLAUSIBLE: 'PLAUSIBLE',
  RISKY: 'RISKY',
  INFEASIBLE: 'INFEASIBLE',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
} as const
export type SurgeryVerdict = (typeof SurgeryVerdict)[keyof typeof SurgeryVerdict]

export const SURGERY_VERDICT_LABEL: Record<SurgeryVerdict, string> = {
  PLAUSIBLE: '可行',
  RISKY: '有风险',
  INFEASIBLE: '不可行',
  INSUFFICIENT_EVIDENCE: '证据不足',
}

export const SURGERY_VERDICT_COLOR: Record<SurgeryVerdict, string> = {
  PLAUSIBLE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  RISKY: 'bg-amber-50 text-amber-700 border-amber-200',
  INFEASIBLE: 'bg-red-50 text-red-700 border-red-200',
  INSUFFICIENT_EVIDENCE: 'bg-slate-100 text-slate-600 border-slate-300',
}

/** 影响强度：NONE | MINOR | MODERATE | SEVERE | CRITICAL */
export const IMPACT_SEVERITY_LABEL: Record<string, string> = {
  NONE: '无影响',
  MINOR: '轻微',
  MODERATE: '中等',
  SEVERE: '严重',
  CRITICAL: '致命',
}

export const IMPACT_SEVERITY_COLOR: Record<string, string> = {
  NONE: 'bg-slate-100 text-slate-600 border-slate-200',
  MINOR: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  MODERATE: 'bg-amber-50 text-amber-700 border-amber-200',
  SEVERE: 'bg-orange-50 text-orange-700 border-orange-200',
  CRITICAL: 'bg-red-50 text-red-700 border-red-200',
}

// ===================== Evolution =====================

export const RelationType = {
  INHERIT: 'INHERIT',
  IMPROVE: 'IMPROVE',
  REPLACE: 'REPLACE',
  BRANCH: 'BRANCH',
  COMBINE: 'COMBINE',
} as const
export type RelationType = (typeof RelationType)[keyof typeof RelationType]

export const RELATION_TYPE_LABEL: Record<RelationType, string> = {
  INHERIT: '继承',
  IMPROVE: '改进',
  REPLACE: '替换',
  BRANCH: '分支',
  COMBINE: '组合',
}

export const RELATION_TYPE_COLOR: Record<RelationType, string> = {
  INHERIT: 'bg-slate-100 text-slate-700 border-slate-300',
  IMPROVE: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  REPLACE: 'bg-rose-50 text-rose-700 border-rose-300',
  BRANCH: 'bg-violet-50 text-violet-700 border-violet-300',
  COMBINE: 'bg-amber-50 text-amber-700 border-amber-300',
}

// ===================== Research Debt =====================

export const DebtCategory = {
  GENERALIZATION: 'GENERALIZATION',
  COMPUTATION: 'COMPUTATION',
  DATA: 'DATA',
  INTERPRETABILITY: 'INTERPRETABILITY',
  ROBUSTNESS: 'ROBUSTNESS',
  EVALUATION: 'EVALUATION',
  THEORY: 'THEORY',
  OTHER: 'OTHER',
} as const
export type DebtCategory = (typeof DebtCategory)[keyof typeof DebtCategory]

export const DEBT_CATEGORY_LABEL: Record<DebtCategory, string> = {
  GENERALIZATION: '泛化性',
  COMPUTATION: '计算成本',
  DATA: '数据',
  INTERPRETABILITY: '可解释性',
  ROBUSTNESS: '鲁棒性',
  EVALUATION: '评测方法',
  THEORY: '理论保证',
  OTHER: '其他',
}

export const DEBT_CATEGORY_COLOR: Record<DebtCategory, string> = {
  GENERALIZATION: 'bg-blue-50 text-blue-700 border-blue-200',
  COMPUTATION: 'bg-orange-50 text-orange-700 border-orange-200',
  DATA: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  INTERPRETABILITY: 'bg-violet-50 text-violet-700 border-violet-200',
  ROBUSTNESS: 'bg-rose-50 text-rose-700 border-rose-200',
  EVALUATION: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  THEORY: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  OTHER: 'bg-slate-100 text-slate-600 border-slate-200',
}

/** 债务的"跨论文程度"—— 决定它在界面上有多重 */
export const DEBT_SCOPE_LABEL: Record<string, string> = {
  CROSS_PAPER: '跨论文领域债务',
  SINGLE_PAPER: '单篇论文局限',
}

export const DEBT_SCOPE_COLOR: Record<string, string> = {
  CROSS_PAPER: 'bg-red-50 text-red-700 border-red-200',
  SINGLE_PAPER: 'bg-slate-100 text-slate-600 border-slate-300',
}

// ===================== Crash Test 检验等级 =====================

export const FindingLevel = {
  PASS: 'PASS',
  CONCERN: 'CONCERN',
  BLOCKER: 'BLOCKER',
} as const
export type FindingLevel = (typeof FindingLevel)[keyof typeof FindingLevel]

export const FINDING_LEVEL_LABEL: Record<FindingLevel, string> = {
  PASS: '通过',
  CONCERN: '需关注',
  BLOCKER: '致命问题',
}

export const FINDING_LEVEL_COLOR: Record<FindingLevel, string> = {
  PASS: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CONCERN: 'bg-amber-50 text-amber-700 border-amber-200',
  BLOCKER: 'bg-red-50 text-red-700 border-red-200',
}

/** Crash Test 的四个检验维度 */
export const CRASH_TEST_DIMENSIONS = [
  { key: 'noveltyCheck', label: '新颖性检验', hint: '这个想法是不是早就有人做过了' },
  { key: 'blockConflictCheck', label: '模块冲突检验', hint: '被组合的模块机制上是否互相打架' },
  { key: 'dataRequirement', label: '数据可行性', hint: '它需要的数据真的存在、真的拿得到吗' },
  { key: 'computeRequirement', label: '算力可行性', hint: '它需要的算力做得到吗' },
] as const

// ===================== Crash Test Verdict =====================

export const Verdict = {
  PROMISING: 'PROMISING',
  RISKY: 'RISKY',
  LIKELY_EXISTS: 'LIKELY_EXISTS',
  INFEASIBLE: 'INFEASIBLE',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
} as const
export type Verdict = (typeof Verdict)[keyof typeof Verdict]

export const VERDICT_LABEL: Record<Verdict, string> = {
  PROMISING: '有前景',
  RISKY: '有风险',
  /**
   * ── UI ⑤：判定标签也要限定范围 ──
   *
   * 原文案「可能已被做过」读起来像在断言全世界有没有人做过 ——
   * 而系统只比对了**当前收录的论文原文**。改成「收录文献中已见相似方案」，
   * 把依据的范围写进结论本身，与债务视图的「当前收录文献中未见解决」同一口径。
   */
  LIKELY_EXISTS: '收录文献中已见相似方案',
  INFEASIBLE: '不可行',
  INSUFFICIENT_EVIDENCE: '证据不足',
}

export const VERDICT_COLOR: Record<Verdict, string> = {
  PROMISING: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  RISKY: 'bg-amber-50 text-amber-700 border-amber-200',
  LIKELY_EXISTS: 'bg-orange-50 text-orange-700 border-orange-200',
  INFEASIBLE: 'bg-red-50 text-red-700 border-red-200',
  INSUFFICIENT_EVIDENCE: 'bg-slate-100 text-slate-600 border-slate-200',
}

// ===================== JSON 安全解析工具 =====================
// SQLite 不支持 Json 类型，结构化字段以字符串存储，这里统一解析入口。

export function parseJsonArray<T = unknown>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

export function parseJsonObject<T = Record<string, unknown>>(
  raw: string | null | undefined
): T | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as T) : null
  } catch {
    return null
  }
}
