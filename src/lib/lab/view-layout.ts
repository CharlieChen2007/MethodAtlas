import {
  CARD_GAP,
  CARD_H,
  CARD_W,
  type CardSpec,
  type LayoutEdge,
  type LayoutResult,
  type ListRow,
  layoutCards,
  layoutStructure,
  NODE_H,
} from '@/lib/lab/layout'
import type { ViewId, LabData } from '@/lib/lab/views'
import type { SurgeryView } from '@/lib/view-models'
import { EVIDENCE_STATUS_LABEL } from '@/lib/enums'
import {
  CARD_TONE_COLOR,
  toneForEvidence,
  toneForOverall,
  toneForProblemStatus,
  toneForVerdict,
} from '@/lib/lab/palette'
import { nodeId, SURGERY_ID_PREFIX } from '@/lib/lab/node-ids'
import { buildCrashConclusion } from '@/lib/lab/crash-summary'
import {
  buildEvolutionSubtitle,
  deriveProblemStatus,
  summarizeProblem,
} from '@/lib/lab/problem-status'

/**
 * 视图 → 画布布局 的唯一入口。
 *
 * ── 本轮（P7-3）的关键改动 ──
 *
 * 原先 `buildViewLayout` 第一行就是 `if (avail.empty) return layoutEmpty(...)`，
 * 于是 5 个空视图（手术/演化/债务/想法/击穿）在"还没跑过 pipeline"时
 * 画布上只有一句话 —— 用户看到的是一个空白页，看不出"这里将来长什么样"。
 *
 * 现在改成：**空态也要有画布主体**。
 *   - 有数据 → 真实卡片（带该视图的特征块：时间线、三行、检查项行…）
 *   - 无数据 → 同一套特征块，但内容是"从真实数据里能算出来的那部分"
 *     （例如演化视图空态仍然画出 4 篇论文的时间线，只是连线是虚线、
 *       标签是"关系待建立"）
 *
 * 两类状态**复用同一套 CardSpec 构造器**，所以不会出现
 * "有数据时好看、空态时糊弄"的两套版式。空态唯一特殊之处是：
 *   - 卡片不带 refId（点了不开面板，因为没有详情可开）
 *   - 卡片 tone 统一为 'default'（没有结论可表达）
 *   - 额外在 LayoutResult 上带 emptyTitle/emptyHint，画布把它渲染成
 *     一个**缩小并下沉**的提示块（不再是占据画布中央的 320px 大卡）
 */

export function buildViewLayout(
  view: ViewId,
  data: LabData,
  paperId: string
): LayoutResult {
  switch (view) {
    // ── 方法 DNA：结构树 ──
    case 'dna': {
      const paper = data.papers.find((p) => p.id === paperId) ?? data.papers[0]
      if (!paper || paper.blocks.length === 0) {
        return layoutSubject(
          '这篇论文还没有方法结构',
          '换一篇论文，或先运行方法抽取。',
          // 空态仍然画出"7 个阶段列"的骨架 —— 让用户看到结构图的形状
          structureSkeleton(paper?.title ?? '（论文）', paper?.id)
        )
      }
      return layoutStructure(paper.title, paper.blocks, {
        intervenedBlockIds: intervenedBlockIdsOf(data),
        // 带上 id —— 面板按 id 精确反查论文，避免同标题歧义（P10 问题 3）
        paperId: paper.id,
      })
    }

    // ── 方法演化：论文时间线 ──
    case 'evolution': {
      return evolutionLayout(data)
    }

    // ── 研究债务：宽卡 + 三行结构 ──
    case 'debt': {
      return debtLayout(data)
    }

    // ── 组合想法：紧间距 + A + B × Debt 小图 ──
    case 'idea': {
      return ideaLayout(data)
    }

    // ── 击穿测试：检查项状态行 ──
    case 'crashtest': {
      return crashLayout(data)
    }
  }
}

/** 项目内所有被手术干预过的 block id —— 结构图上标红 */
export function intervenedBlockIdsOf(data: LabData): string[] {
  return Array.from(new Set(data.surgeries.flatMap((s) => s.intervenedBlockIds)))
}

