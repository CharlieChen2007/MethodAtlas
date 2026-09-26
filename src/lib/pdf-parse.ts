import 'server-only'

import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

/**
 * ⚠️ 必须显式指定 worker 的**绝对路径**，且必须转成 `file://` URL。
 *
 * ── 坑 1：相对路径 / require.resolve 都不行 ──
 * pdfjs 默认按「相对当前模块」找 `pdf.worker.mjs`。`next build` 之后这段代码
 * 被打进 `.next/server/app/api/upload/route.js`，相对解析就落到
 * `.next/server/app/api/upload/pdf.worker.mjs` —— 而 next 默认**不会**把
 * worker 文件复制进 `.next`，于是运行时报：
 *     Setting up fake worker failed: "Cannot find module '.../pdf.worker.mjs'"
 * 两个都试过的错误解法：
 *   ✗ 直接写相对路径            → 打包后必然错
 *   ✗ 用 `require.resolve(...)` → webpack 在构建期就把这个调用**静态求值**成
 *                                 一个相对路径，等于没改
 * 正确解法：用 `process.cwd()` 在**运行时**拼绝对路径。webpack 无法在构建期
 * 求值 `process.cwd()`，所以路径能原样保留到运行时。
 *
 * ── 坑 2（问题 1 的真凶）：裸绝对路径在 Windows 上必须是 file:// URL ──
 * 只给 pdfjs 一个裸的 Windows 绝对路径（`D:\...\pdf.worker.mjs`）会被它当成
 * 一个"模块说明符"去 import，Node 的 ESM loader 随即报：
 *     Setting up fake worker failed: "Only URLs with a scheme in: file, data,
 *     and node are supported by the default ESM loader. On Windows, absolute
 *     paths must be valid file:// URLs. Received protocol 'd:'"
 * 注意报错里的 `Received protocol 'd:'` —— 它把盘符 `D:` 当成了协议名。
 * 修法：用 `pathToFileURL()` 把绝对路径转成 `file:///D:/...` 再交给 pdfjs。
 *
 * ── 坑 3：worker 定位失败不该让上传整个挂掉 ──
 * 万一两个候选路径都没命中（pnpm 布局差异、被裁剪等），不要再抛错，
 * 而是**关掉 worker**（`disableWorker: true`）走同进程解析 —— 慢一点，但能出结果。
 * 这是兜底，不是常规路径；命中与否由 `workerSrc` 是否为 undefined 决定。
 */
function resolveWorkerSrc(): string | undefined {
  const candidates = [
    path.join(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'),
    // pnpm 的 .pnpm 布局：包在 node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/
    path.join(
      process.cwd(),
      'node_modules/.pnpm',
      `pdfjs-dist@${pdfjs.version}`,
      'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
    ),
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) return toFileUrl(p)
    } catch {
      /* 继续试下一个 */
    }
  }
  return undefined
}

/**
 * 绝对路径 → `file://` URL。
 *
 * 分平台处理，而不是无条件用 `pathToFileURL`：
 *
 *   · Windows：`pathToFileURL` 会输出 `file:///D:/...`（正确），但前提是
 *     传进去的路径是**本机风格**。为稳妥，这里显式做一次规范化：
 *     反斜杠换正斜杠、补上盘符前的斜杠，再拼 `file:///`。这样无论
 *     `process.cwd()` 返回 `D:\a\b` 还是 `D:/a/b`，结果都是
 *     `file:///D:/a/b`。**绝不依赖库在边界情况下的行为**，因为这条错误
 *     一旦发生就是"上传必失败"，且只在 Windows 上暴露，代价太高。
 *
 *   · 其它平台：直接 `pathToFileURL`，它对 posix 路径的处理是完备的。
 *
 * 为什么不用 try/catch 包 `pathToFileURL` 兜底：那个函数的失败模式不是
 * "抛异常"，而是"成功返回一个看似合理、但反斜杠被转义的 URL"，
 * catch 根本抓不到。所以 Windows 上必须显式构造。
 */
function toFileUrl(p: string): string {
  if (process.platform === 'win32') {
    // D:\a\b.mjs  →  /D:/a/b.mjs  →  file:///D:/a/b.mjs
    const normalized = p.replace(/\\/g, '/')
    const withSlash = normalized.startsWith('/') ? normalized : '/' + normalized
    return `file://${encodeURI(withSlash)}`
  }
  return pathToFileURL(p).href
}

