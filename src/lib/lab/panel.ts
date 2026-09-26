import type { LabData, ViewId } from '@/lib/lab/views'
import { getAvailability } from '@/lib/lab/views'
import { categoryLabel, evidenceLabel, verdictLabel } from '@/lib/lab/view-layout'
import type { LayoutNode } from '@/lib/lab/layout'
import { parseSurgeryResult } from '@/lib/lab/surgery-result'
import { buildSurgerySummary, humanizeDependencyRisk } from '@/lib/lab/surgery-summary'
import { buildCrashConclusion } from '@/lib/lab/crash-summary'
import {
  buildEvolutionSubtitle,
  deriveProblemStatus,
  summarizeProblem,
} from '@/lib/lab/problem-status'
import { rawIdOf, SURGERY_ID_PREFIX, DEBT_ID_PREFIX } from '@/lib/lab/node-ids'
import { deepStripInlineMarkers, stripInlineMarkers } from '@/lib/lab/text-clean'
import { ROLE_EMPTY_HINT } from '@/lib/lab/block-role'
import { METHOD_STAGE_LABEL, METHOD_STAGE_ORDER } from '@/lib/enums'
import {
  summarizeAttempt,
  summarizeAttemptBySource,
  summarizePointBySource,
  normalizeOutcomeZh,
} from '@/lib/lab/en-summary'

/**
 * 底部详情面板的内容模型。
 *
 * 面板不直接读 LayoutNode —— 因为"画布上被选中的那个节点"和"面板要展示的
 * 事实"不是一回事：节点只带两行文字，面板要带描述、证据、动作。
 * 这里把「选中 id → 面板内容」的映射集中成一个纯函数，
 * 组件只负责画，不负责查。
 */

export interface PanelSection {
  /** 小节标题（可选，无标题表示是主描述） */
  heading?: string
  /** 正文 */
  body: string
  /** 是否是引用块（原文摘录用） */
  quote?: boolean
}

export interface PanelAction {
  label: string
  /** 动作 id —— 组件层决定怎么处理（B5 阶段多为只提示不执行） */
  kind: string
}

export interface PanelContent {
  /** 顶部小标签 */
  label: string
  /** 主标题 */
  title: string
  /** 副标题（如来源论文） */
  subtitle?: string
  /** 证据强度 */
  evidenceStatus?: string
  /** 证据 id 列表（点"查看证据"时给抽屉） */
  evidenceIds: string[]
  /** 正文分节 */
  sections: PanelSection[]
  /** 可执行动作 */
  actions: PanelAction[]

  // ── 接后端所需的"对象标识"（P7-3 新增）──
  //
  // 面板上的按钮要调用 server action，而 action 需要的是**具体的 id**
  // （surgeryAction 要 blockId、crashTestAction 要 ideaId）。
  // 这些 id 在构造面板内容时就已经确定了，所以在这里一并带出来 ——
  // 组件层不必再去反查一遍"当前选中的是谁"。

  /** 被选中的对象 id（block / debt / relation / surgery 的原始 id） */
  refId?: string
  /** 击穿测试 / 想法面板：关联的想法 id（运行击穿测试要用） */
  ideaId?: string
  /**
   * 该 Block 最近一次手术的 Surgery.id —— 用于「撤销本次手术」。
   *
   * 为什么是"最近一次"而不是全部：产品明确要求"同一 Block 被多次手术，
   * 只撤销最近一次"。撤销是**栈式**语义，一次退一步，符合直觉。
   * 为空表示这块没被手术过，面板不显示撤销按钮。
   */
  undoSurgeryId?: string
}

/**
 * 把画布上选中的节点翻译成面板内容。
 *
 * 返回 null 表示"这个节点没有对应的详情"（例如结构图里的空阶段占位节点）。
 */
/**
 * 底部面板的统一出口。
 *
 * ⚠️ 所有面向用户的面板内容**只能**从这里出去。
 * 它做两件事：
 *   1. 把「选中 id / 节点 / 视图」路由到具体的 xxPanel；
 *   2. **在出口处对整份内容做一次深度清洗**（问题 3 的兜底防线）——
 *      剥掉 `【演示推断】` 这类内嵌标记。
 *
 * 为什么清洗放在出口而不是各 panel 里：面板有 7 个分支、每份内容有
 * sections/actions/title/label… 十几个字符串字段，逐个手写清洗必然漏。
 * 放在出口 + 深度遍历，**将来新增字段自动受保护**。
 */
export function buildPanelContent(
  selectedId: string | null,
  node: LayoutNode | null,
  view: ViewId,
  data: LabData,
  /**
   * ── 问题 4：刚刚被「恢复」的 block id ──
   *
   * 恢复动作会删掉那条 Surgery 记录，数据层表现和"从没手术过"完全一样，
   * 用户点完看不到任何回执。这个参数让面板能对着刚恢复的 block 说一句
   * "已恢复" —— 它是**一次性的瞬时状态**，由交互层传入（见 LabShell），
   * 不落库、不参与"状态判定"。真正的状态判定永远看 data.surgeries。
   */
  justRestoredBlockId?: string | null
): PanelContent | null {
  const content = buildPanelContentRaw(selectedId, node, view, data, justRestoredBlockId)
  return content ? deepStripInlineMarkers(content) : null
}

