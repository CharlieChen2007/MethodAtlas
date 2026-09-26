/**
 * 击穿测试的「给结论」层（问题 5）。
 *
 * ── 为什么要重做这一层 ──
 *
 * 原来的击穿测试面板是把模型的原始检查项**原样贴出来**：
 *     「演示模式无法检索新颖性」 / 「演示模式无法判断模块之间是否存在机制冲突」
 *     / 「演示模式不具备检索与机制推理能力，无法对这一项做出真实判断。」
 *
 * 用户的反馈很直接：**这是给我报错，不是给我结论。**
 * 问题不在于模型说了"无法判断"——那是诚实；问题在于：
 *   1. 每一项都停在"无法判断"，用户读完不知道自己到底该做什么；
 *   2. 没有"通过 / 警告 / 失败"这样的**一眼可判别**的档位，
 *      用户得自己从一堆文字里推断这项到底过没过；
 *   3. 没有**修改建议** —— 就算失败了，用户也不知道怎么救；
 *   4. 最后没有一个**总体判定**，用户看完不知道"这个想法我到底该不该做"。
 *
 * 产品要求（原话）：
 *   > 每项给 通过/警告/失败 + 一句话理由 + 修改建议；
 *   > 末尾总体判定 可行/需要调整/不建议做；mock 模式也给诚实判定。
 *
 * 所以本模块做三件事：
 *   ① 把 level(PASS/CONCERN/BLOCKER) 映射成 通过/警告/失败（带颜色档）；
 *   ② 为每一项配一句"人话理由" + 一条"怎么改"的建议；
 *   ③ 汇总成一个总体判定：可行 / 需要调整 / 不建议做。
 *
 * ── P10 Step2：改法从"查静态表"改成"优先读模型输出" ──
 *
 * P9 修掉的是"结论通过却让你改模块"的逻辑矛盾（表不再无视 outcome）。
 * 但改法**内容**仍是人工写死的通用句 —— 对任何触发同一档位的方案，
 * 用户拿到的都是同一句。而模型在写 detail 时已经分析过这个方案的
 * 具体模块组合，让它顺手写改法，才能落到"哪两个模块、哪一环、插什么"。
 *
 * 所以 `suggestionFor` 现在是三级回落：
 *   门控(pass/unknown → null) → 模型给的 → 静态表 → 兜底文案
 * 静态表**降级为兜底**，mock 模式和历史数据仍由它托住，不会退化。
 *
 * ── 关键约束：mock 模式必须给**诚实**判定 ──
 *
 * "诚实"不等于"给一个好看的结论"，也不等于"全都说无法判断"。
 * 对演示模式来说，诚实的判定是：**"需要调整"** ——
 * 因为结构性检查是真实做了的（模块是否跨论文），
 * 而结论性检查确实没做（没有检索能力）。既不能吹成"可行"，
 * 也不该因为"没查"就判"不建议做"（那是另一种撒谎：假装查出了致命问题）。
 * 所以演示模式统一落在"需要调整"，并明确写出"改哪一步能让判定变可靠"。
 */

import type { CrashCheckView, CrashTestView } from '@/lib/view-models'
import { VERDICT_LABEL } from '@/lib/enums'

/** 单条检查的"一眼可判别"档位 —— 通过 / 需要调整 / 无法判断 / 失败 */
export type CheckOutcome = 'pass' | 'warn' | 'unknown' | 'fail'

/** 总体判定 —— 直接对应 可行/需要调整/不建议做 */
export type OverallOutcome = 'go' | 'adjust' | 'stop'

export interface CrashCheckConclusion {
  key: string
  label: string
  /** 通过 / 需要调整 / 无法判断 / 失败 */
  outcome: CheckOutcome
  outcomeLabel: string
  /** 一句话理由（人话，不是模型腔） */
  reason: string
  /**
   * 针对性改法。
   *
   * ── P9 问题 5：这里是 `string | null`，不再是"每条都给" ──
   *
   * 旧实现是「按 key 查一张静态表」，命中就返回 —— **完全不看 outcome**。
   * 结果就是用户看到的那条逻辑矛盾：模块冲突结论是「通过」，
   * 下面却挂着「换掉冲突的那个模块」。
   *
   * 现在：
   *   · `pass` / `unknown` → `null`（通过的不需要改；没查的给不出针对性改法）
   *   · `warn` / `fail`   → 具体改法，且**按「检查项 × 档位」二维决定**
   *   · 说不出针对性改法时 → 返回 `NO_SPECIFIC_SUGGESTION`，不硬套模板
   */
  suggestion: string | null
}