/**
 * ── 问题 4：某个 block 当前是「已摘除」还是「已恢复」？──
 *
 * 手术模式改成"点两次切换"之后，点击前必须先知道这个模块**现在是什么状态**，
 * 才能决定这一下是摘除还是恢复。而"现在是什么状态"的唯一权威来源是
 * **库里最新的 Surgery 记录** —— 前端不维护自己的本地开关。
 *
 * 为什么以库为准而不是本地 state：
 *   手术会写库、会被别处（比如撤销按钮、别的标签页）改掉，前端本地记一份
 *   迟早和库不一致，用户就会看到"点一下没反应"或者"状态反了"。
 *   每次点击都从 data.surgeries 现算，是最不容易错的做法。
 *
 * 为什么取"最后一条包含该 block 的记录"：
 *   surgeries 按查询顺序（时间倒序的近似）给出；倒序找第一条命中的，
 *   就是该 block 最近一次被手术的状态。删记录 = 恢复（见 undo 流程），
 *   所以"最近一次记录存在"就等于"当前处于已摘除"。
 */
export function latestSurgeryForBlock(
  data: LabData,
  blockId: string
): SurgeryView | null {
  for (let i = data.surgeries.length - 1; i >= 0; i--) {
    const s = data.surgeries[i]
    if (s.intervenedBlockIds.includes(blockId)) return s
  }
  return null
}

/** 该 block 是否处于「已摘除」状态（有最新的手术记录即为真） */
export function isBlockRemoved(data: LabData, blockId: string): boolean {
  return latestSurgeryForBlock(data, blockId) !== null
}

// ─────────────────────────────────────────────────────────────
// 各视图的布局（空态 / 有数据 共用同一套卡片构造）
// ─────────────────────────────────────────────────────────────

/**
 * 方法手术。
 *
 * 主体 = 「半透明的方法结构预览」+「靶标提示」。
 *
 * 为什么空态要画结构预览：手术的语义是"在方法结构上动刀"。
 * 如果空态只写一句"尚未做过方法手术"，用户不知道刀该往哪落。
 * 把当前论文的结构树用**低对比度**再画一遍（灰底、无阶段色条），
 * 上面压一行"点击 Block 开始手术"，用户立刻明白这个视图在干什么、
 * 以及第一步该点哪里。
 */
function surgeryLayout(data: LabData): LayoutResult {
  const cards: CardSpec[] = data.surgeries.map((s) => ({
    id: nodeId(SURGERY_ID_PREFIX, s.id),
    label: `方法手术 · ${verdictLabel(s.verdict ?? '')}`,
    title: s.title,
    excerpt: s.description,
    tone: toneForVerdict(s.verdict ?? ''),
    footnote: s.intervenedBlockIds.length
      ? `干预 ${s.intervenedBlockIds.length} 个模块`
      : undefined,
    refId: s.id,
  }))

  if (cards.length > 0) {
    // 有数据：卡片列，间距比默认更紧（手术记录通常成组出现）
    return layoutCards(cards, { gap: 18 })
  }

  // 空态：画结构预览 + 靶标提示
  return surgeryEmptyPreview(data)
}

/**
 * 手术空态 —— 用当前论文的真实结构画一张"待动刀"的预览。
 *
 * 实现方式：调 `layoutStructure` 拿到真实坐标，然后把每个节点标记成
 * `preview: true`（渲染层据此降饱和度、去掉阶段色条），
 * 再在最上方压一条靶标提示。
 *
 * 为什么复用 layoutStructure 而不是另画一张示意图：
 *   示意图会随结构数据变化而与真实结构脱节（用户"看到的是假的"）。
 *   复用同一个布局函数，空态预览与手术后的真实结构**逐像素一致**，
 *   差别只在配色 —— 这是"预览"该有的诚实。
 */
function surgeryEmptyPreview(data: LabData): LayoutResult {
  const paper = data.papers.find((p) => p.blocks.length > 0) ?? data.papers[0]
  if (!paper || paper.blocks.length === 0) {
    return layoutSubject(
      '尚未做过方法手术',
      '方法手术会拿掉或替换某个模块，观察结构是否还成立。先让至少一篇论文有方法结构。',
      structureSkeleton(paper?.title ?? '（论文）', paper?.id)
    )
  }

  const base = layoutStructure(paper.title, paper.blocks, { paperId: paper.id })
  const nodes = base.nodes.map((n) => ({ ...n, preview: true }))

  return {
    ...base,
    nodes,
    emptyTitle: '尚未做过方法手术',
    emptyHint: '点击画布上任意一个 Block，即可对它开始第一次手术。',
    emptyAction: '运行方法手术',
  }
}

