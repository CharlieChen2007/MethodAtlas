/**
 * Mock LLM Provider
 *
 * 用途：在没有 API Key 的情况下也能跑通完整链路（开发 / 演示 / 自动测试）。
 *
 * 设计约束（重要）：
 *   - mock 返回的数据仅从传入的论文文本中做启发式抽取，**不是凭空捏造**，
 *     因此仍然能表达完整的 Evidence 结构（含 quote + 页码）。
 *   - mock 会在结果里明确标记 provider = mock，UI 上有显著提示，
 *     避免把演示数据误认为真实模型产出。
 *   - 一旦配置了真实 LLM_API_KEY，本文件不会被调用。
 */

import type { LLMCallOptions, LLMResult } from './llm'
import { stripInlineMarkers } from './lab/text-clean'

interface MockParagraph {
  page: number
  text: string
  /** 所属章节：abstract / introduction / method / experiment / limitation / … */
  section?: string
}

/**
 * 从 user message 里解析出我们塞进去的论文段落结构。
 *
 * provider 侧约定（P7-1 起）：
 *   `[p3][method] The retriever is a dense passage retriever...`
 *   行首可选带一个 `[section]` 标记 —— 由 buildPaperText 写入。
 *   早期的 `[p3] 文本内容` 仍然兼容（section 标记可选）。
 *
 * 为什么把 section 解析放在这里而不是靠 annotateSections 推断：
 *   annotateSections 依赖「标题独占一段」来切换当前章节，但段落是按行
 *   拼进 prompt 的，标题行一旦被分块逻辑吞掉，后续所有句子都会掉进
 *   guessSection() 的逐句关键词猜测，章节信息整段丢失。
 *   行首标记把章节绑定在**每一段自己身上**，不依赖前后文，稳妥得多。
 */
function parseParagraphsFromPrompt(prompt: string): MockParagraph[] {
  const results: MockParagraph[] = []
  const re = /^\[p(\d+)\](?:\[([a-z][a-z /-]{2,24})\])?\s*(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(prompt)) !== null) {
    results.push({
      page: Number(m[1]),
      text: m[3].trim(),
      section: m[2] ? m[2].trim().toLowerCase() : undefined,
    })
  }
  return annotateSections(results)
}

/**
 * 从段落里挑出最能代表某个语义角色的句子。
 *
 * mock 的目标不是"看起来像 AI 说的"，而是在不编造的前提下，
 * 尽量给出**能读得懂的概括性表述**。所以策略是：
 *   1. 优先选包含语义线索词、且长度适中的句子（完整句 > 断句）
 *   2. 去掉明显是引用/页眉的碎片
 *   3. 若实在找不到，宁可返回空，交由上层标记为"证据不足"
 */
/** 句子指纹：用于跨字段、跨模块的证据去重 */
function sentKeyOf(s: string): string {
  return s.slice(0, 70).toLowerCase()
}

/**
 * 判断一个片段是否适合作为原文引用。
 *
 * PDF 文本提取会把句子从中间切断，产生两类不可用的碎片：
 *   1. 标题碎片 —— 短、无句末标点、大量首字母大写
 *   2. 断裂句   —— 以连接词或小写词开头，缺主语
 *      （如 "and achieve state-of-the-art results when fine-tuned..."）
 * 这两类被当作"方法描述"引用时会让人看不懂，直接排除。
 */
function isQuotableSentence(s: string): boolean {
  if (s.length < 25) return false

  // 标题碎片
  const looksLikeHeading =
    !/[.!?]$/.test(s) &&
    (s.split(/\s+/).length < 12 ||
      (s.match(/\b[A-Z][a-z]/g) ?? []).length >= 4)
  if (looksLikeHeading) return false

  // 断裂句：首词是**连接词/关系代词**，或首字母小写。
  //
  // 注意不要把这几个词算进去：
  //   this / these / it / they / we / as / with / for / from / to / of / in / on / by
  // 它们完全可以作为正常句子的开头（"This wastes computation on easy queries…"
  // 就是一个完整句子）。把它们当作悬空标记会误杀大量有效证据。
  const firstWord = s.split(/\s+/)[0] ?? ''
  const danglingStart =
    /^(and|or|but|so|which|that|where|while|when|because|however|thus|therefore|also|then|hence|moreover|furthermore|additionally)$/i.test(
      firstWord
    ) || /^[a-z]/.test(firstWord)
  if (danglingStart) return false

  return true
}

/**
 * 判断一句话是不是「背景陈述」或「与前人对比」，而不是在描述本文的组件。
 *
 * 为什么需要这一步：`hasMethodVerb` 只检查有没有方法类动词，而描述前人工作、
 * 陈述动机的句子同样会用到 process / use / retrieve 这类动词，于是拿到同样的
 * 高分被选进 block 池。实测 23 个模块里有 10 个属于这种情况，模块名退化成
 * 句首片段（"However, their ability access and precisely"），结构图也就无从谈起。
 *
 * 三类要挡掉的句子：
 *   1. 纯背景   —— "Large pre-trained language models have been shown to …"
 *   2. 问题陈述 —— "However, their ability to … is still limited"
 *   3. 对比句   —— "Unlike RAG, which concatenates passages before encoding, …"
 *
 * 判定必须保守：只挡**句首**就暴露意图的句子。类似
 * "Unlike RAG, we process each passage independently" 这种句首对比、
 * 但主句在讲本文做法的，句首之后会出现 we / our / this paper，
 * 属于有效的方法描述，必须放行。
 */
function isBackgroundOrContrast(s: string): boolean {
  const t = s.trim()
  const lower = t.toLowerCase()

  // 本文自述的动作主体 —— 出现即认为句子在讲本文做了什么，优先放行
  const hasSelfSubject =
    /\b(we|our|this paper|this work)\b/i.test(lower) &&
    /\b(propose|introduce|present|design|develop|employ|use|construct|formulate|adopt|utilize|implement|apply|combine|train|process|encode|decode|decide|learn)\b/i.test(
      lower
    )

  // 1) 纯背景：句首直接指向"已有工作/大规模模型"的普遍能力
  const backgroundOpen =
    /^(large\s+)?(pre-?trained|neural|language)\s+(neural\s+)?(language\s+)?models?\b/i.test(t) ||
    /^(large pre-?trained|recent work|prior work|previous work|earlier work|existing (methods|approaches|work)|retrieval-augmented generation methods such|language models have been)/i.test(
      t
    )
  if (backgroundOpen) return true

  // 1b) 承接句：句首用指代代词承接上一句的主语。
  //     单独摘出来会失去指代对象，读起来是断片
  //     （"They can do so without any access to an external memory source"）。
  const anaphoricOpen = /^(they|it|these|those|such|this)\s/i.test(t)
  const anaphorHasSelfSubject = /\b(we|our)\b/i.test(lower)
  if (anaphoricOpen && !anaphorHasSelfSubject) return true

  // 2) 问题陈述：句首转折 + 句内描述缺陷，且没有本文的动作主体
  const contrastOpen = /^(however|but|although|though|nevertheless|yet|still)\b/i.test(t)
  if (contrastOpen && !hasSelfSubject) return true

  // 3) 对比句：句首 "Unlike/Instead of/Despite/In contrast to" 指向他人做法
  const unlikeOpen = /^(unlike|instead of|in contrast to|different from|contrary to|despite)\b/i.test(t)
  if (unlikeOpen && !hasSelfSubject) return true

  return false
}

function pickSentences(
  paragraphs: MockParagraph[],
  keywords: string[],
  maxSentences = 2,
  /** 已被其他字段占用的句子，不再重复选用 */
  exclude?: Set<string>,
  /** 优先/排斥的章节（用于避免把 limitation 的句子当成 core mechanism） */
  sectionPref?: { prefer?: string[]; avoid?: string[] }
): { text: string; page: number; section: string } | null {
  const candidates: Array<{ text: string; page: number; section: string; score: number }> = []

  for (const p of paragraphs) {
    const sec = sectionOf(p)
    // 章节标题段落不作为正文引用
    if (p.section?.startsWith('heading:')) continue

    // 按句号切句，保留完整句子
    const sentences = p.text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(isQuotableSentence)

    for (const s of sentences) {
      if (exclude && exclude.has(sentKeyOf(s))) continue
      const lower = s.toLowerCase()
      let score = 0
      for (const k of keywords) {
        if (lower.includes(k.toLowerCase())) score += 2
      }
      // 完整句子加分（有句号结尾）
      if (/[.!?]$/.test(s)) score += 1
      // 过长的句子略降权（通常是多句粘连）
      if (s.length > 320) score -= 2

      // 章节偏好：方法/引言里的句子才适合当"核心机制"，
      // 局限性/实验里的句子不适合 —— 否则会出现
      // "本方法的机制是……外部语料质量依赖"这种把缺陷当机制的错误。
      if (sectionPref?.avoid?.includes(sec)) score -= 5
      if (sectionPref?.prefer?.includes(sec)) score += 2

      if (score > 0) {
        candidates.push({
          text: s,
          page: p.page,
          section: sec,
          score,
        })
      }
    }
  }

  if (candidates.length === 0) return null

  candidates.sort((a, b) => b.score - a.score)

  // 取分数最高的若干句，去重后拼成一段概括
  const picked: string[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    const key = c.text.slice(0, 60).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(c.text)
    if (picked.length >= maxSentences) break
  }

  return {
    text: picked.join(' ').slice(0, 600),
    page: candidates[0].page,
    section: candidates[0].section,
  }
}

/**
 * 收集多条**互不重复**的高分句子（每条独立成条，不拼接）。
 *
 * 用于"局限性"这类天然是多条并列的字段 —— 把不同句子拼成一段会让语义失真
 * （例如把"延迟敏感场景受限"和"依赖语料质量"拼成一句）。
 * 宁可只给几条准确的，也不给一段拼凑的。
 */
function collectTopSentences(
  paragraphs: MockParagraph[],
  keywords: string[],
  max = 4,
  /** 已被其他字段占用的句子，不再重复选用 */
  exclude?: Set<string>
): Array<{ text: string; page: number; section: string }> {
  const pool: Array<{
    text: string
    page: number
    section: string
    score: number
  }> = []
  const seen = new Set<string>()

  for (const p of paragraphs) {
    if (p.section?.startsWith('heading:')) continue
    const sec = sectionOf(p)
    const sentences = p.text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(isQuotableSentence)
      .filter((s) => s.length >= 30)

    for (const s of sentences) {
      if (exclude && exclude.has(sentKeyOf(s))) continue
      const key = s.slice(0, 70).toLowerCase()
      if (seen.has(key)) continue

      const lower = s.toLowerCase()
      let score = 0
      for (const k of keywords) {
        if (lower.includes(k.toLowerCase())) score += 2
      }
      if (score > 0) {
        seen.add(key)
        pool.push({ text: s, page: p.page, section: sec, score })
      }
    }
  }

  pool.sort((a, b) => b.score - a.score)
  return pool
    .slice(0, max)
    .map(({ text, page, section }) => ({ text, page, section }))
}

function guessSection(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes('abstract')) return 'abstract'
  if (lower.includes('limitation')) return 'limitation'
  if (
    lower.includes('experiment') ||
    lower.includes('evaluate') ||
    lower.includes('dataset') ||
    lower.includes('result')
  )
    return 'experiment'
  if (
    lower.includes('method') ||
    lower.includes('architecture') ||
    lower.includes('we use') ||
    lower.includes('we propose')
  )
    return 'method'
  return 'body'
}

/**
 * 章节标题 → 规范名。
 *
 * 导出给 method-dna 使用（P7-1）：prompt 构造时需要把章节固化进每段的
 * `[section]` 标记，以保证章节信息不会因为标题行被切走而丢失。
 * 两边共用同一张映射表，避免 prompt 侧的章节名和抽取侧的章节名对不上。
 */
export function headingToSection(line: string): string | null {
  const s = line.trim().toLowerCase().replace(/^\d+[\.\)]?\s*/, '')
  if (/^abstract\b/.test(s)) return 'abstract'
  if (/^introduction\b/.test(s)) return 'introduction'
  if (/^(related\s+work|background)\b/.test(s)) return 'related-work'
  if (/^(method|methods|methodology|approach)\b/.test(s)) return 'method'
  if (/^(experiment|experiments|evaluation|results?|analysis)\b/.test(s)) {
    return 'experiment'
  }
  if (/^(limitation|limitations)\b/.test(s)) return 'limitation'
  if (/^(discussion|conclusion|conclusions)\b/.test(s)) return 'conclusion'
  if (/^(references|appendix)\b/.test(s)) return 'references'
  return null
}

/**
 * 为每个段落标注它所属的章节。
 *
 * 为什么不能只对单句做关键词猜测：
 *   Limitations 章节里的 "Our approach depends on the quality of the external
 *   corpus" 这句话本身不含 "limitation" 字样，单句判断会得到 'body'，
 *   于是它可能被当成"核心机制"引用 —— 把缺陷说成机制。
 *   解析服务已把章节标题切成独立段落，这里顺着段落顺序就能得到真实归属。
 */
function annotateSections(paragraphs: MockParagraph[]): MockParagraph[] {
  let current: string | null = null
  return paragraphs.map((p) => {
    const head = headingToSection(p.text)
    if (head) {
      current = head
      // 标题段落本身标记为标题，避免被当作正文引用
      return { ...p, section: 'heading:' + head }
    }
    return { ...p, section: current ?? guessSection(p.text) }
  })
}