export interface CrashConclusion {
  /** 每项检查的结论 */
  checks: CrashCheckConclusion[]
  /** 末尾总体判定 */
  overall: {
    outcome: OverallOutcome
    label: string
    /** 一句话说清为什么是这个判定 */
    reason: string
    /** 下一步该做什么（跨所有检查汇总） */
    nextSteps: string[]
  }
  /** 各项计数，用于卡片上的 N 通过 / N 警告 / N 失败 */
  counts: { pass: number; warn: number; unknown: number; fail: number }
  /** 是否是演示模式写入的（判定必须显著标注） */
  isMockMode: boolean
}

const LEVEL_TO_OUTCOME: Record<string, CheckOutcome> = {
  PASS: 'pass',
  CONCERN: 'warn',
  BLOCKER: 'fail',
  /**
   * ── 问题 8：UNKNOWN 是独立的第四档 ──
   *
   * 它和 CONCERN（"检查做了，发现要调整"）语义完全不同：
   * UNKNOWN 是"这一项**没查**"。把它混进 CONCERN 会让用户以为
   * "系统查过了、有点问题" —— 而事实是"系统没查"。
   * 单开一档，卡片上直接写「无法判断」，诚实且不含糊。
   */
  UNKNOWN: 'unknown',
}

const OUTCOME_LABEL: Record<CheckOutcome, string> = {
  pass: '通过',
  warn: '需要调整',
  unknown: '无法判断',
  fail: '不通过',
}

/**
 * 改法：**只在「需要调整」和「不通过」时给**，且必须针对这一项的具体结论。
 *
 * ── 为什么原来的静态表是错的（P9 问题 5）──
 *
 * 旧实现是 `SUGGESTION_BY_KEY[key]` —— 按检查项名查表，命中就返回。
 * 它**完全没看 outcome**，所以模块冲突这一项无论结论是"通过"还是
 * "不通过"，用户看到的都是同一句话「换掉冲突的那个模块」。
 * 于是出现了那个逻辑矛盾：结论说通过，改法说换模块。
 *
 * ── P10 Step2：静态表的第二个缺陷，以及为什么改法是三级而不是两级 ──
 *
 * P9 那版把静态表当成**唯一**来源。它是按「检查项 × 档位」二维写的，
 * 不再和结论矛盾，但**内容仍是通用的**：
 * 只要撞上 `blockConflictCheck` 的 warn，无论这个想法是把 Self-RAG 的
 * 反思层接到 DPR 上、还是把别的两个模块拼在一起，拿到的都是
 * 同一句「在它们之间补一个中间层来桥接」—— 没说哪两个模块、
 * 没说要插什么、没说插在哪一环。用户读完还是不知道从哪下手。
 *
 * 而模型在写 detail 时是**看着具体模块组合**写的，它已经知道冲突
 * 落在哪两个具体环节。所以现在优先要模型自己写的 `suggestion`：
 *
 * ── 现在的优先级（自上而下，命中即返回）──
 *
 *   0. `pass` / `unknown` → `null`（门控，**最高优先级，先于一切**）
 *      这一档不允许任何来源给出改法 —— 包括模型。模型有时会顺手
 *      在 PASS 项上写"可以进一步…"，那是套话，收了反而制造矛盾。
 *   1. 模型给的 `check.suggestion` → 直接用
 *      这是针对本次方案生成的改法，粒度最细，优先于一切模板。
 *   2. 静态表 `SUGGESTION_TABLE[key][outcome]` → 兜底
 *      mock 模式没有模型输出，历史数据也可能缺字段。有二维表托底，
 *      至少不会退回到"通过却让你改模块"的老毛病。
 *   3. `NO_SPECIFIC_SUGGESTION` → 最后兜底
 *      两级都没有 = 我们确实不知道该怎么改。如实说，不硬套模板。
 *
 * 注意第 1 条**不区分 mock/真模型**：判断依据是"这条数据里到底有没有
 * 模型写的改法"，而不是"当前配置跑的是不是 mock"。这与 P2 一致的
 * 原则 —— 按数据来源判定，不按当前配置判定。mock 模式下
 * `check.suggestion` 恒为空串，自然落到第 2 条。
 */

