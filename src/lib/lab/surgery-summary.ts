/**
 * 手术结果的「一眼看懂」摘要（问题 2）。
 *
 * ── 为什么要重做这一层 ──
 *
 * 原来的详情是「四段式」：对谁动刀 / 失去什么能力 / 影响有多大 / 依据与不确定。
 * 它的信息是够的，但**阅读顺序错了**：用户要先读完四段才知道结论是什么，
 * 而且里面混着大量术语，例如
 *     「依赖风险：没有其他模块声明依赖该模块。」
 * 这句话既不是结论、也不告诉用户"接下来会怎样"，用户看完只知道"没依赖"，
 * 完全无法据此判断这个手术意味着什么。
 *
 * 产品要求是「提炼关键、展示关键、一眼看懂」，所以改成：
 *     一句话结论  →  3 个关键影响  →  证据  →  不确定性
 * 把结论提到最前，影响收敛到 3 条，其余细节折叠到证据/不确定性里。
 *
 * ── 为什么"人话"要靠模板重写，而不是直接把模型输出搬过来 ──
 * 模型（含 mock）产出的是**分析语言**（"块角色"、"消融证据"、"依赖风险"），
 * 那是给研究者看的中间表示。面向"一眼看懂"，必须把它翻译成
 * 「移除 X 后，Y 会失能」这种因果句。这里做的是**翻译**，不是编造 ——
 * 所有事实仍来自 Surgery.result，只是换一种说法。
 */

import type { SurgeryParsed } from './surgery-result'
import { stripInlineMarkers } from './text-clean'

/** 一句话结论 + 最多 3 条关键影响 */
export interface SurgerySummary {
  /** 一句话结论 —— 面板顶部最显眼的那句 */
  headline: string
  /** 结论的严重程度，决定用哪档颜色 */
  severity: 'severe' | 'moderate' | 'minor' | 'unknown'
  /** 最多 3 条关键影响，每条都是人话 */
  keyImpacts: Array<{ text: string; severityLabel: string; severity: string }>
  /** 是否因为证据不足而无法给出确定结论 */
  inconclusive: boolean
  /** 演示模式（mock）时必须显著标注 */
  isMockMode: boolean
}

/** 把「模块名」之外的杂音去掉，用于拼句子 */
function clean(name: string): string {
  return name.replace(/\s+/g, ' ').trim()
}

/**
 * 中英混排时的空格。
 *
 * 模块名常常是英文（"retrieval-augmented generation (RAG)"），
 * 直接拼进中文句子里会变成「移除retrieval-…后」，读起来像粘连。
 * 规则：中文与 ASCII 字母/数字相邻处补一个空格；其余原样。
 * （英文单词之间原有的空格不受影响 —— 本函数只在中文字符旁插空格。）
 */
function pad(name: string): string {
  return name
    .replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, '$1 $2')
}

/**
 * 把「依赖风险」这句术语翻译成后果句。
 *
 * 例：
 *   原文  "没有其他模块声明依赖该模块。"
 *   译后  "移除它不会连带破坏其他模块 —— 但也没有下游模块会因此受益。"
 *
 *   原文  "该模块被 A、B 依赖，移除会影响这些模块。"
 *   译后  "A、B 依赖它；移除后这两个模块会失去输入。"
 */
function humanizeDependencyRisk(risk: string): string | null {
  const r = risk.trim()
  if (!r) return null

  if (/没有其他模块声明依赖|不依赖|无依赖/.test(r)) {
    // 「没有依赖」不是风险，但它确实意味着"这一步很安全"，要说出来
    return '没有其他模块依赖它 —— 移除的连带影响很小。'
  }

  // 尝试从 "该模块被 A、B 依赖，…" 里抠出依赖方名字
  const m = r.match(/被\s*([^，。]+?)\s*依赖/)
  if (m) {
    const names = m[1].replace(/、/g, '、')
    return `${names} 依赖它；移除后这些模块会失去输入，需要另行补上。`
  }

  // 其他形态：去掉「依赖风险：」前缀，原样但要确保是一句人话
  return r.replace(/^依赖风险[:：]\s*/, '')
}

