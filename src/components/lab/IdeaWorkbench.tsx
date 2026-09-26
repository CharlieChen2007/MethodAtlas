'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { LabData } from '@/lib/lab/views'
import { PATTERN_IDEA_WORKBENCH } from '@/lib/lab/palette'
import { categoryLabel } from '@/lib/lab/view-layout'

/**
 * ── 问题 4：组合想法「用户主导」的三栏工作台 ──
 *
 * ── 为什么要换掉原来的画布卡片 ──
 *
 * 原来点「重新生成组合」→ 系统在全池里自动配对 → 画布上出现几张想法卡片。
 * 用户全程是**旁观者**：他不知道候选为什么是这几个，也不能说
 * "我要的是 A 和 B、针对这条债务"。产品原话是「改成用户主导」。
 *
 * 所以这里做成工作台：
 *   [左] 研究债务   —— 选"要解决什么问题"（可多选；选 0 条 = 让系统自选）
 *   [中] 可选 Block 池（按论文分组）—— 选"拿哪些模块来拼"
 *   [右] 已选 Block + 目标债务 + 「生成组合」
 *
 * ── 三个刻意的设计决定 ──
 *
 * 1. **默认推荐，但可改**：进视图时不预选任何东西 —— 直接点「生成组合」
 *    就等于"系统你用全池给我建议"（沿用原自动模式）；一旦勾选，
 *    生成就严格按勾选来。两条路都在，不是用一条替掉另一条。
 *
 * 2. **只列出真正可用的素材**：Block 池只列有名称的模块；
 *    债务池只列识别出来的债务。空的情况如实说"还没有"，
 *    而不是画一堆占位让人以为能选。
 *
 * 3. **跨论文约束前置**：组合必须跨论文才成立。所以一旦用户选的 Block
 *    全部来自同一篇论文，就在右侧**立刻**给出警告，而不是等他点完
 *    「生成组合」再被服务端拒绝 —— 那是把校验成本推给用户。
 */

/**
 * 池子里一个可选的 Block（带来源论文，用于分组与跨论文判定）
 */
interface PoolBlock {
  id: string
  name: string
  paperId: string
  paperTitle: string
}

/**
 * 三栏宽度分配（合计 100%）。
 *
 * ── 为什么是"三栏 + 右栏内分两段"，而不是"四栏平铺" ──
 * 工作台只拿到画布位（约 75% 宽，25% 留给右栏视图切换器 ——
 * 见 LabShell 的说明：藏掉右栏会让用户无法切视图）。
 * 75% 里若硬切四栏，每栏不到 19%，模块名要截成两三个字、分组标题也放不下。
 * 所以合并成 3 栏，把「已选 + 生成」与「结果」上下叠在**同一栏**里：
 *   左 30% = 债务（问题）
 *   中 === = Block 池（按论文分组，最宽）
 *   右 30% = 上半 已选 + 生成按钮 / 下半 已生成的想法
 * 右栏上下叠还有个额外好处：用户点完"生成"，结果就出现在同一列的
 * 正下方 —— 视线不用横跨整个屏幕。
 */
const COL_DEBT = '30%'
const COL_POOL = 'flex-[1]'
const COL_RIGHT = '32%'

/**
 * ── P18 问题 1：字体统一 ──
 *
 * P15 曾按"分区异字体"给四栏分别指定 serif/mono 制造层级感；
 * P18 要求全局统一字体栈（Inter 优先、中文回落 PingFang/雅黑 ——
 * 见 globals.css 的 body 定义），因此删除 FONT_SERIF / FONT_MONO
 * 两套覆盖，所有区域回落到全局字体。
 */

/**
 * ── P16 问题二：中列论文分组的彩色分隔线 ──
 *
 * 每篇论文一个专属色（6 色循环，论文再多也不会出现"同色相邻组"
 * 的混淆——第 7 篇与第 1 篇同色时中间隔着 5 组）。两个用途：
 *   · DIVIDER[i] 亮色：组标题上方的 2px 横线（首组不放——上面已是
 *     栏标题，再放一条线就是噪音）；
 *   · LABEL[i] 深色：组标题文字的颜色（亮色在白底上对比度不够）。
 * 颜色只落在装饰线与组标题上，**不碰**模块按钮本身 —— 选择态
 * （蓝框/蓝底）与生成逻辑完全不受影响。
 */
const PAPER_DIVIDER = ['#93c5fd', '#86efac', '#fdba74', '#c4b5fd', '#fca5a5', '#d1d5db']
const PAPER_LABEL = ['#1d4ed8', '#15803d', '#c2410c', '#6d28d9', '#b91c1c', '#4b5563']