/** 说不出针对性改法时的统一文案（用户拍板的兜底） */
export const NO_SPECIFIC_SUGGESTION = '暂无针对性改法建议'

/** 一个字面量的空值集合 —— 模型有时会把"没有"写成这些词而不是空串 */
const EMPTY_SENTINELS: ReadonlySet<string> = new Set([
  '',
  '-',
  '无',
  '暂无',
  'none',
  'null',
  'n/a',
  'na',
])

/**
 * 判断模型是否**真的**给了改法。
 *
 * 不能只判空串：模型在"这一项通过、没什么可改"时，除了写 `""`，
 * 还经常写 `"无"` / `"不适用"` / `"-"`。这些都不是改法，
 * 当成改法显示会变成"改法：无"，比不给还难看。
 *
 * 也不做长度门槛 —— "换掉检索模块"只有 7 个字但完全有效，
 * 设门槛会把短而准的改法误杀。只过滤明确的"空"信号。
 */
function hasModelSuggestion(raw: string | undefined | null): raw is string {
  const t = (raw ?? '').trim()
  if (t.length === 0) return false
  return !EMPTY_SENTINELS.has(t.toLowerCase())
}

/**
 * 「检查项 × 档位」二维改法表 —— **现在是兜底，不再是唯一来源**。
 *
 * 外层 key 是检查项，内层 key 是档位（warn / fail）。
 * 只有这两个档位会出现 —— pass / unknown 在 `suggestionFor` 里就被拦掉了。
 * 表里的文案刻意写得比模型**更保守、更通用**，因为它要在
 * "模型没给"时托底，必须对任何触发该档位的方案都成立。
 */
const SUGGESTION_TABLE: Record<string, Partial<Record<'warn' | 'fail', string>>> = {
  noveltyCheck: {
    warn: '做一次针对性查重：用本方案的核心组合去检索近两年的相关工作，确认没有已发表的相同组合。',
    fail: '已有工作覆盖了同样的组合 —— 要么换一个没被做过的组合，要么把创新点移到「怎么做」而不是「做什么」上。',
  },
  blockConflictCheck: {
    warn: '两个模块在机制上不完全兼容，但可以共存：在它们之间补一个中间层来桥接（例如在不可微检索后接一个可微重排序）。',
    fail: '两个模块在同一环路上直接冲突（例如一个要求可微、一个不可微），无法共存 —— 必须换掉其中一个，或改成串行的两阶段设计。',
  },
  dataRequirement: {
    warn: '当前数据规模偏紧：缩到一个公开数据集能覆盖的范围，或补一部分弱监督数据。',
    fail: '现有公开数据无法支撑这个方案：需要先换问题设定或改做小规模机制验证，否则无法得出可信结论。',
  },
  computeRequirement: {
    warn: '算力需求偏高：先在一个小规模设定上验证机制（缩小数据与参数量），确认有效再谈全量训练。',
    fail: '算力需求超出可及范围：必须换更小的骨干模型或削减检索规模，否则方案无法落地验证。',
  },
}

function suggestionFor(check: CrashCheckConclusion, outcome: CheckOutcome): string | null {
  // ── 门控（优先级 0）：通过 / 无法判断 → 不给改法 ──
  // 这是问题 5 的核心修复点，也是 P9 静态表那个 bug 的根源。
  // 放在最前面，且**先于模型输出**：模型偶尔会在 PASS 项上顺手写一句
  // "可进一步…"，那是套话不是改法，收了会重新制造"结论通过却让你改"
  // 的矛盾。门控没有例外。
  if (outcome === 'pass') return null
  if (outcome === 'unknown') return null

  // ── 优先级 1：模型给的针对性改法 ──
  if (hasModelSuggestion(check.suggestion)) return check.suggestion.trim()

  // ── 优先级 2：静态表兜底（按「检查项 × 档位」二维取） ──
  const forCheck = SUGGESTION_TABLE[check.key]
  const targeted = forCheck?.[outcome as 'warn' | 'fail']
  if (targeted) return targeted

  // ── 优先级 3：两级都没有 —— 不硬套模板，如实说"没有针对性建议" ──
  return NO_SPECIFIC_SUGGESTION
}

