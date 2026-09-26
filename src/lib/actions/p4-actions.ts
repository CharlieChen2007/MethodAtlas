'use server'

import { revalidatePath } from 'next/cache'
import { extractResearchDebt } from '@/lib/research-debt'
import { crossbreed } from '@/lib/crossbreeder'
import { runCrashTest } from '@/lib/crash-test'
import { EvidencePolicyError, guardEvidenceWrite } from '@/lib/evidence'
import { LLMError, callLLM, type LLMMessage } from '@/lib/llm'
import { EvidenceStatus, parseJsonArray } from '@/lib/enums'
import { prisma } from '@/lib/prisma'

export interface ActionResult {
  ok: boolean
  message: string
  detail?: string
}

function toActionError(err: unknown, fallback: string): ActionResult {
  if (err instanceof EvidencePolicyError) {
    return { ok: false, message: '证据校验未通过，已拒绝写入', detail: err.message }
  }
  if (err instanceof LLMError) {
    return { ok: false, message: `模型调用失败（${err.kind}）`, detail: err.message }
  }
  return { ok: false, message: fallback, detail: (err as Error).message }
}

// ===================== Evidence 统一写入体检 =====================
//
// 各 Service 在生成阶段已经做过自己的证据筛选，这里只做「落库后复查」：
// 把刚刚写入的记录读回来，确认没有对象带着 INSUFFICIENT 状态落库。
//
// 为什么是复查而不是「写入前拦住」：Service 是在事务里边生成证据边写入的，
// 写之前拿不到最终状态。复查同样能起到兜底作用 —— 一旦有异常状态落库，
// 会立刻被拦下并报错，而不是静默地留在库里。

/** 债务及其 sources / attempts 的状态体检 */
async function guardDebtWrites(projectId: string): Promise<void> {
  const debts = await prisma.researchDebt.findMany({
    where: { projectId },
    select: {
      title: true,
      evidenceStatus: true,
      sources: { select: { evidenceStatus: true } },
      attempts: { select: { evidenceStatus: true } },
    },
  })

  const writes: Array<{ label: string; evidenceStatus: string }> = []
  for (const d of debts) {
    writes.push({ label: `研究债务「${d.title}」`, evidenceStatus: d.evidenceStatus })
    for (const s of d.sources) {
      writes.push({
        label: `研究债务「${d.title}」的来源描述`,
        evidenceStatus: s.evidenceStatus,
      })
    }
    for (const a of d.attempts) {
      writes.push({
        label: `研究债务「${d.title}」的尝试记录`,
        evidenceStatus: a.evidenceStatus,
      })
    }
  }

  guardEvidenceWrite(writes)
}

/** 候选方案的状态体检 */
async function guardIdeaWrites(projectId: string): Promise<void> {
  const ideas = await prisma.candidateIdea.findMany({
    where: { projectId },
    select: { title: true, evidenceStatus: true },
  })

  guardEvidenceWrite(
    ideas.map((i) => ({
      label: `候选方案「${i.title}」`,
      evidenceStatus: i.evidenceStatus,
    }))
  )
}

/** 识别跨论文研究债务 */
export async function debtAction(projectId: string): Promise<ActionResult> {
  try {
    const res = await extractResearchDebt(projectId)
    await guardDebtWrites(projectId)

    revalidatePath(`/projects/${projectId}/research-debt`)
    revalidatePath(`/projects/${projectId}/crossbreeder`)

    const parts = [
      `从 ${res.paperCount} 篇论文中聚合出 ${res.debtCount} 条研究债务`,
      `其中 ${res.crossPaperCount} 条被多篇论文共同提及`,
    ]
    if (res.skipped > 0) parts.push(`跳过 ${res.skipped} 条证据不足的候选`)

    return {
      ok: true,
      message: parts.join('，'),
      detail:
        res.debtCount === 0
          ? '未发现被多篇论文共同提及的问题。单篇论文的局限只是它自己的缺点，不构成领域债务 —— 这是一个有效结论，不是失败。'
          : res.notes.join('；') || undefined,
    }
  } catch (err) {
    return toActionError(err, '研究债务识别失败')
  }
}

