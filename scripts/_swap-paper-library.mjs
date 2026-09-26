#!/usr/bin/env node
/**
 * 用 8 篇 Wi-Fi 指纹数据增强论文替换现有论文库，并跑通全链路。
 *
 * ── 为什么走 HTTP API 而不是直接 import 服务层 ──
 *   服务层是 TypeScript（`@/lib/method-evolution` 等），Node 直接 import 不了。
 *   项目本来就为这件事开了两个受控入口：
 *     · POST /api/upload          字节 → 文本 → 写 PARSED → 抽 Method DNA
 *     · POST /api/pipeline        evolution / debt / crossbreed / crashtest
 *                                 （需 ENABLE_PIPELINE_API=1）
 *   走它们 = 调到与 UI **完全相同的服务函数**，所以"脚本跑通"等价于
 *   "流水线真的可用"，而不是"我伪造了数据"。
 *
 * 用法：
 *   node scripts/_swap-paper-library.mjs            # 干跑（只报告将做什么）
 *   node scripts/_swap-paper-library.mjs --apply    # 真跑
 *   node scripts/_swap-paper-library.mjs --apply --keep-old   # 不清旧论文（调试用）
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

const APPLY = process.argv.includes('--apply')
const KEEP_OLD = process.argv.includes('--keep-old')
const BASE = process.env.MA_BASE ?? 'http://127.0.0.1:3000'
const PROJECT_ID = process.env.MA_PROJECT ?? 'cmu9my2ie0000z6pko5sqr27s'
const DESKTOP = 'C:\\Users\\Charlie\\Desktop'

/** 8 篇新论文（文件名 + 展示用短名 + 年份 + 技术路线），按技术代际排序 */
const PAPERS = [
  ['A_WiFi_Fingerprint_Augmentation_Method_for_3-D_Crowdsourced_Indoor_Positioning_Systems.pdf',
   'WiFi Fingerprint Augmentation', 2022, '高斯过程回归（GPR）'],
  ['GAN_Based_Data_Augmentation_for_Indoor_Localization_Using_Labeled_and_Unlabeled_Data.pdf',
   'GAN Based Data Augmentation', 2021, 'GAN + 半监督'],
  ['More_Accuracy_Less_Fingerprints_Wi-Fi_Indoor_Localization_via_Generative_Adversarial_Networks.pdf',
   'LocGAN', 2023, '半监督 GAN'],
  ['Improve_Indoor_Localization_Accuracy_by_Enriching_CSI_Fingerprints_with_CDPM.pdf',
   'CDPM', 2023, '条件扩散概率模型'],
  ['LCVAE-CNN_Indoor_Wi-Fi_Fingerprinting_CNN_Positioning_Method_Based_on_LCVAE.pdf',
   'LCVAE-CNN', 2025, '位置条件 VAE + CNN'],
  ['WIFIND_Enhancing_Wi-Fi_Fingerprint_Indoor_Localization_with_a_Spatially_Conditioned_Diffusion_Model-Based_Data_Augmentation.pdf',
   'WIFIND', 2025, '空间条件扩散模型'],
  ['Semi-Supervised_Multi-Task_Deep_Learning_for_WiFi_Fingerprint_Database_Construction_in_Building-Scale_Localization.pdf',
   'Semi-Supervised Multi-Task', 2025, '半监督多任务 Mean-Teacher'],
  // ⚠️ 用户名单里第 8 位写的是「Attentional Graph Meta-Learning (2026) 图神经网络 + 元学习」，
  //    但桌面上没有那份 PDF；经与用户确认，**改用**桌面上的 Bayesian-Boosted MetaLoc。
  //    README 表格与演化链叙事随之按"贝叶斯元学习"口径写。
  ['Bayesian-Boosted_MetaLoc_Efficient_Training_and_Guaranteed_Generalization_for_Indoor_Localization.pdf',
   'Bayesian-Boosted MetaLoc', 2025, '元学习 + 贝叶斯（极稀疏场景）'],
]

const prisma = new PrismaClient()
const log = (...a) => console.log(...a)

async function counts() {
  const [pa, dna, blk, rel, de, id, cr, su] = await Promise.all([
    prisma.paper.count(), prisma.methodDNA.count(), prisma.methodBlock.count(),
    prisma.relation.count(), prisma.researchDebt.count(),
    prisma.candidateIdea.count(), prisma.crashTest.count(), prisma.surgeryLog.count(),
  ])
  return { pa, dna, blk, rel, de, id, cr, su }
}
const fmt = (c) => `论文 ${c.pa} | DNA ${c.dna} | 模块 ${c.blk} | 关系 ${c.rel} | 债务 ${c.de} || 想法 ${c.id} | 击穿 ${c.cr} | 手术 ${c.su}`

/** 清空论文库：删 Paper（所有指向它的关系都是 onDelete: Cascade） */
async function clearLibrary() {
  const papers = await prisma.paper.findMany({ select: { id: true, title: true } })
  log(`\n将删除 ${papers.length} 篇旧论文（级联 DNA/Block/证据/关系/债务来源/尝试）：`)
  for (const p of papers) log(`  - ${(p.title || '').slice(0, 56)}`)
  if (!APPLY) return papers.length
  // 先清用户动作（想法/击穿/手术），避免悬挂引用
  await prisma.crashTest.deleteMany({})
  await prisma.candidateIdea.deleteMany({})
  await prisma.surgeryLog.deleteMany({})
  await prisma.relation.deleteMany({})
  await prisma.researchDebt.deleteMany({})
  for (const p of papers) await prisma.paper.delete({ where: { id: p.id } })
  log(`  已删除 ${papers.length} 篇（含全部派生数据）`)
  return papers.length
}