/**
 * 把模型腔的理由改写成"人话"。
 *
 * 主要处理演示模式那几句（它们出现频率最高，也最像报错）：
 *   原文  "演示模式不具备检索与机制推理能力，无法对这一项做出真实判断。…"
 *   改写  "演示模式没有联网检索能力，这一项没有真正检查（不代表没问题，只代表没查）。"
 *
 * 真实模型的 detail 一般已经是完整句子，这里只去掉个别修饰词，不重写。
 */
function humanizeReason(raw: string, isMockMode: boolean): string {
  const r = raw.trim()
  if (!r) return ''

  /**
   * ── 问题 8：文案已经由数据层改写成人话了 ──
   * 这里只保留对**历史数据**的兼容（旧库里存的是"演示模式无法检索新颖性"这类）。
   * 新数据不再命中这些分支 —— 它们进来时本身就是结论化的句子。
   */
  if (/演示模式不具备检索与机制推理能力|无法对这一项做出真实判断/.test(r)) {
    return '这一项需要外部检索能力才能判断，当前没有做 —— 不代表没问题，只代表还没查。'
  }

  // 去掉"演示模式无法…"这种把主语放在模式上的说法，落到"这一项"上
  return r
    .replace(/^演示模式无法/, '当前无法')
    .replace(/\s+/g, ' ')
}

/**
 * 把一条检查渲染成"下一步"条目。
 *
 * 改法可能为 `null`（通过 / 无法判断 / 无针对性建议）——
 * 这时只给检查项名，**不补一句占位的话**：下一步要的是动作，
 * 没有动作就别硬凑一条。
 */
function stepOf(c: CrashCheckConclusion): string {
  return c.suggestion ? `${c.label}：${c.suggestion}` : c.label
}

/**
 * 从击穿测试结果 → 给结论的摘要。
 *
 * 判定顺序（为什么是这个顺序）：
 *   1. 有任何 BLOCKER → 不建议做（致命问题优先，别的都靠后）
 *   2. 没有任何 BLOCKER，但有警告 / 或本身是演示模式 → 需要调整
 *      演示模式**一律**落这里：它没查出致命问题，但也没资格说"可行"
 *   3. 全部通过且非演示模式 → 可行
 *   4. 全部通过但证据不足 / 判定为 INSUFFICIENT_EVIDENCE → 需要调整
 *      （"没发现反证"不等于"成立"，这一点和 crash-test 模块的立场一致）
 */
export function buildCrashConclusion(t: CrashTestView): CrashConclusion {
  const isMockMode = detectMock(t)

  const checks: CrashCheckConclusion[] = t.checks.map((c) => {
    const outcome = LEVEL_TO_OUTCOME[c.level] ?? 'warn'
    const reason = humanizeReason(c.detail || c.finding, isMockMode)
    /**
     * ── P10 Step2：先把模型给的改法放进来，再让 `suggestionFor` 决定用哪个 ──
     *
     * 顺序很关键：`suggestionFor` 的优先级 1 就是读 `check.suggestion`，
     * 所以这里必须**原样透传**模型的输出（包括空串），不能提前做
     * "空串就替换成模板"之类的加工 —— 那样优先级 2 的兜底链就断了，
     * 而且会分不清用户看到的是模型写的还是我们填的。
     */
    const base: CrashCheckConclusion = {
      key: c.key,
      label: c.label,
      outcome,
      outcomeLabel: OUTCOME_LABEL[outcome],
      reason: reason || '（这一项没有给出说明）',
      suggestion: c.suggestion ?? null,
    }
    // 改法依赖完整对象（要按 门控 → 模型 → 表 三级判定），所以在这里补齐
    return { ...base, suggestion: suggestionFor(base, outcome) }
  })

  /**
   * 模型自己给出的"继续做需要满足的条件"是**权威建议**。
   *
   * 为什么它优先于模板：条件是针对这个具体想法算出来的，模板只是方向。
   * 但条件是**全局**的（不区分属于哪一项检查），所以不能直接替掉逐项建议；
   * 这里把它作为"下一步"的额外条目追加在最前，逐项建议保持模板 ——
   * 既有针对性的具体条件，又有每一项都能落地的动作。
   */
  const modelConditions = (t.conditionsToProceed ?? []).filter((s) => s.trim())

  const counts = {
    pass: checks.filter((c) => c.outcome === 'pass').length,
    warn: checks.filter((c) => c.outcome === 'warn').length,
    unknown: checks.filter((c) => c.outcome === 'unknown').length,
    fail: checks.filter((c) => c.outcome === 'fail').length,
  }

  const { outcome, reason, nextSteps } = decideOverall(t, checks, counts, isMockMode, modelConditions)

  return {
    checks,
    overall: { outcome, label: OVERALL_LABEL[outcome], reason, nextSteps: dedupeSteps(nextSteps) },
    counts,
    isMockMode,
  }
}