/** 生成候选方案（跨论文方法组合） */
export async function crossbreedAction(
  projectId: string,
  selection?: {
    /** 问题 4：用户在三栏工作台里挑的具体 Block（空/未传 = 全池） */
    blockIds?: string[]
    /** 问题 4：用户指定的目标债务（空/未传 = 全池） */
    debtIds?: string[]
  }
): Promise<ActionResult> {
  try {
    const res = await crossbreed(projectId, {
      blockIds: selection?.blockIds,
      debtIds: selection?.debtIds,
    })
    await guardIdeaWrites(projectId)

    revalidatePath(`/projects/${projectId}/crossbreeder`)
    revalidatePath(`/projects/${projectId}/research-debt`)

    const s = res.skipped
    const blocked = s.singlePaper + s.noDebt + s.noEvidence + s.noBlocks + s.invalid

    /**
     * 选了多少素材要说出来 —— 用户主导模式下，他要能确认
     * "我挑的 3 个 Block / 1 条债务确实被用上了"，而不是系统偷偷用了全池。
     */
    const scope =
      selection?.blockIds?.length || selection?.debtIds?.length
        ? `（按你的选择：${selection?.blockIds?.length ?? 0} 个模块 × ${
            selection?.debtIds?.length ?? 0
          } 条债务）`
        : ''

    const blockedPart = blocked > 0 ? `，另有 ${blocked} 个候选未通过关卡被拦下` : ''
    const dupPart = res.duplicates > 0 ? `，跳过 ${res.duplicates} 个重复标题` : ''

    return {
      ok: true,
      /**
       * ── P11 问题 3：累积语义 ──
       * 新想法追加进列表而非替换旧想法，消息要明确说出
       * 「已加入列表」与「当前共 N 个」，让用户看到累积结果。
       */
      message:
        res.created > 0
          ? `生成 ${res.created} 个新候选方案，已加入想法列表（当前共 ${res.totalIdeas} 个）${scope}${blockedPart}${dupPart}`
          : `本次未产出新候选（当前仍保留 ${res.totalIdeas} 个想法）${scope}${blockedPart}${dupPart}`,
      detail:
        res.created === 0
          ? '没有找到值得组合的跨论文配对。0 个候选是可接受的答案 —— 编造看起来漂亮的空话才是失败。'
          : res.notes.join('；') || undefined,
    }
  } catch (err) {
    return toActionError(err, '候选方案生成失败')
  }
}

/** 对候选方案执行撞车测试 */
export async function crashTestAction(ideaId: string): Promise<ActionResult> {
  try {
    // 注意：这里刻意不做 guardEvidenceWrite 体检。
    // CrashTest 的 INSUFFICIENT 是合法终态（「没查到证据，所以不下结论」），
    // 不是流程缺陷。详见 src/lib/evidence.ts 的模块注释。
    const res = await runCrashTest(ideaId)

    revalidatePath(`/projects/${res.projectId}/crossbreeder`)
    revalidatePath(`/projects/${res.projectId}/crossbreeder/${ideaId}`)

    const verdictText: Record<string, string> = {
      PROMISING: '有前景',
      RISKY: '有风险',
      LIKELY_EXISTS: '很可能已被做过',
      INFEASIBLE: '不可行',
      INSUFFICIENT_EVIDENCE: '证据不足',
    }
    const v = verdictText[res.overallVerdict] ?? res.overallVerdict

    return {
      ok: true,
      message: `撞车测试完成，判定：${v}`,
      detail:
        res.fatalFlaws.length > 0
          ? `致命弱点：${res.fatalFlaws.join('；')}`
          : res.rejected
            ? '该方案已被否定。'
            : undefined,
    }
  } catch (err) {
    return toActionError(err, '撞车测试失败')
  }
}

/** 删除一个候选方案 */
export async function deleteIdeaAction(ideaId: string): Promise<ActionResult> {
  try {
    const idea = await prisma.candidateIdea.findUnique({
      where: { id: ideaId },
      select: { projectId: true },
    })
    if (!idea) return { ok: false, message: '候选方案不存在' }

    await prisma.candidateIdea.delete({ where: { id: ideaId } })
    revalidatePath(`/projects/${idea.projectId}/crossbreeder`)
    return { ok: true, message: '已删除该候选方案' }
  } catch (err) {
    return toActionError(err, '删除失败')
  }
}

