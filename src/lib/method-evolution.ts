/**
 * Method Evolution —— 方法演化关系抽取（P3）
 *
 * 双重定位（来自项目要求）：
 *   1. 直接响应比赛"技术演进梳理"的要求
 *   2. 作为能力连接器 —— 把 DNA / Block / Debt / Idea 各能力拓扑地串起来
 *
 * 设计原则（项目要求明确写了）：
 *   - 关系类型严格限制为 5 种：INHERIT / IMPROVE / REPLACE / BRANCH / COMBINE
 *   - **不要强行给所有论文建立关系**。没有明确证据就不连边，宁缺毋滥。
 *   - 每条关系都要有 Reason + Evidence + Confidence
 *   - 置信度过低的关系不落库
 */

import { prisma } from './prisma'
import {
  EvidenceSource,
  EvidenceStatus,
  RelationType,
  parseJsonArray,
} from './enums'
import { callLLMStructured, type FieldSpec, type LLMMessage } from './llm'

// ===================== 类型 =====================

interface RawEvidence {
  quote: string
  page: number
  section: string
}

interface RawRelation {
  sourceIndex: number
  targetIndex: number
  type: string
  reason: string
  confidence: number
  evidence: RawEvidence[]
}

interface RawEvolution {
  relations: RawRelation[]
  /** 为什么有些论文之间没有建立关系 */
  notes: string[]
}

export interface EvolutionResult {
  projectId: string
  provider: string
  model: string
  created: number
  skipped: number
  evidenceCount: number
  notes: string[]
}

// ===================== Schema =====================

const EVOLUTION_SPEC: FieldSpec = {
  type: 'object',
  fields: {
    relations: {
      type: 'array',
      of: {
        type: 'object',
        fields: {
          sourceIndex: { type: 'number' },
          targetIndex: { type: 'number' },
          type: { type: 'string' },
          reason: { type: 'string', min: 4 },
          confidence: { type: 'number' },
          evidence: {
            type: 'array',
            of: {
              type: 'object',
              fields: {
                quote: { type: 'string', min: 5 },
                page: { type: 'number' },
                section: { type: 'string' },
              },
            },
          },
        },
      },
    },
    notes: { type: 'array', of: { type: 'string', min: 0 } },
  },
}

// ===================== Prompt =====================

