/**
 * Method DNA 抽取服务（P2）
 *
 * 目标：把一篇论文的方法从"一段自然语言"变成"可分析、可比较、可组合的结构化对象"。
 *
 * 核心约束（来自项目要求）：
 *   1. 每一项重要结论都必须关联 Evidence（原文 quote + 页码 + 章节）
 *   2. 没有证据的字段不得编造 —— 留空并把问题记录到 uncertainties
 *   3. 证据不足时显式标记，而不是用看似合理的文字填补
 *   4. 落库前经过 Evidence 校验，不合格直接拒绝写入
 */

import { prisma } from './prisma'
import {
  EvidenceSource,
  EvidenceStatus,
  PaperStatus,
  BlockType,
  parseJsonArray,
  normalizeMethodStage,
} from './enums'
import { callLLMStructured, type FieldSpec, type LLMMessage } from './llm'
import { EvidencePolicyError } from './evidence'
// 与 mock 抽取器共用同一张「标题 → 章节」映射表，
// 保证 prompt 里写下的 `[section]` 标记和抽取侧识别的章节名完全一致。
import { headingToSection } from './llm-mock'

// ===================== 类型定义 =====================

interface RawEvidence {
  quote: string
  page: number
  section: string
}

interface RawField {
  value: string
  evidence: RawEvidence[]
}

interface RawBlock {
  name: string
  type: string
  description: string
  role: string
  /** 所属方法阶段，取值见 METHOD_STAGE_ORDER */
  stage: string
  /** 阶段内顺序，从 1 开始 */
  order: number
  evidence: RawEvidence[]
}

interface RawDNA {
  task: RawField
  problem: RawField
  coreMechanism: RawField
  blocks: RawBlock[]
  training: RawField
  inference: RawField
  computationalCost: RawField
  limitations: RawField[]
  uncertainties: string[]
}

export interface ExtractedDNA {
  paperId: string
  projectId: string
  provider: string
  model: string
  attempts: number
  evidenceCount: number
  blockCount: number
  evidenceStatus: EvidenceStatus
  warnings: string[]
  uncertainties: string[]
}

// ===================== JSON Schema（用于结构校验） =====================

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

const FIELD_SPEC: FieldSpec = {
  type: 'object',
  fields: {
    value: { type: 'string', min: 0 },
    evidence: EVIDENCE_SPEC,
  },
}

const DNA_SPEC: FieldSpec = {
  type: 'object',
  fields: {
    task: FIELD_SPEC,
    problem: FIELD_SPEC,
    coreMechanism: FIELD_SPEC,
    blocks: {
      type: 'array',
      of: {
        type: 'object',
        fields: {
          name: { type: 'string', min: 2 },
          type: { type: 'string' },
          description: { type: 'string', min: 0 },
          role: { type: 'string', min: 0 },
          stage: { type: 'string', min: 0 },
          order: { type: 'number' },
          evidence: EVIDENCE_SPEC,
        },
      },
    },
    training: FIELD_SPEC,
    inference: FIELD_SPEC,
    computationalCost: FIELD_SPEC,
    limitations: { type: 'array', of: FIELD_SPEC },
    uncertainties: { type: 'array', of: { type: 'string', min: 0 } },
  },
}

// ===================== Prompt 构造 =====================

