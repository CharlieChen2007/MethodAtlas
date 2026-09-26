/**
 * 「问题」视角下的研究债务（问题 3）。
 *
 * ── 为什么要单独一层 ──
 *
 * 问题 3 把「方法演化」从「A → B 的抽象关系」改成「按问题组织」：
 *   卡片标题 = 问题名（就是 ResearchDebt）
 *   副标题   = 多篇论文在这条问题上的演进脉络
 *   详情     = 问题是什么 → 每篇怎么处理 → 状态 → 证据
 *
 * 其中「状态（已解决 / 部分解决 / 未解决）」**不是数据库里现成的字段**，
 * 而是从已有事实推导出来的：
 *   - ResearchDebt.currentStatus 是自由文本（如"未见明确解决"）
 *   - 每条 Attempt 的 outcome 是自由文本（"成功/部分成功/失败/引入新问题/未说明"）
 *
 * 这个推导被**两处**消费（卡片副标题、面板详情），如果各写一份，
 * 极易出现"卡片说未解决、面板说部分解决"的矛盾。所以收敛成这一个纯函数。
 *
 * ── 判定规则（保守，不美化）──
 *
 *   有 attempt 明确"成功"                     → 已解决
 *   有 attempt "部分成功"                      → 部分解决
 *   所有 attempt 都"失败"/"引入新问题"          → 未解决
 *   有 attempt 但 outcome 说不清（"未说明"等）  → 部分解决（做了但没结论）
 *   没有任何 attempt（只有"提及"）              → 指出问题（问题 5 新增档）
 *
 * 为什么"没有 attempt"要单独给「指出问题」而不是并进"未解决"：
 *   这正是研究债务的核心含义 —— 问题被反复提出（occurrenceCount ≥ 2）却
 *   无人尝试解决。把它和"试过但失败"混在一起，会掩盖"这个坑还没人跳"这个
 *   最有价值的信号。
 */

import type { DebtView } from '@/lib/view-models'

/**
 * 问题状态 —— 已解决 / 部分解决 / 未解决 / 指出问题
 *
 * ── 问题 5 新增 `points_out` 档 ──
 *
 * 原来是三档。但实测发现有一类问题和"未解决"语义不同：
 * 论文只是**指出了**这个问题值得研究（自己没动手、也没数据），
 * 这类被塞进"未解决"里，会让用户误以为"有人试过但失败了"。
 * 产品要求演化卡片给的是"一眼看懂的状态标签"，所以把这类单独拆出来。
 */
export type ProblemStatus = 'solved' | 'partial' | 'open' | 'points_out'

export interface ProblemStatusInfo {
  status: ProblemStatus
  /** 中文标签 */
  label: string
  /** 为什么是这个状态（一句话，人话） */
  reason: string
}

const STATUS_LABEL: Record<ProblemStatus, string> = {
  solved: '已解决',
  partial: '部分解决',
  open: '未解决',
  points_out: '指出问题',
}

export function deriveProblemStatus(debt: DebtView): ProblemStatusInfo {
  const attempts = debt.attempts ?? []

  /**
   * ── 问题 5：区分「指出问题」和「未解决」──
   *
   * attempts 为空时不能一律判"未解决"：
   *   · sources 里只有"提及"（context 是描述这个问题的句子）→ 论文只是**指出**了问题
   *   · 连 attempts 都没有、且 sources 也很少      → 这类更接近"点了个题"
   * 两者对用户的含义完全不同：前者是"这个坑有人看到过但没人跳进去"，
   * 后者才是"有人跳过、摔了"。旧实现把两者混成"未解决"，掩盖了这个区别。
   *
   * 判定依据来自数据本身：attempts 是"真的动手了"的证据，
   * 只要 attempts 为空，无论 sources 多少，都还没人真正尝试解决 —— 判「指出问题」。
   */
  if (attempts.length === 0) {
    const raisers = debt.occurrenceCount || debt.sources.length
    return {
      status: 'points_out',
      label: STATUS_LABEL.points_out,
      // UI ⑤：把结论限定在"当前收录文献"范围内（这些数来自本项目的论文，
      // 不能外推成"全世界都没人解决"）
      reason: `当前收录文献中有 ${raisers} 篇论文都指出了这个问题，但都没有动手解决。`,
    }
  }

  const outcomes = attempts.map((a) => a.outcome || '')

  const hasSuccess = outcomes.some((o) => /成功/.test(o) && !/部分成功/.test(o))
  const hasPartial = outcomes.some((o) => /部分成功/.test(o))
  const allFailed = outcomes.every((o) => /失败|引入新问题/.test(o))
  const allUnclear = outcomes.every((o) => !o.trim() || /未说明|未知|不清楚/.test(o))

  if (hasSuccess && !hasPartial) {
    return {
      status: 'solved',
      label: STATUS_LABEL.solved,
      reason: '已有论文给出明确可行的解法。',
    }
  }
  if (hasSuccess || hasPartial) {
    return {
      status: 'partial',
      label: STATUS_LABEL.partial,
      reason: '收录文献中有论文取得部分进展，但问题没有被完全解决。',
    }
  }
  if (allFailed) {
    return {
      status: 'open',
      label: STATUS_LABEL.open,
      reason: '收录文献中有论文尝试过，但都失败或引入了新问题。',
    }
  }
  if (allUnclear) {
    return {
      status: 'partial',
      label: STATUS_LABEL.partial,
      reason: '有论文触及了这个问题，但没有说清楚结果如何。',
    }
  }

  // 兜底：有 attempt 但状态混杂，按"还没定论"处理（不夸大进展）
  return {
    status: 'partial',
    label: STATUS_LABEL.partial,
    reason: '已有相关尝试，但整体进展尚不明确。',
  }
}