function buildPanelContentRaw(
  selectedId: string | null,
  node: LayoutNode | null,
  view: ViewId,
  data: LabData,
  justRestoredBlockId?: string | null
): PanelContent | null {
  if (!selectedId) return null

  /**
   * ── 手术记录（问题 2：剪刀模式的落点）──
   *
   * 为什么这个分支必须放在 `!node` 判断**之前**：
   *
   *   剪刀模式下点一个 Block 之后，我们要展示的是**这次手术的结论**，
   *   而不是 Block 卡片本身。结论挂在 Surgery 记录上，所以选中的 id 是
   *   `surgery-<id>`。但 `surgery-<id>` 只存在于已废弃的 surgery 视图的
   *   layout 里 —— 当前的「方法 DNA」视图没有这个节点，selectedNode 会是
   *   null，若先判 `!node` 就会把面板整块吞掉。
   *
   *   所以这里按 **id 前缀**提前兜底：只要选中 id 是 surgery-，就直接渲染
   *   手术面板，不依赖 layout 里有没有这个节点。这样"就地手术→看结论"
   *   在任何视图下都成立，也把面板与画布布局解耦了。
   */
  const surgeryId = rawIdOf(selectedId, SURGERY_ID_PREFIX)
  if (surgeryId) {
    return surgeryPanel(surgeryId, data)
  }

  /**
   * ── 研究债务（UI ③：债务视图改成列表之后必须补这一条）──
   *
   * 为什么需要它：UI ③ 把债务视图从「卡片」改成了**列表**
   * （一行一条债务）。列表不是画布节点，所以 debtLayout 返回的
   * `nodes` 是空数组，`layout.nodes.find(...)` 永远找不到选中项 ——
   * selectedNode 为 null，面板整块不渲染。
   *
   * 但列表行点击时传进来的 id 是 `debt-<debtId>`（见 CanvasStage 里
   * `onClick={() => onNodeClick({ id: row.id })}`）。这正是
   * 上面 surgery- 分支处理过的同一类问题：**选中项只在 layout 里存在
   * 于某种形态，而面板要按 id 反查**。所以同样按前缀提前兜底，
   * 不依赖 node 是否存在。
   *
   * 放在「!node 判断之前」是与 surgery- 一致的理由：不这么做的话，
   * 债务列表点任何一行面板都是空的 —— 功能等于没做。
   */
  const debtId = rawIdOf(selectedId, DEBT_ID_PREFIX)
  if (debtId) {
    return debtPanel(debtId, data)
  }

  if (!node) return null

  if (node.kind === 'block' && node.block) {
    const b = node.block
    /** 问题 4：这个块是不是刚刚被恢复的那一个（瞬时回执） */
    const justRestored = justRestoredBlockId === b.id

    /**
     * 这块被手术动过吗？动过的话，最近一次手术是哪个？
     *
     * 数据来源：data.surgeries 里按数组顺序找**最后一个**包含该 blockId
     * 的 Surgery（surgeries 由查询按 createdAt 升序给出，所以最后一个
     * 就是最近一次）。产品要求"只撤销最近一次"，正是取这个。
     */
    const lastSurgery = [...data.surgeries]
      .reverse()
      .find((s) => s.intervenedBlockIds.includes(b.id))

    return {
      label: node.label,
      title: b.name,
      subtitle: undefined,
      evidenceStatus: b.evidenceStatus,
      evidenceIds: b.evidenceIds,
      // 「以此为起点做手术」要把它交给 surgeryAction
      refId: b.id,
      // 有手术记录 → 面板出现「撤销本次手术」
      undoSurgeryId: lastSurgery?.id,
      sections: [
        /**
         * ── 问题 4：「刚发生了什么」置顶 ──
         *
         * 恢复操作删掉了那条 Surgery 记录，数据层回到"完好"状态，看起来
         * 和从没动过一样 —— 用户会怀疑"我点的那下生效了吗"。
         * 所以恢复后选中该 block 时，在最上面压一行状态回执：
         * 说清"刚刚恢复了什么"，面板随之出现，且不需要用户做任何选择。
         *
         * 摘除时不会走这里 —— 那条路会选中 surgery 节点，由 surgeryPanel
         * 显示手术结论，本身就是更强的回执。
         */
        ...(justRestored
          ? [
              {
                heading: '已恢复',
                body: `「${b.name}」已经恢复原样，方法结构回到被手术前的状态。若还想看拿掉它的后果，在这一模式下再点一次即可。`,
              },
            ]
          : []),
        { body: b.description || '（该方法模块没有描述）' },
        /**
         * 问题 2：role 为空时**不要**再显示"（未说明）"这种含糊字样，
         * 更不要退回模板句。如实说明"没抽到"，并解释为什么 ——
         * 用户看到的是"数据不够"，而不是"系统在敷衍"。
         */
        {
          heading: '在方法中的角色',
          body: b.role?.trim() ? b.role.trim() : ROLE_EMPTY_HINT,
        },
        ...(lastSurgery
          ? [
              {
                /**
                 * ── 问题 3：这里不能出现英文枚举 ──
                 *
                 * 旧写法是 `判定：${lastSurgery.verdict}` —— 直接把
                 * INSUFFICIENT_EVIDENCE 这种 schema 常量贴给用户看，
                 * 既不是中文、也不是结论。它和"数据搬运"是同一类毛病：
                 * 把库里长什么样原样搬到屏幕上。
                 *
                 * 现在改走 buildSurgerySummary：拿 result 解析出事实，
                 * 翻成「移除 X 后，方法的核心流程会断在这里 —— 因为 X
                 * 负责 Y」这样一句人话。抽不出就诚实说明"无法推断"，
                 * 绝不退回枚举，也不编造因果。
                 */
                heading: '最近一次手术',
                body: (() => {
                  const parsed = parseSurgeryResult(lastSurgery.result)
                  if (!parsed) {
                    return `${lastSurgery.title}\n移除该模块的影响无法从当前数据推断（缺消融实验）。`
                  }
                  const summary = buildSurgerySummary(parsed, b.name)
                  return `${lastSurgery.title}\n${summary.headline}`
                })(),
              },
            ]
          : []),
      ],
      actions: [
        { label: '查看证据', kind: 'evidence' },
        { label: '以此为起点做手术', kind: 'surgery' },
        // 只在本块真的被干预过时才出现 —— 没动过的块不该显示"撤销"
        ...(lastSurgery
          ? [{ label: '撤销本次手术', kind: 'undoSurgery' }]
          : []),
      ],
    }
  }

  // ── 结构树：根节点（论文） ──
  if (node.kind === 'root') {
    /**
     * 反查论文：**优先按 id**，标题只作兜底。
     *
     * 为什么不能只按标题（P10 问题 3 踩到的坑）：
     *   库里真实存在同标题的两篇 Self-RAG（stage 覆盖不同）。
     *   原来 `find(p => p.title === node.title)` 会命中列表里第一篇，
     *   导致面板展示的是**另一篇**的阶段分布与未抽取说明 ——
     *   数据本身没错，但对错了论文，属于最难发现的那类错。
     *   layoutStructure 现在会把 paperId 挂在根节点的 refId 上。
     */
    const paper =
      (node.refId ? data.papers.find((p) => p.id === node.refId) : undefined) ??
      data.papers.find((p) => p.title === node.title) ??
      data.papers[0]
    const avail = getAvailability('dna', data)

    /**
     * 7 个阶段的快速浏览（产品要求「进入 DNA 视图默认选中 root，
     * 面板展开显示论文摘要 + 7 个字段快速浏览」）。
     *
     * 为什么是"每个阶段有几个 block"而不是别的数字：
     *   这张图的价值是"方法由哪些阶段构成"。用户第一眼需要的不是
     *   某一段描述，而是"哪个阶段是实的、哪个是空的"——
     *   这一行小字补上了结构图里最难一眼看出的那件事。
     *   数据直接来自 paper.blocks，不新增查询。
     */
    const stageCounts = METHOD_STAGE_ORDER.map((stage) => ({
      stage,
      label: METHOD_STAGE_LABEL[stage],
      n: (paper?.blocks ?? []).filter((b) => b.stage === stage).length,
    }))
    const quickBrowse = stageCounts
      .map((s) => `${s.label} ${s.n === 0 ? '—' : s.n}`)
      .join('  ·  ')

    const abstract = readAbstract(paper?.id, data)

    const sections: PanelSection[] = []
    if (abstract) {
      sections.push({ heading: '论文摘要', body: abstract, quote: true })
    }
    sections.push({
      heading: '7 个方法阶段 · 模块数',
      body: quickBrowse,
    })
    sections.push({
      body: `该论文抽取出 ${paper?.blocks.length ?? 0} 个方法模块，分布在 ${
        new Set(paper?.blocks.map((x) => x.stage)).size
      } 个方法阶段。`,
    })

    /**
     * ── P10 问题 3：未抽取阶段的说明 ──
     *
     * 背景（拍板 1 选 A）：结构图上**只画有 block 的阶段**，缺失的阶段
     * 不留空位、不留灰框。好处是画布干净，代价是用户看不出"少了个阶段"
     * 到底是论文没写、还是我们没抽出来。
     *
     * 这一节就是那个出口：把没 block 的阶段列出来，并给出模型自己
     * 在抽取时写的理由（MethodDNA.uncertainties）。用户因此能区分：
     *   · 原文未涉及该阶段      → 论文本身如此，不是抽取失败
     *   · 原文提到但证据不足    → 我们看到了但没能成块，属已知局限
     *
     * 为什么不直接画在图上：那会重新引入"灰框占位"，与拍板 1 相悖；
     * 而且图上加占位会让"识别结果"和"识别失败"在视觉上无法区分。
     */
    const missing = stageCounts.filter((s) => s.n === 0)
    if (missing.length > 0) {
      const notes = paper?.uncertainties ?? []
      /**
       * 把 uncertainties 里的条目对到具体阶段。
       *
       * 踩过的坑：只按中文阶段名匹配（`n.includes(m.label)`）会漏 ——
       * 真实模型写的是 **英文枚举名**（"故没有 EVALUATION 阶段的 block"），
       * 而中文标签是"评估"，匹配不上，于是所有阶段都被误报成
       * "原文未涉及"，把模型其实写清楚的理由丢掉了。
       *
       * 现在同时匹配中文标签与英文 stage id，且**先到先得**：
       * 一条 note 只能解释一个阶段，避免一条里提到多个阶段时被重复引用。
       *
       * 兜底措辞也分两种，对应 prompt 里强制的两分法：
       *   命中 note      → 原样引用模型的说法（可能是"提到了但证据不足"）
       *   未命中 note    → "原文未涉及该阶段"（保守结论，可人工复核）
       */
      const explained = new Set<number>()
      const STAGE_EN: Record<string, string> = {
        PROBLEM: 'PROBLEM',
        INPUT: 'INPUT',
        PREPROCESSING: 'PREPROCESSING',
        CORE_METHOD: 'CORE_METHOD',
        TRAINING: 'TRAINING',
        INFERENCE: 'INFERENCE',
        EVALUATION: 'EVALUATION',
      }
      const lines = missing.map((m) => {
        const en = STAGE_EN[m.stage] ?? m.stage
        const idx = notes.findIndex(
          (n, i) =>
            !explained.has(i) && (n.includes(m.label) || n.includes(en))
        )
        if (idx >= 0) {
          explained.add(idx)
          return `· ${m.label}：${notes[idx]}`
        }
        return `· ${m.label}：原文未涉及该阶段`
      })
      // 与具体阶段无关的说明（如"未找到论文自述的局限性"）单独附在后面
      const rest = notes.filter((_, i) => !explained.has(i))
      sections.push({
        heading: '未抽取阶段说明',
        body: [
          `以下 ${missing.length} 个阶段没有抽到模块，结构图上不显示：`,
          ...lines,
          ...(rest.length > 0 ? ['', '其他未覆盖项：', ...rest.map((r) => `· ${r}`)] : []),
        ].join('\n'),
      })
    }

    sections.push({
      heading: '关于这张图',
      body: `全项目共 ${avail.count} 篇论文已抽取方法结构。节点只显示"类型 + 名称"，完整描述与证据在点击后显示在这里。`,
    })

    return {
      label: '论文 · 方法结构总览',
      title: node.title,
      evidenceStatus: undefined,
      evidenceIds: [],
      sections,
      actions: [{ label: '查看全部证据', kind: 'evidence' }],
    }
  }

  // ── 空阶段节点：不展示详情（它没有内容） ──
  if (node.kind === 'empty') return null

  // ── 卡片视图 ──
  if (node.kind === 'card' && node.card?.refId) {
    switch (view) {
      case 'debt':
        return debtPanel(node.card.refId, data)
      case 'idea':
        return ideaPanel(node.card.refId, data)
      case 'crashtest':
        return crashPanel(node.card.refId, data)
      case 'evolution':
        /**
         * 问题 3：演化的卡片现在指向的是**问题**（ResearchDebt.id），
         * 不再是 Relation.id。所以这里必须走 problemPanel ——
         * 若仍走 relationPanel，会因为找不到对应 Relation 而返回 null，
         * 面板整块消失（这正是"改了卡片没改路由"的典型症状）。
         */
        return problemPanel(node.card.refId, data)
      default:
        return null
    }
  }

  return null
}