/**
 * 方法演化 —— 论文横向时间线 + 虚线连接。
 *
 * 空态与有数据共用同一条时间线；差别只在连线的样式：
 *   有数据 → 实线（真实关系）
 *   空态   → 虚线 + 标签「关系待建立」（还说不出关系，但论文确实存在）
 *
 * 为什么空态要画真实论文而不是占位框：
 *   演化需要"至少两篇论文"这个前提。空态把当前项目里**真实存在的
 *   论文**排成时间线，用户看到的是"我这 4 篇论文还没连起来"，
 *   而不是"这个功能没数据"—— 前者是可以行动的信息。
 */
function evolutionLayout(data: LabData): LayoutResult {
  /**
   * ── UI ③：横向时间线按**年份**排布 ──
   *
   * 旧实现按"论文创建顺序"排（createdAt asc）。问题：创建顺序是
   * **上传先后**，与论文本身的年代无关 —— 用户先传了 2024 年的论文、
   * 再传 2013 年的，时间线上就会出现"2024 在左、2013 在右"的倒挂，
   * 一眼就是错的。
   *
   * 现在：有年份的按年份升序，没年份的排在最后（不编造年份、不丢弃）。
   * 同一年内保持原有的相对顺序（稳定排序）。
   */
  const ordered = [...data.papers].sort((a, b) => {
    const ay = a.year ?? Number.POSITIVE_INFINITY
    const by = b.year ?? Number.POSITIVE_INFINITY
    return ay - by
  })

  // 时间线：按年份排布，footnote 显示年份（无年份则如实标"年份未知"）
  const timeline: CardSpec[] = ordered.map((p, i) => ({
    id: `timeline-${p.id}`,
    label: '论文',
    title: p.title,
    excerpt: `${p.blocks.length} 个方法模块`,
    tone: 'default',
    footnote: p.year ? `${p.year} 年` : '年份未知',
  }))

  /**
   * ── UI ③：时间轴刻度 ──
   *
   * 每条刻度对齐它对应的论文卡片中心（x + w/2）。
   * 为什么刻度挂在卡片中心而不是等距分布：
   *   这是一条"论文的时间线"，刻度与论文一一对应才有意义 ——
   *   等距会让用户以为刻度是均匀年份（2013/2018/2023 那种），
   *   而实际数据往往集中在两年，等距会给出错误的时间感。
   */
  const buildAxis = (): LayoutResult['timeline'] => {
    if (ordered.length < 2) return undefined
    // 卡片布局：与下方 layoutCards 相同的列宽/间距，保证刻度对齐
    const cardW = 240
    const gap = 18
    return ordered.map((p, i) => ({
      year: p.year ? String(p.year) : '年份未知',
      x: i * (cardW + gap) + cardW / 2,
      anchorId: `timeline-${p.id}`,
    }))
  }

  /**
   * ── 问题 3：方法演化改成「按问题组织」──
   *
   * 原来这里渲染的是 Relation 卡片，标题形如「论文A → 论文B」——
   * 那是**抽象关系**，用户看到一条箭头并不知道"这两篇之间到底演化出了什么"。
   *
   * 产品要求改成按**问题**聚合：
   *   卡片标题 = 问题名（ResearchDebt.title）
   *   副标题   = 多篇论文在这条问题上的演进脉络（N 篇论文 · 状态）
   *   详情     = 问题是什么 → 每篇怎么处理 → 状态 → 证据
   *
   * 为什么"问题"取 ResearchDebt 而不是 Relation：
   *   ResearchDebt 天然就是"跨论文反复出现、尚未解决"的问题（occurrenceCount≥2），
   *   它本身带 sources（哪些论文提到）与 attempts（谁尝试过、结果如何）——
   *   这正是"演进"要讲的三件事。而 Relation 只有两篇论文间的抽象继承关系，
   *   回答不了"这条问题现在进展到哪一步"。
   *
   * 空态时退回时间线（沿用原行为）：没有债务就没法按问题组织，
   * 此时展示"有哪些论文"是唯一有意义的内容。
   */
  if (data.debts.length > 0) {
    const cards: CardSpec[] = data.debts.map((d) => {
      const info = deriveProblemStatus(d)
      return {
        id: `problem-${d.id}`,
        label: `问题 · ${categoryLabel(d.category)}`,
        title: d.title,
        /**
         * ── 问题 5：卡片摘要改成「一句话提炼」──
         *
         * 原来直接放 `d.description` —— 那是一整段原文，卡片被撑成一面文字墙，
         * 用户必须逐字读完才知道这条问题是什么。现在用 `summarizeProblem`
         * 取第一句完整的话，控制在 60 字内。
         * 完整描述仍在面板里（problemPanel 第一节），想深读点卡片即可。
         */
        excerpt: summarizeProblem(d),
        tone: statusTone(info.status),
        footnote: buildEvolutionSubtitle(d),
        refId: d.id,
        // 复用债务卡片的"涉及论文"行：这里它承担"演进脉络"的角色
        papers: d.sources.map((s) => s.paperTitle),
      }
    })
    return {
      ...withTimeline(layoutCards(cards, { gap: 18 }), timeline, false),
      // UI ③：有数据时同样画出年份刻度轴
      timeline: buildAxis(),
    }
  }

  // 空态：时间线卡片 + 虚线连 + 「关系待建立」
  const empty = layoutCards(timeline, { gap: 18 })
  const decorated = withTimeline(empty, timeline, true)
  return {
    ...decorated,
    timeline: buildAxis(),
    emptyTitle: '尚未识别出可组织成演化脉络的问题',
    emptyHint: '方法演化按「多篇论文反复面对的问题」组织；先跑债务合成以获得问题。',
    emptyAction: '运行债务合成',
  }
}