/** worker 是否成功定位（false = 走了 disableWorker 兜底）。诊断用。 */
export const workerResolved = Boolean(resolveWorkerSrc())

const workerSrc = resolveWorkerSrc()
if (workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
}

/**
 * PDF 解析（纯 Node，无外部进程） —— 问题 6 修复的核心。
 *
 * ── 为什么要在 Node 里自己解析，而不是继续调 Python 服务 ──
 *
 * 原来的链路是「前端 → Server Action → fetch http://127.0.0.1:8000/parse」。
 * 它有三个现实问题：
 *   1. 用户必须先手动起一个 Python 进程，否则上传必失败（ECONNREFUSED）；
 *   2. 失败被 catch 静默吞掉，用户只看到"论文没出现"，不知道发生了什么；
 *   3. Windows 上多一个窗口 = 多一个装依赖/起服务/对端口的坑。
 *
 * 现在改成 Next.js API Route 内置解析：用户在 Windows 上只需要起主服务。
 * Python 版 parser-service/ 仍然保留，作为**可选**的独立后端（见 .env 的
 * PARSER_MODE），但默认不再依赖它。
 *
 * ── 为什么用 legacy build ──
 * pdfjs-dist 的现代构建依赖浏览器专有的 DOMMatrix / structuredClone 等；
 * Node 下直接 import 会在 getDocument 时抛 "DOMMatrix is not defined"。
 * legacy build 自带这些 polyfill，是官方为 Node/旧环境提供的入口。
 *
 * 抽出来的启发式规则与 parser-service/main.py 保持一致 ——
 * 两套实现必须给出同样的段落切分，否则"用哪个后端"会变成两种数据质量。
 */

export interface ParsedParagraph {
  page: number
  text: string
}

export interface ParseResult {
  title: string
  authors: string[]
  year: number | null
  abstract: string
  pageCount: number
  paragraphs: ParsedParagraph[]
}

/** 章节标题白名单（与 Python 版同一份词表） */
const HEADING_WORDS = [
  'Abstract',
  'Introduction',
  'Related\\s+Work',
  'Background',
  'Method',
  'Methods',
  'Methodology',
  'Approach',
  'Experiments?',
  'Evaluation',
  'Results?',
  'Analysis',
  'Discussion',
  'Conclusion',
  'Conclusions',
  'Limitations?',
  'References',
  'Appendix',
]

const HEADING_RE = new RegExp(`^(?:\\d+[\\.\\)]?\\s+)?(?:${HEADING_WORDS.join('|')})\\s*$`, 'i')

/**
 * 「标题 + 正文」粘在同一行的情况要拆开。
 *
 * PDF 常见排版：「1. Introduction Retrieval-augmented generation methods …」
 * 标题和正文之间没有换行。不拆的话，下游按句切分会把
 * "1. Introduction Retrieval-augmented …" 整句当成方法描述引用，语义失真。
 */
const HEADING_PREFIX_RE = new RegExp(
  `^((?:\\d+\\.?\\s+)?(?:${HEADING_WORDS.join('|')}))\\s+(?=[A-Z])`
)

function looksLikeHeading(line: string): boolean {
  const s = line.trim()
  if (s.length >= 60) return false
  if (HEADING_RE.test(s)) return true
  // 全大写、无句末标点的短行
  if (s.length < 40 && s === s.toUpperCase() && !/[.!?]$/.test(s)) {
    // 排除纯符号/数字行
    return /[A-Z]/.test(s)
  }
  return false
}

function splitHeadingPrefix(line: string): string[] {
  const m = line.match(HEADING_PREFIX_RE)
  if (m) {
    const head = m[1].trim()
    const rest = line.slice(m[0].length).trim()
    if (rest.length >= 20) return [head, rest]
  }
  return [line]
}

/**
 * 一页文本 → 段落。
 *
 * 为什么不能按行拆：论文里一句话常跨 2~3 个排版行。每行独立成段会让下游
 * 切出 "and achieve state-of-the-art results…" 这种缺主语的碎片。
 * 规则：上一行以句末标点结尾、或下一行像标题 → 断开；否则并入当前段。
 */