// ── 各视图的面板构造 ──

/**
 * ── 问题 3：按问题组织的演化详情 ──
 *
 * 结构（严格按产品要求，且顺序就是阅读顺序）：
 *   ① 问题是什么     —— 债务描述
 *   ② 每篇论文怎么处理 —— 按论文逐条列出（attempts）+ 其余提及该问题的论文
 *   ③ 状态           —— 已解决 / 部分解决 / 未解决 + 一句话原因
 *   ④ 证据
 *
 * 与 debtPanel 的区别（为什么不能直接复用）：
 *   debtPanel 是"研究债务"视图的面板，视角是**债务管理**
 *   （当前状态 / 涉及论文 / 已有尝试 / 围绕它生成想法）。
 *   本面板视角是**演化**：它要回答"这条问题在几篇论文之间怎么一步步走过来的"，
 *   所以按论文组织、并把状态提到显眼位置，且不提供"生成想法"动作
 *   （那是债务视图的职责，混进来会让两个视图的出口重叠）。
 */
function problemPanel(id: string, data: LabData): PanelContent | null {  const d = data.debts.find((x) => x.id === id)
  if (!d) return null

  const info = deriveProblemStatus(d)
  const sections: PanelSection[] = []

  /**
   * ── 问题 5：结论优先 ──
   *
   * 旧顺序是「问题是什么 → 各论文处理 → 状态 → 证据」，用户要读到第三段
   * 才知道"所以呢"。现在把**状态**提到最前（这是结论），问题描述退居其后。
   * 完整原文不在这里展开 —— 它在「查看证据」里，点一下就能看到原句。
   */
  sections.push({
    heading: '状态',
    body: `${info.label} —— ${info.reason}`,
  })

  // ── 问题是什么（一句话提炼）──
  //
  // 完整 description 不再直接铺在面板里：实测它常是"3 篇论文都承认了这一问题：
  // 《A》、《B》、《C》。演示模式…"这种合成句，贴出来只是把一句话重复一遍还更长。
  // 想看原文的用户走「查看证据」，那里给的是逐条可核对的论文原句。
  //
  // 例外：当提炼结果就是标题（说明 description 本身没有实质内容）时，
  // 把完整 description 附在后面 —— 否则用户会觉得"面板里什么都没有"。
  const oneLine = summarizeProblem(d)
  const full = stripInlineMarkers((d.description || '').trim())
  const showFull =
    full &&
    full !== oneLine &&
    oneLine === d.title &&
    full.length <= 220
  sections.push({
    heading: '这条问题是什么',
    body: showFull ? `${oneLine}\n\n${full}` : oneLine,
  })

  /**
   * ── 每篇论文怎么处理 ──
   *
   * 问题 6 要求统一成「论文 X 尝试了 Y 方案 → 结果：成功/部分成功/未说明」。
   * 这里把 attempt 的 description 压成一句话（它常是一整段），
   * outcome 归一成三档标签 —— 用户扫一眼就能比较"谁走通了、谁没走通"。
   * 完整做法与结果原文在同一条 attempt 的证据里可查。
   */
  /**
   * ── 每篇论文怎么处理（P9 问题 2 重做）──
   *
   * 旧写法是把 `a.description` 截断后**直接贴英文原句**：
   *     《RAG》尝试了「We introduce a general-purpose fine-tuning…」 → 结果：未说明
   * 用户要的是"这篇论文对这个问题的处理"，不是"论文里那句话长什么样"。
   *
   * 现在走 `summarizeAttempt()`：识别言语行为 → 抽对象短语 → 拼一句中文，
   * 引号里只放短语（≤20 字）。抽不出来就退到统一兜底文案，不硬凑。
   * 英文原句仍然完整保留在「查看证据」里，需要核对时点开就能看到。
   */
  const attemptByPaper = new Map(d.attempts.map((a) => [a.paperId, a]))
  const perPaper: string[] = []

  for (const a of d.attempts) {
    // Step 2：按数据来源分流 —— mock 走规则归纳，真模型的中文原样收短
    const what = summarizeAttemptBySource(
      a.description || '',
      // UI ④：论文名完整展示，不再截断到 28 字 ——
      // 面板是"看全貌"的地方，截断过的名字用户无法据此找到那篇论文。
      a.paperTitle,
      a.provider
    )
    perPaper.push(`${what} → 结果：${normalizeOutcomeZh(a.outcome)}`)
  }
  for (const s of d.sources) {
    if (attemptByPaper.has(s.paperId)) continue
    perPaper.push(
      `《${s.paperTitle}》只指出了这个问题，没有提出解法`
    )
  }

  sections.push({
    heading: `各论文的处理（${perPaper.length} 篇）`,
    body: perPaper.length > 0 ? perPaper.join('\n') : '（没有任何论文提及该问题）',
  })

  // ── 证据（由外层用 evidenceIds 渲染"查看证据"，这里只给数量提示） ──
  const evidenceCount = d.evidenceIds.length
  sections.push({
    heading: '证据',
    body:
      evidenceCount > 0
        ? `这条问题关联 ${evidenceCount} 条论文原文证据，点下方「查看证据」可逐条核对。`
        : '这条问题还没有关联到可核对的论文原文。',
  })

  return {
    label: `方法演化 · ${info.label}`,
    title: d.title,
    refId: d.id,
    subtitle: buildEvolutionSubtitle(d),
    evidenceStatus: d.evidenceStatus,
    evidenceIds: d.evidenceIds,
    sections,
    actions: [{ label: '查看证据', kind: 'evidence' }],
  }
}