/**
 * 问题状态 → 卡片色调。
 *
 * ── P19 细节 3：四档四色，别再合并 ──
 *
 * 旧实现把 points_out 与 open 都返回 'bad'，于是「指出问题」和「未解决」
 * 在卡片上是同一个红 —— 而 UI 上写的是两个不同的结论（"还没人跳" vs
 * "跳了但摔了"）。更糟的是三档映射四档容易在调用点取错档，直接表现为
 * 用户看到的 bug：**文案说"部分解决"、色条却是绿的**。
 *
 * 现在映射收敛到 palette 的 toneForProblemStatus（唯一来源）：
 *   已解决 → 绿   部分解决 → 橙   未解决 → 红   指出问题 → 灰
 */
function statusTone(
  s: 'solved' | 'partial' | 'open' | 'points_out'
): 'good' | 'warn' | 'bad' | 'unknown' {
  return toneForProblemStatus(s)
}

/** 给卡片结果补上"时间线感"：卡片间的虚线连接 + 标签 */
function withTimeline(
  result: LayoutResult,
  timeline: CardSpec[],
  dashed: boolean
): LayoutResult {
  if (timeline.length < 2) return result

  // 卡片 id → 节点坐标
  const byId = new Map(result.nodes.map((n) => [n.id, n]))
  const edges: LayoutEdge[] = []
  for (let i = 0; i < timeline.length - 1; i++) {
    const a = byId.get(timeline[i].id)
    const b = byId.get(timeline[i + 1].id)
    if (!a || !b) continue
    edges.push({
      from: a.id,
      to: b.id,
      // 时间线是横向的，连线走"卡片右边中点 → 卡片左边中点"
      toAnchorY: b.y + b.h / 2,
      label: dashed ? '关系待建立' : undefined,
      dashed,
    })
  }
  return { ...result, edges }
}

/**
 * 研究债务 —— 卡片加宽到 480px，内部三行（标题 / 为什么是债务 / 论文列表）。
 *
 * 为什么债务卡要特别宽：
 *   债务的完整论证链是"哪几篇论文 + 各自怎么说"，短摘要装不下，
 *   截断之后用户看不到"为什么这是债务"。宽卡 + 三行结构能让
 *   一条债务自证，不必逐个点开面板。
 */
