/**
 * Crash Test —— 敢否定 Idea 的验证沙箱（P4）
 *
 * 这是价值链的最后一环，也是**唯一一个设计目标是"否定"的模块**。
 *
 * 项目要求原文：
 *   > Crash Test 必须敢于否定 Idea
 *
 * 为什么这条要求如此重要：
 *   前面的所有模块（DNA / Surgery / Evolution / Debt / Crossbreeder）都在
 *   "生成"东西。如果最后一环还在生成，那整个系统就变成了一个 idea 制造机 ——
 *   LLM 可以无限产出听起来很有道理的研究方向，而研究者最不缺的就是方向。
 *   真正稀缺的是**知道哪个方向不值得走**。
 *
 * 因此本模块做四项**对抗性检验**，每项的目标都是找问题，不是找优点：
 *
 *   noveltyCheck       —— 这个想法是不是早就有人做过了？（找"已被做过"的证据）
 *   blockConflictCheck —— 被组合的这些模块，机制上是不是互相打架？
 *   dataRequirement    —— 它需要什么数据？这些数据真的存在/可得吗？
 *   computeRequirement —— 它需要多少算力？做得到吗？
 *
 * 输出 overallVerdict，取值刻意包含两个否定性结论：
 *   LIKELY_EXISTS —— 很可能已被做过（这是最常见的否定）
 *   INFEASIBLE    —— 不可行
 *
 * 还有一个关键设计：**没有找到反证 != 想法成立**。
 * 如果证据不足以支持任何判断，verdict 是 INSUFFICIENT_EVIDENCE，
 * 而不是乐观地给 PROMISING。演不出结论就老实说演不出。
 */

import { prisma } from './prisma'
import {
  EvidenceSource,
  EvidenceStatus,
  Verdict,
  parseJsonArray,
} from './enums'
import { callLLMStructured, type FieldSpec, type LLMMessage } from './llm'

// ===================== 类型 =====================

interface RawEvidence {
  quote: string
  page: number
  section: string
}

interface RawFinding {
  /** 这项检验发现了什么 */
  finding: string
  /** 判定：PASS / CONCERN / BLOCKER */
  level: string
  /** 依据 */
  detail: string
  /**
   * 针对这一项的**改法**（P10 Step2 新增）。
   *
   * ── 为什么必须由模型给，而不是继续用静态表 ──
   *
   * P9 那版是一张人工写死的「检查项 × 档位」二维表。它能修掉
   * "结论通过却让你改模块"的逻辑矛盾，但改法本身是**通用的**：
   * 无论这个想法是把 Self-RAG 的反思层接到 DPR 上、还是把别的两个
   * 模块拼在一起，只要触发 `blockConflictCheck` 的 warn，拿到的
   * 都是同一句「在它们之间补一个中间层来桥接」。
   *
   * 而模型在写 detail 时是**看着具体模块组合**写的 —— 它已经知道
   * 冲突发生在哪两个具体环节上。让它顺手把改法写出来，改法才能落到
   * "是哪两个模块、在哪一环、插什么"这个粒度。
   *
   * 静态表保留为兜底（见 crash-summary.ts 的三级优先级），
   * 所以字段允许为空串 —— 模型没给就回落，不是硬性要求。
   */
  suggestion: string
  evidence: RawEvidence[]
}

interface RawCrashTest {
  noveltyCheck: RawFinding[]
  blockConflictCheck: RawFinding[]
  dataRequirement: RawFinding[]
  computeRequirement: RawFinding[]
  experimentalDesign: string
  /** 补充的发现（不属于以上四类但值得记录的） */
  findings: RawFinding[]
  overallVerdict: string
  verdictReason: string
  /** 要在什么条件下这个 idea 才值得继续 */
  conditionsToProceed: string[]
  /** 这个 idea 的致命弱点 */
  fatalFlaws: string[]
}

export interface CrashTestResult {
  crashTestId: string
  ideaId: string
  projectId: string
  provider: string
  model: string
  overallVerdict: Verdict
  blockerCount: number
  concernCount: number
  evidenceCount: number
  evidenceStatus: EvidenceStatus
  fatalFlaws: string[]
  /** 是否被否决（LIKELY_EXISTS 或 INFEASIBLE） */
  rejected: boolean
}

// ===================== Schema =====================

const EVIDENCE_SPEC: FieldSpec = {
  type: 'array',
  of: {
    type: 'object',
    fields: {
      quote: { type: 'string', min: 5 },
      page: { type: 'number' },
      section: { type: 'string' },
    },
  },
}

