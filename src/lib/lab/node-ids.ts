/**
 * 画布节点 id 的命名约定 —— 单一事实来源。
 *
 * ── 为什么要单独抽一个文件 ──
 *
 * 这些前缀原本是散落在 view-layout.ts 里的字符串字面量（`surgery-${s.id}`、
 * `block-${b.id}` …），谁生成谁自己知道，别人要解析只能照着抄一遍。
 * P7-5 之后「剪刀模式」需要**反向解析**：用户在画布上点了一个 Block，
 * 跑完手术要把选中的 id 指向 Surgery 记录（好让底部面板显示手术结论），
 * 这时是"拿 blockId 拼 surgery id"+"拿 surgery id 反查 surgeryId"，
 * 生成方和解析方分属两个文件 —— 再靠字面量抄写迟早对不上。
 *
 * 所以把前缀收敛到这里：生成、解析、比对全部走同一个常量。
 * 新增节点类型时，这里加一行，解析和生成就都不会漏。
 */

/** 方法模块（Block）节点：`block-<blockId>` */
export const BLOCK_ID_PREFIX = 'block-'

/** 手术记录节点：`surgery-<surgeryId>` */
export const SURGERY_ID_PREFIX = 'surgery-'

/** 论文根节点：`root-<paperId>`（当前 layout 用固定 'root'，保留前缀以便扩展） */
export const ROOT_ID_PREFIX = 'root-'

/** 演化关系节点：`relation-<relationId>` */
export const RELATION_ID_PREFIX = 'relation-'

/** 研究债务节点：`debt-<debtId>` */
export const DEBT_ID_PREFIX = 'debt-'

/** 候选想法节点：`idea-<ideaId>` */
export const IDEA_ID_PREFIX = 'idea-'

/** 击穿测试节点：`crash-<crashTestId>` */
export const CRASH_ID_PREFIX = 'crash-'

/** 演化时间线节点：`timeline-<paperId>` */
export const TIMELINE_ID_PREFIX = 'timeline-'

/** 拼一个节点 id。生成侧一律用它，别手写模板串。 */
export function nodeId(prefix: string, rawId: string): string {
  return `${prefix}${rawId}`
}

/** 从节点 id 里剥出原始 id；前缀不匹配时返回 null（不是这类节点）。 */
export function rawIdOf(id: string | null | undefined, prefix: string): string | null {
  if (!id || !id.startsWith(prefix)) return null
  return id.slice(prefix.length)
}