const SYSTEM_PROMPT = `你是一位严谨的科研方法分析专家，正在梳理一组论文之间的**方法演化关系**。

【核心判断：两种都算演化关系，不要只认第一种】
这组论文常常是**不同团队独立发表**的，彼此不会互相引用。它们在同一个研究领域里
围绕**同一个问题**给出**不同的解法**——这本身就是最典型的"问题驱动的演化"，
是本次要梳理的主要对象。所以关系成立的依据有**两层**：

  ★ 第一层（引用级）：原文明确说了"基于 X / 沿用 X / 不同于 X / 用 X 替代 Y"。
    这是最强证据，confidence 给 0.8~1.0。
  ★ 第二层（问题级）：两篇论文原文**没有互相引用**，但它们
    （a）在解决**同一个可辨识的研究问题**（同一个瓶颈/同一类失效/同一个成本约束），
    （b）各自给出的方法在机制上**可比**（一个是在另一个基础上改进 / 换了一条技术路线 /
         走向不同分支 / 组合了多个部分）。
    满足 (a)+(b) 就是一条**成立的关系**，不是编造——因为"围绕同一问题的方法演进"
    正是要展示的东西。这一层 confidence 给 0.5~0.75。

  ✘ 只有下面这种情况才**不成立**：
    · 两篇论文只是泛泛地同属一个大领域（如"都是深度学习"、"都做语音"），
      却**指不出共同的具体问题**，也说不出机制上的推进/分岔/替换关系。

  换句话说：**先问"它们是不是在打同一个问题"，再问"后者相对前者推进在哪"。
  两个问题都能答上来，就建立关系。** 不要因为它俩没互相引用就一律放弃。

【规则】
1. 每条关系都必须给出 evidence（原文片段 + 页码）。注意：evidence 是"这条关系的依据"，
   它可以来自**任一**相关论文的原文（不要求必须是被引用的那一方）——例如后者引言里
   描述的"现有方法面临的问题"，就是它相对前者推进的直接依据。
   完全找不到任何原文片段支撑的关系，**不要输出**。
2. 但**不要为了凑数建立关系**：答不上"共同问题 + 机制推进"这两问的，就不要连边。
3. reason 要具体——必须同时说清 **(a) 共同面对的问题** 和 **(b) 后者相对前者的推进**，
   而不是"都是做定位的"这类套话。
4. 一组 N 篇论文里的高频情形是"同一问题的不同解法"，会形成**多条边**（甚至一条链）。
   只要符合上面两层依据，就如实、充分地连出来——不要因为"不够确定"而全部省略，
   把判断权交给 confidence。

【五种关系类型，只能取以下之一】
INHERIT —— 后者继承了前者的方法框架（"基于 X 的方法"、"沿用 X 的架构"）
IMPROVE —— 后者针对前者的某个缺陷做了改进（指出了前者的不足并提出解决方案，
           或明确在同一个问题上做得更好）
REPLACE —— 后者用另一种机制替换了前者的某个组件（"用 X 替代 Y"，或在同一环节换了技术路线）
BRANCH  —— 后者是前者思路的一个分支变体（共享核心思路但走向不同方向）
COMBINE —— 后者组合了多个前序方法的不同部分

【confidence 取值 0~1】
0.8~1.0 引用级证据（原文有明确表述）
0.6~0.8 问题级 + 机制关系明确（共同问题清晰，推进方向也清楚）
0.5~0.6 问题级 + 机制关系需一定推断
< 0.5 **不要输出这条关系**

【输出格式】
只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：
{
  "relations": [
    {
      "sourceIndex": 0,
      "targetIndex": 1,
      "type": "IMPROVE",
      "reason": "共同问题：… ；推进：…",
      "confidence": 0.7,
      "evidence": [{"quote":"...","page":2,"section":"introduction"}]
    }
  ],
  "notes": ["哪些论文之间没有建立关系，以及原因"]
}

sourceIndex 和 targetIndex 是论文在下方列表中的序号（从 0 开始）。
方向约定：source 是更早/被继承的方法，target 是更晚/承接的方法。
如果没有发现任何明确的关系，relations 返回空数组，并在 notes 里说明。`

// ===================== 辅助 =====================

function normalizeRelationType(raw: string): RelationType | null {
  const v = (raw || '').trim().toUpperCase()
  const valid = Object.values(RelationType) as string[]
  return valid.includes(v) ? (v as RelationType) : null
}

/** 拿到论文中最能体现"与前置工作的关系"的段落 */
function relationRelevantText(
  paragraphs: Array<{ page: number; text: string }>,
  maxChars = 4000
): string {
  const indicators = [
    'unlike',
    'build upon',
    'building on',
    'based on',
    'extend',
    'extends',
    'improve',
    'inspired by',
    'in contrast',
    'prior work',
    'previous work',
    'follow',
    'combine',
    'replace',
    'in this work',
    'we propose',
    'we introduce',
  ]

  const hits: Array<{ page: number; text: string }> = []
  for (const p of paragraphs) {
    const lower = p.text.toLowerCase()
    if (indicators.some((k) => lower.includes(k))) {
      hits.push(p)
    }
  }

  // 没有命中就退化取前几页（引言通常有相关工作的定位）
  const pool = hits.length > 0 ? hits : paragraphs.slice(0, 30)

  const parts: string[] = []
  let total = 0
  for (const p of pool) {
    const line = `[p${p.page}] ${p.text}`
    if (total + line.length > maxChars) break
    parts.push(line)
    total += line.length + 1
  }
  return parts.join('\n')
}

// ===================== 主流程 =====================

/** 保守阈值：低于此置信度的关系不入库 */
const MIN_CONFIDENCE = 0.5

