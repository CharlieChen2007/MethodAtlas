/**
 * 用户可见文案的统一清洗出口。
 *
 * ── 为什么需要它 ──
 *
 * 项目里有一批「内嵌标记」是给**内部/调试**看的，不是给用户看的：
 *   · `【演示推断】…`   —— 旧版用来标注"这是 mock 推断的"
 *   · `【通用描述】…`   —— 旧版兜底描述的前缀
 *
 * 它们一旦被拼进用户可见的句子，就会读成病句。真实案例（问题 3）：
 *     移除 X 后，方法不再具备「【演示推断】从论文方法描述句中识别出的组件」的能力
 * 用户看到的是两个方括号套在句子中间，完全读不通。
 *
 * 根因不在于某个模板写错，而在于**没有任何一道统一出口**保证这些标记
 * 不流到用户面前。修一个模板，下次换个字段又会漏进来。
 *
 * 所以这里提供 `stripInlineMarkers()`：所有面向用户的文案（面板正文、
 * 结论、摘要、卡片副标题…）在**出口处**都过一遍。它的职责是"兜底"，
 * 不是"主要手段" —— 数据层该给的干净文案照常给，这里只是保证即使漏了，
 * 用户也看不到。
 *
 * ── 要标注"这是推断"怎么办 ──
 * 用 UI 元素（小徽标「推断」/「待验证」），不要塞进句子。
 * 文案里保持纯人话，语义标注交给组件。
 */

/**
 * 需要从用户可见文案里剥掉的内嵌标记。
 *
 * 只收录**已确认属于内部标记**的：`演示推断`、`通用描述`。
 * 不用笼统的 `/【[^】]*】/` 是因为论文原文引号里也可能出现方括号
 * （如 `【1】`、超长公式编号），一律剥掉反而会破坏证据的忠实性。
 */
const INLINE_MARKER_RE = /【(?:演示推断|通用描述)】\s*/g

/**
 * ── 整句式的内部说明（第二批补）──
 *
 * 除了方括号标记，库里还有一类"把实现方式讲给用户听"的**完整句子**，
 * 它们是早期 pipeline 写进数据库的（例如 ResearchDebt.description 末尾
 * 会缀一句"演示模式仅按关键词归类，未经语义确认，建议配置真实模型后重新识别"）。
 *
 * 为什么光改代码不够、必须在这里兜底：
 *   这些句子已经**落库**了。改数据层的产出逻辑只会影响"以后新跑的"，
 *   用户手上的旧库、旧记录照样带着它们显示出来。用户根本不关心
 *   我们内部怎么实现，他只想看结论。
 *
 * 匹配方式：定位到"演示模式"开头的那个句子，一路剥到句末标点（含）。
 *   用 `[^。；\n]*` 而不是 `.*?` —— 剥到**第一个**句末标点就停，
 *   避免把后面正常的结论句也一起吃掉。
 */
const INTERNAL_SENTENCE_RE = /(?:^|(?<=[。；;！!？?\n]))\s*演示模式[^。；;！!？?\n]*[。；;！!？?]?/g

/**
 * 剥掉内嵌标记，并做基础的空格整理。
 *
 * - 标记可能出现在句首/句中/句尾，全部剥除；
 * - 剥完可能出现 `「」`、`（）` 这类**空括号对**（因为括号里原本就是标记），
 *   一并清掉 —— 否则会留下 `「」的能力` 这种看着像 bug 的东西；
 * - 折叠多余空格，但**保留换行**（面板正文是多行结构，不能压成一行）。
 */
export function stripInlineMarkers(input: string): string {
  if (!input) return ''

  let s = input.replace(INLINE_MARKER_RE, '')

  // 剥掉"演示模式…"这类整句内部说明
  s = s.replace(INTERNAL_SENTENCE_RE, '')

  // 剥掉因标记被移除而变空的括号对（中英文都处理）
  s = s
    .replace(/「\s*」/g, '')
    .replace(/『\s*』/g, '')
    .replace(/（\s*）/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/“\s*”/g, '')
    .replace(/‘\s*’/g, '')

  // 句首残留的标点（原本紧跟标记）要清掉，如 "，方法…" → "方法…"
  s = s.replace(/^[，,、。；;：:\s]+/, '')

  // 折叠行内多余空格，保留换行
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n')
    .trim()
}

/** 文案里是否还残留内部标记（测试/CI 用，便于断言"没有漏网之鱼"） */
export function hasInlineMarker(input: string): boolean {
  if (!input) return false
  return /【(?:演示推断|通用描述)】/.test(input) || /演示模式/.test(input)
}

/**
 * 递归清洗 `stripInlineMarkers` 管不到的结构。
 *
 * 面板内容是多层结构（sections[] / actions[] / headline …），逐个字段
 * 手写清洗容易漏。这里提供一个针对"任意嵌套对象"的深度清洗：
 * 凡是 string 字段都过一遍 stripInlineMarkers，其它类型原样保留。
 *
 * 用途：在 panel.ts 的最终出口对整份 PanelContent 调用一次，
 * 从此新增字段**自动**受保护，不会因为忘记加清洗而漏标。
 */
export function deepStripInlineMarkers<T>(value: T): T {
  if (typeof value === 'string') return stripInlineMarkers(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => deepStripInlineMarkers(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepStripInlineMarkers(v)
    }
    return out as T
  }
  return value
}
