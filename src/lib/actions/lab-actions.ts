'use server'

import { revalidatePath } from 'next/cache'
import { runSurgery } from '@/lib/method-surgery'
import { extractEvolution } from '@/lib/method-evolution'
import { EvidencePolicyError, guardEvidenceWrite } from '@/lib/evidence'
import { LLMError } from '@/lib/llm'
import { SurgeryAction } from '@/lib/enums'
import { prisma } from '@/lib/prisma'

export interface ActionResult {
  ok: boolean
  message: string
  detail?: string
}

// ===================== Evidence 统一写入体检 =====================
//
// 与 p4-actions 同样的策略：各 Service 生成阶段已有自己的证据筛选，
// 这里在落库后复查，确认没有对象带着 INSUFFICIENT 状态留在库里。

/** 手术记录的状态体检 */
async function guardSurgeryWrite(surgeryId: string): Promise<void> {
  const s = await prisma.surgery.findUnique({
    where: { id: surgeryId },
    select: { title: true, evidenceStatus: true },
  })
  if (!s) return

  guardEvidenceWrite([
    { label: `手术记录「${s.title}」`, evidenceStatus: s.evidenceStatus },
  ])
}

/** 演化关系的状态体检 */
async function guardRelationWrites(projectId: string): Promise<void> {
  const relations = await prisma.relation.findMany({
    where: { projectId },
    select: { id: true, type: true, evidenceStatus: true },
  })

  guardEvidenceWrite(
    relations.map((r) => ({
      label: `演化关系 ${r.id}（${r.type}）`,
      evidenceStatus: r.evidenceStatus,
    }))
  )
}

/** 执行一次方法手术 */
export async function surgeryAction(params: {
  blockId: string
  action: string
  note?: string
}): Promise<ActionResult> {
  try {
    const action = (Object.values(SurgeryAction) as string[]).includes(
      params.action
    )
      ? (params.action as SurgeryAction)
      : SurgeryAction.REMOVE

    const res = await runSurgery({
      blockId: params.blockId,
      action,
      note: params.note?.trim() || undefined,
    })
    await guardSurgeryWrite(res.surgeryId)

    revalidatePath(`/projects/${res.projectId}/method-lab/surgery/${res.methodId}`)
    revalidatePath(`/projects/${res.projectId}/method-lab/dna/${res.paperId}`)

    return {
      ok: true,
      message: `手术分析完成：${res.evidenceCount} 条证据`,
      detail:
        res.uncertainties.length > 0
          ? `不确定项：${res.uncertainties.join('；')}`
          : undefined,
    }
  } catch (err) {
    if (err instanceof EvidencePolicyError) {
      return { ok: false, message: '证据校验未通过，已拒绝写入', detail: err.message }
    }
    if (err instanceof LLMError) {
      return { ok: false, message: `模型调用失败（${err.kind}）`, detail: err.message }
    }
    return { ok: false, message: '手术分析失败', detail: (err as Error).message }
  }
}

/** 删除一次手术记录 */
export async function deleteSurgeryAction(surgeryId: string): Promise<ActionResult> {
  try {
    const surgery = await prisma.surgery.findUnique({
      where: { id: surgeryId },
      include: { method: { include: { paper: true } } },
    })
    if (!surgery) return { ok: false, message: '手术记录不存在' }

    await prisma.surgery.delete({ where: { id: surgeryId } })

    revalidatePath(
      `/projects/${surgery.method.paper.projectId}/method-lab/surgery/${surgery.methodId}`
    )
    return { ok: true, message: '已删除该手术记录' }
  } catch (err) {
    return { ok: false, message: '删除失败', detail: (err as Error).message }
  }
}

/** 梳理项目内方法演化关系 */
export async function evolutionAction(projectId: string): Promise<ActionResult> {
  try {
    const res = await extractEvolution(projectId)
    await guardRelationWrites(projectId)

    revalidatePath(`/projects/${projectId}/evolution/graph`)
    revalidatePath(`/projects/${projectId}/workspace`)

    return {
      ok: true,
      message: `建立 ${res.created} 条演化关系，${res.evidenceCount} 条证据（跳过 ${res.skipped} 条证据不足或置信度过低的候选）`,
      detail: res.notes.length > 0 ? res.notes.join('；') : undefined,
    }
  } catch (err) {
    if (err instanceof LLMError) {
      return { ok: false, message: `模型调用失败（${err.kind}）`, detail: err.message }
    }
    return { ok: false, message: '演化梳理失败', detail: (err as Error).message }
  }
}

/** 人工确认或否决一条演化关系 */
export async function reviewRelationAction(
  relationId: string,
  projectId: string,
  decision: 'confirm' | 'reject'
): Promise<ActionResult> {
  try {
    if (decision === 'reject') {
      await prisma.relation.delete({ where: { id: relationId } })
      revalidatePath(`/projects/${projectId}/evolution/graph`)
      return { ok: true, message: '已否决并删除该关系' }
    }

    // 确认：把证据强度提到 CONFIRMED（人工复核高于模型自评）
    await prisma.relation.update({
      where: { id: relationId },
      data: { confidence: 1, evidenceStatus: 'CONFIRMED' },
    })
    revalidatePath(`/projects/${projectId}/evolution/graph`)
    return { ok: true, message: '已确认该关系' }
  } catch (err) {
    return { ok: false, message: '操作失败', detail: (err as Error).message }
  }
}
