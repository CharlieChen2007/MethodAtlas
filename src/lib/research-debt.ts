/**
 * Research Debt —— 研究债务（P4）
 *
 * 核心洞察（这是整个项目与"论文摘要工具"的分水岭）：
 *   一篇论文自述的局限，是**这篇论文**的缺点。
 *   但如果同一类局限被不同年份的多篇论文**反复**提到，那它就不再是
 *   某一篇的缺点，而是这个领域长期欠下的债 —— Research Debt。
 *
 * 所以本模块做的不是"提取局限性列表"，而是**跨论文聚类**：
 *   把 N 篇论文各自提到的局限，归并成 M 个（M << N）长期未解决的问题。
 *
 * 为什么这一步重要：
 *   Research Debt 是 candidate idea 的**合法性来源**。
 *   项目要求明确写了：Candidate Idea 必须来自 Method Blocks + Research Debt + Evidence。
 *   没有 Research Debt，所谓的"研究方向推导"就只是让模型自由发挥。
 *
 * 设计红线：
 *   1. occurrenceCount 必须真实反映"有几篇论文提到了它"，不许拍脑袋
 *   2. 每个 debt 必须能指回具体论文的具体原文（DebtSource + Evidence）
 *   3. 只被 1 篇论文提到的问题，evidenceStatus 只能是 UNCERTAIN ——
 *      它还不够格叫"领域欠下的债"
 *   4. 论文里已经解决的（Attempt 里标记为有效的）问题，不应再算作债务
 */

import { prisma } from './prisma'
import {
  DebtCategory,
  EvidenceSource,
  EvidenceStatus,
  parseJsonArray,
} from './enums'
import { callLLMStructured, type FieldSpec, type LLMMessage } from './llm'

// ===================== 类型 =====================

interface RawEvidence {
  quote: string
  page: number
  section: string
}

interface RawDebtSource {
  /** 论文在下方列表中的序号（从 0 开始） */
  paperIndex: number
  /** 这篇论文里如何描述该问题 */
  context: string
  evidence: RawEvidence[]
}

interface RawAttempt {
  paperIndex: number
  description: string
  /** 成功 / 部分成功 / 失败 / 引入新问题 */
  outcome: string
  evidence: RawEvidence[]
}

interface RawDebt {
  title: string
  description: string
  category: string
  /** 目前这个问题的状态：仍是公开问题 / 有部分进展 / 已被某篇论文缓解 */
  currentStatus: string
  sources: RawDebtSource[]
  attempts: RawAttempt[]
}

export interface RawDebtCluster {
  debts: RawDebt[]
  /** 为什么某些局限没有被聚成债务 */
  notes: string[]
}

