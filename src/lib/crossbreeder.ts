/**
 * Crossbreeder —— 方法组合器（P4）
 *
 * 核心定位：
 *   把**不同论文**的 Method Blocks 重新组合，生成候选方案（Candidate Idea）。
 *
 * 这是整条价值链里最容易失控的一步 —— 因为"随便组合两个模块"能生成
 * 无穷多个听起来像那么回事的 idea。所以项目给了一条硬约束：
 *
 *   > Candidate Idea 必须来自 Method Blocks + Research Debt + Evidence
 *
 * 本模块把这条约束翻译成三道**强制关卡**：
 *   关卡 1（Block 合法性）：idea 引用的每个 blockId 必须真实存在于项目内，
 *                            且必须**至少来自 2 篇不同的论文** ——
 *                            否则它就只是"把同一篇论文的东西换个说法"，不是组合。
 *   关卡 2（Debt 合法性）：idea 必须关联至少一条 Research Debt，
 *                            并且要给出 why（为什么这个组合能解决这个债务）。
 *                            没有债务支撑的 idea 一律拒绝落库。
 *   关卡 3（证据合法性）：idea 必须能指回具体的原文证据。
 *
 * 只有三关全过才落库。任何一关不过 → 丢弃该 idea 并计入 skipped。
 * **宁可产出 0 个 idea，也不要产出漂亮的空话。**
 */