export function splitParagraphs(raw: string): string[] {
  const lines: string[] = []
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^\d{1,4}$/.test(line)) continue // 页码
    lines.push(...splitHeadingPrefix(line))
  }

  const paragraphs: string[] = []
  let buf = ''
  for (const line of lines) {
    if (/^[\d\s\-–]+$/.test(line)) continue // 页眉/页脚

    if (looksLikeHeading(line)) {
      if (buf) {
        paragraphs.push(buf)
        buf = ''
      }
      paragraphs.push(line)
      continue
    }
    if (!buf) {
      buf = line
      continue
    }
    if (/[.!?:;]$/.test(buf)) {
      paragraphs.push(buf)
      buf = line
    } else {
      buf = `${buf} ${line}`
    }
  }
  if (buf) paragraphs.push(buf)
  return paragraphs
}

function extractTitle(meta: Record<string, unknown>, paragraphs: ParsedParagraph[]): string {
  const metaTitle = String(meta.Title ?? '').trim()
  if (metaTitle) {
    const cleaned = metaTitle.replace(/\.pdf$/i, '').trim()
    // metadata 里常出现 "Microsoft Word - xxx" 这类垃圾前缀，够长才信
    if (cleaned.length >= 10) return cleaned
  }

  const first = paragraphs.find((p) => p.page === 1 && p.text.length >= 10)
  if (!first) return '未识别标题'

  /**
   * 退化路径：用首页第一段当标题。
   *
   * 但首页首段常常是「标题 作者列表」挤在一起（PDF 里标题和作者之间
   * 可能没有换行），直接取整段会把作者吞进标题。先做几次裁剪。
   */
  let t = first.text.trim()

  // 1) 砍掉尾部的年份分隔（"… Tasks Patrick Lewis, … — 2020"）
  const yearSep = t.search(/\s[—–-]\s(?:19|20)\d{2}\b/)
  if (yearSep > 10) t = t.slice(0, yearSep)

  /**
   * 2) 砍掉尾部的作者串。
   *
   * ⚠️ 这里必须用**锚定在末尾**的匹配（`…$`），不能全局搜。
   * 否则标题里恰好出现的「两个首字母大写的词」（如 "Sparse Attention"、
   * "Long-Context Retrieval"）会被当成人名，把标题从中间截断 ——
   * 实测把 "Sparse Attention for Efficient Long-Context Retrieval"
   * 截成了 "Sparse Attention for"。
   *
   * 作者串的形态：`Name Name, Name Name, …` 一直延伸到结尾。
   */
  const authorsTail = t.match(
    /\s((?:[A-Z][a-z]+(?:-[A-Z][a-z]+)?\s+[A-Z][a-z]+)(?:\s*,\s*[A-Z][a-z]+(?:-[A-Z][a-z]+)?\s+[A-Z][a-z]+)*)$/
  )
  if (authorsTail && authorsTail.index !== undefined && authorsTail.index > 10) {
    t = t.slice(0, authorsTail.index)
  }

  t = t.replace(/\s+/g, ' ').trim()
  // 裁完太短说明误伤（把正文当人名了），退回原文，宁长勿缺
  return t.length >= 10 ? t : first.text.slice(0, 300)
}

