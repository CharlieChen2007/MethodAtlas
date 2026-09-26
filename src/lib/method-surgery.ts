/**
 * Method Surgery —— 方法手术（P3）
 *
 * 核心定位（来自项目要求）：
 *   允许用户对一个方法做"结构化手术"，例如移除某个 Block。
 *   系统**不重新训练模型**，而是基于论文证据做结构化模拟分析，输出：
 *     - 被操作的模块及其在原方法中的作用
 *     - 删除/替换后可能损失的功能
 *     - 预期影响（带强度分级）
 *     - 相关 Ablation / Experimental Evidence
 *     - 不确定性
 *
 * 设计红线：
 *   1. 明确标注这是"基于论文证据的模拟分析"，不是实验结论
 *   2. 所有影响判断必须关联证据；找不到消融证据时要**明说没有**，
 *      并把 verdict 降到 INSUFFICIENT_EVIDENCE，而不是编一个看似合理的后果
 *   3. 依赖关系要参与推理：删掉被依赖的模块，影响会沿依赖链扩散
 */

import { prisma } from './prisma'
import {
  BlockType,
  EvidenceSource,
  EvidenceStatus,
  SurgeryAction,
  SurgeryVerdict,
  parseJsonArray,
  parseJsonObject,
} from './enums'
import { callLLMStructured, type FieldSpec, type LLMMessage } from './llm'
import { EvidencePolicyError } from './evidence'

// ===================== 类型 =====================

interface RawEvidence {
  quote: string
  page: number
  section: string
}

interface RawImpact {
  /** 功能损失描述 */
  effect: string
  /** 影响强度 */
  severity: string // NONE | MINOR | MODERATE | SEVERE | CRITICAL
  /** 影响为什么会发生 */
  rationale: string
  evidence: RawEvidence[]
}

interface RawSurgery {
  /** 被操作模块在原方法中承担的作用（复述 + 深化） */
  blockRole: string
  /** 该模块被移除/禁用后，系统整体会失去什么功能 */
  lostCapability: string
  /** 逐条影响 */
  impacts: RawImpact[]
  /** 原文中与本操作相关的消融实验证据 */
  ablationEvidence: RawEvidence[]
  /** 是否找到了直接相关的消融实验 */
  hasDirectAblation: boolean
  /** 依赖风险：删除该模块是否会破坏其他模块 */
  dependencyRisk: string
  /** 综合判定 */
  verdict: string
  verdictReason: string
  /** 本次分析中无法确定的部分 */
  uncertainties: string[]
}