export async function extractEvolution(
  projectId: string
): Promise<EvolutionResult> {
  // ---- 1) 取出项目内已有 Method DNA 的论文 ----
  const papers = await prisma.paper.findMany({
    where: {
      projectId,
      methodDNA: { isNot: null },
    },
    include: {
      methodDNA: { include: { blocks: true } },
      evidenceRefs: true,
    },
    orderBy: { year: 'asc' },
  })

  if (papers.length < 2) {
    throw new Error(
      `至少需要 2 篇已抽取 Method DNA 的论文才能梳理演化关系（当前 ${papers.length} 篇）。`
    )
  }

  // ---- 2) 构造论文列表 ----
  const paperContext = papers
    .map((p, i) => {
      const dna = p.methodDNA!
      return [
        `### [${i}] ${p.title}`,
        `- 年份：${p.year ?? '未知'}`,
        `- 任务：${dna.task || '（未抽取）'}`,
        `- 核心问题：${dna.problem || '（未抽取）'}`,
        `- 核心机制：${dna.coreMechanism || '（未抽取）'}`,
        `- 方法模块：${dna.blocks.map((b) => b.name).join('、') || '（无）'}`,
      ].join('\n')
    })
    .join('\n\n')

  const paperTexts = papers
    .map((p, i) => {
      const paragraphs = parseJsonArray<{ page: number; text: string }>(p.rawText)
      return `### [${i}] ${p.title}\n${relationRelevantText(paragraphs)}`
    })
    .join('\n\n')

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `【论文列表】\n${paperContext}\n\n` +
        `【各论文的相关原文片段】\n${paperTexts}\n\n` +
        `请梳理这 ${papers.length} 篇论文之间的方法演化关系。记住：没有明确证据就不要建立关系。`,
    },
  ]

  // ---- 3) 调用模型 ----
  const result = await callLLMStructured<RawEvolution>({
    messages,
    spec: EVOLUTION_SPEC,
    coerce: (raw) => raw as RawEvolution,
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
    purpose: 'method-evolution',
  })

  const evo = result.value
  const isMockMode = result.provider === 'mock'

  /**
   * ── 调试开关：EVO_DEBUG=1 时打印模型原始输出 + 逐条放弃原因 ──
   *
   * 为什么需要它：用户问「关系为什么这么少」时，无法区分
   *   (a) 模型压根没输出几条  vs  (b) 模型输出了但被过滤掉
   * 这两种情况的处置完全相反（改 prompt vs 改过滤阈值），
   * 所以必须能看见原始输出。默认关闭，不影响正常链路。
   */
  const debug = process.env.EVO_DEBUG === '1'
  if (debug) {
    console.error('[evo-debug] papers(order used):')
    papers.forEach((p, i) => console.error(`  [${i}] year=${p.year} ${p.title.slice(0, 60)}`))
    console.error(`[evo-debug] model returned ${evo.relations?.length ?? 0} relations:`)
    for (const r of evo.relations ?? []) {
      console.error(
        `  ${r.sourceIndex}->${r.targetIndex} ${r.type} conf=${r.confidence} ev=${r.evidence?.length ?? 0}`
      )
    }
    if (evo.notes?.length) console.error('[evo-debug] notes:', evo.notes.join(' | '))
  }

  // ---- 4) 逐条校验并落库 ----
  let created = 0
  let skipped = 0
  let evidenceCount = 0

  // 清掉本项目旧的自动生成关系（保留人工确认过的）
  await prisma.relation.deleteMany({ where: { projectId } })

  // 同一对论文（无序）只保留一条关系 —— 去重，避免模型重复输出
  const pairSeen = new Set<string>()

  for (const rel of evo.relations ?? []) {
    // 索引合法性
    const si = Math.floor(rel.sourceIndex)
    const ti = Math.floor(rel.targetIndex)
    if (
      !Number.isInteger(si) ||
      !Number.isInteger(ti) ||
      si < 0 ||
      ti < 0 ||
      si >= papers.length ||
      ti >= papers.length ||
      si === ti
    ) {
      if (debug) console.error(`[evo-debug] skip: bad index ${si}->${ti}`)
      skipped++
      continue
    }

    const type = normalizeRelationType(rel.type)
    if (!type) {
      if (debug) console.error(`[evo-debug] skip: bad type "${rel.type}"`)
      skipped++
      continue
    }

    const confidence = Number(rel.confidence)

    // 置信度过低 —— 按项目要求不强行建立关系
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
      if (debug)
        console.error(`[evo-debug] skip: low confidence ${rel.confidence} (${si}->${ti})`)
      skipped++
      continue
    }

    const sourcePaper = papers[si]
    const targetPaper = papers[ti]

    // ---- 方向校验 ----
    // 方向约定：source 是更早/被继承的方法，target 是更晚/承接的方法。
    // 模型偶尔会把方向搞反，这里用年份做一次兜底：
    // 若 source 明显晚于 target，则交换两端，避免产出「倒流」的演化边。
    let src = sourcePaper
    let tgt = targetPaper
    let srcIdx = si
    let tgtIdx = ti
    if (
      sourcePaper.year != null &&
      targetPaper.year != null &&
      sourcePaper.year > targetPaper.year
    ) {
      // 年份更晚的不能当 source，交换
      ;[src, tgt] = [targetPaper, sourcePaper]
      ;[srcIdx, tgtIdx] = [ti, si]
    }

    // ---- 证据原文核对 ----
    const rawEv = (rel.evidence ?? []).filter(
      (e) => e && typeof e.quote === 'string' && e.quote.trim().length >= 5
    )

    // 证据可以在 src / tgt 两篇论文中任一篇里核对（交换方向后仍成立）
    const srcText = parseJsonArray<{ page: number; text: string }>(src.rawText)
      .map((p) => p.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()

    const tgtText = parseJsonArray<{ page: number; text: string }>(tgt.rawText)
      .map((p) => p.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()

    const verifiedEv = rawEv.map((e) => {
      const needle = e.quote
        .replace(/\s+/g, ' ')
        .replace(/^[^0-9A-Za-z\u4e00-\u9fa5]+/, '')
        .toLowerCase()
        .slice(0, 80)
      const inSource = needle.length >= 5 && srcText.includes(needle)
      const inTarget = needle.length >= 5 && tgtText.includes(needle)
      return {
        ...e,
        verified: inSource || inTarget,
        paperId: inTarget ? tgt.id : src.id,
      }
    })

    // 没有任何证据的关系 —— 拒绝落库（项目硬约束）
    if (verifiedEv.length === 0) {
      if (debug) console.error(`[evo-debug] skip: no evidence (${si}->${ti})`)
      skipped++
      continue
    }

    // 同一对论文只允许一条关系（无序去重）
    const pairKey = [srcIdx, tgtIdx].sort((a, b) => a - b).join('-')
    if (pairSeen.has(pairKey)) {
      if (debug) console.error(`[evo-debug] skip: duplicate pair ${pairKey}`)
      skipped++
      continue
    }
    pairSeen.add(pairKey)

    const verifiedOk = verifiedEv.filter((e) => e.verified).length

    // 演示模式统一降级为 UNCERTAIN
    const evidenceStatus: EvidenceStatus = isMockMode
      ? EvidenceStatus.UNCERTAIN
      : verifiedOk >= 1 && confidence >= 0.7
        ? EvidenceStatus.CONFIRMED
        : EvidenceStatus.UNCERTAIN

    await prisma.$transaction(async (tx) => {
      const idMap = new Map<string, string>()
      for (const e of verifiedEv) {
        const rec = await tx.evidenceRef.create({
          data: {
            paperId: e.paperId,
            source: EvidenceSource.PAPER_FACT,
            status: e.verified
              ? EvidenceStatus.CONFIRMED
              : EvidenceStatus.UNCERTAIN,
            quote: e.quote.slice(0, 1200),
            section: (e.section || 'body').trim().toLowerCase().slice(0, 40),
            pageNumber:
              Number.isFinite(e.page) && e.page >= 1 ? Math.floor(e.page) : null,
            confidence: e.verified ? (isMockMode ? 0.6 : 0.9) : 0.3,
          },
        })
        idMap.set(`${e.page}::${e.quote.slice(0, 100)}`, rec.id)
      }

      await tx.relation.create({
        data: {
          projectId,
          sourcePaperId: src.id,
          sourceMethodId: src.methodDNA!.id,
          targetPaperId: tgt.id,
          targetMethodId: tgt.methodDNA!.id,
          type,
          reason: rel.reason.trim().slice(0, 1000),
          confidence,
          evidenceIds: JSON.stringify(Array.from(idMap.values())),
          evidenceStatus,
        },
      })
    })

    created++
    evidenceCount += verifiedEv.length
  }

  return {
    projectId,
    provider: result.provider,
    model: result.model,
    created,
    skipped,
    evidenceCount,
    notes: (evo.notes ?? []).filter((n) => n && n.trim()),
  }
}
