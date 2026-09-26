import type {
  BlockView,
  CrashTestView,
  DebtView,
  EvidenceView,
  IdeaView,
  PaperView,
  RelationView,
  SurgeryView,
} from '@/lib/view-models'

/**
 * 单页画布的「视图注册表」。
 *
 * 6 个视图共享同一个画布与同一套节点/连线原语，差别只在：
 *   1. 画布上放什么（layout 函数）
 *   2. 是否有数据（空态怎么显示）
 *   3. 右侧/底部面板显示什么
 *
 * 这里把「视图 → 数据可用性」的判断集中成纯函数，组件只消费结果，
 * 避免 6 个视图各写一遍空态判断而口径不一致。
 */

export interface LabData {
  projectId: string
  projectName: string
  papers: PaperView[]
  evidence: EvidenceView[]
  relations: RelationView[]
  debts: DebtView[]
  ideas: IdeaView[]
  crashTests: CrashTestView[]
  surgeries: SurgeryView[]
}

/** 6 个视图 id（顺序即工具栏从上到下的顺序） */
/**
 * ── 问题 2：`surgery` 不再是独立视图 ──
 *
 * 手术改成了「画布上的剪刀模式」：点右上角剪刀 → 光标变剪刀、
 * 节点高亮可点 → 点某个 Block 就地对它动刀，画布始终是方法 DNA 的结构图。
 * 既然不再有"手术视图"，它就不该占一个 ViewId —— 否则会出现
 * "点了剪刀但工具栏说你在手术视图"这种自相矛盾的状态。
 */
export const VIEW_IDS = [
  'dna',
  'evolution',
  'debt',
  'idea',
  'crashtest',
] as const

export type ViewId = (typeof VIEW_IDS)[number]

export interface ViewMeta {
  id: ViewId
  /** 工具栏按钮文字 */
  label: string
  /** 图标用一个汉字/单字符，避免引入图标库（产品要求禁止装饰性图标） */
  glyph: string
  /** 一句话说明这个视图回答什么问题 */
  question: string
}

export const VIEW_META: Record<ViewId, ViewMeta> = {
  dna: {
    id: 'dna',
    label: '方法 DNA',
    glyph: '结',
    question: '这篇论文的方法由哪些阶段构成？',
  },
  evolution: {
    id: 'evolution',
    label: '方法演化',
    glyph: '演',
    // 问题 3 后：演化按"问题"组织，所以这个视图回答的是
    // "多篇论文反复面对的是哪些问题、各自走到哪一步"
    question: '多篇论文反复面对的是哪些问题？每条问题走到哪一步了？',
  },
  debt: {
    id: 'debt',
    label: '研究债务',
    glyph: '债',
    /**
     * ── UI ⑤：限制结论范围 ──
     *
     * 原文案「这个领域有哪些反复出现却没人解决的问题？」是一个**过度断言**：
     * 系统只读了本项目收录的这几篇论文，凭什么说"没人解决"？可能只是
     * 我们没检索到。把系统的检视范围写进结论，才是诚实的表述。
     */
    question: '当前收录文献中，有哪些反复出现却未见解决的问题？',
  },
  idea: {
    id: 'idea',
    label: '组合想法',
    glyph: '合',
    question: '把不同论文的模块组合起来，能生成什么新方案？',
  },
  crashtest: {
    id: 'crashtest',
    label: '击穿测试',
    glyph: '试',
    question: '这些组合想法经得起推敲吗？',
  },
}

/**
 * 视图数据可用性 —— 决定画布是「画内容」还是「画空态」。
 *
 * 每条都返回「计数 + 建议动作」，UI 直接照抄文案即可，
 * 不会出现"这个视图为什么是空的、我该点什么"的困惑。
 */
export interface ViewAvailability {
  /** 是否渲染为空态 */
  empty: boolean
  /** 当前有多少条真实数据 */
  count: number
  /** 空态时中央显示的一句话 */
  emptyTitle: string
  /** 空态时的补充说明（可选） */
  emptyHint?: string
  /** 空态时的主按钮文案（可选） */
  action?: string
  /** 有数据但很少时的角落提示（可选） */
  cornerNote?: string
}

/**
 * 「有方法结构的论文」计数 —— 全项目唯一口径。
 *
 * 为什么抽成独立函数：
 *   这个数被三处消费 —— dna 视图的空态判定（本文件）、
 *   右栏 dna 徽标、以及 P7-4 工作流里「方法 DNA」步是否完成
 *   （`workflow.ts`）。如果各算各的，只要有一处写成
 *   "MethodDNA 存在"而不是"有 block"，就会出现
 *   "工具栏显示 3、工作流显示 2"这种自相矛盾。
 */
export function structuredPaperCount(data: LabData): number {
  return data.papers.filter((p) => p.blocks.length > 0).length
}

