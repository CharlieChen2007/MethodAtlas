'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CanvasStage } from '@/components/lab/CanvasStage'
import { TopBar } from '@/components/lab/TopBar'
import { LeftRail } from '@/components/lab/LeftRail'
import { BottomPanel } from '@/components/lab/BottomPanel'
import { DetailRail } from '@/components/lab/DetailRail'
import { TimelineList, DebtList } from '@/components/lab/ViewLists'
import { Dashboard } from '@/components/lab/Dashboard'
import { ConfirmDialog } from '@/components/lab/ConfirmDialog'
import { CrashIdeaTabs } from '@/components/lab/CrashIdeaTabs'
import { CrashIdeaCards } from '@/components/lab/CrashIdeaCards'
import { CrashReportDock } from '@/components/lab/CrashReportDock'
import { CrashComparePanel } from '@/components/lab/CrashComparePanel'
import { CrashChatPanel, type ChatTurn } from '@/components/lab/CrashChatPanel'
import { ActionBar, useActionFeedback } from '@/components/lab/ActionBar'
import { IdeaWorkbench } from '@/components/lab/IdeaWorkbench'
import { useEvidenceDrawer, type EvidenceItem } from '@/components/EvidenceDrawer'
import {
  buildViewLayout,
  findBlockName,
  intervenedBlockIdsOf,
  latestSurgeryForBlock,
} from '@/lib/lab/view-layout'
import { buildPanelContent, panelForDebt, panelForPaper, type PanelContent } from '@/lib/lab/panel'
import { nodeId, BLOCK_ID_PREFIX, SURGERY_ID_PREFIX, IDEA_ID_PREFIX, CRASH_ID_PREFIX } from '@/lib/lab/node-ids'
import { buildWorkflow } from '@/lib/lab/workflow'
import {
  surgeryAction,
  deleteSurgeryAction,
  evolutionAction,
} from '@/lib/actions/lab-actions'
import {
  crossbreedAction,
  crashTestAction,
  debtAction,
  resetUserDataAction,
  createCustomBlockAction,
  crashChatAction,
} from '@/lib/actions/p4-actions'
import { SurgeryAction } from '@/lib/enums'
import { ZONE_BY_VIEW, type LabZone } from '@/lib/lab/zones'
import {
  VIEW_IDS,
  VIEW_META,
  getAvailability,
  type LabData,
  type ViewId,
} from '@/lib/lab/views'
import { VIEW_SOFT_BORDER, VIEW_PATTERN, viewColor } from '@/lib/lab/palette'
import { buildDashboard } from '@/lib/lab/dashboard'
import type { LayoutNode } from '@/lib/lab/layout'

export type { LabData }

/**
 * 单页画布的状态中枢 + **按钮到后端的接线层**。
 *
 * 为什么用 useReducer 而不是 4 个 useState：
 *   view / paperId / selectedId 三者是联动的（切视图要清选中，切论文要清选中），
 *   拆成多个 setState 需要写多组同步逻辑，容易漏。reducer 把"状态转移"显式化。
 *
 * 为什么用 history.replaceState：
 *   产品要求「单页应用，所有功能在同一个路由内切换」且「不跳页」。
 *   用 router.push 会触发 App Router 的重新渲染（RSC 会重新请求），
 *   用 replaceState 只改地址栏、不触发导航 —— 既是单页、又能分享链接。
 *
 * ── P7-3：按钮如何接后端 ──
 *   所有动作走已存在的 server action（不新造 API 路由）：
 *     运行方法手术   → surgeryAction({blockId, action:'REMOVE'})
 *     运行演化分析   → evolutionAction(projectId)
 *     重新生成组合   → crossbreedAction(projectId)
 *     运行击穿测试   → crashTestAction(ideaId)
 *     围绕债务生成想法 → **不调后端**，切 idea 视图 + 预填 debtId
 *     查看证据       → 已通的证据抽屉
 *
 *   ── 上传论文是唯一的例外：走 Route Handler，不是 server action ──
 *     上传论文       → fetch('/api/upload')（见下方 handleUpload）
 *
 *   原因见 handleUpload 的注释：老的 server action `uploadPaper`
 *   ① 从不抽取方法 DNA（上传进来的论文永远没有结构），
 *   ② 解析失败只 console.error 且返回 void，前端无从得知。
 *   更糟的是它还依赖一个独立进程（Python parser-service，8000 端口），
 *   服务没起时论文被静默标成 FAILED。现在 /api/upload 在进程内用 pdfjs
 *   解析，**不依赖任何外部服务**；该 action 已随死代码清理一并删除。
 *
 *   action 返回真实结果（message/detail），交给 ActionBar 如实呈现；
 *   跑完后调用 router.refresh() 让 RSC 聚合查询重新取数（不跳页），
 *   画布随即反映真实的数据变化。
 */

interface State {
  view: ViewId
  paperId: string
  /** 画布上被选中的节点 id（结构树是 block-xxx，卡片是 debt-xxx 等） */
  selectedId: string | null
  /**
   * 债务上下文 —— 债务→想法 这条链的目标债务。
   * 既可能来自"点了围绕它生成想法"（跳转预填），也可能来自 URL 直连。
   */
  contextDebtId: string | null
  /** 想法上下文 —— 想法→击穿 / 击穿→想法 这条链的目标想法 */
  contextIdeaId: string | null
  /** 来源步骤 —— 目前仅 'surgery'（手术→演化 这条链） */
  fromStep: 'surgery' | null
  /**
   * ── 手术（剪刀）模式（问题 2）──
   *
   * true = 用户点了画布右上角的剪刀，光标变 crosshair，
   * 画布上所有可切模块加红色虚线轮廓，点它们就地动刀。
   *
   * 为什么放进 state 而不是组件内 useState：
   *   它需要被 URL（?surgery=1，旧路由重定向进来）和视图切换共同控制 ——
   *   切走 DNA 视图就该自动退出剪刀模式（画布上已经没有可切的块了）。
   *   放 reducer 里，这些规则集中在一处，不会散落到各处 useEffect。
   */
  surgeryMode: boolean
  /**
   * ── 问题 2：工作台勾选写进 URL ──
   *
   * 组合想法视图里，用户勾了哪些模块 / 哪些债务，必须能在
   * 「切走再切回来」「刷新页面」「把链接发给同事」三种情况下原样恢复。
   * 只在 IdeaWorkbench 里用 useState 记，切个视图就归零了 ——
   * 用户回头一看"我挑的半天的东西没了"，这是实打实的返工。
   *
   * 所以把这份勾选提升为**受控状态**：真值在 LabShell 的 state（进而写进
   * URL），IdeaWorkbench 只负责渲染与上报变更（onSelectionChange）。
   * 这样 URL 就是唯一事实源，恢复逻辑不需要在工作台里再写一遍。
   */
  pickedBlockIds: string[]
  pickedDebtIds: string[]
  /**
   * ── 问题 4：这个工作台"跑过生成"没有 ──
   *
   * 「还没有生成过组合」和「生成了但 0 个候选」是两件事：
   * 前者是"你还没开始"，后者是"你跑了，关卡把候选全拦下了，该改选材"。
   * 光看 data.ideas.length === 0 分不清这两者（都是 0），
   * 所以需要一个独立的"跑过"标记 —— 用户点过「生成组合」并成功返回就置 1。
   *
   * 写进 URL（?ran=1）而不是只放内存：跑完后刷新页面，
   * 那条"已运行生成，但没有产生候选方案"的提示应当还在 ——
   * 否则用户会以为自己没点过。
   */
  hasRun: boolean
  /**
   * ── 需求 B：击穿测试里选中的想法（可多选）──
   *
   * 需求 B 把「已生成的想法」列表从组合想法搬到了击穿测试，并且要求
   * 「用户先选想法再运行击穿，结果与所选想法绑定」。这份选中集合就是
   * 击穿视图的运行输入。
   *
   * 与 pickedBlockIds 同构：真值放 state → 写进 URL（?crashIdeaIds=a,b），
   * 刷新 / 分享链接 / 两视图往返都不丢。
   * 只在 view === 'crashtest' 时写 URL —— 离开击穿视图这份选中仍有意义
   * （回来还要用），所以不像 contextIdeaId 那样在切视图时清空。
   */
  crashIdeaIds: string[]
}

type Action =
  | { type: 'setView'; view: ViewId }
  | { type: 'setPaper'; paperId: string }
  | { type: 'select'; id: string | null }
  | { type: 'toggleSurgery' }
  | { type: 'setSurgeryMode'; on: boolean }
  | { type: 'gotoIdeaWithDebt'; debtId: string; firstIdeaNodeId: string | null }
  | { type: 'gotoCrashFromIdea'; ideaId: string; firstCrashNodeId: string | null }
  | { type: 'gotoIdeaFromCrash'; ideaId: string; targetIdeaNodeId: string | null }
  | { type: 'gotoEvolutionFromSurgery' }
  | { type: 'clearPrefill' }
  /** 问题 2：工作台勾选变化 → 写进 state（进而写进 URL） */
  | { type: 'setPicked'; blockIds: string[]; debtIds: string[] }
  /** 问题 4：生成动作成功返回 → 记下"跑过" */
  | { type: 'markRun' }
  /** 需求 A：一键重置 —— 清空"运行态"，保留基础数据 */
  | { type: 'resetRun' }
  /** 需求 B：击穿测试里选中的想法集合变化 */
  | { type: 'setCrashIdeas'; ideaIds: string[] }
  | {
      type: 'syncFromUrl'
      view: ViewId
      paperId: string
      selectedId: string | null
      contextDebtId: string | null
      contextIdeaId: string | null
      fromStep: 'surgery' | null
      /** URL 带债务上下文且落在 idea 时，自动选中首张想法卡以打开面板 */
      firstIdeaNodeId: string | null
      /** URL 带 ?surgery=1（旧方法手术路由重定向）→ 落地即进入剪刀模式 */
      surgeryMode: boolean
      /** 问题 2：从 URL 恢复的勾选（已按存在性过滤） */
      pickedBlockIds: string[]
      pickedDebtIds: string[]
      /** 问题 4：从 URL 恢复的"跑过"标记 */
      hasRun: boolean
      /** 需求 B：从 URL 恢复的击穿想法选中（已按存在性过滤） */
      crashIdeaIds: string[]
    }

/**
 * 进入某个视图时的**默认选中**。
 *
 * ── P19 减展示 4：改为「什么都不选中」──
 *
 * 旧行为：DNA 视图默认选中 root 并自动展开底部面板（P7 的产品要求）。
 * 本轮产品要求「底部面板默认折叠、高度 0；点击节点后滑出；点击空白处收回」，
 * 且「一屏只有 1 个视觉焦点（画布）」—— 进页面就弹出一个 38vh 的详情面板
 * 正好与这两条冲突，所以默认选中被去掉：画布干净、面板关着，
 * 用户点哪个节点才展开哪个节点的详情。
 *
 * 保留成函数（而不是删掉默认逻辑）是因为调用点有五处，语义仍是
 * "切视图时该选中什么"，将来若要给某个视图加回默认选中，改这里一处即可。
 */
