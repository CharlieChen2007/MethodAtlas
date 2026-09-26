/**
 * Block 名字规范化 —— P9 问题 1 的核心逻辑。
 *
 * ── 为什么单独成一个模块 ──
 *
 * 和 block-role 同样的理由：这段规则有两个消费者
 *   1. 数据层（llm-mock.ts）—— DNA 抽取时给每个 Block 写 name；
 *   2. 维护脚本（scripts/reseed-roles.mjs）—— 刷新存量 Block 的 name。
 * 抽出来两边共用一份规则，不会出现"代码更新了、脚本还用旧的"。
 *
 * ── 原来的名字为什么必须废掉 ──
 *
 * 实测库里 20 个 Block，名字是从原文句子**直接切出来的片段**：
 *     "RAG-Sequence and RAG-Token both achieve state-of-the-art results"  （完整句子）
 *     "Self-RAG outperforms ChatGPT and retrieval-augmented baselines such"（被截断）
 *     "used to retrieve text documents z"                                  （被动式 + 变量名）
 *     "design"                                                             （空壳）
 * 用户看到的画布节点名，就是这些。它不是"模块名"，是"句子残骸"。
 *
 * ── 现在的做法：五步管线 ──
 *
 *   ① 剥引用标记   —— 复用 stripInlineMarkers
 *   ② 切第一个从句 —— 在 which/that/where/when/,/;/: 处切
 *   ③ 判"是不是句子片段" —— 含动词 / 含 3 个以上实词 / 超长
 *   ④ 提缩写       —— Retrieval-Augmented Generation → RAG
 *   ⑤ 按三条规则组装最终名
 *
 * ── 一条重要的克制 ──
 *
 * 规范化的目标是**修坏的，不是改好的**。
 * `Fusion-in-Decoder`、`Self-RAG` 这类已经是合格名词短语的，
 * 一律原样放行 —— 不强制转成 `FiD (Fusion-in-Decoder)`。
 * 判断依据是 `isCleanName()`：只由名词性词构成、无动词、长度适中。
 * 这条保证了幂等性：规范化跑两次，结果与跑一次相同。
 */

/** 名字超过这个长度才考虑规范化（产品要求 30 字符） */
const LONG_NAME_THRESHOLD = 30

/** 最终名字的最大长度 */
const MAX_NAME_LEN = 48

/**
 * 「缩写 (全称)」里全称的最大长度 —— 比 MAX_NAME_LEN 宽。
 *
 * 全称是次要信息（用户主要看缩写），可以长一点；
 * 而且全称只是**在原文里存在**，我们只是转述，不该因为它长就丢掉它。
 */
const MAX_FULL_LEN = 60

/**
 * 句子片段判定用的动词表。
 *
 * 只收"一看就是谓语"的词 —— 名词短语里不会出现它们。
 * 特别注意 `used` / `designed` 这类过去分词：它们出现在
 * "used to retrieve..." 这种被动式片段里，是该被判定为片段的强信号。
 */
const VERB_RE =
  /\b(?:is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|will|would|shall|should|may|might|must|propose|proposes|proposed|introduce|introduces|introduced|present|presents|presented|design|designs|designed|develop|develops|developed|use|uses|used|using|retrieve|retrieves|retrieved|encode|encodes|encoded|generate|generates|generated|combine|combines|combined|achieve|achieves|achieved|outperform|outperforms|outperformed|show|shows|showed|demonstrate|demonstrates|demonstrated|investigate|investigates|evaluate|evaluates|evaluated|consider|considers|considered|make|makes|made|grow|grows|grew|lead|leads|led|allow|allows|allowed|require|requires|required|reduce|reduces|reduced|improve|improves|improved|provide|provides|provided|concatenate|concatenates|concatenated)\b/i

/**
 * 判断一个字符串是否是**纯连接词/虚词**拼起来的（没有任何实义内容）。
 *
 * 与 `CONNECTOR_RE`（只看开头）的区别：
 *   "Moreover, this approach" 开头是连接词，但后面 `approach` 是实词 ——
 *   这种名字该被**剥掉前缀**变成 "Approach"，而不是整条丢掉。
 *   "On the other hand" 则是**整条**都由虚词构成 —— 一个实词都没有，
 *   这种必须整条判死，否则会退化出 OH 这种假缩写。
 *
 * 这就是 `OH (Other Hand)` 的成因：单看每个词都"词形合法"，
 * 于是 `isPlausibleNounPhrase` 放行、`deriveAbbr` 还给它编了个缩写。
 */