function debtLayout(data: LabData): LayoutResult {
  const cards: CardSpec[] = data.debts.map((d) => ({
    id: `debt-${d.id}`,
    label: `研究债务 · ${categoryLabel(d.category)}`,
    title: d.title,
    excerpt: d.description,
    tone: toneForEvidence(d.evidenceStatus),
    footnote: `${d.occurrenceCount} 篇论文提及`,
    refId: d.id,
    /** 三行结构的第一行：为什么它是债务 */
    why: buildDebtWhy(d),
    /** 三行结构的第三行：论文列表 */
    papers: d.sources.map((s) => s.paperTitle),
  }))

  if (cards.length > 0) {
    /**
     * ── UI ③：债务改成列表 ──
     *
     * 产品原话「债务视图：卡片改列表（一行一条债务，左侧状态色条，
     * 右侧名称）」。用 list 通道渲染，不再走 layoutCards。
     *
     * 布局尺寸只给一个"足够放下整个列表"的画布高度 —— 列表在
     * 画布上是从顶部开始逐行排，不需要走卡片那种列宽计算。
     *
     * 左侧色条颜色沿用**证据强度色**（toneForEvidence），与旧卡片
     * 左边框同口径 —— 改成列表只是换了排布形态，语义色不能变，
     * 否则用户会以为"债务严重程度"的判据变了。
     */
    const rows: ListRow[] = data.debts.map((d) => ({
      id: `debt-${d.id}`,
      title: d.title,
      barColor: CARD_TONE_COLOR[toneForEvidence(d.evidenceStatus)],
      meta: `${categoryLabel(d.category)} · ${d.occurrenceCount} 篇论文提及`,
      refId: d.id,
    }))

    // P15 需求二：行高 56→72、列宽 720→840（字号放大联动，CanvasStage 行样式同步）
    const LIST_ROW_H = 72
    const LIST_GAP = 10
    const LIST_W = 840
    const height = rows.length * (LIST_ROW_H + LIST_GAP)

    return {
      nodes: [],
      edges: [],
      list: rows,
      width: LIST_W,
      height,
      bounds: { minY: 0, maxY: Math.max(LIST_ROW_H, height) },
    }
  }

  // 空态：给一张"债务长什么样"的范例结构（明确标注是结构示例，不是伪造结论）
  const sample: CardSpec = {
    id: 'debt-sample',
    label: '研究债务 · 结构示例',
    title: '为什么是债务 / 涉及哪些论文',
    excerpt:
      '研究债务是"多篇论文反复承认、但在当前收录文献中未见解决"的问题。单篇论文的局限只是它自己的缺点，不构成领域债务。',
    tone: 'default',
    footnote: '示例结构 · 非真实数据',
    why: '多篇论文承认同一问题，但没有一篇给出解决方案 —— 这才是债务。',
    papers: [],
  }
  const empty = layoutCards([sample], { wide: true })
  return {
    ...empty,
    emptyTitle: '尚未识别出跨论文的研究债务',
    emptyHint: '需要多篇已抽取结构的论文，才能比对出"反复出现、在当前收录文献中未见解决"的问题。',
    emptyAction: '运行债务合成',
  }
}

/** 把一条债务压成"为什么是债务"的一行 */
function buildDebtWhy(d: LabData['debts'][number]): string {
  const status = (d.currentStatus ?? '').trim()
  if (status) return status
  if (d.sources.length > 0) {
    return `${d.sources.length} 篇论文都提到这个问题，但没有一篇给出直接解决方案。`
  }
  return '（该债务没有记录当前解决状态）'
}

/**
 * 组合想法 —— 卡片间距收紧，每张带 `A + B × Debt = Idea` 小图。
 *
 * 小图的三个操作数是**真实数据**：
 *   A / B   = 来源 Block 名（fromBlockIds 还原）
 *   Debt    = 回应的研究债务标题（fromDebtIds 还原）
 *   Idea    = 这张卡本身
 * 没有任何一项时不画对应项，不编造。
 */