/** 取段落的章节名（去掉 heading: 前缀） */
function sectionOf(p: MockParagraph): string {
  const s = p.section ?? 'body'
  return s.startsWith('heading:') ? s.slice(8) : s
}

/**
 * 解析段落行首的 `[section]` 标记（P7-1 新增）。
 *
 * 为什么需要：
 *   method-dna 现在把章节写进 prompt（`[p3][method] The retriever is ...`），
 *   但 buildMockDNA 的解析器只剥 `[pN]`，`[method]` 会留在句子正文里 ——
 *   既不干净（污染证据 quote），也用不上。
 *
 *   更关键的是：annotateSections 只认「独立成段的标题行」来切换 current
 *   section，而解析出的段落是**逐行**的，标题行一旦被切走，
 *   后面所有句子都掉进 guessSection() —— 那是逐句关键词猜测，
 *   无法稳定区分 abstract/introduction/method/experiment，
 *   于是所有 block 都被打成同一段，stage 退化成 1~2 种。
 *
 * 处理方式：
 *   `[method]` 这类形如纯小写英文单词的方括号标记就是章节名，直接取用；
 *   其它形式（`[p3]`、`[自述局限]`）不是章节，忽略。
 *   取到就剥掉前缀，让下游的句子切分、证据 quote 保持干净的原文。
 */
const SECTION_TAG = /^\[([a-z][a-z /-]{2,24})\]\s*(.*)$/

function stripSectionPrefix(p: MockParagraph): MockParagraph {
  if (!p.text) return p
  const m = p.text.match(SECTION_TAG)
  if (!m) return p
  return { ...p, text: m[2].trim(), section: m[1].trim().toLowerCase() }
}

// ============================================================================
// 领域无关的 Method Block 启发式抽取
//
// 旧版本使用固定 NLP/ML 关键词表（attention/encoder/retriever 等），导致非 NLP
// 领域论文（如室内定位、CV、机器人）命中率为 0。这里改为按「方法描述句」
// 的通用特征打分：章节位置、动词线索、技术名词密度、句长，从而任何领域
// 都能抽出可结构化的 Block。默认 type=OTHER，再通过少量领域无关模式推断类型。
// ============================================================================

const METHOD_VERBS = [
  'propose',
  'introduce',
  'design',
  'develop',
  'present',
  'employ',
  'construct',
  'formulate',
  'adopt',
  'utilize',
  'implement',
  'apply',
]

const SECTION_WEIGHT: Record<string, number> = {
  method: 3,
  introduction: 1.5,
  abstract: 1,
  body: 0,
  experiment: -1,
  limitation: -2,
  conclusion: -1,
}

/** 判断句子是否包含方法描述动词 */
function hasMethodVerb(s: string): boolean {
  const lower = s.toLowerCase()
  return METHOD_VERBS.some((v) => new RegExp(`\\b${v}[a-z]{0,3}\\b`).test(lower))
}

/** 统计技术名词密度：大写词组、连字符复合词、缩写 */
function techNounScore(s: string): number {
  const acronyms = (s.match(/\b[A-Z]{2,}\b/g) ?? []).length
  const hyphenTerms = (s.match(/\b[a-z]+-[a-z]+\b/g) ?? []).length
  const capitalizedPhrases = (s.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) ?? []).length
  return acronyms * 1.5 + hyphenTerms * 1 + capitalizedPhrases * 1
}

/**
 * 从方法描述句中推断 Block 名称（P7-0 修复）。
 *
 * 结构图的节点只能显示**一行标题**，所以名字必须是「这个模块叫什么」，
 * 而不是句首切片。旧实现兜底取「前 6 个实词」，对
 *   "The retriever is a dense passage retriever (DPR) with a bi-encoder…"
 * 会得到 "The retriever dense passage retriever with" —— 读起来是碎句。
 *
 * 按句子结构分三种模式依次尝试：
 *   A. 本文自述引入：「We propose X」「We introduce X」        → 取 X
 *   B. 主语是模块  ：「The retriever is a dense passage…」     → 取 is/a 之后的核心名词短语
 *   C. 其它        ：取句首的名词短语（到第一个动词为止）
 * 都失败才退回旧的前 N 词策略，保证永远有名字可用。
 */
/**
 * 主语提取 —— 找出句子里"在讲哪个组件"（P7-0 重构）。
 *
 * 为什么改成「先定位主语，再以它为单位成块」：
 *   旧实现是「先按句子成块，再从句子里猜名字」，于是出现两种坏结果：
 *     1. 背景句/对比句也被当成模块（已在 isBackgroundOrContrast 拦掉）；
 *     2. 命名只能拿到句首切片（"used to retrieve text documents z"）。
 *   模块的本质是**句子谈论的那个组件**，所以先定位主语这个动作本身
 *   就同时解决了"要不要成块"和"叫什么名"两个问题。
 *
 * 返回 null 表示这句话没有可识别的组件主语（纯背景、纯过程描述等），
 * 此时**不生成模块** —— 少一个模块比多一个假模块好。
 */

/** 不该充当模块名的主语（代词 / 回指 / 空主语） */
const NON_MODULE_SUBJECT =
  /^(we|our|it|its|they|their|them|this|that|these|those|he|she|one|ones|there|here|such|both|all|none|some|many|most|each|every|however|but|although|though|while|unlike|instead|despite|furthermore|moreover|additionally|therefore|thus|hence|finally|first|second|third|next|then|also|another|the same|a number|several|various|different|recent|prior|previous|earlier|existing|large|large-scale|pre-trained neural language models|language models|neural language models|pre-trained language models)$/i

/** 谓语起头标记：名词短语到此为止 */
const PREDICATE_START =
  /\s+(?:is|are|was|were|be|been|being|has|have|had|uses?|used|using|can|could|will|would|may|might|must|should|does|do|did|trains?|processes|encodes|decodes|combines|improves|shows|allows|enables|takes|gives|makes|provides|requires|needs|learns|retrieves|generates|consists?|refers?|performs|produces|yields|reduces|increases|achieves|treats|computes|applies|adopts|introduces|proposes|presents|designs|develops|represents|denotes|means|follows|defer|deferred|fuses|fused|encoded|passed|concatenated|computed|fed|sees|seeks|serves|acts|works|operates|handles|tackles|addresses|mitigates|leverages|utilizes|employs|builds|constructs|considers|assumes|defines|specifies|describes|reports|notes|suggests|indicates|implies|requires)\b/i

/** 判断一个短语是否像"组件名" */
function looksLikeModuleName(phrase: string): boolean {
  const p = phrase.trim()
  if (p.length < 3 || p.length > 80) return false
  const words = p.split(/\s+/)
  if (words.length === 0 || words.length > 7) return false
  // 不能全是停用词
  const contentWords = words.filter((w) => w.length > 2)
  if (contentWords.length === 0) return false
  return true
}

/** 去掉限定词、收尾标点，规整空白 */
function cleanPhrase(v: string): string {
  return v
    .replace(
      /^\s*(?:a|an|the|our|this|that|these|those|its|their|each|every|all|any|some)\s+/i,
      ''
    )
    .replace(/[，,.;:!?]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从一句话里找出它谈论的组件主语。
 *
 * 支持三类句式：
 *   1. 「We propose/introduce X」        → 取 X（本文自述引入的核心组件）
 *   2. 「X is/uses/does …」             → 取主语 X（X 即模块）
 *   3. 「The retriever is a DPR …」      → 取主语；若谓语是定义式，取谓词中的名词短语
 *
 * 返回 null 表示这句话不适合作为一个模块。
 *
 * 已知局限（P7-0 未能解决，留待真实模型抽取）：
 *   这是一个纯正则函数，输入只有一句话，无法真正判断"这句话的主语是不是一个
 *   组件"。对 "The input sequence x is used to retrieve…" 这类**被动语态**
 *   句子会取到谓语片段（"used to retrieve text documents z"）。
 *   要根治需要成分句法分析或语义判断，已超出正则的能力边界 ——
 *   按"证据不足不硬凑"的原则，此处不再继续堆叠规则。
 */
function extractBlockSubject(s: string): string | null {
  const text = s.trim()

  // --- 1) 本文自述引入：「We propose X」 ---
  const intro = text.match(
    /\b(?:propose|introduce|present|design|develop|construct|formulate)\s+(?:a|an|the)?\s*([^,.;:!?]{4,80})/i
  )
  if (intro) {
    const phrase = cleanPhrase(intro[1].split(/\s+(?:which|that|where|who)\s/i)[0])
    if (looksLikeModuleName(phrase)) return phrase
  }

  // --- 2) 主语即模块：句首名词短语，到谓语为止 ---
  // 只接受真正以名词短语起头的句子（首字母大写或限定词 + 名词）
  const subjectMatch = text.match(
    /^((?:the|a|an|our|this|each|every|all)\s+)?([A-Za-z][\w()\-]*(?:\s+(?:[A-Za-z][\w()\-]*|of|for|in|on|to|with|by|from|as)){0,6})/
  )
  if (subjectMatch) {
    const head = (subjectMatch[1] ?? '') + subjectMatch[2]
    // 先按谓语切段，再判断段首词是不是可作模块名的名词
    const phraseBeforeVerb = head.split(PREDICATE_START)[0]
    const subject = cleanPhrase(phraseBeforeVerb)

    // 检查**段首词**是否是代词/连词 —— 是则整句不适合当作模块
    const headWord = subject.split(/\s+/)[0] ?? ''
    if (NON_MODULE_SUBJECT.test(headWord)) return null

    // 2b) 定义式谓语：「X is a/an <名词短语>」——谓词更具体时改用它
    const defin = text.match(/^[^,.;:!?]{2,70}?\s+(?:is|are)\s+(?:a|an|the)?\s*([^,.;:!?]{4,70})/i)
    let candidate = subject
    if (defin) {
      const predicate = cleanPhrase(
        defin[1].split(/\s+(?:which|that|where|who|with\s+(?:a|an|the))\s/i)[0]
      )
      if (looksLikeModuleName(predicate) && predicate.length >= 8) {
        candidate = predicate
      }
    }

    if (looksLikeModuleName(candidate)) return candidate
  }

  return null
}

/**
 * 兼容旧调用点：拿不到可信主语时退化为"句首名词短语"。
 *
 * 为什么不返回 'Method Component' 这类占位符：
 *   结构图的节点必须显示**一行标题**（纠偏方案 2.2）。占位符会让多个节点
 *   标题完全相同，用户无法区分，比一个不完美但唯一的标题更糟。
 *   所以兜底取句首的实词串 —— 可能不是理想的模块名，但至少有辨识度，
 *   且完整语义仍保留在 description 里，点开节点即可看到。
 */
function inferBlockName(s: string): string {
  // 先取主语候选（可能是完整句子片段），再统一交给名字规范化管线：
  //   - 已经合格的短名词（Fusion-in-Decoder / Self-RAG）原样保留
  //   - 超过 30 字符的句子片段 → 缩写 (全称)
  //   - 纯功能词 / 全是动词的片段 → 空串
  const subject = extractBlockSubject(s)
  const normalized = normalizeBlockName(subject || s, s)
  if (normalized) return normalized

  // 兜底：句首名词性实词（跳过代词/连词/谓语动词），最多 4 个
  const SKIP =
    /^(we|our|this|that|these|those|it|they|their|each|every|unlike|instead|despite|however|but|although|though|while|both|all|some|many|most|such|other|another|the|a|an|and|or|so|also|then|thus|hence|moreover|furthermore|additionally|when|where|which|is|are|was|were|be|been|being|used|encoded|encoded|design|can|may|might|must|should)$/i
  const words = s
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z-]/g, ''))
    .filter((w) => w.length > 2 && !SKIP.test(w))
  const fallback = words.slice(0, 4).join(' ')

  // 问题 1：兜底也不允许产出「被截断的英文原句」。
  // 只有在兜底结果本身也通过规范化校验时才采用；否则返回空串，
  // 由调用方**丢弃这个 block**（宁缺勿滥），而不是塞一段半截句子当名字。
  if (fallback) {
    const rescued = normalizeBlockName(fallback, '')
    if (rescued) return rescued
  }
  return ''
}

/** 根据少量领域无关关键词推断 Block 类型；未命中则 OTHER */
function inferBlockType(s: string): string {
  const lower = s.toLowerCase()
  if (/\battention\b/.test(lower)) return 'ATTENTION'
  if (/\bencoders?\b|\bencoding\b/.test(lower)) return 'ENCODER'
  if (/\bdecoders?\b|\bdecoding\b/.test(lower)) return 'DECODER'
  if (/\b(fine-tun|finetun|pre-train|pretrain)\b/.test(lower)) return 'FINETUNE'
  if (/\b(pre-train|pretrain)\b/.test(lower)) return 'PRETRAIN'
  if (/\b(loss|objective|likelihood|gradient|optimi)\b/.test(lower)) return 'LOSS'
  if (/\b(dropout|regulari|weight decay|normali)\b/.test(lower)) return 'REGULARIZATION'
  if (/\b(augment|synthetic data|data generation)\b/.test(lower)) return 'AUGMENTATION'
  if (/\bsampl(ing|er|e)\b/.test(lower)) return 'SAMPLING'
  if (/\b(inference|latency|test-time|deploy|serving)\b/.test(lower)) return 'ARCHITECTURE'
  if (/\b(post-process|postprocess)\b/.test(lower)) return 'POSTPROCESS'
  return 'OTHER'
}