/**
 * P9：`normalizeOutcome` 与 `summarizeText` 已删除。
 *
 * 它们原本的职责是「把 outcome 归成三档」+「把描述截一段」，
 * 但后者正是问题 2/3 的病灶 —— 截断英文原句直接贴进面板。
 * 现在两件事都归 `@/lib/lab/en-summary`：
 *   · `normalizeOutcomeZh()`  —— outcome 归一（含"已解决/未解决"两档）
 *   · `summarizeAttempt()` / `summarizePoint()` —— 中文归纳，不截断原文
 */

function debtPanel(id: string, data: LabData): PanelContent | null {
  const d = data.debts.find((x) => x.id === id)
  if (!d) return null

  /**
   * ── 问题 6：研究债务面板也走「结论优先」──
   *
   * 旧顺序是「一段描述 → 当前状态 → 涉及论文 → 已有尝试」：
   *   用户读完一大段描述才知道"所以这条问题到底解决没有"。
   *   状态被压在第 2 节，而且"已有尝试"用的是 `描述 → 结果` 的流水账。
   * 现在：
   *   ① 状态提到最前（结论）
   *   ② 描述换成一句话提炼（细节在证据里）
   *   ③ 「已有尝试」统一成「《论文》动作「短语」 → 结果：Z」
   *      Z 走 normalizeOutcomeZh 归一成 已解决/部分成功/失败/引入新问题/未解决/未说明
   */
  const info = deriveProblemStatus(d)

  const attemptLines = d.attempts.map((a) => {
    const what = summarizeAttemptBySource(
      a.description || '',
      // UI ④：论文名完整展示，不截断
      a.paperTitle,
      a.provider
    )
    return `${what} → 结果：${normalizeOutcomeZh(a.outcome)}`
  })

  return {
    label: `研究债务 · ${categoryLabel(d.category)}`,
    title: d.title,
    refId: d.id,
    subtitle: `${d.occurrenceCount} 篇论文提及`,
    evidenceStatus: d.evidenceStatus,
    evidenceIds: d.evidenceIds,
    sections: [
      // ① 结论：状态
      { heading: '状态', body: `${info.label} —— ${info.reason}` },
      // ② 一句话提炼（description 若是无实质内容的合成句，这里就是标题）
      { heading: '这条债务是什么', body: summarizeProblem(d) },
      ...(d.currentStatus?.trim() && d.currentStatus.trim() !== info.label
        ? [{ heading: '论文原文里的说法', body: stripInlineMarkers(d.currentStatus.trim()) }]
        : []),
      {
        heading: `涉及的论文（${d.sources.length}）`,
        // P9 问题 3：这里以前是 `《论文》：<英文原句截断>`，直接贴原文。
        // P10 Step2：改为按「数据来源」分派 ——
        //   · mock 时代写入的（provider 为空或 'mock'）→ 走 summarizePoint() 的老中文归纳
        //   · 真模型写入的 → 模型本就是中文，直接用（限 60 字，避免长句撑爆面板）
        body:
          d.sources
            .map((s) => summarizePointBySource(s.context || '', s.paperTitle, s.provider))
            .join('\n') || '（无）',
      },
      {
        heading: `已有尝试（${d.attempts.length}）`,
        body: attemptLines.join('\n') || '（尚无尝试 —— 这个问题被反复提出，但还没有论文动手解决）',
      },
    ],
    actions: [
      { label: '查看证据', kind: 'evidence' },
      { label: '围绕它生成组合想法', kind: 'idea' },
    ],
  }
}

