import type { ViewId } from '@/lib/lab/views'

/**
 * P14 —— 功能区域注册表：分区动画与分区交互锁的唯一口径。
 *
 * ── 为什么需要它 ──
 *
 * 旧版是「全局一把锁」：`useActionFeedback` 的单一 pending 分发全站，
 * 任一区域跑动作，所有区域的按钮一起禁用、一起呼吸 —— 用户分不清
 * "哪个区域在动"，也被迫陪跑与自己无关的等待。
 *
 * P14 把锁拆到区域粒度：一个区域忙只锁自己，其他区域照常可用。
 * 这份类型就是"区域"这个词在代码里的唯一定义，消费方（锁、色带、
 * 验收脚本）都从这里拿口径，避免各写各的字符串。
 *
 * ── 各区域的锁语义 ──
 *
 *   dna        方法 DNA 画布。节点选中/缩放是纯前端交互，没有异步动作，
 *              因此没有"忙"态 —— 它的可点击性由视图切换（key remount）
 *              与手术模式的进入条件控制，不走动作锁。
 *   surgery    手术模式（DNA 画布上的剪刀模式）：摘除/恢复/分析。
 *   evolution  方法演化：面板里的"运行债务合成/演化关系"动作。
 *   debt       研究债务：与 evolution 共用同一条 debtAction 链路，
 *              锁也共用（同一时刻只有一个合成在跑，互锁是数据一致性要求）。
 *   idea       组合想法：生成组合 + 手动输入想法（两条链路同区互锁——
 *              它们写同一张 CandidateIdea 表，并发落库会让计数口径混乱）。
 *   crashtest  击穿测试：运行击穿 + 面板动作；对比维度选择器（compare）
 *              是纯前端计算、无异步动作，随本区锁，不单列。
 *   chat       AI 对话 dock：历来有独立的 chatSending 锁（P12 起），
 *              P14 只是把它的失败反馈也归入本区。
 *   global     导航类动作：论文切换 / PDF 上传 / 两级重置 / 确认框。
 *              这些动作影响全站数据（换论文 = 换数据集），进行中必须
 *              全站锁定 —— 这是唯一保留"全局锁"语义的区域。
 */
export type LabZone =
  | 'dna'
  | 'surgery'
  | 'evolution'
  | 'debt'
  | 'idea'
  | 'crashtest'
  | 'chat'
  | 'global'

/** 全部区域 id（验收脚本与色带渲染按此遍历；顺序即声明顺序，无语义） */
export const LAB_ZONES: readonly LabZone[] = [
  'dna',
  'surgery',
  'evolution',
  'debt',
  'idea',
  'crashtest',
  'chat',
  'global',
] as const

/**
 * 视图 → 默认动作区域。
 *
 * BottomPanel 的面板动作按钮、空态引导按钮发生在"某个视图"里，
 * 它们该锁哪个区域由当前视图查这张表决定，而不是各写一份 if/else。
 *
 * 注意 debt → evolution：两者共用 debtAction 链（详见 LabZone 注释），
 * 锁口径必须一致，否则"债务视图跑合成、演化视图还能再点一次"。
 */
export const ZONE_BY_VIEW: Record<ViewId, LabZone> = {
  dna: 'dna',
  evolution: 'evolution',
  debt: 'evolution',
  idea: 'idea',
  crashtest: 'crashtest',
}