function ideaLayout(data: LabData): LayoutResult {
  const cards: CardSpec[] = data.ideas.map((i) => ({
    id: `idea-${i.id}`,
    label: '组合想法',
    title: i.title,
    // 问题 7：描述已由数据层压成一句话（见 llm-mock 的 buildMockCrossbreeder）
    excerpt: i.description,
    tone: i.fromBlockIds.length === 0 ? 'warn' : 'default',
    footnote:
      i.fromBlockIds.length === 0
        ? '尚未绑定来源 Block'
        : `来自 ${i.fromBlockIds.length} 个模块`,
    refId: i.id,
    formula: buildIdeaFormula(i, data),
    /**
     * ── 问题 7：长免责声明 → 小徽标「待验证」──
     *
     * 旧卡片在正文里挂一整句"这只是结构性组合假设，其有效性未经任何验证"。
     * 那句话 20+ 字，挤占正文宽度，而且每张卡片都重复一遍。
     * 改成右上角一个小胶囊：信息密度不变，视觉噪音降到最低。
     *
     * 为什么用 `warn` 色（不是红）：它是"需要人工判断"，不是"有问题"。
     */
    badge: { text: '待验证', tone: 'warn' },
  }))

  if (cards.length > 0) {
    // 组合卡片间距收紧（产品要求）—— 想法之间是并列的，不需要大留白
    return layoutCards(cards, { gap: 14 })
  }

  const sample: CardSpec = {
    id: 'idea-sample',
    label: '组合想法 · 结构示例',
    title: 'A + B × Debt = Idea',
    excerpt:
      '组合想法会把不同论文的模块拼进同一条流程，并指定它回应哪一条研究债务 —— 没有债务指向的组合只是堆砌。',
    tone: 'default',
    footnote: '示例结构 · 非真实数据',
    formula: { a: '模块 A', b: '模块 B', debt: '研究债务', idea: '新方案' },
  }
  const empty = layoutCards([sample], { gap: 14 })
  return {
    ...empty,
    emptyTitle: '尚未生成组合想法',
    emptyHint: '先有至少一条研究债务，组合才有明确的目标。',
    emptyAction: '重新生成组合',
  }
}

/** 把一条想法压成 `A + B × Debt = Idea` 的四个操作数 */
function buildIdeaFormula(
  idea: LabData['ideas'][number],
  data: LabData
): NonNullable<CardSpec['formula']> {
  const blocks = idea.fromBlockIds
    .map((id) => findBlockName(id, data))
    .filter((x): x is string => Boolean(x))
  const debt = idea.debtIds
    .map((id) => data.debts.find((d) => d.id === id)?.title)
    .filter((x): x is string => Boolean(x))[0]

  return {
    a: blocks[0],
    b: blocks[1] ?? blocks[0],
    debt,
    idea: '新方案',
  }
}

/**
 * 按 block id 找到模块名 —— 跨全部论文查找。
 *
 * 导出给 P7-4 的上下文横条复用（"本次手术干预了 N 个 Block：xxx"），
 * 使 blockId → 可读名字的翻译只有一处实现。
 */
export function findBlockName(blockId: string, data: LabData): string | undefined {
  for (const p of data.papers) {
    const b = p.blocks.find((x) => x.id === blockId)
    if (b) return b.name
  }
  return undefined
}

/**
 * 击穿测试 —— 每张卡带 6 个检查项的图标状态行。
 *
 * ── 为什么是 6 个而不是 4 个 ──
 *   数据层真实落库的检查是 4 项（noveltyCheck / blockConflictCheck /
 *   dataRequirement / computeRequirement）。产品要求卡片上有 6 个检查项，
 *   所以另外 2 项取自**已经存在于同一份 findings JSON 里**的信息：
 *     · 实验设计（experimentalDesign 是否已生成）
 *     · 致命弱点（fatalFlaws 是否为空）
 *   这两项都是真实存在的字段，不是编出来的第 5、6 个假检查。
 *   缺数据的检查项显示为 ⚠（"未检出/未覆盖"），而不是伪造一个 ✓。
 *
 * ── 状态图标映射（数据层 → 图标）──
 *   PASS    → ✓
 *   CONCERN → ⚠
 *   BLOCKER → ✗
 *   UNKNOWN → ⚠（灰色，"这项没跑到"）
 *   注意数据层用的是 BLOCKER，不是 FAIL —— 早期方案文里写的 FAIL 是笔误。
 */