export interface SurgeryResult {
  surgeryId: string
  methodId: string
  paperId: string
  projectId: string
  provider: string
  model: string
  verdict: SurgeryVerdict
  evidenceCount: number
  evidenceStatus: EvidenceStatus
  uncertainties: string[]
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

const SURGERY_SPEC: FieldSpec = {
  type: 'object',
  fields: {
    blockRole: { type: 'string', min: 0 },
    lostCapability: { type: 'string', min: 0 },
    impacts: {
      type: 'array',
      of: {
        type: 'object',
        fields: {
          effect: { type: 'string', min: 2 },
          severity: { type: 'string' },
          rationale: { type: 'string', min: 0 },
          evidence: EVIDENCE_SPEC,
        },
      },
    },
    ablationEvidence: EVIDENCE_SPEC,
    hasDirectAblation: { type: 'boolean' },
    dependencyRisk: { type: 'string', min: 0 },
    verdict: { type: 'string' },
    verdictReason: { type: 'string', min: 0 },
    uncertainties: { type: 'array', of: { type: 'string', min: 0 } },
  },
}

// ===================== Prompt =====================

const SYSTEM_PROMPT = `你是一位严谨的科研方法分析专家，正在执行一次"方法手术"的**结构化模拟分析**。

【最重要的前提 —— 必须理解并遵守】
你**没有做任何实验，也不能做实验**。你的任务是基于论文中已有的证据，
推演"如果从这个方法里移除/禁用某个模块，会发生什么"。
这是**基于论文证据的模拟分析**，不是实验结论。你必须诚实地反映证据的强弱。

【证据规则 —— 违反则输出作废】
1. 只依据我提供的论文原文作答。原文没有的，一律不要编造。
2. 每一条 impact 都要尽可能附上 evidence（原文片段 + 页码）。
   如果某条影响你找不到原文依据，就把 evidence 留空数组，并在 uncertainties 里说明。
3. ablationEvidence 只填**原文中确实存在的消融实验/对比实验证据**。
   如果论文根本没做相关消融，就把 hasDirectAblation 设为 false，ablationEvidence 留空。
   **绝对不要为了显得有依据而编造消融实验。**
4. 论文原文里的实验数据要原样引用（数字、指标名），不要改写或估计。

【影响强度 severity 的取值】
NONE / MINOR / MODERATE / SEVERE / CRITICAL

【综合判定 verdict 的取值 —— 要敢于给负面结论】
PLAUSIBLE          —— 移除该模块后方法很可能仍能工作，且有证据支持
RISKY              —— 很可能造成明显功能损失，但有替代路径或影响可控
INFEASIBLE         —— 移除后会破坏方法的核心机制，方法基本失效
INSUFFICIENT_EVIDENCE —— 论文中找不到足够证据来判断后果

【特别要求】
- 如果该模块被其他模块依赖（prompt 中会给出依赖关系），必须分析影响如何沿依赖链扩散。
- 如果找不到相关消融实验，verdict 应当倾向 INSUFFICIENT_EVIDENCE，而不是猜测。
- 不要为了让用户高兴而给出乐观结论。该说"这样改会坏掉"就直接说。

【三个核心字段必须分工明确 —— 最常见的错误是三者写成同一句话的三种说法】
这三个字段会被并排展示给用户看，读者一眼就能发现"三句话其实是一句"。
所以每个字段回答的必须是**不同的问题**，不能互相复述：

  · blockRole  回答「**这个模块原本干什么**」—— 陈述前提，不是后果。
      允许深化 prompt 里给出的角色信息，但不允许新造事实。
      必须是你自己的功能化表述，不要照抄 prompt 原文。

  · lostCapability 回答「**拿掉它后，方法整体失去了哪一件能力**」。
      ★ 这是全篇最重要的一句，用户默认只看这一句。
      ★ 判据：读完它，用户应当能理解"为什么这个模块不能拿掉"（或"拿掉了也没事"）。
      ★ 必须是一句完整的中文因果句，主语是"方法"或"系统"的那个能力，不是这个模块本身。
      ★ 禁止写成"失去了该模块所承担的功能"这类同义反复 —— 那等于没答。
      ★ 禁止把 blockRole 复制一遍当作 lostCapability。

  · impacts 回答「**具体会怎样一步步坏掉**」—— 是 lostCapability 的展开与细分。
      每条 effect 都是一次**独立的、可分别验证的**后果，不要只是把
      lostCapability 换个说法重写一遍。至少有一条要说明"后果有多严重、为什么"。
      severity 要拉开档次：如果所有 impact 都是同一个 severity，
      通常说明你没有真正区分主次，请重新评估哪条才是决定性的。

三者的关系可以概括为：
      blockRole       = 它是什么（前提）
      lostCapability  = 整体损失（结论，一句话）
      impacts         = 损失如何展开（分条，带严重度与理由）

【输出格式】
只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：
{
  "blockRole": "该模块原本承担什么职责（功能化表述，一句话，不要复述 prompt 原文）",
  "lostCapability": "移除后方法整体失去的那一件能力（一句完整因果句，用户默认只看这一句）",
  "impacts": [
    { "effect": "一个独立、可分别验证的具体后果（不要只是复述 lostCapability）", "severity": "SEVERE", "rationale": "为什么会这样", "evidence": [{"quote":"...","page":3,"section":"experiment"}] }
  ],
  "ablationEvidence": [{"quote":"...","page":4,"section":"experiment"}],
  "hasDirectAblation": true,
  "dependencyRisk": "对依赖该模块的其他模块的影响分析",
  "verdict": "RISKY",
  "verdictReason": "判定理由",
  "uncertainties": ["哪些地方证据不足、无法确定"]
}`

// ===================== 辅助 =====================

function normalizeSeverity(raw: string): string {
  const v = (raw || '').trim().toUpperCase()
  return ['NONE', 'MINOR', 'MODERATE', 'SEVERE', 'CRITICAL'].includes(v)
    ? v
    : 'MODERATE'
}

function normalizeVerdict(raw: string): SurgeryVerdict {
  const v = (raw || '').trim().toUpperCase()
  const valid = Object.values(SurgeryVerdict) as string[]
  return (valid.includes(v) ? v : SurgeryVerdict.INSUFFICIENT_EVIDENCE) as SurgeryVerdict
}

// ===================== 主流程 =====================

export async function runSurgery(params: {
  blockId: string
  action: SurgeryAction
  /** 可选：用户的补充意图描述 */
  note?: string
}): Promise<SurgeryResult> {
  const { blockId, action, note } = params

  // ---- 1) 取出被操作模块及其所属方法/论文 ----
  const block = await prisma.methodBlock.findUnique({
    where: { id: blockId },
    include: {
      method: {
        include: {
          paper: { include: { evidenceRefs: true } },
          blocks: true,
        },
      },
    },
  })

  if (!block) throw new Error(`方法模块不存在: ${blockId}`)

  const method = block.method
  const paper = method.paper
  const paragraphs = parseJsonArray<{ page: number; text: string }>(paper.rawText)

  if (paragraphs.length === 0) {
    throw new Error('该论文没有可用的解析文本，无法进行手术分析。')
  }

  // ---- 2) 计算依赖关系（谁依赖这个模块） ----
  const dependents = method.blocks.filter((b) => {
    const deps = parseJsonArray<string>(b.dependencies)
    return deps.includes(blockId)
  })

  const blockEvidenceMap = new Map(paper.evidenceRefs.map((e) => [e.id, e]))
  const blockEvidence = parseJsonArray<string>(block.evidenceIds)
    .map((id) => blockEvidenceMap.get(id))
    .filter(Boolean)

  // 论文中所有实验相关的证据（供模型判断消融）
  const experimentEvidence = paper.evidenceRefs.filter(
    (e) => e.section === 'experiment' || e.section === 'limitation'
  )

  // ---- 3) 构造 Prompt ----
  const actionLabel =
    action === SurgeryAction.REMOVE
      ? '移除（Remove）'
      : action === SurgeryAction.DISABLE
        ? '禁用（Disable）'
        : '替换（Replace）'

  const paperText = paragraphs
    .map((p) => `[p${p.page}] ${p.text}`)
    .join('\n')
    .slice(0, 20000)

  const contextBlock = [
    `【论文标题】${paper.title}`,
    '',
    '【被操作的方法模块】',
    `- 名称：${block.name}`,
    `- 类型：${block.type}`,
    `- 描述：${block.description || '（原文未提供描述）'}`,
    `- 在方法中的作用：${block.role || '（原文未说明）'}`,
    '',
    `【操作】${actionLabel}`,
    note ? `【用户补充说明】${note}` : '',
    '',
    '【该模块自身的原文证据】',
    blockEvidence.length > 0
      ? blockEvidence.map((e) => `- [p${e!.pageNumber}] ${e!.quote}`).join('\n')
      : '（该模块没有关联到原文证据，请特别谨慎判断）',
    '',
    '【依赖关系】',
    dependents.length > 0
      ? `以下模块声明依赖被操作的模块：${dependents.map((d) => d.name).join('、')}`
      : '没有其他模块声明依赖该模块。',
    '',
    '【方法的整体结构】',
    `- 核心机制：${method.coreMechanism || '（未抽取）'}`,
    `- 其他模块：${method.blocks
      .filter((b) => b.id !== blockId)
      .map((b) => b.name)
      .join('、') || '（无）'}`,
    '',
    '【论文中与实验/局限相关的段落（供你判断是否存在消融证据）】',
    experimentEvidence.length > 0
      ? experimentEvidence
          .map((e) => `- [p${e.pageNumber}] ${e.quote}`)
          .join('\n')
      : '（论文中没有提取到实验相关证据）',
  ]
    .filter(Boolean)
    .join('\n')

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `${contextBlock}\n\n` +
        `===== 论文正文开始（供你核对原文）=====\n${paperText}\n===== 论文正文结束 =====`,
    },
  ]

  // ---- 4) 调用模型 ----
  const result = await callLLMStructured<RawSurgery>({
    messages,
    spec: SURGERY_SPEC,
    coerce: (raw) => raw as RawSurgery,
    maxAttempts: 3,
    temperature: 0.1,
        /**
     * ── P10 Step2：maxTokens 提升到 32000（对齐 method-dna）──
     *
     * 原因：hy3 等**推理模型**的 reasoning_content 与 content **共享**
     * max_tokens。原来的 6000~8000 是按非推理模型估的（假设回答独占预算），
     * 推理模型光思考就能吃掉 13k+ 字符，预算在写出正式回答前耗尽 →
     * finish_reason=length、content 为空 → 整次调用降级到 mock。
     *
     * 危险在于这是**静默**的：用户以为看到的是模型判断，
     * 实际拿到的是本地启发式结果。32000 给思考留足余量；
     * 真超限时 LLMError(kind=TRUNCATED) 会立刻失败而不是空转重试。
     */
    maxTokens: 32000,
    /** 总预算：避免多次超时叠加让用户干等 */
    totalBudgetMs: 300000,
    purpose: 'method-surgery',
  })

  const s = result.value
  const isMockMode = result.provider === 'mock'

  // ---- 5) 汇总证据 ----
  const allRaw: RawEvidence[] = [
    ...s.impacts.flatMap((i) => i.evidence ?? []),
    ...(s.ablationEvidence ?? []),
  ].filter((e) => e && typeof e.quote === 'string' && e.quote.trim().length >= 5)

  const seen = new Set<string>()
  const unique = allRaw.filter((e) => {
    const k = `${e.page}::${e.quote.slice(0, 100)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // 原文核对
  const normalizedFullText = paragraphs
    .map((p) => p.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()

  const verified = unique.map((e) => {
    const needle = e.quote
      .replace(/\s+/g, ' ')
      .replace(/^[^0-9A-Za-z\u4e00-\u9fa5]+/, '')
      .toLowerCase()
      .slice(0, 80)
    return {
      ...e,
      verified: needle.length >= 5 && normalizedFullText.includes(needle),
    }
  })

  const verifiedCount = verified.filter((v) => v.verified).length

  // ---- 6) verdict 降级规则 ----
  let verdict = normalizeVerdict(s.verdict)

  // 没有找到直接消融证据时，不允许给出过于肯定的结论
  if (!s.hasDirectAblation && !isMockMode) {
    if (verdict === SurgeryVerdict.PLAUSIBLE || verdict === SurgeryVerdict.INFEASIBLE) {
      verdict = SurgeryVerdict.INSUFFICIENT_EVIDENCE
    }
  }

  // 演示模式下统一降到 INSUFFICIENT_EVIDENCE（启发式不具备推理能力）
  if (isMockMode) {
    verdict = SurgeryVerdict.INSUFFICIENT_EVIDENCE
  }

  // 完全没有证据时强制降级
  const evidenceStatus: EvidenceStatus =
    verifiedCount === 0
      ? EvidenceStatus.INSUFFICIENT
      : isMockMode
        ? EvidenceStatus.UNCERTAIN
        : verifiedCount >= 2
          ? EvidenceStatus.CONFIRMED
          : EvidenceStatus.UNCERTAIN

  if (evidenceStatus === EvidenceStatus.INSUFFICIENT) {
    verdict = SurgeryVerdict.INSUFFICIENT_EVIDENCE
  }

  // ---- 7) 落库 ----
  const surgeryId = await prisma.$transaction(async (tx) => {
    // 清掉同模块同类型的旧手术记录，保证可重复执行
    const old = await tx.surgery.findMany({
      where: { methodId: method.id, description: `${actionLabel}:${blockId}` },
      select: { id: true },
    })
    if (old.length > 0) {
      await tx.surgeryLog.deleteMany({
        where: { surgeryId: { in: old.map((o) => o.id) } },
      })
      await tx.surgery.deleteMany({ where: { id: { in: old.map((o) => o.id) } } })
    }

    // 写证据
    const evidenceIdMap = new Map<string, string>()
    for (const e of verified) {
      const created = await tx.evidenceRef.create({
        data: {
          paperId: paper.id,
          source: EvidenceSource.PAPER_FACT,
          status: e.verified
            ? EvidenceStatus.CONFIRMED
            : EvidenceStatus.UNCERTAIN,
          quote: e.quote.slice(0, 1200),
          section: (e.section || 'body').trim().toLowerCase().slice(0, 40),
          pageNumber:
            Number.isFinite(e.page) && e.page >= 1
              ? Math.min(Math.floor(e.page), paper.pageCount ?? 9999)
              : null,
          confidence: e.verified ? (isMockMode ? 0.6 : 0.9) : 0.3,
        },
      })
      evidenceIdMap.set(`${e.page}::${e.quote.slice(0, 100)}`, created.id)
    }

    const idsFor = (list: RawEvidence[]): string[] =>
      (list ?? [])
        .map((e) => evidenceIdMap.get(`${e.page}::${e.quote.slice(0, 100)}`))
        .filter((id): id is string => Boolean(id))

    const surgery = await tx.surgery.create({
      data: {
        methodId: method.id,
        title: `${actionLabel} · ${block.name}`,
        description: `${actionLabel}:${blockId}`,
        verdict,
        evidenceStatus,
        evidenceIds: JSON.stringify([
          ...idsFor(s.impacts.flatMap((i) => i.evidence ?? [])),
          ...idsFor(s.ablationEvidence ?? []),
        ]),
        result: JSON.stringify({
          blockId,
          blockName: block.name,
          blockType: block.type,
          action,
          note: note ?? null,
          blockRole: s.blockRole,
          lostCapability: s.lostCapability,
          impacts: (s.impacts ?? []).map((i) => ({
            effect: i.effect,
            severity: normalizeSeverity(i.severity),
            rationale: i.rationale,
            evidenceIds: idsFor(i.evidence ?? []),
          })),
          ablationEvidenceIds: idsFor(s.ablationEvidence ?? []),
          hasDirectAblation: Boolean(s.hasDirectAblation),
          dependencyRisk: s.dependencyRisk,
          dependents: dependents.map((d) => ({ id: d.id, name: d.name })),
          verdict,
          verdictReason: s.verdictReason,
          uncertainties: (s.uncertainties ?? []).filter((u) => u && u.trim()),
          isMockMode,
          provider: result.provider,
          model: result.model,
          /** 明确标注这是模拟分析，不是实验结果 */
          disclaimer:
            '本结果为基于论文证据的结构化模拟分析，未进行任何模型重训练或实验验证。',
        }),
        logs: {
          create: [{ blockId, action }],
        },
      },
    })

    return surgery.id
  })

  return {
    surgeryId,
    methodId: method.id,
    paperId: paper.id,
    projectId: paper.projectId,
    provider: result.provider,
    model: result.model,
    verdict,
    evidenceCount: verified.length,
    evidenceStatus,
    uncertainties: (s.uncertainties ?? []).filter((u) => u && u.trim()),
  }
}