function isAllConnectorWords(s: string): boolean {
  /**
   * ── 只对**纯 ASCII** 字符串生效（关键守卫）──
   *
   * 这个函数的判定方式是「把所有非 a-z 字符抹掉，看剩下的是不是全是连接词」。
   * 对纯中文名（"粒子滤波融合"）来说，抹掉后**一个词都不剩** ——
   * 如果此时返回 true，整个模块名会被判为"全虚词"而丢弃。
   *
   * 这正是我在第一版里踩的坑：一次回归测试中 23 个真实中文模块名
   * 有 16 个被清空或改写。中文名根本不该由"英文连接词表"来裁决 ——
   * 它压根不适用。所以先判断是否含 CJK，含则直接放行（交给长度/
   * 其他规则去管），只对拉丁文本做连接词判定。
   */
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)) return false

  const words = s
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  /**
   * 抹掉非字母字符后没有剩余词，说明这串字符里**没有任何拉丁字母**
   * （例如纯数字、纯符号、"µs" 之类）。这种情况不能判为"全连接词" ——
   * 我们没有证据说它是连接词，按"不适用"处理，返回 false 放行。
   */
  if (words.length === 0) return false
  return words.every((w) => new RegExp(`^(?:${CONNECTOR_ALT})$`, 'i').test(w))
}

/**
 * 是否命中多词连接短语（整段）。
 *
 * 用 `includes` 而不是 `startsWith`：调用方会把首尾都裁干净，
 * 但 "there is, on the other hand, a method" 这种插入语也要能被抓到。
 */
function hitsConnectorPhrase(s: string): boolean {
  /**
   * 同样只对纯 ASCII 生效 —— 中文名里不会出现英文连接短语，
   * 而且下面的 `[^a-z\s]` 归一化会把中文全抹掉，可能凑出假匹配。
   */
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)) return false

  const lower = s.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return CONNECTOR_PHRASES.some((p) => lower === p || lower.startsWith(p + ' '))
}

/**
 * 名词短语里允许出现的连接词。
 *
 * `Fusion-in-Decoder` 的 `in`、`Retrieval-Augmented` 的连字符，
 * 都属于"合格名字"的组成部分 —— 判断时不能把它们当成杂音。
 */
const NOUN_GLUE_RE =
  /^(?:[A-Za-z][A-Za-z0-9\-]*|of|for|in|on|to|with|by|from|as|and|or|the|a|an)$/

/**
 * ── 句首不该作为模块名开头的词（含连接词/虚词）──
 *
 * ⚠️ 这个表是**唯一的连接词事实来源**，`LEADING_STOP_RE` / `EDGE` 都从它派生。
 *
 * 为什么要把它们合并（P10 问题 3）：
 *   原先 `LEADING_STOP_RE`（判"不合格"用）和 `EDGE`（剥停用词用）是两张
 *   各写各的表，而且都有漏。后果不是"名字丑一点"，是**假模块**进了库：
 *
 *     "On the other hand" → "OH (Other Hand)"   ← 看着像正经缩写，实际是连接词
 *     "Moreover, this approach" → "Moreover Approach"
 *     "Thus, the system" → "Thus System"
 *
 *   `OH (Other Hand)` 尤其危险：它长得跟 `FiD (Fusion-in-Decoder)` 一模一样，
 *   人眼扫过去不会觉得有问题 —— 但它描述的是"另一方面"，不是任何方法。
 *   用户会据此以为这篇论文真有个叫 OH 的组件。
 *
 * 所以两张表合并成一份，并**补齐学术英语里全部高频连接词**。
 */