/** 上传一篇：/api/upload 内部会「解析 PDF + 抽 Method DNA」 */
async function uploadOne(file, idx) {
  const abs = path.join(DESKTOP, file[0])
  if (!existsSync(abs)) return { ok: false, message: `文件不存在：${abs}` }
  const buf = readFileSync(abs)
  const fd = new FormData()
  fd.append('projectId', PROJECT_ID)
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), file[0])

  const t0 = Date.now()
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: fd })
  const txt = await res.text()
  let j
  try { j = JSON.parse(txt) } catch { return { ok: false, message: `非 JSON 响应（${res.status}）：${txt.slice(0, 160)}` } }
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  if (!j.ok) {
    return { ok: false, message: `[${j.stage}] ${j.message}${j.detail ? ' / ' + j.detail : ''}`, paperId: j.paperId, secs }
  }
  return {
    ok: true, paperId: j.paperId, secs,
    message: `${j.blockCount} 模块 / ${j.evidenceCount} 证据（${j.evidenceStatus}）/ ${j.pageCount} 页`,
    title: j.title, year: j.year,
  }
}

/** 调 /api/pipeline 的某个 action */
async function pipeline(action, extra = {}) {
  const res = await fetch(`${BASE}/api/pipeline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, projectId: PROJECT_ID, ...extra }),
  })
  const txt = await res.text()
  let j
  try { j = JSON.parse(txt) } catch { return { ok: false, message: `非 JSON（${res.status}）：${txt.slice(0, 200)}` } }
  return { ok: Boolean(j.ok), message: j.message ?? '', detail: j.detail }
}

async function main() {
  log('='.repeat(74))
  log(`论文库替换：${PAPERS.length} 篇 Wi-Fi 指纹数据增强论文`)
  log(`模式：${APPLY ? '真跑' : '干跑（加 --apply 才动手）'}`)
  log(`服务：${BASE}  项目：${PROJECT_ID}`)
  log('='.repeat(74))
  log(`\n替换前：${fmt(await counts())}`)

  // 0) 服务可用性（pipeline 接口必须先开着）
  const probe = await pipeline('dna', { paperId: 'nonexistent' })
  if (/未启用/.test(probe.message)) {
    log('\n!! /api/pipeline 未启用 —— 请用 ENABLE_PIPELINE_API=1 重启 dev server 后再跑。')
    await prisma.$disconnect()
    process.exit(2)
  }

  // 1) 清空旧库
  if (KEEP_OLD) {
    log('\n（--keep-old：跳过清空）')
  } else {
    log('\n── 步骤 1：清空现有论文库 ──')
    await clearLibrary()
    if (!APPLY) { log('\n[dry-run] 到此为止。'); await prisma.$disconnect(); return }
    log(`  清空后：${fmt(await counts())}`)
  }
  if (!APPLY) { log('\n[dry-run] 到此为止。'); await prisma.$disconnect(); return }

  // 2) 上传 8 篇（解析 + DNA 抽取）
  log('\n── 步骤 2：上传并解析 8 篇（含 DNA 抽取）──')
  const uploaded = []
  for (let i = 0; i < PAPERS.length; i++) {
    const p = PAPERS[i]
    process.stdout.write(`  [${i + 1}/${PAPERS.length}] ${p[1].padEnd(28)} `)
    const r = await uploadOne(p, i)
    if (r.ok) {
      log(`✓ ${r.secs}s  ${r.message}`)
      uploaded.push({ ...p, paperId: r.paperId, realTitle: r.title })
    } else {
      log(`✗ ${r.message}`)
      if (r.paperId) uploaded.push({ ...p, paperId: r.paperId, failed: true })
    }
  }
  const okUp = uploaded.filter((u) => !u.failed)
  log(`\n  上传成功 ${okUp.length}/${PAPERS.length}`)
  log(`  上传后：${fmt(await counts())}`)

  // 3) 演化
  log('\n── 步骤 3：演化分析 ──')
  const evo = await pipeline('evolution')
  log(`  ${evo.ok ? '✓' : '✗'} ${evo.message}`)

  // 4) 债务
  log('\n── 步骤 4：债务合成 ──')
  const debt = await pipeline('debt')
  log(`  ${debt.ok ? '✓' : '✗'} ${debt.message}`)

  // 5) 组合想法
  log('\n── 步骤 5：组合想法 ──')
  const cb = await pipeline('crossbreed')
  log(`  ${cb.ok ? '✓' : '✗'} ${cb.message}`)

  // 6) 击穿测试
  log('\n── 步骤 6：击穿测试 ──')
  const ct = await pipeline('crashtest')
  log(`  ${ct.ok ? '✓' : '✗'} ${ct.message}`)
  if (ct.detail) ct.detail.split('\n').forEach((l) => log(`      ${l}`))

  log(`\n${'='.repeat(74)}`)
  log(`替换后：${fmt(await counts())}`)
  log('='.repeat(74))

  // 逐篇 DNA 明细（验收用）
  log('\n每篇论文的 DNA 明细：')
  const papers = await prisma.paper.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, year: true },
  })
  for (const p of papers) {
    const dna = await prisma.methodDNA.findFirst({
      where: { paperId: p.id },
      include: { blocks: { select: { stage: true } } },
    })
    const ev = await prisma.evidenceRef.count({ where: { paperId: p.id } })
    const stages = new Set((dna?.blocks ?? []).map((b) => b.stage))
    log(`  ${String(p.year ?? '?').padEnd(4)} ${(p.title || '').slice(0, 46).padEnd(46)} 模块 ${String(dna?.blocks.length ?? 0).padStart(2)}  阶段 ${stages.size}  证据 ${ev}`)
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('\nFAIL', e)
  await prisma.$disconnect()
  process.exit(1)
})