/** 问题 2：角色提炼规则已抽到独立模块，供数据层与维护脚本共用。 */
import { deriveBlockRole } from './lab/block-role'
/** 问题 1（P9）：Block 名字规范化 —— 缩写、首字母大写、去尾标点、片段→「缩写 (全称)」。 */
import { normalizeBlockName } from './lab/block-name'
export { deriveBlockRole } from './lab/block-role'

/**
 * 推断 Block 所属的方法阶段（P7-0）。
 *
 * 判定依据优先用**可反思的信息源**，其次才用关键词：
 *   1. 句子所处的章节（section）—— 解析服务已按论文标题顺序切好章节，
 *      这是最接近"作者把这件事放在流程哪个位置"的证据；
 *   2. 句子自身的过程性关键词（训练/推理/评估/预处理）；
 *   3. 都判不出来时退回 CORE_METHOD —— 与 schema 默认值一致，
 *      不凭猜测分配到别的阶段。
 *
 * 注意：这里不推断模块之间的依赖关系。依赖需要真实的组件级指代消解，
 * 靠关键词猜出来的是假结构。
 */
function inferBlockStage(text: string, section: string): string {
  const lower = text.toLowerCase()
  const sec = (section || '').toLowerCase()

  // 「pre-trained / pretrained / fine-tuned」这类词在论文里绝大多数是**修饰语**，
  // 用来描述"我们用的这个模型是预训练好的"，而不是"本文在做训练"。
  // 例："...combining a pre-trained seq2seq model with a dense passage retriever"
  //     "...uses a pre-trained seq2seq transformer as the parametric memory"
  // 直接按关键词判 TRAINING 会把大量方法描述句误判为训练阶段。
  // 因此先把它抹掉，只用"真的是训练行为"的表达来判断。
  const withoutModelAdjectives = lower
    .replace(/\bpre-?trained\b/g, ' ')
    .replace(/\bpre-?training\b/g, ' ')
    .replace(/\bfine-?tuned\b/g, ' ')
    .replace(/\bpretrained\b/g, ' ')

  // --- 1) 过程性关键词优先（同一章节内也能区分训练 / 推理 / 评估） ---
  if (/\b(evaluat|benchmark|metric|dataset|test set|ablation)\w*\b/.test(lower)) {
    return 'EVALUATION'
  }
  if (/\b(inference|at test time|decoding|beam search|serving|latency|deploy)\w*\b/.test(lower)) {
    return 'INFERENCE'
  }
  // 训练：要求出现真正的训练行为表述（训练动词 / 损失 / 优化 / 微调过程）
  if (
    /\b(fine-?tun|finetun|training|train the|trained on|optimiz|gradient|loss|objective|backpropagat)\w*\b/.test(
      withoutModelAdjectives
    )
  ) {
    return 'TRAINING'
  }
  if (/\b(tokeniz|preprocess|pre-process|chunk|segmentation|feature extraction|embedding of the input)\w*\b/.test(lower)) {
    return 'PREPROCESSING'
  }

  // --- 2) 退回章节位置 ---
  if (sec === 'experiment') return 'EVALUATION'
  if (sec === 'method') return 'CORE_METHOD'

  // --- 3) 判不出来就归到核心方法，不猜 ---
  return 'CORE_METHOD'
}

/**
 * 各阶段的抽取配额（P7-1 新增）。
 *
 * 为什么需要配额，而不是只按分数取前 N：
 *   旧实现是「全局按分数排序，取前 8」。方法的篇幅天然向正文倾斜，
 *   method 段的句子既含方法动词又有技术名词，分数碾压其它章节，
 *   于是 8 个名额几乎全被 CORE_METHOD 占满 —— 实测三篇论文分别只
 *   覆盖 1~2 个阶段，而结构图要成立至少需要 3 个阶段。
 *
 *   配额把「覆盖哪些阶段」从分数竞争的副作用变成显式的设计目标：
 *   每个阶段都保留自己的名额，先把这个阶段的句子捞出来，
 *   再回头补核心方法。这样低篇幅阶段（实验、训练）不会被饿死。
 *
 *   配额取得很保守（每个阶段 1~2 个）：宁可少一个模块，
 *   也不为了填满泳道去拉低证据标准 —— 与「证据不足不硬凑」一致。
 */
const STAGE_QUOTA: Record<string, number> = {
  EVALUATION: 2,
  TRAINING: 2,
  INFERENCE: 1,
  PREPROCESSING: 1,
  INPUT: 1,
  PROBLEM: 1,
  CORE_METHOD: 6,
}

/** 按阶段定向抽取时，放宽到什么程度才算"这个阶段确实有句子" */
const STAGE_MIN_SCORE = 1.5

/**
 * 从论文各章节中抽取候选 Block 句子（P7-1：按阶段定向抽取）。
 *
 * 两轮策略：
 *   第一轮 —— 按阶段配额定向捞。对每个 stage，只在这个阶段对应的章节里
 *             找句子，分数门槛放宽到 STAGE_MIN_SCORE。目的是**保证覆盖**。
 *   第二轮 —— 用剩余名额按原分数补核心方法，保证方法的细节不会被稀释。
 *
 * 关于 experiment 段的处理变化（这是本轮的实质改动）：
 *   旧实现把 experiment 定为 -1 分直接 `continue` 掉，理由是"实验段讲的
 *   是结果，不是方法"。但评估协议（数据集、指标、消融设计）**本身就是
 *   方法的一部分** —— 一篇论文如果没有评估设计，它的方法是不完整的。
 *   现在改为：experiment 段只捞 EVALUATION 这一类句子，且必须带评估
 *   关键词（见 STAGE_KEYWORDS），避免把"我们的模型取得了 SOTA"这种
 *   纯结果陈述当成模块。
 */
function extractBlockSentences(
  paragraphs: MockParagraph[],
  usedSentences: Set<string>,
  max = 10
): Array<{ text: string; page: number; section: string }> {
  interface Cand {
    text: string
    page: number
    section: string
    stage: string
    score: number
  }

  const all: Cand[] = []
  const seen = new Set<string>()

  for (const p of paragraphs) {
    if (p.section?.startsWith('heading:')) continue
    const sec = sectionOf(p)

    // limitation / conclusion 仍然排除：那里讲的是"没做到什么"，
    // 把它当成模块会歪曲方法本身（旧行为，保持不变）。
    if (sec === 'limitation' || sec === 'conclusion' || sec === 'references') continue

    const sentences = p.text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(isQuotableSentence)
      .filter((s) => s.length >= 60 && s.length <= 320)
      // 挡掉背景句 / 问题陈述 / 对比句 —— 它们不是本文的组件
      .filter((s) => !isBackgroundOrContrast(s))

    for (const s of sentences) {
      const key = sentKeyOf(s)
      if (usedSentences.has(key) || seen.has(key)) continue
      seen.add(key)

      const stage = inferBlockStage(s, sec)

      // 实验段只认可评估类句子，防止把结果陈述当模块
      if (sec === 'experiment' && stage !== 'EVALUATION') continue
      // 反过来，评估类结论如果落在方法段里，也是有效的评估设计描述 —— 放行

      const verbScore = hasMethodVerb(s) ? 3 : 0
      const techScore = techNounScore(s)
      const lengthScore = s.length >= 80 && s.length <= 220 ? 1 : 0
      // 章节权重改用非负值：实验段不再被一刀切排除，而是靠 STAGE 判定把关
      const sectionWeight = SECTION_WEIGHT[sec] ?? 0
      const score = verbScore + techScore * 0.8 + lengthScore + Math.max(0, sectionWeight)

      all.push({ text: s, page: p.page, section: sec, stage, score })
    }
  }

  const picked: Cand[] = []
  const pickedKeys = new Set<string>()

  // ---- 第一轮：按阶段配额定向捞，保证每个阶段都有模块 ----
  for (const [stage, quota] of Object.entries(STAGE_QUOTA)) {
    if (!quota) continue
    const bucket = all
      .filter((c) => c.stage === stage)
      .filter((c) => c.score >= STAGE_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
    for (const c of bucket.slice(0, quota)) {
      const k = sentKeyOf(c.text)
      if (pickedKeys.has(k)) continue
      pickedKeys.add(k)
      picked.push(c)
    }
  }

  // ---- 第二轮：用剩余名额补高分句（通常是核心方法细节） ----
  if (picked.length < max) {
    const rest = all
      .filter((c) => !pickedKeys.has(sentKeyOf(c.text)))
      .filter((c) => c.score >= 2.5)
      .sort((a, b) => b.score - a.score)
    for (const c of rest.slice(0, max - picked.length)) {
      pickedKeys.add(sentKeyOf(c.text))
      picked.push(c)
    }
  }

  // 展示顺序：按流程阶段先后排，同阶段内按分数（即重要性）
  const stageRank = (s: string) => METHOD_STAGE_FLOW_ORDER.indexOf(s)
  picked.sort((a, b) => {
    const d = stageRank(a.stage) - stageRank(b.stage)
    return d !== 0 ? d : b.score - a.score
  })

  return picked.slice(0, max).map(({ text, page, section }) => ({ text, page, section }))
}

/**
 * 阶段流程顺序（用于把抽取结果按方法流程排列）。
 *
 * 与 enums.ts 的 METHOD_STAGE_ORDER 保持一致；这里单独放一份是因为
 * llm-mock 是纯启发式的抽取层，不希望为了一个排序再牵一层依赖。
 * 若两边不一致，enums 的版本为准（UI 的泳道顺序用它）。
 */
const METHOD_STAGE_FLOW_ORDER = [
  'PROBLEM',
  'INPUT',
  'PREPROCESSING',
  'CORE_METHOD',
  'TRAINING',
  'INFERENCE',
  'EVALUATION',
]

/** 当领域无关抽取未命中时，从 method 段取最长句子兜底 */
function fallbackBlockSentences(
  paragraphs: MockParagraph[],
  usedSentences: Set<string>,
  max = 2
): Array<{ text: string; page: number; section: string }> {
  const candidates: Array<{ text: string; page: number; section: string; length: number }> = []

  for (const p of paragraphs) {
    if (p.section?.startsWith('heading:')) continue
    const sec = sectionOf(p)
    if (!['method', 'introduction', 'abstract'].includes(sec)) continue

    const sentences = p.text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 40 && s.length <= 400)

    for (const s of sentences) {
      const key = sentKeyOf(s)
      if (usedSentences.has(key)) continue
      candidates.push({ text: s, page: p.page, section: sec, length: s.length })
    }
  }

  candidates.sort((a, b) => b.length - a.length)
  return candidates.slice(0, max)
}

/** 旧关键词规则表，保留用于对比/回归测试 */
const BLOCK_KEYWORD_RULES: Array<{
  keywords: string[]
  name: string
  type: string
  role: string
}> = []

