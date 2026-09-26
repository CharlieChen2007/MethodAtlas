import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { NextResponse } from 'next/server'

import { prisma } from '@/lib/prisma'
import { PaperStatus } from '@/lib/enums'
import { parsePdf, NO_TEXT_LAYER } from '@/lib/pdf-parse'
import { extractMethodDNA } from '@/lib/method-dna'

/**
 * POST /api/upload —— 上传论文 PDF，一次跑完整条链路（问题 6 修复）。
 *
 * ── 为什么从 Server Action 改成 API Route ──
 *
 * 原来的 Server Action 有两个致命缺陷：
 *   1. **链子断了一截**：解析完 PDF 只写到 status=PARSED 就结束，
 *      从来没调用 extractMethodDNA。也就是说，**通过上传入口进来的论文
 *      永远不会有方法结构**，画布上永远点不开。
 *      （seed 的论文能显示结构，是因为 seed 走了 /api/pipeline 的另一条链。）
 *   2. **失败静默**：解析服务连不上时 catch → 只 console.error，
 *      函数返回 void，前端无从得知失败，用户只看到"论文没出现"。
 *
 * 现在这条 Route 把链路补全：
 *   PDF 字节 → 文本 → 写 PARSED → 抽取 Method DNA → 写 DNA_EXTRACTED
 *
 * 而且每一步都**如实回报**：成功给出真实计数，失败给出人话原因 + HTTP 状态码，
 * 前端可以据此显示明确的错误，而不是装作没事。
 *
 * ── 为什么不用 Server Action 而是 Route ──
 * 这条链路耗时较长（解析 + LLM 抽取），需要返回**结构化结果**（含 status/计数）
 * 让前端渲染真实进度；Server Action 的返回值在流式渲染下不好做多阶段进度。
 * 另外上传体积限制已在 next.config.mjs 放宽到 50mb。
 */

export const dynamic = 'force-dynamic'
// Node 运行时：需要 fs + pdfjs（不能跑在 Edge）
export const runtime = 'nodejs'

const MAX_UPLOAD_MB = 50

interface UploadOk {
  ok: true
  paperId: string
  title: string
  authors: string[]
  year: number | null
  pageCount: number
  paragraphCount: number
  blockCount: number
  evidenceCount: number
  evidenceStatus: string
  provider: string
  warnings: string[]
}

interface UploadErr {
  ok: false
  /** 失败发生在哪一步 —— 前端据此给出更具体的提示 */
  stage: 'validate' | 'save' | 'parse' | 'dna' | 'unknown'
  message: string
  detail?: string
  /** 失败时已写入的论文 id（便于用户重试/DNA 重抽） */
  paperId?: string
}

function err(stage: UploadErr['stage'], message: string, detail?: string, paperId?: string) {
  const body: UploadErr = { ok: false, stage, message, detail, paperId }
  // 400 输入问题；其余是服务端处理失败（502 表示上游解析/抽取不可用）
  const status = stage === 'validate' ? 400 : 500
  return NextResponse.json(body, { status })
}