export function getAvailability(view: ViewId, data: LabData): ViewAvailability {
  switch (view) {
    case 'dna': {
      const n = structuredPaperCount(data)
      return {
        empty: n === 0,
        count: n,
        emptyTitle: '还没有任何论文被抽取出方法结构',
        emptyHint: '先上传论文并运行方法抽取。',
        action: '去上传论文',
      }
    }

    case 'evolution': {
      /**
       * ── 这里有两个不同的判断，别合并 ──
       *
       * `empty`（这个视图有没有东西可画）由 `debts.length` 决定 ——
       * 必须与 `evolutionLayout()` 的分支一致：那边是
       * `if (data.debts.length > 0) { 画问题卡片 } else { 退回时间线 }`。
       * 若这里改用别的口径，会出现"工具栏说空、画布上却有卡片"的矛盾。
       *
       * `done`（工作流这一步做完了吗）由 `workflow.ts` 的 judge() 决定，
       * 口径是"有 attempts 的债务数 > 0"—— 因为"演化"要的是叙事，
       * 光有问题没有尝试，画布上只是一排孤立卡片，谈不上演进。
       * 两者刻意不同：**画得出来 ≠ 这一步做完了**。
       * （这个视图的空态是时间线，本身是有意义的画面，所以 empty 可以为
       *  false 而 done 仍为 false 的组合不会矛盾。）
       */
      const n = data.debts.length
      return {
        empty: n === 0,
        count: n,
        emptyTitle: '尚未识别出可组织成演化脉络的问题',
        emptyHint: '方法演化按「多篇论文反复面对的问题」组织；先跑债务合成以获得问题。',
        action: '运行债务合成',
        cornerNote:
          n > 0 && data.debts.every((d) => (d.attempts?.length ?? 0) === 0)
            ? '当前问题都还没有论文尝试解决，画布上只能看到问题本身；要看到演进脉络，需要有论文给出解法。'
            : undefined,
      }
    }

    case 'debt': {
      const n = data.debts.length
      return {
        empty: n === 0,
        count: n,
        emptyTitle: '尚未识别出跨论文的研究债务',
        // UI ⑤：把"没人解决"改成有范围限定的"当前收录文献中未见解决"
        emptyHint: '研究债务是"多篇论文反复承认、但在当前收录文献中未见解决"的问题。',
        action: '运行债务合成',
        cornerNote:
          n === 1
            ? '当前仅识别到 1 条跨论文债务，可运行债务合成以补充。'
            : undefined,
      }
    }

    case 'idea': {
      const n = data.ideas.length
      const noSource = n > 0 && data.ideas.every((i) => i.fromBlockIds.length === 0)
      return {
        empty: n === 0,
        count: n,
        emptyTitle: '尚未生成组合想法',
        emptyHint: '组合想法会把不同论文的模块拼进同一条流程。',
        action: '生成组合想法',
        cornerNote: noSource ? '部分想法尚未绑定来源 Block，可重新生成组合。' : undefined,
      }
    }

    case 'crashtest': {
      const n = data.crashTests.length
      /**
       * ── 需求 B：击穿测试的空态要分两种 ──
       *
       * 想法列表搬到本视图之后，"没有击穿结果"不再只有一种原因：
       *   A. 连想法都没有 → 问题出在上一步（组合想法），必须把用户送回去，
       *      在这里点"运行击穿"是徒劳的（没有靶子可打）。
       *   B. 有想法、还没测 → 就地引导他选一个想法跑起来，别往别处送。
       * 混成一句话，A 情况的用户会在本视图反复点按钮而毫无进展。
       */
      if (data.ideas.length === 0) {
        return {
          empty: true,
          count: 0,
          emptyTitle: '还没有可击穿的想法',
          emptyHint: '击穿测试是针对「已生成的想法」做验证。请先去组合想法视图选定模块与债务，生成候选方案。',
          action: '去组合想法',
        }
      }
      return {
        empty: n === 0,
        count: n,
        emptyTitle: n === 0 ? '还没对任何想法做击穿测试' : '尚未对任何组合想法做击穿测试',
        emptyHint:
          n === 0
            ? '在上方列表中选中要验证的想法，然后点「运行击穿测试」。'
            : '击穿测试会检查新颖性、模块冲突与资源可行性。',
        action: '运行击穿测试',
      }
    }
  }
}

/** 某个视图在给定论文下是否有内容（论文切换器上用） */
export function countBlocks(blocks: BlockView[]): number {
  return blocks.length
}

/** 全项目 block 总数（右栏顶部概览用） */
export function totalBlocks(data: LabData): number {
  return data.papers.reduce((s, p) => s + p.blocks.length, 0)
}

/**
 * 底部状态条要的六个计数。
 *
 * 为什么把统计放在这里而不是组件里：
 *   这六个数是"项目当前有多少料"的口径，必须和工具栏徽标、
 *   空态判定用的是同一套数。散在组件里各算一遍，
 *   很容易出现"工具栏显示 2、状态条显示 3"这种自相矛盾。
 *
 * 注意 `papers` 项用的是论文**总数**（含未抽取结构的），
 * 而 `blocks` 是跨全部论文的 block 总数 —— 与右栏论文切换器
 * 里逐篇的 blockCount 求和一致。
 */
export interface StatusCounts {
  papers: number
  /** 有方法结构的论文数（工具栏 dna 徽标同口径） */
  structuredPapers: number
  blocks: number
  debts: number
  ideas: number
  crashTests: number
}

export function statusCounts(data: LabData): StatusCounts {
  return {
    papers: data.papers.length,
    structuredPapers: structuredPaperCount(data),
    blocks: totalBlocks(data),
    debts: data.debts.length,
    ideas: data.ideas.length,
    crashTests: data.crashTests.length,
  }
}
