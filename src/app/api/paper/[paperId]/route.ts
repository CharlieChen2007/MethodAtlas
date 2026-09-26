/**
 * ── 问题 5：论文原文取用（证据核对闭环保底）──
 *
 * 证据抽屉要能「打开 PDF 对应页」。浏览器打开 PDF 需要一个能取到
 * 文件字节的 URL —— 而 `storage/` 不在 `public/` 下（它是运行期写入的
 * 用户数据，不该被打包/静态暴露），所以必须有一个 Route Handler 按 id
 * 把文件流出来。
 *
 * 安全约定：
 *   · 只按 `paperId` 查库拿 `pdfPath`，**不接受任意路径参数** ——
 *     这是防目录穿越的关键：路径完全由服务端从数据库取，客户端无法构造
 *     `../../etc/passwd` 这类输入。
 *   · 文件不存在（老数据 pdfPath 为空 / 文件被清掉）→ 404 并给出可读说明，
 *     而不是 500。前端据此提示"这篇论文没有可打开的原文"。
 *
 * 支持 Range 请求（`Accept-Ranges`）：浏览器内置 PDF 阅读器要跳到第 N 页
 * 时，会按字节区间请求，不支持 Range 会退化成整文件下载、定位失效。
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: { paperId: string } }
) {
  const paperId = params.paperId
  if (!paperId) {
    return NextResponse.json({ ok: false, message: '缺少论文 id' }, { status: 400 })
  }

  const paper = await prisma.paper.findUnique({
    where: { id: paperId },
    select: { id: true, title: true, pdfPath: true },
  })
  if (!paper) {
    return NextResponse.json({ ok: false, message: '论文不存在' }, { status: 404 })
  }

  /**
   * pdfPath 在库里是**相对仓库根**的路径（storage/papers/<id>/paper.pdf）。
   * 与 process.cwd() 拼成绝对路径 —— 和 upload 路由写入时同一套基准，
   * 保证读写指向同一个文件。
   */
  const rel = (paper.pdfPath ?? '').trim()
  if (!rel) {
    return NextResponse.json(
      { ok: false, message: '这篇论文没有保存原文文件，无法打开 PDF' },
      { status: 404 }
    )
  }

  const abs = path.join(process.cwd(), rel)

  let size: number
  try {
    const st = await stat(abs)
    size = st.size
  } catch {
    return NextResponse.json(
      { ok: false, message: '这篇论文的原文文件已不存在（可能被清理过）' },
      { status: 404 }
    )
  }

  const range = req.headers.get('range')
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    // inline：让浏览器内置阅读器直接打开，而不是弹下载框
    'Content-Disposition': `inline; filename="paper.pdf"`,
    'Accept-Ranges': 'bytes',
    // 原文是用户上传的自有资料，缓存一小段时间即可，避免频繁读盘
    'Cache-Control': 'private, max-age=3600',
  }

  // ── Range 请求：返回 206 + 局部字节，PDF 阅读器据此跳页/流式加载 ──
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      const start = m[1] ? Number(m[1]) : 0
      const end = m[2] ? Number(m[2]) : size - 1
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
        const safeEnd = Math.min(end, size - 1)
        const buf = await readFile(abs)
        const chunk = buf.subarray(start, safeEnd + 1)
        return new NextResponse(new Uint8Array(chunk), {
          status: 206,
          headers: {
            ...headers,
            'Content-Range': `bytes ${start}-${safeEnd}/${size}`,
            'Content-Length': String(chunk.length),
          },
        })
      }
    }
    // Range 头不合法 → 忽略，按整文件返回（比 416 更宽容，浏览器能自己兜底）
  }

  const buf = await readFile(abs)
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: { ...headers, 'Content-Length': String(size) },
  })
}