export async function POST(req: Request) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return err('validate', '请求不是合法的表单数据（multipart/form-data）。')
  }

  const projectId = String(form.get('projectId') ?? '').trim()
  const file = form.get('file')

  if (!projectId) return err('validate', '缺少 projectId。')
  if (!(file instanceof File) || file.size === 0) return err('validate', '没有收到 PDF 文件（或文件为空）。')

  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    return err('validate', `「${file.name}」不是 PDF 文件。`, '目前只支持 PDF 格式的论文。')
  }
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    return err(
      'validate',
      `「${file.name}」超过 ${MAX_UPLOAD_MB} MB 上限。`,
      '请先压缩 PDF，或拆分后再上传。'
    )
  }

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!project) return err('validate', '项目不存在，无法上传到该项目。')

  // ── 1) 建占位记录 + 落盘 ──
  const fallbackTitle = file.name.replace(/\.pdf$/i, '').trim() || '未命名论文'
  let paperId = ''
  try {
    const paper = await prisma.paper.create({
      data: { projectId, title: fallbackTitle, pdfPath: '', status: PaperStatus.UPLOADED },
    })
    paperId = paper.id

    const relDir = path.join('storage', 'papers', paper.id)
    const absDir = path.join(process.cwd(), relDir)
    await mkdir(absDir, { recursive: true })

    const relPath = path.join(relDir, 'paper.pdf')
    const buffer = Buffer.from(await file.arrayBuffer())
    await writeFile(path.join(process.cwd(), relPath), buffer)

    await prisma.paper.update({ where: { id: paper.id }, data: { pdfPath: relPath } })
  } catch (e) {
    return err('save', '文件保存失败。', (e as Error).message, paperId || undefined)
  }

  // ── 2) 解析 PDF（内置，纯 Node） ──
  let parsed
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    parsed = await parsePdf(new Uint8Array(buffer))
  } catch (e) {
    await prisma.paper
      .update({ where: { id: paperId }, data: { status: PaperStatus.FAILED } })
      .catch(() => {})
    /**
     * 问题 1：这里原来是**误判** —— 不管什么原因失败，都告诉用户
     * "可能是扫描件"。而真正常见的是 worker 路径 / 解析器报错，
     * 用户拿到的建议（"转成带文字层的 PDF"）完全对不上病因。
     *
     * 现在分两类，如实说：
     *   · NO_TEXT_LAYER —— 解析**跑完了**但一个字符都没有，这才真是图片型 PDF；
     *   · 其它          —— 解析过程**出错**，把真实原因原样给出，并引导看服务端日志。
     */
    const msg = (e as Error).message
    if (msg === NO_TEXT_LAYER) {
      return err(
        'parse',
        `「${file.name}」里没有可提取的文字 —— 这份 PDF 很可能是扫描件（纯图片）。`,
        '需要先用 OCR 工具（如 Adobe Acrobat、ABBYY、或在线 OCR）把图片文字转成可选中文字的 PDF，再上传。',
        paperId
      )
    }
    return err(
      'parse',
      `「${file.name}」解析出错：${msg}`,
      '这不是"扫描件"问题，而是解析器本身报错。请把这条错误发给开发者；' +
        '若服务端日志里能看到完整堆栈，一并提供能更快定位。',
      paperId
    )
  }

  await prisma.paper.update({
    where: { id: paperId },
    data: {
      title: parsed.title || fallbackTitle,
      authors: JSON.stringify(parsed.authors),
      year: parsed.year,
      abstract: parsed.abstract || null,
      rawText: JSON.stringify(parsed.paragraphs),
      pageCount: parsed.pageCount,
      status: PaperStatus.PARSED,
    },
  })

  // ── 3) 抽取 Method DNA —— 原实现**完全缺失**的这一环 ──
  let dna
  try {
    dna = await extractMethodDNA(paperId)
  } catch (e) {
    // 文本已经解析出来了，论文保留在 PARSED（用户可重试抽取），
    // 但要明确告诉用户"解析成功、结构抽取失败"，不要假装全成功。
    await prisma.paper
      .update({ where: { id: paperId }, data: { status: PaperStatus.PARSED } })
      .catch(() => {})
    return err(
      'dna',
      `PDF 已解析成功，但方法结构抽取失败：${(e as Error).message}`,
      '文本已经在库里了。可以在右栏选中这篇论文后点「重新抽取方法 DNA」再试一次。',
      paperId
    )
  }

  const body: UploadOk = {
    ok: true,
    paperId,
    title: parsed.title || fallbackTitle,
    authors: parsed.authors,
    year: parsed.year,
    pageCount: parsed.pageCount,
    paragraphCount: parsed.paragraphs.length,
    blockCount: dna.blockCount,
    evidenceCount: dna.evidenceCount,
    evidenceStatus: dna.evidenceStatus,
    provider: dna.provider,
    warnings: dna.warnings ?? [],
  }
  return NextResponse.json(body, { status: 200 })
}
