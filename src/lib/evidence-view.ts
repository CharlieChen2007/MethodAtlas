/**
 * 证据视图工具（服务端 / 客户端通用）
 *
 * 把数据库里的 EvidenceRef 记录转成 UI 层统一消费的 EvidenceItem，
 * 并提供「按 id 数组取有序证据」的辅助函数。
 *
 * 为什么要单独一个文件：
 *   - EvidenceItem 是 UI 契约，但服务端页面（Server Component）也要造它，
 *     放在 'use client' 的组件文件里会导致服务端无法安全 import
 *   - 「evidenceId 数组 → EvidenceItem」这段映射原本在 5 个页面里各写了一遍，
 *     这里收敛成一份实现
 *
 * 本文件不导任何 React / 客户端 API，可安全被 Server Component 引用。
 */

import { prisma } from './prisma'
import { parseJsonArray, type EvidenceSource, type EvidenceStatus } from './enums'

/**
 * 证据抽屉消费的统一视图对象。
 *
 * 注意：这是 UI 契约，字段与 EvidenceRef 表并不一一对应
 * （`paperTitle` 是从关联的 Paper 带出来的，用于跨论文场景下标识来源）。
 */
export interface EvidenceItem {
  id: string
  source: EvidenceSource
  status: EvidenceStatus
  quote: string | null
  section: string | null
  pageNumber: number | null
  confidence: number
  paperTitle?: string
  /**
   * ── 问题 5：证据核对闭环需要"打开 PDF 对应页" ──
   *
   * 光有 paperTitle 不够 —— 打开原文需要的是可寻址的 id
   * （前端据此拼 `/api/paper/<paperId>#page=<pageNumber>`）。
   * 所以这里必须把 paperId 也带出来。可空：历史数据/合成证据可能没有。
   */
  paperId?: string
}

/** EvidenceRef 记录中本工具需要的字段形状 */
interface EvidenceRefLike {
  id: string
  source: string
  status: string
  quote: string | null
  section: string | null
  pageNumber: number | null
  confidence: number
  paperId?: string
}

/**
 * 单条 EvidenceRef → EvidenceItem。
 *
 * `source` / `status` 在库里是 String（SQLite 不支持 enum），
 * 这里做一次收敛转型。运行时若出现未知值，UI 侧用 `??` 兜底渲染，
 * 不会因此崩溃。
 */
export function toEvidenceItem(
  e: EvidenceRefLike,
  paperTitle?: string
): EvidenceItem {
  return {
    id: e.id,
    source: e.source as EvidenceSource,
    status: e.status as EvidenceStatus,
    quote: e.quote,
    section: e.section,
    pageNumber: e.pageNumber,
    confidence: e.confidence,
    paperTitle,
    paperId: e.paperId,
  }
}

/**
 * 批量：按 evidenceId 列表查库并组装成 `id → EvidenceItem` 映射。
 *
 * 供 Server Component 直接 `await` 使用。
 *
 * @param ids       要加载的证据 id（会去重）
 * @param paperTitle 已知来源论文标题时可直接传入，省一次关联查询。
 *                   跨论文场景（如 Research Debt）请留空，让函数从关联带出
 *                   每一条各自的论文标题 —— 否则所有证据都会挂上同一个标题。
 */
export async function loadEvidenceMap(
  ids: string[],
  paperTitle?: string
): Promise<Record<string, EvidenceItem>> {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id)))
  // `in: []` 会走一次无意义的查询，直接短路
  if (unique.length === 0) return {}

  const rows = await prisma.evidenceRef.findMany({
    where: { id: { in: unique } },
    include: { paper: { select: { title: true } } },
  })

  const map: Record<string, EvidenceItem> = {}
  for (const row of rows) {
    map[row.id] = toEvidenceItem(row, paperTitle ?? row.paper?.title)
  }
  return map
}

/**
 * 从映射里按指定顺序取出证据列表。
 *
 * 缺失的 id 会被静默跳过（例如证据已被删除），
 * 调用方若要感知缺失，请自行对比长度。
 */
export function resolveEvidence(
  map: Record<string, EvidenceItem>,
  ids: string[]
): EvidenceItem[] {
  return ids
    .map((id) => map[id])
    .filter((e): e is EvidenceItem => Boolean(e))
}

/**
 * 从 JSON 字符串字段读取 evidenceIds。
 *
 * 与 `evidence.ts` 的同名函数等价 —— 那边属于服务端校验模块（带 prisma 依赖），
 * 这里放在视图工具里方便纯 UI 层引用。
 */
export function readEvidenceIds(raw: string | null | undefined): string[] {
  return parseJsonArray<string>(raw).filter((id) => typeof id === 'string')
}