const CONNECTOR_WORDS = [
  // 并列/转折
  'however', 'nevertheless', 'nonetheless', 'but', 'yet', 'whereas',
  'although', 'though', 'while', 'whilst', 'instead', 'conversely',
  'contrarily', 'conversely', 'rather', 'unlike', 'except',
  // 递进/补充
  'moreover', 'furthermore', 'additionally', 'besides', 'also', 'plus',
  'similarly', 'likewise', 'correspondingly', 'equally', 'namely',
  'specifically', 'particularly', 'notably', 'importantly', 'especially',
  // 因果/推论
  'therefore', 'thus', 'hence', 'consequently', 'accordingly', 'so',
  'since', 'because', 'as', 'for', 'given', 'thereby', 'thence',
  // 总结/让步
  'overall', 'generally', 'typically', 'ultimately', 'finally', 'lastly',
  'briefly', 'summarily', 'altogether', 'regardless', 'anyway',
  // 时序/条件
  'meanwhile', 'afterwards', 'subsequently', 'previously', 'initially',
  'originally', 'eventually', 'currently', 'now', 'then', 'meanwhile',
  'otherwise', 'if', 'unless', 'provided', 'assuming', 'suppose',
  // 从句引导词 —— 最容易漏的一类：单独看像名词，实际只是从句开头
  // （"when the method ..." / "where the sensor ..." 曾被当成模块名）
  'when', 'whenever', 'where', 'wherever', 'whence', 'whereby',
  'wherein', 'whether', 'whilst', 'whither',
  // 综述/举例
  'first', 'firstly', 'second', 'secondly', 'third', 'thirdly',
  'next', 'following', 'above', 'below', 'here', 'there', 'theoretically',
  'empirically', 'practically', 'ideally', 'in', 'on', 'at', 'by',
  'with', 'from', 'to', 'of', 'into', 'onto', 'upon', 'about',
  // 代词/指示词（出现在短语开头 = 句子残骸）
  'we', 'our', 'this', 'that', 'these', 'those', 'it', 'its', 'they',
  'their', 'there', 'here', 'such', 'which', 'who', 'whom', 'whose',
  'other', 'another', 'each', 'every', 'all', 'some', 'many', 'most',
  'both', 'either', 'neither', 'any', 'one', 'two', 'several',
  'consider', 'using', 'used', 'the', 'a', 'an', 'and', 'or',
  // 时间副词（"Eventual Improvement" 这类假名字的来源）
  'eventual', 'initial', 'final', 'subsequent', 'prior', 'previous',
  'current', 'recent', 'later', 'earlier',
]

/**
 * 多词连接短语 —— 必须**整词序列**匹配。
 *
 * 单靠上面的单词表拦不住 "On the other hand"（每个词单看都合法，
 * 而且会被缩写化成 OH）。所以对这类固定搭配单独列一条，
 * 在**规范化之前**先整段识别掉。
 *
 * 排序要求：长的在前，避免 "on the contrary" 被 "on the" 截断。
 */
const CONNECTOR_PHRASES = [
  'on the other hand', 'on the contrary', 'on the one hand',
  'in other words', 'in contrast', 'in addition', 'in particular',
  'in fact', 'in general', 'in summary', 'in short', 'in conclusion',
  'in practice', 'in theory', 'in essence', 'in effect',
  'at the same time', 'at the same', 'at first', 'at last',
  'as a result', 'as a consequence', 'as such', 'as well', 'as opposed',
  'by contrast', 'by comparison', 'by way', 'by the same token',
  'for example', 'for instance', 'for this reason', 'for these reasons',
  'to this end', 'to that end', 'to sum up', 'to conclude',
  'with respect', 'with regard', 'with this', 'with that',
  'of course', 'of note', 'of interest',
  'due to', 'owing to', 'thanks to', 'prior to', 'contrary to',
  'the other hand', 'other words', 'other hand',
]

/** 把单词表编译成正则字符类 */
const CONNECTOR_ALT = CONNECTOR_WORDS.map((w) =>
  w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
).join('|')

/**
 * 是否含 CJK（中文/日文/韩文）字符。
 *
 * 连接词表是为**英文**写的，用它去裁决中文模块名没有意义，
 * 而且 `^(?:...)\b` 里的 `\b` 在 CJK 边界上行为与直觉不同。
 * 所有连接词判定都先用它把中文放行。
 */
const HAS_CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/

/**
 * 句首是连接词/虚词 → 不合格（也用于剥停用词）。
 *
 * `(?![\u3400-\u9fff...])` 这个否定前瞻是必需的：不加的话
 * `^the\b` 之类会去匹配中文串里意外出现的字母，而且我们根本
 * 不该对中文名做英文连接词判定。直接在这里一次性挡住，
 * 比在每个调用点各写一遍更不容易漏。
 */
const CONNECTOR_RE = new RegExp(
  `^(?!\\p{Script=Han})(?:${CONNECTOR_ALT})\\b`,
  'iu'
)