export interface DebtExtractionResult {
  projectId: string
  provider: string
  model: string
  /** 参与聚类的论文数 */
  paperCount: number
  /** 聚合出的债务数 */
  debtCount: number
  /** 其中被多篇论文共同提到的（真正够格叫"领域债务"的） */
  crossPaperCount: number
  /** 记录了尝试解决的次数 */
  attemptCount: number
  evidenceCount: number
  skipped: number
  notes: string[]
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

const DEBT_SPEC: FieldSpec = {
  type: 'object',
  fields: {
    debts: {
      type: 'array',
      of: {
        type: 'object',
        fields: {
          title: { type: 'string', min: 4 },
          description: { type: 'string', min: 0 },
          category: { type: 'string' },
          currentStatus: { type: 'string', min: 0 },
          sources: {
            type: 'array',
            of: {
              type: 'object',
              fields: {
                paperIndex: { type: 'number' },
                context: { type: 'string', min: 0 },
                evidence: EVIDENCE_SPEC,
              },
            },
          },
          attempts: {
            type: 'array',
            of: {
              type: 'object',
              fields: {
                paperIndex: { type: 'number' },
                description: { type: 'string', min: 0 },
                outcome: { type: 'string' },
                evidence: EVIDENCE_SPEC,
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

const SYSTEM_PROMPT = `你是一位严谨的科研方法论分析专家，正在做一件事：**跨论文识别研究债务（Research Debt）**。

【什么是 Research Debt】
一篇论文自述的局限，是这篇论文的缺点。
但如果**同一类问题**被不同论文反复提到、在**当前收录文献范围内**始终未见解决，
它就不是某一篇的缺点，而是这个领域长期欠下的债 —— 这叫做 Research Debt。

⚠️ 范围纪律（必须遵守）：
  你只能看到**项目当前收录的这几篇论文**。所以任何关于"没人解决 / 尚未解决 /
  无人处理"的判断，都只能限定在这个范围内表达。
  正确说法：「在当前收录文献中未见解决」「这几篇论文都提到但都未给出方案」
  错误说法：「这个问题至今没人解决」「该领域尚未解决此问题」
  —— 后者是超出证据范围的断言：可能只是我们没检索到，而不是真的没人做。

你的核心任务不是"罗列局限性"，而是**归类合并**：
把 N 篇论文里散落的局限，归并成少数几个跨论文的长期问题。

【最重要的规则 —— 违反则输出作废】
1. **不要把每篇论文的局限原样复制成一条债务。** 同一个问题在不同论文里
   可能有不同说法（"计算开销大" / "retrieval cost grows linearly" / "expensive at scale"），
   它们是**同一个 debt**，必须合并，并在 sources 里列出各论文各自的描述。
2. **每个 debt 的 sources 至少要能追溯到具体原文。** 找不到原文依据的不要输出。
3. 如果某篇论文的局限确实**独此一家**（只被它提到），
   那也照实输出，但 sources 只有一条 —— 系统会自行降级它的可信度。
   你不需要为了凑数而强行合并，也不要为了合并而丢掉真实存在的独立问题。
4. **区分"提出问题"和"尝试解决"。**
   - sources 是"这篇论文承认存在该问题"
   - attempts 是"这篇论文尝试解决该问题"，并说明结果（成功/部分成功/失败/引入新问题）
   一个被反复尝试却始终没解决好的问题，才是最值得关注的债务。

【category 只能取以下之一】
GENERALIZATION    泛化性 —— 换领域/换分布就失效
COMPUTATION       计算成本 —— 太慢、太贵、显存放不下
DATA              数据 —— 依赖标注/依赖特定语料/数据稀缺
INTERPRETABILITY  可解释性 —— 说不清为什么有效
ROBUSTNESS        鲁棒性 —— 输入扰动下不稳定、易被攻击
EVALUATION        评测方法 —— 没有公认的评测方式、指标不可信
THEORY            理论保证 —— 缺乏理论分析或收敛性证明
OTHER             其他

【currentStatus 描述这条债务当前的状态】
例如："三篇论文均提及但均未解决" / "已有部分进展，但仅在特定条件下有效" /
"2023 年的工作缓解了计算开销，但泛化问题仍存在"
★ currentStatus 里同样要遵守范围纪律：写「当前收录文献中未见解决」，
  而不是「至今无人解决」（后者超出了你的可见范围）。

【输出格式】
只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：
{
  "debts": [
    {
      "title": "简短的问题标题（不超过 40 字）",
      "description": "这个跨论文问题的完整描述",
      "category": "COMPUTATION",
      "currentStatus": "当前状态描述",
      "sources": [
        {
          "paperIndex": 0,
          "context": "这篇论文里是怎么描述这个问题的",
          "evidence": [{"quote":"...","page":5,"section":"limitation"}]
        }
      ],
      "attempts": [
        {
          "paperIndex": 1,
          "description": "这篇论文尝试怎么解决",
          "outcome": "部分成功",
          "evidence": [{"quote":"...","page":8,"section":"experiment"}]
        }
      ]
    }
  ],
  "notes": ["哪些局限没有被聚成债务，以及原因"]
}

paperIndex 是论文在下方列表中的序号（从 0 开始）。
如果一篇论文的局限全部与其他人重复，那它应该出现在已有 debt 的 sources 里，而不是新建一条。
如果确实没有任何值得一提的跨论文问题，debts 返回空数组，并在 notes 里说明原因。`

// ===================== 辅助 =====================

function normalizeCategory(raw: string): DebtCategory {
  const v = (raw || '').trim().toUpperCase()
  const valid = Object.values(DebtCategory) as string[]
  return (valid.includes(v) ? v : DebtCategory.OTHER) as DebtCategory
}

/** 只保留有实际内容的证据项 */
function cleanEvidence(list: RawEvidence[] | undefined): RawEvidence[] {
  return (list ?? []).filter(
    (e) => e && typeof e.quote === 'string' && e.quote.trim().length >= 5
  )
}

/**
 * 把「局限相关」的原文段落挑出来喂给模型。
 *
 * 这里刻意覆盖三类来源：
 *   1. 各论文 limitations 字段（Method DNA 已抽取的自述局限）
 *   2. section 标记为 limitation / discussion / conclusion 的证据
 *   3. 正文里带转折词的句子（However / limitation / future work ...）
 * 三者合并去重，保证模型有足够素材做跨论文聚类。
 */
function collectLimitationContext(
  paragraphs: Array<{ page: number; text: string; section?: string }>,
  dnaLimitations: string[],
  limitationEvidence: Array<{ pageNumber: number | null; quote: string | null; section: string | null }>,
  maxChars = 3000
): string {
  const indicators = [
    'however',
    'limitation',
    'limited',
    'future work',
    'remains',
    'challenge',
    'difficulty',
    'struggle',
    'fail to',
    'cannot',
    'unable',
    'expensive',
    'costly',
    'scalab',
    'out of scope',
    'not address',
    'left for',
    'open problem',
    'remains open',
  ]

  const pieces: string[] = []
  let total = 0
  const push = (line: string) => {
    if (total + line.length > maxChars) return false
    pieces.push(line)
    total += line.length + 1
    return true
  }

  // 1) 自述局限优先
  for (const lim of dnaLimitations) {
    if (!lim || !lim.trim()) continue
    if (!push(`[自述局限] ${lim.trim()}`)) break
  }

  // 2) 证据里标记为 limitation 的原文
  for (const e of limitationEvidence) {
    if (!e.quote) continue
    if (!push(`[p${e.pageNumber ?? '?'}][${e.section ?? 'body'}] ${e.quote}`)) break
  }

  // 3) 正文里带转折词的段落
  for (const p of paragraphs) {
    const lower = p.text.toLowerCase()
    if (!indicators.some((k) => lower.includes(k))) continue
    if (!push(`[p${p.page}] ${p.text}`)) break
  }

  return pieces.join('\n')
}

// ===================== 主流程 =====================

/** 单篇论文提到的债务 —— 只算 UNCERTAIN，够不上"领域债务" */
const MIN_SOURCES_FOR_CONFIRMED = 2

export async function extractResearchDebt(
  projectId: string
): Promise<DebtExtractionResult> {
  // ---- 1) 取出项目内已有 Method DNA 的论文 ----
  const papers = await prisma.paper.findMany({
    where: { projectId, methodDNA: { isNot: null } },
    include: {
      methodDNA: true,
      evidenceRefs: true,
    },
    orderBy: [{ year: 'asc' }, { createdAt: 'asc' }],
  })

  if (papers.length < 2) {
    throw new Error(
      `至少需要 2 篇已抽取 Method DNA 的论文才能识别跨论文的研究债务（当前 ${papers.length} 篇）。` +
        `单篇论文的局限只是它自己的缺点，不构成领域债务。`
    )
  }

  // ---- 2) 构造论文上下文 ----
  const paperContext = papers
    .map((p, i) => {
      const dna = p.methodDNA!
      const blocks = parseJsonArray<string>(dna.limitations)
      return [
        `### [${i}] ${p.title}`,
        `- 年份：${p.year ?? '未知'}`,
        `- 任务：${dna.task || '（未抽取）'}`,
        `- 核心机制：${dna.coreMechanism || '（未抽取）'}`,
        `- 自述局限：${blocks.length > 0 ? blocks.join(' / ') : '（未抽取到自述局限）'}`,
      ].join('\n')
    })
    .join('\n\n')

  const paperTexts = papers
    .map((p, i) => {
      const dna = p.methodDNA!
      const paragraphs = parseJsonArray<{
        page: number
        text: string
        section?: string
      }>(p.rawText)

      const limitationEvidence = p.evidenceRefs.filter(
        (e) =>
          e.section === 'limitation' ||
          e.section === 'discussion' ||
          e.section === 'conclusion'
      )

      const ctx = collectLimitationContext(
        paragraphs,
        parseJsonArray<string>(dna.limitations),
        limitationEvidence
      )

      return `### [${i}] ${p.title}\n${ctx || '（未找到与局限相关的原文）'}`
    })
    .join('\n\n')

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `【论文列表（共 ${papers.length} 篇）】\n${paperContext}\n\n` +
        `【各论文中与局限/未解决问题相关的原文】\n${paperTexts}\n\n` +
        `请把这 ${papers.length} 篇论文提到的局限，归并成跨论文的研究债务。\n` +
        `记住：同一个问题在不同论文里的不同说法，必须合并成一条 debt，` +
        `并在 sources 里分别列出；不要把它们拆成多条。`,
    },
  ]

  // ---- 3) 调用模型 ----
  const result = await callLLMStructured<RawDebtCluster>({
    messages,
    spec: DEBT_SPEC,
    coerce: (raw) => raw as RawDebtCluster,
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
    purpose: 'research-debt',
  })

  const cluster = result.value
  const isMockMode = result.provider === 'mock'

  // ---- 4) 清掉旧的自动生成债务（保留人工确认过的 CONFIRMED） ----
  // 人工确认过的债务是用户的判断结果，不能被重新抽取覆盖掉。
  const manualDebts = await prisma.researchDebt.findMany({
    where: { projectId, evidenceStatus: EvidenceStatus.CONFIRMED },
    select: { id: true },
  })
  const keepIds = new Set(manualDebts.map((d) => d.id))

  const existing = await prisma.researchDebt.findMany({
    where: { projectId },
    select: { id: true },
  })
  const toDelete = existing.filter((d) => !keepIds.has(d.id)).map((d) => d.id)
  if (toDelete.length > 0) {
    await prisma.researchDebt.deleteMany({ where: { id: { in: toDelete } } })
  }

  // ---- 5) 逐条校验并落库 ----
  let debtCount = 0
  let crossPaperCount = 0
  let attemptCount = 0
  let evidenceCount = 0
  let skipped = 0

  for (const debt of cluster.debts ?? []) {
    const title = (debt.title ?? '').trim()
    if (title.length < 4) {
      skipped++
      continue
    }

    // ---- sources 校验：索引合法 + 去重 ----
    const rawSources = (debt.sources ?? []).filter((s) => {
      const idx = Math.floor(Number(s?.paperIndex))
      return Number.isInteger(idx) && idx >= 0 && idx < papers.length
    })

    // 同一篇论文在同一个 debt 里只保留一条 source
    const sourceByPaper = new Map<number, RawDebtSource>()
    for (const s of rawSources) {
      const idx = Math.floor(Number(s.paperIndex))
      const ev = cleanEvidence(s.evidence)
      const prev = sourceByPaper.get(idx)
      // 证据更多的那个优先
      if (!prev || cleanEvidence(prev.evidence).length < ev.length) {
        sourceByPaper.set(idx, s)
      }
    }

    const sources = Array.from(sourceByPaper.values())

    // 完全没有来源的债务 —— 拒绝落库（项目硬约束）
    if (sources.length === 0) {
      skipped++
      continue
    }

    // 没有任何一条来源带证据 —— 同样拒绝
    const hasAnyEvidence = sources.some(
      (s) => cleanEvidence(s.evidence).length > 0
    )
    if (!hasAnyEvidence) {
      skipped++
      continue
    }

    const occurrenceCount = sources.length
    const isCrossPaper = occurrenceCount >= MIN_SOURCES_FOR_CONFIRMED

    // ---- attempts 校验 ----
    const attempts = (debt.attempts ?? []).filter((a) => {
      const idx = Math.floor(Number(a?.paperIndex))
      return (
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < papers.length &&
        (a.description ?? '').trim().length > 0
      )
    })

    // ---- 证据强度判定 ----
    // 演示模式统一 UNCERTAIN；真实模式下：
    //   跨论文（>=2 篇）+ 有核对通过的原文 → CONFIRMED
    //   其余 → UNCERTAIN
    // 注意：这里绝不会是 INSUFFICIENT —— 上面已经拦掉了无证据的情况。
    let evidenceStatus: EvidenceStatus
    if (isMockMode) {
      evidenceStatus = EvidenceStatus.UNCERTAIN
    } else if (isCrossPaper) {
      evidenceStatus = EvidenceStatus.CONFIRMED
    } else {
      evidenceStatus = EvidenceStatus.UNCERTAIN
    }

    await prisma.$transaction(async (tx) => {
      const allEvidenceIds: string[] = []
      const sourceEvidenceIds: string[][] = []
      const attemptEvidenceIds: string[][] = []

      // 写 sources 的证据
      for (const s of sources) {
        const paper = papers[Math.floor(Number(s.paperIndex))]
        const text = paper.rawText
          ? parseJsonArray<{ page: number; text: string }>(paper.rawText)
              .map((p) => p.text)
              .join(' ')
              .replace(/\s+/g, ' ')
              .toLowerCase()
          : ''

        const ids: string[] = []
        for (const e of cleanEvidence(s.evidence)) {
          const needle = e.quote
            .replace(/\s+/g, ' ')
            .replace(/^[^0-9A-Za-z\u4e00-\u9fa5]+/, '')
            .toLowerCase()
            .slice(0, 80)
          const verified = needle.length >= 5 && text.includes(needle)

          const rec = await tx.evidenceRef.create({
            data: {
              paperId: paper.id,
              source: EvidenceSource.PAPER_FACT,
              status: verified
                ? EvidenceStatus.CONFIRMED
                : EvidenceStatus.UNCERTAIN,
              quote: e.quote.slice(0, 1200),
              section: (e.section || 'limitation').trim().toLowerCase().slice(0, 40),
              pageNumber:
                Number.isFinite(e.page) && e.page >= 1
                  ? Math.min(Math.floor(e.page), paper.pageCount ?? 9999)
                  : null,
              confidence: verified ? (isMockMode ? 0.6 : 0.9) : 0.3,
            },
          })
          ids.push(rec.id)
          allEvidenceIds.push(rec.id)
        }
        sourceEvidenceIds.push(ids)
      }

      // 写 attempts 的证据
      for (const a of attempts) {
        const paper = papers[Math.floor(Number(a.paperIndex))]
        const text = paper.rawText
          ? parseJsonArray<{ page: number; text: string }>(paper.rawText)
              .map((p) => p.text)
              .join(' ')
              .replace(/\s+/g, ' ')
              .toLowerCase()
          : ''

        const ids: string[] = []
        for (const e of cleanEvidence(a.evidence)) {
          const needle = e.quote
            .replace(/\s+/g, ' ')
            .replace(/^[^0-9A-Za-z\u4e00-\u9fa5]+/, '')
            .toLowerCase()
            .slice(0, 80)
          const verified = needle.length >= 5 && text.includes(needle)

          const rec = await tx.evidenceRef.create({
            data: {
              paperId: paper.id,
              source: EvidenceSource.PAPER_FACT,
              status: verified
                ? EvidenceStatus.CONFIRMED
                : EvidenceStatus.UNCERTAIN,
              quote: e.quote.slice(0, 1200),
              section: (e.section || 'experiment').trim().toLowerCase().slice(0, 40),
              pageNumber:
                Number.isFinite(e.page) && e.page >= 1
                  ? Math.min(Math.floor(e.page), paper.pageCount ?? 9999)
                  : null,
              confidence: verified ? (isMockMode ? 0.6 : 0.9) : 0.3,
            },
          })
          ids.push(rec.id)
          allEvidenceIds.push(rec.id)
        }
        attemptEvidenceIds.push(ids)
      }

      const created = await tx.researchDebt.create({
        data: {
          projectId,
          title: title.slice(0, 300),
          description: (debt.description ?? '').trim().slice(0, 2000),
          category: normalizeCategory(debt.category),
          currentStatus: (debt.currentStatus ?? '').trim().slice(0, 1000),
          occurrenceCount,
          evidenceIds: JSON.stringify(allEvidenceIds),
          evidenceStatus,
        },
      })

      // sources
      for (let k = 0; k < sources.length; k++) {
        const s = sources[k]
        const paper = papers[Math.floor(Number(s.paperIndex))]
        await tx.debtSource.create({
          data: {
            debtId: created.id,
            paperId: paper.id,
            context: (s.context ?? '').trim().slice(0, 1000),
            evidenceIds: JSON.stringify(sourceEvidenceIds[k] ?? []),
            evidenceStatus:
              (sourceEvidenceIds[k] ?? []).length > 0
                ? EvidenceStatus.UNCERTAIN
                : EvidenceStatus.INSUFFICIENT,
            // 把数据来源固化下来 —— 读侧（panel）据此决定要不要做规则归纳
            provider: result.provider,
          },
        })
      }

      // attempts
      for (let k = 0; k < attempts.length; k++) {
        const a = attempts[k]
        const paper = papers[Math.floor(Number(a.paperIndex))]
        await tx.attempt.create({
          data: {
            debtId: created.id,
            paperId: paper.id,
            description: (a.description ?? '').trim().slice(0, 1000),
            outcome: (a.outcome ?? '').trim().slice(0, 100) || '未说明',
            evidenceIds: JSON.stringify(attemptEvidenceIds[k] ?? []),
            evidenceStatus: EvidenceStatus.UNCERTAIN,
            provider: result.provider,
          },
        })
      }
    })

    debtCount++
    if (isCrossPaper) crossPaperCount++
    attemptCount += attempts.length
    evidenceCount += sources.reduce(
      (n, s) => n + cleanEvidence(s.evidence).length,
      0
    )
  }

  return {
    projectId,
    provider: result.provider,
    model: result.model,
    paperCount: papers.length,
    debtCount,
    crossPaperCount,
    attemptCount,
    evidenceCount,
    skipped,
    notes: (cluster.notes ?? []).filter((n) => n && n.trim()),
  }
}
