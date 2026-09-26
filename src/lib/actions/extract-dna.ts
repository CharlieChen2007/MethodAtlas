'use server'

import { revalidatePath } from 'next/cache'
import { extractMethodDNA } from '@/lib/method-dna'
import { EvidencePolicyError } from '@/lib/evidence'
import { LLMError } from '@/lib/llm'
import { PaperStatus } from '@/lib/enums'
import { prisma } from '@/lib/prisma'

export interface ExtractActionResult {
  ok: boolean
  message: string
  detail?: string
}

/**
 * 触发 Method DNA 抽取
 *
 * 失败时把论文状态置回 PARSED（而不是 FAILED）——FAILED 在 P1 表示
 * "PDF 解析失败"，两者语义不同，混用会让用户困惑。
 */
export async function extractDNAAction(
  paperId: string
): Promise<ExtractActionResult> {
  try {
    const result = await extractMethodDNA(paperId)

    revalidatePath(`/projects/${result.projectId}/workspace`)
    revalidatePath(`/projects/${result.projectId}/workspace/papers/${paperId}`)
    revalidatePath(`/projects/${result.projectId}/method-lab/dna/${paperId}`)

    const via =
      result.provider === 'mock'
        ? '（本地启发式抽取，未经语义模型验证）'
        : `（${result.provider} / ${result.model}）`

    return {
      ok: true,
      message: `已抽取 ${result.blockCount} 个方法模块、${result.evidenceCount} 条证据 ${via}`,
      detail:
        result.uncertainties.length > 0
          ? `以下字段因原文未明确说明而留空：${result.uncertainties.join('；')}`
          : undefined,
    }
  } catch (err) {
    // 抽取失败时把状态退回 PARSED，保留重新抽取的机会
    await prisma.paper
      .update({ where: { id: paperId }, data: { status: PaperStatus.PARSED } })
      .catch(() => {})

    if (err instanceof EvidencePolicyError) {
      return { ok: false, message: '证据校验未通过，已拒绝写入', detail: err.message }
    }
    if (err instanceof LLMError) {
      return {
        ok: false,
        message: `模型调用失败（${err.kind}）`,
        detail: err.message,
      }
    }
    return {
      ok: false,
      message: '抽取失败',
      detail: (err as Error).message,
    }
  }
}
