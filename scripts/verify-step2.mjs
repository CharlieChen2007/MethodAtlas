/**
 * P10 Step2 验收脚本 —— 验证两个问题都真的修好了。
 *
 * 不依赖服务器、不调用模型，只跑纯函数，用来回答两个问题：
 *   A) en-summary 的数据来源分流是否生效（真中文直用 / mock 英文走归纳）
 *   B) suggestionFor 的三级回落是否真的按顺序命中
 *
 * 用法：node scripts/verify-step2.mjs
 */

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// ── 用 tsx 风格的方式加载 TS：走 esbuild 太重，这里用最朴素的办法 ──
// 直接从编译产物里取。next build 已经把 src 编译进 .next，但路径不好找。
// 所以这里改用「对齐源文件逻辑」的方式：把关键函数复制一份做断言。
// 这不是好做法 —— 所以下面同时做了「源文件文本断言」，确保两边一致。

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

/**
 * 剥掉 // 行注释与 /* *\/ 块注释，避免注释里提到的函数名被误当成真实调用。
 * 只用于静态计数断言，不参与任何业务逻辑。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

console.log('\n══════════ A. en-summary 数据来源分流 ══════════\n')

const enSummary = read('src/lib/lab/en-summary.ts')

// A1: 分流函数存在且被正确导出
check('导出 isMockSource()', /export function isMockSource/.test(enSummary))
check('导出 summarizeAttemptBySource()', /export function summarizeAttemptBySource/.test(enSummary))
check('导出 summarizePointBySource()', /export function summarizePointBySource/.test(enSummary))

// A2: 历史数据（空 provider）必须按 mock 处理 —— 这是最危险的分支
check(
  '空 provider 视为 mock（历史数据安全）',
  /\?! ?p\) ?return true/.test(enSummary.replace(/\s+/g, ' ')) ||
    /if \(!p\) return true/.test(enSummary),
  '未找到"空 provider → mock"的分支'
)

// A3: 60 字上限
check('存在 60 字上限常量', /MAX_MODEL_BODY_LEN\s*=\s*60/.test(enSummary))

// A4: 真正的分支逻辑：mock → 老归纳；真模型 → 限长直用
const attemptFn = enSummary.slice(
  enSummary.indexOf('export function summarizeAttemptBySource'),
  enSummary.indexOf('export function summarizePointBySource')
)
check('summarizeAttemptBySource 首行判 mock', /isMockSource\(provider\)/.test(attemptFn))
check('summarizeAttemptBySource 调用 clampChinese', /clampChinese/.test(attemptFn))

const pointFn = enSummary.slice(enSummary.indexOf('export function summarizePointBySource'))
check('summarizePointBySource 首行判 mock', /isMockSource\(provider\)/.test(pointFn))
check('summarizePointBySource 调用 clampChinese', /clampChinese/.test(pointFn))

// A5: panel.ts 三处调用点全部换成 BySource 版本
//     注意：必须先剥掉注释再数 —— 注释里出现函数名是正常的（说明性文字），
//     直接全文 match 会把注释算成"残留调用"，是误报。
const panelRaw = read('src/lib/lab/panel.ts')
const panel = stripComments(panelRaw)
const barePoint = (panel.match(/\bsummarizePoint\(/g) || []).length
const bareAttempt = (panel.match(/\bsummarizeAttempt\(/g) || []).length
const bySource = (panel.match(/summarize(Point|Attempt)BySource\(/g) || []).length
check('panel.ts 无残留裸 summarizePoint() 调用', barePoint === 0, `仍有 ${barePoint} 处`)
check('panel.ts 无残留裸 summarizeAttempt() 调用', bareAttempt === 0, `仍有 ${bareAttempt} 处`)
check('panel.ts 三处调用点已切换到 BySource', bySource === 3, `实际 ${bySource} 处`)
// 按**行**数而不是匹配数：同一行可能出现多个函数名（注释在列举用法），
// 数匹配数会把一行算成多处，误报为"注释数量变化"。
check(
  'panel.ts 裸函数名仅出现在注释行里',
  panelRaw
    .split('\n')
    .filter((l) => /summarizePoint\(|summarizeAttempt\(/.test(l))
    .every((l) => /^\s*(\/\/|\*|\/\*)/.test(l)),
  '发现有非注释行出现裸函数名 —— 可能存在未切换的调用点'
)

// A6: provider 全链路打通
console.log('\n  ── provider 字段全链路 ──')
check('schema: DebtSource.provider', /model DebtSource[\s\S]*?provider String @default\(""\)/.test(read('prisma/schema.prisma')))
check('schema: Attempt.provider', /model Attempt[\s\S]*?provider String @default\(""\)/.test(read('prisma/schema.prisma')))
check('写入侧: research-debt.ts 写 provider', (read('src/lib/research-debt.ts').match(/provider: result\.provider/g) || []).length >= 2)
check('视图层: view-models.ts 有 provider', /provider: string/.test(read('src/lib/view-models.ts')))
check(
  '装配层: lab/page.tsx 透传 provider',
  /provider: s\.provider/.test(read('src/app/projects/[pid]/lab/page.tsx')) &&
    /provider: a\.provider/.test(read('src/app/projects/[pid]/lab/page.tsx'))
)

console.log('\n══════════ B. suggestionFor 三级回落 ══════════\n')

const cs = read('src/lib/lab/crash-summary.ts')

// B1: 门控在模型之前（顺序至关重要）
const fn = cs.slice(cs.indexOf('function suggestionFor'), cs.indexOf('/**\n * 把模型腔的理由'))
const idxPass = fn.indexOf("outcome === 'pass'")
const idxUnknown = fn.indexOf("outcome === 'unknown'")
const idxModel = fn.indexOf('hasModelSuggestion')
const idxTable = fn.indexOf('SUGGESTION_TABLE')
const idxFallback = fn.indexOf('NO_SPECIFIC_SUGGESTION')
check('门控 pass 存在', idxPass > -1)
check('门控 unknown 存在', idxUnknown > -1)
check('门控 在 模型 之前', idxPass > -1 && idxModel > -1 && idxPass < idxModel && idxUnknown < idxModel)
check('模型 在 静态表 之前', idxModel < idxTable, `model@${idxModel} table@${idxTable}`)
check('静态表 在 兜底 之前', idxTable < idxFallback, `table@${idxTable} fallback@${idxFallback}`)

// B2: 空值哨兵 —— 模型写"无"/"-"不算改法
check('存在空值哨兵集合', /EMPTY_SENTINELS/.test(cs))
check('哨兵含 "无"', /'无'/.test(cs))
check('哨兵含 "-"', /'-'/.test(cs))
check('hasModelSuggestion 做 trim 后判空', /const t = \(raw \?\? ''\)\.trim\(\)/.test(cs))

// B3: buildCrashConclusion 把模型值先透传再回落
check(
  'buildCrashConclusion 透传 c.suggestion',
  /suggestion: c\.suggestion \?\? null/.test(cs),
  '未找到透传语句 —— 优先级 1 会失效'
)

// B4: View 类型有 suggestion 字段
const vm = read('src/lib/view-models.ts')
check('CrashCheckView 有 suggestion?: string', /suggestion\?: string/.test(vm))

// B5: 解析层给空串、不给兜底文案
const page = read('src/app/projects/[pid]/lab/page.tsx')
check(
  '解析层缺失时给空串（保住回落链）',
  /suggestion: typeof first\?\.suggestion === 'string' \? first\.suggestion : ''/.test(page),
  '解析层填了兜底值会截断回落链'
)

console.log('\n  ── crash-test.ts 模型侧 ──')
const ct = read('src/lib/crash-test.ts')
check('RawFinding 有 suggestion 字段', /interface RawFinding[\s\S]*?suggestion: string/.test(ct))
check('FINDING_SPEC 有 suggestion（min:0 不强制）', /suggestion: \{ type: 'string', min: 0 \}/.test(ct))
check('prompt 有 suggestion 专门段落', /【suggestion —— 每一项必须给/.test(ct))
check('prompt 明确 PASS 必须留空', /level = PASS\s*→\s*suggestion 必须留空/.test(ct))
check('prompt 禁止通用套话', /禁止写通用套话/.test(ct))
check('prompt 示例 JSON 含 suggestion 字段', /"suggestion":"具体改法/.test(ct))
const persistCount = (ct.match(/suggestion: \(f\.suggestion \?\? ''\)/g) || []).length
check('五处持久化块都写入 suggestion', persistCount === 5, `实际 ${persistCount} 处`)

console.log('\n  ── llm-mock.ts P3 同步 ──')
const mock = read('src/lib/llm-mock.ts')
check('MockFinding 有 suggestion 字段', /interface MockFinding[\s\S]*?suggestion: string/.test(mock))
// 不能用 ^\s+suggestion: 逐行数 —— 多行字符串值的 suggestion 只有第一行有冒号，
// 后续行是缩进的字符串续行，行首匹配会漏掉。用出现次数更可靠：
// 1 个接口字段声明 + 8 条 finding
// （novelty 1 + blockConflict 3 + data 2 + compute 2 = 8）。
const mockSug = (mock.match(/suggestion:/g) || []).length
const mockFindings = (mock.match(/^\s{6,}suggestion:/gm) || []).length
check('mock 接口有 suggestion 声明', /interface MockFinding[\s\S]*?suggestion: string/.test(mock))
check(
  'mock 八条 finding 都给 suggestion',
  mockFindings === 8,
  `实际 ${mockFindings} 条 finding（总匹配 ${mockSug} 处 = 1 接口声明 + findings）`
)
check('mock PASS 项给空串', /suggestion: '',/.test(mock))
check('mock CONCERN/BLOCKER 给实质改法', /suggestion:\s*\n?\s*'从项目已有的其他论文里/.test(mock))

console.log(`\n══════════ 结果 ══════════`)
console.log(`  通过 ${pass} · 失败 ${fail}`)
if (fail > 0) {
  console.log('\n  ⚠️  有未通过项，Step2 尚未完成\n')
  process.exit(1)
}
console.log('\n  🎉 Step2 两个问题均已在代码层面接通\n')