const FINDING_SPEC: FieldSpec = {
  type: 'array',
  of: {
    type: 'object',
    fields: {
      finding: { type: 'string', min: 4 },
      level: { type: 'string' },
      detail: { type: 'string', min: 0 },
      // min: 0 —— 允许模型留空（这一项通过、或它确实给不出针对性改法）。
      // 校验层不强制，由 crash-summary.ts 做「模型给的 → 静态表 → 兜底文案」
      // 的三级回落，这样"模型改法质量不稳"不会让整次调用判为 SCHEMA 失败。
      suggestion: { type: 'string', min: 0 },
      evidence: EVIDENCE_SPEC,
    },
  },
}

const CRASH_TEST_SPEC: FieldSpec = {
  type: 'object',
  fields: {
    noveltyCheck: FINDING_SPEC,
    blockConflictCheck: FINDING_SPEC,
    dataRequirement: FINDING_SPEC,
    computeRequirement: FINDING_SPEC,
    experimentalDesign: { type: 'string', min: 0 },
    findings: FINDING_SPEC,
    overallVerdict: { type: 'string' },
    verdictReason: { type: 'string', min: 0 },
    conditionsToProceed: { type: 'array', of: { type: 'string', min: 0 } },
    fatalFlaws: { type: 'array', of: { type: 'string', min: 0 } },
  },
}

// ===================== Prompt =====================

