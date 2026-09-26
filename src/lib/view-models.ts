/**
 * 跨组件共享的视图模型类型。
 *
 * 这些类型原先散落在各个组件文件里（例如 BlockView 定义在 MethodBlockGrid.tsx，
 * SurgeryWorkbench.tsx 里另有一个同名字段不同的副本），导致删除组件时会连带
 * 断掉别处的编译。
 *
 * P7 UI 重构（单页画布）把类型集中到这里，让组件可以自由废弃而不影响数据契约。
 */

/**
 * 方法模块的视图模型 —— 由 prisma.methodBlock 映射而来。
 *
 * 字段与 MethodBlock 模型对齐：stage / order 是 P7-0 新增的结构表达字段，
 * 结构图按 stage 分列、按 order 列内排序。
 */
export interface BlockView {
  id: string
  name: string
  type: string
  description: string
  role: string
  /** 所属方法阶段（P7-0 新增）—— 结构图按它分组 */
  stage: string
  /** 阶段内顺序（P7-0 新增）—— 结构图按它排序 */
  order: number
  evidenceIds: string[]
  evidenceStatus: string
}

// ─────────────────────────────────────────────────────────────
// 单页画布的 6 个视图所需的视图模型
// ─────────────────────────────────────────────────────────────

/** 证据引用（底部面板点击证据时查看） */
export interface EvidenceView {
  id: string
  paperId: string
  paperTitle: string
  /** PAPER_FACT | LLM_SYNTHESIS | LLM_INFERENCE */
  source: string
  status: string
  /** schema 可空 */
  quote: string | null
  section: string | null
  pageNumber: number | null
  confidence: number
  summary: string | null
}

export interface PaperView {
  id: string
  title: string
  status: string
  /**
   * 论文摘要（schema 可空）。
   *
   * 供 DNA 视图默认选中根节点时，在底部面板里展开"论文摘要 + 7 阶段浏览"。
   * 数据本来就在 Paper 行里，RSC 聚合查询顺带带出，不新增查询。
   */
  abstract: string
  /**
   * ── P10 问题 3：抽取时标注的"未覆盖说明" ──
   *
   * 模型对"某个阶段原文没写 / 证据不足"的自述，直接来自 MethodDNA.uncertainties。
   * 用途：结构图上只画有 block 的阶段（拍板 1 选 A，不做灰框占位），
   * 于是"为什么少了某个阶段"这件事必须有个出口 —— 就在面板里列出来，
   * 让用户能区分「论文真没写」和「我们没抽好」。
   *
   * 数据本来就在 MethodDNA 行里（RSC 已 include），不新增查询。
   */
  uncertainties: string[]
  /**
   * ── UI ③：演化时间线要按年份排布 ──
   *
   * 演化视图要画一条横向时间轴（2013 → 2022 → 2024 …）并把论文卡片挂上去。
   * 时间轴必须有年份才有意义，所以把 Paper.year 带进视图层。
   * 可空：早年上传的数据 / 模型没能识别出年份时为 null，
   * 视图侧用「年份未知」兜底，而不是编一个年份。
   */
  year: number | null
  blocks: BlockView[]
}

/** 方法演化关系 */
export interface RelationView {
  id: string
  sourcePaperId: string
  targetPaperId: string
  type: string
  reason: string
  confidence: number
  evidenceIds: string[]
  evidenceStatus: string
}

export interface DebtSourceView {
  id: string
  paperId: string
  paperTitle: string
  context: string
  evidenceIds: string[]
  /**
   * 这段 context 的来源：`mock`（本地启发式拼的英文原句）
   * 还是真实模型名（本就是中文归纳）。
   *
   * panel 据此决定要不要过规则归纳 —— 见 en-summary 的 `summarizeBySource`。
   * 空串表示历史数据（本字段引入前写入的），按 mock 处理最安全：
   * 老数据确实全是 mock 路径产生的。
   */
  provider: string
}

export interface AttemptView {
  id: string
  paperId: string
  /**
   * 尝试该方案的论文标题。
   *
   * 为什么要在视图层冗余这一个字段：问题 3 的演化详情要按
   * 「每篇论文怎么处理这个问题」逐条列出，标题是那一行的主语。
   * Attempt 只有 paperId，如果每次渲染都回查 papers 数组，
   * 调用方（panel.ts）就得自己建索引并处理"论文已删"的兜底 ——
   * 在数据组装处一次性带上，读侧永远是纯展示。
   */
  paperTitle: string
  description: string
  outcome: string
  /** 数据来源，语义同 DebtSourceView.provider */
  provider: string
}