/**
 * 演进脉络副标题 —— 形如「3 篇论文 → 部分解决」。
 *
 * 为什么不显示 "A → B → C" 这种论文链：问题 3 明确要求**不显示抽象关系**，
 * 要的是"这条问题在几篇论文之间如何演进"。所以副标题给的是
 * **问题维度的概览**（涉及几篇 / 现在到哪一步），而不是论文之间的箭头。
 */
export function buildEvolutionSubtitle(debt: DebtView): string {
  const info = deriveProblemStatus(debt)
  const n = debt.occurrenceCount || debt.sources.length
  return `${n} 篇论文 · ${info.label}`
}

/**
 * ── 问题 5：把问题描述压成一句话 ──
 *
 * 产品要求：演化卡片不该贴一段原文，用户扫一眼要拿到 80% 的信息。
 *
 * 为什么不直接把 `description` 截断到 N 个字：
 *   原文常常是"多句 + 论文引用标记 + 分号列举"，硬截断会断在句子中间，
 *   读起来比不截还累。这里做的是**取第一句完整的话**（按中文/英文句末
 *   标点切分），并在超长时按词边界收尾。
 *
 * 为什么保留原文可查：`description` 原封不动进了面板的「查看证据」路径，
 * 卡片上只放提炼句 —— 想要细节的用户点进去就能看到全文。
 */
export function summarizeProblem(debt: DebtView, maxLen = 60): string {
  const raw = (debt.description || debt.currentStatus || debt.title || '').trim()
  if (!raw) return debt.title

  // 剥掉常见的论文引用标记（[12] / (Smith et al., 2020) / 【1】），
  // 它们对"读懂这句话"没有帮助，只会占宽
  let cleaned = raw
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
    .replace(/【\d+】/g, '')
    .replace(/\((?:[A-Z][a-zA-Z.\-]+(?:\s+et\s+al\.?)?,?\s*\d{4}[a-z]?)\)/g, '')
    /**
     * 先剥掉「演示模式…」这类**整句内部说明**。
     * 它们常常跟在正文句后面，如果先做"取第一句"就会原样留下 ——
     * 实测踩过：剥离论文清单后，剩下的第一句正好是这句说明，
     * 于是卡片上显示的是"演示模式仅按关键词归类…"，而真正的问题描述没了。
     * 这里与 panel 出口的 stripInlineMarkers 保持同一套语义。
     */
    .replace(/(?:^|(?<=[。；;！!？?\n]))\s*演示模式[^。；;！!？?\n]*[。；;！!？?]?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  /**
   * ── 剥掉「论文清单」这个数据噪音 ──
   *
   * 债务描述是自动合成的，形态常是
   *   「3 篇论文都在不同程度上承认了这一问题：《A》、《B》、《C》。<真正的问题句>」
   * 对用户来说，前半段只是"有几篇论文提到"，没有任何信息量，
   * 却把真正的问题句挤出了卡片可视范围（实测就发生了这件事）。
   * 所以把「…《…》…」这段整块删掉，让真正的问题句浮上来。
   *
   * ⚠️ 只在**确实删掉了东西、且删完还有内容**时才采用新串 ——
   *   否则遇到"整段都是论文清单"的描述会被清成空字符串，
   *   卡片就没内容了。那样宁可保留原句。
   */
  const stripped = cleaned.replace(/^[^《]{0,40}《[^》]*》(?:\s*[、，,]?\s*《[^》]*》)*\s*[。；;]?\s*/, '')
  if (stripped.trim().length >= 8) {
    cleaned = stripped.trim()
  } else {
    /**
     * 整段都是论文清单（剥离后没剩内容）—— 说明这条描述**本身没有实质信息**。
     * 此时不要再把清单一串打印出来占满卡片，直接回退到问题标题：
     * 标题（如"计算开销与可扩展性"）已经是一句能读懂的结论，比如清单有用得多。
     */
    return debt.title
  }

  // 取第一句完整的话（中英文句末标点都认）
  const m = cleaned.match(/[^。；;！!？?]+[。；;！!？?]?/)
  let one = (m ? m[0] : cleaned).trim()

  // 去掉句末标点，让卡片上更干净（卡片本身就是"一句话"的位置）
  one = one.replace(/[。；;！!？?、,，]+$/, '')

  if (one.length <= maxLen) return one

  // 超长 → 按标点/空格边界收，尽量不断在词中间
  const cut = one.slice(0, maxLen)
  const lastBreak = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf(' '))
  const body = lastBreak > maxLen * 0.6 ? cut.slice(0, lastBreak) : cut
  return `${body}…`
}

export { STATUS_LABEL as PROBLEM_STATUS_LABEL }