function ideaPanel(id: string, data: LabData): PanelContent | null {
  const i = data.ideas.find((x) => x.id === id)
  if (!i) return null
  // 把 fromBlockIds 还原成"模块名（论文名）"，比显示 id 有用得多
  const parts = i.fromBlockIds.map((bid) => resolveBlockLabel(bid, data)).filter(Boolean)

  /**
   * ── 问题 7：结论优先，机制压到 1-2 句 ──
   *
   * 旧版把三段平铺：描述 → 来源模块 → 回应的债务 → 为什么能解决。
   * 用户要先读三节才到"凭什么有效"。现在把**机制提到第一节**，
   * 且只给 1-2 句（数据层已压过，见 llm-mock 的 why）。
   *
   * 详细解释（来源模块、回应的债务）退到后面 —— 它们对"判断这个想法
   * 值不值得看"是**论据**，不是结论。
   */
  const sections: PanelSection[] = []

  // ① 结果：机制（为什么能解决）—— 一句话在前
  if (i.mechanism?.trim()) {
    sections.push({ heading: '为什么能解决', body: i.mechanism.trim() })
  }

  // ② 这个组合是什么（描述，已被数据层压成一句话）
  sections.push({ body: i.description })

  /**
   * ③ 详细解释 —— 「查看详情」折叠区
   *
   * 产品要求"详细解释进查看详情"。用一个带前缀的小节模拟折叠语义：
   * 标题写「查看详情 · 来源模块」等，用户知道这是展开信息、不是必读。
   * （真正的折叠交互由面板组件按 heading 前缀渲染 — 见 BottomPanel）
   */
  sections.push({
    heading: '查看详情 · 来源模块',
    body: parts.length ? parts.join('\n') : '该想法尚未绑定来源 Block。',
  })
  sections.push({
    heading: '查看详情 · 回应的研究债务',
    body:
      i.debtIds
        .map((did) => data.debts.find((d) => d.id === did)?.title)
        .filter(Boolean)
        .join('\n') || '（未关联债务）',
  })

  return {
    label: '组合想法',
    title: i.title,
    refId: i.id,
    // 「运行击穿测试」要把它交给 crashTestAction
    ideaId: i.id,
    subtitle: parts.length ? `组合自 ${parts.length} 个模块` : '尚未绑定来源 Block',
    evidenceStatus: i.evidenceStatus,
    evidenceIds: i.evidenceIds,
    sections,
    actions: [
      { label: '查看证据', kind: 'evidence' },
      ...(parts.length === 0 ? [{ label: '重新生成组合', kind: 'regenerate' }] : []),
      { label: '运行击穿测试', kind: 'crashtest' },
    ],
  }
}