function buildMockDNA(prompt: string) {
  // 先把段落行首的 `[section]` 标记还原成 section（P7-1），
  // 否则 annotateSections 会把全部段落误判成 body/method —— 见 stripSectionPrefix。
  const paragraphs = parseParagraphsFromPrompt(prompt).map(stripSectionPrefix)

  if (paragraphs.length === 0) {
    // 没有解析到段落时，返回明确的「证据不足」结构
    return {
      task: { value: '', evidence: [] },
      problem: { value: '', evidence: [] },
      coreMechanism: { value: '', evidence: [] },
      blocks: [],
      training: { value: '', evidence: [] },
      inference: { value: '', evidence: [] },
      computationalCost: { value: '', evidence: [] },
      limitations: [],
      uncertainties: ['未能从论文文本中解析到任何段落，无法抽取方法结构'],
    }
  }

  const fullText = paragraphs.map((p) => p.text).join(' ')

  // ==========================================================================
  // 证据占用表 —— 全局共享，跨字段、跨模块去重
  //
  // 为什么必须共享：
  //   1. 概要与 block 各自独立挑句子，会出现 training 和 inference 引同一句话，
  //      用户看到两个不同字段挂着同样的证据，会怀疑数据是凑的。
  //   2. 更严重的是「抢占」：概要字段先跑，把有限的完整句子挑光，
  //      轮到 block 时已无可用句，模块数会随随便便就掉到 0。
  //      所以这里的顺序是「先让 block 占句，概要字段再挑剩下的」。
  // ==========================================================================
  const usedSentences = new Set<string>()

  // --- Method Blocks（领域无关抽取 + 兜底） ---
  const blocks: Array<{
    name: string
    type: string
    stage: string
    order: number
    description: string
    role: string
    evidence: Array<{ quote: string; page: number; section: string }>
  }> = []

  const blockSentences = extractBlockSentences(paragraphs, usedSentences, 8)

  // 阶段内顺序：每个 stage 各自从 1 开始递增
  const stageCounter = new Map<string, number>()

  for (const pick of blockSentences) {
    usedSentences.add(sentKeyOf(pick.text))
    const inferredType = inferBlockType(pick.text)
    const name = inferBlockName(pick.text)
    // 问题 1（P9）：规范化后拿不到合格名字的句子，**不生成 block**。
    // 以前这里会把一段截断原文当名字（如「In this work we investigate how much」），
    // 画布上就是一句半截英文 —— 比少一个节点更糟，因为用户无法辨认这是什么。
    if (!name) continue
    const stage = inferBlockStage(pick.text, pick.section)
    const next = (stageCounter.get(stage) ?? 0) + 1
    stageCounter.set(stage, next)
    blocks.push({
      name,
      type: inferredType,
      stage,
      order: next,
      description: pick.text.slice(0, 260),
      /**
       * 问题 2：role 必须**从这个模块自己的描述句里提炼**，不是三选一模板。
       * 提炼不出就留空字符串，由前端显示「未抽取到角色信息」——
       * 以前那三句『【演示推断】…通用组件』对所有节点都一样，等于没写。
       */
      role: deriveBlockRole(pick.text),
      evidence: [{ quote: pick.text, page: pick.page, section: pick.section }],
    })
  }

  // 兜底：如果领域无关抽取一无所获，取 method 段最长句子生成通用 Block
  if (blocks.length === 0) {
    const fallback = fallbackBlockSentences(paragraphs, usedSentences, 2)
    for (const pick of fallback) {
      usedSentences.add(sentKeyOf(pick.text))
      const stage = inferBlockStage(pick.text, pick.section)
      const name = inferBlockName(pick.text)
      // 同问题 1：兜底分支也要求名字合格，否则宁缺勿滥。
      if (!name) continue
      const next = (stageCounter.get(stage) ?? 0) + 1
      stageCounter.set(stage, next)
      blocks.push({
        name,
        type: 'OTHER',
        stage,
        order: next,
        description: pick.text.slice(0, 260),
        // 同问题 2：兜底分支也只提炼真实角色，提炼不出就留空。
        role: deriveBlockRole(pick.text),
        evidence: [{ quote: pick.text, page: pick.page, section: pick.section }],
      })
    }
  }

  // --- 任务 ---
  const taskPick = pickSentences(
    paragraphs,
    ['we introduce', 'we propose', 'we present', 'we evaluate', 'this paper'],
    2,
    usedSentences,
    { prefer: ['abstract', 'introduction'], avoid: ['limitation'] }
  )
  if (taskPick) usedSentences.add(sentKeyOf(taskPick.text))
  const task = {
    value: taskPick ? taskPick.text : '',
    evidence: taskPick
      ? [{ quote: taskPick.text, page: taskPick.page, section: taskPick.section }]
      : [],
  }

  // --- 核心问题 ---
  const problemPick = pickSentences(
    paragraphs,
    [
      'however',
      'remain open',
      'cannot easily',
      'downsides',
      'still limited',
      'lags behind',
    ],
    2,
    usedSentences,
    { prefer: ['abstract', 'introduction'] }
  )
  if (problemPick) usedSentences.add(sentKeyOf(problemPick.text))
  const problem = {
    value: problemPick ? problemPick.text : '',
    evidence: problemPick
      ? [
          {
            quote: problemPick.text,
            page: problemPick.page,
            section: problemPick.section,
          },
        ]
      : [],
  }

  // --- 核心机制 ---
  // 必须来自方法/引言章节：局限性里的"我们依赖外部语料质量"也会命中
  // combine/our approach 等词，但那是缺陷，不是机制。
  const mechPick = pickSentences(
    paragraphs,
    [
      'we propose',
      'combine',
      'architecture uses',
      'our approach',
      'our method',
      'we introduce a general-purpose',
    ],
    2,
    usedSentences,
    { prefer: ['method', 'introduction', 'abstract'], avoid: ['limitation'] }
  )
  if (mechPick) usedSentences.add(sentKeyOf(mechPick.text))
  const coreMechanism = {
    value: mechPick ? mechPick.text : '',
    evidence: mechPick
      ? [{ quote: mechPick.text, page: mechPick.page, section: mechPick.section }]
      : [],
  }

  // --- 训练策略 ---
  const trainPick = pickSentences(
    paragraphs,
    ['fine-tun', 'train', 'optimiz', 'gradient', 'pre-train'],
    2,
    usedSentences,
    { prefer: ['method', 'introduction'], avoid: ['limitation'] }
  )
  if (trainPick) usedSentences.add(sentKeyOf(trainPick.text))
  const training = {
    value: trainPick ? trainPick.text : '',
    evidence: trainPick
      ? [{ quote: trainPick.text, page: trainPick.page, section: trainPick.section }]
      : [],
  }

  // --- 推理策略 ---
  const inferPick = pickSentences(
    paragraphs,
    ['inference', 'at test time', 'generat', 'latency'],
    2,
    usedSentences,
    { prefer: ['method', 'introduction'], avoid: ['limitation'] }
  )
  if (inferPick) usedSentences.add(sentKeyOf(inferPick.text))
  const inference = {
    value: inferPick ? inferPick.text : '',
    evidence: inferPick
      ? [{ quote: inferPick.text, page: inferPick.page, section: inferPick.section }]
      : [],
  }

  // --- 计算成本 ---
  const costPick = pickSentences(
    paragraphs,
    [
      'computational cost',
      'expensive',
      'gpu',
      'computational',
      'latency',
      'memory',
    ],
    2,
    usedSentences
  )
  if (costPick) usedSentences.add(sentKeyOf(costPick.text))
  const computationalCost = {
    value: costPick ? costPick.text : '',
    evidence: costPick
      ? [{ quote: costPick.text, page: costPick.page, section: costPick.section }]
      : [],
  }

  // --- 局限性（多段） ---
  // 注意：这里刻意只取单句。把多句拼成一段会让语义失真
  // （例如把"延迟敏感场景受限"和"依赖语料质量"拼成一句），
  // 宁可只给一条准确的，也不给一段拼凑的。
  const limitationPicks = collectTopSentences(
    paragraphs,
    [
      'limitation',
      'depends on the quality',
      'remains expensive',
      'still hallucin',
      'latency-sensitive',
      'when relevant documents are absent',
      'introduces additional computational cost',
      'complicates serving',
    ],
    4,
    usedSentences
  )
  const limitations = limitationPicks.map((pick) => ({
    value: pick.text,
    evidence: [
      { quote: pick.text, page: pick.page, section: pick.section },
    ],
  }))

  // --- 明确记录哪些字段没找到证据 ---
  const uncertainties: string[] = []
  if (!task.evidence.length) uncertainties.push('未找到支撑 Task 的原文证据')
  if (!problem.evidence.length) uncertainties.push('未找到支撑 Core Problem 的原文证据')
  if (!coreMechanism.evidence.length)
    uncertainties.push('未找到支撑 Core Mechanism 的原文证据')
  if (!blocks.length) uncertainties.push('未从原文中识别出可结构化的 Method Blocks')
  if (!training.evidence.length) uncertainties.push('未找到支撑 Training 策略的原文证据')
  if (!inference.evidence.length) uncertainties.push('未找到支撑 Inference 策略的原文证据')
  if (!computationalCost.evidence.length)
    uncertainties.push('未找到支撑计算成本的原文证据')
  if (!limitations.length) uncertainties.push('未找到论文自述的局限性')
  if (fullText.length < 500)
    uncertainties.push('论文正文过短，抽取结果可能不完整')

  /**
   * ── P3 同步（P10 问题 3）：逐阶段说明"为什么这个阶段没有 block" ──
   *
   * 真实模型的 prompt 现在要求：对每个扫过但没抽出 block 的阶段，
   * 必须在 uncertainties 里写清是"原文未涉及"还是"提到了但证据不足"。
   * mock 作为降级路径必须产出**同构**的结果 —— 否则切到 mock 时
   * 面板的「未抽取阶段说明」会缺项，用户看到的信息量随 provider 变化。
   *
   * mock 的判定：该阶段没有任何 block，且原文里也找不到对应关键词
   * （靠 stage 的 section 归属判断）时，记为"原文未涉及"。
   */
  const coveredStages = new Set(blocks.map((b) => b.stage))
  const STAGE_LABEL_FOR_MOCK: Record<string, string> = {
    PROBLEM: '问题',
    INPUT: '输入',
    PREPROCESSING: '预处理',
    CORE_METHOD: '核心方法',
    TRAINING: '训练',
    INFERENCE: '推理',
    EVALUATION: '评估',
  }
  for (const stage of METHOD_STAGE_FLOW_ORDER) {
    if (coveredStages.has(stage)) continue
    const label = STAGE_LABEL_FOR_MOCK[stage] ?? stage
    uncertainties.push(`原文未涉及${label}阶段，故没有该阶段的 block`)
  }

  return {
    task,
    problem,
    coreMechanism,
    blocks,
    training,
    inference,
    computationalCost,
    limitations,
    uncertainties,
  }
}

/**
 * Mock 入口 —— 按 purpose 分派到不同的假数据生成器。
 *
 * 设计约束（重要）：
 *   1. 所有 mock 数据都只从传入的 prompt 文本里做启发式抽取，不凭空捏造，
 *      因此仍能表达完整的 Evidence 结构（含 quote + 页码）。
 *   2. 结果里带 provider='mock'，UI 上有显著提示，避免误认为真实模型产出。
 *   3. mock 的结论一律偏保守 —— 宁可说"证据不足"，不硬给结论。
 */
export async function mockLLMResponse(
  opts: LLMCallOptions,
  cfg: { model: string }
): Promise<LLMResult> {
  const prompt = opts.messages.map((m) => m.content).join('\n')

  let payload: unknown
  switch (opts.purpose) {
    case 'method-surgery':
      payload = buildMockSurgery(prompt)
      break
    case 'method-evolution':
      payload = buildMockEvolution(prompt)
      break
    case 'research-debt':
      payload = buildMockResearchDebt(prompt)
      break
    case 'crossbreeder':
      payload = buildMockCrossbreeder(prompt)
      break
    case 'crash-test':
      payload = buildMockCrashTest(prompt)
      break
    case 'method-dna-extraction':
    default:
      payload = buildMockDNA(prompt)
      break
  }

  // 模拟一点网络延迟，让 UI 的加载态可见
  await new Promise((r) => setTimeout(r, 400))

  return {
    text: JSON.stringify(payload),
    provider: 'mock',
    model: cfg.model || 'mock-model',
  }
}

// ============================================================================
// Method Surgery 的 mock 数据
//
// mock 定位：证明"链路通了"，不假装能做真实推理。
// 因此这里只做**结构完整 + 保守结论**，verdict 一律给证据不足，
// 由上层（method-surgery.ts）统一处理降级逻辑。
// ============================================================================

interface MockSurgeryBlockInfo {
  name: string
  type: string
  description: string
  role: string
  dependents: string[]
}

/** 从 surgery prompt 里解析出被操作的模块信息 */
function parseSurgeryContext(prompt: string): MockSurgeryBlockInfo {
  const get = (label: string): string => {
    const m = prompt.match(new RegExp(`- ${label}：(.+)`))
    return m ? m[1].trim() : ''
  }

  const depMatch = prompt.match(/以下模块声明依赖被操作的模块：(.+)/)

  return {
    name: get('名称'),
    type: get('类型'),
    description: get('描述'),
    role: get('在方法中的作用'),
    dependents: depMatch
      ? depMatch[1]
          .split('、')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  }
}

function buildMockSurgery(prompt: string) {
  const info = parseSurgeryContext(prompt)
  const paragraphs = parseParagraphsFromPrompt(prompt)

  // 找论文里带实验/消融线索的句子，仅作为"可能相关"的候选展示，
  // 不声称它们是针对本模块的消融实验。
  const ablationCandidates = collectTopSentences(
    paragraphs,
    [
      'ablation',
      'removing',
      'without',
      'decrease',
      'worse',
      'confirm that',
      'we find that',
    ],
    2
  )

  const impacts: Array<{
    effect: string
    severity: string
    rationale: string
    evidence: Array<{ quote: string; page: number; section: string }>
  }> = []

  // 依赖扩散影响 —— 这是唯一能靠结构信息（而非语义）推出的结论
  if (info.dependents.length > 0) {
    const depSentence = paragraphs.find((p) =>
      info.dependents.some((d) =>
        p.text.toLowerCase().includes(d.split(' ')[0].toLowerCase())
      )
    )
    impacts.push({
      effect:
        '依赖该模块的 ' + info.dependents.join('、') + ' 可能无法正常工作',
      severity: 'SEVERE',
      rationale:
        '这些模块在方法的依赖结构中声明了对被操作模块的依赖，移除后依赖链上游会失去输入。',
      evidence: depSentence
        ? [
            {
              quote: depSentence.text.slice(0, 300),
              page: depSentence.page,
              section: guessSection(depSentence.text),
            },
          ]
        : [],
    })
  }

  /**
   * ── 问题 3 / P10-S3：三个核心字段必须分工明确 ──
   *
   * S3 给真模型的 prompt 加了一段硬约束：blockRole（它是什么）、
   * lostCapability（整体失去哪件能力）、impacts（怎么一步步坏）
   * **必须回答三个不同的问题，不能写成同一句话的三种说法**。
   *
   * 按 P3（拍板）：prompt 改了，mock 必须**完整**同步 ——
   * 半同步等于没有兜底（降级时用户看到的仍是旧文风）。
   * 所以这里也照同一套分工来产出三个字段：
   *
   *   blockRole      = 功能化表述（deriveBlockRole 的输出本身就是功能动词句）
   *   lostCapability = 一句完整因果句，主语是"方法"的能力，且不得复述 blockRole
   *   impacts        = 独立、可分别验证的后果，severity 要拉开档次
   *
   * 关于 lostCapability 为什么用「<模块名> 这一环节」而不是直接拼 derivedRole：
   *   若直接拼 `因为${derivedRole}`，而 derivedRole 本身又是
   *   「负责从语料库中检索出与问题相关的段落」，就成了"因为负责检索"，
   *   语义重复且读起来是病句。改成指代「X 这一环节」后，
   *   既点明了失去的**是哪个环节的能力**，又和 blockRole 措辞有实质差异。
   */
  const derivedRole = deriveBlockRole(info.description) || deriveBlockRole(info.role)
  const bn = (info.name || '该模块').trim()

  // 基于模块自身描述的影响（保守表述）
  impacts.push({
    effect: derivedRole
      ? '方法将不再具备「' + derivedRole + '」的能力'
      : '方法将不再具备该模块所承担的能力',
    severity: 'MODERATE',
    rationale: derivedRole
      ? '该模块在原文中被描述为承担「' + derivedRole + '」，移除后这部分能力不再具备。'
      : '该模块的功能描述在原文中不完整，无法准确判断影响范围。',
    evidence: [],
  })

  return {
    blockRole: derivedRole || '（原文对该模块作用的描述不完整）',
    /**
     * 只用**具体功能**生成结论；提炼不到就留空字符串。
     * 留空会让 buildHeadline 走「无法从当前数据推断」分支 —— 这是诚实的，
     * 比硬套一句"失去该模块后…"要好。绝不再把模板句塞进来。
     */
    lostCapability: derivedRole
      ? '移除' +
        bn +
        ' 后，方法失去了' +
        derivedRole.replace(/^负责/, '').replace(/^用于/, '') +
        '这一环节的能力，核心流程会断在这里。'
      : '',
    impacts,
    ablationEvidence: ablationCandidates.map((c) => ({
      quote: c.text,
      page: c.page,
      section: c.section,
    })),
    hasDirectAblation: false,
    dependencyRisk:
      info.dependents.length > 0
        ? '该模块被 ' +
          info.dependents.join('、') +
          ' 依赖，移除会影响这些模块。'
        : '没有其他模块声明依赖该模块。',
    verdict: 'INSUFFICIENT_EVIDENCE',
    verdictReason:
      '当前只做了结构性分析（模块之间的依赖关系），没有做语义层面的因果推理，' +
      '所以无法判断移除该模块的具体后果。按项目规则标记为证据不足，不做推测性结论。',
    uncertainties: [
      '本次分析不做语义层面的因果推理，只依据模块依赖结构',
      '未在论文中找到与该模块直接对应的消融实验',
      ...(info.dependents.length > 0
        ? [
            '依赖该模块的 ' +
              info.dependents.join('、') +
              ' 的实际受影响程度未能评估',
          ]
        : []),
    ],
  }
}