/** 人工采纳 / 否决一个候选方案（人工判断高于模型判定） */
export async function reviewIdeaAction(
  ideaId: string,
  decision: 'accept' | 'reject'
): Promise<ActionResult> {
  try {
    const idea = await prisma.candidateIdea.findUnique({
      where: { id: ideaId },
      select: { projectId: true },
    })
    if (!idea) return { ok: false, message: '候选方案不存在' }

    if (decision === 'reject') {
      // 否决等价于删除：不保留被判定为无价值的候选，避免污染列表
      await prisma.candidateIdea.delete({ where: { id: ideaId } })
      revalidatePath(`/projects/${idea.projectId}/crossbreeder`)
      return { ok: true, message: '已否决并移除该候选方案' }
    }

    // 采纳：把证据强度提到 CONFIRMED，表示"人已看过并认可"
    await prisma.candidateIdea.update({
      where: { id: ideaId },
      data: { evidenceStatus: EvidenceStatus.CONFIRMED },
    })
    revalidatePath(`/projects/${idea.projectId}/crossbreeder`)
    revalidatePath(`/projects/${idea.projectId}/crossbreeder/${ideaId}`)
    return { ok: true, message: '已采纳该候选方案（人工确认）' }
  } catch (err) {
    return toActionError(err, '操作失败')
  }
}

// ===================== 一键重置（需求 A） =====================
//
// 只清「用户动作」产生的运行数据，基础数据一律保留：
//   清除：CrashTest / CandidateIdeaDebt / CandidateIdea / Surgery（SurgeryLog 级联）
//   保留：Project / Paper / EvidenceRef / MethodDNA / MethodBlock /
//         Relation / ResearchDebt / DebtSource / Attempt
//
// 删除顺序沿用 scripts/reset-user-data.mjs 的纪律：先关联表、再主表，
// 避免中途出现悬挂外键。
//
// ⚠️ Surgery 没有 projectId（schema.prisma:152-173），必须走关联路径
//    method → paper → projectId，与 src/app/projects/[pid]/lab/page.tsx:60-64
//    的查询口径保持一致。

/** 一键重置：清空运行数据（想法 / 击穿结果 / 手术），保留论文与结构基础数据。 */
export async function resetUserDataAction(projectId: string): Promise<ActionResult> {
  try {
    const [ideas, surgeries] = await Promise.all([
      prisma.candidateIdea.count({ where: { projectId } }),
      prisma.surgery.count({ where: { method: { paper: { projectId } } } }),
    ])

    await prisma.crashTest.deleteMany({ where: { idea: { projectId } } })
    await prisma.candidateIdeaDebt.deleteMany({ where: { idea: { projectId } } })
    await prisma.candidateIdea.deleteMany({ where: { projectId } })
    await prisma.surgery.deleteMany({ where: { method: { paper: { projectId } } } })

    revalidatePath(`/projects/${projectId}/lab`)
    // 旧路由是 lab 的薄跳转，一并失效，避免回退到缓存页面
    revalidatePath(`/projects/${projectId}/crossbreeder`)
    revalidatePath(`/projects/${projectId}/evolution/graph`)
    revalidatePath(`/projects/${projectId}/research-debt`)

    const cleared = ideas + surgeries
    return {
      ok: true,
      message: cleared > 0 ? `已清空运行数据（${ideas} 个想法、${surgeries} 次手术）` : '已经是初始状态，没有需要清空的运行数据',
      detail: '论文、方法结构、演化关系与债务库均已保留',
    }
  } catch (err) {
    return toActionError(err, '重置失败')
  }
}