const SYSTEM_PROMPT = `你是一位以**严苛**著称的资深审稿人，正在对一个候选研究方案做"撞车测试"（Crash Test）。

【你的立场 —— 这决定了你是否有用】
你的任务**不是评估这个想法有多好，而是找出它为什么会失败。**
一份只写优点的报告是没有价值的。研究者最不缺的就是听起来不错的方向，
他们真正需要的是**知道哪个方向不值得投入**。

所以：
- 主动去找"这个想法其实已经被做过了"的证据
- 主动去找"这两个模块机制上其实互斥"的理由
- 主动去找"它需要的数据根本拿不到 / 算力根本不够"的现实约束
- **如果确实找不出致命问题，也要诚实说明，不要为了显得严厉而编造批评**

【四项对抗性检验 —— 每项都要给 level】
level 取值：
  PASS    —— 这一项没有发现问题
  CONCERN —— 有问题但可以设法缓解
  BLOCKER —— 这一项足以否决整个方案

1) noveltyCheck —— 新颖性检验
   在提供的论文原文里，有没有工作**已经做过类似的事**？
   如果原文中就有"我们用 X 解决了 Y"这种表述，而本方案正是"用 X 解决 Y"，
   那就是 LIKELY_EXISTS 的强证据。要认真找，不要轻易给 PASS。

2) blockConflictCheck —— 模块冲突检验
   被组合的模块在机制上是否互相矛盾？
   例如：一个要求端到端可微，另一个是不可微的离散检索；
   一个假设输入是定长，另一个产出变长序列。
   如果两个模块从未在同一方法中出现过，要特别警惕 —— 这可能正说明它们不兼容。

3) dataRequirement —— 数据可行性
   这个方案需要什么规模的标注数据 / 领域语料 / 评测集？
   论文原文里有没有证据表明这类数据存在且可得？
   如果方案隐含"需要一个新的标注数据集"，要明确指出这是重大成本。

4) computeRequirement —— 算力可行性
   训练 / 推理需要什么量级的算力？
   论文原文里有没有给出可参考的开销数字（GPU 数量、训练时长、参数量）？
   如果方案把两个高开销模块叠加，要指出开销可能是相乘而非相加。

【overallVerdict —— 必须敢于给否定结论】
PROMISING             —— 四项检验基本通过，且有证据支持值得一试
RISKY                 —— 存在明显风险，但风险可评估、有缓解路径
LIKELY_EXISTS         —— **很可能已被做过**（原文中已有高度相似的方案）
INFEASIBLE            —— **不可行**（数据/算力/模块冲突上存在 BLOCKER）
INSUFFICIENT_EVIDENCE —— 证据不足以判断（例如原文根本没有讨论相关开销）

【最重要的判定规则 —— 违反则输出作废】
- **没有发现反证，不等于想法成立。** 如果你掌握的证据根本不足以
  对某项检验做出判断，应给 INSUFFICIENT_EVIDENCE，而不是乐观地给 PROMISING。
- 只要四项检验中出现任意一个 BLOCKER，overallVerdict 就不能是 PROMISING。
- 如果存在 BLOCKER，必须在 fatalFlaws 里明确写出致命弱点。
- fatalFlaws 允许为空数组 —— 但只有在真的找不出致命弱点时才留空。

【suggestion —— 每一项必须给"怎么改"，这是本报告最有价值的部分】
只诊断不给解法，对研究者是没有用的：他知道自己会撞车，但不知道怎么绕。

所以针对**每一项**检验，你要在 suggestion 字段里写出**具体的改法**：
- 必须落到这个方案**具体的模块名、具体的环节**上，
  写"是 A 模块的哪一步与 B 模块的哪一步冲突、在哪一环插入什么"。
- **禁止写通用套话**。以下这类句子一律不合格（它们对任何方案都成立，
  等于没写）：
    · "建议进一步验证"
    · "可以尝试优化"
    · "注意数据规模的限制"
    · "在二者之间加一个中间层来桥接"（没说加在哪、加什么）
- 要写成**能直接动手做**的动作，例如
  "把不可微的 BM25 检索结果先固化成候选集，再做可微重排序，
   断开梯度回传到检索这一步" —— 而不是"解决可微性问题"。

suggestion 与 level 的配套关系（**必须遵守**）：
  · level = PASS    → suggestion 必须留空字符串 ""。
                      通过的项目没有要改的，硬给一条改法就是自相矛盾。
  · level = CONCERN → 必须给改法：说明怎么缓解，缓解后还剩什么风险。
  · level = BLOCKER → 必须给改法：说明要么换掉什么、要么改成什么
                      才能救回来；如果**确实救不回来**，就明确写
                      "这一项无法通过调整解决，建议放弃该组合" ——
                      这也是有效信息，不要含糊其辞。

【输出格式】
只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：
{
  "noveltyCheck": [
    {"finding":"简短结论","level":"CONCERN","detail":"具体依据","suggestion":"具体改法；PASS 时为空串","evidence":[{"quote":"...","page":3,"section":"introduction"}]}
  ],
  "blockConflictCheck": [ ... ],
  "dataRequirement": [ ... ],
  "computeRequirement": [ ... ],
  "experimentalDesign": "如果要验证这个想法，最小可行实验该怎么设计（数据、基线、指标、对照）",
  "findings": [ ... ],
  "overallVerdict": "LIKELY_EXISTS",
  "verdictReason": "为什么给这个判定",
  "conditionsToProceed": ["在什么条件下这个方向才值得继续"],
  "fatalFlaws": ["足以否决它的致命问题"]
}

★★ 输出的强制完整性要求（系统会逐字段校验，缺一个字段整次输出作废）★★
上面的 5 个 finding 数组（noveltyCheck / blockConflictCheck / dataRequirement /
computeRequirement / findings）里的**每一个元素**，都必须同时具备这 5 个字段：
    finding、level、detail、suggestion、evidence

其中：
  · suggestion 即使是 PASS 也必须**存在**，值写成空字符串 ""（不能不写这个键）。
  · evidence 即使没有可引用的原文，也必须**存在**，值写成空数组 []。
    （有原文时写成 [{"quote":"...","page":3,"section":"..."}]）
  · detail 也必须存在（可以较短，但不能省略）。
一句话：**"键不能省，值可以为空"**。写的时候逐条自检，不要凭印象略过某个字段。

★★ 数组里的"每一个元素"是真的每一个（最常见的失败点）★★
最容易漏掉 evidence 的，恰恰是最后一个 findings 数组 ——
因为它和你脑子里"标准检查项"的印象不一样，写到最后就退化成
只写 finding/detail/suggestion 三条。**它和其他四个数组的规则完全相同**：
findings 里的每一项也必须有 evidence（没有原文就写 []，但键必须在）。

写完之后请**逐数组、逐元素**过一遍下面这张自查表，不要凭印象：
    noveltyCheck        —— 第 1、2…N 项的 evidence 键都在吗？
    blockConflictCheck  —— 同上
    dataRequirement     —— 同上
    computeRequirement  —— 同上
    findings            —— 同上（★ 这一项最容易漏）
任何一项答不上"在"，就把缺失的键补上（值可以是空数组）再输出。`

// ===================== 辅助 =====================