// ============================================================================
// Method Evolution 的 mock 数据
//
// 定位：证明"链路通了"，**绝不能假装能做演化推理**。
//
// ── P10 Step6：与真实 prompt 的两层证据模型同步 ──
//
// 真实模型的 prompt 已从"只认引用级证据"改成**两层**（见 method-evolution.ts）：
//   ★ 引用级：原文有"基于/沿用/不同于"等明确表述
//   ★ 问题级：无互相引用，但在解决同一个可辨识的研究问题、且机制可比
//
// 因此 mock 也必须有两层，否则会与真模型产生**结构性差异**（P3 约束：
// 「prompt 改动必须完整同步到 mock，做一半等于没做降级」）。对应地：
//   第一层 → 关键词共现（沿用原逻辑），confidence 0.55
//   第二层 → 无引用线索时，改用**共享领域术语**判定（见 sharedTopicHits），
//             confidence 压到 0.5（刚好过 MIN_CONFIDENCE 这道门）
//
// 保守策略（比真实模型更保守）：
//   1. 方向由论文列表顺序（调用方已按年份升序排）决定：只能「较早 → 较晚」，
//      绝不产生双向边，也绝不产生"后来者指向更早者"的倒流边。
//   2. 每篇论文最多只建立 **一条** 上游关系（取线索最强的那篇）。
//      真实的演化梳理会有分支与多父节点，但演示模式没有语义能力去判断，
//      所以宁可只给一条最保守的推测，也不铺开一张看似丰富的假图谱。
//   3. 必须真的在该论文原文中看到线索词（第二层退化为领域词共现），
//      才算候选。找不到就返回空数组 —— 不连边本身就是有效结论。
// ============================================================================

function buildMockEvolution(prompt: string) {
  // 解析论文列表：### [0] 标题
  const paperRe = /^### \[(\d+)\] (.+)$/gm
  const papers: Array<{ index: number; title: string }> = []
  let m: RegExpExecArray | null
  while ((m = paperRe.exec(prompt)) !== null) {
    papers.push({ index: Number(m[1]), title: m[2].trim() })
  }

  const relations: Array<{
    sourceIndex: number
    targetIndex: number
    type: string
    reason: string
    confidence: number
    evidence: Array<{ quote: string; page: number; section: string }>
  }> = []

  // 解析出「### [i] 标题」分块，并记录每段属于哪篇论文 —— 
  // 否则会把 A 论文的句子当成 B 论文的证据，产生伪造的演化关系。
  interface BlockedParagraph {
    paperIndex: number
    page: number
    text: string
    section?: string
  }
  const blocked: BlockedParagraph[] = []
  {
    const blocks = prompt.split(/^### \[(\d+)\] .+$/gm)
    // split 带捕获组时结果形如 [前言, '0', 块0内容, '1', 块1内容, ...]
    for (let k = 1; k < blocks.length; k += 2) {
      const idx = Number(blocks[k])
      const chunk = blocks[k + 1] ?? ''
      const raw: MockParagraph[] = []
      const re = /^\[p(\d+)\]\s*(.+)$/gm
      let mm: RegExpExecArray | null
      while ((mm = re.exec(chunk)) !== null) {
        raw.push({ page: Number(mm[1]), text: mm[2].trim() })
      }
      // 逐篇标注章节，避免跨论文混用
      for (const p of annotateSections(raw)) {
        blocked.push({
          paperIndex: idx,
          page: p.page,
          text: p.text,
          section: p.section,
        })
      }
    }
  }
  // 兜底：若分块失败（prompt 格式变化），退回全局解析但不做跨论文断言
  const paragraphs =
    blocked.length > 0
      ? blocked
      : parseParagraphsFromPrompt(prompt).map((p) => ({
          paperIndex: -1,
          page: p.page,
          text: p.text,
          section: p.section,
        }))

  const relationIndicators: Array<{ type: string; keywords: string[] }> = [
    {
      type: 'IMPROVE',
      keywords: ['unlike', 'improve', 'limitation of', 'address the'],
    },
    {
      type: 'INHERIT',
      keywords: ['build upon', 'building on', 'based on', 'extend'],
    },
    { type: 'REPLACE', keywords: ['replace', 'instead of', 'rather than'] },
    { type: 'COMBINE', keywords: ['combine', 'combining', 'integrate'] },
    { type: 'BRANCH', keywords: ['inspired by', 'variant', 'alternative'] },
  ]

  /** 标题里能代表这篇论文的特征词（过滤掉通用词） */
  const STOP = new Set([
    'with',
    'from',
    'using',
    'learning',
    'based',
    'towards',
    'through',
    'leveraging',
    'models',
    'model',
    'tasks',
    'task',
    'open',
    'domain',
    'question',
    'answering',
    'generative',
    'generation',
    'neural',
    'language',
  ])
  const keywordsOf = (title: string): string[] =>
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))

  // 对每篇论文（除第一篇外）只找一条最强上游关系
  for (let t = 1; t < papers.length; t++) {
    const target = papers[t]
    const srcWordsByPaper = papers
      .slice(0, t)
      .map((p) => ({ paper: p, words: keywordsOf(p.title) }))
      .filter((x) => x.words.length > 0)

    if (srcWordsByPaper.length === 0) continue

    interface Candidate {
      sourceIndex: number
      type: string
      quote: string
      page: number
      hits: number
      section: string
      /** 引用级（true）还是问题级（false）—— 决定 confidence 与 reason 措辞 */
      citationLevel: boolean
    }
    let best: Candidate | null = null

    // 只扫描「属于目标论文」的段落 —— 演化线索必须出现在承接方论文里
    const targetParagraphs = paragraphs.filter(
      (p) => p.paperIndex === target.index
    )

    for (const p of targetParagraphs) {
      const lower = p.text.toLowerCase()

      // 该片段属于目标论文：必须提到某个前序论文的特征词
      let mentioned: { paper: { index: number; title: string }; hits: number } | null =
        null
      for (const sw of srcWordsByPaper) {
        const hits = sw.words.filter((w) => lower.includes(w)).length
        if (hits > 0 && (!mentioned || hits > mentioned.hits)) {
          mentioned = { paper: sw.paper, hits }
        }
      }
      if (!mentioned) continue

      /**
       * ── 第一层：引用级 ──
       * 命中明确的演化线索词（unlike / based on / …）。
       */
      const ind = relationIndicators.find((x) =>
        x.keywords.some((k) => lower.includes(k))
      )

      /**
       * ── 第二层：问题级（P10 Step6 新增，对齐真模型 prompt）──
       *
       * 没有引用级线索时的兜底：看这一段的领域术语是否与某个前序论文
       * 共享。共享领域术语 = "在谈论同一类研究问题" 的粗粒度信号。
       * 这当然弱于语义判断，所以：
       *   · type 一律给 BRANCH（最中性的"同问题、不同走向"）
       *   · confidence 0.5（刚好过门，明示"只是可能"）
       *   · reason 里写清是领域词共现、未经语义确认
       */
      let level1 = ind ?? null
      let level2Hits = 0
      if (!level1) {
        level2Hits = sharedTopicHits(lower)
        if (level2Hits < 2) continue // 只共享 1 个词太弱，不连边
      }

      const candidate: Candidate = level1
        ? {
            sourceIndex: mentioned.paper.index,
            type: level1.type,
            quote: p.text,
            page: p.page,
            hits: mentioned.hits,
            section: p.section ?? 'body',
            citationLevel: true,
          }
        : {
            sourceIndex: mentioned.paper.index,
            type: 'BRANCH',
            quote: p.text,
            page: p.page,
            hits: mentioned.hits,
            section: p.section ?? 'body',
            citationLevel: false,
          }

      // 引用级优先于问题级（同为引用级时比特征词命中数）
      const better =
        !best ||
        (candidate.citationLevel && !best.citationLevel) ||
        (candidate.citationLevel === best.citationLevel &&
          candidate.hits > best.hits)
      if (better) best = candidate
    }

    if (best) {
      const srcTitle = papers
        .find((x) => x.index === best!.sourceIndex)!
        .title.slice(0, 40)
      relations.push({
        sourceIndex: best.sourceIndex,
        targetIndex: target.index,
        type: best.type,
        reason: best.citationLevel
          ? '在目标论文原文片段中检测到「' +
            srcTitle +
            '」的特征词与演化线索词共现，但未经语义确认。'
          : '目标论文与前序论文「' +
            srcTitle +
            '」共享多个领域术语（推断为面对同一研究问题），但无互相引用，' +
            '机制关系未经语义确认。',
        // 置信度刻意压低，避免以假乱真；问题级更低一档
        confidence: best.citationLevel ? 0.55 : 0.5,
        evidence: [
          {
            quote: best.quote.slice(0, 300),
            page: best.page,
            section: best.section.startsWith('heading:')
              ? best.section.slice(8)
              : best.section,
          },
        ],
      })
    }
  }

  return {
    relations,
    notes: [
      '关系判定基于关键词共现（引用级）与领域词共现（问题级），' +
        '均未经语义验证，置信度 0.5~0.55。',
      '每篇论文最多只建立一条上游关系，方向固定为「较早 → 较晚」，' +
        '不铺开分支与多父节点 —— 这类判断需要语义推理能力。',
      relations.length === 0
        ? '未在原文中检测到明确的方法演化线索，因此没有建立任何关系。'
        : '共检测到 ' +
          relations.length +
          ' 条可能的关系，建议配置真实模型后重新梳理。',
    ],
  }
}

/**
 * ── 问题级判定用的领域术语表（P10 Step6）──
 *
 * 为什么用一张固定小表而不是通用词频：
 *   演示模式的定位是"证明链路通了"，不是"真的懂领域"。用一张**有限、
 *   可解释**的领域词表，能让"共享问题"的判定保持在可审计的范围内 ——
 *   出现了哪些词、命中几个，都能在 reason 里讲清楚。通用词频会引入
 *   大量噪声词（"method"、"results"），反而制造假关系。
 *
 * 这些词覆盖了本项目的示例领域（RAG / 检索 / 室内定位 / WiFi 指纹 / 众包），
 * 换领域时按同样的粒度补充即可。
 */
const TOPIC_TERMS = [
  // 检索增强 / RAG
  'retrieval',
  'retrieve',
  'augmented',
  'passage',
  'knowledge-intensive',
  'parametric',
  // 室内定位 / IPS
  'indoor',
  'positioning',
  'localization',
  'fingerprint',
  'fingerprinting',
  'wifi',
  'wi-fi',
  'rss',
  'crowdsourc',
  'crowdsensing',
  'pdr',
  'pedestrian',
  'dead reckoning',
  'calibration',
  'reference point',
  'radio map',
]

/** 返回文本中命中的主题词个数（去重） */
function sharedTopicHits(lowerText: string): number {
  let n = 0
  for (const t of TOPIC_TERMS) {
    if (lowerText.includes(t)) n++
  }
  return n
}