export function IdeaWorkbench({
  data,
  pending,
  onGenerate,
  onSelectIdea,
  pickedBlockIds,
  pickedDebtIds,
  contextDebtId,
  hasRun,
  onSelectionChange,
  onAddCustomBlock,
}: {
  data: LabData
  pending: boolean
  /** 点「生成组合」—— 把用户的勾选交给后端 */
  onGenerate: (selection: { blockIds: string[]; debtIds: string[] }) => void
  /**
   * ⚠️ 需求 B 后本视图不再渲染想法卡片（列表已搬到击穿测试），
   *    所以 onSelectIdea 也就不再被调用。这里保留参数是为了不破坏
   *    调用方签名之外的其他用法；真正点开想法现在走击穿测试视图。
   *    tsc 的 noUnusedParameters 未开启，保留是安全的。
   */
  onSelectIdea: (id: string) => void
  /**
   * ── 问题 2：勾选是**受控**的 ──
   *
   * 真值在 LabShell 的 state（进而写进 URL），这里只负责渲染与上报。
   * 组件内部仍保留一份 Set 作为"点击即时响应"的本地镜像 ——
   * 但每次变更都把**完整集合**同步给父级，由父级决定去留。
   *
   * 为什么要本地 Set + 受控双写，而不是纯受控（每次点击等都走
   * 父级 → 重渲染）：
   *   连续快速点击时纯受控会出现"点击丢失"（父级 state 更新滞后，
   *   第二次点击读到的是旧的 Set）。本地 Set 保证每次点击都作用在
   *   最新集合上，父级只做最终记录。
   */
  pickedBlockIds: string[]
  pickedDebtIds: string[]
  /**
   * ── 问题 1：从债务视图带过来的目标债务 ──
   *
   * 用户点「围绕它生成组合想法」→ 跳转到本视图并带上这条债务的 id。
   * 工作台进视图时**自动勾选**它，右栏「目标债务」于是显示
   * 「目标债务：<标题>」而不是「目标债务 0」。
   */
  contextDebtId: string | null
  /** ── 问题 4：这个工作台跑过生成没有（三态判定的依据）── */
  hasRun: boolean
  /** 勾选变化时上报（父级写进 URL） */
  onSelectionChange: (selection: { blockIds: string[]; debtIds: string[] }) => void
  /** ── P18 问题 2：提交手动添加的模块（LabShell 调 action 落库并加入已选）── */
  onAddCustomBlock: (name: string, description: string, paperId: string | null) => void
}) {
  /**
   * 本地镜像。初始值来自父级（URL 恢复 / 跳转带入）。
   *
   * ⚠️ 这里**不能**把父级 props 直接当唯一真值：onClick 需要同步读到
   * "当前已选什么"，而 React state 更新是异步的。用本地 Set 承接点击，
   * 每次变更把结果 push 给父级即可。
   */
  const [pickedBlocks, setPickedBlocks] = useState<Set<string>>(
    () => new Set(pickedBlockIds)
  )
  const [pickedDebts, setPickedDebts] = useState<Set<string>>(() => new Set(pickedDebtIds))

  /**
   * ── 问题 1：URL/跳转带来的目标债务，自动勾上 ──
   *
   * 为什么用 effect 而不是初始化时合并：
   *   contextDebtId 可能在本组件挂载之后才变化（例如用户先落在 idea 视图，
   *   再从底部面板点了一条债务的「围绕它生成想法」——此时组件已挂载）。
   *   用 effect 才能覆盖"挂载后再带进来"的情况。
   *
   * 只在"这条债务存在、且当前没被勾上"时才动 —— 避免每次重渲染都把
   * 用户手动取消的勾选又加回去（那会让用户永远取消不掉）。
   */
  const debtIdsKey = data.debts.map((d) => d.id).join(',')
  useEffect(() => {
    if (!contextDebtId) return
    if (!data.debts.some((d) => d.id === contextDebtId)) return
    setPickedDebts((prev) => {
      if (prev.has(contextDebtId)) return prev
      const next = new Set(prev)
      next.add(contextDebtId)
      return next
    })
    // pickedDebts 不进依赖：值变化不该重跑本 effect，
    // 否则用户手动取消勾选后会被立刻加回来。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextDebtId, debtIdsKey])

  /**
   * ── 问题 2：父级（URL）变化时把本地镜像对齐 ──
   *
   * 场景：浏览器后退/前进、"切走再切回来"时 LabShell 从 URL 读回勾选，
   * 以新 props 传下来。此时本地 Set 必须同步，否则界面显示的还是旧的。
   *
   * ⚠️ 关键：**不能把 contextDebtId 带来的勾选冲掉**。
   *
   * 这里踩过一个很隐蔽的坑（问题 1 因此失效）：
   *   ① contextDebtId 的 effect 把目标债务勾上 →
   *   ② 本 effect 随即用 URL 里的 `debtIds`（空）覆盖整个 pickedDebts →
   *      勾选被清空，右栏又变回「未指定债务」。
   *   两个 effect 互相打架，症状是"URL 明明带 debtId，界面却说没指定"。
   *
   * 修法：本 effect 只负责**对齐父级显式写下的 blockIds/debtIds**，
   * 并把 contextDebtId 作为**基线**合并进来（它是"意图"，不是"可被覆盖的状态"）。
   * 这样两边不再冲突：context 永远在集合里，除非用户自己取消。
   */
  const propsKey = `${[...pickedBlockIds].sort().join(',')}|${[...pickedDebtIds].sort().join(',')}`
  useEffect(() => {
    setPickedBlocks(new Set(pickedBlockIds))
    setPickedDebts(() => {
      const next = new Set(pickedDebtIds)
      // contextDebtId 是"必须包含"的意图债务，合并而非被覆盖
      if (contextDebtId && data.debts.some((d) => d.id === contextDebtId)) {
        next.add(contextDebtId)
      }
      return next
    })
    // propsKey 是 props 内容的稳定摘要；分开列 props 会因数组引用变化而误触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propsKey, contextDebtId])

  /**
   * Block 池：把 data.papers 摊平成 (block, paper) 对，再按论文分组。
   * 为什么用 papers 而不是另查一个 blocks 表：LabData 里 blocks 本就
   * 挂在 paper 下，再查一次既多余又可能和画布数据不一致。
   */
  const grouped = useMemo(() => {
    const groups: Array<{ paperId: string; paperTitle: string; blocks: PoolBlock[] }> = []
    for (const p of data.papers) {
      const blocks: PoolBlock[] = p.blocks
        .filter((b) => (b.name || '').trim())
        .map((b) => ({ id: b.id, name: b.name, paperId: p.id, paperTitle: p.title }))
      if (blocks.length > 0) {
        groups.push({ paperId: p.id, paperTitle: p.title, blocks })
      }
    }
    return groups
  }, [data.papers])

  const allBlocks = useMemo(() => grouped.flatMap((g) => g.blocks), [grouped])

  /**
   * ── 问题 2：把本地勾选上报给父级（写 URL）──
   *
   * 为什么用 effect 上报，而不是在 onClick 里直接调 onSelectionChange：
   *
   *   在 onClick 里 `setPickedBlocks(next) + emit(next)` 会踩两个坑：
   *     ① 若在 setState 的 **updater 函数**里调父级 setState ——
   *        updater 在 render 阶段执行，React 直接抛
   *        "Cannot update a component (LabShell) while rendering
   *         a different component (IdeaWorkbench)"，且 commit 半途而废，
   *        表现为按钮点了没反应（真实发生过的 bug）。
   *     ② 若改成"用闭包里的 pickedBlocks 算 next" ——
   *        同一 tick 内连点两个模块时，两次 onClick 都读到同一份旧值，
   *        后一次会覆盖前一次，**丢点击**（同样真实发生过）。
   *
   *   两条路都错。正确做法是两条分开：
   *     · 点击只做一件事 —— setState(updater)，用函数式更新保证连点不丢；
   *     · 上报交给 effect —— 它读到的永远是 commit 之后的最新 Set。
   *
   *   effect 依赖用"排序后拼接"的字符串摘要，而不是 Set 引用：
   *   每次 setState 都会新建 Set，引用比较会无限触发上报。
   */
  const pickedBlocksKey = Array.from(pickedBlocks).sort().join(',')
  const pickedDebtsKey = Array.from(pickedDebts).sort().join(',')
  const didMountRef = useRef(false)
  useEffect(() => {
    /**
     * 首次挂载的跳过条件要比"是不是第一次渲染"更细：
     *
     * 若 URL 只带了 `debtId`（问题 1 的跳转入口）而没有 `debtIds`，
     * 那么组件内部**刚刚**才把这条债务勾上 —— 这是一次真实的状态变化，
     * 必须上报给父级，否则：
     *   · 父级的 pickedDebts 一直是空；
     *   · URL 里始终不出现 debtIds；
     *   · 一旦父级因任何原因重渲染，本地勾选就可能被同步回去清掉。
     *
     * 只有"首帧 + 没有任何 context 债务要记"时才跳过，
     * 因为那种情况下父级 props 已经与本地完全一致，上报纯属回写抖动。
     */
    const isFirst = !didMountRef.current
    didMountRef.current = true
    if (isFirst && !contextDebtId) return

    onSelectionChange({
      blockIds: Array.from(pickedBlocks),
      debtIds: Array.from(pickedDebts),
    })
    // pickedBlocksKey / pickedDebtsKey 是内容的稳定摘要，足以驱动上报
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedBlocksKey, pickedDebtsKey])

  const toggleBlock = (id: string) => {
    setPickedBlocks((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleDebt = (id: string) => {
    setPickedDebts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 已选 Block 涉及的论文数 —— 跨论文约束的判定依据 */
  const pickedPapers = useMemo(() => {
    const s = new Set<string>()
    for (const b of allBlocks) if (pickedBlocks.has(b.id)) s.add(b.paperId)
    return s
  }, [allBlocks, pickedBlocks])

  const crossPaperWarning =
    pickedBlocks.size > 0 && pickedPapers.size < 2
      ? '组合必须跨论文：现在选的模块都来自同一篇论文，生成会被拦下。请再选一篇论文里的模块。'
      : null

  /**
   * ── 问题 4（P9）：生成的门槛 ──
   *
   * 旧逻辑 `allBlocks.length > 0 && data.debts.length > 0` 只看**池子非空**，
   * 不看用户选了什么 —— 于是用户什么都不选也能点"生成组合"，
   * 系统拿全池跑出一堆想法。用户看到"已生成的想法"里有东西，
   * 但那不是他点出来的，读起来就像系统预置的。
   *
   * 现在要求：**至少选 2 个模块**。理由：
   *   · 组合的本质是"把两个不同模块拼起来"，1 个模块构不成组合；
   *   · 这条约束和跨论文约束一起，保证每次生成都是用户明确选择的结果。
   *
   * 债务仍然可以不选（系统会挑最相关的一条），但会提示建议选。
   */
  const MIN_MODULES = 2
  const pickedModuleCount = pickedBlocks.size
  const tooFewModules = pickedModuleCount < MIN_MODULES

  /**
   * 提示语的**优先级**（重要）：
   *   模块数不够 > 跨论文。因为"只选了 1 个"是更前置、更基础的问题 ——
   *   用户连 2 个都没选够时，跟他讲"要跨论文"是跳跃的。
   *   两件事都满足之前，按钮都不可点。
   */
  const gateHint: string | null =
    allBlocks.length === 0
      ? '还没有可用的方法模块，请先运行「方法 DNA 抽取」。'
      : data.debts.length === 0
        ? '还没有研究债务 —— 组合想法需要一条要解决的问题作为目标。'
        : pickedModuleCount === 0
          ? `请至少选 ${MIN_MODULES} 个模块（你还没选）。`
          : tooFewModules
            ? `请至少选 ${MIN_MODULES} 个模块（现在只选了 ${pickedModuleCount} 个）。`
            : crossPaperWarning

  /** 这条提示属于"跨论文"性质还是"选够模块"性质 —— 决定渲染措辞 */
  const gateHintIsCrossPaper = gateHint !== null && gateHint === crossPaperWarning

  const canGenerate = !pending && gateHint === null

  const pickedBlockList = allBlocks.filter((b) => pickedBlocks.has(b.id))
  const pickedDebtList = data.debts.filter((d) => pickedDebts.has(d.id))

  return (
    <div
      className="flex h-full w-full min-h-0"
      data-idea-workbench
      data-picked-blocks={pickedBlocks.size}
      data-picked-debts={pickedDebts.size}
      style={{
        // P15 需求六：工作台底纹（绿调细点，与其他视图的图案互不相同）
        backgroundColor: PATTERN_IDEA_WORKBENCH.bg,
        backgroundImage: PATTERN_IDEA_WORKBENCH.image,
        backgroundSize: PATTERN_IDEA_WORKBENCH.size,
      }}
    >
      {/* ───────── 左栏：研究债务 ───────── */}
      <section
        className="flex h-full shrink-0 flex-col border-r-2 border-[#86efac]"
        style={{ width: COL_DEBT }}
      >
        <Header
          title="① 要解决什么问题"
          hint={
            data.debts.length > 0
              ? `选定目标债务（可多选；不选则由系统自选）。共 ${data.debts.length} 条。`
              : '还没有识别出研究债务。'
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          {data.debts.length === 0 && (
            <Empty text="组合想法必须建立在研究债务之上。请先运行「债务合成」。" />
          )}
          <div className="flex flex-col gap-2">
            {data.debts.map((d) => {
              const on = pickedDebts.has(d.id)
              return (
                <button
                  key={d.id}
                  type="button"
                  data-debt-option={d.id}
                  data-picked={on ? '1' : '0'}
                  onClick={() => toggleDebt(d.id)}
                  disabled={pending}
                  /* P20：债务候选逐项交错淡入（列表出场动画，见 globals.css） */
                  className="ma-list-item rounded-block border px-3 py-2.5 text-left transition-colors disabled:opacity-60"
                  style={{
                    borderColor: on ? '#2563eb' : '#e5e7eb',
                    background: on ? '#eff6ff' : '#ffffff',
                  }}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className="mt-[1px] shrink-0 text-meta"
                      style={{ color: on ? '#2563eb' : '#9ca3af' }}
                      aria-hidden
                    >
                      {on ? '●' : '○'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-body font-medium text-ink">{d.title}</span>
                      <span className="mt-0.5 block text-micro text-ink-faint">
                        {categoryLabel(d.category)} · {d.occurrenceCount} 篇论文提及
                      </span>
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {/* ───────── 中栏：可选 Block 池（按论文分组） ───────── */}
      <section className={`flex h-full min-w-0 flex-col ${COL_POOL}`}>
        <Header
          title="② 拿哪些模块来拼"
          hint={
            allBlocks.length > 0
              ? `从不同论文里挑模块（跨论文是硬条件）。共 ${allBlocks.length} 个，来自 ${grouped.length} 篇论文。`
              : '还没有任何论文抽取出方法模块。'
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          {allBlocks.length === 0 && (
            <Empty text="先上传论文并运行方法抽取，这里才会出现可选模块。" />
          )}
          <div className="flex flex-col gap-2">
            {grouped.map((g, gi) => {
              // P16 问题二：论文专属色（6 色循环）；亮色画线、深色写字
              const dividerColor = PAPER_DIVIDER[gi % PAPER_DIVIDER.length]
              const labelColor = PAPER_LABEL[gi % PAPER_LABEL.length]
              return (
              <div key={g.paperId} data-paper-group={g.paperId} data-paper-title={g.paperTitle}>
                {/* P16 问题二：论文间彩色分隔线 —— 不同来源一眼可辨。
                    首组不放线（上方就是栏标题，再加线是噪音）。 */}
                {gi > 0 && (
                  <div
                    aria-hidden
                    className="mb-2 h-0.5 rounded-full"
                    style={{ background: dividerColor }}
                  />
                )}
                {/* 论文分组标题：标题文字跟随组色（深一档，保证对比度），
                    "来自哪篇论文"在线和字上是同一套颜色语言 */}
                <div className="mb-1.5 flex items-center gap-2">
                  <span
                    className="truncate text-meta font-medium"
                    style={{ color: labelColor }}
                    title={g.paperTitle}
                  >
                    {g.paperTitle}
                  </span>
                  <span className="shrink-0 text-micro text-ink-faint">{g.blocks.length}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {g.blocks.map((b) => {
                    const on = pickedBlocks.has(b.id)
                    return (
                      <button
                        key={b.id}
                        type="button"
                        data-block-option={b.id}
                        data-picked={on ? '1' : '0'}
                        onClick={() => toggleBlock(b.id)}
                        disabled={pending}
                        /* P20：模块候选逐项交错淡入。
                           ⚠️ 这里是 `:nth-child` 计数 —— 每个模块按钮在它
                           所属的 [data-paper-group] 里是第 N 个，所以延迟
                           会按"每组内序号"重置，读起来是分组入场，正合适。 */
                        className="ma-list-item flex items-center gap-2 rounded-block border px-3 py-2 text-left transition-colors disabled:opacity-60"
                        style={{
                          borderColor: on ? '#2563eb' : '#e5e7eb',
                          background: on ? '#eff6ff' : '#ffffff',
                        }}
                      >
                        <span
                          className="shrink-0 text-meta"
                          style={{ color: on ? '#2563eb' : '#9ca3af' }}
                          aria-hidden
                        >
                          {on ? '●' : '○'}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-body text-ink">{b.name}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* ───────── 右栏：上半 已选 + 生成 / 下半 已生成的想法 ───────── */}
      <section
        className="flex h-full shrink-0 flex-col border-l-2 border-[#93c5fd]"
        style={{ width: COL_RIGHT }}
      >
        {/* ── 上半：确认选择 ── */}
        <div className="flex min-h-0 flex-[1] flex-col">
          <Header title="③ 生成组合" hint="确认你的选择，再生成候选方案。" />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
            {/* 已选 Block */}
            <div className="mb-2">
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-meta font-medium text-ink-muted">已选模块</span>
                <span className="text-micro text-ink-faint" data-selected-blocks>
                  {pickedBlockList.length > 0 ? `${pickedBlockList.length} 个` : '未选模块'}
                </span>
              </div>
              {pickedBlockList.length === 0 ? (
                <p className="text-micro text-ink-faint">
                  未选 —— 请至少选 {MIN_MODULES} 个模块。系统不会替你挑模块。
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {pickedBlockList.map((b) => (
                    <li key={b.id} className="flex items-start gap-1.5 text-micro text-ink">
                      <span className="mt-[1px] shrink-0 text-accent" aria-hidden>
                        ·
                      </span>
                      <span className="min-w-0 flex-1">
                        {b.name}
                        <span className="ml-1 text-ink-faint">（{truncate(b.paperTitle, 12)}）</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 目标债务 */}
            <div className="mb-2" data-target-debt>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-meta font-medium text-ink-muted">目标债务</span>
                {/**
                 * ── 问题 1：不显示裸数字「0」──
                 *
                 * 旧界面这里永远渲染 `{pickedDebtList.length}` —— 没选时
                 * 显示一个孤零零的「0」，读起来像"目标是 0 条债务"，
                 * 而用户刚从债务视图点了「围绕它生成组合想法」跳过来，
                 * 看到 0 会直接怀疑"是不是没带过来"。
                 *
                 * 现在：有就显示条数，没有就明确写「未指定债务」。
                 */}
                <span className="text-micro text-ink-faint" data-selected-debts>
                  {pickedDebtList.length > 0 ? `${pickedDebtList.length} 条` : '未指定债务'}
                </span>
              </div>
              {pickedDebtList.length === 0 ? (
                <p className="text-micro text-ink-faint">
                  未指定债务 —— 系统会挑一条最相关的债务作为目标。建议至少选一条，组合才有明确方向。
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {pickedDebtList.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-start gap-1.5 text-micro text-ink"
                      data-target-debt-id={d.id}
                    >
                      <span className="mt-[1px] shrink-0 text-accent" aria-hidden>
                        ·
                      </span>
                      {/* 目标债务要能一眼看到全称 —— 它是本次生成的核心意图 */}
                      <span className="min-w-0 flex-1">{d.title}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 跨论文警告：选了才提示，且是"拦住"不是"事后报错" */}
            {crossPaperWarning && (
              <div
                className="rounded-block border px-3 py-2 text-micro leading-4"
                data-cross-paper-warning
                style={{ borderColor: '#f59e0b', background: '#fffbeb', color: '#92400e' }}
              >
                {crossPaperWarning}
              </div>
            )}

            {/*
              问题 4：生成门槛的提示。
              两种情况会走到这里：
                · 模块数不够（含"一个都没选"）→ data-generate-blocked
                · 模块数够了但都来自同一篇论文 → data-cross-paper-warning
              按钮可点时 gateHint 为 null，两条都不渲染。
            */}
            {gateHint && gateHintIsCrossPaper && (
              <div
                className="rounded-block border px-3 py-2 text-micro leading-4"
                data-cross-paper-warning
                style={{ borderColor: '#f59e0b', background: '#fffbeb', color: '#92400e' }}
              >
                {gateHint}
              </div>
            )}
            {gateHint && !gateHintIsCrossPaper && pickedModuleCount > 0 && (
              <div
                className="rounded-block border px-3 py-2 text-micro leading-4"
                data-generate-blocked
                style={{ borderColor: '#f59e0b', background: '#fffbeb', color: '#92400e' }}
              >
                {gateHint}
              </div>
            )}
          </div>

          {/* 生成按钮 */}
          <div className="shrink-0 border-t border-line px-4 py-3">
            <button
              type="button"
              data-generate-combo
              data-generating={pending ? '1' : '0'}
              disabled={!canGenerate}
              onClick={() =>
                onGenerate({
                  // Array.from 而非 [...set]：工程的 target 低于 es2015，
                  // 展开 Set 需要 downlevelIteration，用 Array.from 更稳。
                  blockIds: Array.from(pickedBlocks),
                  debtIds: Array.from(pickedDebts),
                })
              }
              className={`w-full rounded-block px-3 py-2 text-body font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50${
                pending ? ' ma-pulse' : ''
              }`}
              style={{ background: canGenerate ? '#2563eb' : '#e5e7eb', color: canGenerate ? '#ffffff' : '#9ca3af' }}
            >
              {pending ? '正在生成…' : '生成组合'}
            </button>
            <p className="mt-2 text-micro text-ink-faint">
              {pickedModuleCount < MIN_MODULES
                ? `已选 ${pickedModuleCount} 个模块 —— 至少需要 ${MIN_MODULES} 个才能生成组合。`
                : `按你的选择生成：${pickedModuleCount} 个模块 × ${pickedDebts.size || '自动'} 条债务。`}
            </p>
          </div>
        </div>

        {/* ── 下半：手动输入想法对话框（P13 问题 1）──
            原「本次生成产出」概览区**改为**用户输入对话框：表单成为这块
            的主角，产出概览压缩为表单下方的一行小结（三态钩子
            data-idea-empty / data-idea-count 原样保留 —— verify-local 的
            计数断言不破；data-goto-crashtest 按钮 P16 问题二已删）。 */}
        <CustomIdeaDock
          ideaCount={data.ideas.length}
          hasRun={hasRun}
          papers={grouped.map((g) => ({ id: g.paperId, title: g.paperTitle }))}
          onAddCustomBlock={onAddCustomBlock}
          pending={pending}
        />
      </section>
    </div>
  )
}

/**
 * 手动输入想法对话框（P13 问题 1）。
 *
 * ── 这块原来是什么，为什么改 ──
 *
 * P11 需求 B 时这里是「本次生成产出」概览：数字 + 引导 + 去击穿测试
 * 入口（想法列表已搬到击穿测试视图）。P12 在它顶部塞了一个自定义
 * 想法表单。P13 把语义反过来：**对话框是主角**，用户在第三列下方
 * 直接写下自己的想法；生成产出概览降为附属的一行小结。
 *
 * 为什么概览不能删干净：三态判定（never-run / ran-empty / 有结果）
 * 和计数钩子是冷启动/生成链路的验收锚点（verify-local 依赖
 * data-idea-empty / data-idea-count），保留它们 = 回归不破。
 *
 * ⚠️ 这里仍然**没有 `data-idea-card`** —— 想法卡片依旧只在击穿测试视图。
 */
/**
 * ── P18 问题 2：手动添加模块表单 ──
 *
 * 原「手动输入想法」（直接写一条 CandidateIdea）改为「手动添加模块」：
 * 用户补充的是一个**方法模块**，提交后落库为 MethodBlock 并自动加入
 * 「已选模块」列表 —— 点「生成组合」时它与其他已选模块一起生成想法。
 *
 * 三个字段：
 *   模块名称（必填，6–300 字符）  —— 钩子沿用 data-custom-idea-title
 *   模块描述（可选，≤3000 字符） —— 钩子沿用 data-custom-idea-desc
 *   所属论文（可选下拉）          —— 新钩子 data-custom-idea-paper
 *
 * ⚠️ 钩子名沿用旧名（-title/-desc/-submit/-hint）而不是改名为 -name：
 * 多个验收脚本（verify-p12/p13/p14/p2/local）用旧钩子定位这三个控件，
 * 改名会把无关断言全部打破；语义变化（想法→模块）由脚本各自更新断言。
 */
function CustomBlockForm({
  pending,
  papers,
  onAdd,
}: {
  pending: boolean
  papers: Array<{ id: string; title: string }>
  onAdd: (name: string, description: string, paperId: string | null) => void
}) {
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [paperId, setPaperId] = useState('')

  const t = title.trim()
  const d = desc.trim()
  const tooShort = t.length > 0 && t.length < 6
  const tooLong = t.length > 300 || d.length > 3000
  const canSubmit = !pending && !tooShort && !tooLong && t.length >= 6

  const hint = tooShort
    ? `名称至少 6 个字符（当前 ${t.length}）`
    : title.length > 300
      ? '名称超过 300 字符上限'
      : d.length > 3000
        ? '描述超过 3000 字符上限'
        : ''

  function submit() {
    if (!canSubmit) return
    onAdd(t, d, paperId || null)
    setTitle('')
    setDesc('')
  }

  return (
    <div
      data-custom-idea-form
      className="rounded-block border border-line px-3 py-2"
    >
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-micro font-medium text-ink">手动添加模块</span>
        <span className="text-[10px] text-ink-faint">
          加入已选列表，与其他模块一起生成想法
        </span>
      </div>
      <input
        data-custom-idea-title
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
        disabled={pending}
        maxLength={320}
        placeholder="模块名称（必填，6–300 字符）"
        className="w-full rounded-md border border-line px-2 py-1.5 text-meta text-ink placeholder:text-[#9ca3af] focus:border-accent focus:outline-none disabled:opacity-60"
      />
      <textarea
        data-custom-idea-desc
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        disabled={pending}
        rows={2}
        maxLength={3200}
        placeholder="模块描述（可选，≤3000 字符）"
        className="mt-1.5 w-full resize-none rounded-md border border-line px-2 py-1.5 text-meta leading-4 text-ink placeholder:text-[#9ca3af] focus:border-accent focus:outline-none disabled:opacity-60"
      />
      {papers.length > 0 && (
        <select
          data-custom-idea-paper
          value={paperId}
          onChange={(e) => setPaperId(e.target.value)}
          disabled={pending}
          title="模块挂靠的论文（决定它在跨论文判定中算哪一篇）"
          /* P19 细节 4：select 的提示项同样加深（#9ca3af = ink-faint 的实色，
             比浏览器默认的浅灰可读性高一档）。 */
          style={{ color: paperId ? undefined : '#9ca3af' }}
          className="mt-1.5 w-full rounded-md border border-line bg-white px-2 py-1.5 text-meta focus:border-accent focus:outline-none disabled:opacity-60"
        >
          <option value="">所属论文（可选）—— 不指定则挂第一篇</option>
          {papers.map((p) => (
            <option key={p.id} value={p.id}>
              {truncate(p.title, 40)}
            </option>
          ))}
        </select>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          data-custom-idea-submit
          data-disabled={canSubmit ? '0' : '1'}
          disabled={!canSubmit}
          onClick={submit}
          title={canSubmit ? '加入已选模块列表' : '先填写模块名称（≥6 字符）'}
          className="rounded-md px-2.5 py-1 text-[11px] font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-45"
          style={{ background: canSubmit ? '#2563eb' : '#cbd5e1' }}
        >
          {pending ? '正在添加…' : '加入已选模块'}
        </button>
        {hint && (
          <span data-custom-idea-hint className="text-[10px] text-[#b45309]">
            {hint}
          </span>
        )}
      </div>
    </div>
  )
}

function CustomIdeaDock({
  ideaCount,
  hasRun,
  papers,
  onAddCustomBlock,
  pending,
}: {
  ideaCount: number
  hasRun: boolean
  papers: Array<{ id: string; title: string }>
  onAddCustomBlock: (name: string, description: string, paperId: string | null) => void
  pending: boolean
}) {
  const text =
    ideaCount > 0
      ? `已生成 ${ideaCount} 个想法，可在击穿测试视图中查看。`
      : hasRun
        ? '已运行生成，但没有产生候选方案。建议检查模块选择或调整债务。'
        : '还没有生成过组合。可以先在左边选素材点「生成组合」，也可以在上方手动添加一个模块。'

  return (
    <div
      className="flex min-h-0 flex-[1] flex-col border-t border-line"
    >
      <Header
        title="手动添加模块"
        hint="自己补充的模块会加入「已选模块」，点「生成组合」时与其他已选模块一起生成想法。"
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {/* 表单主体（P18 问题 2：想法表单 → 模块表单） */}
        <CustomBlockForm pending={pending} papers={papers} onAdd={onAddCustomBlock} />
        {/*
         * ── 附属概览行（原「本次生成产出」概览压缩而来）──
         * key={ideaCount}：计数变化（新一轮生成）→ 块 remount →
         * 有结果时播 ma-gen-flash（绿色短闪，"新结果到了"），
         * 无结果/未跑时只做普通淡入。动画只在状态变化时重播。
         *
         * 三态钩子（never-run / ran-empty / has-ideas）与
         * data-idea-count 原样保留 —— 它们是冷启动与生成链路的
         * 验收锚点（verify-local 依赖），改文案不删钩子。
         */}
        <p
          key={ideaCount}
          data-idea-empty={ideaCount > 0 ? 'has-ideas' : hasRun ? 'ran-empty' : 'never-run'}
          data-idea-count={ideaCount}
          data-gen-flash={ideaCount > 0 ? '1' : '0'}
          className={`mt-4 rounded-block border border-dashed px-3 py-2.5 text-micro leading-4 text-ink-faint ${
            ideaCount > 0 ? 'ma-gen-flash border-[#86efac]' : 'ma-fade-in border-line-strong'
          }`}
        >
          {text}
        </p>
      </div>
    </div>
  )
}

function Header({ title, hint }: { title: string; hint: string }) {
  // P15 需求四"减空隙"：pt-4 pb-3 → pt-3 pb-2（三栏标题行整体收敛 ~8px）
  return (
    <div className="shrink-0 px-4 pb-2 pt-3">
      <h2 className="text-meta font-medium text-ink">{title}</h2>
      <p className="mt-1 text-micro leading-4 text-ink-faint">{hint}</p>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <p className="mb-3 rounded-block border border-dashed border-line-strong px-3 py-3 text-micro leading-4 text-ink-faint">
      {text}
    </p>
  )
}

function truncate(t: string, n: number): string {
  return t.length > n ? `${t.slice(0, n)}…` : t
}