/**
 * 生成「一句话结论」。
 *
 * 优先级（为什么是这个顺序）：
 *   1. 有明确 verdict → 直接用它的语义（这是分析给出的正式判定）
 *   2. 否则用影响里最严重的一条 → 最严重的后果就是结论
 *   3. 都没有 → 老实说"分析没能给出结论"
 */
function buildHeadline(parsed: SurgeryParsed, blockName: string, actionLabel: string): {
  headline: string
  severity: SurgerySummary['severity']
  inconclusive: boolean
} {
  const lost = parsed.lostCapability.trim()
  const severe = parsed.impacts.find((i) => i.severity === 'CRITICAL' || i.severity === 'SEVERE')
  const anyImpact = severe ?? parsed.impacts[0]
  const bn = pad(blockName)

  // 有"失去的能力"就是最直接的结论 —— 它本身就是一句因果
  if (lost) {
    const sev: SurgerySummary['severity'] = severe
      ? severe.severity === 'CRITICAL'
        ? 'severe'
        : 'severe'
      : 'moderate'
    return {
      headline: joinCauseAndEffect(actionLabel, bn, lost),
      severity: sev,
      inconclusive: false,
    }
  }

  /**
   * 问题 3：lost 为空时**不再**退回 impact 的模板句。
   *
   * 旧逻辑是「lost 没有就用第一条 impact」，而 impact 的 effect 里也塞着
   * `方法将失去「<模板文案>」这一功能` —— 相当于换个地方再套一次模板，
   * 结论照样读不通。所以这里显式区分：
   *   · 有 lost            → 用具体功能生成结论；
   *   · 没有 lost 但有 impact → 用 impact（由数据层保证它是人话）；
   *   · 都没有             → 诚实说"无法从当前数据推断"。
   */
  if (anyImpact) {
    return {
      headline: joinCauseAndEffect(actionLabel, bn, anyImpact.effect),
      severity: anyImpact.severity === 'CRITICAL' || anyImpact.severity === 'SEVERE' ? 'severe' : 'moderate',
      inconclusive: false,
    }
  }

  /**
   * 什么都抽不出来 —— 按方案要求给出明确的"无法推断"结论，
   * 并点出原因（缺消融实验），而不是一句含糊的"没能确定"。
   */
  return {
    headline: `移除${bn} 的影响无法从当前数据推断——这篇论文里没有与该模块对应的消融实验，也没有可用的功能描述。`,
    severity: 'unknown',
    inconclusive: true,
  }
}

/**
 * 把「因」和「果」拼成一句不重复的结论。
 *
 * ── 问题 3：为什么不能硬套模板 ──
 *
 * 旧模板是 `${actionLabel}${blockName}后，方法不再具备「${lost}」的能力`。
 * 当 lost 本身是一句模板文案（如「从论文方法描述句中识别出的组件」）时，
 * 结论就变成：
 *     移除 X 后，方法不再具备「【演示推断】从方法描述句中识别出的组件」的能力
 * —— 方括号标记内嵌、读不通、还答非所问。
 *
 * 现在分三种情况，**优先用已经自足的结论，绝不二次包装**：
 *   1. lost 本身是一句完整结论（含"移除…后"或"失去"等因果开头）→ 直接用；
 *   2. lost 是一段"能力/功能"描述 → 套成
 *        「移除 X 后，方法的核心流程会断在这里——因为 X 负责 Y」；
 *   3. lost 为空 → 调用方（buildHeadline）会走"无法推断"分支，不会走到这里。
 *
 * 另外：出口处再跑一次 stripInlineMarkers —— 双保险。即使将来某个字段
 * 又漏进标记，用户也看不到（问题 3 的兜底防线）。
 */