/** 短语层判定：整段匹配多词连接短语 */
const CONNECTOR_PHRASE_RE = new RegExp(
  `^(?:${CONNECTOR_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
)


/**
 * 已知缩写的"全称 → 缩写"推导。
 *
 * 一般规则（取首字母）能覆盖绝大多数情形，但有几个特例会算错：
 *   · Dense Passage Retriever → 首字母 DPR ✓（一般规则就对）
 *   · Fusion-in-Decoder       → 首字母 FD ✗（实际习惯叫 FiD）
 * 所以特例单独列出来，一般规则兜底。
 */
const ABBR_OVERRIDES: Record<string, string> = {
  'fusion in decoder': 'FiD',
  'fusion-in-decoder': 'FiD',
  'retrieval augmented generation': 'RAG',
  'dense passage retriever': 'DPR',
  'self rag': 'Self-RAG',
  'recurrent neural network': 'RNN',
  'large language model': 'LLM',
}

/**
 * 从「全称」推导缩写：取每个实词的首字母。
 *
 * 连字符词（`Retrieval-augmented`）算**一个**词，
 * 否则 `RAG` 会被算成 `RA` 少一个字母。
 */
function deriveAbbr(full: string): string {
  const key = full
    .toLowerCase()
    .replace(/[()（）]/g, ' ')
    .replace(/[\s_]+/g, ' ')
    .trim()
  if (ABBR_OVERRIDES[key]) return ABBR_OVERRIDES[key]
  if (ABBR_OVERRIDES[key.replace(/-/g, ' ')]) return ABBR_OVERRIDES[key.replace(/-/g, ' ')]

  const words = full
    // 先按空白切，连字符整体保留为一个词
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z\-]/g, ''))
    .filter(Boolean)
    .filter(
      (w) => !/^(?:of|for|in|on|to|with|by|from|as|and|or|the|a|an)$/i.test(w)
    )
  if (words.length < 2) return ''
  const abbr = words.map((w) => w[0].toUpperCase()).join('')
  // 缩写太短（1 个字母）或太长（>6）都不像真缩写，放弃
  if (abbr.length < 2 || abbr.length > 6) return ''
  return abbr
}

/** 判断括号里的东西是不是一个缩写（全大写、2-6 位） */
function isAbbr(s: string): boolean {
  const t = s.replace(/[^A-Za-z0-9-]/g, '')
  return /^[A-Z][A-Z0-9-]{1,5}$/.test(t)
}

/**
 * 判断一个短语是不是**已经合格**的模块名。
 *
 * 合格 = 不含谓语动词 + 不超过 6 个词 + 不以停用词开头。
 * 命中的一律原样保留 —— 这是"不改好的"那条克制的执行点。
 *
 * 注意这里**不要求每个词都在白名单里**。
 * 第一版要求了，结果 `Generative Models for Open Domain Question Answering`
 * 因为 `Open` 不在白名单被判成片段 —— 那是误伤：它是个规规矩矩的名词短语。
 * 正确的判据是"**不含动词**"，而不是"每个词都认识"。
 */
export function isCleanName(name: string): boolean {
  const n = trimTail((name || '').trim().replace(/\s+/g, ' '))
  if (!n) return false

  /**
   * ── 先放行「缩写 (全称)」这一种形式 ──
   *
   * 这是本模块**自己产出的标准格式**（`RAG (Retrieval-augmented Generation)`），
   * 也是用户明确要求的格式。如果不在这里放行，会形成一个死循环：
   *   规范化产出 A → isCleanName(A)=false → 下次跑又被当成片段改写。
   * 幂等性就毁了。
   *
   * 判定：括号外是 2-6 位缩写，括号内是不含动词的名词短语。
   */
  const pair = splitAbbrAndFull(n)
  if (pair) {
    const inner = pair.full
    const innerWords = inner.split(/\s+/)
    if (VERB_RE.test(inner)) return false
    if (innerWords.length > 6) return false
    /**
     * 括号内的**全称**可以比 30 字符长一些 ——
     * 因为它在屏幕上是被缩写"带出来"的次要信息，不是主标识。
     * 第一版直接套用 30 字符阈值，把
     * `PPD (Providing Provenance for Decisions)`（34 字符）判成片段，
     * 于是它每次都被重新规范化，幂等性也挂了。
     * 给全称单独留 60 字符的额度。
     */
    if (inner.length > 60) return false
    if (pair.abbr.length < 2 || pair.abbr.length > 6) return false
    return true
  }

  if (n.length > LONG_NAME_THRESHOLD) return false
  if (VERB_RE.test(n)) return false
  if (CONNECTOR_RE.test(n)) return false
  /**
   * ── 纯连接词/连接短语 → 判死（P10 问题 3）──
   *
   * 这两条是 `OH (Other Hand)` 的直接克星：
   *   · `hitsConnectorPhrase` 抓 "on the other hand" 这类**多词固定搭配**
   *     （每个单词单看都合法，只靠 CONNECTOR_RE 拦不住）；
   *   · `isAllConnectorWords` 抓"一个实词都没有"的情况，
   *     覆盖 "moreover this" / "thus the" 这类单词排列。
   *
   * 顺序不能反：先判短语，再判全虚词 —— 短语判定更具体，先命中更准确。
   */
  if (hitsConnectorPhrase(n)) return false
  if (isAllConnectorWords(n)) return false
  const words = n.split(/\s+/)
  if (words.length > 6) return false
  // 每个词必须是"词形合法"的（字母/数字/连字符，或已知连接词）
  if (!words.every((w) => NOUN_GLUE_RE.test(w))) return false
  return true
}

/** 首字母大写（只动第一个字母，其它保持原样，避免破坏 RAG-Sequence 这种） */
function capitalize(s: string): string {
  if (!s) return s
  return s[0].toUpperCase() + s.slice(1)
}

/** 去掉末尾标点与空白 */
function trimTail(s: string): string {
  return s.replace(/[\s.,;:!?、，。；：！？]+$/g, '').trim()
}

/** 标题化：每个实词首字母大写，连接词小写（保留 RAG-Sequence 这类大写缩写） */
function titleCase(s: string): string {
  const SMALL = /^(?:of|for|in|on|to|with|by|from|as|and|or|a|an|the)$/i
  return s
    .split(/\s+/)
    .map((w, i) => {
      // 已经含大写字母的词（缩写）原样保留
      if (/[A-Z]/.test(w)) return w
      if (i > 0 && SMALL.test(w)) return w.toLowerCase()
      return capitalize(w)
    })
    .join(' ')
}

/**
 * 切掉第一个从句。
 *
 * 论文描述句常是「主句, which ... 」结构，模块名只需主句部分。
 * 在关系代词 / 分号 / 逗号+连接词处切。
 */
function firstClause(s: string): string {
  let t = s
  // 关系代词引导的从句
  t = t.split(/\s+(?:which|that|where|when|who|whom|whose)\s/i)[0]
  // 分号
  t = t.split(/;/)[0]
  // 句末
  t = t.split(/\.\s/)[0]
  // 「, and/but/which」这类并列从句
  t = t.split(/,\s+(?:and|but|or|while|whereas|so)\s/i)[0]
  return trimTail(t)
}

/** 从 "xxx (RAG)" 或 "RAG (retrieval augmented generation)" 里抽出 (缩写, 全称) */
function splitAbbrAndFull(s: string): { abbr: string; full: string } | null {
  const m = s.match(/^(.+?)\s*[（(]\s*([^)）]+?)\s*[)）]\s*$/)
  if (!m) return null
  const outside = m[1].trim()
  const inside = m[2].trim()
  if (isAbbr(inside)) {
    // 形式 A：全称在前、缩写在后 —— "retrieval-augmented generation (RAG)"
    return { full: outside, abbr: inside.replace(/[^A-Za-z0-9-]/g, '') }
  }
  if (isAbbr(outside)) {
    // 形式 B：缩写在前、全称在后 —— "RAG (retrieval-augmented generation)"
    return { full: inside, abbr: outside.replace(/[^A-Za-z0-9-]/g, '') }
  }
  return null
}

/**
 * 取前 N 个实词，作为"提不出缩写"时的兜底名字。
 *
 * ⚠️ 这个函数**只做兜底**，且必须保证结果不含动词 ——
 * 否则会产出 "Introduce General-purpose Fine-tuning Recipe" 这种
 * 把动词当名词塞进名字里的怪东西。调用方负责再过一道 VERB_RE。
 */
function leadingContentWords(s: string, n = 4): string {
  const STOP =
    /^(?:we|our|this|that|these|those|it|they|their|there|however|but|and|or|the|a|an|of|for|in|on|to|with|by|from|as|is|are|was|were|be|been|being|has|have|had|can|could|will|would|may|might|must|used|using|use)$/i
  const words = s
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9\-]/g, ''))
    .filter((w) => w.length > 1 && !STOP.test(w))
    // 关键：把动词从候选里剔掉。名字里不该有谓语。
    .filter((w) => !VERB_RE.test(w))
  return words.slice(0, n).join(' ')
}

/**
 * 名词短语的"可用性"闸门。
 *
 * 抽出的短语未必值得当模块名。有些明显是残渣：
 *   · 只 1 个词        —— "Design"、"Work"
 *   · 全是功能词       —— "How Much"、"Two Variants"
 *   · 只有 2 个词且都很泛 —— "Ideas Retrieval-augmented"
 *
 * 判据：至少 2 个词，且至少 1 个词不是功能词，且总长 ≥ 6。
 * 这样 `How Much`（都是功能词）、`Design`（单词）会被挡掉，
 * 而 `Text Documents`、`General-purpose Fine-tuning Recipe` 能过。
 */
function isUsableNounPhrase(np: string): boolean {
  const t = (np || '').trim()
  if (!t) return false
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length < 2) return false
  if (t.length < 6) return false

  /**
   * ── 连接词守卫（P10 问题 3）──
   *
   * 这里是**最后一个关口**：步骤④的 `extractNounPhrase` 与步骤⑤的
   * `leadingContentWords` 产出的候选都要过它。原先它只要求
   * "至少一个 ≥4 字符的实词"，于是：
   *   "Moreover Approach"    → 过（Approach 8 字符）
   *   "Thus System"          → 过（System 6 字符）
   *   "Other Hand"           → 过（Hand 4 字符）
   * 这三类都是**连接词 + 半个名词**的拼接产物，不是方法名。
   *
   * 判定分两条，缺一不可：
   *   ① 整条命中连接短语 / 全是虚词 → 直接否掉；
   *   ② **开头**是连接词 → 否掉。这一条覆盖 "Moreover Approach"
   *      这种"连接词还在开头"的残留 —— 说明剥离没做完，
   *      与其把半截名字落库，不如让它返回空、由调用方显示"未识别"。
   */
  if (hitsConnectorPhrase(t)) return false
  if (isAllConnectorWords(t)) return false
  if (CONNECTOR_RE.test(t)) return false

  // 至少要有一个"真正的实词"（非功能词、长度 ≥ 4）
  const GENERIC =
    /^(?:the|a|an|of|for|in|on|to|with|by|from|as|and|or|how|much|many|two|three|four|first|second|both|each|every|all|some|most|other|another|such|this|that|these|those|it|its|our|their|we|work|method|approach|way|thing|idea|ideas)$/i
  const hasContent = words.some((w) => w.length >= 4 && !GENERIC.test(w))
  return hasContent
}

/**
 * 单字母/无意义变量名（原文里的数学符号，如 `z`、`x`、`q`）。
 *
 * 它们出现在 `used to retrieve text documents z` 这类片段里 ——
 * `z` 是论文的记号，不是模块名的一部分。拼进名字里只会让人困惑。
 */
const MATH_VAR_RE = /^[a-z]$/i

/**
 * 从一段"句子残骸"里抽出一个**干净的名词短语**。
 *
 * 思路：把句子按词切开，**丢掉动词和它的宾语从句**，
 * 只保留连续的、不含动词的名词序列（取最长的那一段）。
 *
 * 例：
 *   "introduce general-purpose fine-tuning recipe"
 *     → 丢 introduce → "general-purpose fine-tuning recipe"
 *   "RAG concatenates passages before"
 *     → 丢 concatenates → "RAG passages"（before 是尾词，也丢）
 *   "used to retrieve text documents z"
 *     → 丢 used/to/retrieve → "text documents"（z 是数学变量，也丢）
 */
function extractNounPhrase(s: string): string {
  /**
   * ── 先剥掉开头的**多词连接短语**（P10 问题 3）──
   *
   * 为什么必须在分词之前做：
   *   "On the other hand, paper [7] summarizes…" 按逗号切完是
   *   "On the other hand"。此时逐词扫描会得到 4 个"无动词"的词，
   *   而 `the`/`on` 在 EDGE 里、`other`/`hand` 不在 ——
   *   剥完剩 `Other Hand`，再被 `deriveAbbr` 编成 `OH`。
   *   于是连接词变成了一条看起来很像方法模块的记录。
   *
   *   在分词前整段剥掉，得到空串 → 上层直接判为"抽不出名词短语"，
   *   这条残骸就不会进库。
   *
   * 只剥开头（`^`）：连接短语出现在中间时，它两侧都有实义内容，
   * 从中间挖掉反而会拼接出错误短语，交给后面的动词切分处理更安全。
   */
  let working = (s || '').trim()
  for (;;) {
    const before = working
    working = working.replace(
      new RegExp(
        `^(?:${CONNECTOR_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b[\\s,;:]*`,
        'i'
      ),
      ''
    )
    // 也在同一轮里剥掉开头的**单个**连接词（"Moreover, this approach" → "this approach"）
    working = working.replace(
      new RegExp(`^(?:${CONNECTOR_ALT})\\b[\\s,;:]*`, 'i'),
      ''
    )
    if (working === before) break
    if (!working) break
  }
  if (!working) return ''

  const raw = working
    // 先按逗号/分号切成子句 —— 逗号后面通常是另一个分句（"…decoding, integrating them…"），
    // 不切的话 "decoding" 和 "integrating" 会连成一段，抽出的"名词短语"里会混进谓语。
    .split(/[,;，；]/)[0]
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9\-]/g, ''))
    .filter(Boolean)
    // 丢掉单字母数学变量（z/x/q）—— 它是论文的记号，不是名字
    .filter((w) => !MATH_VAR_RE.test(w))
  if (raw.length === 0) return ''

  // 逐词扫描，遇到动词就"切一刀"，最后取最长的一段
  const chunks: string[][] = []
  let cur: string[] = []
  for (const w of raw) {
    if (VERB_RE.test(w)) {
      if (cur.length) chunks.push(cur)
      cur = []
      continue
    }
    cur.push(w)
  }
  if (cur.length) chunks.push(cur)

  // 去掉每段头尾的连接词/停用词
  /**
   * 剥掉每段头尾的连接词/停用词。
   *
   * ── 为什么改成从 CONNECTOR_WORDS 派生（P10 问题 3）──
   *
   * 原先这里是一张**手写的短表**（只列了 of/for/in/the/... 等 21 个词），
   * 和上方的 `LEADING_STOP_RE` 各写各的。于是虽然"判定层"知道
   * `however` 不该当开头，"剥离层"却不认识它 —— 结果是
   * "Moreover, this approach" 剥完仍留着 `Moreover`，
   * 最后落库成 "Moreover Approach" 这种半截名字。
   *
   * 两处共用同一份 `CONNECTOR_WORDS` 之后，只要往表里加词，
   * 判定与剥离会**同时**生效，不会再出现两边不一致。
   *
   * 注意：`before` / `after` / `how` / `much` / `many` 这几个
   * 原本在表里、但不在 CONNECTOR_WORDS 中，这里显式补上 —— 它们
   * 确实是英语里的高频虚词，剥掉是对的。
   */
  const EDGE = new RegExp(
    `^(?:${CONNECTOR_ALT}|before|after|how|much|many)$`,
    'i'
  )
  const cleaned = chunks
    .map((c) => {
      let a = 0
      let b = c.length
      while (a < b && EDGE.test(c[a])) a++
      while (b > a && EDGE.test(c[b - 1])) b--
      return c.slice(a, b)
    })
    .filter((c) => c.length > 0)

  if (cleaned.length === 0) return ''
  // 取最长的一段（信息量最大）
  const best = cleaned.reduce((x, y) => (y.length > x.length ? y : x), cleaned[0])
  const joined = best.join(' ')

  /**
   * 去掉「X and Y」这种并列结构里的后半截。
   *
   * 为什么必须做：
   *   原句 "…generation and critique-based decoding" 抽出来的短语是
   *   "ideas from retrieval-augmented generation and critique-based
   *   decoding" —— 7 个词、含并列连词、还悬在 "and" 结构上。
   *   直接拿去当 Block 名字就成了 "Ideas from Retrieval-augmented
   *   Generation and"（末尾一个孤零零的 and），正是用户说的
   *   "不要把被截断的原文片段当名字"。
   *
   *   X and Y 里 X 通常是主概念、Y 是修饰性的并列项，取 X 更紧凑、
   *   也更像"一个模块"。只有两侧都足够长（≥2 词）时才切，
   *   避免把 "encoder and decoder" 这种**本来就是整体**的词切坏。
   */
  const andParts = joined.split(/\s+and\s+/i)
  if (andParts.length === 2) {
    const [left, right] = andParts
    if (left.split(/\s+/).length >= 2 && right.split(/\s+/).length >= 2) {
      return left.trim()
    }
  }
  return joined
}

/**
 * 主入口：把任意"名字候选"规范成合格模块名。
 *
 * 幂等性保证：对已经规范过的名字再跑一次，输出完全相同。
 * （靠 isCleanName 早退 + 输出格式自身合格实现）
 */
export function normalizeBlockName(raw: string, description?: string): string {
  let s = trimTail((raw || '').replace(/\s+/g, ' '))

  // 兜底：raw 为空时退回 description 的首个从句
  if (!s && description) {
    s = firstClause(trimTail((description || '').replace(/\s+/g, ' ')))
  }
  if (!s) return ''

  // ── 早退：已经是合格名字 → 原样保留 ──
  //
  // 这是"不改好的"那条克制的唯一执行点。
  // 先于一切改写，保证 Fusion-in-Decoder / Self-RAG / RAG architecture
  // 这类名字不会被规范化流程动到。
  const tagged = splitAbbrAndFull(s)
  if (!tagged && isCleanName(s)) {
    return trimTail(s)
  }

  // ── ① 切第一个从句 ──
  s = firstClause(s)

  // ── ② 若本身是 "全称 (缩写)" 形式 → 直接组装 ──
  //
  // 这是最可靠的一条路：原文自己给出了缩写与全称的对应关系，
  // 我们只是换个顺序呈现，**不猜**。
  const pair = splitAbbrAndFull(s)
  if (pair) {
    const full = titleCase(pair.full)
    // 全称太短（如 "RAG (retrieval)"）→ 只用缩写，别啰嗦
    if (full.split(/\s+/).length < 2) return trimTail(pair.abbr)
    // 全称长度合适且不含动词 → 用「缩写 (全称)」
    if (full.length <= MAX_FULL_LEN && !VERB_RE.test(full)) {
      return trimTail(`${pair.abbr} (${full})`)
    }
    // 全称是个长句子 → 只用缩写，别把长句拖出来
    return trimTail(pair.abbr)
  }

  // ── ③ 切完从句后变干净了 → 标题化即可 ──
  if (isCleanName(s)) {
    return trimTail(titleCase(s))
  }

  // ── ④ 是片段：先抽名词短语，再决定输出形式 ──
  //
  // 为什么先抽名词短语而不是直接"取前 N 个词"：
  //   "introduce general-purpose fine-tuning recipe"
  //   取前 4 个词 → "Introduce General-purpose Fine-tuning"（含动词，错）
  //   抽名词短语 → "general-purpose fine-tuning recipe"（对）
  const np = extractNounPhrase(s)
  if (np && isUsableNounPhrase(np)) {
    const abbr = deriveAbbr(np)
    const full = titleCase(np)
    // 名词短语本身可能仍超长 —— 超了就只用缩写
    if (abbr && abbr.length >= 2) {
      const words = np.split(/\s+/)
      // 全称够短才配出来；否则只留缩写（避免又变回长串）
      if (words.length <= 5 && full.length <= MAX_FULL_LEN) {
        return trimTail(`${abbr} (${full})`)
      }
      return trimTail(abbr)
    }
    if (full.length <= MAX_NAME_LEN) return trimTail(full)
    // 太长又没有缩写 → 截到 5 个词
    return trimTail(titleCase(np.split(/\s+/).slice(0, 5).join(' ')))
  }

  // ── ⑤ 最后兜底：取前 4 个实词（已剔动词）标题化 ──
  //
  // 走到这里说明规则没能提出好名字。返回一个"去掉动词的短名词短语"，
  // 至少比整句残骸强。注意这里**不编造** —— 词都来自原文。
  // 同样要过 isUsableNounPhrase —— 挡掉 "Design"、"How Much" 这类空壳。
  const last = leadingContentWords(s, 4)
  if (last && isUsableNounPhrase(last)) return trimTail(titleCase(last))

  // 连像样的名词短语都提不出来（例如整句都是功能词）——
  // 如实返回空，由调用方决定怎么显示，**不编造**。
  return ''
}

/**
 * 判断一个名字是否"看起来像被截断的句子残骸"。
 *
 * 给验收脚本用：它可以拿这个函数（通过 /api 或独立断言）批量检查，
 * 而不必在脚本里重写一遍规则。
 */
export function looksLikeSentenceFragment(name: string): boolean {
  const n = trimTail((name || '').trim())
  if (!n) return true
  if (n.length > LONG_NAME_THRESHOLD) return true
  if (VERB_RE.test(n)) return true
  if (CONNECTOR_RE.test(n)) return true
  // 纯连接词 / 连接短语 → 句子残骸（与 isPlausibleNounPhrase 保持同一套判定）
  if (hitsConnectorPhrase(n)) return true
  if (isAllConnectorWords(n)) return true
  // 结尾是 the/and/of 这类词 → 被截断
  if (/\b(?:the|and|of|for|to|with|by|from|as|a|an|such|which|that)$/i.test(n)) return true
  return false
}