// ============================================================================
// Research Debt 的 mock 数据（P4）
//
// mock 定位：跨论文聚类需要真正的语义理解能力，启发式做不到。
// 因此这里**刻意只做保守的事情**：
//   1. 按「类目关键词」把各论文的局限性句子归类，而不是硬造一个新的问题
//   2. 只有**两篇以上**论文命中同一类目时，才把它输出为一条债务
//      —— 这恰好符合"单篇的局限不算领域债务"的项目定义
//   3. 如果聚类结果为空，就返回空数组。**没有债务也是有效结论。**
// ============================================================================

/** 类目 → 关键词。用于把局限性句子归到相应类目。 */
const DEBT_CATEGORY_KEYWORDS: Array<{ category: string; keywords: string[] }> = [
  {
    category: 'COMPUTATION',
    keywords: [
      'computation',
      'computational',
      'expensive',
      'cost',
      'costly',
      'latency',
      'memory',
      'scalab',
      'throughput',
      'inference time',
      'gpu',
    ],
  },
  {
    category: 'GENERALIZATION',
    keywords: [
      'generaliz',
      'out-of-domain',
      'out of domain',
      'domain shift',
      'distribution',
      'unseen',
      'transfer',
      'robustness across',
    ],
  },
  {
    category: 'DATA',
    keywords: [
      'data',
      'corpus',
      'annotation',
      'labeled',
      'labelled',
      'supervision',
      'dataset',
      'coverage',
      'knowledge base',
    ],
  },
  {
    category: 'INTERPRETABILITY',
    keywords: [
      'interpretab',
      'explainab',
      'transparen',
      'black box',
      'provenance',
      'attribution',
    ],
  },
  {
    category: 'ROBUSTNESS',
    keywords: [
      'robust',
      'adversar',
      'noise',
      'perturb',
      'attack',
      'hallucin',
      'unreliable',
    ],
  },
  {
    category: 'EVALUATION',
    keywords: [
      'evaluation',
      'benchmark',
      'metric',
      'measure',
      'no standard',
      'lack of',
      'not comparable',
    ],
  },
  {
    category: 'THEORY',
    keywords: [
      'theoretical',
      'theory',
      'guarantee',
      'proof',
      'convergence',
      'bound',
      'formal',
    ],
  },
]

/** 局限类句子的线索词 */
const LIMITATION_HINTS = [
  'however',
  'limitation',
  'limited',
  'future work',
  'remains',
  'challenge',
  'difficult',
  'struggle',
  'fail to',
  'cannot',
  'unable',
  'expensive',
  'costly',
  'scalab',
  'not address',
  'left for',
  'open problem',
  'remains open',
  'depends on',
  'sensitive to',
]

/** 转折/局限标记 —— 引用时从这里开始裁，避免带上无关的背景句 */
const LIMITATION_CUT_MARKERS = [
  'however',
  'but ',
  'limitation',
  'remain',
  'challeng',
  'difficult',
  'struggle',
  'fail to',
  'cannot',
  'unable',
  'expensive',
  'costly',
  'we leave',
  'left for',
  'future work',
  'open problem',
  'not address',
]

/**
 * 把句子裁到「局限部分」开头。
 *
 * 例："Large pre-trained language models ... on NLP tasks. However, their ability
 *      to access and precisely manipulate knowledge is still limited."
 *   →   "However, their ability to access and precisely manipulate knowledge is still limited."
 *
 * 目的是让引用读起来就是一句完整的"局限陈述"，
 * 而不是"背景介绍 + 顺带一句转折"。
 */
function trimToLimitationClause(text: string): string {
  const lower = text.toLowerCase()
  let cut = -1
  for (const marker of LIMITATION_CUT_MARKERS) {
    const idx = lower.indexOf(marker)
    if (idx > 0 && (cut === -1 || idx < cut)) cut = idx
  }
  // 找不到标记，或标记就在开头 —— 原样返回
  const result = cut > 0 ? text.slice(cut) : text
  return result.trim()
}

/** 局限句里常见的"已经做了什么"动作线索，用于判定是否真的存在一次尝试 */
const ATTEMPT_ACTION_HINTS = [
  'we propose',
  'we introduce',
  'we present',
  'we design',
  'we develop',
  'we use',
  'we employ',
  'we adopt',
  'we apply',
  'we address',
  'we tackle',
  'we mitigate',
  'we alleviate',
  'our approach',
  'our method',
  'our model',
  'this paper',
  'the model',
  'to address',
  'to mitigate',
  'to alleviate',
  'in order to',
  'propose a',
  'introduce a',
]

/** 尝试的结果线索 —— 只在原文确实说了结果时才判定 */
const ATTEMPT_OUTCOME_HINTS: Array<{ outcome: string; keywords: string[] }> = [
  {
    outcome: '部分成功',
    keywords: [
      'improve',
      'improves',
      'improved',
      'outperform',
      'reduc',
      'mitigat',
      'alleviat',
      'better than',
      'higher',
    ],
  },
  {
    outcome: '引入新问题',
    keywords: [
      'at the cost of',
      'comes with',
      'introduces additional',
      'however, this',
      'trade-off',
      'tradeoff',
      'but it also',
    ],
  },
  {
    outcome: '未见效',
    keywords: ['fail', 'does not', 'cannot', 'unable', 'still limited', 'remains'],
  },
]

/**
 * 把句子裁到「尝试动作」开头。
 *
 * 与 trimToLimitationClause 同理，但目标是相反的一端：
 * 局限句常常写成「问题陈述 + 转折 + 我们怎么做」，例如
 *   "However, their ability to ... is still limited. However, we propose a
 *    retrieval-augmented approach that reduces this cost significantly."
 * attempts 要引的是后半段（我们做了什么），所以要裁到第一个动作主语处，
 * 否则用户看到的"尝试"前半截其实在描述问题。
 */
function trimToAttemptClause(text: string): string {
  const lower = text.toLowerCase()
  let cut = -1
  for (const marker of ATTEMPT_ACTION_HINTS) {
    const idx = lower.indexOf(marker)
    // 必须是句内较靠后的位置，避免把开头的 "this paper" 之类误当切点
    if (idx > 0 && (cut === -1 || idx < cut)) cut = idx
  }
  if (cut <= 0) return text.trim()
  // 往前吃掉一个转折连词，让引用读起来连贯（保留首字母大写）
  const head = text.slice(0, cut)
  const m = head.match(/(?:however|but|nevertheless|still|therefore|thus)\s*,?\s*$/i)
  if (m) {
    const rest = text.slice(cut)
    const connector = text.slice(cut - m[0].length, cut)
    return (connector + rest).trim()
  }
  return text.slice(cut).trim()
}

/**
 * 从「局限句」中识别论文自己尝试过的应对方式（attempt，P7-0）。
 *
 * 为什么必须严格：`attempts` 描述的是"这篇论文做了什么去解决该问题"。
 * 这不是可以靠句式模板生成的字段 —— 一旦编造，用户会看到根本不存在的
 * 研究动作，而它又挂着 evidence，看起来可信度很高。所以这里要求句子
 * **同时**满足两个条件才认：
 *   1. 含明确的动作主体（we propose / our approach / to mitigate …）
 *   2. 该句讨论的就是当前这条债务的类目关键词
 * 任一不满足就返回 null —— 没有 attempts 是诚实的结论。
 */
function inferAttempt(
  text: string,
  category: string
): { description: string; outcome: string } | null {
  const lower = text.toLowerCase()

  // 条件 1：必须能看到"谁做了什么"
  const hasAction = ATTEMPT_ACTION_HINTS.some((h) => lower.includes(h))
  if (!hasAction) return null

  // 条件 2：必须和当前债务是同一个话题，否则就是把别的贡献贴到这条债务上
  const rule = DEBT_CATEGORY_KEYWORDS.find((r) => r.category === category)
  if (rule && !rule.keywords.some((k) => lower.includes(k))) return null

  const clause = trimToAttemptClause(text)

  // 结果：只在原文有明确结果线索时才判定，否则照实说"未说明"
  const clauseLower = clause.toLowerCase()
  let outcome = '未说明'
  for (const hint of ATTEMPT_OUTCOME_HINTS) {
    if (hint.keywords.some((k) => clauseLower.includes(k))) {
      outcome = hint.outcome
      break
    }
  }

  return { description: clause.slice(0, 300), outcome }
}

function buildMockResearchDebt(prompt: string) {
  // ---- 解析论文列表 ----
  const paperRe = /^### \[(\d+)\] (.+)$/gm
  const papers: Array<{ index: number; title: string; year: string }> = []
  let m: RegExpExecArray | null
  while ((m = paperRe.exec(prompt)) !== null) {
    papers.push({ index: Number(m[1]), title: m[2].trim(), year: '' })
  }
  // 从论文列表里补年份
  const yearRe = /- 年份：(\S+)/g
  let y: RegExpExecArray | null
  let yi = 0
  while ((y = yearRe.exec(prompt)) !== null && yi < papers.length) {
    papers[yi].year = y[1]
    yi++
  }

  // ---- 按论文分块解析段落 ----
  interface BlockedPara {
    paperIndex: number
    page: number
    text: string
    section: string
  }
  const blocked: BlockedPara[] = []
  {
    const blocks = prompt.split(/^### \[(\d+)\] .+$/gm)
    for (let k = 1; k < blocks.length; k += 2) {
      const idx = Number(blocks[k])
      const chunk = blocks[k + 1] ?? ''
      const raw: MockParagraph[] = []

      // 注意：这里**刻意不把 `[自述局限]` 行当成引用来源**。
      //
      // 原因：`[自述局限]` 是 Method DNA 抽取阶段对原文的**转述**，
      // 不是逐字原文。把它当作债务的 quote 会造成假证据 ——
      // 看它来自论文，实际是模型改写过的句子，无法回溯核对。
      //
      // 所以 mock 只引用带页码的正文行（[pN] 前缀），
      // 这些才是能在原文中逐字核对上的。

      // [p3][limitation] 文本  或  [p3] 文本
      const re = /^\[p(\d+)\](?:\[([^\]]+)\])?\s*(.+)$/gm
      let mm: RegExpExecArray | null
      while ((mm = re.exec(chunk)) !== null) {
        raw.push({
          page: Number(mm[1]),
          text: mm[3].trim(),
          section: mm[2] ? mm[2].trim() : undefined,
        })
      }

      // 正文里完全没有带页码的局限类句子时，才退回到自述局限
      // （此时 quote 会因无法核对而被上层标为 UNCERTAIN —— 这是诚实的降级）
      const hasNumbered = raw.some((p) => {
        const lower = p.text.toLowerCase()
        return LIMITATION_HINTS.some((h) => lower.includes(h))
      })
      if (!hasNumbered) {
        const limRe = /^\[自述局限\]\s*(.+)$/gm
        let lm: RegExpExecArray | null
        while ((lm = limRe.exec(chunk)) !== null) {
          raw.push({ page: 1, text: lm[1].trim() })
        }
      }

      for (const p of annotateSections(raw)) {
        blocked.push({
          paperIndex: idx,
          page: p.page,
          text: p.text,
          section: sectionOf(p),
        })
      }
    }
  }

  // ---- 挑出「局限性句子」，按类目归类 ----
  interface Hit {
    paperIndex: number
    page: number
    text: string
    section: string
    category: string
  }
  const hits: Hit[] = []
  const seenSent = new Set<string>()

  for (const p of blocked) {
    const lower = p.text.toLowerCase()
    if (!LIMITATION_HINTS.some((k) => lower.includes(k))) continue
    if (!isQuotableSentence(p.text)) continue

    // 归到一个类目：命中关键词最多的那个
    let bestCat = 'OTHER'
    let bestScore = 0
    for (const rule of DEBT_CATEGORY_KEYWORDS) {
      const score = rule.keywords.filter((k) => lower.includes(k)).length
      if (score > bestScore) {
        bestScore = score
        bestCat = rule.category
      }
    }
    if (bestScore === 0) continue

    const key = `${p.paperIndex}::${sentKeyOf(p.text)}`
    if (seenSent.has(key)) continue
    seenSent.add(key)

    hits.push({
      paperIndex: p.paperIndex,
      page: p.page,
      // 从局限句本身开始引用，而不是把前面的背景介绍也带上 ——
      // 否则引用的前半段在讲别的事，读者会以为系统抓错了句子。
      text: trimToLimitationClause(p.text),
      section: p.section,
      category: bestCat,
    })
  }

  // ---- 按类目聚合：只有 >= 2 篇不同论文命中，才算「跨论文债务」 ----
  const byCategory = new Map<string, Hit[]>()
  for (const h of hits) {
    const list = byCategory.get(h.category) ?? []
    list.push(h)
    byCategory.set(h.category, list)
  }

  const CATEGORY_TITLE: Record<string, string> = {
    COMPUTATION: '计算开销与可扩展性',
    GENERALIZATION: '跨领域与分布外泛化',
    DATA: '对标注数据与语料的依赖',
    INTERPRETABILITY: '决策过程的可解释性',
    ROBUSTNESS: '输入扰动下的鲁棒性',
    EVALUATION: '评测方式的可靠性',
    THEORY: '理论保证的缺失',
    OTHER: '其他长期未解决的问题',
  }

  const debts: Array<{
    title: string
    description: string
    category: string
    currentStatus: string
    sources: Array<{
      paperIndex: number
      context: string
      evidence: Array<{ quote: string; page: number; section: string }>
    }>
    attempts: Array<{
      paperIndex: number
      description: string
      outcome: string
      evidence: Array<{ quote: string; page: number; section: string }>
    }>
  }> = []

  for (const entry of Array.from(byCategory.entries())) {
    const category = entry[0]
    const list = entry[1]
    // 按论文去重，每篇论文取一条最长的说法
    const perPaper = new Map<number, Hit>()
    for (const h of list) {
      const prev = perPaper.get(h.paperIndex)
      if (!prev || h.text.length > prev.text.length) perPaper.set(h.paperIndex, h)
    }

    const papers2 = Array.from(perPaper.values())
    // 关键约束：只有 2 篇以上论文共同提到，才够格叫"领域债务"
    if (papers2.length < 2) continue

    const years = papers2
      .map((h) => papers[h.paperIndex]?.year)
      .filter((v) => v && v !== '未知')
      .sort()

    debts.push({
      title: CATEGORY_TITLE[category] ?? CATEGORY_TITLE.OTHER,
      description:
        `${papers2.length} 篇论文都在不同程度上承认了这一问题：` +
        papers2
          .map((h) => `《${papers[h.paperIndex]?.title ?? '未知'}》`)
          .join('、') +
        '。',
      category,
      currentStatus:
        years.length >= 2
          ? `${years[0]} 至 ${years[years.length - 1]} 年间被反复提及，未见明确解决`
          : '被多篇论文提及，未见明确解决',
      sources: papers2.map((h) => ({
        paperIndex: h.paperIndex,
        context: h.text.slice(0, 300),
        evidence: [
          {
            quote: h.text.slice(0, 300),
            page: h.page,
            section: h.section.startsWith('heading:')
              ? h.section.slice(8)
              : h.section,
          },
        ],
      })),
      // attempts：只认「同一篇论文里明确描述了自己做了什么」的句子。
      // 这里刻意不做跨论文推断 —— "A 论文的局限由 B 论文解决了"需要真实
      // 的语义比对，靠关键词配对出来的会是假的研究脉络。
      attempts: papers2
        .map((h) => {
          const attempt = inferAttempt(h.text, category)
          if (!attempt) return null
          return {
            paperIndex: h.paperIndex,
            description: attempt.description,
            outcome: attempt.outcome,
            evidence: [
              {
                quote: h.text.slice(0, 300),
                page: h.page,
                section: h.section.startsWith('heading:')
                  ? h.section.slice(8)
                  : h.section,
              },
            ],
          }
        })
        .filter((a): a is NonNullable<typeof a> => a !== null),
    })
  }

  return {
    debts,
    notes: [
      '研究债务按「类目关键词」聚类，只有被 2 篇以上论文共同提到的问题才会被输出，' +
        '且「尝试解决」的记录只在同一篇论文明确描述了自己做了什么时才会生成，不做跨论文推断。',
      debts.length === 0
        ? '未检测到被多篇论文共同提及的跨论文问题，因此没有生成任何研究债务。' +
          '单篇论文的局限只是它自己的缺点，不构成领域债务 —— 这是一个有效结论。'
        : `共识别出 ${debts.length} 条跨论文研究债务（${hits.length} 条原始局限被归类）。`,
    ],
  }
}

