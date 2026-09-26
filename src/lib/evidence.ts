/**
 * Evidence 校验规则（全局元能力）
 *
 * 项目硬约束：任何重要的 AI 生成事实、关系、判断、推断都必须能关联 Evidence；
 * 证据不足时必须显式标记，禁止编造。这里是该约束的执行者。
 *
 * 四条规则：
 *   R1  对象必须至少引用 1 条证据（evidenceIds 非空）
 *   R2  被引用的证据不能是 INSUFFICIENT
 *   R3  对象自身的 evidenceStatus 不能是 INSUFFICIENT
 *   R4  引用的 evidenceId 必须真实存在
 *
 * ⚠️ R3 有一个明确的例外：**CrashTest**。
 *    其他模型的 INSUFFICIENT 表示「本该有证据却缺失」，属于缺陷；
 *    但 CrashTest 的 INSUFFICIENT 是它的**合法终态** —— 语义为
 *    「这次检验没有找到可核对的原文证据，所以拒绝给出确定判断」。
 *    这是 P4 刻意的诚信设计（README「Crash Test」章节）。
 *    因此 CrashTest 的写入路径不调用 `guardEvidenceWrite`，见 p4-actions.ts。
 *
 * ── 关于「统一强制层」（P5 接入）──
 *
 * 各 Service 在生成阶段会做自己的证据筛选（哪些片段核对通过、哪些被丢弃），
 * 因此它们对「什么是合格的证据」有比本文件更细的上下文。
 *
 * 本文件提供两层收口：
 *   1. `guardEvidenceWrite` —— 轻量不变量，专供 Server Action 写入路径统一调用。
 *      只检查**任何情况下都不该成立**的条件（当前是 R3），不碰各 Service
 *      已经处理过的筛选逻辑，所以不会误拦。
 *   2. `assertEvidencePolicy` —— 完整四规则校验，供需要严格把关的场景显式调用。
 *
 * 为什么不把完整校验直接塞进 Action 层：各 Service 对"无证据"的处理策略并不
 * 一致（有的拒绝落库，有的是合法的未知态），一刀切会误伤。详见 README 的
 * 「Evidence Chain」章节。
 */

import { prisma } from './prisma'
import { EvidenceStatus, parseJsonArray } from './enums'

export interface EvidenceViolation {
  rule: 'R1_NO_EVIDENCE' | 'R2_INSUFFICIENT_REF' | 'R3_OBJECT_INSUFFICIENT' | 'R4_MISSING_REF'
  message: string
}

export class EvidencePolicyError extends Error {
  constructor(readonly violations: EvidenceViolation[]) {
    super(
      `Evidence 校验未通过，拒绝写入：\n` +
        violations.map((v) => `  [${v.rule}] ${v.message}`).join('\n')
    )
    this.name = 'EvidencePolicyError'
  }
}

/**
 * 写入前的不变量体检（供 Server Action 层统一调用）。
 *
 * 只校验 R3：声称有证据强度的对象，其强度不能是 INSUFFICIENT。
 *
 * 这条规则之所以是安全的不变量：`INSUFFICIENT` 在绝大多数模型上的语义是
 * 「本该有证据但没找到」，属于流程缺陷，不应该落库。各 Service 也都已经
 * 遵守了这一点（无证据时要么拒绝落库，要么记为 UNCERTAIN）。
 *
 * ⚠️ 例外：CrashTest 不适用本规则，调用方必须排除它。
 *    CrashTest 的 `INSUFFICIENT` 是**合法的最终结论**，不是流程缺陷 ——
 *    它的语义是「本次检验没有找到可核对的原文证据，因此拒绝给出确定判断」。
 *    这正是 P4 刻意建立的诚信语义：宁可承认没查到，也不假装找到了。
 *    详见 README「Crash Test」章节与已知局限第 12 条。
 *
 * @param writes 待写入对象列表：`{ label, evidenceStatus }`
 */