const SYSTEM_PROMPT = `你是一位严谨的科研方法分析专家，负责把一篇论文的研究方法拆解成结构化对象（Method DNA）。

【最重要的规则 —— 违反则输出作废】
1. 只依据我提供的论文原文作答。原文没有写的，一律不要写。
2. 每一个字段都必须附带 evidence 数组，evidence 里的 quote 必须是**论文原文的连续片段**（可以截断，但不得改写、不得润色、不得翻译）。
3. 如果某个字段在原文中找不到支撑，就把它留空（value 设为空字符串，evidence 设为空数组），并在 uncertainties 数组里说明缺什么。**绝对不要用常识或推测填空。**
4. page 必须是你引用片段所在的页码（我会用 [pN] 标记页码）。
5. section 填写该片段所属章节，取值：abstract / introduction / method / experiment / limitation / body。

【Method Block 的拆分要求】
把方法拆成可以独立理解、比较、组合的模块。type 只能取以下之一：
ENCODER, DECODER, ATTENTION, LOSS, REGULARIZATION, SAMPLING, PRETRAIN, FINETUNE, AUGMENTATION, ARCHITECTURE, POSTPROCESS, OTHER
每个 block 要说明：它是什么（description）、它在整个方法里承担什么作用（role）。
不要为了凑数而拆分；只拆原文确实描述了的模块。
同一个 block 的 description 应当是**对该模块自身的概括**，而不是随手摘抄一句无关的话。
不同 block 不应引用同一句原文作为各自的主要依据 —— 如果某段话被一个模块占用了，就为其他模块另找依据；找不到就说明该模块证据不足。

【description 与 role 的分工 —— 这是最容易被写混的一处，务必区分】
description 与 role 不是同一件事换两种说法，它们回答的是**两个不同的问题**：

  · description 回答「**这个模块是什么**」—— 它的构成、机制、输入输出形态。
      例：'基于 DPR 的双编码器检索器，把问题与段落分别编码到同一向量空间。'

  · role 回答「**拿掉它，方法会失去哪一件能力**」—— 一句功能职责陈述。
      判据：写完后自问「移除它，什么会不 work？」能直接回答这个问题的才是 role。
      例：'负责从语料库中检索出与问题相关的段落。'

写 role 时的四条硬规矩（违反则视为该字段未完成）：
  1. **不要复述 description**。把 description 的同义改写当作 role 是最常见的错误，
     这种 role 不提供任何新信息。两者措辞必须有实质差异。
  2. **不要讲"它由哪些部分组成"或"它怎么做"**。那是 description 的职责。
     role 只讲"它承担什么职责"，不讲内部构造、不讲实现步骤、不讲用了什么模型。
  3. **一句话，以功能动词开头**（负责…／把…转成…／为…提供…／决定…／控制…）。
     不要写成"一个 XX 模块"这样的名词短语 —— 那种写法说了等于没说。
  4. **不要写"在方法中起重要作用/不可或缺"这类空话**。要具体到能力本身。
     若原文对该模块职责的描述确实不足以提炼出一句功能陈述，
     就把 role 留空字符串（空数组同理），并在 uncertainties 里说明，
     **绝不要用"起重要作用"之类的套话填空**。

对照示例（正确 vs 错误，来自同一句原文）：
  原文：'The retriever is a dense passage retriever (DPR) with a bi-encoder architecture,
        and the generator is a BART-large sequence-to-sequence model.'
  ✓ description: '双编码器稠密段落检索器（DPR），与 BART-large 生成器组合。'
  ✓ role:        '负责从语料库中检索出与问题相关的段落。'
  ✗ role:        '一个使用双编码器架构的稠密段落检索器。'   ← 这是在复述构成，等于 description
  ✗ role:        '在方法中承担关键的检索作用。'             ← 空话，没说失去了什么能力

【Method Block 的阶段归位（stage / order）】
每个 block 还必须标出它属于方法的哪个阶段（stage）和在该阶段内的先后顺序（order）。
stage 只能取以下之一（**按流程从先到后排列**）：
PROBLEM, INPUT, PREPROCESSING, CORE_METHOD, TRAINING, INFERENCE, EVALUATION
判定依据：**该模块在论文正文里出现/被描述的章节位置**。
- 描述问题动机的 → PROBLEM
- 描述输入数据形态的 → INPUT
- 描述输入如何被预处理/切分/编码成特征的 → PREPROCESSING
- 描述方法本体的主体组件（架构、注意力、检索器、解码器等）→ CORE_METHOD
- 描述训练目标、损失、优化、微调策略的 → TRAINING
- 描述推理/生成时如何运作的 → INFERENCE
- 描述评估协议、数据集、指标的 → EVALUATION
order 是**该模块在其所属阶段内部的顺序**，从 1 开始递增；不同阶段各自独立从 1 开始编号。

★★ 关于阶段覆盖：**尽力抽取，不要主动放弃** ★★
这七个阶段是"方法流程"的通用骨架，**不是每篇论文都必须凑齐七个**。
一篇论文实际覆盖哪些阶段，取决于它自己写了什么 —— 你的任务是把
**它真的写了的部分**尽量抽出来，而不是"拿不准就归到 CORE_METHOD"。

具体地：
1. **只要原文提到了某个阶段的内容，就要为它抽 block。**
   哪怕原文只有一句话、一个名词（例如只在正文出现一次 "we evaluate on NaturalQuestions"），
   也应当抽出对应的 EVALUATION 阶段 block，而不是因为"信息少"就放弃。
2. **不要把 stage 当成"不确定时的避难所"。**
   仅当某个模块**确实是方法本体组件、且无法归入任何更具体阶段**时才用 CORE_METHOD。
   把问题动机、评估协议这类内容硬塞进 CORE_METHOD 是错的 —— 它们各有归属。
3. **只有当原文完全没有涉及某个阶段时，才省略该阶段的 block。**
   "没写清楚" ≠ "没写"。前者应当抽取 + 在 uncertainties 里标注；
   后者才省略。

【输出前的逐阶段自检（必须执行，不要跳过）】
在最终确定 blocks 之前，请对**每一个你打算输出的 block** 反向检查一遍，
并按下面两个问题各问一次：

  问题 A：「我把它分到的这个 stage，是原文实际描述的位置吗？」
        —— 如果不是，改到正确的 stage。

  问题 B：「文章里还有没有**别的阶段**的内容，我漏抽了？」
        —— 逐阶段扫一遍：PROBLEM / INPUT / PREPROCESSING / CORE_METHOD /
           TRAINING / INFERENCE / EVALUATION
           只要扫到某个阶段**原文确实有内容**，就把它补成 block。

对每个"扫到了内容但证据不足以支撑一个 block"或"完全没扫到内容"的阶段，
**必须在 uncertainties 里写清楚是哪一种**，两种情形措辞不同：
  · 涉及但证据不足 → "原文提到了 XX 阶段（引用），但描述不足以支撑独立 block，故未拆分"
  · 完全未提及     → "原文未涉及 XX 阶段"
**不允许"什么都不说就跳过"** —— 用户看到图上少了某个阶段时，
必须能从 uncertainties 里区分"论文真没写"和"我们没抽好"。

【输出格式】
只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块。结构如下：
{
  "task":              { "value": "该论文要解决的任务，一句话", "evidence": [{"quote": "...", "page": 1, "section": "abstract"}] },
  "problem":           { "value": "该论文针对的核心问题，一句话", "evidence": [...] },
  "coreMechanism":     { "value": "核心机制，一到两句话", "evidence": [...] },
  "blocks":            [ { "name": "...", "type": "ATTENTION", "stage": "CORE_METHOD", "order": 1, "description": "这个模块是什么（构成/机制）", "role": "拿掉它会失去哪件能力——一句话、功能动词开头", "evidence": [...] } ],
  "training":          { "value": "训练策略", "evidence": [...] },
  "inference":         { "value": "推理策略", "evidence": [...] },
  "computationalCost": { "value": "计算成本", "evidence": [...] },
  "limitations":       [ { "value": "论文自述的局限", "evidence": [...] } ],
  "uncertainties":     [
    "某个字段/阶段因为原文没写所以没能填（例：原文未涉及 EVALUATION 阶段）",
    "某个阶段原文提到了但证据不足以支撑独立 block（例：原文提到在 NaturalQuestions 上评估，但未给出指标与协议，故未拆分评估 block）"
  ]
}`