function extractAuthors(meta: Record<string, unknown>): string[] {
  const raw = String(meta.Author ?? '').trim()
  if (!raw) return []
  return raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 年份：优先正文里出现的年份，最后才退化到 PDF 创建时间。
 *
 * 为什么顺序不能反：PDF 的 CreationDate 是**文件生成时间**，不是发表年份。
 * 反过来优先取 CreationDate，所有论文会被标成同一年，
 * 基于年份判断演化方向（较早 → 较晚）就会全错。
 */
function extractYear(meta: Record<string, unknown>, paragraphs: ParsedParagraph[]): number | null {
  const head = paragraphs
    .filter((p) => p.page <= 2)
    .map((p) => p.text)
    .join('\n')
  const years = (head.match(/\b(19\d{2}|20\d{2})\b/g) ?? []).map(Number)
  if (years.length) {
    // 取众数：正文里引用文献的年份多而杂，众数比最大值更接近发表年
    const freq = new Map<number, number>()
    for (const y of years) freq.set(y, (freq.get(y) ?? 0) + 1)
    let best = years[0]
    let bestCount = 0
    freq.forEach((c, y) => {
      if (c > bestCount) {
        best = y
        bestCount = c
      }
    })
    return best
  }
  const creation = String(meta.CreationDate ?? '')
  const m = creation.match(/D:(\d{4})/)
  if (m) {
    const y = Number(m[1])
    if (y >= 1900 && y <= 2100) return y
  }
  return null
}

function extractAbstract(paragraphs: ParsedParagraph[]): string {
  const full = paragraphs.map((p) => p.text).join('\n')
  const m = full.match(/\babstract\b\s*[:\-–]?\s*/i)
  if (!m || m.index === undefined) return ''
  const start = m.index + m[0].length
  let tail = full.slice(start, start + 4000)

  /**
   * 在下一个章节标题处截断。
   *
   * 坑：PDF 里摘要和下一节常常挤在同一行 ——
   * "… long-context benchmarks. Method Our approach introduces …"
   * 只匹配行首的标题词是抓不住的（"Method" 在行中间）。
   * 所以这里不加 `^` 锚点，匹配「标题词 + 空格 + 大写字母开头」：
   * 这正是"新章节开始"的排版特征，而摘要正文里不会出现这种形状。
   */
  const stop = tail.match(/\b(?:introduction|keywords|index terms|1\.\s)\b/i)
  const heading = tail.match(
    /\s(?:Method|Methods|Methodology|Approach|Experiments?|Evaluation|Results?|Analysis|Discussion|Conclusion|Conclusions|Limitations?|References|Appendix)\s+(?=[A-Z])/
  )
  let cut = -1
  if (stop && stop.index !== undefined) cut = stop.index
  if (heading && heading.index !== undefined && (cut < 0 || heading.index < cut)) cut = heading.index
  if (cut >= 0) tail = tail.slice(0, cut)

  return tail.replace(/\s+/g, ' ').trim().slice(0, 2500)
}

/**
 * 解析 PDF 字节流 → 结构化全文。
 *
 * 抛错即代表"这份 PDF 解析不了"，调用方必须把错误**如实回报给用户**，
 * 不允许 catch 后静默。
 *
 * 错误分成两类，调用方要用不同话术（问题 1 的修复点之一）：
 *   · NO_TEXT_LAYER —— 解析**成功**但一个字符都没读到，才可能是扫描件/纯图；
 *   · 其它（含 worker 装不起来）—— 是**解析出错**，如实说原因，不要甩锅给扫描件。
 */
export const NO_TEXT_LAYER = 'NO_TEXT_LAYER'

export async function parsePdf(data: Uint8Array): Promise<ParseResult> {
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    /**
     * worker 定位成功 → 交给它（生产环境应走这里）。
     * 定位失败 → 关掉 worker，退回同进程解析：慢，但不会因为"找不到 worker
     * 文件"就让整条上传链路失败（坑 3 的兜底）。
     */
    ...(workerSrc ? {} : { disableWorker: true }),
    disableFontFace: true,
  }).promise

  const pageCount = doc.numPages
  if (!pageCount) throw new Error('PDF 没有可读取的页面')

  const paragraphs: ParsedParagraph[] = []
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    // 用换行还原行结构（item 之间 PDF 不一定给换行，靠 hasEOL 标记）
    let raw = ''
    for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str !== 'string') continue
      raw += item.str
      raw += item.hasEOL ? '\n' : ' '
    }
    for (const text of splitParagraphs(raw)) paragraphs.push({ page: i, text })
    page.cleanup()
  }

  /**
   * 只有走完整个解析、确实一个字符都没有，才敢说"没有文字层"。
   * 用哨兵值向上传递，由 API 层翻译成用户话术 —— 这里不要写
   * "可能是扫描件"，因为绝大多数失败其实是解析错误（问题 1）。
   */
  if (!paragraphs.length) {
    throw new Error(NO_TEXT_LAYER)
  }

  const info = ((await doc.getMetadata().catch(() => null)) as { info?: Record<string, unknown> } | null)
    ?.info ?? {}
  // v6 移除了 destroy()，用 cleanup() 释放文档内部资源
  await doc.cleanup()

  return {
    title: extractTitle(info, paragraphs),
    authors: extractAuthors(info),
    year: extractYear(info, paragraphs),
    abstract: extractAbstract(paragraphs),
    pageCount,
    paragraphs,
  }
}