function normalizeLevel(raw: string): 'PASS' | 'CONCERN' | 'BLOCKER' | 'UNKNOWN' {
  const v = (raw || '').trim().toUpperCase()
  if (v === 'PASS' || v === 'CONCERN' || v === 'BLOCKER' || v === 'UNKNOWN') return v
  return 'CONCERN'
}

function normalizeVerdict(raw: string): Verdict {
  const v = (raw || '').trim().toUpperCase()
  const valid = Object.values(Verdict) as string[]
  return (valid.includes(v) ? v : Verdict.INSUFFICIENT_EVIDENCE) as Verdict
}

function cleanEvidence(list: RawEvidence[] | undefined): RawEvidence[] {
  return (list ?? []).filter(
    (e) => e && typeof e.quote === 'string' && e.quote.trim().length >= 5
  )
}

function allFindings(t: RawCrashTest): RawFinding[] {
  return [
    ...(t.noveltyCheck ?? []),
    ...(t.blockConflictCheck ?? []),
    ...(t.dataRequirement ?? []),
    ...(t.computeRequirement ?? []),
    ...(t.findings ?? []),
  ]
}

// ===================== 主流程 =====================

export async function runCrashTest(ideaId: string): Promise<CrashTestResult> {
  // ---- 1) 取出候选 idea 及其全部上下文 ----
  const idea = await prisma.candidateIdea.findUnique({
    where: { id: ideaId },
    include: {
      project: true,
      fromDebts: {
        include: {
          debt: {
            include: {
              sources: { include: { paper: true } },
              attempts: { include: { paper: true } },
            },
          },
        },
      },
    },
  })

  if (!idea) throw new Error(`候选方案不存在: ${ideaId}`)

  // 组合用到的模块
  // ── P12 问题 2：空模块是合法场景，不再拦截 ──
  // 用户手动输入的想法 fromBlockIds='[]'，历史上这里直接 throw
  // （本意是拦"生成想法的模块全被删掉"的数据损坏），结果把
  // 自定义想法也一并拒之门外 —— 与"同等对待、可击穿"的需求冲突。
  // 击穿审查的对象是想法本身（标题+描述），模块只是辅助上下文：
  // 没有模块就没有模块冲突可言，让 prompt 如实说明即可。
  const blockIds = parseJsonArray<string>(idea.fromBlockIds)
  const blocks = await prisma.methodBlock.findMany({
    where: { id: { in: blockIds } },
    include: { method: { include: { paper: true } } },
  })

  // 项目内所有论文（用于新颖性检索 —— 必须跨全部论文找，不能只看来源论文）
  const allPapers = await prisma.paper.findMany({
    where: { projectId: idea.projectId },
    include: { methodDNA: { include: { blocks: true } }, evidenceRefs: true },
    orderBy: [{ year: 'asc' }, { createdAt: 'asc' }],
  })

  // ---- 2) 构造 Prompt ----
  const blockDesc =
    blocks.length === 0
      ? '（该想法由用户手动输入，没有关联的方法模块 ——\n' +
        '  请就想法本身的标题与描述做检验；模块冲突项没有对象，如实给 PASS 即可）'
      : blocks
          .map((b) => {
            return [
              `- 「${b.name}」（${b.type}）`,
              `    来自论文：${b.method.paper.title}（${b.method.paper.year ?? '未知'}）`,
              `    描述：${(b.description || '（无）').slice(0, 300)}`,
              `    作用：${(b.role || '（无）').slice(0, 300)}`,
            ].join('\n')
          })
          .join('\n')

  const debtDesc =
    idea.fromDebts.length === 0
      ? '（无关联的研究债务 —— 用户手动输入的想法）'
      : idea.fromDebts
          .map((d) => {
            const srcs = d.debt.sources
              .map((s) => `        · 《${s.paper.title}》：${s.context.slice(0, 200)}`)
              .join('\n')
            const atts =
              d.debt.attempts.length > 0
                ? d.debt.attempts
                    .map(
                      (a) =>
                        `        · 《${a.paper.title}》尝试过：${a.description.slice(0, 200)}（结果：${a.outcome}）`
                    )
                    .join('\n')
                : '        （此前无人尝试解决）'
            return [
              `- 「${d.debt.title}」（${d.debt.category}｜${d.debt.occurrenceCount} 篇论文提及）`,
              `    本方案声称：${d.why}`,
              `    各论文的说法：`,
              srcs || '        （无）',
              `    已有的尝试记录：`,
              atts,
            ].join('\n')
          })
          .join('\n')

  // 全文供新颖性检索
  const corpusText = allPapers
    .map((p, i) => {
      const paragraphs = parseJsonArray<{ page: number; text: string }>(p.rawText)
      const text = paragraphs
        .map((x) => `[p${x.page}] ${x.text}`)
        .join('\n')
        .slice(0, 12000)
      return `### [${i}] ${p.title}（${p.year ?? '未知'}）\n${text}`
    })
    .join('\n\n')

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `【待检验的候选方案】\n` +
        `标题：${idea.title}\n` +
        `描述：${idea.description || '（无）'}\n\n` +
        `【它组合了哪些模块】\n${blockDesc}\n\n` +
        `【它声称要解决的研究债务】\n${debtDesc}\n\n` +
        `【项目内全部论文原文（请在其中检索是否已有类似工作）】\n${corpusText}\n\n` +
        `请对这个方案做撞车测试。记住：你的任务是找出它为什么会失败。\n` +
        `如果证据不足以判断，就给 INSUFFICIENT_EVIDENCE —— 不要乐观地假设它可行。`,
    },
  ]

  // ---- 3) 调用模型 ----
  const result = await callLLMStructured<RawCrashTest>({
    messages,
    spec: CRASH_TEST_SPEC,
    coerce: (raw) => raw as RawCrashTest,
    maxAttempts: 3,
    temperature: 0.2,
    /**
     * ── P10 Step2：maxTokens 从 6000 提到 32000 ──
     *
     * 6000 是按**非推理模型**估的：那时假设 content 独占整个预算。
     * 但 hy3 是推理模型，`reasoning_content` 与 `content` **共享**
     * `max_tokens` —— 实测这一轮思考过程就吃掉 13835~14345 字符，
     * 预算在写出正式回答之前就耗尽了，于是 finish_reason=length、
     * content 为空串，整次调用降级到 mock。
     *
     * 后果比"慢"严重得多：击穿测试**静默变成了 mock 结论**，
     * 用户看到的"模块冲突：可行"其实来自本地启发式，不是模型判断。
     * 而 Step2 的 suggestion 改造恰好依赖模型输出 ——
     * 预算不够 = 模型永远给不出 suggestion = 新功能在真模型下等于没上。
     *
     * 32000 的依据：与 method-dna 对齐。实测 hy3 的推理开销约
     * 5~6k token 且**大致恒定**（不随输入线性增长），
     * 32000 给正式回答留出足够余量。
     */
    maxTokens: 32000,
    /** 与 method-dna 一致的总预算：两次尝试足够，避免三连超时让用户干等 */
    totalBudgetMs: 300000,
    purpose: 'crash-test',
  })

  const t = result.value
  const isMockMode = result.provider === 'mock'

  // ---- 4) 统计检验结果 ----
  const findings = allFindings(t).map((f) => ({
    ...f,
    level: normalizeLevel(f.level),
  }))

  const blockerCount = findings.filter((f) => f.level === 'BLOCKER').length
  const concernCount = findings.filter((f) => f.level === 'CONCERN').length

  // ---- 5) verdict 判定 —— 这里是最关键的逻辑 ----
  let overallVerdict = normalizeVerdict(t.overallVerdict)

  // 规则 A：存在 BLOCKER 时不允许乐观
  if (blockerCount > 0 && overallVerdict === Verdict.PROMISING) {
    overallVerdict = Verdict.RISKY
  }

  // 规则 B：新颖性检验出现 BLOCKER —— 说明原文里已有高度相似工作
  const noveltyBlocker = (t.noveltyCheck ?? []).some(
    (f) => normalizeLevel(f.level) === 'BLOCKER'
  )
  if (noveltyBlocker && overallVerdict === Verdict.PROMISING) {
    overallVerdict = Verdict.LIKELY_EXISTS
  }

  /**
   * ── 规则 C（问题 8 重做）：不再一律降级为"证据不足" ──
   *
   * 旧规则：`if (isMockMode) overallVerdict = INSUFFICIENT_EVIDENCE`
   *   —— 结果是每次击穿测试都只有一句"证据不足"，用户拿不到任何倾向。
   *   这正是问题 8 抱怨的"全是免责声明"。
   *
   * 新分工（用户拍板）：
   *   · 结构性检查（模块冲突 / 数据可行性 / 算力可行性）本身就能从
   *     数据推出结论，mock 给的是**真判断**，不该被降级；
   *   · 新颖性依赖检索，mock 给的是 `UNKNOWN`（"无法判断，建议查重"），
   *     它已经被计入 levels，会自然把 verdict 压到"需要调整"，
   *     不需要再额外降级一次。
   *
   * 唯一保留降级的场景：**模型什么结构信息都没给**（四项检查全空）——
   * 那时确实没有任何依据，降级是诚实的。
   */
  const hasAnyFinding =
    (t.noveltyCheck?.length ?? 0) +
      (t.blockConflictCheck?.length ?? 0) +
      (t.dataRequirement?.length ?? 0) +
      (t.computeRequirement?.length ?? 0) >
    0
  if (isMockMode && !hasAnyFinding) {
    overallVerdict = Verdict.INSUFFICIENT_EVIDENCE
  }

  /**
   * 规则 D（问题 8）：新颖性 `UNKNOWN` 不允许得出"可行"。
   *
   * 这是用户明确加的约束：只有**结构性检查真做了**的项才能给"可行"。
   * 新颖性没查过 = 这个方案是否早已存在是未知的，绝不能标成"有前景"。
   */
  const noveltyUnknown = (t.noveltyCheck ?? []).some(
    (f) => normalizeLevel(f.level) === 'UNKNOWN'
  )
  if (noveltyUnknown && overallVerdict === Verdict.PROMISING) {
    overallVerdict = Verdict.RISKY
  }

  // ---- 6) 证据落库（汇总所有检验里的证据） ----
  const allEv = findings.flatMap((f) => cleanEvidence(f.evidence))

  // 去重
  const seen = new Set<string>()
  const uniqueEv = allEv.filter((e) => {
    const k = `${e.page}::${e.quote.slice(0, 100)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // 原文核对：证据必须能在项目内某篇论文中找到
  const paperTexts = allPapers.map((p) => ({
    id: p.id,
    text: parseJsonArray<{ page: number; text: string }>(p.rawText)
      .map((x) => x.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .toLowerCase(),
  }))

  interface VerifiedEv extends RawEvidence {
    verified: boolean
    paperId: string
  }
  const verifiedEv: VerifiedEv[] = []
  for (const e of uniqueEv) {
    const needle = e.quote
      .replace(/\s+/g, ' ')
      .replace(/^[^0-9A-Za-z\u4e00-\u9fa5]+/, '')
      .toLowerCase()
      .slice(0, 80)
    if (needle.length < 5) continue

    const hit = paperTexts.find((p) => p.text.includes(needle))
    if (hit) verifiedEv.push({ ...e, verified: true, paperId: hit.id })
  }

  const evidenceCount = verifiedEv.length

  // 完全没有证据支撑的检验报告 —— 不给任何确定性结论
  if (evidenceCount === 0 && !isMockMode) {
    overallVerdict = Verdict.INSUFFICIENT_EVIDENCE
  }

  const evidenceStatus: EvidenceStatus =
    evidenceCount === 0
      ? EvidenceStatus.INSUFFICIENT
      : isMockMode
        ? EvidenceStatus.UNCERTAIN
        : evidenceCount >= 2
          ? EvidenceStatus.CONFIRMED
          : EvidenceStatus.UNCERTAIN

  const fatalFlaws = (t.fatalFlaws ?? []).filter((f) => f && f.trim())

  // ---- 7) 落库（一个 idea 只保留一份最新的撞车测试） ----
  const crashTestId = await prisma.$transaction(async (tx) => {
    await tx.crashTest.deleteMany({ where: { ideaId } })

    const evidenceIds: string[] = []
    for (const e of verifiedEv) {
      const rec = await tx.evidenceRef.create({
        data: {
          paperId: e.paperId,
          source: EvidenceSource.LLM_INFERENCE,
          status: EvidenceStatus.CONFIRMED,
          quote: e.quote.slice(0, 1200),
          section: (e.section || 'body').trim().toLowerCase().slice(0, 40),
          pageNumber:
            Number.isFinite(e.page) && e.page >= 1 ? Math.floor(e.page) : null,
          confidence: isMockMode ? 0.6 : 0.9,
        },
      })
      evidenceIds.push(rec.id)
    }

    const created = await tx.crashTest.create({
      data: {
        ideaId,
        noveltyCheck: JSON.stringify(
          (t.noveltyCheck ?? []).map((f) => ({
            finding: f.finding,
            level: normalizeLevel(f.level),
            detail: f.detail,
            suggestion: (f.suggestion ?? '').trim().slice(0, 500),
            evidenceIds: cleanEvidence(f.evidence)
              .map(
                (e) =>
                  verifiedEv.find(
                    (v) =>
                      v.page === e.page &&
                      v.quote.slice(0, 100) === e.quote.slice(0, 100)
                  )?.paperId ?? null
              )
              .filter((x): x is string => Boolean(x)),
          }))
        ),
        blockConflictCheck: JSON.stringify(
          (t.blockConflictCheck ?? []).map((f) => ({
            finding: f.finding,
            level: normalizeLevel(f.level),
            detail: f.detail,
            suggestion: (f.suggestion ?? '').trim().slice(0, 500),
            evidenceIds: cleanEvidence(f.evidence).map((e) => e.quote.slice(0, 200)),
          }))
        ),
        dataRequirement: JSON.stringify(
          (t.dataRequirement ?? []).map((f) => ({
            finding: f.finding,
            level: normalizeLevel(f.level),
            detail: f.detail,
            suggestion: (f.suggestion ?? '').trim().slice(0, 500),
            evidenceIds: cleanEvidence(f.evidence).map((e) => e.quote.slice(0, 200)),
          }))
        ),
        computeRequirement: JSON.stringify(
          (t.computeRequirement ?? []).map((f) => ({
            finding: f.finding,
            level: normalizeLevel(f.level),
            detail: f.detail,
            suggestion: (f.suggestion ?? '').trim().slice(0, 500),
            evidenceIds: cleanEvidence(f.evidence).map((e) => e.quote.slice(0, 200)),
          }))
        ),
        experimentalDesign: (t.experimentalDesign ?? '').trim().slice(0, 4000),
        findings: JSON.stringify({
          extra: (t.findings ?? []).map((f) => ({
            finding: f.finding,
            level: normalizeLevel(f.level),
            detail: f.detail,
            suggestion: (f.suggestion ?? '').trim().slice(0, 500),
            /**
             * ── 补上 evidence（原本这里唯一漏掉的一个）──
             *
             * 四个命名数组都写了 `evidenceIds`，只有 `findings.extra` 没写。
             * 后果不是"少个字段"这么轻：
             *   ① 提示词要求模型每个 finding 都给 evidence，
             *      校验层（validateShape）也会因为缺键把整次输出判为失败 ——
             *      但我们落库时又把它丢掉，等于**收了钱不做事**；
             *   ② 前端 `allFindings` 与面板的"证据"按钮都按同一套形状读数据，
             *      extra 少了这一项，同一个页面上两类 finding 长得不一样；
             *   ③ 最要命的是**静默**：模型明明给了引用原文，
             *      用户在 findings 里却看不到出处，无从核对。
             *
             * 这里与上面四个数组保持完全一致的写法：先 cleanEvidence
             * 过滤掉 quote 过短的，再映射成被 verify 通过、真实落库的 paperId。
             */
            evidenceIds: cleanEvidence(f.evidence)
              .map(
                (e) =>
                  verifiedEv.find(
                    (v) =>
                      v.page === e.page &&
                      v.quote.slice(0, 100) === e.quote.slice(0, 100)
                  )?.paperId ?? null
              )
              .filter((x): x is string => Boolean(x)),
          })),
          verdictReason: t.verdictReason,
          conditionsToProceed: (t.conditionsToProceed ?? []).filter(
            (c) => c && c.trim()
          ),
          fatalFlaws,
          blockerCount,
          concernCount,
          isMockMode,
          provider: result.provider,
          model: result.model,
          /** 与 Surgery 一致的诚实声明 */
          disclaimer:
            '本报告是基于项目内论文证据的对抗性分析，未进行任何实验验证。' +
            '它的目标是否定方案，而非背书方案；未被否决不等于可行。',
        }),
        overallVerdict,
        evidenceIds: JSON.stringify(evidenceIds),
        evidenceStatus,
      },
    })

    return created.id
  })

  return {
    crashTestId,
    ideaId,
    projectId: idea.projectId,
    provider: result.provider,
    model: result.model,
    overallVerdict,
    blockerCount,
    concernCount,
    evidenceCount,
    evidenceStatus,
    fatalFlaws,
    rejected:
      overallVerdict === Verdict.LIKELY_EXISTS ||
      overallVerdict === Verdict.INFEASIBLE,
  }
}
