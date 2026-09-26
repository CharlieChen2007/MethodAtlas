/**
 * S5 验证：四段式推理链的「prompt 契约 ↔ 代码校验 ↔ mock 输出」三者自洽。
 *
 * 最容易出的故障（也是本脚本主要盯的）：
 *   whyIsVague() 加了四段结构校验后，**mock 自己产出的 why 会不会被判为
 *   空话**？如果会，降级模式下所有候选都会被静默丢光（0 个 idea）——
 *   这比文案难看严重得多，而且不会有任何报错。
 */
// ── 校验逻辑直接从生产源码取，脚本自包含 ──
//    做法：整体编译 crossbreeder.ts（用项目自带的 tsc），require 它的导出。
//    只为了拿到 whyIsVague，所以把 @/lib/prisma 换成一个空壳 —— 否则
//    require 时会去连数据库（校验函数本身完全用不到它）。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

function loadWhyValidators() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's5-'))
  const shim = path.join(tmp, 'prisma-shim.ts')
  fs.writeFileSync(shim, 'export const prisma: any = {}\n', 'utf8')

  const tsconfig = path.join(tmp, 'tsconfig.json')
  fs.writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        outDir: tmp,
        module: 'commonjs',
        target: 'es2020',
        moduleResolution: 'node',
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        // 不加载 @types：本脚本只需运行时行为，缺 Node 类型定义不影响
        types: [],
        baseUrl: ROOT,
        // 把 prisma 指向空壳；其余别名照常
        paths: { '@/lib/prisma': [shim], '@/*': ['src/*'] },
        noEmitOnError: false,
      },
      include: [path.join(ROOT, 'src/lib/crossbreeder.ts')],
    }),
    'utf8'
  )

  // tsc 会因为 llm.ts 缺 @types/node 而报 TS2591，但**依然会产出 JS**。
  // 所以这里容忍非零退出码 —— 我们只关心文件有没有生成（下面会检查）。
  try {
    execFileSync(path.resolve(ROOT, 'node_modules/.bin/tsc'), ['-p', tsconfig], { stdio: 'pipe' })
  } catch {
    /* 见上：类型报错不阻断产出 */
  }

  // tsc 会按 rootDir 摊平目录，找到编译出来的 crossbreeder.js
  const found = []
  ;(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.name === 'crossbreeder.js') found.push(f)
      // 编译出来的 prisma.js 会去 require('@prisma/client')，
      // 但校验函数根本用不到 prisma —— 替换成空壳，避免拉起真实客户端。
      else if (e.name === 'prisma.js') {
        fs.writeFileSync(f, 'exports.prisma = {}\n', 'utf8')
      }
    }
  })(tmp)
  if (!found.length) throw new Error('tsc 未产出 crossbreeder.js')

  const mod = require(found[0])
  fs.rmSync(tmp, { recursive: true, force: true })
  return mod
}
const { whyIsVague } = loadWhyValidators()

const DEBT = '计算开销与可扩展性'
function mockWhy(blkA, blkB) {
  return [
    `①债务的缺口：「${DEBT}」卡在` +
      `${blkA.role ? `原方案只解决了「${blkA.role}」这一面，` : ''}` +
      `没有处理它在规模上去之后才暴露的那一段。`,
    `②模块的特性：「${blkB.name}」的机制是` +
      `${blkB.role || '承担组合中缺失的那一环'}，` +
      `这一能力此前没有被放进与「${DEBT}」相同的流程里。`,
    `③为什么能对上：把「${blkB.name}」的这项能力接在` +
      `「${blkA.name}」之后，正好补上第①段里那段没人负责的缺口——` +
      `两者出自不同论文、从未同框，所以这是一个尚未被验证过的接法。`,
    `④可验证的预期：若这个组合成立，在固定现有算力预算下` +
      `逐步加大处理规模时，相对只用「${blkA.name}」的基线` +
      `应当观察到质量继续上升而不是提前持平。`,
  ].join('\n')
}

const PAIRS = [
  [{ name: 'RAG (Retrieval-augmented Generation)', role: '基于编码结果生成最终输出' },
   { name: 'Fusion-in-Decoder', role: '把多个段落的编码拼接后一次性交给解码器，解码只跑一次' }],
  [{ name: 'TVR (Two Variants RAG-Sequence)', role: '负责从语料库中检索出与问题相关的段落' },
   { name: 'ST (Separately Together)', role: '把检索到的段落分别编码' }],
  [{ name: 'DPR (Dense Passage Retriever)', role: '把输入文本编码成向量表示，供后续环节使用' },
   { name: 'IRG (Ideas from Retrieval-augmented Generation)', role: '' }],
]

// 应当被拦下的「空话」样本
const BAD = [
  ['一句话空话', '可以提高性能。'],
  ['套话开头', '能够提升效果，有助于泛化。'],
  ['两段式（问题 7 的旧格式）',
   '用「Fusion-in-Decoder」补上「RAG」在「计算开销」上的短板。\n两者出自不同论文、从未同框，功能上正好一个负责生成、一个负责压缩。'],
  ['四段但缺衔接',
   '①债务缺口：检索篇数多了解码成本线性上涨。\n②模块特性：FiD 把编码拼接后一次解码。\n③预期：算力固定下质量应当继续上升。'],
]

let pass = 0, fail = 0
const chk = (c, m) => { if (c) { pass++; console.log('    ✅ ' + m) } else { fail++; console.log('    ❌ ' + m) } }

console.log('═'.repeat(72))
console.log('S5 验证：四段式推理链')
console.log('═'.repeat(72))

console.log('\n── 1) mock 自己产出的 why 必须通过校验（否则降级时候选会被丢光）──')
for (const [a, b] of PAIRS) {
  const w = mockWhy(a, b)
  console.log('\n【' + a.name.slice(0, 30) + ' × ' + b.name.slice(0, 24) + '】')
  w.split('\n').forEach((l) => console.log('    ' + l))
  chk(!whyIsVague(w), 'mock 的 why 通过 whyIsVague（不会被静默丢弃）')
  chk(w.split('\n').filter(Boolean).length === 4, '确实是 4 段')
}

console.log('\n── 2) 空话样本必须被拦下 ──')
for (const [label, w] of BAD) {
  const bad = whyIsVague(w)
  console.log('\n【' + label + '】')
  w.split('\n').forEach((l) => console.log('    ' + l))
  chk(bad, '被 whyIsVague 判定为不通过')
}

console.log('\n' + '═'.repeat(64))
console.log('通过 ' + pass + ' / 失败 ' + fail)
console.log(fail === 0 ? '结论：全部通过 ✅' : '结论：存在失败 ❌')
process.exit(fail === 0 ? 0 : 1)