function crashLayout(data: LabData): LayoutResult {
  const cards: CardSpec[] = data.crashTests.map((t) => {
    /**
     * 卡片也要「给结论」（问题 5）。
     *
     * 原来卡片标签直接印 verdict（如「证据不足」），那是**模型的语言**，
     * 用户要的是"这个想法我能不能做"。所以这里用与面板同一套结论层
     * （buildCrashConclusion），保证卡片与面板说的是同一句话，
     * 不会出现"卡片说证据不足、面板说需要调整"这种自相矛盾。
     */
    const conclusion = buildCrashConclusion(t)
    const excerpt =
      conclusion.checks
        .filter((c) => c.outcome !== 'pass')
        .map((c) => `[${c.outcomeLabel}] ${c.label}`)
        .join('  ') ||
      conclusion.checks.map((c) => `[${c.outcomeLabel}] ${c.label}`).join('  ')

    return {
      id: `crash-${t.id}`,
      label: `击穿测试 · ${conclusion.overall.label}`,
      title: t.ideaTitle ?? '（未关联想法）',
      excerpt: excerpt || t.findings,
      tone: toneForOverall(conclusion.overall.outcome),
      footnote: conclusion.overall.reason,
      refId: t.id,
      checks: buildCrashChecks(t),
    }
  })

  if (cards.length > 0) {
    // P18 问题 3c：竖向堆叠。原来横排一行，想法一多画布就被拉得
    // 越来越宽（要左右拖才能看全）；竖排符合"逐个往下读"的动线，
    // 也和右侧「已生成的想法」列表（纵向）方向一致。
    return layoutCards(cards, { gap: 18, vertical: true })
  }

  /**
   * P18 问题 3a：空态示例卡片已删除。
   *
   * 原来没有击穿结果时画布上会摆一张「尚未对任何组合想法做击穿测试」
   * 的示例卡 —— 它与左上角 CrashRunCard 的「已生成的想法」空态、
   * 画布中央的提示是三处重叠的"你还没跑"表述。用户点名删掉这张卡：
   * 击穿结果为零时画布干净为空即可，剩余两处（CrashRunCard 空态行 +
   * 视图可用性引导）已足够说明"去哪跑"。
   */
  return layoutCards([], { gap: 18 })
}

/** 检查项图标状态行的单元格 */
export interface CrashCheckCell {
  key: string
  label: string
  /** PASS | CONCERN | BLOCKER | UNKNOWN */
  level: string
  /** ✓ / ⚠ / ✗ */
  icon: string
}

const LEVEL_ICON: Record<string, string> = {
  PASS: '✓',
  CONCERN: '⚠',
  BLOCKER: '✗',
  /**
   * ── 问题 8：UNKNOWN 用 `?` 而不是 `⚠` ──
   *
   * `⚠` 是"查了、有疑虑"，`?` 是"没查"。两者在卡片上必须一眼可分 ——
   * 混用会让用户以为系统查过新颖性并发现了问题（实际是根本没查）。
   */
  UNKNOWN: '?',
}

/** 从数据层 4 项检查 + findings 的 2 项补充，组成 6 格状态行 */
function buildCrashChecks(t: LabData['crashTests'][number]): CrashCheckCell[] {
  const cells: CrashCheckCell[] = t.checks.map((c) => ({
    key: c.key,
    label: c.label,
    level: c.level,
    icon: LEVEL_ICON[c.level] ?? '⚠',
  }))

  // 第 5 项：实验设计是否已生成（真实字段 experimentalDesign）
  cells.push({
    key: 'experimentalDesign',
    label: '实验设计',
    level: t.experimentalDesign?.trim() ? 'PASS' : 'UNKNOWN',
    icon: t.experimentalDesign?.trim() ? '✓' : '⚠',
  })

  // 第 6 项：致命弱点（来自 findings JSON 的 fatalFlaws）
  cells.push({
    key: 'fatalFlaws',
    label: '致命弱点',
    level: t.fatalFlaws.length > 0 ? 'BLOCKER' : 'PASS',
    icon: t.fatalFlaws.length > 0 ? '✗' : '✓',
  })

  return cells
}

// （原 SAMPLE_CHECKS —— 空态示例卡片的 6 项检查图标行，
//  P18 问题 3a 删除示例卡片后已无消费方，随之移除。）

// ─────────────────────────────────────────────────────────────
// 通用零件
// ─────────────────────────────────────────────────────────────

/**
 * 空态骨架：只画根节点 + 一个"结构待抽取"的提示节点。
 *
 * 用于"连论文结构都还没有"的最外层空态 —— 此时画真实结构图无从谈起，
 * 但给一个视觉锚点仍然比一句白字有用：用户能看见流程是横向的、
 * 知道结构图会从左侧的论文节点向右展开。
 *
 * ── S1：不再预画 7 个"待抽取"阶段列 ──
 *
 * 旧实现把全部 7 个阶段列都画成虚框「待抽取」，理由是"让用户知道
 * 结构图将来长什么样"。这跟 layoutStructure 里那批「原文未描述」
 * 空列是同一个毛病，而且更严重：
 *   ① 空态本来就是要**引导用户去上传/抽取**。7 个灰框不但没帮上忙，
 *      反而让画面看起来"已经有很多东西在等着" —— 用户会以为
 *      系统卡住了、或者以为这些框是该自己填的。
 *   ② 它和"抽取完成但某阶段为空"长得几乎一样，两种情况在视觉上
 *      不可区分，用户无法判断自己处在哪一步。
 *   ③ 按 P1 的口径：**没有数据 = 没有阶段**。预画阶段等于凭空
 *      声明"这篇论文应该覆盖这 7 个阶段"，这是我们不知道的事。
 *
 * 现在只留根节点，把"接下来会发生什么"交给空态提示文案
 * （emptyTitle / emptyHint / emptyAction）去说 —— 那是它该干的活。
 */