// ===================== P12 问题 2：用户自定义想法 =====================
//
// 与 crossbreedAction 生成的想法**同库同表同语义**（CandidateIdea），
// 区别只在来源：生成的带 fromBlockIds/evidence，自定义的两者皆空 ——
// 击穿测试、重置、删除对两者一视同仁。
//
// 证据强度给 UNCERTAIN（不是 CONFIRMED）：用户输入没有经过任何证据核对，
// 也不允许 INSUFFICIENT（会被 guardEvidenceWrite 拦下，R3 规则）。
// UNCERTAIN 的语义恰好是「未经核对」—— 手动输入就是这种状态。

/** P12：手动添加一条自定义想法（与生成想法同等对待） */
export async function createCustomIdeaAction(
  projectId: string,
  rawTitle: string,
  rawDescription = ''
): Promise<ActionResult> {
  try {
    // ---- 基础校验（与前端同步，服务端是权威）----
    const title = (rawTitle ?? '').trim()
    const description = (rawDescription ?? '').trim()
    if (title.length < 6) {
      return { ok: false, message: '想法标题至少 6 个字符（过短无法区分）' }
    }
    if (title.length > 300) {
      return { ok: false, message: '想法标题过长（上限 300 字符）' }
    }
    if (description.length > 3000) {
      return { ok: false, message: '想法描述过长（上限 3000 字符）' }
    }

    // ---- 标题去重：与 crossbreeder 同一套规范化规则 ----
    // 用户手动输入最容易发生的失误就是"连点两次提交"——去重直接挡掉。
    const norm = title.replace(/\s+/g, '').toLowerCase()
    const all = await prisma.candidateIdea.findMany({
      where: { projectId },
      select: { title: true },
    })
    if (all.some((t) => t.title.replace(/\s+/g, '').toLowerCase() === norm)) {
      return { ok: false, message: '已存在同名想法，未重复添加（想法列表全部保留）' }
    }

    await prisma.candidateIdea.create({
      data: {
        projectId,
        title,
        description,
        fromBlockIds: '[]',
        evidenceIds: '[]',
        evidenceStatus: EvidenceStatus.UNCERTAIN,
      },
    })

    revalidatePath(`/projects/${projectId}/lab`)
    revalidatePath(`/projects/${projectId}/crossbreeder`)

    const total = await prisma.candidateIdea.count({ where: { projectId } })
    return {
      ok: true,
      message: `自定义想法已加入列表（当前共 ${total} 个）`,
      detail: '它和生成的想法待遇相同：可选中、可运行击穿测试、可删除。',
    }
  } catch (err) {
    return toActionError(err, '添加自定义想法失败')
  }
}

// ===================== P18 问题 2：手动添加模块 =====================
//
// 原「手动输入想法」改为「手动添加模块」：用户补充的不再是一条成品
// CandidateIdea，而是一个**方法模块**（MethodBlock），加入已选列表后
// 与其他已选模块一起参与「生成组合」。
//
// 为什么落库为真实 MethodBlock 而不是前端内存：
//   · crossbreed 的素材池是 `prisma.methodBlock.findMany`（DB 查询），
//     前端临时 id 到了服务端找不到行，生成链路直接断；
//   · 落库后模块天然出现在中列论文分组里（views 把 blocks 挂在 paper
//     下），刷新/分享链接/重开标签页都不丢；
//   · 证据语义清晰：手动输入没有任何证据核对，evidenceIds 留空、
//     状态 UNCERTAIN —— crossbreed 对无证据模块本来就有兼容分支
//     （prompt 里只是少一段「原文片段」），不会卡关卡。
//
// 归属：MethodBlock 必须挂在一个 MethodDNA 下（schema 硬约束）。
// 用户可选「所属论文」（可选）：选了挂那篇；没选挂项目内第一篇
// 有方法 DNA 的论文（工作台的生成门槛本来就有「跨论文」约束，
// 单论文项目本来就生成不了，这里不额外造约束）。

