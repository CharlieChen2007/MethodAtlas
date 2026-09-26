import { NextResponse } from 'next/server'

import { prisma } from '@/lib/prisma'
import { extractMethodDNA } from '@/lib/method-dna'
import { runSurgery } from '@/lib/method-surgery'
import { extractEvolution } from '@/lib/method-evolution'
import { extractResearchDebt } from '@/lib/research-debt'
import { crossbreed } from '@/lib/crossbreeder'
import { runCrashTest } from '@/lib/crash-test'
import { SurgeryAction } from '@/lib/enums'

/**
 * 流水线驱动接口 —— 供 scripts/seed-demo.mjs 一次性跑完全链路。
 *
 * 为什么需要它：
 *   各阶段能力原本只能在浏览器里一个个点。要在命令行灌演示数据，
 *   要么让脚本 import TS 服务层（Node 做不到），要么让脚本自己写数据库
 *   （那就等于绕过流水线伪造数据，seed 成功也就失去了意义）。
 *   这里开一个受控入口，让脚本调到**与 UI 完全相同的服务函数**，
 *   于是「seed 跑通」就等价于「流水线真的可用」。
 *
 * 安全边界（重要）：
 *   本接口用来灌演示数据，**默认关闭**，必须显式设置
 *   `ENABLE_PIPELINE_API=1` 才可用。
 *
 *   为什么不用 NODE_ENV 判断：`next start` 会把 NODE_ENV 设成 production，
 *   而演示数据恰恰常常是在 `next start` 起来的服务上灌的 ——
 *   用 NODE_ENV 卡会把正当用法一起挡掉。
 *   改成一个显式的、默认关闭的开关：想用的人明确打开，
 *   真实生产部署时不要设这个变量即可。
 */

export const dynamic = 'force-dynamic'

/** 流水线接口是否启用（默认关闭） */
function pipelineEnabled() {
  return process.env.ENABLE_PIPELINE_API === '1'
}

interface StepResult {
  step: string
  ok: boolean
  message: string
  detail?: string
}

function disabled() {
  return NextResponse.json(
    {
      ok: false,
      message:
        '流水线接口未启用。请设置环境变量 ENABLE_PIPELINE_API=1 后重启服务（仅用于灌演示数据，生产环境请勿开启）。',
    },
    { status: 403 }
  )
}

// ---------------- 单个阶段 ----------------

async function runStep(step: string, fn: () => Promise<string>): Promise<StepResult> {
  try {
    return { step, ok: true, message: await fn() }
  } catch (err) {
    return { step, ok: false, message: (err as Error).message }
  }
}

export async function POST(req: Request) {
  if (!pipelineEnabled()) return disabled()

  let body: { action?: string; projectId?: string; paperId?: string; surgeryBlockId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: '请求体不是合法 JSON' }, { status: 400 })
  }

  const { action, projectId, paperId } = body

  // 逐阶段执行：seed 脚本按顺序调用，任一步失败都能定位到具体环节
  switch (action) {
    case 'dna': {
      if (!paperId) {
        return NextResponse.json({ ok: false, message: '缺少 paperId' }, { status: 400 })
      }
      const r = await runStep('method-dna', async () => {
        const dna = await extractMethodDNA(paperId)
        return `抽取到 ${dna.blockCount} 个方法模块，${dna.evidenceCount} 条证据（${dna.evidenceStatus}）`
      })
      return NextResponse.json(r, { status: r.ok ? 200 : 500 })
    }

    case 'surgery': {
      // 拿该论文的第一个方法模块做一次「移除」手术，作为演示样本
      const dna = await prisma.methodDNA.findFirst({
        where: { paperId },
        include: { blocks: { orderBy: { id: 'asc' }, take: 1 } },
      })
      const block = dna?.blocks[0]
      if (!block) {
        return NextResponse.json(
          { ok: false, message: '该论文还没有方法模块，无法做手术' },
          { status: 400 }
        )
      }
      const r = await runStep('method-surgery', async () => {
        const res = await runSurgery({
          blockId: block.id,
          action: SurgeryAction.REMOVE,
          note: '演示数据：假设移除该模块，考察对整体方法的连带影响',
        })
        return `手术完成，${res.evidenceCount} 条证据`
      })
      return NextResponse.json(r, { status: r.ok ? 200 : 500 })
    }

    case 'evolution': {
      if (!projectId) {
        return NextResponse.json({ ok: false, message: '缺少 projectId' }, { status: 400 })
      }
      const r = await runStep('method-evolution', async () => {
        const res = await extractEvolution(projectId)
        return `建立 ${res.created} 条关系，${res.evidenceCount} 条证据（跳过 ${res.skipped}）`
      })
      return NextResponse.json(r, { status: r.ok ? 200 : 500 })
    }

    case 'debt': {
      if (!projectId) {
        return NextResponse.json({ ok: false, message: '缺少 projectId' }, { status: 400 })
      }
      const r = await runStep('research-debt', async () => {
        const res = await extractResearchDebt(projectId)
        return `从 ${res.paperCount} 篇论文聚合出 ${res.debtCount} 条债务（其中 ${res.crossPaperCount} 条跨论文）`
      })
      return NextResponse.json(r, { status: r.ok ? 200 : 500 })
    }

    case 'crossbreed': {
      if (!projectId) {
        return NextResponse.json({ ok: false, message: '缺少 projectId' }, { status: 400 })
      }
      const r = await runStep('crossbreeder', async () => {
        const res = await crossbreed(projectId, { maxIdeas: 3 })
        return `生成 ${res.created} 个候选方案（素材池 ${res.blockPoolSize} 模块 × ${res.debtPoolSize} 债务）`
      })
      return NextResponse.json(r, { status: r.ok ? 200 : 500 })
    }

    case 'crashtest': {
      if (!projectId) {
        return NextResponse.json({ ok: false, message: '缺少 projectId' }, { status: 400 })
      }
      // 对所有尚无撞车测试的候选方案逐个跑
      const ideas = await prisma.candidateIdea.findMany({
        where: { projectId, crashTest: null },
        select: { id: true, title: true },
      })
      if (ideas.length === 0) {
        return NextResponse.json({
          ok: true,
          step: 'crash-test',
          message: '没有待测试的候选方案（全部已测试）',
        })
      }

      const results: StepResult[] = []
      for (const idea of ideas) {
        results.push(
          await runStep(`crash-test:${idea.title.slice(0, 30)}`, async () => {
            const res = await runCrashTest(idea.id)
            return `判定 ${res.overallVerdict}（${res.evidenceCount} 条证据，致命问题 ${res.blockerCount} 个）`
          })
        )
      }
      const failed = results.filter((r) => !r.ok)
      return NextResponse.json(
        {
          ok: failed.length === 0,
          step: 'crash-test',
          message: `${results.length} 个方案已测试，${failed.length} 个失败`,
          detail: results.map((r) => `${r.ok ? '✓' : '✗'} ${r.step} — ${r.message}`).join('\n'),
        },
        { status: failed.length === 0 ? 200 : 500 }
      )
    }

    default:
      return NextResponse.json(
        { ok: false, message: `未知 action: ${action}` },
        { status: 400 }
      )
  }
}

/** 供 seed 脚本探测接口是否可用 */
export async function GET() {
  if (!pipelineEnabled()) return disabled()
  return NextResponse.json({
    ok: true,
    message: '流水线接口可用',
    actions: ['dna', 'surgery', 'evolution', 'debt', 'crossbreed', 'crashtest'],
  })
}