function crashPanel(id: string, data: LabData): PanelContent | null {
  const t = data.crashTests.find((x) => x.id === id)
  if (!t) return null

  /**
   * ── 问题 5：击穿测试要「给结论」，不是「给报错」──
   *
   * 原来的 sections 是把四项检查的 detail 原样铺开，用户读到的是
   * 「演示模式无法检索新颖性 / 无法判断模块冲突…」—— 这是报错，
   * 不是结论。现在改成「结论在前、依据在后」：
   *
   *   一句话总体判定（可行 / 需要调整 / 不建议做）
   *     → 每项检查：通过/警告/失败 + 一句话理由 + 修改建议
   *     → 补充发现（模型给出的其余发现，不丢）
   *     → 实验设计
   *     → 致命弱点（有才显示）
   *
   * 判定文案全部来自 crash-summary，本函数只负责排版，
   * 保证"给结论"的逻辑只有一处、可单独测。
   */
  const conclusion = buildCrashConclusion(t)

  const sections: PanelSection[] = []

  // ── ① 一句话总体判定（最前，无标题） ──
  //    注意：面板正文是纯文本渲染（whitespace-pre-line），**不支持 Markdown**，
  //    所以这里不能用 ** 粗体 —— 会原样显示成星号。强调靠句式与位置。
  sections.push({
    body: `总体判定：${conclusion.overall.label}\n${conclusion.overall.reason}`,
  })

  // ── ② 每项检查：档位 + 理由 + 建议 ──
  //    用一行 [通过]/[需要调整]/[无法判断]/[不通过] 开头，扫一眼就知道每项过没过
  //
  //    问题 8：计数行把「无法判断」单列出来 —— 它是"没查"，
  //    不能和"查了发现要调整"混在一个数字里，否则用户无法判断
  //    "这个结论到底是查出来的还是没查"。
  const countBits = [
    `${conclusion.counts.pass} 通过`,
    conclusion.counts.warn > 0 ? `${conclusion.counts.warn} 需要调整` : '',
    conclusion.counts.unknown > 0 ? `${conclusion.counts.unknown} 无法判断` : '',
    conclusion.counts.fail > 0 ? `${conclusion.counts.fail} 不通过` : '',
  ].filter(Boolean)

  /**
   * ── ② 每项检查：档位 + 理由 + 改法（P9 问题 5）──
   *
   * 改法**只在「需要调整」和「不通过」时渲染**。
   * 旧实现是无条件 `改法：${c.suggestion}`，于是"通过"的项下面也挂着一条
   * 模板改法（结论通过、改法却让你换模块），逻辑自相矛盾。
   * 现在 `suggestion === null` 时整行不渲染 —— 通过的不需要改，
   * 没查的给不出针对性改法，两者都不该硬凑一句话。
   */
  sections.push({
    heading: `四项检查 · ${countBits.join(' / ')}`,
    body: conclusion.checks
      .map((c) => {
        const lines = [`[${c.outcomeLabel}] ${c.label}`, c.reason]
        if (c.suggestion) lines.push(`改法：${c.suggestion}`)
        return lines.join('\n')
      })
      .join('\n\n'),
  })

  // ── ③ 下一步（把"该做什么"集中在一处，用户不用自己从检查里提炼） ──
  if (conclusion.overall.nextSteps.length > 0) {
    sections.push({
      heading: '下一步',
      body: conclusion.overall.nextSteps.map((s) => `· ${s}`).join('\n'),
    })
  }

  // ── ④ 补充发现（模型额外给出的、不属于四类的发现；不丢） ──
  const extra: string[] = []
  for (const c of t.checks) {
    const all = c.allFindings ?? []
    // 第一条已经进了上面"四项检查"，这里从第二条开始列
    for (const f of all.slice(1)) {
      if (f.finding || f.detail) extra.push(`· ${f.finding}${f.detail ? ` —— ${f.detail}` : ''}`)
    }
  }
  if (extra.length > 0) {
    sections.push({ heading: '补充发现', body: extra.join('\n') })
  }

  // ── ⑤ 实验设计 ──
  if (t.experimentalDesign.trim()) {
    sections.push({ heading: '如果要验证它', body: t.experimentalDesign.trim() })
  }

  // ── ⑥ 致命弱点（有才显示；没有就不占位） ──
  if (t.fatalFlaws.length > 0) {
    sections.push({
      heading: '致命弱点',
      body: t.fatalFlaws.map((f) => `· ${f}`).join('\n'),
    })
  }

  /**
   * ── ⑦ 说明（问题 8：从免责声明改成"这份结论的能力边界"）──
   *
   * 旧文案是"这份报告由演示模式生成…不能当作任何依据"—— 那是把实现方式
   * 讲给用户听，且是一句全盘否定，等于作废了上面所有结论。
   *
   * 现在改成如实交代**哪些做了、哪些没做**：用户据此可以判断
   * "哪几条结论可以信、哪几条要自己补"。
   */
  if (conclusion.isMockMode) {
    sections.push({
      heading: '说明',
      body:
        '结构类检查（模块冲突 / 数据可行性 / 算力可行性）已实际完成，结论可直接参考；' +
        '新颖性依赖外部文献检索，本次未执行 —— 请把方案当作尚未查重的假设。',
    })
  }

  return {
    label: `击穿测试 · ${conclusion.overall.label}`,
    title: t.ideaTitle ?? '（未关联想法）',
    refId: t.id,
    ideaId: t.ideaId,
    subtitle: `证据强度：${evidenceLabel(t.evidenceStatus)}`,
    evidenceStatus: t.evidenceStatus,
    evidenceIds: [],
    sections,
    actions: [{ label: '查看关联想法', kind: 'gotoIdea' }],
  }
}