const OVERALL_LABEL: Record<OverallOutcome, string> = {
  go: '可行',
  adjust: '需要调整',
  stop: '不建议做',
}

function decideOverall(
  t: CrashTestView,
  checks: CrashCheckConclusion[],
  counts: { pass: number; warn: number; unknown: number; fail: number },
  isMockMode: boolean,
  modelConditions: string[]
): { outcome: OverallOutcome; reason: string; nextSteps: string[] } {
  // ① 有致命问题 —— 先把失败项列清楚，再给"要么换要么停"
  if (counts.fail > 0) {
    const failed = checks.filter((c) => c.outcome === 'fail').map((c) => c.label)
    return {
      outcome: 'stop',
      reason: `有 ${counts.fail} 项检查失败：${failed.join('、')}。存在足以否决这个方案的问题。`,
      nextSteps: [
        ...modelConditions,
        ...checks.filter((c) => c.outcome === 'fail').map(stepOf),
        ...(t.fatalFlaws.length > 0 ? [`已知致命弱点需先解决：${t.fatalFlaws.join('；')}`] : []),      ],
    }
  }

  const verdict = t.overallVerdict

  // ② 演示模式：给**明确倾向**，不是免责声明（问题 8 重做）
  //
  //    旧逻辑：一律返回"需要调整 + 没有检索能力所以不能判断"——
  //    每个方案拿到的都是同一句话，等于没给结论。
  //
  //    新逻辑：结论直接来自**已完成的检查**。
  //    判定依据写在 reason 里（"三项结构检查通过，一项没查"），
  //    用户既知道倾向，也知道这个倾向立在什么上面。
  if (isMockMode) {
    const unknownChecks = checks.filter((c) => c.outcome === 'unknown')
    const warnChecks = checks.filter((c) => c.outcome === 'warn')

    // ②-a 有没查的项 → 倾向"需要调整"，并点明**差的就是那一步**
    if (unknownChecks.length > 0) {
      return {
        outcome: 'adjust',
        reason:
          `已完成的 ${counts.pass + counts.warn} 项结构检查里` +
          (warnChecks.length > 0
            ? `${warnChecks.length} 项需要调整、其余通过`
            : '全部通过') +
          `；但「${unknownChecks.map((c) => c.label).join('、')}」这一项没有做（需要外部检索能力）。` +
          `因此倾向于「可以做，但要先把没查的那项补上」——` +
          `在查重之前，请把它当作尚未验证的假设。`,
        nextSteps: [
          ...modelConditions,
          ...unknownChecks.map(stepOf),
          ...buildNextSteps(checks),
        ],
      }
    }

    // ②-b 结构检查全过、也没有"没查"的项 → 才允许给"可行"
    if (counts.pass === checks.length && checks.length > 0) {
      return {
        outcome: 'go',
        reason: `已完成的 ${checks.length} 项检查全部通过，没有发现结构性问题。`,
        nextSteps: modelConditions.length > 0 ? [...modelConditions] : ['按最小可行实验先验证机制。'],
      }
    }
  }

  // ③ 真实模型明确给出否定判定
  if (verdict === 'LIKELY_EXISTS' || verdict === 'INFEASIBLE') {
    return {
      outcome: 'stop',
      reason: `模型判定为「${VERDICT_LABEL[verdict] ?? verdict}」。`,
      nextSteps: [...modelConditions, ...buildNextSteps(checks)],
    }
  }

  // ④ 有警告项 —— 可做，但要先把警告处理掉
  if (counts.warn > 0) {
    return {
      outcome: 'adjust',
      reason: `没有致命问题，但有 ${counts.warn} 项警告需要先处理。`,
      nextSteps: [...modelConditions, ...buildNextSteps(checks)],
    }
  }

  // ⑤ 证据不足：没发现反证 != 成立
  if (verdict === 'INSUFFICIENT_EVIDENCE' || t.evidenceStatus === 'INSUFFICIENT') {
    return {
      outcome: 'adjust',
      reason: '四项检查没有发现问题，但可用证据不足 —— 「没找到反证」不等于「想法成立」。',
      nextSteps: [...modelConditions, ...buildNextSteps(checks)],
    }
  }

  // ⑥ 真·全部通过
  return {
    outcome: 'go',
    reason: '四项检查全部通过，且没有发现致命弱点。',
    nextSteps: [
      ...modelConditions,
      ...checks.filter((c) => c.outcome !== 'pass').map(stepOf),
    ],
  }
}