/**
 * 把论文段落拼成带页码标记的文本，并按长度截断。
 *
 * 为什么逐段带上 `[section]` 标记（P7-1 修复）：
 *   mock 抽取器需要知道每句话出自哪个章节，才能把模块归到正确的 stage。
 *   此前 prompt 只带 `[pN]`，章节信息在整个链路里只以「独立成段的标题行」
 *   形式存在（解析服务会把 "2. Method" 切成单独一段），
 *   一旦被分块/拼接，标题行就可能丢失，下游只能靠关键词猜章节 ——
 *   于是所有模块都落到 method 段，stage 永远只有 1~2 种，
 *   泳道图因为凑不够 3 个阶段而始终降级成时间轴。
 *
 *   最稳的做法是在**证据源头**把章节固化成结构化标记：章节只取决于
 *   段落自身的文本形态，不依赖前面是否恰好出现了标题行，因此
 *   换论文、换领域、换解析结果都不会失效。
 *
 * 标记形如 `[p3][method] The retriever is a dense passage retriever...`，
 * 由 `buildMockDNA` 的 `stripSectionPrefix` 解析。
 * 真实模型同样能利用它来填写 evidence.section，比让它自己猜更可靠。
 */
function buildPaperText(
  paragraphs: Array<{ page: number; text: string }>,
  maxChars = 24000
): { text: string; truncated: boolean } {
  const parts: string[] = []
  let total = 0
  let truncated = false
  let current: string | null = null

  for (const p of paragraphs) {
    const head = headingToSection(p.text)
    if (head) current = head
    const line = `[p${p.page}]${current ? `[${current}]` : ''} ${p.text}`
    if (total + line.length > maxChars) {
      truncated = true
      break
    }
    parts.push(line)
    total += line.length + 1
  }

  return { text: parts.join('\n'), truncated }
}