/** 研究债务 */
export interface DebtView {
  id: string
  title: string
  description: string
  category: string
  currentStatus: string
  occurrenceCount: number
  evidenceIds: string[]
  evidenceStatus: string
  sources: DebtSourceView[]
  attempts: AttemptView[]
}

/** 击穿测试的单条检查 */
export interface CrashCheckView {
  key: string
  label: string
  finding: string
  level: string
  detail: string
  /**
   * 模型针对这一项给出的**具体改法**（P10 Step2 新增）。
   *
   * 空串表示模型没给（这一项通过、或历史数据）。
   * `crash-summary.ts` 会按「模型给的 → 静态表 → 兜底文案」三级回落，
   * 所以这里**不能**在解析时替模型补默认值 —— 一补就分不清
   * "模型真的给了这条改法"和"我们替它填的"，回落逻辑也就失去意义。
   */
  suggestion?: string
  /**
   * 这一项的**全部**发现（第 1 条已展开到 finding/detail）。
   *
   * 为什么要保留全部：原实现只取了 `arr[0]`，模型为某一项给出
   * 多条发现时，其余被静默丢弃 —— 用户看到的"检查结论"其实只是
   * 第一条，容易误判这一项只查到一件事。问题 5 重做面板时，
   * 第二段（关键影响 / 补充发现）需要完整数据，所以这里全量带上。
   */
  allFindings?: Array<{ finding: string; level: string; detail: string }>
}

export interface CrashTestView {
  id: string
  /** 关联的想法 id —— 独立使用（击穿测试视图）时必需 */
  ideaId?: string
  /** 关联想法标题 —— 独立使用时可带上，方便卡片显示 */
  ideaTitle?: string
  overallVerdict: string
  checks: CrashCheckView[]
  experimentalDesign: string
  findings: string
  evidenceStatus: string
  /**
   * 致命弱点 —— 来自 findings JSON 的 fatalFlaws。
   *
   * 卡片上"6 个检查项状态行"的第 6 格用它：有致命弱点 → ✗，
   * 没有 → ✓。这是真实字段，不是为凑数编的第 6 个检查。
   */
  fatalFlaws: string[]
  /**
   * 是否由演示模式（mock）写入。
   *
   * 问题 5 要求"mock 模式也给诚实判定" —— 判定逻辑必须先能**可靠地**
   * 知道这是不是 mock，否则会把启发式结论当成真实模型的结论呈现。
   * 这里从 findings JSON 里带出来（新版本会写），文案侧再兜底一次。
   */
  isMockMode?: boolean
  /**
   * 模型给出的"继续做需要满足的条件" —— 即修改建议的权威来源。
   * 没有时由 crash-summary 用按检查项的模板补齐。
   */
  conditionsToProceed?: string[]
  /** 模型的总体判定理由（findings JSON 里的 verdictReason） */
  verdictReason?: string
}

/** 组合想法 */
export interface IdeaView {
  id: string
  title: string
  description: string
  fromBlockIds: string[]
  evidenceIds: string[]
  evidenceStatus: string
  debtIds: string[]
  /**
   * 一句话机制 —— 为什么这个组合能解决它回应的那条债务。
   *
   * 来源：CandidateIdeaDebt.why（模型在生成时必须给出的理由，
   * 说不出 why 的候选会在服务端被直接丢掉）。
   * 问题 4 要求 Idea 卡片显示「来自哪些 Block + 目标债务 + 一句话机制」，
   * 这个字段就是那"一句话机制"。多条债务时取第一条（卡片放不下更多）。
   */
  mechanism?: string
  /**
   * ── P11 问题 3 ──
   * 来源方法标签 —— 该想法由哪些论文的模块组合而来（「来自 A + B」）。
   * 击穿测试的"已生成想法"列表用它区分同批/跨批的想法：
   * 列表项 = 标题 + 来源方法，用户能一眼看出第几次生成产出了什么。
   */
  sourceLabel?: string
  crashTest: CrashTestView | null
}

/** 方法手术 */
export interface SurgeryView {
  id: string
  methodId: string
  title: string
  description: string
  /** schema 可空 */
  result: string | null
  verdict: string | null
  evidenceIds: string[]
  evidenceStatus: string
  /** 被干预的 block id —— 结构图上标红 */
  intervenedBlockIds: string[]
}