import { prisma } from './prisma'
import {
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

interface RawCandidate {
  title: string
  description: string
  /** 组合用到的模块，值是下方列表里的编号 */
  blockIndexes: number[]
  /** 想解决的债务，值是下方列表里的编号 */
  debtIndexes: number[]
  /** 为什么这个组合能解决该债务（必须具体，不能是套话） */
  why: string
  evidence: RawEvidence[]
}

interface RawCrossbreed {
  candidates: RawCandidate[]
  notes: string[]
}

export interface CrossbreedResult {
  projectId: string
  provider: string
  model: string
  /** 参与组合的模块数 / 债务数 */
  blockPoolSize: number
  debtPoolSize: number
  /** 落库的候选 idea 数 */
  created: number
  /** 被三道关卡拦下的数量 */
  skipped: {
    noBlocks: number
    singlePaper: number
    noDebt: number
    noEvidence: number
    invalid: number
  }
  /**
   * ── P11 问题 3 ──
   * 本次因标题与项目内已有想法重复而被跳过的候选数。
   * 旧想法一律保留（累积，不替换），重复候选只跳过不落库。
   */
  duplicates: number
  /**
   * ── P11 问题 3 ──
   * 落库完成后，项目内想法总数（含历史累积）。
   * 前端据此提示「当前共 N 个想法」。
   */
  totalIdeas: number
  evidenceCount: number
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

const CROSSBREED_SPEC: FieldSpec = {
  type: 'object',
  fields: {
    candidates: {
      type: 'array',
      of: {
        type: 'object',
        fields: {
          title: { type: 'string', min: 6 },
          description: { type: 'string', min: 0 },
          blockIndexes: { type: 'array', of: { type: 'number' } },
          debtIndexes: { type: 'array', of: { type: 'number' } },
          why: { type: 'string', min: 4 },
          evidence: EVIDENCE_SPEC,
        },
      },
    },
    notes: { type: 'array', of: { type: 'string', min: 0 } },
  },
}

// ===================== Prompt =====================

const SYSTEM_PROMPT = `你是一位资深科研人员，正在尝试提出**有依据的**候选研究方案（Candidate Idea）。

【你的素材只有三样，不允许引入第四样】
  A. 方法模块池（Method Blocks）—— 从多篇论文里拆出来的、可复用的方法组件
  B. 研究债务池（Research Debt）—— 被多篇论文反复提到、至今未解决的长期问题
  C. 原文证据（Evidence）

也就是说：**你提出的每个 idea，都必须是用现有模块去解决一个真实存在的债务。**
不能凭空想一个"如果……会不会更好"的方向。

【三道强制关卡 —— 系统会逐条检查，过不了直接丢弃】
关卡 1：你引用的模块**必须来自至少 2 篇不同的论文**。
        如果两个模块其实来自同一篇论文，那不是"组合"，是把作者自己的东西换个说法。
        ★ 每个模块在下方列表里都标注了「来自论文：XXX」——**输出前逐条核对**：
        把你要引用的所有 blockIndexes 对应的论文标题列一遍，数一数是不是 >= 2 篇。
        只有 1 篇的，直接不要输出这个候选（这是最常见的失败原因）。
关卡 2：你必须关联**至少一条**研究债务，并说清楚 why：这个组合为什么能解决它。
        说不出 why 的 idea 会被直接丢掉。
关卡 3：你必须给出证据（原文片段 + 页码），说明这些模块是什么、这个债务确实存在。
        ★★ 证据的 quote **必须是原文的逐字连续片段**（可以截取，但不要改写、
        不要翻译、不要自己组织语言、不要拼接不相邻的句子）。
        系统会把你的 quote 拿到论文原文里**做字符串比对**，对不上的一律作废。
        所以：请从上面「描述 / 作用 / 各论文的说法」里**原样复制**一段连续文字，
        而不是概括它。宁可引一小段真实的原文，也不要写一句漂亮的转述。

【why 必须写成四段式推理链 —— 这是本任务的核心，也是最容易糊弄的地方】
why 不是"一句解释"，而是一条**可被逐段核对的推理链**。必须按下面四段写，
每段都要写，顺序不能换，每段之间用换行分隔（不要写成一大段）：

  第 1 段 · 债务的具体缺口
      说出这个债务**具体卡在哪一步**。不要复述债务标题 —— 标题是概括，
      你要指出的是它的**症结**（"瓶颈在于每多检索一篇文档，解码成本线性增长"），
      而不是"这个问题很重要/尚未解决"。

  第 2 段 · 模块的关键特性
      说出你要用的那个模块**到底具备什么特性**，且这个特性是解决第 1 段缺口
      所必需的。要具体到机制层面（"它把 N 个段落的编码折叠成单个表示，
      使解码时的输入长度与检索篇数解耦"），不要写成"它很高效/很先进"。

  第 3 段 · 为什么能对上
      ★ 这是四段里唯一不能省的衔接段，也是绝大多数空话出现的地方。
      要明确说出：第 2 段的哪个特性，**以什么方式**补上第 1 段的哪个缺口。
      判据：把第 1 段和第 2 段单独放一起，读者应该还看不出来为什么能解决 ——
      第 3 段就是那个"所以"。如果你发现第 3 段只是把前两段重说一遍，
      说明你没有真正想清楚这个组合，那就应当**放弃这个候选**，
      而不是用一句套话把它写过去。

  第 4 段 · 可验证的预期
      给出一个**可以被实验证伪**的预期，写清"如果这个组合成立，应当观察到什么"。
      要提到可比的对象（相对于什么、在什么条件下）。禁止写"性能会提升"这种
      无法证伪的话 —— 它没有信息量。若你无法给出任何可证伪的预期，
      说明这个组合还没有形成假设，应当放弃。

【四段式示例（照着这个粒度写）】
  第 1 段：多文档问答里，检索篇数越多答案越准，但解码端要对每篇文档各跑一遍
          生成，成本随检索篇数线性上涨，限制了实际可用的检索规模。
  第 2 段：Fusion-in-Decoder 先把每篇文档**分别**编码，再把所有文档的
          编码结果**拼接后一次性交给解码器**，解码只跑一次。
  第 3 段：把解码次数从"与检索篇数成正比"压成常数次，正好消掉了第 1 段
          里那个线性项 —— 于是可以在同样算力预算下检索更多文档。
  第 4 段：若成立，在固定解码算力预算下增加检索篇数时，答案质量应当
          继续上升而不是持平，且这个趋势在长文档场景里更明显。

【最重要的要求：不要凑数】
- 如果你觉得素材之间**没有**值得组合的地方，就返回空的 candidates 数组。
  **0 个 idea 是一个可接受的、诚实的答案**；编 5 个空话才是失败。
- 不要提"需要重新设计一个新模块"这种 idea —— 那样它就脱离了 Block 池，
  违背了"方法组合器"的定义。你只能用池子里已有的模块。
- 写不出第 3 段（说清"为什么能对上"）的候选，请直接不要输出它。
  少而站得住 > 多而站不住。

【输出前的自检（必须逐条过一遍，不要跳过）】
对每个你准备输出的候选，回答下面三个问题，任何一个答案是"否"就**删掉这个候选**：
  Q1. 我引用的 blockIndexes 对应的论文标题，**去重后是否 >= 2 篇**？
      （只涉及 1 篇论文 → 删掉）
  Q2. 我引用的每一条 evidence 的 quote，是不是**原文里逐字连续的一段**？
      （如果是我概括/翻译/改写的 → 重新回到材料里复制一段真的原文）
  Q3. 我的 why 第 3 段，是不是真的说出了"某特性以某方式补上某缺口"，
      而不是把第 1、2 段重说一遍？（只是重说 → 删掉）
最后：**宁可只输出 1 个站得住的候选，也不要输出 3 个过不了关卡的候选。**

【输出格式】
只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：
{
  "candidates": [
    {
      "title": "方案标题（具体，不要写'一个改进方法'这种）",
      "description": "方案描述：把哪些模块、怎么组合、期望达到什么效果",
      "blockIndexes": [0, 3],
      "debtIndexes": [1],
      "why": "四段式推理链（用 \\n 分隔，四段都要有）：\n①债务的具体缺口：…\n②模块的关键特性：…\n③为什么能对上：第②段的哪个特性、以什么方式补上第①段的哪个缺口\n④可验证的预期：若成立应当观察到什么（相对于什么、在什么条件下）",
      "evidence": [{"quote":"...","page":2,"section":"method"}]
    }
  ],
  "notes": ["为什么某些模块/债务没有被用来组合"]
}

blockIndexes 和 debtIndexes 是下方列表中的编号（从 0 开始）。
如果确实没有值得组合的地方，candidates 返回空数组，并在 notes 里说明原因。`

// ===================== 辅助 =====================

function cleanEvidence(list: RawEvidence[] | undefined): RawEvidence[] {
  return (list ?? []).filter(
    (e) => e && typeof e.quote === 'string' && e.quote.trim().length >= 5
  )
}

/** 套话检测 —— why 里如果只有这些词，视为没说出实质内容 */
const VAGUE_WHY_PATTERNS = [
  /^可以提高(性能|效果|准确率)/,
  /^有助于(泛化|提升)/,
  /^能够(提升|改善)(性能|效果)/,
  /^(提升|改善|增强)(性能|效果|表现)/,
  /^更(好|优)(地)?(解决|处理)/,
]

/**
 * ── P10-S5：四段式推理链的结构校验 ──
 *
 * prompt 里已经要求 why 写成四段（缺口 / 特性 / 衔接 / 可验证预期），
 * 但**prompt 是请求，不是保证** —— 模型完全可能把四段压成一句
 * 或者干脆跳掉第 3 段。如果只在 prompt 里写、代码不查，那就等于
 * "要求写了，但没人执行"，用户最终看到的仍可能是一句空话。
 *
 * 所以这里做**结构性校验**（只查形状，不判内容质量 —— 语义质量
 * 由 prompt + 人工判断负责，代码判不了）：
 *   · 至少 3 段非空：给模型留一点容错（它可能把①和②合成一段）；
 *   · 总长度下限：太短必然缺内容；
 *   · 第 3 段（衔接段）必须存在且非空 —— 它是最容易缺失、也最关键的一段。
 *
 * 为什么用"段数"而不是关键词匹配：模型措辞千变万化，用关键词
 * （如匹配"为什么能对上"）会把措辞稍有不同但内容合格的候选误杀。
 * 段数是**形状**，稳定得多。
 */
/**
 * 四段式结构校验 —— 单独 export 是为了让回归脚本能直接验它
 * （`scripts/verify-s5-fourpart.cjs`）。这是本模块唯一被外部引用的辅助函数：
 * 四段契约横跨「prompt 文案 / 代码校验 / mock 产出」三处，
 * 只要有一处漂移就会出现"候选被静默丢光"这类无报错故障，
 * 所以必须能被独立测到。
 */
export function whyIsFourPart(why: string): { ok: boolean; reason?: string } {
  const parts = why
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length < 3) {
    return { ok: false, reason: `推理链只有 ${parts.length} 段（要求 4 段）` }
  }
  // 衔接段在末尾倒数第二段的位置最不稳，改成"必须有至少一段在讲衔接"
  const hasConnect =
    /(所以|因此|于是|正好|恰好|从而|这样一来|进而)/.test(why) ||
    /(补上|填补|消掉|抵消|化解|解耦|对上)/.test(why)
  if (!hasConnect) {
    return { ok: false, reason: '缺少第 3 段衔接（没有说清"为什么能对上"）' }
  }
  return { ok: true }
}

/** 同 whyIsFourPart：export 供回归脚本直接验证 mock 产出不会被静默丢弃。 */
export function whyIsVague(why: string): boolean {
  const t = why.trim()
  if (t.length < 10) return true
  if (VAGUE_WHY_PATTERNS.some((re) => re.test(t))) return true
  // S5：四段式结构不成立 → 视为"没说清"
  return !whyIsFourPart(t).ok
}

// ===================== 主流程 =====================

/** 单个 idea 最多引用多少个模块 / 债务 —— 避免"什么都想要"的大杂烩 */
const MAX_BLOCKS_PER_IDEA = 4
const MAX_DEBTS_PER_IDEA = 3

export async function crossbreed(
  projectId: string,
  options?: {
    maxIdeas?: number
    /**
     * ── 问题 4：用户主导的三栏工作台 ──
     *
     * 用户在画布上**自己挑**了要组合的 Block 与目标债务，这里把它们传进来。
     * 为空/未传 = 沿用原来的"全自动：全池 × 全池"行为。
     *
     * 为什么不做成"只能传"（强制用户选）：
     *   自动模式仍然是有价值的默认推荐 —— 用户可以先点「生成组合」看系统
     *   的建议，再动手改。产品原话是"系统可给默认推荐但用户可改"，
     *   所以两条路径都要在，而不是用一条替掉另一条。
     */
    blockIds?: string[]
    debtIds?: string[]
  }
): Promise<CrossbreedResult> {
  const maxIdeas = options?.maxIdeas ?? 5
  const pickedBlockIds = options?.blockIds?.filter(Boolean) ?? []
  const pickedDebtIds = options?.debtIds?.filter(Boolean) ?? []

  // ---- 1) 素材池 A：方法模块（跨论文） ----
  const blocks = await prisma.methodBlock.findMany({
    where: {
      method: { paper: { projectId } },
      // 用户在右栏挑了具体的 Block → 只取这些（空数组视为"没挑"，取全池）
      ...(pickedBlockIds.length > 0 ? { id: { in: pickedBlockIds } } : {}),
    },
    include: {
      method: { include: { paper: { include: { evidenceRefs: true } } } },
    },
    orderBy: { id: 'asc' },
  })

  // ---- 2) 素材池 B：研究债务 ----
  const debts = await prisma.researchDebt.findMany({
    where: {
      projectId,
      ...(pickedDebtIds.length > 0 ? { id: { in: pickedDebtIds } } : {}),
    },
    include: {
      sources: { include: { paper: { include: { evidenceRefs: true } } } },
      attempts: { include: { paper: true } },
    },
    orderBy: [{ occurrenceCount: 'desc' }, { id: 'asc' }],
  })

  if (blocks.length === 0) {
    throw new Error('项目内还没有方法模块，请先完成 Method DNA 抽取。')
  }
  if (debts.length === 0) {
    throw new Error(
      '项目内还没有识别出研究债务。Candidate Idea 必须建立在 Research Debt 之上，' +
        '请先执行「识别研究债务」。'
    )
  }

  // 项目内论文数须 >= 2，否则"跨论文组合"无从谈起
  const paperIds = new Set(blocks.map((b) => b.method.paper.id))
  if (paperIds.size < 2) {
    throw new Error(
      `跨论文组合至少需要 2 篇论文的方法模块（当前 ${paperIds.size} 篇）。`
    )
  }

  const skipped = {
    noBlocks: 0,
    singlePaper: 0,
    noDebt: 0,
    noEvidence: 0,
    invalid: 0,
  }

  // ---- 3) 构造 Prompt ----
  //
  // ── 关键：给模型**可逐字复制的英文原文片段**（P10 Step6 修）──
  //
  // 这里曾经只给模型中文的 description / role（那是 LLM 生成的中文摘要）。
  // 但关卡 3 的证据核对是拿 quote 去**论文英文原文**里做字符串比对 ——
  // 模型照着中文摘要"复制"，得到的必然是中文，永远比对不上，
  // 于是全部候选卡在 gate3b 被丢弃（实测 3/3 全废，生成 0 个 idea）。
  //
  // 修法：把每个模块自己的 EvidenceRef.quote（**逐字英文原文**）一并列出来，
  // 并明确指示"证据请从这里复制"。这样模型复制出来的就是能过比对真原文的片段。
  const evidenceByBlockId = new Map<string, string[]>()
  {
    // 按论文聚合 evidenceRef，供按 id 查找（quote 在库里可空，这里统一成空串过滤掉）
    const evById = new Map<string, { quote: string; pageNumber: number | null }>()
    for (const b of blocks) {
      for (const e of b.method.paper.evidenceRefs) {
        const q = (e.quote ?? '').trim()
        if (!q) continue
        evById.set(e.id, { quote: q, pageNumber: e.pageNumber })
      }
    }
    for (const b of blocks) {
      const ids = parseJsonArray<string>(b.evidenceIds)
      const quotes = ids
        .map((id) => evById.get(id))
        .filter((x): x is { quote: string; pageNumber: number | null } => Boolean(x))
        .map((x) => {
          const page = x.pageNumber ?? 1
          return `      · [p${page}] ${x.quote.replace(/\s+/g, ' ').slice(0, 220)}`
        })
      evidenceByBlockId.set(b.id, quotes)
    }
  }

  const blockList = blocks
    .map((b, i) => {
      const quotes = evidenceByBlockId.get(b.id) ?? []
      const lines = [
        `[${i}] ${b.name}（${b.type}）`,
        `    来自论文：${b.method.paper.title}（${b.method.paper.year ?? '年份未知'}）`,
        `    描述：${(b.description || '（原文未提供描述）').slice(0, 200)}`,
        `    作用：${(b.role || '（原文未说明）').slice(0, 200)}`,
      ]
      if (quotes.length > 0) {
        lines.push(`    原文片段（证据请从这里逐字复制）：`)
        lines.push(...quotes)
      }
      return lines.join('\n')
    })
    .join('\n')

  const debtList = debts
    .map((d, i) => {
      const src = d.sources
        .map((s) => {
          const lines = [
            `        · 《${s.paper.title}》：${s.context.slice(0, 160)}`,
          ]
          // 该债务来源的**逐字英文原文**（同样供证据复制用）
          const ids = parseJsonArray<string>(s.evidenceIds)
          const quotes = ids
            .map((id) => s.paper.evidenceRefs.find((e) => e.id === id))
            .filter((e): e is NonNullable<typeof e> => Boolean(e) && Boolean((e?.quote ?? '').trim()))
            .slice(0, 2)
            .map(
              (e) =>
                `          [原文·p${e.pageNumber ?? 1}] ${(e.quote ?? '')
                  .replace(/\s+/g, ' ')
                  .slice(0, 200)}`
            )
          lines.push(...quotes)
          return lines.join('\n')
        })
        .join('\n')
      return [
        `[${i}] ${d.title}（${d.category}｜${d.occurrenceCount} 篇论文提及）`,
        `    现状：${d.currentStatus || '（未说明）'}`,
        `    各论文的说法：`,
        src || '        （无）',
      ].join('\n')
    })
    .join('\n')

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `【素材池 A：方法模块（共 ${blocks.length} 个，来自 ${paperIds.size} 篇论文）】\n${blockList}\n\n` +
        `【素材池 B：研究债务（共 ${debts.length} 条）】\n${debtList}\n\n` +
        `请最多提出 ${maxIdeas} 个候选方案。\n` +
        `记住三条：模块必须跨论文、必须关联债务且说清 why、必须给证据。\n` +
        `★ 写 evidence 时，请从上面标着「[原文片段]」「[原文·pN]」的行里**逐字复制**一段\n` +
        `  连续英文原文（不要翻译成中文、不要自己概括），页码就写那个 pN。\n` +
        `如果素材之间没有值得组合的地方，就返回空数组 —— 这是可接受的答案。`,
    },
  ]

  // ---- 4) 调用模型 ----
  const result = await callLLMStructured<RawCrossbreed>({
    messages,
    spec: CROSSBREED_SPEC,
    coerce: (raw) => raw as RawCrossbreed,
    maxAttempts: 3,
    temperature: 0.3,
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
    purpose: 'crossbreeder',
  })

  const raw = result.value
  const isMockMode = result.provider === 'mock'

  /**
   * ── 调试开关：CB_DEBUG=1 时打印模型原始候选 + 逐条放弃原因 ──
   *
   * 用户问「为什么生成 0 个想法」时，必须能区分
   *   (a) 模型没输出候选  vs  (b) 输出了但三道关卡全没过
   * 处置方向相反，所以把原始输出和每道关卡的判定都打出来。
   * 默认关闭。
   */
  const debug = process.env.CB_DEBUG === '1'
  if (debug) {
    console.error(`[cb-debug] blocks=${blocks.length} debts=${debts.length}`)
    console.error(`[cb-debug] model returned ${raw.candidates?.length ?? 0} candidates:`)
    for (const cd of raw.candidates ?? []) {
      console.error(
        `  "${(cd.title ?? '').slice(0, 40)}" blocks=${JSON.stringify(cd.blockIndexes)} debts=${JSON.stringify(cd.debtIndexes)} ev=${cd.evidence?.length ?? 0}`
      )
    }
    if (raw.notes?.length) console.error('[cb-debug] notes:', raw.notes.join(' | '))
  }

  /**
   * ── P11 问题 3：累积而非替换 ──
   *
   * 旧实现：生成成功后 deleteMany 掉所有未确认旧想法 → 用户点 3 次「生成」，
   * 列表里永远只有最后一批。用户要求的是「每一次生成的想法都加入同一个列表」。
   *
   * 新实现：
   *   · 旧想法一律保留（包括未确认的 —— 确认与否不再影响存留）；
   *   · 用规范化标题做去重：模型若反复产出同名方案，只跳过并计入 duplicates，
   *     不覆盖、不删除已有记录；
   *   · seenTitles 在循环里动态扩充 → 同一批候选内部重复也会被拦下。
   */
  const existing = await prisma.candidateIdea.findMany({
    where: { projectId },
    select: { id: true, title: true },
  })
  const seenTitles = new Set(
    existing.map((e) => e.title.replace(/\s+/g, '').toLowerCase())
  )

  // ---- 5) 三道关卡逐条校验 ----
  let created = 0
  let duplicates = 0
  let evidenceCount = 0
  const notes: string[] = [...(raw.notes ?? []).filter((n) => n && n.trim())]

  const candidates = (raw.candidates ?? []).slice(0, maxIdeas)

  for (const cand of candidates) {
    const title = (cand.title ?? '').trim()
    const why = (cand.why ?? '').trim()

    if (title.length < 6) {
      if (debug) console.error(`[cb-debug] gate0 invalid title "${title}"`)
      skipped.invalid++
      continue
    }

    // ---- 关卡 0b：标题去重（P11 问题 3）----
    // 与已有想法或同批前序候选同名 → 跳过，不覆盖、不删除已有记录
    const normTitle = title.replace(/\s+/g, '').toLowerCase()
    if (seenTitles.has(normTitle)) {
      if (debug) console.error(`[cb-debug] gate0b duplicate title "${title.slice(0, 40)}"`)
      duplicates++
      continue
    }
    seenTitles.add(normTitle)

    // ---- 关卡 1：模块必须存在，且跨 >= 2 篇论文 ----
    const blockIdxs = Array.from(
      new Set(
        (cand.blockIndexes ?? [])
          .map((n) => Math.floor(Number(n)))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < blocks.length)
      )
    ).slice(0, MAX_BLOCKS_PER_IDEA)

    if (blockIdxs.length === 0) {
      if (debug) console.error(`[cb-debug] gate1 no blocks "${title.slice(0, 30)}"`)
      skipped.noBlocks++
      continue
    }

    const pickedBlocks = blockIdxs.map((i) => blocks[i])
    const distinctPapers = new Set(pickedBlocks.map((b) => b.method.paper.id))
    if (distinctPapers.size < 2) {
      // 同一篇论文的模块互相组合，不构成"跨论文组合"
      if (debug)
        console.error(
          `[cb-debug] gate1 single-paper "${title.slice(0, 30)}" (papers=${distinctPapers.size})`
        )
      skipped.singlePaper++
      continue
    }

    // ---- 关卡 2：必须关联债务，且 why 不能是套话 ----
    const debtIdxs = Array.from(
      new Set(
        (cand.debtIndexes ?? [])
          .map((n) => Math.floor(Number(n)))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < debts.length)
      )
    ).slice(0, MAX_DEBTS_PER_IDEA)

    if (debtIdxs.length === 0) {
      if (debug) console.error(`[cb-debug] gate2 no debt "${title.slice(0, 30)}"`)
      skipped.noDebt++
      continue
    }
    if (whyIsVague(why)) {
      if (debug)
        console.error(
          `[cb-debug] gate2 vague why "${title.slice(0, 30)}": ${whyIsFourPart(why).reason ?? ''}`
        )
      skipped.noDebt++
      continue
    }

    // ---- 关卡 3：必须有证据 ----
    const ev = cleanEvidence(cand.evidence)
    if (ev.length === 0) {
      if (debug) console.error(`[cb-debug] gate3 no evidence "${title.slice(0, 30)}"`)
      skipped.noEvidence++
      continue
    }

    // 证据必须能在**被引用模块所属论文**的原文中找到
    const allowedText = new Map<string, string>()
    for (const b of pickedBlocks) {
      const pid = b.method.paper.id
      if (allowedText.has(pid)) continue
      const text = parseJsonArray<{ page: number; text: string }>(
        b.method.paper.rawText
      )
        .map((p) => p.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .toLowerCase()
      allowedText.set(pid, text)
    }

    // 债务来源论文也允许作为证据出处（债务本身来自论文原文）
    for (const di of debtIdxs) {
      for (const s of debts[di].sources) {
        if (allowedText.has(s.paper.id)) continue
        const text = parseJsonArray<{ page: number; text: string }>(
          s.paper.rawText
        )
          .map((p) => p.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .toLowerCase()
        allowedText.set(s.paper.id, text)
      }
    }

    interface VerifiedEv extends RawEvidence {
      verified: boolean
      paperId: string
    }
    const verifiedEv: VerifiedEv[] = []
    for (const e of ev) {
      const needle = e.quote
        .replace(/\s+/g, ' ')
        .replace(/^[^0-9A-Za-z\u4e00-\u9fa5]+/, '')
        .toLowerCase()
        .slice(0, 80)

      if (needle.length < 5) continue

      let matchedPaperId: string | null = null
      for (const entry of Array.from(allowedText.entries())) {
        const [pid, text] = entry
        if (text.includes(needle)) {
          matchedPaperId = pid
          break
        }
      }

      if (matchedPaperId) {
        verifiedEv.push({ ...e, verified: true, paperId: matchedPaperId })
      }
    }

    // 一条都没核对上的 idea —— 拒绝落库
    if (verifiedEv.length === 0) {
      if (debug) {
        console.error(
          `[cb-debug] gate3b evidence UNVERIFIED "${title.slice(0, 30)}" — 引用模块所属论文 ${pickedBlocks
            .map((b) => b.method.paper.title.slice(0, 18))
            .join(' / ')}`
        )
        for (const e of ev) {
          const needle = e.quote
            .replace(/\s+/g, ' ')
            .replace(/^[^0-9A-Za-z\u4e00-\u9fa5]+/, '')
            .toLowerCase()
            .slice(0, 80)
          console.error(`      quote(${needle.length}): "${needle.slice(0, 70)}"`)
        }
      }
      skipped.noEvidence++
      continue
    }

    // ---- 三关全过，落库 ----
    const evidenceStatus: EvidenceStatus = isMockMode
      ? EvidenceStatus.UNCERTAIN
      : verifiedEv.length >= 2 && distinctPapers.size >= 2
        ? EvidenceStatus.CONFIRMED
        : EvidenceStatus.UNCERTAIN

    const newIdeaId = await prisma.$transaction(async (tx) => {
      const evidenceIds: string[] = []
      for (const e of verifiedEv) {
        const rec = await tx.evidenceRef.create({
          data: {
            paperId: e.paperId,
            source: EvidenceSource.LLM_SYNTHESIS,
            status: EvidenceStatus.CONFIRMED,
            quote: e.quote.slice(0, 1200),
            section: (e.section || 'method').trim().toLowerCase().slice(0, 40),
            pageNumber:
              Number.isFinite(e.page) && e.page >= 1 ? Math.floor(e.page) : null,
            confidence: isMockMode ? 0.6 : 0.9,
          },
        })
        evidenceIds.push(rec.id)
      }

      const idea = await tx.candidateIdea.create({
        data: {
          projectId,
          title: title.slice(0, 300),
          description: (cand.description ?? '').trim().slice(0, 3000),
          fromBlockIds: JSON.stringify(pickedBlocks.map((b) => b.id)),
          evidenceIds: JSON.stringify(evidenceIds),
          evidenceStatus,
        },
      })

      for (const di of debtIdxs) {
        await tx.candidateIdeaDebt.create({
          data: {
            ideaId: idea.id,
            debtId: debts[di].id,
            why: why.slice(0, 1000),
          },
        })
      }

      return idea.id
    })

    created++
    evidenceCount += verifiedEv.length
  }

  /**
   * ── P11 问题 3 ──
   * 旧的「删旧换新」事务已整体移除：新想法追加进列表，旧想法原样保留。
   * 用户手动删除/否决某个想法仍走 deleteIdeaAction / reviewIdeaAction。
   */
  if (duplicates > 0) {
    notes.push(
      `${duplicates} 个候选因标题与已有想法重复被跳过（已有想法全部保留）。`
    )
  }

  // ---- 6) 把被拦下的原因写成 notes，让用户看到系统真的在把关 ----
  const s = skipped
  if (
    s.singlePaper + s.noDebt + s.noEvidence + s.noBlocks + s.invalid >
    0
  ) {
    const parts: string[] = []
    if (s.singlePaper > 0)
      parts.push(
        `${s.singlePaper} 个候选被拦下：引用的模块全部来自同一篇论文，不构成跨论文组合`
      )
    if (s.noDebt > 0)
      parts.push(
        `${s.noDebt} 个候选被拦下：没有关联研究债务，或 why 是套话（说不清为什么能解决问题）`
      )
    if (s.noEvidence > 0)
      parts.push(`${s.noEvidence} 个候选被拦下：证据无法在原文中核对上`)
    if (s.noBlocks > 0) parts.push(`${s.noBlocks} 个候选被拦下：没有引用有效的模块`)
    if (s.invalid > 0) parts.push(`${s.invalid} 个候选被拦下：标题不合法`)
    notes.push('关卡拦截记录：' + parts.join('；'))
  }

  const totalIdeas = await prisma.candidateIdea.count({ where: { projectId } })

  return {
    projectId,
    provider: result.provider,
    model: result.model,
    blockPoolSize: blocks.length,
    debtPoolSize: debts.length,
    created,
    skipped,
    duplicates,
    totalIdeas,
    evidenceCount,
    notes,
  }
}