/** P18 问题 2：手动添加一个方法模块（加入已选列表，参与生成组合） */
export async function createCustomBlockAction(
  projectId: string,
  rawName: string,
  rawDescription = '',
  paperId: string | null = null
): Promise<ActionResult & { blockId?: string }> {
  try {
    // ---- 基础校验（与前端表单同步，服务端是权威）----
    const name = (rawName ?? '').trim()
    const description = (rawDescription ?? '').trim()
    if (name.length < 6) {
      return { ok: false, message: '模块名称至少 6 个字符（过短无法区分）' }
    }
    if (name.length > 300) {
      return { ok: false, message: '模块名称过长（上限 300 字符）' }
    }
    if (description.length > 3000) {
      return { ok: false, message: '模块描述过长（上限 3000 字符）' }
    }

    // ---- 解析归属的 MethodDNA ----
    let methodId: string | null = null
    if (paperId) {
      const paper = await prisma.paper.findFirst({
        where: { id: paperId, projectId },
        select: { methodDNA: { select: { id: true } } },
      })
      if (!paper) {
        return { ok: false, message: '所属论文不存在（可能已被删除）' }
      }
      if (!paper.methodDNA) {
        return {
          ok: false,
          message: '这篇论文还没有方法 DNA，模块必须挂在方法结构下',
          detail: '请选择一篇已运行过方法抽取的论文，或不指定（自动挂到第一篇）。',
        }
      }
      methodId = paper.methodDNA.id
    } else {
      // 不指定 → 第一篇有方法 DNA 的论文
      const first = await prisma.methodDNA.findFirst({
        where: { paper: { projectId } },
        orderBy: { id: 'asc' },
        select: { id: true },
      })
      if (!first) {
        return {
          ok: false,
          message: '项目里还没有任何方法 DNA',
          detail: '手动模块必须挂在论文的方法结构下；请先上传论文并运行方法抽取。',
        }
      }
      methodId = first.id
    }

    const block = await prisma.methodBlock.create({
      data: {
        methodId,
        name,
        description,
        type: 'OTHER',
        role: '手动添加',
        stage: 'CORE_METHOD',
        evidenceIds: '[]',
        evidenceStatus: EvidenceStatus.UNCERTAIN,
      },
    })

    revalidatePath(`/projects/${projectId}/lab`)
    revalidatePath(`/projects/${projectId}/crossbreeder`)

    return {
      ok: true,
      message: `模块「${name}」已加入已选列表`,
      detail: '点「生成组合」时它会与其他已选模块一起生成想法。',
      blockId: block.id,
    }
  } catch (err) {
    return toActionError(err, '添加模块失败')
  }
}

// ===================== P12 问题 3：击穿测试 AI 对话 =====================
//
// 就"当前选中想法"与 AI 多轮讨论。上下文由服务端从库里组装
// （想法 + 目标债务 + 来源方法 + CrashTest 结果），前端只传
// 会话历史与用户新消息 —— 上下文不可被前端伪造。
//
// LLM 调用沿用 callLLM（同一 provider/model/key，不新增配置）。
// 纯文本对话（非 jsonMode）：chat 的产出是建议而非结构化数据。

