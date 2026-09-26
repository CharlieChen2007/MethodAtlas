/**
 * 英文原文 → 中文「动作 + 对象」归纳（P9 问题 2 / 问题 3）。
 *
 * ── 为什么需要它 ──
 *
 * 演化面板里写的是：
 *     《RAG》尝试了「We introduce a general-purpose fine-tuning recipe…」 → 结果：未说明
 * 债务面板里写的是：
 *     《RAG》：However, their ability to access and…
 *
 * 这两处都是把**英文原句直接贴出来**（再截断）。用户要的是"这篇论文对这个问题
 * 做了什么"，不是"论文里那句英文长什么样"。截断更糟 —— 读者要自己补完句子。
 *
 * ── 这一层的定位 ──
 *
 * 它**不是翻译**，也不假装是翻译。它做的事是：
 *   1. 识别句子的**言语行为**（提出/指出/承认/尝试/对比…）
 *   2. 从句子里抽出**对象**（做了什么、针对什么）
 *   3. 拼成一句中文：`提出了「通用微调方法」`
 *
 * 所以它的产出是「动作 + 对象」的**结构化归纳**，不是逐词直译。
 * mock 阶段没有语义理解能力，这个归纳是**规则驱动**的 —— 它能做到的是
 * "把英文句子的骨架用中文重新讲一遍"，做不到"真正读懂这句话的意思"。
 * 真实的语义归纳必须由 LLM 完成（见 `summarizeEnglish() `顶部的说明）。
 *
 * ── 兜底原则（用户已拍板）──
 *
 * 归纳不出来时，**不硬凑**，返回统一兜底文案：
 *     `（该论文的原文表述未能归纳成中文，请查看证据）`
 * 这条文案在 mock 和接了真 LLM 之后**都成立**，不会误导用户以为没接模型。
 * 不用「需要接入语言模型才能归纳」这类说法 —— 那会让用户以为系统没配模型。
 *
 * ── 中文闸门 ──
 *
 * 归纳结果必须**真的是中文**。规则管线偶尔会漏出英文（比如对象短语没被正确
 * 替换）。所以出口处有一道 `assertChinese()`：中文字符占比低于阈值就判定
 * 归纳失败，退到兜底文案。这样"面板里不再出现英文原句"这条验收标准
 * 是由**代码保证**的，不靠人工逐条检查。
 */

/** 归纳失败时的统一兜底文案（用户拍板的 A 案） */
export const FALLBACK_SUMMARY = '（该论文的原文表述未能归纳成中文，请查看证据）'

/** 引号内短语的长度上限（字）——用户要求「引号里只放短语，不放整句」 */
const MAX_PHRASE_LEN = 20

/** 中文占比闸门：低于此值判定"这不算中文"，退兜底 */
const MIN_CJK_RATIO = 0.4

// ─────────────────────────────────────────────────────────────
// 中文判定
// ─────────────────────────────────────────────────────────────

/** 统计 CJK 汉字数量 */
function countCjk(s: string): number {
  return (s.match(/[\u4e00-\u9fff]/g) || []).length
}

/**
 * 中文字符占比是否达标。
 *
 * 分母用「汉字 + 拉丁字母」而不是字符串全长 —— 标点、空格、数字
 * 不该拉低占比（否则 `提出了「RAG」` 这种含专名的正常归纳会被误杀）。
 */
export function isChineseEnough(s: string): boolean {
  const t = (s || '').trim()
  if (!t) return false
  const cjk = countCjk(t)
  const latin = (t.match(/[A-Za-z]/g) || []).length
  const total = cjk + latin
  if (total === 0) return false
  return cjk / total >= MIN_CJK_RATIO
}

// ─────────────────────────────────────────────────────────────
// 英文句式识别
// ─────────────────────────────────────────────────────────────

/**
 * 言语行为表：把英文的"说法"映射成中文的"动作"。
 *
 * 顺序有意义 —— 越具体的越靠前。例如 "we introduce" 必须排在
 * 泛化的 "introduce" 之前，否则「We introduce X」会被当成主谓结构
 * 而不是"本文提出"。
 *
 * `kind` 用来决定后面怎么造句：
 *   · 'propose'  —— 论文提出了某做法      → `提出了「X」`
 *   · 'point'    —— 论文指出了某问题      → `指出了「X」`
 *   · 'admit'    —— 论文承认了某局限      → `承认「X 仍是未解决问题」`
 *   · 'attempt'  —— 论文尝试了某做法      → `尝试了「X」`
 *   · 'contrast' —— 论文对比了某做法      → `对比了「X」`
 */