/**
 * 旧版「关系面板」已随问题 3 移除。
 *
 * 原实现把 Relation 渲染成「论文A → 论文B」+ 关系类型 + 依据，
 * 那是**抽象关系**视角。问题 3 之后演化视图按「问题」组织，
 * 卡片指向 ResearchDebt，详情由 problemPanel 渲染。
 * 保留这段注释是为了让后来者知道：删除是**有意的**，
 * 不是漏改了分支 —— 若将来要重新展示论文间的直接继承关系，
 * 应基于 Relation 新建面板，而不是复活旧版再打补丁。
 */

function surgeryPanel(id: string, data: LabData): PanelContent | null {
  const s = data.surgeries.find((x) => x.id === id)
  if (!s) return null

  const parsed = parseSurgeryResult(s.result)

  const sections: PanelSection[] = []

  /**
   * ── 问题 2：结构改成「一句话结论 → 3 个关键影响 → 证据 → 不确定性」 ──
   *
   * 为什么删掉了原来的「一段描述 + 四段式」：
   *   1. 描述段（s.description）只是"我做了个手术"的复述，不提供判断信息，
   *      占着最上面的位置却把结论挤到了第四段；
   *   2. 四段式的标题（对谁动刀 / 失去什么能力…）本身还需要理解成本。
   *   现在结论在第一行，用户扫一眼就知道"这个手术意味着什么"。
   */
  if (parsed) {
    const blockName =
      parsed.blockName ||
      data.papers
        .flatMap((p) => p.blocks)
        .find((b) => s.intervenedBlockIds.includes(b.id))?.name
    const summary = buildSurgerySummary(parsed, blockName)

    // ── ① 一句话结论（最显眼，无标题直接放最前） ──
    sections.push({ body: summary.headline })

    // ── ② 3 个关键影响 ──
    if (summary.keyImpacts.length > 0) {
      sections.push({
        heading: '关键影响',
        body: summary.keyImpacts
          .map((i) => `· [${i.severityLabel}] ${i.text}`)
          .join('\n'),
      })
    }

    // ── ③ 证据 ──
    //    把"依据"从术语翻译成人话：有没有直接的消融实验，
    //    以及连带影响（原「依赖风险」——那个词用户看不懂，见 humanizeDependencyRisk）
    const evidenceBits: string[] = []
    evidenceBits.push(
      parsed.hasDirectAblation
        ? `论文里有直接相关的消融实验（${parsed.ablationEvidenceIds.length} 条），这条结论有原文支撑。`
        : '论文里没有直接的消融实验，这条结论是从方法结构推出来的，不是实验测出来的。'
    )
    const dep = humanizeDependencyRisk(parsed.dependencyRisk)
    if (dep) evidenceBits.push(dep)
    sections.push({ heading: '证据', body: evidenceBits.join('\n\n') })

    // ── ④ 不确定性（有才显示；没有就不占位） ──
    const uncertainBits: string[] = [...parsed.uncertainties]
    if (summary.isMockMode) {
      /**
       * 这里原来写「当前为演示模式…」—— 那是把**实现方式**讲给用户听。
       * 用户需要知道的是"这条结论有多可靠"，不是"系统用了什么模式"。
       * 改成对可靠性的直接判断，并给出可操作的下一步。
       */
      uncertainBits.unshift(
        '这条结论由本地启发式规则推导，未经语义推理验证 —— 可当作线索，不宜当作定论。'
      )
    }
    if (uncertainBits.length > 0) {
      sections.push({
        heading: '不确定性',
        body: uncertainBits.map((u) => `· ${u}`).join('\n'),
      })
    }

    // 降级：一句话结论都没算出来时，把判定理由如实放出来，别装作有结论
    if (summary.inconclusive && parsed.verdictReason) {
      sections.push({ heading: '为什么给不出结论', body: parsed.verdictReason })
    }
  } else {
    // 降级：展示原始文本，并说明为什么没解析成功
    sections.push({
      heading: '手术结论',
      body: s.description.trim() || '（这条手术记录没有留下可读的结论）',
    })
    if (s.result?.trim()) {
      sections.push({
        heading: '原始记录',
        body: `${s.result}\n\n（这条记录的格式不是当前版本的结构化结果，无法展开成一句话结论。）`,
      })
    }
  }

  return {
    label: `方法手术 · ${verdictLabel(s.verdict ?? '')}`,
    title: s.title,
    refId: s.id,
    subtitle: s.intervenedBlockIds.length
      ? `干预 ${s.intervenedBlockIds.length} 个模块`
      : undefined,
    evidenceStatus: s.evidenceStatus,
    evidenceIds: s.evidenceIds,
    sections,
    actions: [{ label: '查看证据', kind: 'evidence' }],
  }
}

/** 把 block id 还原成「模块名（论文名）」 */
function resolveBlockLabel(blockId: string, data: LabData): string {
  for (const p of data.papers) {
    const b = p.blocks.find((x) => x.id === blockId)
    // UI ④：详情面板里论文名完整展示（这是"看全貌"的地方，不该截断）
    if (b) return `${b.name}（${p.title}）`
  }
  return ''
}

