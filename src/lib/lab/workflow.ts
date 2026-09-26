import {
  VIEW_IDS,
  VIEW_META,
  structuredPaperCount,
  type LabData,
  type ViewId,
} from '@/lib/lab/views'

/**
 * P7-4「工作流串联」的**唯一事实源**。
 *
 * 为什么需要这个文件：
 *   单页画布有 6 个视图，但它们本来是 6 个平级功能 ——
 *   用户看不出"先做哪个、做到哪了"。这个文件把 7 个流程步骤
 *   （比视图多一个「论文」）的**顺序、状态、判定**集中成纯函数，
 *   让顶部导航条、右侧工具栏、底部状态条三处消费**同一套口径**，
 *   不会出现"导航条说完成了、右栏说未开始"这种自相矛盾。
 *
 * ── 两个容易搞混的概念，这里划清 ──
 *
 *   1. **视图（ViewId，6 个）**：画布当前画什么。没有「论文」视图。
 *   2. **工作流步骤（WorkflowStepId，7 个）**：流程上的位置，第 1 步是「论文」。
 *
 *   所以 WorkflowStepId **不是** ViewId 的超集，必须独立定义，
 *   并用 viewOfStep / stepIdOfView 做双向映射。
 *
 *   3. **方法阶段（METHOD_STAGE，7 个）**：论文方法内部的阶段
 *      （问题/输入/核心方法…）。与工作流步骤**完全无关**，别混。
 */
/**
 * ── 问题 2：`surgery` 已从工作流步骤中移除 ──
 *
 * 为什么删掉而不是保留：
 *   手术被改造成「画布上的剪刀模式」——它是一个**画布内的操作动作**，
 *   不是一个"进去看一个视图"的流程站点。它既没有独立的画布视图
 *   （点了剪刀还是停在方法 DNA 的结构图上），也不该在导航条里
 *   占一个"第 3 步"的位置。
 *   原来把它当步骤会带来两个具体问题：
 *     ① 用户点「方法手术」进去，看到的是同一张结构图 + 一段术语详情，
 *        并不知道"我该干什么"（产品原话：看不懂）；
 *     ② 导航条上它永远显示"未完成"，因为很多人根本不会去点它，
 *        于是"建议下一步"长期卡在手术这一格，形成死循环。
 */
export const WORKFLOW_STEP_IDS = [
  'paper',
  'dna',
  'evolution',
  'debt',
  'idea',
  'crashtest',
] as const

export type WorkflowStepId = (typeof WORKFLOW_STEP_IDS)[number]

/**
 * 步骤状态。
 *   done    ✓ 已完成（数据库里有真实数据）
 *   current ● 当前（正在看这个视图）
 *   todo    ○ 未开始（数据库无数据，且不是当前视图）
 */
export type StepState = 'done' | 'current' | 'todo'

export interface WorkflowStep {
  id: WorkflowStepId
  /** 显示名。paper 单独给，其余沿用 VIEW_META.label */
  label: string
  /** 单字字形。paper 用「文」，其余沿用 VIEW_META.glyph */
  glyph: string
  /** 对应视图；「论文」不是视图 → null */
  view: ViewId | null
  /** 右侧工具栏编号：dna=1 … crashtest=6；「论文」不在右栏显示 → null */
  stepNo: number | null
  /** 数据判定：这一步做过了吗 */
  done: boolean
  /** 展示用计数（paper=论文总数，dna=有结构的论文数，其余=对应记录数） */
  count: number
}

export interface Workflow {
  steps: WorkflowStep[]
  /** 已完成步数（0~7） */
  doneCount: number
  total: number
  /**
   * ★ 当前视图所在的步骤。
   * 恒为 6 个视图之一 —— 「论文」**永远不是** ★，
   * 因为用户不可能"停在论文步"（它不是视图）。
   */
  currentStepId: WorkflowStepId
  /**
   * → 建议下一步：**第一个未完成**的步骤。
   * 全部完成时为 null（导航条不画 →）。
   */
  nextStepId: WorkflowStepId | null
  /** 当前步骤序号（1~7），状态条展示用 */
  currentNo: number
}

/** 视图 → 步骤。6 个视图与步骤同名，直通即可 */
export function stepIdOfView(view: ViewId): WorkflowStepId {
  return view
}

/** 步骤 → 视图。「论文」返回 null */
export function viewOfStep(id: WorkflowStepId): ViewId | null {
  return id === 'paper' ? null : id
}

/**
 * 右侧工具栏编号。
 *
 * 为什么 dna = 第 1 步（而不是对齐导航条的第 2 步）：
 *   右栏**从不显示**「论文」项，所以它天然是 1~6 的连续编号。
 *   若给 DNA 编"第 2 步"，用户会同时在屏上看到
 *   "导航条 DNA=2 / 右栏 DNA=1" 两套编号 —— 那是错误信息。
 *   右栏的 1~6 表达的是"视图在流程里的次序"，与导航条不并列对比。
 */
export function stepNoOfView(view: ViewId): number {
  return VIEW_IDS.indexOf(view) + 1
}