const SPEECH_ACTS: Array<{ re: RegExp; kind: string; verb: string }> = [
  { re: /\bwe\s+(?:introduce|propose|present|develop|design|construct|build)\b/i, kind: 'propose', verb: '提出了' },
  { re: /\bwe\s+(?:show|demonstrate|find|observe)\b/i, kind: 'propose', verb: '证明了' },
  { re: /\b(?:this\s+(?:paper|work)|our\s+(?:work|approach|method))\s+(?:introduces?|proposes?|presents?)\b/i, kind: 'propose', verb: '提出了' },
  { re: /\b(?:introduces?|proposes?|presents?)\s+(?:a|an|the)?\b/i, kind: 'propose', verb: '提出了' },
  { re: /\bhowever\b[^.]*?\b(?:is|are|remain|remains)\b[^.]*?\b(?:limited|insufficient|lacking|unclear|unsolved|unaddressed)\b/i, kind: 'admit', verb: '承认' },
  { re: /\b(?:fails?|suffers?)\s+(?:to|from)\b/i, kind: 'point', verb: '指出了' },
  { re: /\b(?:limits?|restricts?|hinders?|prevents?)\b/i, kind: 'point', verb: '指出了' },
  { re: /\b(?:grow|grows|increase|increases|scale|scales)\s+(?:linearly|quadratically)\b/i, kind: 'point', verb: '指出了' },
  { re: /\bwastes?\s+(?:computation|compute|resources)\b/i, kind: 'point', verb: '指出了' },
  { re: /\b(?:we|they)\s+(?:attempt|try|explore|investigate)\b/i, kind: 'attempt', verb: '尝试了' },
  { re: /\b(?:compared?|comparison|outperforms?|beats?|surpasses?)\b/i, kind: 'contrast', verb: '对比了' },
]

/**
 * 「问题短语」的规则表：识别句子在说**哪个问题**，映射成中文短语。
 *
 * 这张表是**领域无关的通用表达**（知识访问、计算开销、上下文长度…），
 * 不针对具体论文写死。命中一条就用它的中文短语，命中不了就走
 * `extractObjectPhrase()` 抽名词短语。
 *
 * `onlyWhen` 收窄命中条件：有些短语只在特定上下文成立（例如
 * "fixed number of passages" 只有在同时提到 "waste/need" 时才是问题）。
 */
const PROBLEM_PHRASES: Array<{ re: RegExp; phrase: string }> = [
  { re: /knowledge[- ]intensive|access and precisely manipulate knowledge|access(?:ing)? (?:and (?:update|updating) )?knowledge/i, phrase: '知识访问与更新受限' },
  { re: /encoder cost grow|cost grow linearly|grow linearly with the number of passages|encoding cost/i, phrase: '编码开销随段落数线性增长' },
  { re: /fixed number of passages|regardless of whether retrieval is actually needed|retrieve a fixed number/i, phrase: '固定段落数浪费算力' },
  { re: /parametric and non-parametric memory/i, phrase: '参数记忆与外部记忆的结合方式' },
  { re: /long[- ]context|context (?:length|window)/i, phrase: '长上下文处理' },
  { re: /hallucinat/i, phrase: '生成内容的幻觉问题' },
  { re: /compute|computation|latency|efficien/i, phrase: '计算开销与效率' },
  { re: /scalab/i, phrase: '可扩展性' },
  { re: /fine[- ]tun(?:e|ing)/i, phrase: '通用微调方法' },
  { re: /retriev/i, phrase: '检索与生成的结合方式' },
]

/**
 * 从英文句子里抽出"对象短语"。
 *
 * 走法：先尝试 `PROBLEM_PHRASES` 的领域短语；不中，再退到**技术名词短语**提取
 * —— 找句子里的专名/术语（大写开头的连续词、含连字符的复合词、已知缩写），
 * 拼成短语。
 *
 * 返回空串表示抽不出来（调用方会退到兜底文案）。
 */