function structureSkeleton(paperTitle: string, paperId?: string): LayoutResult {
  const rootW = 168
  const placeholderW = 200
  const gap = 40
  const placeholderX = rootW + gap

  const nodes: LayoutResult['nodes'] = [
    {
      id: 'root',
      kind: 'root',
      label: '论文',
      title: paperTitle,
      // 与 layoutStructure 一致：根节点带 paperId，面板按 id 反查论文
      refId: paperId,
      x: 0,
      y: 0,
      w: rootW,
      h: NODE_H,
      col: 0,
    },
    {
      id: 'empty-structure',
      kind: 'empty',
      label: '方法结构',
      title: '待抽取',
      placeholder: '待抽取',
      x: placeholderX,
      y: 0,
      w: placeholderW,
      h: NODE_H,
      col: 1,
    },
  ]

  const edges: LayoutEdge[] = [
    { from: 'root', to: 'empty-structure', toAnchorY: NODE_H / 2 },
  ]

  const width = placeholderX + placeholderW
  return {
    nodes,
    edges,
    width,
    height: NODE_H + 80,
    bounds: { minY: 0, maxY: NODE_H },
  }
}

/** 把"主体 + 一个缩小的空态提示块"合成一个 LayoutResult */
function layoutSubject(
  emptyTitle: string,
  emptyHint: string,
  subject: LayoutResult
): LayoutResult {
  return { ...subject, emptyTitle, emptyHint }
}

// ── 文案映射（集中在此，避免散落） ──

function short(title: string | undefined, max = 22): string {
  if (!title) return '（未知论文）'
  return title.length > max ? `${title.slice(0, max)}…` : title
}

const CATEGORY_LABEL: Record<string, string> = {
  COMPUTATION: '计算开销',
  DATA: '数据',
  GENERALIZATION: '泛化',
  EVALUATION: '评测',
  THEORY: '理论',
  OTHER: '其他',
}

export function categoryLabel(c: string): string {
  return CATEGORY_LABEL[c] ?? c
}

const VERDICT_LABEL: Record<string, string> = {
  INSUFFICIENT_EVIDENCE: '证据不足',
  PASS: '通过',
  CONCERN: '有疑虑',
  FAIL: '不成立',
  POSITIVE: '正面',
}

export function verdictLabel(v: string): string {
  return VERDICT_LABEL[v] ?? v
}

// toneForVerdict / toneForEvidence 统一由 palette 提供 ——
// 这里不再重复定义，避免"卡片红"与"徽标红"漂移成两个色值。

/**
 * 证据强度文案 —— 直接复用 enums 里的唯一映射，不另建一份。
 *
 * 之前这里自己写了一份 `SUFFICIENT/UNCERTAIN/INSUFFICIENT` 的映射，
 * 与 enums 的 `CONFIRMED/UNCERTAIN/INSUFFICIENT` 键名不一致，
 * 导致 `CONFIRMED` 查不到、直接把原值印在界面上（"证据CONFIRMED"）。
 * 单一来源能从根本上避免这类漂移。
 */
export function evidenceLabel(s: string): string {
  return EVIDENCE_STATUS_LABEL[s as keyof typeof EVIDENCE_STATUS_LABEL] ?? s
}

/** 供验证脚本 / 报告引用的几何常量（避免各处硬编码） */
export const LAYOUT_METRICS = {
  CARD_W,
  CARD_H,
  CARD_GAP,
  /** 债务宽卡宽度 —— 验证脚本断言"债务卡 480px"用 */
  DEBT_CARD_W: 480,
  /** 组合卡紧间距 —— 验证脚本断言"间距收紧"用 */
  IDEA_CARD_GAP: 14,
} as const