/**
 * 汇总"下一步做什么"，并做去重。
 *
 * 为什么必须去重：模型自己写的 conditionsToProceed 常常和我们补的第一条
 * （"配置真实模型后重新执行"）说的是同一件事，只是用词不同 ——
 * 「重新执行击穿测试」与「重新执行撞车测试」是同一个动作的两种叫法。
 * 不去重的话，用户会看到同一个动作被列两遍，反而显得系统不清楚自己要什么。
 *
 * 去重策略：归一化掉「击穿/撞车」「测试/检验」这类同义替换 + 去掉标点，
 * 再比对是否互为子串 —— 命中则只保留先出现的那条。
 */
function dedupeSteps(steps: string[]): string[] {
  const norm = (s: string) =>
    s
      .replace(/击穿/g, '撞车')
      .replace(/[\s，。；、,.!！?？：:（）()【】\[\]]/g, '')
      .toLowerCase()
  const out: string[] = []
  const seen: string[] = []
  for (const s of steps) {
    const n = norm(s)
    if (!n) continue
    if (seen.some((x) => x.includes(n) || n.includes(x))) continue
    seen.push(n)
    out.push(s)
  }
  return out
}

/**
 * 汇总"下一步做什么"。
 *
 * 只取**非通过**项的模板建议（通过项不需要行动），并按原顺序去重。
 * 为什么不在下一步里塞模型原文：下一步要的是"动作"，
 * 模型原文是"判断"，两者混在一起用户又要重新提炼一遍。
 */
function buildNextSteps(checks: CrashCheckConclusion[]): string[] {
  const items = checks.filter((c) => c.outcome !== 'pass').map(stepOf)
  return items.length > 0 ? items : ['四项检查未发现需要处理的问题。']
}

/**
 * 判断这条记录是不是演示模式写的。
 *
 * 为什么不能只看一个字段：结果是 JSON 快照，不同版本写入的字段不同。
 * 这里用**多个可靠信号**任一命中即判定，避免漏判导致把 mock 结论当真实结论：
 *   1. findings JSON 里的 isMockMode（新版本会写）
 *   2. verdict 是 INSUFFICIENT_EVIDENCE 且检查项里出现"演示模式"字样
 */
function detectMock(t: CrashTestView): boolean {
  try {
    const obj = JSON.parse(t.findings) as { isMockMode?: unknown }
    if (obj && obj.isMockMode === true) return true
  } catch {
    /* findings 不是 JSON —— 继续用文本启发式 */
  }
  const blob = `${t.findings} ${t.checks.map((c) => `${c.finding} ${c.detail}`).join(' ')}`
  return /演示模式/.test(blob)
}