/**
 * 取论文摘要。
 *
 * 摘要存在 PaperView.abstract（由 lab/page.tsx 从 Paper.abstract 带出），
 * 不是新查询 —— RSC 聚合查询里本来就 select 了整行。
 * 没有摘要时返回空串，调用方据此决定要不要渲染"论文摘要"这一节
 * （宁可少一节，也不要印一行"（无摘要）"占位置）。
 */
function readAbstract(paperId: string | undefined, data: LabData): string {
  if (!paperId) return ''
  const p = data.papers.find((x) => x.id === paperId)
  return (p?.abstract ?? '').trim()
}

/**
 * ── P21：给"右侧详情栏"用的两个公开入口 ──
 *
 * 演化视图与债务视图改成两栏后，选中项不再来自**画布节点**，而是来自
 * 左侧列表的 id（`problem-<debtId>` 这类节点 id 只有画布那条通道才有）。
 *
 * 为什么不让调用方自己拼节点 id：
 *   节点 id 的拼法（前缀 + 原始 id）散在调用方，一旦 `node-ids.ts` 改前缀，
 *   这些手拼的地方全会静默失效；而且"伪造一个 LayoutNode"去骗
 *   buildPanelContent 的卡片分支，本身就是把内部结构当接口用。
 *
 * 这两个包装函数直接调私有构造器（同一文件内可见），
 * 保证**详情内容与底部面板完全同源**，不会出现两套措辞。
 */
export function panelForDebt(debtId: string, data: LabData): PanelContent | null {
  return debtPanel(debtId, data)
}

export function panelForProblem(problemId: string, data: LabData): PanelContent | null {
  return problemPanel(problemId, data)
}

/**
 * ── P21：演化视图「选中论文」的详情 ──
 *
 * 产品要求右栏给的是**选中论文**的详情：标题 / 问题 / 方法 / 结果 / 证据。
 * 这不是某一条债务的面板（那条走 panelForProblem），而是"这篇论文在本项目里
 * 与哪些问题相关、分别怎么处理、结果如何"的汇总视图 —— 所以单独在这里组装，
 * 数据全部来自已有的 debts.sources / debts.attempts，没有任何新查询。
 */
export function panelForPaper(paperId: string, data: LabData): PanelContent | null {
  const p = data.papers.find((x) => x.id === paperId)
  if (!p) return null

  const related = data.debts.filter((d) => d.sources.some((s) => s.paperId === paperId))
  const sections: PanelSection[] = []

  // ① 问题：这篇论文碰到了哪些跨论文问题
  if (related.length > 0) {
    sections.push({
      heading: '关联的研究问题',
      body: related
        .map((d) => {
          const info = deriveProblemStatus(d)
          return `· ${d.title}（${info.label}）`
        })
        .join('\n'),
    })
  } else {
    sections.push({
      heading: '关联的研究问题',
      body: '收录内容里没有把这篇论文关联到任何跨论文研究问题。',
    })
  }

  // ② 方法 + 结果：逐条列出它自己的尝试
  const attempts = related.flatMap((d) =>
    d.attempts.filter((a) => a.paperId === paperId).map((a) => ({ debt: d, a }))
  )
  if (attempts.length > 0) {
    sections.push({
      heading: '方法与结果',
      body: attempts
        .map(
          ({ debt, a }) =>
            `【${debt.title}】\n方法：${a.description || '（未记录）'}\n结果：${
              a.outcome || '（未说明）'
            }`
        )
        .join('\n\n'),
    })
  }

  // ②b 各论文的处理：同一个问题，别篇论文是怎么做的
  //
  // ── 为什么这一节必须存在 ──
  // 「演化」这个视图的意义就是**横着比**：不是只看这篇论文做了什么，
  // 而是看同一个问题在不同论文上被怎么处理。右栏给的是单篇详情，
  // 如果只列它自己，"演化"的读感就丢了。
  //
  // 用《论文名》包住标题：那是可核对的**出处**，与债务面板的
  // 「涉及的论文」同一约定 —— 全站统一，不另造写法。
  const withAttempts = related.filter((d) => d.attempts.length > 0)
  if (withAttempts.length > 0) {
    const lines: string[] = []
    for (const d of withAttempts) {
      lines.push(`【${d.title}】`)
      for (const a of d.attempts) {
        const other = data.papers.find((x) => x.id === a.paperId)
        const name = other?.title ?? a.paperTitle ?? '（未知论文）'
        lines.push(`  《${name}》：${a.outcome || '（未说明结果）'}`)
      }
      lines.push('')
    }
    sections.push({ heading: '各论文的处理', body: lines.join('\n').trim() })
  }

  // ③ 摘要（有才显示）
  const abs = readAbstract(paperId, data)
  if (abs) {
    sections.push({ heading: '查看详情 · 论文摘要', body: abs.slice(0, 900) })
  }

  // ④ 证据 —— 论文这一层没有 evidenceStatus 字段（那是 block / debt 级的概念），
  //    所以这里只收集证据 id 交给抽屉，不硬造一个证据强度。
  const paperEvidenceIds = Array.from(
    new Set([...data.evidence.filter((e) => e.paperId === paperId).map((e) => e.id)])
  )
  if (paperEvidenceIds.length > 0) {
    sections.push({
      heading: '查看详情 · 证据',
      body: `这篇论文贡献了 ${paperEvidenceIds.length} 条证据条目，点下方「查看证据」逐条核对原文。`,
    })
  }

  return {
    label: `论文 · ${p.year ?? '年份未知'}`,
    title: p.title,
    subtitle: `${p.blocks.length} 个方法模块`,
    evidenceStatus: undefined,
    evidenceIds: paperEvidenceIds,
    sections,
    actions: [{ label: '查看证据', kind: 'evidence' }],
    refId: p.id,
  }
}