// ============================================================================
// Crossbreeder 的 mock 数据（P4）
//
// 这是整条链路里最容易被 mock 糊弄过去的一环 —— 随便组合两个模块就能
// 编出一个听起来不错的 idea。所以 mock 必须**同样受三道关卡约束**，
// 否则演示模式下会产出一堆漂亮空话，违背项目"不虚构科研结论"的要求。
//
// mock 的策略：
//   1. 只做「A 论文的模块 + B 论文的模块」这种真正的跨论文配对
//   2. 必须能指出一条真实存在的研究债务，并给出具体的 why（模板里带上
//      模块名与债务名，避免"可以提高性能"这类放到哪里都成立的套话）
//   3. 证据直接取该模块自己的原文引用 —— 不编造
//   4. 配对数量上限严格限制，宁缺毋滥
// ============================================================================

/**
 * 从两篇论文的模块中各挑一个，组成一个有意义的配对。
 *
 * 排除两种"退化配对"：
 *   - 同名（Encoder × Encoder）—— 同一类组件配不出新假设
 *   - 同类型（ENCODER × ENCODER）—— 同上
 *
 * 优先返回**类型不同**的组合（如 Retriever × Decoder）；
 * 实在找不到就返回 null，让调用方跳过这一对 —— 宁可不产出。
 */
function pickDistinctPair<
  A extends { name: string; type: string },
>(a: A[], b: A[]): [A, A] | null {
  // 第一优先：名称和类型都不同
  for (const x of a) {
    for (const y of b) {
      if (x.name.toLowerCase() !== y.name.toLowerCase() && x.type !== y.type) {
        return [x, y]
      }
    }
  }
  // 第二优先：仅名称不同（类型相同），聊胜于无
  for (const x of a) {
    for (const y of b) {
      if (x.name.toLowerCase() !== y.name.toLowerCase()) {
        return [x, y]
      }
    }
  }
  // 只剩同名同类型的组合 —— 不产出
  return null
}

/**
 * 取标题的最前几个词，用作论文的短标识。
 * 用途：让候选方案的标题能区分"哪个模块来自哪篇论文"，
 * 避免出现两条都叫「Encoder × Decoder」的歧义标题。
 */
function firstWords(title: string, n = 3): string {
  const words = title.trim().split(/\s+/).slice(0, n).join(' ')
  return words || title.slice(0, 18)
}

function buildMockCrossbreeder(prompt: string) {
  // ---- 解析模块池：形如 "[0] 模块名（TYPE）\n    来自论文：标题（年份）" ----
  interface MockBlock {
    index: number
    name: string
    type: string
    paperTitle: string
    description: string
    role: string
  }
  const blocks: MockBlock[] = []
  {
    const re = /^\[(\d+)\] (.+?)（([A-Z_]+)）\n\s*来自论文：(.+?)（([^）]*)）\n\s*描述：(.+)\n\s*作用：(.+)$/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(prompt)) !== null) {
      blocks.push({
        index: Number(m[1]),
        name: m[2].trim(),
        type: m[3].trim(),
        paperTitle: m[4].trim(),
        description: m[6].trim(),
        role: m[7].trim(),
      })
    }
  }

  // ---- 解析债务池：形如 "[0] 标题（CATEGORY｜N 篇论文提及）" ----
  interface MockDebt {
    index: number
    title: string
    category: string
    occurrence: number
    status: string
  }
  const debts: MockDebt[] = []
  {
    const re = /^\[(\d+)\] (.+?)（([A-Z_]+)｜(\d+) 篇论文提及）\n\s*现状：(.+)$/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(prompt)) !== null) {
      debts.push({
        index: Number(m[1]),
        title: m[2].trim(),
        category: m[3].trim(),
        occurrence: Number(m[4]),
        status: m[5].trim(),
      })
    }
  }

  // ---- 找出「同一篇论文内部的证据引用」——
  //      直接从 prompt 里该模块所在的描述行取，不编造 ----
  //      这里用模块的 description/role 作为证据来源的替代，
  //      因为 mock 拿不到该模块的 evidence quote 文本。
  //      上层会做原文核对，核对不上的会被关卡 3 拦下 —— 这是可接受的：
  //      演示模式下宁可少产出，也不产出无法追溯的 idea。
  const candidates: Array<{
    title: string
    description: string
    blockIndexes: number[]
    debtIndexes: number[]
    why: string
    evidence: Array<{ quote: string; page: number; section: string }>
  }> = []

  if (blocks.length >= 2 && debts.length >= 1) {
    // 按论文分组
    const byPaper = new Map<string, MockBlock[]>()
    for (const b of blocks) {
      const list = byPaper.get(b.paperTitle) ?? []
      list.push(b)
      byPaper.set(b.paperTitle, list)
    }
    const paperTitles = Array.from(byPaper.keys())

    // 只有 >= 2 篇论文时才做跨论文配对
    if (paperTitles.length >= 2) {
      const MAX_IDEAS = 3
      let made = 0

      // 债务按提及论文数降序 —— 优先用"最像领域债务"的那条
      const rankedDebts = [...debts].sort((a, b) => b.occurrence - a.occurrence)

      outer: for (const debt of rankedDebts) {
        // 依次尝试跨论文配对：论文 i 的模块 × 论文 j 的模块
        //
        // 注意两点，否则会生成"看起来像组合、实际上毫无信息量"的候选：
        //   1. 不要用两个**同名**模块配对（如 Encoder × Encoder）——
        //      同一类组件在两篇论文里本来就是类似的东西，配在一起不构成假设
        //   2. 不要用两个**同类型**模块配对（如 ENCODER × ENCODER），
        //      理由同上。优先取类型不同的模块对。
        for (let i = 0; i < paperTitles.length; i++) {
          for (let j = i + 1; j < paperTitles.length; j++) {
            const a = byPaper.get(paperTitles[i])!
            const b = byPaper.get(paperTitles[j])!
            if (a.length === 0 || b.length === 0) continue

            const pair = pickDistinctPair(a, b)
            if (!pair) continue
            const [blkA, blkB] = pair

            candidates.push({
              title:
                `${blkA.name}（${firstWords(paperTitles[i])}） × ` +
                `${blkB.name}（${firstWords(paperTitles[j])}）：面向「${debt.title}」的组合方案`,
              /**
               * ── 问题 7：description 压成「一句话说清这个组合是什么」──
               *
               * 旧文案是"把 A 与 B 放在同一条流程里，尝试回应 C 这一被 N 篇论文
               * 提及的问题。这只是**结构性组合假设**，其有效性未经任何验证。"
               * ——第二句是免责声明，不该混在正文里（用户要的是内容，不是自我否定），
               * 而且"演示模式生成的跨论文组合"这种把实现方式讲给用户听的开头也在。
               *
               * 现在正文只留事实：谁 × 谁、回应哪个问题。
               * "有效性未验证"改由卡片上的「待验证」小徽标表达（见 toRiskBadge）。
               */
              description:
                `把《${paperTitles[i]}》的「${blkA.name}」与` +
                `《${paperTitles[j]}》的「${blkB.name}」放进同一条流程，` +
                `用来回应「${debt.title}」。`,
              blockIndexes: [blkA.index, blkB.index],
              debtIndexes: [debt.index],
              /**
               * ── 问题 7 重做 / P10-S5：why 改成四段式推理链 ──
               *
               * 问题 7 曾把 why 压成"先结果、后理由"的两句。S5 推翻了那个口径：
               * 两句里**没有衔接段**，用户看到的是"两个模块各自是什么"，
               * 但看不到"所以为什么能对上" —— 那才是判断一个组合有没有价值的关键。
               * 面板把它整块渲染为「为什么能解决」，两句话撑不起这个标题。
               *
               * 现在按 prompt 的四段契约（缺口 / 特性 / 衔接 / 可验证预期）产出，
               * 且**四段确实在回答四个不同的问题**：
               *   ① 缺口   = 债务卡在哪（用 role 缺失的那一面表达）
               *   ② 特性   = blkB 具备什么机制层面的能力
               *   ③ 衔接   = 那个能力**怎么**补上缺口（S5 新增，也是关键）
               *   ④ 预期   = 若成立应当观察到什么（可证伪）
               *
               * 按 P3（拍板）：prompt 改了 mock 必须完整同步 ——
               * 否则降级时用户看到的仍是旧的两句式，
               * 而 whyIsVague() 的四段校验会把 mock 自己的输出也判为"空话"，
               * 候选会被静默丢光（0 个 idea）—— 那是比难看更严重的故障。
               */
              why: [
                `①债务的缺口：「${debt.title}」卡在` +
                  `${blkA.role ? `原方案只解决了「${blkA.role}」这一面，` : ''}` +
                  `没有处理它在规模上去之后才暴露的那一段。`,
                `②模块的特性：「${blkB.name}」的机制是` +
                  `${blkB.role || '承担组合中缺失的那一环'}，` +
                  `这一能力此前没有被放进与「${debt.title}」相同的流程里。`,
                `③为什么能对上：把「${blkB.name}」的这项能力接在` +
                  `「${blkA.name}」之后，正好补上第①段里那段没人负责的缺口——` +
                  `两者出自不同论文、从未同框，所以这是一个尚未被验证过的接法。`,
                `④可验证的预期：若这个组合成立，在固定现有算力预算下` +
                  `逐步加大处理规模时，相对只用「${blkA.name}」的基线` +
                  `应当观察到质量继续上升而不是提前持平。`,
              ].join('\n'),
              // 证据用两个模块自身的描述文本 —— 它们确实来自各自论文原文
              evidence: [
                {
                  quote: stripInlineMarkers(blkA.description).slice(0, 280),
                  page: 1,
                  section: 'method',
                },
                {
                  quote: stripInlineMarkers(blkB.description).slice(0, 280),
                  page: 1,
                  section: 'method',
                },
              ].filter((e) => e.quote && e.quote.length >= 5),
            })

            made++
            if (made >= MAX_IDEAS) break outer

            // 每篇论文只取一个模块参与，避免同一对论文反复组合
            break
          }
        }
      }
    }
  }

  return {
    candidates,
    notes: [
      '候选方案由「跨论文模块配对」机械生成，机制说明是模板化推断，不具备真实的科研判断能力。',
      candidates.length === 0
        ? '素材之间没有找到值得组合的跨论文配对，因此没有生成候选方案。' +
          '0 个候选是可接受的答案 —— 编造看起来漂亮的空话才是失败。'
        : `生成了 ${candidates.length} 个跨论文组合候选，均需人工判断其合理性。`,
    ],
  }
}