// ===================== 业务规则校验 =====================

/** 把模型给的 block type 规整到合法集合，非法值退化为 OTHER */
function normalizeBlockType(raw: string): BlockType {
  const upper = (raw || '').trim().toUpperCase()
  const valid = Object.values(BlockType) as string[]
  return (valid.includes(upper) ? upper : 'OTHER') as BlockType
}

/** 页码兜底：模型可能给出越界或不存在的页码 */
function clampPage(page: number, maxPage: number): number | null {
  if (!Number.isFinite(page) || page < 1) return null
  if (maxPage > 0 && page > maxPage) return null
  return Math.floor(page)
}

// ===================== 主流程 =====================

/**
 * 对一篇论文抽取 Method DNA，并写入数据库。
 *
 * 落库前会校验：DNA 至少要有 1 条有效证据；否则拒绝写入并把论文标记为 FAILED。
 */
export async function extractMethodDNA(paperId: string): Promise<ExtractedDNA> {
  const paper = await prisma.paper.findUnique({ where: { id: paperId } })
  if (!paper) throw new Error(`论文不存在: ${paperId}`)

  const paragraphs = parseJsonArray<{ page: number; text: string }>(paper.rawText)
  if (paragraphs.length === 0) {
    await prisma.paper.update({
      where: { id: paperId },
      data: { status: PaperStatus.FAILED },
    })
    throw new Error('该论文没有可用的解析文本，无法抽取方法结构。请先确认 PDF 解析成功。')
  }

  const maxPage = paper.pageCount ?? Math.max(...paragraphs.map((p) => p.page))
  const { text, truncated } = buildPaperText(paragraphs)

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `论文标题：${paper.title}\n` +
        (truncated
          ? `注意：正文较长，以下为节选（前 ${text.length} 字符）。\n`
          : '') +
        `\n===== 论文正文开始 =====\n${text}\n===== 论文正文结束 =====`,
    },
  ]

  const result = await callLLMStructured<RawDNA>({
    messages,
    spec: DNA_SPEC,
    coerce: (raw) => raw as RawDNA,
    maxAttempts: 3,
    temperature: 0.1,
    /**
     * 为什么是 32000：
     *   推理型模型（hy3 等）的 reasoning_content 与 content **共享**这个预算。
     *   实测同一套 prompt：输入 1000 字符时思考用 ~3.5k tokens，
     *   输入 6000~24000 字符时思考用 ~5-6k，但个别论文会飙到 28k+，
     *   原来 8000 的预算直接被思考过程吃光，content 是空串 → 调用失败。
     *
     *   32000 对齐主流推理模型的 max_tokens 上限，能容纳正常量级的思考，
     *   同时（关键）配合 LLMError kind=TRUNCATED —— 真截断了会**立刻失败**，
     *   不再重试 3 次白等三轮推理。
     */
    maxTokens: 32000,
    /**
     * 总预算 5 分钟。单次推理 30~110 秒，够一次完整尝试 + 一次重试；
     * 再往上是异常，如实失败比让用户干等更有价值。
     */
    totalBudgetMs: 300000,
    purpose: 'method-dna-extraction',
  })

  const dna = result.value

  // ---------- 1) 收集全部证据，去重后统一落库 ----------
  const evidenceKey = (e: RawEvidence) => `${e.page}::${e.quote.slice(0, 120)}`

  const rawEvidenceList: RawEvidence[] = [
    ...dna.task.evidence,
    ...dna.problem.evidence,
    ...dna.coreMechanism.evidence,
    ...dna.blocks.flatMap((b) => b.evidence),
    ...dna.training.evidence,
    ...dna.inference.evidence,
    ...dna.computationalCost.evidence,
    ...dna.limitations.flatMap((l) => l.evidence),
  ].filter((e) => e && typeof e.quote === 'string' && e.quote.trim().length >= 5)

  const seen = new Set<string>()
  const uniqueEvidence: RawEvidence[] = []
  for (const e of rawEvidenceList) {
    const key = evidenceKey(e)
    if (seen.has(key)) continue
    seen.add(key)
    uniqueEvidence.push(e)
  }

  if (uniqueEvidence.length === 0) {
    await prisma.paper.update({
      where: { id: paperId },
      data: { status: PaperStatus.FAILED },
    })
    throw new Error(
      '抽取结果不含任何有效证据，已按规则拒绝写入数据库（不允许无证据的结论落库）。'
    )
  }

  // 校验：evidence 的 quote 必须能在原文里找到（防止模型编造原文）
  const fullText = paragraphs.map((p) => p.text).join(' ')
  const normalizedFullText = fullText.replace(/\s+/g, ' ').toLowerCase()

  const verifiedEvidence: Array<RawEvidence & { verified: boolean }> =
    uniqueEvidence.map((e) => {
      // 归一化后取前 80 字符作为指纹，去原文里核对是否真实存在。
      // 去掉开头的非字母数字字符（引号、连字符、项目符号等），避免因格式差异误判。
      const needle = e.quote
        .replace(/\s+/g, ' ')
        .replace(/^[^0-9A-Za-z\u4e00-\u9fa5]+/, '')
        .toLowerCase()
        .slice(0, 80)
      const verified =
        needle.length >= 5 && normalizedFullText.includes(needle)
      return { ...e, verified }
    })

  const verifiedCount = verifiedEvidence.filter((e) => e.verified).length

  // 演示模式（mock）下所有证据的置信度要显著低于真实模型，
  // 避免把启发式抽取的结果误当作可靠的模型输出。
  const isMockMode = result.provider === 'mock'
  const confirmedConfidence = isMockMode ? 0.6 : 0.95
  const unconfirmedConfidence = isMockMode ? 0.3 : 0.5

  // ---------- 2) 计算 DNA 整体证据强度 ----------
  const hasAllCoreFields = Boolean(
    dna.task.value.trim() &&
      dna.problem.value.trim() &&
      dna.coreMechanism.value.trim()
  )

  // 演示模式（mock）下，无论字段是否齐全，整体证据强度最高只能到 UNCERTAIN。
  // 理由：启发式抽取不具备语义理解能力，不该与真实模型的分析标同一档可信度。
  const dnaStatus: EvidenceStatus = isMockMode
    ? verifiedCount > 0
      ? EvidenceStatus.UNCERTAIN
      : EvidenceStatus.INSUFFICIENT
    : hasAllCoreFields && verifiedCount >= 3
      ? EvidenceStatus.CONFIRMED
      : verifiedCount > 0
        ? EvidenceStatus.UNCERTAIN
        : EvidenceStatus.INSUFFICIENT

  // ---------- 3) 落库（Evidence + DNA + Blocks 在同一事务内，保证一致性） ----------
  const evidenceIdByKey = new Map<string, string>()

  await prisma.$transaction(async (tx) => {
    // 重复抽取时保证幂等：先清掉旧结果
    await tx.methodDNA.deleteMany({ where: { paperId } })
    await tx.evidenceRef.deleteMany({ where: { paperId } })

    // 3.1 先写证据
    for (const e of verifiedEvidence) {
      const page = clampPage(e.page, maxPage)
      const section = (e.section || 'body').trim().toLowerCase().slice(0, 40)
      const created = await tx.evidenceRef.create({
        data: {
          paperId,
          source: EvidenceSource.PAPER_FACT,
          // 通过原文核对 → CONFIRMED；未通过 → UNCERTAIN（留作人工复核，不参与结论支撑）
          status: e.verified
            ? EvidenceStatus.CONFIRMED
            : EvidenceStatus.UNCERTAIN,
          quote: e.quote.slice(0, 1200),
          section,
          pageNumber: page,
          confidence: e.verified
            ? confirmedConfidence
            : unconfirmedConfidence,
        },
      })
      evidenceIdByKey.set(evidenceKey(e), created.id)
    }

    const idsFor = (list: RawEvidence[]): string[] =>
      list
        .map((e) => evidenceIdByKey.get(evidenceKey(e)))
        .filter((id): id is string => Boolean(id))

    // 3.2 Evidence 策略校验（引用的证据此时已存在，可以在事务内核对）
    //   R1 — 核心字段（Task / Problem / Core Mechanism）必须至少有一处证据支撑
    //   R3 — 整体证据强度不能是 INSUFFICIENT
    const coreEvidenceIds = [
      ...idsFor(dna.task.evidence),
      ...idsFor(dna.problem.evidence),
      ...idsFor(dna.coreMechanism.evidence),
    ]

    if (coreEvidenceIds.length === 0) {
      throw new EvidencePolicyError([
        {
          rule: 'R1_NO_EVIDENCE',
          message:
            'Method DNA 的 Task / Problem / Core Mechanism 均无证据支撑，已拒绝写入',
        },
      ])
    }

    if (dnaStatus === EvidenceStatus.INSUFFICIENT) {
      throw new EvidencePolicyError([
        {
          rule: 'R3_OBJECT_INSUFFICIENT',
          message: 'Method DNA 整体证据强度为 INSUFFICIENT，已拒绝写入',
        },
      ])
    }

    // 3.3 写入 DNA 与 Blocks
    await tx.methodDNA.create({
      data: {
        paperId,
        task: dna.task.value.trim(),
        problem: dna.problem.value.trim(),
        coreMechanism: dna.coreMechanism.value.trim(),
        training: dna.training.value.trim()
          ? JSON.stringify({ summary: dna.training.value.trim() })
          : null,
        inference: dna.inference.value.trim()
          ? JSON.stringify({ summary: dna.inference.value.trim() })
          : null,
        computationalCost: dna.computationalCost.value.trim() || null,
        limitations: JSON.stringify(
          dna.limitations.map((l) => l.value.trim()).filter(Boolean)
        ),
        uncertainties: JSON.stringify(
          (dna.uncertainties || []).filter((u) => u && u.trim())
        ),
        evidenceIds: JSON.stringify([
          ...idsFor(dna.task.evidence),
          ...idsFor(dna.problem.evidence),
          ...idsFor(dna.coreMechanism.evidence),
          ...idsFor(dna.training.evidence),
          ...idsFor(dna.inference.evidence),
          ...idsFor(dna.computationalCost.evidence),
        ]),
        fieldEvidenceIds: JSON.stringify({
          task: idsFor(dna.task.evidence),
          problem: idsFor(dna.problem.evidence),
          coreMechanism: idsFor(dna.coreMechanism.evidence),
          training: idsFor(dna.training.evidence),
          inference: idsFor(dna.inference.evidence),
          computationalCost: idsFor(dna.computationalCost.evidence),
        }),
        evidenceStatus: dnaStatus,
        blocks: {
          create: dna.blocks.map((b, blockIndex) => ({
            name: b.name.trim().slice(0, 200),
            type: normalizeBlockType(b.type),
            description: (b.description || '').trim().slice(0, 1000),
            role: (b.role || '').trim().slice(0, 500),
            dependencies: '[]',
            // 结构表达：stage 由模型按论文章节判定，非法值退化为 CORE_METHOD；
            // order 优先用模型给的阶段内序号，缺失时回退为该 block 在抽取结果中的全局下标。
            stage: normalizeMethodStage(b.stage),
            order: Number.isFinite(b.order) ? Math.max(0, Math.floor(b.order) - 1) : blockIndex,
            evidenceIds: JSON.stringify(idsFor(b.evidence)),
            evidenceStatus:
              idsFor(b.evidence).length > 0
                ? EvidenceStatus.CONFIRMED
                : EvidenceStatus.UNCERTAIN,
          })),
        },
      },
    })

    await tx.paper.update({
      where: { id: paperId },
      data: { status: PaperStatus.DNA_EXTRACTED },
    })
  })

  return {
    paperId,
    projectId: paper.projectId,
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
    evidenceCount: verifiedEvidence.length,
    blockCount: dna.blocks.length,
    evidenceStatus: dnaStatus,
    warnings: result.warnings,
    uncertainties: (dna.uncertainties || []).filter((u) => u && u.trim()),
  }
}