function defaultSelectionFor(_view: ViewId): string | null {
  return null
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'setView':
      // 切视图必须重设选中：选中项的语义随视图变化，跨视图保留会指向不存在的东西。
      // 但 dna 视图有默认选中（root），所以不是简单清空。
      //
      // 上下文清理同样必须显式（P7-4）：三种上下文各有自己"该出现的视图"，
      // 切走就清掉 —— 否则从击穿切回 DNA 还挂着"针对想法 X"的横条，是脏状态。
      return {
        ...state,
        view: action.view,
        selectedId: defaultSelectionFor(action.view),
        contextDebtId: action.view === 'idea' ? state.contextDebtId : null,
        contextIdeaId: action.view === 'crashtest' ? state.contextIdeaId : null,
        fromStep: action.view === 'evolution' ? state.fromStep : null,
        // 剪刀模式只在 DNA 结构图上成立 —— 切到别的视图自动退出，
        // 否则会出现"光标还是剪刀、但画布上全是卡片"的矛盾状态
        surgeryMode: action.view === 'dna' ? state.surgeryMode : false,
      }
    case 'setPaper':
      return { ...state, paperId: action.paperId, selectedId: null }
    case 'select':
      return { ...state, selectedId: action.id }
    case 'toggleSurgery':
      return { ...state, surgeryMode: !state.surgeryMode }
    case 'setSurgeryMode':
      return { ...state, surgeryMode: action.on }
    case 'gotoIdeaWithDebt':
      /**
       * 「围绕它生成组合想法」：不调后端，只做视图跳转 + 预填债务。
       *
       * 为什么还要选中第一张想法卡：
       *   预填提示渲染在**底部面板里**，而面板只在有选中项时展开。
       *   如果只切视图不选中，用户跳到 idea 视图会看到面板是关着的，
       *   那条"已带上目标债务 X"的提示根本看不见 —— 跳转等于白跳。
       *   所以这里顺带选中一张卡，把面板打开，让预填状态可见。
       *
       *   选中哪一张：传进来的第一个想法节点（跨状态计算，reducer 保持纯净）。
       *   没有想法卡时（idea 为空）就不选中，此时空态主体会给出下一步。
       */
      return {
        ...state,
        view: 'idea',
        selectedId: action.firstIdeaNodeId,
        contextDebtId: action.debtId,
        contextIdeaId: null,
        fromStep: null,
      }
    case 'gotoCrashFromIdea':
      /**
       * 想法 → 击穿：跑完击穿测试后自动落到击穿视图，并带上"针对哪个想法"。
       * 同 gotoIdeaWithDebt 的道理，选中一张击穿卡把面板打开。
       *
       * 需求 B：顺带把刚跑完的这个想法并入击穿列表的选中集合 ——
       * 用户刚在想法视图点了「运行击穿」，到了击穿视图这条链的"输入"
       * 就应该是那个想法，否则列表里一个都没选、运行按钮还是灰的，
       * 用户得再手动勾一次，体验上等于跳转没生效。
       */
      return {
        ...state,
        view: 'crashtest',
        selectedId: action.firstCrashNodeId,
        contextIdeaId: action.ideaId,
        contextDebtId: null,
        fromStep: null,
        crashIdeaIds: state.crashIdeaIds.includes(action.ideaId)
          ? state.crashIdeaIds
          : [...state.crashIdeaIds, action.ideaId],
      }
    case 'gotoIdeaFromCrash':
      /** 击穿 → 想法：点击穿卡里的「查看想法」，回到它对应的想法并选中 */
      return {
        ...state,
        view: 'idea',
        selectedId: action.targetIdeaNodeId,
        contextIdeaId: action.ideaId,
        contextDebtId: null,
        fromStep: null,
      }
    case 'gotoEvolutionFromSurgery':
      /**
       * 手术 → 演化：跑完演化分析后落到演化视图，并标记"从手术过来的"。
       * 画布顶部的上下文横条据此显示"本次手术干预了 N 个 Block"。
       */
      return {
        ...state,
        view: 'evolution',
        selectedId: null,
        fromStep: 'surgery',
        contextDebtId: null,
        contextIdeaId: null,
      }
    case 'clearPrefill':
      return { ...state, contextDebtId: null }
    case 'setPicked':
      /**
       * 问题 2：工作台勾选变化。
       *
       * 为什么直接覆盖而不是合并：工作台上报的是**完整**勾选集合
       * （它自己维护 Set，再一次性转成数组传上来），所以覆盖即正确。
       * 合并反而会把"取消勾选"丢掉 —— 那是本题要修的病。
       */
      return { ...state, pickedBlockIds: action.blockIds, pickedDebtIds: action.debtIds }
    case 'markRun':
      return { ...state, hasRun: true }
    case 'setCrashIdeas':
      /**
       * 需求 B：击穿测试选中的想法集合。
       * 与 setPicked 同构 —— CrashRunBar 上报完整集合，覆盖即正确。
       */
      return { ...state, crashIdeaIds: action.ideaIds }
    case 'resetRun':
      /**
       * 需求 A：一键重置（一级重置 —— 清"运行态"）。
       *
       * 只回到"这次运行之前"，绝不碰基础数据：论文 / DNA / 演化关系 /
       * 债务库都还在 data 里（那些是数据库里没被删的行，不是 state）。
       *
       * 清哪些：
       *   - 目标债务（contextDebtId）、想法上下文（contextIdeaId）、来源步骤
       *   - 已选模块 / 已选债务（pickedBlockIds / pickedDebtIds）
       *   - "跑过"标记（hasRun）→ 空态文案回到"你还没开始"
       *   - 击穿视图选中的想法（crashIdeaIds）→ 结果与选中的绑定一并归一
       *   - 选中项（selectedId）→ 面板自动收起（面板只在有选中项时展开）
       *   - 剪刀模式 → 回到普通光标
       *
       * ⚠️ 已生成的想法本体不在这里清 —— 那需要落库（resetUserDataAction）。
       *    单点「重置」只清前端运行态；要连想法一起清，走「彻底重置」。
       *
       * view 保持不变：重置不该把用户从当前视图弹走。用户在
       * 击穿测试页点重置，就应该还站在击穿测试页上看它变干净。
       */
      return {
        ...state,
        selectedId: defaultSelectionFor(state.view),
        contextDebtId: null,
        contextIdeaId: null,
        fromStep: null,
        surgeryMode: false,
        pickedBlockIds: [],
        pickedDebtIds: [],
        hasRun: false,
        crashIdeaIds: [],
      }
    case 'syncFromUrl': {
      /**
       * URL 回读。补一条关键逻辑：
       *   若 URL 带了债务上下文且落在 idea 视图，必须自动选中一张想法卡 ——
       *   否则面板关着，那条预填提示看不见（与 gotoIdeaWithDebt 同一个坑）。
       */
      let selectedId = action.selectedId ?? defaultSelectionFor(action.view)
      if (!action.selectedId && action.view === 'idea' && action.contextDebtId) {
        selectedId = action.firstIdeaNodeId
      }
      return {
        view: action.view,
        paperId: action.paperId,
        selectedId,
        contextDebtId: action.contextDebtId,
        contextIdeaId: action.contextIdeaId,
        fromStep: action.fromStep,
        // 剪刀模式只在 DNA 视图有意义 —— 与 setView 同一纪律
        surgeryMode: action.view === 'dna' ? action.surgeryMode : false,
        // 问题 2/4：勾选与"跑过"标记从 URL 恢复（readUrl 已做存在性过滤）
        pickedBlockIds: action.pickedBlockIds,
        pickedDebtIds: action.pickedDebtIds,
        hasRun: action.hasRun,
        // 需求 B：击穿想法选中同样从 URL 恢复（已做存在性过滤）
        crashIdeaIds: action.crashIdeaIds,
      }
    }
  }
}

/**
 * 从 URL 读取全部状态（仅客户端调用）。
 *
 * 健壮性纪律（P7-4 新增 debtId/ideaId 后尤其重要）：
 *   **每个 id 都必须校验存在性**，不存在就置 null。
 *   绝不能把 URL 里的脏 id 塞进 state —— 否则面板会因为找不到对应数据
 *   而渲染成空白，用户还以为是 bug。
 */
function readUrl(
  papers: { id: string }[],
  debts: { id: string }[],
  ideas: { id: string }[],
  crashTests: { id: string }[],
  blocks: { id: string }[]
): {
  view: ViewId
  paperId: string
  contextDebtId: string | null
  contextIdeaId: string | null
  fromStep: 'surgery' | null
  firstIdeaNodeId: string | null
  surgeryMode: boolean
  pickedBlockIds: string[]
  pickedDebtIds: string[]
  hasRun: boolean
  crashIdeaIds: string[]
} {
  const sp = new URLSearchParams(window.location.search)

  const v = sp.get('view')
  const view = (VIEW_IDS as readonly string[]).includes(v ?? '') ? (v as ViewId) : 'dna'

  const pid = sp.get('paper')
  const paperId = papers.some((p) => p.id === pid) ? (pid as string) : (papers[0]?.id ?? '')

  const d = sp.get('debtId')
  const contextDebtId = debts.some((x) => x.id === d) ? (d as string) : null

  const i = sp.get('ideaId')
  const contextIdeaId = ideas.some((x) => x.id === i) ? (i as string) : null

  // from 只认 'surgery' 一个值 —— 白名单，避免任意字符串进 state
  const f = sp.get('from')
  const fromStep = f === 'surgery' ? 'surgery' : null

  // URL 直连进 idea 且带债务时，要能自动打开面板（选中首张想法卡）
  const firstIdeaNodeId = ideas[0] ? `idea-${ideas[0].id}` : null

  // ?surgery=1 → 落地即进入剪刀模式（旧方法手术路由重定向用）
  const surgeryMode = sp.get('surgery') === '1'

  /**
   * ── 问题 2：恢复勾选（逗号分隔的 id 列表）──
   *
   * 纪律同上面各 id：**逐个校验存在性**，过滤掉已删除的模块/债务。
   * 若不校验，一条被删掉的 debtId 留在 URL 里，工作台会渲染一个
   * "选中的幽灵债务"——右栏显示"目标债务：1"，左栏却找不到对应行。
   */
  const blockIds = (sp.get('blockIds') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && blocks.some((b) => b.id === x))
  const pickedBlockIds = Array.from(new Set(blockIds))

  const debtIds = (sp.get('debtIds') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && debts.some((dd) => dd.id === x))
  const pickedDebtIds = Array.from(new Set(debtIds))

  // ?ran=1 → 这个工作台跑过生成（用于零结果三态判定）
  const hasRun = sp.get('ran') === '1'

  /**
   * ── 需求 B：恢复击穿测试选中的想法（?crashIdeaIds=a,b）──
   *
   * 纪律与 blockIds / debtIds 完全一致：逐个校验存在性。
   * 想法被删掉后，URL 里残留的 id 不该让击穿列表出现"幽灵勾选"。
   */
  const crashIds = (sp.get('crashIdeaIds') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && ideas.some((it) => it.id === x))
  const crashIdeaIds = Array.from(new Set(crashIds))

  return {
    view,
    paperId,
    contextDebtId,
    contextIdeaId,
    fromStep,
    firstIdeaNodeId,
    surgeryMode,
    pickedBlockIds,
    pickedDebtIds,
    hasRun,
    crashIdeaIds,
  }
}

/**
 * 初始状态必须是**确定性**的（固定 dna + 第一篇论文），不能读 URL。
 *
 * 因为 useReducer 的初始值在 SSR 与服务端首帧都会执行，而服务端没有
 * window.location —— 若初始值依赖 URL，服务端渲染的是默认视图、客户端
 * 首帧渲染的是 URL 里的视图，两棵树的属性不一致 → hydration 报错。
 *
 * 注意：初始 view 是 dna，所以 selectedId 直接取默认值 'root'，
 * 与服务端首帧一致（dna 的默认选中是常量，不依赖 URL）。
 *
 * 正确做法：初始值固定，然后在 useEffect 里用 readUrl 覆盖一次。
 * 这会有"闪一下"的成本，但只在带 ?view= 参数直连时发生，可以接受。
 */
function initState(papers: { id: string }[]): State {
  const view: ViewId = 'dna'
  return {
    view,
    paperId: papers[0]?.id ?? '',
    selectedId: defaultSelectionFor(view),
    contextDebtId: null,
    contextIdeaId: null,
    fromStep: null,
    // 初始不开剪刀模式：服务端首帧与客户端一致（都 false），避免 hydration 抖动
    surgeryMode: false,
    // 勾选与"跑过"标记同样必须确定性初始化（服务端没有 URL）——
    // 空的数组/布尔与客户端首帧一致，随后由 useEffect 里的 readUrl 覆盖
    pickedBlockIds: [],
    pickedDebtIds: [],
    hasRun: false,
    // 需求 B：击穿想法选中同样确定性初始化（服务端无 URL），随后被 readUrl 覆盖
    crashIdeaIds: [],
  }
}