// ============================================================================
// Crash Test 的 mock 数据（P4 / 问题 8 重做）
//
// 这是 mock 最需要克制的地方。撞车测试的价值在于"敢否定"，
// 而启发式根本没有**语义**推理能力。
//
// ── 问题 8：从"全是免责声明"改成"给明确倾向" ──
//
// 用户拍板的分工：
//   · 结构性检查（模块冲突 / 数据可行性 / 算力可行性）——
//     这些可以**从数据本身的结构**得出结论，mock 必须给出明确倾向，
//     而且这几项才有资格给"可行"。
//   · 新颖性 —— 依赖外部检索/查重能力，mock 的确做不到，
//     所以只给「无法判断（建议查重）」。**不能假装查过**。
//
// 判定依据必须写清楚（"因为两个模块来自同一篇论文"而不是"我判断不了"），
// 这样用户既能拿到结论，也知道结论立在什么上面。
// ============================================================================

function buildMockCrashTest(prompt: string) {
  // ---- 解析 prompt 里的结构性事实 ----
  //   ① 模块来源论文（判断是否真的跨论文）
  //   ② 模块类型（判断两类组件是否同质 —— 同质配对不产生新假设）
  const paperRe = /来自论文：(.+?)（([^）]*)）/g
  const sourcePapers = new Set<string>()
  let pm: RegExpExecArray | null
  while ((pm = paperRe.exec(prompt)) !== null) {
    sourcePapers.add(pm[1].trim())
  }

  /**
   * 解析模块条目：形如 "[0] 名称（TYPE）\n 来自论文：… \n 描述：… \n 作用：…"
   * 拿到 type 才能做"同质组件"的结构判断；拿不到就退化为"不知道"，
   * 不硬编造结论。
   */
  const mdRe = /^\[(\d+)\] (.+?)（([A-Z_]+)）\n\s*来自论文：(.+?)（([^）]*)）\n\s*描述：(.+)\n\s*作用：(.+)$/gm
  interface MockMod { name: string; type: string; paper: string; desc: string; role: string }
  const mods: MockMod[] = []
  {
    let m: RegExpExecArray | null
    while ((m = mdRe.exec(prompt)) !== null) {
      mods.push({
        name: m[2].trim(),
        type: m[3].trim(),
        paper: m[4].trim(),
        desc: m[6].trim(),
        role: m[7].trim(),
      })
    }
  }

  const crossPaper = sourcePapers.size >= 2
  /** 两两模块类型是否完全相同 —— 同类型组件配在一起不构成新假设 */
  const sameTypePairs = mods.some((a, i) =>
    mods.some((b, j) => i !== j && a.type === b.type && a.paper !== b.paper)
  )

  interface MockFinding {
    finding: string
    level: string
    detail: string
    /**
     * 针对性改法（P10 Step2 新增，与 crash-test.ts 的 RawFinding.suggestion 同形）。
     *
     * ── 为什么 mock 也必须给这个字段（P3 原则）──
     *
     * 读侧的 `suggestionFor()` 是「门控 → 模型给的 → 静态表 → 兜底」三级回落。
     * 如果 mock 不产出 suggestion，两种情况都会出问题：
     *   ① mock 路径**永远走不到优先级 2**，实际渲染出来的改法全部来自
     *      静态表 —— 那 mock 与真模型在同一屏上的差异就只剩文案长短，
     *      验收时无法判断"三级回落"到底接通没有；
     *   ② 一旦以后有人去掉静态表，mock 会直接掉到兜底文案。
     *
     * 所以 mock 也要按同样的规则给：
     *   · `PASS`    → 空串（读侧门控会拦掉，这里也保持语义一致）
     *   · `UNKNOWN` → 空串（没查的项目给不出针对性改法，这是诚实）
     *   · `CONCERN` / `BLOCKER` → 写这条结论对应的改法
     *
     * 注意 mock 的改法自然比真模型**通用**（它没有读模块细节的能力），
     * 这恰恰是我们要展示的差异：真模型能说出"是哪两个模块在哪一环冲突"，
     * mock 只能说"换成类型互补的模块对"。差异必须来自能力，不是来自格式。
     */
    suggestion: string
    evidence: Array<{ quote: string; page: number; section: string }>
  }

  // ══ ① 新颖性：mock 做不了，如实说"没查"，并给下一步动作 ══
  //    用户钦定：这一项只能给「无法判断（建议查重）」，绝不能给"可行"。
  const noveltyCheck: MockFinding[] = [
    {
      finding: '无法判断 —— 需要查重才能确认',
      level: 'UNKNOWN',
      detail:
        '判断新颖性要检索已有的论文与实现，这一步需要外部检索能力。' +
        '当前没有接入检索，所以这里既不能说"没人做过"，也不能说"已经有人做过"。' +
        '下一步：拿这个组合的关键词（两个模块名 + 目标问题）去查公开文献。',
      // UNKNOWN = 这一项**没查**。没查过就没有任何依据说该怎么改，
      // 给一条通用改法等于假装查过了 —— 所以留空，让读侧门控返回 null。
      suggestion: '',
      evidence: [],
    },
  ]

  // ══ ② 模块冲突：**结构性判断**（可以给"可行"）══
  const blockConflictCheck: MockFinding[] = []
  if (!crossPaper) {
    blockConflictCheck.push({
      finding: '不建议做 —— 模块没有跨论文',
      level: 'BLOCKER',
      detail:
        '检测到被组合的模块全部来自同一篇论文。所谓"组合"必须跨越至少两篇论文，' +
        '否则只是把同一篇论文里的组件重新描述一遍，不产生新的方法假设。',
      // BLOCKER 也要给改法 —— "救不救得回来"本身是有效信息。
      // 这条的具体动作是：去库里找一篇别的论文的模块来替换其中一个。
      suggestion:
        '从项目已有的其他论文里挑一个类型互补的模块，替换掉这两个中的一个，' +
        '让组合重新跨越两篇论文；若库里只有这一篇，先补充一篇候选论文再重跑。',
      evidence: [],
    })
  } else if (sameTypePairs) {
    blockConflictCheck.push({
      finding: '需要调整 —— 配对的两个模块属于同一类组件',
      level: 'CONCERN',
      detail:
        '两个模块来自不同论文，但类型相同（例如都是编码器/都是检索器）。' +
        '同类组件在各自论文里本来就解决同一个子问题，直接叠加通常不会产生' +
        '新的能力，只会让流程里出现两个功能重叠的环节。' +
        '建议换成类型互补的模块对（如"检索"配"生成后校验"）。',
      suggestion:
        '把这两个同类型模块中的一个换掉，改成与另一个异质的模块 ——' +
        '典型组合是"检索 + 生成后校验"或"压缩 + 条件生成"。' +
        '若两个模块都不可替换，可改为让它们**串行**承担不同阶段的同一职责（先粗筛后精排），' +
        '但要在方案里说清阶段划分，否则仍会被判为功能重叠。',
      evidence: [],
    })
  } else {
    blockConflictCheck.push({
      finding: '可行 —— 模块跨论文且类型互补',
      level: 'PASS',
      detail:
        `已确认这两个模块分别来自 ${sourcePapers.size} 篇不同论文，且类型不同 ——` +
        '它们在流程里承担的是不同环节，不存在"两个组件抢同一个位置"的结构性问题。' +
        '注意：这里只排除了「结构冲突」，两者在机制层面是否真的能配合，' +
        '需要读原文细节判断。',
      // PASS = 通过。门控会拦掉任何改法（包括我们这里写的），
      // 显式留空是为了让 mock 数据与真模型数据在语义上完全一致。
      suggestion: '',
      evidence: [],
    })
  }

  // ══ ③ 数据可行性：**结构性判断**（可以给"可行"）══
  //    依据：跨论文组合要在同一套评测上验证，两篇论文是否都有可用数据描述。
  const dataRequirement: MockFinding[] = crossPaper
    ? [
        {
          finding: '可行 —— 两篇论文都提供了方法描述，可据此设计数据方案',
          level: 'PASS',
          detail:
            '组合涉及的各模块都带原文方法描述，说明对应论文有完整的实验章节，' +
            '其评测数据与指标是可查的。这意味着"要什么数据"这件事可以确定下来。' +
            '注意：这里确认的是「数据可获取」，不是"数据一定够用" ——' +
            '能否支撑新方案的效果验证，要用最小实验先探。',
          suggestion: '',
          evidence: [],
        },
      ]
    : [
        {
          finding: '需要调整 —— 缺少跨论文数据对照',
          level: 'CONCERN',
          detail:
            '模块没有跨论文，无法构造"两种方法在同一评测上对比"的数据方案。' +
            '先确认组合真的跨越两篇论文，再谈数据可行性。',
          suggestion:
            '先把组合改成跨论文的模块对（否则没有可对照的第二套数据），' +
            '再为两篇论文各自锁定一个公开评测集，' +
            '确保新方案能在同一套指标下与两个基线分别对比。',
          evidence: [],
        },
      ]

  // ══ ④ 算力可行性：**结构性判断**（可以给"可行"）══
  //    依据：组合的模块数量 —— 拼接两个已有模块不会带来数量级上升。
  const computeRequirement: MockFinding[] =
    crossPaper && !sameTypePairs
      ? [
          {
            finding: '可行 —— 组合只增加一个环节，算力量级不上升',
            level: 'PASS',
            detail:
              '这个组合是把两个已有模块串起来，没有引入新的训练目标或更大的模型，' +
              '推理链只变长一个环节。相对单篇论文本身的训练/推理开销，' +
              '这是同一量级，不需要额外的大规模算力。',
            suggestion: '',
            evidence: [],
          },
        ]
      : [
          {
            finding: '需要调整 —— 结构问题未澄清前无法评估算力',
            level: 'CONCERN',
            detail:
              '模块配对本身存在结构性问题（未跨论文或类型同质），' +
              '在把组合关系理清之前，算力评估没有意义 —— 换一组模块结论会完全不同。',
            suggestion:
              '先解决上游的模块配对问题，拿到一组类型互补的跨论文模块后重新执行本项检查；' +
              '在那之前不要据此做算力预算。',
            evidence: [],
          },
        ]

  /**
   * ── 总体判定（问题 8 三级 rubric）──
   *
   *   有 BLOCKER            → 不建议做
   *   有 CONCERN / UNKNOWN  → 需要调整
   *   全部 PASS             → 可行
   *
   * 为什么不把 UNKNOWN 当成"没问题"：
   *   新颖性没查过，就永远不该得出"可行"。这正是用户拍板的那条限制 ——
   *   只有结构检查真做了、且都通过，才允许给"可行"。
   */
  const levels = [
    ...noveltyCheck,
    ...blockConflictCheck,
    ...dataRequirement,
    ...computeRequirement,
  ].map((f) => f.level)

  const hasBlocker = levels.includes('BLOCKER')
  const hasConcern = levels.includes('CONCERN')
  const hasUnknown = levels.includes('UNKNOWN')

  const overallVerdict = hasBlocker ? 'INFEASIBLE' : hasConcern || hasUnknown ? 'RISKY' : 'PROMISING'

  const verdictReason = hasBlocker
    ? '结构检查就发现了硬问题（模块没有真正跨论文），不需要再看别的 —— 这个组合不成立。'
    : hasConcern
      ? '结构检查发现模块配对本身需要调整（两个模块属于同一类组件，功能会重叠）。' +
        '把配对换成类型互补的模块后，再重新评估。'
      : '已做的三项结构检查（模块冲突 / 数据可行性 / 算力可行性）全部通过；' +
        '唯一没做的是新颖性检索 —— 在查重之前，这个方案应当按"待验证"看待。'

  return {
    noveltyCheck,
    blockConflictCheck,
    dataRequirement,
    computeRequirement,
    experimentalDesign:
      '先用最小可行实验验证机制是否成立：固定基线、只替换被组合的那个环节、' +
      '控制变量，并明确指标与对照。不要一上来就跑全量评测。',
    /**
     * ── `findings`（补充发现）：mock 这里恒为空数组，但**不能省略** ──
     *
     * 与四个命名数组同形的 `MockFinding[]`，当前 mock 不产出补充发现。
     * 之所以要写字段注释而不是直接留 `[]` 了事：
     * 真模型路径下 `findings` 是**唯一一个曾经漏掉 evidence 的数组**
     * （见 crash-test.ts 里落库处的注释）。mock 形态上必须与真模型
     * 完全同形（P2 按数据来源判定 mock/真模型 —— 形状不一致会让
     * 下游按同一套代码读两种数据，正是一个已经踩过的坑）。
     * 将来 mock 要补 findings，也必须带 evidence（无原文就给 []）。
     */
    findings: [],
    overallVerdict,
    verdictReason,
    conditionsToProceed: hasBlocker
      ? ['换成跨论文的模块对后重新执行检查']
      : [
          ...(hasConcern ? ['把配对换成类型互补的模块（避免同类组件叠加）'] : []),
          '用两个模块名 + 目标问题做一次公开文献查重，确认新颖性',
          '设计最小可行实验，先验证机制是否成立',
        ],
    fatalFlaws: hasBlocker
      ? ['模块未跨论文 —— 该候选不满足"跨论文组合"的定义']
      : [],
  }
}