/** 一条会话消息（前端持有历史，服务端不存库） */
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** P12：就某个想法与 AI 对话（多轮，历史由前端带回） */
export async function crashChatAction(
  ideaId: string,
  history: ChatTurn[],
  userMessage: string
): Promise<ActionResult> {
  try {
    const msg = (userMessage ?? '').trim()
    if (!msg) return { ok: false, message: '消息为空' }
    if (msg.length > 2000) return { ok: false, message: '消息过长（上限 2000 字符）' }
    if (history.length > 40) {
      return { ok: false, message: '会话历史过长，请开启新话题（刷新页面）' }
    }

    // ---- 组装上下文（服务端权威，前端传不进假数据）----
    const idea = await prisma.candidateIdea.findUnique({
      where: { id: ideaId },
      include: {
        fromDebts: { include: { debt: { select: { title: true } } } },
        crashTest: true,
      },
    })
    if (!idea) return { ok: false, message: '想法不存在（可能已被删除）' }

    const blockIds = parseJsonArray<string>(idea.fromBlockIds)
    const blocks = blockIds.length
      ? await prisma.methodBlock.findMany({
          where: { id: { in: blockIds } },
          select: { name: true },
        })
      : []

    const debtLines = idea.fromDebts.map((d) => d.debt.title)
    const blockLines = blocks.map((b) => b.name)

    const verdictText: Record<string, string> = {
      PROMISING: '有前景',
      RISKY: '有风险',
      LIKELY_EXISTS: '很可能已被做过',
      INFEASIBLE: '不可行',
      INSUFFICIENT_EVIDENCE: '证据不足',
    }

    const crash = idea.crashTest
    const crashLines: string[] = []
    if (crash) {
      crashLines.push(
        `总体判定：${verdictText[crash.overallVerdict] ?? crash.overallVerdict}`
      )
      const checkPairs: Array<[string, string]> = [
        ['新颖性检查', crash.noveltyCheck],
        ['模块冲突检查', crash.blockConflictCheck],
        ['数据需求检查', crash.dataRequirement],
        ['算力需求检查', crash.computeRequirement],
      ]
      for (const [label, raw] of checkPairs) {
        const arr = parseJsonArray<{ finding?: string; level?: string }>(raw)
        const first = arr[0]
        if (first) {
          crashLines.push(`- ${label}：${first.level ?? '?'} —— ${first.finding ?? ''}`)
        }
      }
      if (crash.experimentalDesign?.trim()) {
        crashLines.push(`- 实验设计已生成（摘要：${crash.experimentalDesign.slice(0, 200)}…）`)
      }
      try {
        const f = JSON.parse(crash.findings || '{}') as {
          fatalFlaws?: string[]
          conditionsToProceed?: string[]
        }
        if (f.fatalFlaws?.length) crashLines.push(`- 致命弱点：${f.fatalFlaws.join('；')}`)
        if (f.conditionsToProceed?.length)
          crashLines.push(`- 继续推进的条件：${f.conditionsToProceed.join('；')}`)
      } catch {
        /* findings 非法 JSON 时跳过补充信息 */
      }
    }

    const systemPrompt = [
      '你是方法学研究顾问，帮助研究者审视一个"组合想法"（候选研究方案）。',
      '回答必须基于下面给出的上下文；上下文里没有的信息要明说"不知道"，不要编造。',
      '回答用简体中文，简洁直接，一般不超过 300 字；用户追问再展开。',
      '',
      '── 想法 ──',
      `标题：${idea.title}`,
      `描述：${idea.description || '（无）'}`,
      '',
      '── 目标债务（这个想法想解决的问题）──',
      debtLines.length ? debtLines.map((t, i) => `${i + 1}. ${t}`).join('\n') : '（无，用户自定义想法未关联债务）',
      '',
      '── 来源方法（组合用到的模块）──',
      blockLines.length ? blockLines.map((n, i) => `${i + 1}. ${n}`).join('\n') : '（无，用户手动输入的想法）',
      '',
      '── 击穿测试结果 ──',
      crashLines.length ? crashLines.join('\n') : '（尚未运行击穿测试）',
    ].join('\n')

    // ---- 拼 messages：system + 历史 + 新消息 ----
    // 历史只接受 user/assistant 两种角色（system 由服务端独占）。
    const historyMsgs: LLMMessage[] = (history ?? [])
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
      .slice(-20) // 服务端再截一道，防止超长
      .map((t) => ({ role: t.role, content: t.content.slice(0, 2000) }))

    const res = await callLLM({
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMsgs,
        { role: 'user', content: msg },
      ],
      purpose: 'crash-chat',
      temperature: 0.4,
      maxTokens: 1200,
    })

    // mock 降级时 callLLM 返回的是 JSON 字符串（mockLLMResponse 的默认分支），
    // 对"对话"这个场景是明显的驴唇不对马嘴 —— 如实告知用户，不假装在讨论。
    if (res.provider === 'mock') {
      return {
        ok: false,
        message: '对话功能需要真实模型（当前为离线演示模式）',
        detail: '请在 .env 里配置 LLM_PROVIDER=openai-compatible 及相应 API Key 后重试。',
      }
    }

    const reply = res.text.trim()
    if (!reply) return { ok: false, message: '模型返回了空回复，请重试' }

    return { ok: true, message: reply, detail: undefined }
  } catch (err) {
    return toActionError(err, '对话失败')
  }
}