export function LabShell({ data }: { data: LabData }) {
  const [state, dispatch] = useReducer(reducer, data.papers, initState)
  const { view, paperId, selectedId, contextDebtId, contextIdeaId, fromStep, surgeryMode } = state
  const drawer = useEvidenceDrawer()
  const router = useRouter()
  const feedback = useActionFeedback()

  /** 上传中的论文名 —— 用于回显"正在解析 xxx.pdf" */
  const [uploadingName, setUploadingName] = useState<string | null>(null)

  /**
   * ── 需求 A：重置的二次确认 ──
   *
   * null = 没在确认；'run' = 一级重置确认中；'data' = 二级重置确认中。
   * 用 ConfirmDialog 而不是 window.confirm：原生弹窗会阻塞 JS 主线程，
   * 让 Playwright 以"超时"这种无信息量的方式失败（详见组件注释）。
   */
  const [confirm, setConfirm] = useState<'run' | 'data' | null>(null)

  /**
   * ── P11 问题 4：重置动画（"回到初始"的视觉回执）──
   *
   * 重置成功后给画布上的重置簇加一个 300ms 的透明度回落动画
   * （.anim-reset，见 globals.css），让"已经清干净了"看得见。
   *
   * 为什么不用 CSS animation-play-state 或保持常开：
   *   动画必须**只在重置发生时播放一次**。用 state 置位 + 定时归零，
   *   class 加上 → 动画播完 → class 摘掉，下一次重置还能再播。
   *   450ms 略长于动画时长（300ms），避免掐尾。
   *
   * 为什么放 LabShell 而不是 CanvasStage 内部：
   *   触发时机由 handleResetRun/handleResetData（动作完成回调）决定，
   *   真值在这里；CanvasStage 只消费 prop。
   *
   * ── P14 改造：state → nonce ──
   * 旧版是 LabShell 持一个布尔 + 450ms 定时器，喂给两处 ResetCluster。
   * P14 把动画下沉到组件内部：这里只递增一个 nonce（重置次数），
   * ResetCluster 自己监听 nonce 变化、自己播 450ms 动画、自己清理定时器。
   * 好处：动画的生命周期与组件共存亡（卸载即停），
   * LabShell 不再持有"动画进行中"这种表现层状态。
   */
  const [resetNonce, setResetNonce] = useState(0)
  const triggerResetAnim = useCallback(() => {
    setResetNonce((n) => n + 1)
  }, [])

  /**
   * ── P12 问题 3：AI 对话的会话历史 ──
   *
   * 按 ideaId 分桶（切换想法 → 显示各自的会话，互不污染）。
   * 为什么放 LabShell 而不是 CrashChatPanel 内部：
   *   面板只在 crashtest 视图挂载，切走视图就卸载 —— 内部 state
   *   会让"切去组合想法看一眼再回来"丢掉对话。LabShell 全程不卸载。
   * 为什么不进 reducer/URL：会话是过程数据，不是可分享的页面状态。
   * resetRun 时在这里整体清空（reducer 管不到组件外的 useState）。
   */
  const [chats, setChats] = useState<Record<string, ChatTurn[]>>({})
  /** 面板当前讨论的想法 id（默认跟随列表选中，用户可手动切换话题） */
  const [chatActiveId, setChatActiveId] = useState<string | null>(null)

  /**
   * ── P19 减展示 2：左侧导航栏默认折叠 ──
   *
   * 48px 窄条（视图字形 + 重置 + logo），展开才显示完整导航
   * （流程 7 步 / 论文切换 / 两级重置）。产品要求「一屏只有 1 个
   * 视觉焦点」，导航是"我要去哪"的低频动作，不该常驻 248px。
   */
  const [railCollapsed, setRailCollapsed] = useState(true)

  /** P19 减展示 5：AI 讨论面板的开关（右下角浮动按钮控制） */
  const [chatOpen, setChatOpen] = useState(false)

  /**
   * ── P21：右侧详情栏的选中对象 ──
   *
   * 演化视图的详情主语是**论文**，债务视图是**债务**。
   * 这两个选中项不进 URL、不进 reducer：它们是"临时看一眼"的浏览状态，
   * 不是可分享的页面状态（URL 里的 paper/debtId 表示的是"从哪条链过来"，
   * 语义不同，混进去会让链接变含糊）；切走视图清空即可。
   */
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null)
  const [selectedDebtId, setSelectedDebtId] = useState<string | null>(null)

  /**
   * ── P19/P21：对比抽屉是否打开 ──
   *
   * 抽屉是覆盖中栏的模态层；打开时**卸载**下面的击穿报告（不是标 inert ——
   * 实测 inert 只影响交互、元素仍占几何，零重叠扫描照样算它）。
   */
  const [compareOpen, setCompareOpen] = useState(false)

  /**
   * ── P21（B 方案）：底部数据看板的开合 ──
   * 产品要求**默认展开**；折叠时画布占 100% 高度。
   * 与 compareOpen 一样属于"临时看一眼"的浏览状态，不进 URL、不进 reducer。
   */
  const [dashOpen, setDashOpen] = useState(true)

  /**
   * ── P18 开场页 ──
   *
   * 三态：
   *   'show'   开场页盖在最上（工作台 opacity:0 预先就位）
   *   'fading' 交叉过渡中：开场页淡出 & 工作台淡入**同时**进行（各 500ms）
   *   'gone'   过渡结束，开场页卸载（DOM 移除 = display:none 的等价物）
   *
   * 跳过逻辑（sessionStorage['intro-seen']）：同一浏览器会话（标签页
   * 存活期间）只显示一次；关掉标签页再打开 sessionStorage 清空 → 重新显示。
   *
   * 为什么用 isomorphic layout effect 而不是 useEffect 做跳过判定：
   *   useEffect 在首帧**绘制之后**才跑 —— 会话内第二次进来会先闪一帧
   *   开场页再消失。layout effect 在绘制前执行，直接以 'gone' 起步。
   *
   * 为什么不拆成独立组件包 children：工作台淡入需要操作 LabShell
   * 根元素的 opacity（开场页与工作台是兄弟、交叉两层动画），
   * 状态放本组件最近手边。
   */
  const [intro, setIntro] = useState<'show' | 'fading' | 'gone'>('show')
  const useIntroSkipEffect =
    typeof window === 'undefined' ? useEffect : useLayoutEffect
  useIntroSkipEffect(() => {
    try {
      if (window.sessionStorage.getItem('intro-seen') === '1') setIntro('gone')
    } catch {
      /* sessionStorage 被禁用时按"没看过"处理，显示开场页 */
    }
  }, [])
  const beginExploring = useCallback(() => {
    try {
      window.sessionStorage.setItem('intro-seen', '1')
    } catch {
      /* 忽略：极端环境写不进也不影响本次过渡 */
    }
    setIntro('fading')
    // 520ms 略长于 500ms 过渡，掐掉尾帧前先让动画播完
    window.setTimeout(() => setIntro('gone'), 520)
  }, [])

  /**
   * ── 问题 4：刚刚被恢复的 block（一次性回执）──
   *
   * 恢复会删库记录，数据层回到"完好"，用户看不到任何变化。
   * 这个 state 只用来在底部面板压一行"已恢复"；它**不参与任何状态判定**，
   * 判定永远看 data.surgeries（见 latestSurgeryForBlock）。
   */
  const [justRestoredBlockId, setJustRestoredBlockId] = useState<string | null>(null)

  /**
   * ── 离线模式徽标：真模型降级标记 ──
   *
   * 为什么需要轮询，而不是把状态当 props 传进来：
   *   降级是**运行期事件**（发生在用户点"抽取方法结构"之后），
   *   而本组件的 props 是那一刻之前由 Server Component 渲染的。
   *   当 props 用的话值会永远停在"未降级"，除非用户手动刷新 ——
   *   徽标就等于看不见。
   *
   * 轮询策略：
   *   · 每 5 秒问一次 /api/llm-status。这个频率足够"用户跑完一个动作
   *     回头看画布时就已经亮了"，又不会给本地 dev server 造成压力。
   *   · 一旦拿到 degraded=true 就**停止轮询**（clearInterval）——
   *     降级是粘性状态，见过一次就够，没必要一辈子问下去。
   *   · 组件卸载时清理定时器，避免 dev 模式 HMR 下堆积。
   */
  const [degradedReason, setDegradedReason] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false

    const check = async () => {
      try {
        const res = await fetch('/api/llm-status', { cache: 'no-store' })
        if (!res.ok) return
        const json = (await res.json()) as { degraded?: boolean; degradedReason?: string | null }
        if (stopped) return
        if (json.degraded) {
          /**
           * P18 全局约束：界面不出现任何模型名称。
           * 降级原因来自服务端的 LLMError.message，其中可能内嵌
           * 「模型「xxx」…」这类具体名字 —— 显示前统一脱敏成「模型」，
           * 诊断细节留给服务端日志。
           */
          const sanitized = (json.degradedReason || '真模型调用失败').replace(
            /模型「[^」]*」/g,
            '模型'
          )
          setDegradedReason(sanitized)
          stopped = true
          // 已经拿到答案，不用再问
          window.clearInterval(timer)
        }
      } catch {
        /* 状态接口本身失败不该影响页面 —— 静默忽略，下次再试 */
      }
    }

    void check()
    const timer = window.setInterval(check, 5000)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [])

  /** 「查看证据」动作：把证据 id 翻译成抽屉要的 EvidenceItem 并打开 */
  const openEvidence = useCallback(
    (ids: string[], title: string) => {
      const items: EvidenceItem[] = ids
        .map((id) => data.evidence.find((e) => e.id === id))
        .filter(Boolean)
        .map((e) => {
          const ev = e!
          return {
            id: ev.id,
            source: ev.source as EvidenceItem['source'],
            status: ev.status as EvidenceItem['status'],
            quote: ev.quote,
            section: ev.section,
            pageNumber: ev.pageNumber,
            confidence: ev.confidence,
            paperTitle: ev.paperTitle,
            // 问题 5：带上 paperId，证据抽屉据此拼「打开 PDF 对应页」链接
            paperId: ev.paperId,
          }
        })
      drawer.open(items, title)
    },
    [data.evidence, drawer]
  )

  /**
   * 跑完一个 server action 之后刷新 RSC 聚合查询。
   *
   * 为什么用 router.refresh() 而不是 router.push(同路由)：
   *   refresh() 重新执行当前路由的 Server Component（重新查库），
   *   但**不改变 URL、不重置客户端 state**（reducer 里的 view/选中都保留），
   *   所以画布会"原地更新为新数据"。
   *
   * 与 history.replaceState 不冲突：replaceState 只改地址栏字符串，
   * 而 refresh() 不动地址栏，两者各管各的。
   */
  const refreshData = useCallback(() => {
    router.refresh()
  }, [router])

  /**
   * ── P18 问题 2：手动添加模块 ──
   *
   * 原「手动输入想法」（直接写一条 CandidateIdea）改为「手动添加模块」：
   * 落库为 MethodBlock（挂用户选的论文或第一篇有方法 DNA 的论文），
   * 成功后：
   *   ① 把新模块 id 追加进 pickedBlockIds —— 它立即出现在
   *      「已选模块」列表里（用户要求"加入后进入已选模块列表"）；
   *   ② refreshData —— 中列论文分组里同步出现这个新模块。
   *
   * 与生成组合互锁同一分区（zone: 'idea'）—— 两者都写库，
   * 并发跑会出现"生成结果里看不到刚加的模块"。
   *
   * blockId 通过闭包传出（feedback.run 的结果类型只有
   * {ok,message,detail}，扩展字段进不了它的泛型，就近闭包最省事）。
   */
  const handleAddCustomBlock = useCallback(
    (name: string, description: string, paperId: string | null) => {
      let newBlockId: string | undefined
      feedback.run({
        pendingText: '正在添加模块…',
        zone: 'idea', // P14：与生成组合同区互锁（都影响工作台素材）
        exec: async () => {
          const r = await createCustomBlockAction(data.projectId, name, description, paperId)
          if (r.ok && r.blockId) newBlockId = r.blockId
          return r
        },
        onSettled: (r) => {
          if (r.ok && newBlockId) {
            dispatch({
              type: 'setPicked',
              blockIds: Array.from(new Set([...state.pickedBlockIds, newBlockId])),
              debtIds: state.pickedDebtIds,
            })
            refreshData()
          }
        },
      })
    },
    [feedback, refreshData, data.projectId, state.pickedBlockIds, state.pickedDebtIds]
  )

  /**
   * ── P12 问题 3：发送一条对话 ──
   *
   * 本地先追加用户消息（即时反馈），成功后追加 AI 回复，失败把该条
   * 标 failed（面板显示「重试」）。历史由前端持回传 —— 服务端只信
   * 自己组装的上下文。
   */
  const [chatSending, setChatSending] = useState(false)
  const handleChatSend = useCallback(
    (ideaId: string, text: string, history: ChatTurn[]) => {
      setChats((prev) => ({
        ...prev,
        [ideaId]: [...(prev[ideaId] ?? []), { role: 'user', content: text }],
      }))
      setChatSending(true)
      setChatActiveId(ideaId)

      void (async () => {
        let result: { ok: boolean; message: string; detail?: string }
        try {
          result = await crashChatAction(ideaId, history, text)
        } catch (err) {
          result = { ok: false, message: '对话调用未完成', detail: (err as Error)?.message }
        }
        setChatSending(false)
        setChats((prev) => ({
          ...prev,
          [ideaId]: result.ok
            ? [...(prev[ideaId] ?? []), { role: 'assistant', content: result.message }]
            : (prev[ideaId] ?? []).map((m, i) =>
                i === (prev[ideaId] ?? []).length - 1 && m.role === 'user'
                  ? { ...m, failed: true }
                  : m
              ),
        }))
        // 失败同时把原因带给全局反馈条（红条不自动消失，可读完整原因）
        if (!result.ok) {
          feedback.run({
            pendingText: '正在发送…',
            zone: 'chat', // P14：失败反馈归对话区，不锁其他区域
            exec: async () => result,
          })
        }
      })()
    },
    [feedback]
  )

  /**
   * ── 问题 4：剪刀模式下点中一个 Block = 「摘除 / 恢复」切换 ──
   *
   * 用户要求：第一次点 → 摘除；第二次点同一个 Block → 恢复；循环。
   * **不弹中间选择面板** —— 点一下就是一个确定动作，不给用户出选择题。
   *
   * 判断"这一下该摘还是该恢复"的唯一依据：**库里该 block 最新一条 Surgery 记录**
   *   · 没有记录  → 当前是"完好"，这一下 = 摘除（surgeryAction / REMOVE）
   *   · 有记录    → 当前是"已摘除"，这一下 = 恢复（deleteSurgeryAction）
   *
   * 为什么前端不自己记一个 `removedSet`：
   *   手术会写库，撤销按钮、别的标签页、刷新都会改它。本地记一份迟早和库不一致，
   *   用户就会看到"点一下没反应"或"状态反了"。每次从 data.surgeries 现算最稳。
   *
   * 跑完仍然自动选中**这次产生/删掉的那条记录**，让底部面板滑出显示
   * 「刚发生了什么」——见下面那个 effect。
   */
  const pendingSurgeryBlockRef = useRef<{
    blockId: string
    /** 这次动作是摘除还是恢复 —— 决定面板该选哪条记录 */
    removed: boolean
    /** 恢复时被删掉的那条记录 id —— 用于提示文案 */
    deletedId: string | null
  } | null>(null)

  const handleSurgeryPick = useCallback(
    (node: LayoutNode) => {
      const blockId = node.block?.id
      if (!blockId) return
      const blockName = node.block?.name ?? '这个模块'
      const latest = latestSurgeryForBlock(data, blockId)

      // ── 当前已摘除 → 这一下是「恢复」 ──
      if (latest) {
        feedback.run({
          pendingText: `正在恢复「${blockName}」…`,
          zone: 'surgery', // P14：手术动作只锁手术区
          exec: () => deleteSurgeryAction(latest.id),
          onSettled: (r) => {
            if (!r.ok) return
            pendingSurgeryBlockRef.current = {
              blockId,
              removed: false,
              deletedId: latest.id,
            }
            refreshData()
          },
        })
        return
      }

      // ── 当前完好 → 这一下是「摘除」 ──
      feedback.run({
        pendingText: `正在分析「${blockName}」被拿掉后会怎样…`,
        zone: 'surgery', // P14：手术动作只锁手术区
        exec: () =>
          surgeryAction({
            blockId,
            action: SurgeryAction.REMOVE,
            note: '画布剪刀模式：就地移除该模块',
          }),
        onSettled: (r) => {
          if (!r.ok) return
          /**
           * ── 为什么不是「选中 block 节点」 ──
           *
           * 产品要求是「点击某个 Block → 底部面板显示一句话结论」。
           * 如果这里选 `block-<id>`，面板会渲染 **block 卡片**
           * （模块描述 / 在方法中的角色 / …），一句话结论根本不出现
           * —— 这正是上一轮实测截图里发生的事。
           *
           * 结论属于**这次手术记录**（Surgery.result 解析而来），
           * 所以正确做法是选中 **surgery 节点**，让 surgeryPanel 渲染
           * 「一句话结论 → 关键影响 → 证据 → 不确定性」。
           *
           * 但 surgeryId 是后端刚生成的，surgeryAction 的返回值里没有，
           * 且 refreshData()（router.refresh）是异步的 —— 拿不到新数据。
           * 于是记下 blockId，交给下面那个 effect：
           * 等 surgeries 随 RSC 刷新落地后，再把最新的那条选中。
           */
          pendingSurgeryBlockRef.current = { blockId, removed: true, deletedId: null }
          refreshData()
        },
      })
    },
    [feedback, refreshData, data]
  )

  /**
   * 剪刀模式下跑完一次切换 → 等新数据落地，把底部面板切到「刚发生了什么」。
   *
   * ── 摘除 ──
   *   选中这次新生成的那条 Surgery 记录，面板显示一句话结论。
   *
   * ── 恢复 ──
   *   记录已经被删了，没有"这次的手术节点"可选。面板改选**对应的 block 节点**，
   *   显示"已恢复 X"—— 这正是用户要的"面板仍要出现，显示刚发生了什么"。
   *
   * 为什么用 effect 而不是在 onSettled 里直接 dispatch：
   *   onSettled 触发时 router.refresh() 还没跑完，data.surgeries 仍是旧的，
   *   此刻找不到刚生成的那条。effect 依赖 data.surgeries，刷新完成自动重跑。
   * 取完立刻清空 ref，避免后续任何 data 变化重复触发（一次点击只处理一次）。
   */
  useEffect(() => {
    const pending = pendingSurgeryBlockRef.current
    if (!pending) return

    if (!pending.removed) {
      // ── 恢复：等那条记录真的从数据里消失，再切到 block 节点 ──
      const stillThere = data.surgeries.some((s) => s.id === pending.deletedId)
      if (stillThere) return
      pendingSurgeryBlockRef.current = null
      setJustRestoredBlockId(pending.blockId)
      dispatch({ type: 'select', id: nodeId(BLOCK_ID_PREFIX, pending.blockId) })
      return
    }

    // ── 摘除：等新记录落地，选中它 ──
    const latest = [...data.surgeries]
      .reverse()
      .find((s) => s.intervenedBlockIds.includes(pending.blockId))
    if (!latest) return
    pendingSurgeryBlockRef.current = null
    setJustRestoredBlockId(null)
    dispatch({ type: 'select', id: nodeId(SURGERY_ID_PREFIX, latest.id) })
  }, [data.surgeries])

  /**
   * ── 问题 4：三栏工作台的「生成组合」──
   *
   * 把用户在右栏挑的 Block 与目标债务原样交给后端。
   * 空选择 = 让系统用全池给默认推荐（沿用原自动模式）。
   *
   * 为什么选完不做"自动选中某个新想法"：
   *   生成是**一次批量动作**，可能产出 0~N 个候选。自动选中其中一个
   *   会让用户以为"就生成了这一个"。这里只刷新数据，让画布
   *   （对，idea 视图现在没有画布，但后续如果回到卡片展示）
   *   与统计自然更新，用户自己去看结果。
   */
  const handleGenerateCombo = useCallback(
    (selection: { blockIds: string[]; debtIds: string[] }) => {
      const n = selection.blockIds.length
      const m = selection.debtIds.length
      feedback.run({
        pendingText:
          n || m ? `正在按你的选择生成组合（${n} 模块 × ${m || '自动'} 债务）…` : '正在生成组合方案…',
        zone: 'idea', // P14：与手动输入同区互锁（写同一张 CandidateIdea 表）
        exec: () => crossbreedAction(data.projectId, selection),
        onSettled: (r) => {
          if (r.ok) {
            /**
             * ── 问题 4：成功的"生成"动作 → 记下跑过 ──
             *
             * 只有 r.ok 才置位。失败（模型超时/证据校验不过）应当保持
             * "还没生成过"——那种情况的下一步是"重试"，而不是
             * "去改选材"。两者的引导方向不同，不能混。
             */
            dispatch({ type: 'markRun' })
            refreshData()
          }
        },
      })
    },
    [feedback, refreshData, data.projectId]
  )

  /**
   * ── 问题 2：工作台勾选变化 → 提升到 state（进而写进 URL）──
   *
   * 工作台自己维护 Set（点击即时响应），每次变化把这套 Set 完整上报。
   * 这里不重新计算、不合并，只转发 —— 真值由 URL 承载。
   */
  const handlePickedChange = useCallback(
    (selection: { blockIds: string[]; debtIds: string[] }) => {
      dispatch({ type: 'setPicked', blockIds: selection.blockIds, debtIds: selection.debtIds })
    },
    []
  )

  /**
   * ── P19 问题 3：击穿测试的 tab 切换 ──
   *
   * 从"可多选的清单"改成"单选 tab"：点哪个 tab 就看哪个想法的报告。
   * 选中集合仍是 `crashIdeaIds`（写进 URL，刷新/分享不丢），只是
   * 从"多选"语义收窄成"当前认定的那一个"。
   *
   * 为什么保留数组而不是改成单个 id 的 state：
   *   · URL 契约 `?crashIdeaIds=a,b` 与 readUrl/readCrashIds 的逐 id
   *     存在性校验已经就位，改成标量要动六处同步点（纪律见架构说明），
   *     收益却只是少一层数组 —— 不值；
   *   · 底层数据模型依然是"一个想法一次击穿"（CrashTest.ideaId 是 @unique），
   *     数组的长度语义天然表达"当前正在看哪一个"。
   */
  const handleCrashTabChange = useCallback((ideaId: string) => {
    dispatch({ type: 'setCrashIdeas', ideaIds: [ideaId] })
  }, [])

  /**
   * ── P19 问题 3：运行当前 tab 的击穿测试 ──
   *
   * 一次只针对当前 tab 的想法（旧的"一次跑多个选中"已随多选清单一起退场）。
   * 后端 crashTestAction(ideaId) 本来就是单想法语义（CrashTest.ideaId 是
   * @unique），所以这里不需要循环 —— 失败原因也能如实报出来。
   */
  const handleRunCrash = useCallback(
    (ideaId: string) => {
      if (!ideaId) return
      feedback.run({
        pendingText: '正在做击穿测试…',
        zone: 'crashtest', // P14：击穿动作只锁击穿区
        exec: () => crashTestAction(ideaId),
        onSettled: (r) => {
          if (r.ok) refreshData()
        },
      })
    },
    [feedback, refreshData]
  )

  /**
   * ── 需求 A：一级重置（只清前端运行态）──
   *
   * 不改库，只把 reducer 里的"运行态"归零：目标债务 / 已选模块 /
   * 已选债务 / 跑过标记 / 击穿选中 / 选中项（面板随之收起）/ 剪刀模式。
   *
   * 跳转策略：**不切视图**。重置是"把这个页面清干净"，不是"带你去别处"；
   * 用户站在击穿测试页点重置，就该还在击穿测试页看到它变空。
   *
   * 重置完要让地址栏也干净 —— syncUrl 只是"状态→URL"的单向写出，
   * 而它由 state 变化触发的 effect 驱动，所以 dispatch 之后就自动同步了。
   */
  const handleResetRun = useCallback(() => {
    dispatch({ type: 'resetRun' })
    triggerResetAnim()
    // P12 问题 3：会话是运行数据的一部分 —— 重置清空
    setChats({})
    setChatActiveId(null)
    feedback.run({
      pendingText: '正在重置…',
      zone: 'global', // P14：重置影响全站运行态，保留全站锁
      exec: async () => ({
        ok: true,
        message: '已重置为运行前的初始状态',
        detail: '论文、方法结构、演化关系与债务库均保留',
      }),
    })
  }, [feedback, triggerResetAnim])

  /**
   * ── 需求 A：二级重置（清库里的运行数据）──
   *
   * 比一级重置更彻底：连"已生成的想法"本体一起从库里删掉。
   * 保留论文 / DNA / 演化 / 债务 —— 也就是需求里说的"基础数据不丢"。
   *
   * 顺序：先调后端删库，成功后再归零前端运行态并 refreshData()。
   * 若先归零后删库，删库失败时用户会看到"页面空了但想法还在"的错位。
   */
  const handleResetData = useCallback(() => {
    feedback.run({
      pendingText: '正在清空运行数据…',
      zone: 'global', // P14：删库动作影响全站数据，保留全站锁
      exec: () => resetUserDataAction(data.projectId),
      onSettled: (r) => {
        if (r.ok) {
          dispatch({ type: 'resetRun' })
          triggerResetAnim()
          refreshData()
        }
      },
    })
  }, [feedback, refreshData, data.projectId, triggerResetAnim])

  /** 需求 B：从组合想法一键跳到击穿测试 */
  const handleGotoCrashTest = useCallback(() => {
    dispatch({ type: 'setView', view: 'crashtest' })
  }, [])

  /**
   * 每个 case 都调用真实存在的后端入口，并把返回的 message/detail
   * 交给 ActionBar 如实展示。没有"转圈→完成"的假动画：
   * 进行中只把按钮文案换成进行时短语。
   */
  const handlePanelAction = useCallback(
    (kind: string, content: PanelContent) => {
      switch (kind) {
        // ── 查看证据（已通）──
        case 'evidence':
          openEvidence(content.evidenceIds, `${content.title} · 证据`)
          break

        // ── 运行方法手术：对选中的 Block 调 surgeryAction ──
        case 'surgery': {
          const blockId = content.refId
          if (!blockId) {
            feedback.run({
              pendingText: '正在准备手术…',
              zone: 'surgery', // P14
              exec: async () => ({
                ok: false,
                message: '这块内容没有关联的方法模块',
                detail: '请先在「方法 DNA」视图里点击一个 Block 节点，再运行手术。',
              }),
            })
            break
          }
          feedback.run({
            pendingText: '正在做方法手术分析…',
            zone: 'surgery', // P14：手术动作只锁手术区
            exec: () =>
              surgeryAction({
                blockId,
                action: SurgeryAction.REMOVE,
                note: '从单页画布发起',
              }),
            onSettled: (r) => {
              if (r.ok) refreshData()
            },
          })
          break
        }

        // ── 撤销本次手术：删掉最近一次 Surgery 记录（P7-5 缺陷 2）──
        //
        // 真实写库：deleteSurgeryAction → prisma.surgery.delete（级联删 SurgeryLog）。
        // 删完 refreshData() 重查 RSC，被干预 block 的红框随之消失。
        // 同一 Block 被多次手术时只撤销最近一次（undoSurgeryId 就是那条）。
        case 'undoSurgery': {
          const surgeryId = content.undoSurgeryId
          if (!surgeryId) {
            feedback.run({
              pendingText: '正在准备撤销…',
              zone: 'surgery', // P14
              exec: async () => ({
                ok: false,
                message: '这个模块没有被手术干预过',
                detail: '只有红色边框的模块才有可撤销的手术。',
              }),
            })
            break
          }
          feedback.run({
            pendingText: '正在撤销本次手术…',
            zone: 'surgery', // P14：手术动作只锁手术区
            exec: () => deleteSurgeryAction(surgeryId),
            onSettled: (r) => {
              if (r.ok) refreshData()
            },
          })
          break
        }

        // ── 运行演化分析：对全项目调 evolutionAction ──
        case 'evolution': {
          feedback.run({
            pendingText: '正在梳理跨论文的演化关系…',
            zone: 'evolution', // P14：演化动作只锁演化区（债务区随锁，同一 debt 链）
            exec: () => evolutionAction(data.projectId),
            onSettled: (r, meta) => {
              if (r.ok) {
                refreshData()
                // 用专用 action 落位，顺带标记"从手术过来的"，
                // 让画布顶部显示"本次手术干预了 N 个 Block"（上下文继承链 1）。
                // P14：superseded 时只刷新数据不跳视图 —— 结果展示已被更晚的
                // 动作顶替，迟到的跳转会打断用户正在进行的操作。
                if (!meta.superseded) dispatch({ type: 'gotoEvolutionFromSurgery' })
              }
            },
          })
          break
        }

        // ── 重新生成组合：调 crossbreedAction ──
        case 'regenerate': {
          feedback.run({
            pendingText: '正在重新生成组合方案…',
            zone: 'idea', // P14：与生成/手动输入同区互锁
            exec: () => crossbreedAction(data.projectId),
            onSettled: (r) => {
              if (r.ok) refreshData()
            },
          })
          break
        }

        // ── 运行击穿测试：对选中的想法调 crashTestAction ──
        case 'crashtest': {
          const ideaId = content.ideaId
          if (!ideaId) {
            feedback.run({
              pendingText: '正在准备击穿测试…',
              zone: 'crashtest', // P14
              exec: async () => ({
                ok: false,
                message: '这条内容没有关联的组合想法',
                detail: '击穿测试的对象是"组合想法"，请先选中一个想法。',
              }),
            })
            break
          }
          feedback.run({
            pendingText: '正在做击穿测试…',
            zone: 'crashtest', // P14：击穿动作只锁击穿区
            exec: () => crashTestAction(ideaId),
            onSettled: (r, meta) => {
              if (r.ok) {
                refreshData()
                // 上下文继承链 2：落到击穿视图并记住"针对哪个想法"。
                // 选中对应击穿卡把面板打开，横条也据此显示针对关系。
                // P14：superseded 时只刷新数据不跳视图（同 evolution 的理由）。
                if (!meta.superseded) {
                  const ct = data.crashTests.find((t) => t.ideaId === ideaId)
                  dispatch({
                    type: 'gotoCrashFromIdea',
                    ideaId,
                    firstCrashNodeId: ct ? `crash-${ct.id}` : null,
                  })
                }
              }
            },
          })
          break
        }

        // ── 围绕债务生成想法：**不调后端**，只做视图跳转 + 预填债务 ──
        //    产品明确要求这是"跳转"，不是"生成"。真正的生成由用户在
        //    组合想法视图里点「重新生成组合」触发。
        case 'idea': {
          const debtId = content.refId
          if (!debtId) break
          // 先算出"跳过去之后应该选中哪张想法卡"，交 reducer 一次到位。
          // idea 视图的卡片 id 形如 `idea-${id}`（见 view-layout）。
          const firstIdea = data.ideas[0]
          dispatch({
            type: 'gotoIdeaWithDebt',
            debtId,
            firstIdeaNodeId: firstIdea ? `idea-${firstIdea.id}` : null,
          })
          break
        }

        // ── 从击穿测试跳到它对应的想法（本地跳转，带上下文）──
        case 'gotoIdea': {
          const ideaId = content.ideaId
          if (!ideaId) break
          dispatch({
            type: 'gotoIdeaFromCrash',
            ideaId,
            targetIdeaNodeId: `idea-${ideaId}`,
          })
          break
        }

        default:
          // 未接线的动作如实告知，不假装成功。
          feedback.run({
            pendingText: '正在处理…',
            zone: 'global', // P14：未接线的动作无法判断归属，保守用全站锁
            exec: async () => ({
              ok: false,
              message: `「${kind}」这个动作尚未接入后端`,
              detail: '为避免做出"点了没反应"的死按钮，这里如实告知而不是假装成功。',
            }),
          })
      }
    },
    [openEvidence, feedback, refreshData, data.projectId, data.ideas, data.crashTests]
  )

  /**
   * 空态主按钮 —— 与面板动作走同一套后端入口。
   *
   * 空态出现的场景是"这个视图还没有数据"。这里的按钮是"启动 pipeline"，
   * 所以走的是各 pipeline 的全项目入口（不依赖某个具体选中项）。
   */
  const handleEmptyAction = useCallback(
    (v: ViewId) => {
      switch (v) {
        case 'dna':
          // DNA 空态 = 还没有论文有结构 → 引导去上传论文
          document.querySelector<HTMLInputElement>('input[type="file"]')?.click()
          break

        /**
         * ── 问题 3 后：演化的数据源变成了「问题」（ResearchDebt）──
         *
         * 所以空态的启动动作应当是**债务合成**（debtAction），而不是
         * 原来的"梳理演化关系"（evolutionAction，它产出的是 Relation）。
         * 若仍调 evolutionAction，用户点完会写一堆 Relation 进库，
         * 但画布上什么都没有 —— 因为画布读的是 debts。
         */
        case 'evolution':
          feedback.run({
            pendingText: '正在从多篇论文里聚合共同面对的问题…',
            zone: 'evolution', // P14：债务合成只锁演化/债务区（同一链路）
            exec: () => debtAction(data.projectId),
            onSettled: (r) => {
              if (r.ok) refreshData()
            },
          })
          break

        /**
         * ── 债务合成的真实入口（此前是死按钮）──
         *
         * 之前这里返回「尚未接入本项目的前端入口」，但服务端
         * `debtAction` 一直是存在的（研究债务页用的就是它）。
         * 那时候不接线是因为它不在 P0 六按钮清单里；现在问题 3 把
         * 债务提升为演化视图的数据源，它必须能真的跑起来，
         * 否则"演化空态 → 运行债务合成"这条路依然是死的。
         */
        case 'debt':
          feedback.run({
            pendingText: '正在从多篇论文里聚合共同面对的问题…',
            zone: 'evolution', // P14：与演化同锁（debtAction 是同一条链路）
            exec: () => debtAction(data.projectId),
            onSettled: (r) => {
              if (r.ok) refreshData()
            },
          })
          break

        case 'idea':
          feedback.run({
            pendingText: '正在重新生成组合方案…',
            zone: 'idea', // P14：与生成/手动输入同区互锁
            exec: () => crossbreedAction(data.projectId),
            onSettled: (r) => {
              if (r.ok) refreshData()
            },
          })
          break

        case 'crashtest':
          // 击穿测试的对象是某个具体想法 → 先切到 idea 选一个
          dispatch({ type: 'setView', view: 'idea' })
          feedback.run({
            pendingText: '正在切换到组合想法…',
            zone: 'global', // P14：纯提示性反馈，不锁任何功能区
            exec: async () => ({
              ok: true,
              message: '已切到「组合想法」：选中一个想法，再点「运行击穿测试」',
              detail: '击穿测试的对象是一个具体的组合想法，请先选定它。',
            }),
          })
          break
      }
    },
    [feedback, refreshData, data.projectId]
  )

  /**
   * ── P14：底部面板动作按钮的分区锁判定 ──
   *
   * 面板动作按钮的 disabled 不再统一看全站 pending，而是按"这个按钮
   * 触发的是哪个区域的动作"查锁：
   *   · surgery/undoSurgery → 手术区
   *   · evolution           → 演化区
   *   · regenerate          → 组合想法区
   *   · crashtest           → 击穿区
   *   · 其余（evidence/idea/gotoIdea 等纯前端动作）按当前视图的默认区 ——
   *     它们不跑 run()，锁不锁都不可达，这里只是口径闭合。
   *
   * 为什么写成 LabShell 的回调而不是 BottomPanel 内部判断：
   *   isBusy 的真值（busyZones）在 feedback hook 里，BottomPanel 拿不到；
   *   且 kind → zone 的口径与 handlePanelAction 的 case 标注必须同源，
   *   放在一起才不会漂移。
   */
  const isPanelActionBusy = useCallback(
    (kind: string) => {
      switch (kind) {
        case 'surgery':
        case 'undoSurgery':
          return feedback.isBusy('surgery')
        case 'evolution':
          return feedback.isBusy('evolution')
        case 'regenerate':
          return feedback.isBusy('idea')
        case 'crashtest':
          return feedback.isBusy('crashtest')
        default:
          return feedback.isBusy(ZONE_BY_VIEW[view])
      }
    },
    [feedback, view]
  )

  /**
   * 上传论文 —— 调 /api/upload，一次跑完「解析 PDF → 抽 Method DNA → 写库」。
   *
   * 为什么改成 fetch API Route 而不是原来的 Server Action（问题 6）：
   *   原来那个 action ① **从不抽取方法 DNA**，上传进来的论文永远没有结构，
   *   ② 解析失败时只 console.error，返回 void —— 前端无从得知，用户只看到
   *   "论文没出现"。现在 Route 会返回**真实的结构化结果**（含失败原因），
   *   所以这里能给出诚实的成功/失败提示，而不是一句含糊的"已提交"。
   */
  const handleUpload = useCallback(
    async (file: File) => {
      setUploadingName(file.name)

      await feedback.run({
        // 进度是分阶段的：先解析文本，再抽方法结构。文案如实反映这两步
        pendingText: `正在上传「${file.name}」→ 解析 PDF 文本 → 抽取方法 DNA…`,
        zone: 'global', // P14：上传改变全站数据集，保留全站锁
        /**
         * 长任务必须解释"在等什么、大概多久"。
         * 推理模型的抽取耗时与论文长度强相关（实测 30~110 秒），
         * 用户不知道这个量级时，会把正常的等待当成卡死。
         */
        hint: '方法结构抽取由语义模型完成，一篇论文通常需要 30 秒～2 分钟，请勿关闭页面或重复提交。',
        exec: async () => {
          const fd = new FormData()
          fd.append('projectId', data.projectId)
          fd.append('file', file)

          let res: Response
          try {
            res = await fetch('/api/upload', { method: 'POST', body: fd })
          } catch (e) {
            // 网络层失败（服务重启、断网）—— 也要说清楚，不静默
            return {
              ok: false,
              message: `上传「${file.name}」时网络中断`,
              detail: (e as Error).message,
            }
          }

          const payload = (await res.json().catch(() => null)) as
            | {
                ok: boolean
                message?: string
                detail?: string
                stage?: string
                title?: string
                pageCount?: number
                paragraphCount?: number
                blockCount?: number
                evidenceCount?: number
                provider?: string
              }
            | null

          if (!res.ok || !payload?.ok) {
            return {
              ok: false,
              message: payload?.message ?? `上传失败（HTTP ${res.status}）`,
              detail: payload?.detail,
            }
          }

          /**
           * P18 全局约束：界面不出现任何模型/供应商名称。
           * 原来这里会把 payload.provider（可能是具体模型名）拼进
           * 回执 —— 现在只在降级时提示"本地启发式抽取"，正常路径
           * 不提及任何 provider。
           */
          const via =
            payload.provider === 'mock'
              ? '（本地启发式抽取，未经语义模型验证）'
              : ''

          return {
            ok: true,
            message: `「${payload.title}」已上传并解析完成：${payload.blockCount} 个方法模块、${payload.evidenceCount} 条证据 ${via}`,
            detail: `${payload.pageCount} 页、${payload.paragraphCount} 个段落。可在右栏选中这篇论文查看方法结构。`,
          }
        },
        onSettled: (r) => {
          // 只有真的成功了才刷新；失败时也刷新，让 FAILED 状态如实呈现
          refreshData()
          setUploadingName(null)
          if (r.ok) {
            // 上传成功后自动把该论文选中，用户立刻能在画布上看到结构
            router.refresh()
          }
        },
        autoHideMs: 9000,
      })
    },
    [data.projectId, feedback, refreshData, router]
  )

  /**
   * ── 问题 2：全项目 Block 的 (id) 扁平列表 ──
   *
   * 只用于 readUrl 校验 URL 里的 blockIds 是否真实存在。
   * 为什么在这里算而不是在 readUrl 里遍历 data.papers：
   *   readUrl 是纯函数、只拿到"最小形状"的参数（{id}[]）——
   *   保持这个习惯，它的依赖面越窄越不容易因为数据结构变动而崩。
   */
  const allBlocks = useMemo(
    () => data.papers.flatMap((p) => p.blocks.map((b) => ({ id: b.id }))),
    [data.papers]
  )

  // ── 挂载后把 URL 对齐到状态；若 URL 带了参数则反向覆盖状态 ──
  const didHydrateRef = useRef(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const sp = new URLSearchParams(window.location.search)
    if (!didHydrateRef.current) {
      didHydrateRef.current = true
      const fromUrl = readUrl(data.papers, data.debts, data.ideas, data.crashTests, allBlocks)
      // 只要有任一 query 参数就反向覆盖（避免把 URL 又写回去形成抖动）
      if (sp.toString()) {
        dispatch({ type: 'syncFromUrl', ...fromUrl, selectedId: null })
        return
      }
    }
    syncUrl(state)
  }, [state, data.papers, data.debts, data.ideas, data.crashTests, allBlocks])

  // ── 浏览器前进/后退时回读 URL ──
  useEffect(() => {
    const onPop = () => {
      const fromUrl = readUrl(data.papers, data.debts, data.ideas, data.crashTests, allBlocks)
      dispatch({ type: 'syncFromUrl', ...fromUrl, selectedId: null })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [data.papers, data.debts, data.ideas, data.crashTests, allBlocks])

  const onNodeClick = useCallback((node: LayoutNode) => {
    // 空阶段占位节点没有详情，点了不开面板（但也不算选中）
    if (node.kind === 'empty') {
      dispatch({ type: 'select', id: null })
      return
    }
    // 预览态（手术空态的结构底图）是可点的 —— 它就是"刀往哪落"的靶标
    dispatch({ type: 'select', id: node.id })
  }, [])

  const layout = useMemo(() => buildViewLayout(view, data, paperId), [view, data, paperId])

  /** 当前选中的节点对象（面板需要它的 label / block 等） */
  const selectedNode = useMemo(
    () => layout.nodes.find((n) => n.id === selectedId) ?? null,
    [layout.nodes, selectedId]
  )

  /** 底部面板内容 —— 由选中节点翻译而来 */
  const panelContent = useMemo(
    () => buildPanelContent(selectedId, selectedNode, view, data, justRestoredBlockId),
    [selectedId, selectedNode, view, data, justRestoredBlockId]
  )

  /**
   * ── P21：DNA / 演化 / 债务三视图的「右侧详情栏」内容 ──
   *
   * 这三个视图改成"左内容 + 右详情"两栏后，详情不再从底部滑出，
   * 而是常驻右栏、只在选中时显示内容。内容来源分三路：
   *   · dna       → 选中的画布节点（复用 buildPanelContent，与旧底部面板同源）
   *   · evolution → 选中的**论文**（panelForPaper）
   *   · debt      → 选中的**债务**（panelForDebt）
   *
   * 演化与债务为什么不走 buildPanelContent：那两个视图改版后，选中项来自
   * 左侧列表而不是画布节点，而 buildPanelContent 的卡片分支要求传 LayoutNode。
   * 伪造节点等于把内部结构当接口用，所以走各自明确的入口（内容仍与面板同源）。
   */
  const railContent = useMemo<PanelContent | null>(() => {
    if (view === 'evolution') {
      return selectedPaperId ? panelForPaper(selectedPaperId, data) : null
    }
    if (view === 'debt') {
      return selectedDebtId ? panelForDebt(selectedDebtId, data) : null
    }
    return panelContent
  }, [view, selectedPaperId, selectedDebtId, data, panelContent])

  /**
   * ── P21（B 方案）：底部数据看板的内容 ──
   * 统计口径与配色都在 lib/lab/dashboard.ts 里，本组件只把结果传下去。
   * 纯派生数据，不新增任何查询。
   */
  const dashContent = useMemo(() => buildDashboard(view, data), [view, data])

  /** 右栏那句提示语随视图变，告诉用户"点哪儿"，而不是干放一个空框 */
  const railPlaceholder = useMemo(() => {
    switch (view) {
      case 'debt':
        return '点击左侧债务查看详情'
      case 'evolution':
        return '点击左侧某一年 / 论文查看详情'
      default:
        return '点击画布上的模块查看详情'
    }
  }, [view])

  const avail = useMemo(() => getAvailability(view, data), [view, data])

  /** 每个视图的数据条数（工具栏徽标） */
  const counts = useMemo<Record<ViewId, number>>(() => {
    const c = {} as Record<ViewId, number>
    for (const v of VIEW_IDS) c[v] = getAvailability(v, data).count
    return c
  }, [data])

  const showPaperSwitcher = view === 'dna'

  /** TopBar 中间的当前论文名（切换入口在左栏「论文」分组） */
  const currentPaperTitle = useMemo(
    () => data.papers.find((p) => p.id === paperId)?.title ?? '未选择论文',
    [data.papers, paperId]
  )

  /**
   * ── P19 减展示 1：TopBar「分析」按钮的文案 ──
   *
   * 按钮跑的是**当前视图所属链路**的 pipeline（复用 handleEmptyAction），
   * 文案必须随之说清楚"点下去会发生什么"，否则用户不敢点：
   *   dna       → 方法抽取（还没上传论文时就是引导上传）
   *   evolution / debt → 债务合成
   *   idea      → 生成组合
   *   crashtest → 没有全局入口，回到组合想法先生成想法
   */
  const analyzeLabel = useMemo(() => {
    switch (view) {
      case 'dna':
        return '抽取方法结构'
      case 'evolution':
      case 'debt':
        return '运行债务合成'
      case 'idea':
        return '生成组合想法'
      case 'crashtest':
        return '去生成想法'
    }
  }, [view])

  /**
   * 工作流（每步状态 + ★ 当前 + → 建议下一步）。
   *
   * ── UI ① 后它只服务于右栏 ──
   * 曾经顶部导航条与右栏共用这份数据，现在导航条已删除，
   * 右栏仍是它的唯一消费者（每个视图按钮显示"第 N 步 · 状态"）。
   * 保留它是因为那行状态对用户判断"下一步该干什么"有实际价值。
   */
  const workflow = useMemo(() => buildWorkflow(data, view), [data, view])

  /**
   * 画布顶部的上下文横条 —— 三条继承链共用一个槽位，按优先级取第一条命中的。
   *
   *   1. 手术 → 演化：显示"本次手术干预了 N 个 Block"
   *   2. 想法 → 击穿：显示"本次击穿测试针对想法「X」"
   *
   * 与 cornerNote 的区别：cornerNote 是 getAvailability 给的**静态数据建议**，
   * 这里是**跨步骤传来的动态上下文** —— 语义不同，所以放在独立的槽位，
   * 不污染 getAvailability 的契约。
   */
  const contextStrip = useMemo<{ text: string } | null>(() => {
    if (view === 'evolution' && fromStep === 'surgery') {
      const last = data.surgeries[data.surgeries.length - 1]
      if (!last || last.intervenedBlockIds.length === 0) return null
      const names = last.intervenedBlockIds
        .map((bid) => findBlockName(bid, data))
        .filter((x): x is string => Boolean(x))
      const shown = names.slice(0, 3).join('、')
      const more = names.length > 3 ? ` 等 ${names.length} 个` : ''
      return {
        text: `本次手术干预了 ${last.intervenedBlockIds.length} 个 Block${
          shown ? `：${shown}${more}` : ''
        }`,
      }
    }

    if (view === 'crashtest' && contextIdeaId) {
      const ct = data.crashTests.find((t) => t.ideaId === contextIdeaId)
      return {
        text: `本次击穿测试针对想法「${ct?.ideaTitle ?? '（已删除的想法）'}」`,
      }
    }

    return null
  }, [view, fromStep, contextIdeaId, data])

  /**
   * 预填提示要显示债务**标题**而不是 id —— 用户看不懂 cuid。
   * 债务被删掉时返回 null，提示自然消失。
   */
  const contextDebtTitle = useMemo(() => {
    if (!contextDebtId) return null
    return data.debts.find((d) => d.id === contextDebtId)?.title ?? null
  }, [contextDebtId, data.debts])

  /** 被手术干预过的 block —— 结构图上标红 */
  const intervenedIds = useMemo(
    () => new Set(intervenedBlockIdsOf(data)),
    [data]
  )

  /**
   * ── P19：左侧导航栏（默认折叠 48px）──
   *
   * 右栏已整体删除，导航与论文切换收进这一条：
   *   · 视图切换  → 左栏 5 枚视图按钮（展开态）+ TopBar 的下拉（第二出口）
   *   · 论文切换  → 左栏「论文」分组（原右栏的切换器原样搬来，钩子不变）
   *   · 重置      → 左栏「设置」分组（折叠态只留 ↺）
   *   · logo      → 左栏底部（P19 从画布右下角移出）
   *
   * 画布因此拿到 100% 宽度（只减去 48px 窄条）。
   */
  const renderNav = () => (
    <LeftRail
      collapsed={railCollapsed}
      onToggle={() => setRailCollapsed((c) => !c)}
      view={view}
      onViewChange={(v) => dispatch({ type: 'setView', view: v })}
      /* ── P21：论文切换已搬到 TopBar ──
         左栏不再有论文列表，所以 papers / paperId / onPaperChange /
         showPaperSwitcher / uploadingName 都不再往这里传。 */
      counts={counts}
      workflow={workflow}
      pending={feedback.pending}
      onResetRun={() => setConfirm('run')}
      onResetData={() => setConfirm('data')}
      resetNonce={resetNonce}
    />
  )

  /**
   * ── P19 减展示 1：顶部一行紧凑工具栏 ──
   *
   * 视图切换下拉 + 论文切换下拉 + 上传/分析/重置。
   * 「分析」按钮点下去跑的是**当前视图所属链路**的 pipeline
   * （与画布空态的主按钮走同一个 handleEmptyAction，语义单一）。
   *
   * ── P21：论文切换从左栏搬到顶栏 ──
   * 左栏的论文列表整块删除（它自己滚动、把 logo 挤下去，长标题还要折 3 行），
   * 切换入口改到顶栏当前论文名上 —— "我在看哪一篇"和"换一篇"在同一处。
   */
  const renderTopBar = () => (
    <TopBar
      view={view}
      onViewChange={(v) => dispatch({ type: 'setView', view: v })}
      counts={counts}
      papers={data.papers.map((p) => ({
        id: p.id,
        title: p.title,
        blockCount: p.blocks.length,
      }))}
      paperId={paperId}
      onPaperChange={(id) => dispatch({ type: 'setPaper', paperId: id })}
      pending={feedback.pending}
      uploadingName={uploadingName}
      onRequestUpload={() => {
        const el = document.getElementById('lab-upload-input') as HTMLInputElement | null
        el?.click()
      }}
      onAnalyze={() => handleEmptyAction(view)}
      analyzeLabel={analyzeLabel}
      onResetRun={() => setConfirm('run')}
      onResetData={() => setConfirm('data')}
      resetNonce={resetNonce}
    />
  )

  /**
   * ── P19 问题 3：击穿测试的当前想法报告内容 ──
   *
   * 报告渲染完全复用 crashPanel（与底部面板同源），只是挂在中栏常驻。
   * 未击穿时返回 null —— CrashReportDock 会退化成"想法简介 + 怎么跑"。
   */
  /**
   * 当前报告对象 = 选中的 tab；**没有选中时回落到上下文想法**。
   *
   * 为什么要有回落：`?view=crashtest&ideaId=X` 是"想法 → 击穿"这条链的
   * 落地链接（contextIdeaId 是它的载体），它历史上会顺带把该想法标成
   * 当前项。P19 把 tab 收窄成单选、且 tab 状态走 `crashIdeaIds` 之后，
   * 只带 ideaId 的链接会让报告区无对象可显示 —— 跨步骤上下文横条
   * （"本次击穿测试针对想法「X」"）也跟着不渲染，验收里两条断言失败。
   * 这里回落一层，链接语义就与旧版一致；用户点别的 tab 时 crashIdeaIds
   * 有值，回落自然让位。
   */
  const activeCrashIdea = useMemo(() => {
    const id = state.crashIdeaIds[0] ?? contextIdeaId
    if (!id) return null
    return data.ideas.find((i) => i.id === id) ?? null
  }, [data.ideas, state.crashIdeaIds, contextIdeaId])
  const activeCrashPanel = useMemo(() => {
    const t = activeCrashIdea?.crashTest
    if (!t) return null
    /**
     * ⚠️ `buildPanelContent` 的第二参是**节点对象**（不是 null）——
     * 它在卡片分支里读 `node.card.refId` 才知道该渲染谁的面板。
     * 第一版这里传了 null，结果永远返回 null，报告区退化成
     * 「尚未运行」的占位卡（截图实测抓到）。所以先从**同一个** layout
     * 里取出该击穿卡节点，再走与底部面板完全相同的入口。
     */
    const node = layout.nodes.find((n) => n.id === nodeId(CRASH_ID_PREFIX, t.id)) ?? null
    if (!node) return null
    return buildPanelContent(node.id, node, 'crashtest', data, null)
  }, [activeCrashIdea, data, layout.nodes])

  return (
    /**
     * P18 开场页结构修正：开场页浮层必须是工作台根元素的**兄弟**，
     * 不能是它的子元素 —— 根元素在 'show' 态 opacity:0（预先就位、
     * 等 fading 淡入），而父级 opacity 会连坐所有子元素：浮层放进
     * 根元素里面，show 态整个开场页（含 #fafafa 底、logo、按钮）
     * 一起不可见，用户看到纯白屏。用 Fragment 让两层平级交叉。
     */
    <>
    <div
      className="relative flex h-full w-full flex-col"
      style={
        /* P18 开场页：'show' 时工作台已就位但透明；'fading' 时 500ms
           淡入（与开场页淡出交叉）；'gone' 后不再干预（无内联样式）。 */
        intro === 'gone'
          ? undefined
          : {
              opacity: intro === 'show' ? 0 : 1,
              transition: 'opacity 500ms ease-in-out',
            }
      }
    >
      <input
        id="lab-upload-input"
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleUpload(f)
          // 允许连续上传同一个文件（清空 value）
          e.target.value = ''
        }}
      />

      {/*
        主体区：flex-1 + min-h-0。
        min-h-0 是硬要求 —— flex item 默认 min-height:auto，
        右栏的论文切换器是 flex-1 overflow-y-auto，不给 min-h-0
        就会顶开父级高度 → 整页出现滚动条（验收 4/5 会失败）。

        data-lab-body：验收脚本靠它定位"画布 + 工具栏"这一行算宽度占比。
        之前脚本用的是 `.flex.h-full.w-full`，P7-4 加了顶部导航条后
        那个选择器会命中外层 flex-col（第一个孩子是隐藏 input，宽 0），
        导致占比算出 0%/100% —— 加个语义化属性把契约钉死。
      */}
      {/* ── P19 减展示 1：顶部一行紧凑工具栏（视图下拉 / 论文 / 操作）── */}
      {renderTopBar()}

      {/*
        主体区：左侧导航栏 + 内容区。
        min-h-0 是硬要求 —— flex item 默认 min-height:auto，
        左栏的论文列表是 flex-1 overflow-y-auto，不给 min-h-0
        就会顶开父级高度 → 整页出现滚动条（验收 4/5 会失败）。

        data-lab-body：验收脚本靠它定位"画布 + 导航"这一行算宽度占比。
        之前的右栏已整体删除，画布因此拿到几乎全部宽度（只减 48px 窄条）。
      */}
      <div data-lab-body className="flex min-h-0 w-full flex-1">
        {/* ── 左侧导航栏（默认折叠 48px；展开 248px）── */}
        {renderNav()}

        {view === 'idea' ? (
          /* ═══════════════ 组合想法：工作台 ═══════════════
             P21（B 方案）：本视图也套「左内容 + 右详情 + 下看板」：
               左 70% = 三栏工作台（真正的"内容"）
               右 30% = 选中模块 / 债务的详情
               下      = 数据看板（4 统计卡片 + 2 图表，可折叠）
             ⚠️ 右栏为什么不是产品原稿写的"想法列表（标题 + 状态）"：
                本视图从需求 B 起就**不再渲染想法卡片**（列表只在击穿测试视图，
                有注释与验收共同守着）。凭空造一个只在此处出现的想法列表 =
                新增功能，与本轮"不新增功能，只减展示"的约束直接冲突。
                所以右栏放的是**已有的**选中项详情（原来在底部滑出），
                只把位置从底部搬到右侧 —— 内容一个字没变。 */
          <div
            key={view}
            className="relative ma-view-in flex h-full min-w-0 flex-1 flex-col"
          >
            <span
              data-zone-band
              aria-hidden
              className="pointer-events-none absolute left-0 top-0 z-10 h-full w-0.5"
              style={{ backgroundColor: viewColor(view) }}
            />

            {/* 上半：左内容 + 右详情 */}
            <div className="flex min-h-0 w-full flex-1">
              <div className="relative min-h-0 min-w-0" style={{ width: '70%' }}>
                <IdeaWorkbench
                  data={data}
                  // P14 分区锁：只看组合想法区是否忙（生成/手动输入互锁），
                  // 其他区域跑动作不再连坐禁用本区按钮。
                  pending={feedback.isBusy('idea')}
                  onGenerate={handleGenerateCombo}
                  pickedBlockIds={state.pickedBlockIds}
                  pickedDebtIds={state.pickedDebtIds}
                  contextDebtId={contextDebtId}
                  hasRun={state.hasRun}
                  onSelectionChange={handlePickedChange}
                  onSelectIdea={(id) => dispatch({ type: 'select', id: nodeId(IDEA_ID_PREFIX, id) })}
                  onAddCustomBlock={handleAddCustomBlock}
                />
                {/* 动作反馈条：生成组合的成败提示 */}
                <ActionBar
                  feedback={feedback.feedback}
                  onClear={feedback.clear}
                  action={
                    data.ideas.length > 0
                      ? { label: '去击穿测试 →', onClick: handleGotoCrashTest, testId: 'goto-crashtest' }
                      : undefined
                  }
                />
              </div>

              {/* ── 右 30%：详情栏 ── */}
              <aside
                data-detail-rail
                data-detail-empty={panelContent ? '0' : '1'}
                className="ma-view-fade relative flex h-full min-w-0 flex-1 flex-col overflow-hidden border-l border-line bg-white"
              >
                <span
                  aria-hidden
                  className="absolute left-0 top-0 z-10 h-full w-0.5"
                  style={{ backgroundColor: viewColor(view) }}
                />
                {panelContent ? (
                  <BottomPanel
                    content={panelContent}
                    onClose={() => dispatch({ type: 'select', id: null })}
                    onAction={handlePanelAction}
                    pending={feedback.pending}
                    isActionBusy={isPanelActionBusy}
                    accent={viewColor(view)}
                    borderColor={VIEW_SOFT_BORDER[view]}
                    prefillDebtTitle={contextDebtTitle}
                    onPrefillConsumed={() => dispatch({ type: 'clearPrefill' })}
                  />
                ) : (
                  <div
                    data-detail-placeholder
                    className="flex h-full items-center justify-center px-6"
                  >
                    <p className="max-w-[220px] text-center text-meta leading-6 text-ink-faint">
                      点击左侧的模块 / 债务卡片查看详情
                    </p>
                  </div>
                )}
              </aside>
            </div>

            {/* ── 下半：底部数据看板 ── */}
            <Dashboard
              stats={dashContent.stats}
              charts={dashContent.charts}
              open={dashOpen}
              onToggle={() => setDashOpen((o) => !o)}
              collapsedHint={dashContent.collapsedHint}
            />
          </div>
        ) : (
          /* ═══════════════ 画布视图（dna / evolution / debt / crashtest）═══════════════
             P19：删掉右栏后画布 flex-1 直接吃满 data-lab-body 的剩余宽度，
             只减去左栏的 48px（折叠态）。零重叠由结构保证：没有任何
             绝对定位元素需要绕过别的区域。 */
          <div
            key={view}
            className="relative ma-view-in flex h-full min-w-0 flex-1 flex-col"
          >
            {/* ── P14：区域分隔色带（颜色随视图变化）── */}
            <span
              data-zone-band
              aria-hidden
              className="pointer-events-none absolute left-0 top-0 z-10 h-full w-0.5"
              style={{ backgroundColor: viewColor(view) }}
            />

            {/**
             * ── P19 问题 3①：击穿测试的顶部想法 tab 切换条 ──
             *
             * 替代原右栏「已生成的想法」清单 + 顶部进度提示：
             * 一条 = tab（选哪个想法）+ 计数 + 运行按钮。
             * 其余视图不渲染它（它们没有"逐个想法"的语义）。
             */}
            {view === 'crashtest' ? (
              <CrashIdeaTabs
                ideas={data.ideas}
                activeId={activeCrashIdea?.id ?? null}
                onActiveChange={handleCrashTabChange}
                pending={feedback.isBusy('crashtest')}
                onRun={handleRunCrash}
                onGotoIdea={() => dispatch({ type: 'setView', view: 'idea' })}
              />
            ) : null}

            {/**
             * ── P19 问题 3：击穿视图的中栏 = 当前想法的击穿报告 ──
             *
             * dna / evolution / debt 三个视图在 P21 改成"左内容 + 右详情"
             * 两栏（见 else 分支）；击穿视图保持"tab + 报告 + AI 讨论"三层。
             */}
            {view === 'crashtest' ? (
              <div className="flex min-h-0 w-full flex-1 flex-col">
                {/* ── P21（B 方案）：击穿视图也套「左内容 + 右详情 + 下看板」──
                    左 40% = 想法卡片列表（每个想法一张卡，带状态色条）
                    右 60% = 选中卡片的击穿报告
                    下      = 数据看板
                    顶部那条 CrashIdeaTabs 保留：5 套验收脚本按它的
                    [data-crash-run-card] / [data-run-crash] 定位，契约不能动。 */}
                <div className="flex min-h-0 w-full flex-1">
                  <div className="min-h-0 min-w-0" style={{ width: '40%' }}>
                    <CrashIdeaCards
                      ideas={data.ideas}
                      activeId={activeCrashIdea?.id ?? null}
                      onActiveChange={handleCrashTabChange}
                      pending={feedback.isBusy('crashtest')}
                    />
                  </div>

                  <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden border-l border-line">
                {/**
                 * ── P19 修正：抽屉打开时**卸载**报告，而不是把它标成 inert ──
                 *
                 * 第一版想用 `inert` 把被盖住的报告从可交互集合里摘掉。实测不成立：
                 * `inert` 只影响交互/聚焦，**元素仍在 DOM 里、仍占几何**，
                 * 所以"两两零重叠"扫描照样把它算进去（报出 5 处真实交叠）。
                 *
                 * 正确的做法是**条件渲染**：抽屉是覆盖中栏的模态层，打开时报告
                 * 本来就是"看不见"的，直接不渲染它 —— 既真的不可点，也不占几何。
                 * 关闭抽屉后报告立刻回来（selectedIds 仍是同一个想法，无需重算）。
                 */}
                {!compareOpen && (
                  <div className="h-full w-full">
                    <CrashReportDock
                      activeIdea={activeCrashIdea}
                      content={activeCrashPanel ?? panelContent}
                      onClose={() => dispatch({ type: 'select', id: null })}
                      onAction={handlePanelAction}
                      pending={feedback.pending}
                      isActionBusy={isPanelActionBusy}
                      prefillDebtTitle={contextDebtTitle}
                      onPrefillConsumed={() => dispatch({ type: 'clearPrefill' })}
                      /* P19：击穿视图没有画布了，跨步骤上下文横条（"本次击穿
                         测试针对想法「X」"）改由中栏报告渲染 —— 见 CrashReportDock 注释 */
                      contextStrip={contextStrip}
                    />
                  </div>
                )}
                {/* 动作反馈条（运行击穿的成败提示） */}
                <ActionBar feedback={feedback.feedback} onClear={feedback.clear} />
                {/* ── P19 问题 3：右上角浮动的「想法对比」按钮 + 覆盖式抽屉 ──
                    旧的左侧常驻对比列已删除（那是第 4 层框）。
                    按钮与抽屉同级挂在**中栏容器**上，抽屉的 inset-0 才能铺满
                    整个中栏（见 CrashComparePanel 注释）。
                    位置在 tab 条下方、报告之内的右上角：报告标题行高度固定
                    （约 57px），把浮标推到 top-14 就落在标题行下方的正文留白里，
                    不会压住标题行的 ✕ 关闭键，也不会压住左下的动作按钮。 */}
                <CrashComparePanel
                  ideas={data.ideas}
                  selectedIds={state.crashIdeaIds}
                  // P14 分区锁：对比随击穿区（纯前端计算，锁的是动作进行中的按钮）
                  pending={feedback.isBusy('crashtest')}
                  onOpenChange={setCompareOpen}
                />
                  </div>
                </div>

                {/* ── 底部数据看板（P21 B 方案）── */}
                <Dashboard
                  stats={dashContent.stats}
                  charts={dashContent.charts}
                  open={dashOpen}
                  onToggle={() => setDashOpen((o) => !o)}
                  collapsedHint={dashContent.collapsedHint}
                />
              </div>
            ) : (
              /**
               * ── P21：DNA / 演化 / 债务 = 「左内容 + 右详情」两栏 ──
               *
               * 产品指出的共同问题：这三个视图原本都是"一条内容 + 大画布"，
               * 右侧或上下 70% 是空的。共同改法就是这一层 flex 行：
               *   dna       左 70% 画布       + 右 30% 选中 Block 详情
               *   evolution 左 70% 纵向时间线 + 右 30% 选中论文详情
               *   debt      左 40% 债务列表   + 右 60% 选中债务详情
               *
               * 详情栏只在选中时显示内容，未选中给一句提示语。
               * 仍然是静态 flex 兄弟（不用 absolute）—— 零重叠靠结构保证。
               */
              <div className="flex min-h-0 w-full flex-1 flex-col">
              <div className="flex min-h-0 min-h-0 w-full flex-1">
                <div
                  data-split-left
                  className={'relative min-h-0 min-w-0 ' + (view === 'debt' ? 'w-[40%]' : 'w-[70%]')}
                  /* ── P21：把视图底图补回来 ──
                     底图原本由 CanvasStage 画在画布上。evolution/debt 改成两栏后
                     那两个视图**没有画布了**，底图跟着一起消失 —— 实测左侧内容列
                     backgroundImage 变成 `none`，verify-p15 的 F1b/F2/F4
                     （五处底图两两互异）当场报红。
                     这不是"断言过时"，是**真实的视觉回归**：那两个视图变成纯白一片，
                     与 dna 的灰点阵不一致。所以从 VIEW_PATTERN（同一份单一事实源）
                     按视图取，画在与画布等价的"内容区"上。 */
                  style={{
                    backgroundColor: VIEW_PATTERN[view]?.bg,
                    backgroundImage: VIEW_PATTERN[view]?.image,
                    backgroundSize: VIEW_PATTERN[view]?.size,
                  }}
                >
                  {view === 'evolution' ? (
                    /* 演化：纵向时间线（年份 / 论文 / 一句话问题，可展开方法与结果） */
                    <TimelineList
                      papers={data.papers}
                      debts={data.debts}
                      selectedPaperId={selectedPaperId}
                      onSelectPaper={setSelectedPaperId}
                    />
                  ) : view === 'debt' ? (
                    /* 债务：列表（状态色条 + 标题 + 涉及论文数） */
                    <DebtList
                      debts={data.debts}
                      selectedDebtId={selectedDebtId}
                      onSelectDebt={setSelectedDebtId}
                    />
                  ) : (
                <CanvasStage
                  nodes={layout.nodes}
                  edges={layout.edges}
                  contentW={layout.width}
                  contentH={layout.height}
                  bounds={layout.bounds}
                  timeline={layout.timeline}
                  list={layout.list}
                  viewId={view}
                  selectedId={selectedId}
                  intervenedIds={intervenedIds}
                  onNodeClick={onNodeClick}
                  onBackgroundClick={() => dispatch({ type: 'select', id: null })}
                  emptyTitle={layout.emptyTitle}
                  emptyHint={layout.emptyHint}
                  emptyAction={avail.action}
                  onEmptyAction={() => handleEmptyAction(view)}
                  panelOpen={Boolean(panelContent)}
                  cornerNote={avail.cornerNote}
                  /* ── P21：画布不再自己渲染上下文横条 ──
                     横条改由这一列统一渲染（见左列末尾那段），否则 dna 视图
                     会出现两条一模一样的横条（画布一条 + 列一条）——
                     正是本轮反复要消灭的"同一内容出现两份"。 */
                  contextStrip={null}
                  surgeryMode={surgeryMode}
                  surgeryAvailable={view === 'dna' && layout.nodes.some((n) => Boolean(n.block))}
                  // P14 分区锁：剪刀只看手术区是否忙，他区动作不再连坐
                  surgeryPending={feedback.isBusy('surgery')}
                  onToggleSurgery={() => dispatch({ type: 'toggleSurgery' })}
                  onSurgeryPick={handleSurgeryPick}
                  /**
                   * ── 问题 1：上传按钮固定在画布左上角 ──
                   *
                   * 画布只发"被点了"的信号，真正的 file input 点击在这里。
                   * 为什么用 getElementById 而不是把 ref 传下去：
                   *   input 挂在 LabShell 顶层（跨视图共用一份），
                   *   传 ref 会让 CanvasStage 与"上传"这件事强耦合，
                   *   而它本质只管画布渲染。按 id 取是这里最松的耦合。
                   */
                  onRequestUpload={() => {
                    const el = document.getElementById('lab-upload-input') as HTMLInputElement | null
                    el?.click()
                  }}
                  uploadPending={Boolean(uploadingName)}
                  uploadNote={uploadingName}
                  degradedReason={degradedReason}
                  /* ── P19 细节 2：画布右下角的缩放条与 logo 都已移出 ──
                     缩放条（data-zoom-*）整体删除 —— 产品要求「logo 和缩放条
                     从画布移走」，两者原本在右下角互相压叠。缩放仍可通过
                     画布自动适应（fit）与滚轮/拖拽完成；logo 现在只在左栏底部。 */
                />

                  )}

                  {/* ── 上下文横条（P7-4）：跨步骤传来的动态上下文 ──
                      P21：原来只有 CanvasStage 渲染它，所以改两栏后
                      **演化/债务视图的横条整个消失了**（实测抓到：
                      "本次手术干预了 N 个 Block" 在演化视图看不到）。
                      现在提到这一列统一渲染 —— dna 由画布让位（它传 null），
                      演化/债务由这里显示，三个视图行为一致。 */}
                  {contextStrip && (
                    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-3">
                      <div
                        data-context-strip
                        className="flex items-center gap-1.5 rounded-full border border-line bg-white/90 px-3 py-1.5 backdrop-blur-sm"
                      >
                        <span aria-hidden className="text-[11px]" style={{ color: '#2563eb' }}>
                          ↳
                        </span>
                        <span className="text-[11px] text-ink-muted">{contextStrip.text}</span>
                      </div>
                    </div>
                  )}

                  {/* 真实动作反馈条（成功=绿、失败=红、进行中=灰，非转圈动画） */}
                  <ActionBar feedback={feedback.feedback} onClear={feedback.clear} />
                </div>

                {/* ── 右侧详情栏（P21）：选中项详情；未选中给一句提示语 ── */}
                <DetailRail
                  content={railContent}
                  onClose={() => {
                    if (view === 'evolution') setSelectedPaperId(null)
                    else if (view === 'debt') setSelectedDebtId(null)
                    else dispatch({ type: 'select', id: null })
                  }}
                  onAction={handlePanelAction}
                  pending={feedback.pending}
                  isActionBusy={isPanelActionBusy}
                  placeholder={railPlaceholder}
                  accent={viewColor(view)}
                  borderColor={VIEW_SOFT_BORDER[view]}
                  width={view === 'debt' ? '60%' : '30%'}
                />
              </div>

              {/* ── 底部数据看板（P21 B 方案）：4 统计卡片 + 2 图表，可折叠 ──
                  折叠时画布/内容列自动吃掉剩余高度（flex 自然伸缩，不用 absolute）。 */}
              <Dashboard
                stats={dashContent.stats}
                charts={dashContent.charts}
                open={dashOpen}
                onToggle={() => setDashOpen((o) => !o)}
                collapsedHint={dashContent.collapsedHint}
              />
              </div>
            )}

            {/**
             * ── P19 问题 3③ / 减展示 5：AI 讨论（底部，默认折叠）──
             *
             * 挂在画布列 flex-col 的末尾（与 BottomPanel 同款机制：
             * 展开占固定高度、画布自动收缩，收起只剩标题行）。
             * 本轮两处变化：
             *   · **默认折叠**（P19 要求"底部：AI 讨论（默认折叠）"），
             *     由 LabShell 的 chatOpen 控制 —— 右下角浮动按钮
             *     「与MethodAtlas共同探索」是它的开关；
             *   · 只在击穿测试视图出现（讨论对象是"某个想法"）。
             *
             * 会话历史仍在 LabShell（chats），切视图不丢。
             */}
            {view === 'crashtest' ? (
              <CrashChatPanel
                ideas={data.ideas}
                selectedIds={state.crashIdeaIds}
                activeId={chatActiveId ?? activeCrashIdea?.id ?? null}
                onActiveChange={(id) => setChatActiveId(id)}
                chats={chats}
                onSend={handleChatSend}
                sending={chatSending}
                open={chatOpen}
                onOpenChange={setChatOpen}
              />
            ) : null}

            {/**
             * ── P21：这里的底部详情面板已删除 ──
             *
             * 原因（用户实拍指出）：dna / evolution / debt 改成两栏后，
             * 详情由**右侧 DetailRail** 承担，而这里还挂着一份同样的
             * BottomPanel —— 同一份 panelContent 在屏幕上出现了两次
             * （右栏一次、底部一次，内容一模一样），必须删掉重复的那份。
             *
             * 保留它也没有意义：画布列的高度是给画布用的，多一个底部面板
             * 只会挤压画布。想法视图的那份在它自己的分支里（见 idea 分支），
             * 不受影响。
             */}

            {/**
             * ── P21：浮标只在击穿测试视图出现 ──
             *
             * 用户实拍指出：这个「与MethodAtlas共同探索」按钮在 DNA 视图
             * 也出现了，但那里**根本没有 AI 讨论面板**（CrashChatPanel 只在
             * crashtest 渲染）—— 点了只会把 chatOpen 置位，用户看不到任何
             * 反馈，是个"点了没反应"的死按钮。
             *
             * 按产品给的判据处理：**只在击穿测试里有用的按钮，就别在别的
             * 视图里出现**。所以这里加 view === 'crashtest' 条件，而不是
             * 让它"在别处点了自动跳到击穿视图"—— 那等于偷偷换了用户的视图，
             * 而且本轮约束明确说了不新增功能。
             *
             * ── 为什么 bottom 是算出来的，不是写死 12px ──
             * AI 讨论 dock 是内容列底部的全宽条，右下角正好是它的「话题下拉」。
             * 浮标固定 bottom-3 会压住下拉（2890px²），展开后还压住输入框与
             * 发送按钮（4536 / 1008px²）。所以让它贴着 dock 顶边停靠：
             * dock 折叠时落在右下角，展开时自动上移到 dock 之上。
             */}
            {view === 'crashtest' && (
              <button
                type="button"
                data-explore-fab
                data-explore-open={chatOpen ? '1' : '0'}
                onClick={() => setChatOpen((o) => !o)}
                style={{ bottom: chatOpen ? 272 : 48 }}
                title={
                  chatOpen
                    ? '收起 AI 讨论面板'
                    : '展开 AI 讨论面板：就当前想法向系统提问（上下文自动带上目标债务与来源方法）'
                }
                className="ma-card-in absolute right-3 z-20 flex items-center gap-1.5 rounded-full border border-line bg-white/95 px-3 py-2 text-meta font-medium text-ink-soft backdrop-blur-sm transition-[bottom] duration-150 hover:border-accent hover:text-accent"
              >
                <span aria-hidden className="text-[12px] leading-none">
                  ✦
                </span>
                与MethodAtlas共同探索
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── 需求 A：重置的二次确认框 ──
          一级重置只清前端运行态，二级重置连库里的想法一起清。
          两者的措辞必须让用户一眼看出差别（会不会删掉已生成的想法）。 */}
      <ConfirmDialog
        open={confirm === 'run'}
        title="重置为运行前的初始状态？"
        description="将清空目标债务、已选模块、已选债务、跑过标记与击穿测试的选中项，并收起详情面板。已导入的论文、方法 DNA、演化关系与债务库都会保留。"
        confirmLabel="重置"
        onConfirm={() => {
          setConfirm(null)
          handleResetRun()
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'data'}
        title="彻底重置运行数据？"
        description="将删除全部已生成的组合想法、击穿测试结果与方法手术记录，并清空界面上的运行状态。论文、方法 DNA、演化关系与债务库仍会保留。此操作不可撤销。"
        confirmLabel="彻底重置"
        danger
        pending={feedback.pending}
        onConfirm={() => {
          setConfirm(null)
          handleResetData()
        }}
        onCancel={() => setConfirm(null)}
      />

      {/**
       * ── P18 开场页（全屏浮层，工作台的兄弟节点）──
       *
       * 纯色底（#fafafa）+ logo 居中（屏高约 36%）+「开始探索」按钮
       * （logo 下方 48px）。点击 → 写 sessionStorage['intro-seen'] →
       * 'fading'：本层 500ms 淡出，同时工作台根元素 500ms 淡入
       * —— 交叉执行，不是"先淡出再淡入"；520ms 后本层卸载（DOM
       * 移除，等价 display:none）。不走路由（无 URL 变化、无 RSC 请求）。
       *
       * z-[100] 压过一切（含 z-20 浮层与确认框）；'fading' 期间
       * pointer-events:none 让最后一帧点击不至于卡在正在消失的层上。
       *
       * ⚠ 必须渲染在根 div 之外（Fragment 兄弟）：放里面会被
       * 'show' 态的父级 opacity:0 连坐成白屏（见上方 return 注释）。
       */}
    </div>
    {intro !== 'gone' && (
        <div
          data-intro-page
          aria-hidden={intro !== 'show'}
          /* ── P19 第四部分：背景改纯白 ──
             原来写的是 #fafafa（近白），在部分显示器/色彩配置下与工作台的
             纯白不同色，用户看到"欢迎页有一条轻微色差"。产品明确要求
             #ffffff。这里同时显式关掉任何继承来的底色（bg-white 即 #ffffff），
             与 body 的 `@apply bg-white` 完全一致。 */
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-white"
          style={{
            opacity: intro === 'fading' ? 0 : 1,
            transition: 'opacity 500ms ease-in-out',
            pointerEvents: intro === 'fading' ? 'none' : 'auto',
          }}
        >
          <img
            src="/logo.png"
            alt="MethodAtlas"
            draggable={false}
            /* ── P21：开场页动效 ──
               logo = 淡入 + 上移 16px（0.36s ease-out），按钮只淡入。
               为什么按钮不一起上移：logo 是视觉主体，让它先"落位"，
               按钮随后淡入，读起来是"先看到品牌、再看到入口"。 */
            className="ma-intro-logo h-[36vh] w-auto select-none"
          />
          <button
            type="button"
            data-intro-start
            onClick={beginExploring}
            /* ── P19 细节 1：按钮改蓝紫渐变 ──
               原来是纯深蓝 #2563eb，与 logo 的蓝紫渐变不搭。
               取 logo 上已有的两个端色（蓝 #2563eb → 紫 #7c3aed）做线性渐变，
               既呼应 logo，又保持"主色只用于可操作元素"的纪律。
               text-white + 稍加深的投影让白字在渐变上对比度足够（WCAG AA）。 */
            className="ma-intro-fade mt-12 rounded-block px-8 py-3 text-body font-medium text-white transition-[filter] hover:brightness-110"
            style={{ backgroundImage: 'linear-gradient(96deg, #2563eb 0%, #4f46e5 55%, #7c3aed 100%)' }}
          >
            开始探索
          </button>
        </div>
      )}
    </>
  )
}

/**
 * 把状态序列化到 URL —— **唯一允许调 replaceState 的地方**（P7-4 纪律）。
 *
 * 为什么强调"唯一写者"：上下文参数多了之后（debtId/ideaId/from），
 * 如果各个 dispatch 点各写一次 URL，很容易互相覆盖、写出矛盾状态。
 * 只由本函数从完整 state 一次性序列化，就不会有这种问题。
 */
function syncUrl(s: State) {
  if (typeof window === 'undefined') return
  const sp = new URLSearchParams()
  sp.set('view', s.view)
  if (s.view === 'dna' && s.paperId) sp.set('paper', s.paperId)
  if (s.contextDebtId) sp.set('debtId', s.contextDebtId)
  if (s.contextIdeaId) sp.set('ideaId', s.contextIdeaId)
  if (s.fromStep) sp.set('from', s.fromStep)
  // 剪刀模式也同步到 URL：刷新后仍停在手术模式，且可分享"我要做手术"这个意图
  if (s.surgeryMode) sp.set('surgery', '1')
  /**
   * ── 问题 2：勾选写进 URL ──
   *
   * 只在 idea 视图写：勾选是工作台的概念，其他视图里带着一串
   * blockIds/debtIds 是噪音，而且会让分享出去的 DNA 链接变得莫名其妙。
   * 切走时这两个参数随之消失（state 里仍保留，切回来会重新写入）——
   * 这正是"切走再切回来勾选还在"要实现的效果。
   */
  if (s.view === 'idea') {
    if (s.pickedBlockIds.length > 0) sp.set('blockIds', s.pickedBlockIds.join(','))
    if (s.pickedDebtIds.length > 0) sp.set('debtIds', s.pickedDebtIds.join(','))
    // 问题 4：跑过的标记同样只在 idea 视图有意义
    if (s.hasRun) sp.set('ran', '1')
  }
  /**
   * ── 需求 B：击穿想法选中写进 URL ──
   *
   * 与 blockIds 同一纪律：只在自己的视图里写。选中的想法是击穿测试的
   * 运行输入，出现在别的视图链接里同样是噪音。
   */
  if (s.view === 'crashtest' && s.crashIdeaIds.length > 0) {
    sp.set('crashIdeaIds', s.crashIdeaIds.join(','))
  }
  const next = `${window.location.pathname}?${sp.toString()}`
  if (next !== window.location.pathname + window.location.search) {
    window.history.replaceState(null, '', next)
  }
}