export function guardEvidenceWrite(
  writes: Array<{ label: string; evidenceStatus: string | null | undefined }>
): void {
  const violations: EvidenceViolation[] = []

  for (const w of writes) {
    if (w.evidenceStatus === EvidenceStatus.INSUFFICIENT) {
      violations.push({
        rule: 'R3_OBJECT_INSUFFICIENT',
        message: `${w.label} 的证据强度为 INSUFFICIENT。INSUFFICIENT 表示「没有任何可用证据」，这样的对象不允许落库。`,
      })
    }
  }

  if (violations.length > 0) {
    throw new EvidencePolicyError(violations)
  }
}

/**
 * 校验一组 evidenceIds 是否满足写入要求（完整四规则）。
 *
 * R1 / R3 是纯内存判断，R2 / R4 需要查库确认引用真实存在。
 *
 * 注意：各 Service 有自己的证据筛选策略，直接对它们的产物调用本函数可能误拦
 * （例如合法的"未知态"会被 R1 拦下）。写入路径请优先用 `guardEvidenceWrite`。
 *
 * @param evidenceIds   对象引用的证据 id 列表
 * @param evidenceStatus 对象自身的证据强度
 * @param label          出错信息里用的对象名，便于定位
 */
export async function assertEvidencePolicy(
  evidenceIds: string[],
  evidenceStatus: EvidenceStatus,
  label: string
): Promise<void> {
  const violations: EvidenceViolation[] = []

  // R1：必须至少有一条证据
  if (evidenceIds.length === 0) {
    violations.push({
      rule: 'R1_NO_EVIDENCE',
      message: `${label} 没有关联任何证据，不允许写入（无证据的结论禁止落库）`,
    })
  }

  // R3：对象自身不能是 INSUFFICIENT
  if (evidenceStatus === EvidenceStatus.INSUFFICIENT) {
    violations.push({
      rule: 'R3_OBJECT_INSUFFICIENT',
      message: `${label} 的证据强度为 INSUFFICIENT，不允许写入`,
    })
  }

  if (violations.length > 0) {
    throw new EvidencePolicyError(violations)
  }

  // R2 / R4：检查引用的证据真实存在且不是 INSUFFICIENT
  const refs = await prisma.evidenceRef.findMany({
    where: { id: { in: evidenceIds } },
    select: { id: true, status: true },
  })

  if (refs.length !== evidenceIds.length) {
    const found = new Set(refs.map((r) => r.id))
    const missing = evidenceIds.filter((id) => !found.has(id))
    violations.push({
      rule: 'R4_MISSING_REF',
      message: `${label} 引用了不存在的证据 id: ${missing.join(', ')}`,
    })
  }

  const insufficient = refs.filter(
    (r) => r.status === EvidenceStatus.INSUFFICIENT
  )
  if (insufficient.length > 0) {
    violations.push({
      rule: 'R2_INSUFFICIENT_REF',
      message: `${label} 引用了证据强度为 INSUFFICIENT 的证据: ${insufficient
        .map((r) => r.id)
        .join(', ')}`,
    })
  }

  if (violations.length > 0) {
    throw new EvidencePolicyError(violations)
  }
}

/** 从 JSON 字符串字段读取 evidenceIds */
export function readEvidenceIds(raw: string | null | undefined): string[] {
  return parseJsonArray<string>(raw).filter((id) => typeof id === 'string')
}

/** 根据引用的证据整体情况，推导对象的证据强度（供 Service 层统一使用） */
export async function deriveEvidenceStatus(
  evidenceIds: string[]
): Promise<EvidenceStatus> {
  if (evidenceIds.length === 0) return EvidenceStatus.INSUFFICIENT

  const refs = await prisma.evidenceRef.findMany({
    where: { id: { in: evidenceIds } },
    select: { status: true },
  })

  if (refs.length === 0) return EvidenceStatus.INSUFFICIENT

  const hasConfirmed = refs.some((r) => r.status === EvidenceStatus.CONFIRMED)
  const hasUncertain = refs.some((r) => r.status === EvidenceStatus.UNCERTAIN)

  if (hasConfirmed && !hasUncertain) return EvidenceStatus.CONFIRMED
  if (hasConfirmed || hasUncertain) return EvidenceStatus.UNCERTAIN
  return EvidenceStatus.INSUFFICIENT
}