function joinCauseAndEffect(actionLabel: string, blockName: string, lost: string): string {
  const effect = lost.trim()

  // 已经自带"因"的标志词 —— 出现任何一个都说明它本身就是一句完整结论
  const selfContained =
    /^(失去|移除|拿掉|去掉|不再|无法|没有)/.test(effect) || /后[，,]/.test(effect.slice(0, 12))

  if (selfContained) {
    // 把模糊指代换成具体模块名，读者不用回头找"该模块"是谁
    return stripInlineMarkers(
      effect
        .replace(/^(失去)?该模块后[，,]?\s*/, `移除${blockName}后，`)
        .replace(/^(失去)?它后[，,]?\s*/, `移除${blockName}后，`)
    )
  }

  /**
   * ── P10-S3：区分"能力名词短语"与"后果句" ──
   *
   * 走到这里的 lost 有两种，混为一谈会产出病句。
   *
   * 它原来是唯一分支：一律套「…——因为 X 负责 <lost>」。当 lost 是
   * **能力描述**（"从语料库中检索相关段落"）时读得通；
   * 但 buildHeadline 在 lostCapability 为空时会退而用 impacts[0].effect，
   * 那是一条**后果句**（"依赖该模块的下游模块会失去输入"）。
   * 把它塞进"负责…"后面就成了：
   *     移除 X 后，方法的核心流程会断在这里——因为 X 负责依赖该模块的下游模块会失去输入
   * 主谓宾全乱，用户读到的是一句语法错误的结论。
   *
   * 判据：后果句的特征是**自身已经含主语和谓语**（"…会…"、"…将不再具备…"、
   * "…无法…"）。这类句子不需要"负责"这个槽位，直接作为结论陈述即可。
   */
  const looksLikeConsequence =
    /^(依赖|下游|上游|其他|系统|方法|该模块|它)/.test(effect) ||
    /(会|将|不再|无法|失去|丧失|失效|破坏)/.test(effect)

  if (looksLikeConsequence) {
    // 后果句：它本身就是结论，只需点明"移除谁之后"
    return stripInlineMarkers(`移除${blockName}后，${effect.replace(/[。；;]+$/, '')}。`)
  }

  /**
   * 能力名词短语 —— 补一层因果。
   * 用「核心流程会断在这里——因为 X 负责 Y」这个句式：
   *   · 先给结果（流程会断），再给理由（负责什么），符合"结论优先"；
   *   · 破折号把因果分开，比"因为…所以…"更短，面板里一行放得下。
   */
  const capability = effect.replace(/^系统(将)?(会)?/, '方法会').replace(/[。；;]+$/, '')
  return stripInlineMarkers(
    `移除${blockName} 后，方法的核心流程会断在这里——因为${blockName}负责${capability}。`
  )
}

/**
 * 从完整解析结果 → 一眼看懂的摘要。
 *
 * @param parsed  parseSurgeryResult 的输出（调用方保证非 null）
 * @param dataBlockName  兜底用的模块名（result 里可能没带 blockName）
 */
export function buildSurgerySummary(
  parsed: SurgeryParsed,
  dataBlockName?: string
): SurgerySummary {
  const blockName = clean(parsed.blockName || dataBlockName || '这个模块')
  const actionLabel = parsed.actionLabel || '改动'

  const { headline, severity, inconclusive } = buildHeadline(parsed, blockName, actionLabel)

  /**
   * 关键影响只取 3 条。
   *
   * 为什么是 3：面板高度有限，超过 3 条用户不会再读；而且影响之间有主次，
   * 把最重要的 3 条按严重度排出来，信息量已经足够支撑"要不要做这个手术"的判断。
   * 被截掉的条目**不丢** —— 它们仍在「证据」一节里完整列出。
   */
  const keyImpacts = [...parsed.impacts]
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity))
    .slice(0, 3)
    .map((i) => ({ text: i.effect, severityLabel: i.severityLabel, severity: i.severity }))

  return { headline, severity, keyImpacts, inconclusive, isMockMode: parsed.isMockMode }
}

function sevRank(s: string): number {
  switch (s) {
    case 'CRITICAL':
      return 4
    case 'SEVERE':
      return 3
    case 'MODERATE':
      return 2
    case 'MINOR':
      return 1
    default:
      return 0
  }
}

export { humanizeDependencyRisk }