/**
 * 数据判定表 —— 全部基于已有的 LabData，不新增任何查询。
 *
 * `dna` 一项刻意复用 `structuredPaperCount`（而非判断 MethodDNA 是否存在），
 * 与 `getAvailability('dna')` 保持**同一口径**：有 block 才算抽出了结构。
 *
 * ── U3 修复：evolution 与 debt 不能共用 debts.length（顺序倒置的根因）──
 *
 * 旧实现两行完全相同：
 *     evolution: { done: data.debts.length > 0, count: data.debts.length },
 *     debt:      { done: data.debts.length > 0, count: data.debts.length },
 *
 * 后果不是"看起来重复"，而是**建议下一步永远跳过 evolution**：
 * `suggestNext()` 取第一个未完成步，而 evolution 排在 debt 前面。
 * 没有债务时两者都是 ○，建议正确指向 evolution；
 * 但**一旦债务合成完成**，`debts.length > 0` 让两者同时变 ✓，
 * evolution 就再也不会被建议了 —— 用户被直接推去「研究债务」，
 * 而"演化"这一步实际上从未被引导过。这就是用户说的顺序倒置。
 *
 * ── 那么 evolution 的完成判据应该是什么 ──
 *
 * 两个视图虽然读同一份 debts，但**讲的是不同的事**（见 view-layout.ts）：
 *   · debt 视图     = 「有哪些跨论文问题」（识别层面）
 *   · evolution 视图 = 「每条问题在论文之间怎么演进的」（叙事层面）
 *
 * 演化叙事要成立，光有"谁提出了这个问题"不够 —— 必须有
 * **attempts（谁尝试解决过、结果如何）**，否则画布上只有一排孤立的
 * 问题卡片，谈不上"演进"（evolutionLayout 的卡片副标题就是
 * buildEvolutionSubtitle，它渲染的正是 N 篇论文 / 状态 / 尝试数）。
 *
 * 所以判据定为：**至少一条债务带有 attempts**。
 * 这样三步之间才有真实的先后递进：
 *     债务识别（debt）→ 尝试收集（attempts 落库）→ 演化叙事（evolution）
 * 且不会出现"debt 已完成但 evolution 未开始"以外的组合 ——
 * 若连债务都没有，两步都未完成，建议仍正确指向 debt 之前的 evolution
 * （此时 evolution 的空态就是时间线，是有意义的画面）。
 *
 * 计数口径同步改为"有尝试的债务数"，避免导航条显示"1"却画不出演进。
 */
function judge(data: LabData): Record<WorkflowStepId, { done: boolean; count: number }> {
  /**
   * 能撑起"演化脉络"的债务 = 有 attempts 的债务。
   * 用 `some` 判完成、用 `filter().length` 做计数，两者同一口径。
   */
  const narratable = data.debts.filter((d) => (d.attempts?.length ?? 0) > 0).length

  return {
    paper: { done: data.papers.length > 0, count: data.papers.length },
    dna: { done: structuredPaperCount(data) > 0, count: structuredPaperCount(data) },
    evolution: { done: narratable > 0, count: narratable },
    debt: { done: data.debts.length > 0, count: data.debts.length },
    idea: { done: data.ideas.length > 0, count: data.ideas.length },
    crashtest: { done: data.crashTests.length > 0, count: data.crashTests.length },
  }
}

/**
 * 建议下一步 = **第一个未完成**的步骤。
 *
 * 为什么不是"当前步的邻居"：
 *   「建议下一步」要回答的是"整个流程卡在哪"，
 *   而不是"在当前视图旁边该去哪"。
 *   若按邻居算，用户停在已完成的债务视图会看到 → 指向想法，
 *   但真正卡住的是更早的手术 —— 补上手术才是推进流程。
 *   首个未完成 = 最小可推进缺口，语义唯一、可断言。
 */
function suggestNext(steps: WorkflowStep[]): WorkflowStepId | null {
  const firstTodo = steps.find((s) => !s.done)
  return firstTodo ? firstTodo.id : null
}

export function buildWorkflow(data: LabData, view: ViewId): Workflow {
  const j = judge(data)

  const steps: WorkflowStep[] = WORKFLOW_STEP_IDS.map((id) => ({
    id,
    label: id === 'paper' ? '论文' : VIEW_META[id].label,
    glyph: id === 'paper' ? '文' : VIEW_META[id].glyph,
    view: viewOfStep(id),
    stepNo: id === 'paper' ? null : stepNoOfView(id),
    done: j[id].done,
    count: j[id].count,
  }))

  const currentStepId = stepIdOfView(view)

  return {
    steps,
    doneCount: steps.filter((s) => s.done).length,
    total: steps.length,
    currentStepId,
    nextStepId: suggestNext(steps),
    currentNo: WORKFLOW_STEP_IDS.indexOf(currentStepId) + 1,
  }
}

/**
 * 单步的状态与角色标记 —— 供 WorkflowBar / RightToolbar 共用，
 * 保证两处对"这一步是什么状态"完全一致。
 *
 * 渲染互斥规则（每格最多 2 个符号）：
 *   1. 当前步        → 状态固定 `●`，角色槽 `★`；若同时是建议步，★ 吃掉 →
 *   2. 建议步（非当前）→ 状态按数据 `✓/○`，角色槽 `→`
 *   3. 其余          → 状态按数据 `✓/○`，角色槽空
 */
export interface StepMark {
  state: StepState
  /** 状态符号：✓ / ● / ○ */
  stateSymbol: string
  /** 角色标记：★（当前）/ →（建议）/ ''（无） */
  roleSymbol: string
  /** 中文状态文案（右栏用） */
  stateText: string
}

export function stepMark(step: WorkflowStep, workflow: Workflow): StepMark {
  const isCurrent = step.id === workflow.currentStepId
  const isSuggested = step.id === workflow.nextStepId

  if (isCurrent) {
    return {
      state: 'current',
      stateSymbol: '●',
      // 当前即建议时不重复强调，★ 优先
      roleSymbol: '★',
      stateText: '当前',
    }
  }
  if (step.done) {
    return {
      state: 'done',
      stateSymbol: '✓',
      roleSymbol: isSuggested ? '→' : '',
      stateText: '已完成',
    }
  }
  return {
    state: 'todo',
    stateSymbol: '○',
    roleSymbol: isSuggested ? '→' : '',
    stateText: '未开始',
  }
}