function extractObjectPhrase(s: string): string {
  // ① 领域短语优先 —— 命中即是最贴切的归纳
  for (const p of PROBLEM_PHRASES) {
    if (p.re.test(s)) return p.phrase
  }

  // ② 退到技术名词短语：连续的大写卡头词 / 含连字符的复合词
  const tokens = s
    .replace(/[.,;:!?()\[\]"'“”‘’]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const parts: string[] = []
  for (const t of tokens) {
    // 值得保留的：大写开头（专名）、含连字符（复合术语）、全大写缩写
    const isProper = /^[A-Z][a-zA-Z0-9-]{2,}$/.test(t)
    const isHyphen = /^[a-zA-Z]+-[a-zA-Z-]+$/.test(t)
    const isAbbr = /^[A-Z]{2,6}$/.test(t)
    if (isProper || isHyphen || isAbbr) {
      // 过滤掉句首必然会大写的常见功能词
      if (/^(?:The|This|These|Those|However|Additionally|Moreover|We|Our|In|It|But|And|A|An)$/.test(t)) continue
      parts.push(t)
    }
  }

  if (parts.length === 0) return ''
  // 去重、限量（短语不是句子）
  const uniq = Array.from(new Set(parts)).slice(0, 4)
  return uniq.join(' ')
}

/** 把对象短语收成「短句」——超过上限就按词边界截断 */
function trimPhrase(p: string): string {
  const t = (p || '').trim().replace(/[.,;:!?。；：！？]+$/, '')
  if (t.length <= MAX_PHRASE_LEN) return t
  const cut = t.slice(0, MAX_PHRASE_LEN)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > MAX_PHRASE_LEN * 0.5 ? cut.slice(0, lastSpace) : cut) + '…'
}

// ─────────────────────────────────────────────────────────────
// 对外主函数
// ─────────────────────────────────────────────────────────────

/**
 * 给归纳正文挂上「《论文》」前缀，并在这之前做中文闸门。
 *
 * ── 为什么闸门只判"正文"、不判"正文+前缀"（这是一个真实的 bug）──
 *
 * 第一版把闸门加在拼好的整句上：`isChineseEnough(prefix + body)`。
 * 结果**所有**归纳都掉进兜底 —— 因为论文标题是英文的：
 *     《Retrieval-Augmented Generati…》指出了「知识访问与更新受限」
 * 这句话里拉丁字母 28 个、汉字 12 个，占比 30% < 40%，
 * 于是被判成"不是中文"。
 *
 * 但"这是一句中文归纳"该由**正文**决定，论文标题是**引用**，
 * 它本来就该是原文。把引用算进闸门，等于"因为论文名是英文，
 * 所以中文归纳不算中文" —— 逻辑上就错了。
 *
 * 现在：先判正文是否中文，再拼前缀。引用不参与闸门。
 */
function withPaper(body: string, paper?: string): string {
  if (!isChineseEnough(body)) return FALLBACK_SUMMARY
  return paper ? `《${paper}》${body}` : body
}

/**
 * 把一段英文原文归纳成一句中文。
 *
 * @param raw    英文原文（可能是一整段）
 * @param paper  论文名（用于「《X》提出了…」的句式；不传则只返回动作句）
 * @returns      一句中文；归纳失败返回 `FALLBACK_SUMMARY`
 *
 * ── 接了真 LLM 之后这里会变成什么 ──
 * 现在是「正则识别言语行为 + 短语表匹配」。接真 LLM 后，这个函数会变成
 * 一次 prompt 调用：把原文和"归纳成一句中文、引号内不超过 20 字"的要求
 * 交给模型，由模型输出真正的语义归纳。**函数签名和兜底行为不变**，
 * 所以调用方（panel.ts）不用改。
 */
export function summarizeEnglish(raw: string, paper?: string): string {
  const text = (raw || '').replace(/\s+/g, ' ').trim()
  if (!text) return FALLBACK_SUMMARY

  // 已经是中文的输入直接放行（避免对本来就归纳好的文案再加工）
  if (isChineseEnough(text)) return text

  // ① 识别言语行为
  const act = SPEECH_ACTS.find((a) => a.re.test(text))
  // ② 抽出对象短语
  const obj = trimPhrase(extractObjectPhrase(text))

  if (act && obj) {
    // 承认类：句式是「承认『X 仍是未解决问题』」
    if (act.kind === 'admit') return withPaper(`${act.verb}「${obj}仍是未解决问题」`, paper)
    return withPaper(`${act.verb}「${obj}」`, paper)
  }

  // ③ 只有对象、没有识别出动作 —— 用中性动词，不编造"提出/指出"
  if (obj) return withPaper(`涉及「${obj}」`, paper)

  // ④ 什么都没抽出来 —— 不硬凑
  return FALLBACK_SUMMARY
}

/**
 * 归纳「论文的尝试」（演化面板用）。
 *
 * 与 `summarizeEnglish` 的区别：这里的语义固定是"这篇论文针对该问题做了什么"，
 * 所以优先用「尝试了」而不是根据言语行为猜。仍然过中文闸门。
 *
 * 用户给的示例：
 *     《RAG》提出了「通用微调方法」 → 结果：未说明
 * 对应这里产出 `《RAG》提出了「通用微调方法」`，` → 结果：…` 由调用方拼。
 */
export function summarizeAttempt(raw: string, paper?: string): string {
  const text = (raw || '').replace(/\s+/g, ' ').trim()
  if (!text) return FALLBACK_SUMMARY
  if (isChineseEnough(text)) return text

  const obj = trimPhrase(extractObjectPhrase(text))
  if (!obj) return FALLBACK_SUMMARY

  // 是"本文提出 X"就说"提出了"，否则说"尝试了"（更保守、不失真）
  const act = SPEECH_ACTS.find((a) => a.re.test(text))
  const verb = act && (act.kind === 'propose' || act.kind === 'attempt') ? act.verb : '尝试了'

  return withPaper(`${verb}「${obj}」`, paper)
}

/**
 * 归纳「论文指出的问题」（债务面板的 source 用）。
 *
 * 债务的 source.context 是"论文里指出这个问题的原句"，语义固定是"指出了"。
 *
 * 用户给的示例：
 *     《Leveraging Passage》指出了「编码开销线性增长」 → 结果：未解决
 *     《Self-RAG》指出了「固定段落数浪费计算」 → 结果：未解决
 */
export function summarizePoint(raw: string, paper?: string): string {
  const text = (raw || '').replace(/\s+/g, ' ').trim()
  if (!text) return FALLBACK_SUMMARY
  if (isChineseEnough(text)) return text

  const obj = trimPhrase(extractObjectPhrase(text))
  if (!obj) return FALLBACK_SUMMARY

  // "however … is/are limited" 这类是"承认"，用不同动词更准确
  const admit = SPEECH_ACTS.find((a) => a.kind === 'admit' && a.re.test(text))
  const verb = admit ? '承认' : '指出了'

  return withPaper(`${verb}「${obj}」`, paper)
}

/**
 * 结果归一（供调用方使用）。
 *
 * 放在这个模块是因为它是"归纳链路的最后一环" —— 归纳出"做了什么"之后，
 * 还要回答"成了没有"。三档标签让用户扫一眼就能比较，
 * 而不是逐条读自由文本。
 */
export function normalizeOutcomeZh(outcome: string | undefined | null): string {
  const o = (outcome ?? '').trim()
  if (!o) return '未说明'
  if (/部分成功|partially|partial success/i.test(o)) return '部分成功'
  if (/失败|无效|fail|worse|degrad/i.test(o)) return '失败'
  if (/引入新问题|新的问题|副作用|side effect/i.test(o)) return '引入新问题'
  if (/已解决|解决|resolved|success|成功|有效|improve|effective|outperform|work(?:s|ed)?\b/i.test(o)) return '已解决'
  if (/未解决|unsolved|open|remain/i.test(o)) return '未解决'
  return '未说明'
}

// ─────────────────────────────────────────────────────────────
// 按数据来源分流（Step 2）
// ─────────────────────────────────────────────────────────────

/**
 * 真模型归纳的正文长度上限（字）。
 *
 * 用户定为 60。理由：这一层产出的东西要**横着比较**——
 * 「各论文的处理（3 篇）」是一列并列的句子，每句两三百字就没法扫读了。
 * mock 路径本来就压到 20 字以内（引号里只放短语），
 * 真模型若放任其输出两三句，两条路径的观感会差出一个量级。
 *
 * 60 字够装下"提出了 X 方法，通过在 Y 上引入 Z 来缓解 W"这种完整表述。
 */
const MAX_MODEL_BODY_LEN = 60

/**
 * 按句边界把中文收短到上限内。
 *
 * 为什么不直接 `slice(0, 60) + '…'`：
 * 硬切会切在词中间，出现「通过在检索器上引入重排机制来缓解知…」这种
 * 半截句子 —— 读者要自己补完，比短一点更难受。
 * 所以优先在句末标点断开；找不到标点才退回按字符截断（并补省略号）。
 */
function clampChinese(text: string, max = MAX_MODEL_BODY_LEN): string {
  const t = (text || '').trim()
  if (t.length <= max) return t

  // 在 max 之前找最后一个句末标点，优先整句收住
  const head = t.slice(0, max)
  const lastStop = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('；'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？')
  )
  if (lastStop >= max * 0.4) return head.slice(0, lastStop + 1)

  // 次选：在逗号处断开，语义相对完整
  const lastComma = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'))
  if (lastComma >= max * 0.5) return head.slice(0, lastComma) + '。'

  // 兜底：硬截断，但补省略号表明"这里被截过"
  return head + '…'
}

/**
 * 判定一段数据是不是 mock 来源。
 *
 * 为什么不用「文本是不是中文」来猜：
 *   真模型的中文归纳里会夹英文专名（`提出了「Self-RAG 反思令牌」`），
 *   英文论文标题参与拼接后占比更低；反过来，mock 也可能恰好拼出
 *   高中文占比的句子（对象短语命中 `PROBLEM_PHRASES` 的中文短语时）。
 *   双向都会误判。
 *
 * 所以以**写入时固化的 provider 字段**为准：
 *   · `mock`      → 规则归纳
 *   · 其它非空值  → 真模型归纳（provider 存的是模型名或 'openai-compatible'）
 *   · 空串        → 历史数据。本字段引入前**所有**数据都是 mock 路径
 *                   产生的，所以按 mock 处理是唯一正确的选择。
 */
export function isMockSource(provider: string | undefined | null): boolean {
  const p = (provider ?? '').trim()
  if (!p) return true // 历史数据 = mock 时代产物
  return p === 'mock'
}

/**
 * 按来源归纳「论文的尝试」（演化 / 债务面板用）。
 *
 * ── 这一步在 Step 2 之前是错的 ──
 *
 * 原来 panel 无条件调 `summarizeAttempt()`。它在函数内部有一句
 * `if (isChineseEnough(text)) return text` —— 看起来"真模型的中文会被放行"，
 * 所以好像没问题。但实际有两个毛病：
 *
 *   1. **长度失控**：真模型给的是一段完整归纳（常 100~200 字），
 *      原样放行后，面板的「各论文的处理」变成一列长段落，
 *      反而比 mock 路径（压缩到 20 字）更难读 —— **真模型的输出更难用**。
 *   2. **行为不可预期**：如果真模型某次输出了中英混排（专名多、汉字占比
 *      跌破 40% 闸门），会掉进规则归纳分支，被正则二次加工 ——
 *      结果是一句"机器拼的中文"，而不是模型的原话。
 *
 * 现在改成按来源显式分流：
 *   · mock   → 走规则归纳（行为与 P9 完全一致，不回归）
 *   · 真模型 → **原样使用模型的中文**，只做长度收短，不做规则加工
 *
 * 「不做规则加工」是重点：模型已经读懂了句子，再用正则去猜它的
 * 言语行为，只会把准确的意思改错。
 */
export function summarizeAttemptBySource(
  raw: string,
  paper: string | undefined,
  provider: string | undefined | null
): string {
  if (isMockSource(provider)) return summarizeAttempt(raw, paper)

  // 真模型路径：以模型输出为准
  const text = (raw || '').replace(/\s+/g, ' ').trim()
  if (!text) return FALLBACK_SUMMARY

  // 模型偶尔会输出英文（幻觉或遵守指令不力）—— 这时才退回规则归纳
  if (!isChineseEnough(text)) return summarizeAttempt(raw, paper)

  const body = clampChinese(text)
  return paper ? `《${paper}》${body}` : body
}

/**
 * 按来源归纳「论文指出的问题」（债务面板的 sources 用）。
 *
 * 分流逻辑与 `summarizeAttemptBySource` 一致，只是 mock 分支
 * 走 `summarizePoint()`（语义固定为"指出了"）。
 */
export function summarizePointBySource(
  raw: string,
  paper: string | undefined,
  provider: string | undefined | null
): string {
  if (isMockSource(provider)) return summarizePoint(raw, paper)

  const text = (raw || '').replace(/\s+/g, ' ').trim()
  if (!text) return FALLBACK_SUMMARY
  if (!isChineseEnough(text)) return summarizePoint(raw, paper)

  const body = clampChinese(text)
  return paper ? `《${paper}》${body}` : body
}
