import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { EmptyState } from '@/components/EmptyState'

/**
 * 根路由 —— 系统的「落点」。
 *
 * ── 为什么改这里 ──
 * 之前这里是 `redirect('/projects')`，一个三行的静态页。
 *
 * 在生产模式（`next start`）下它出问题了：根路径 `/` 返回
 * **"404 This page could not be found"** —— 而 build 输出里 `/` 明明白白
 * 列着、dev 模式也一切正常。这类"路由存在却说找不到"的报错最耗时，
 * 因为每一条线索都指向"页面不见了"，而页面一直都在。
 *
 * 根因是「静态预渲染页里的 redirect」在生产模式下有边界情况，
 * 与其去赌 Next 的内部行为，不如**不再依赖它**：
 * 把根路径做成一个真正的动态落点页。顺带把 U1 一起做了。
 *
 * ── 现在的行为 ──
 *   · 已有项目 → 直接进最近动过的那个项目的画布（一键直达）
 *   · 没有项目 → 渲染引导页，说清四步流程 + 给一个明确入口
 *
 * `force-dynamic` 是必须的：要查库，不能构建期定死。
 */

export const dynamic = 'force-dynamic'

export default async function Home() {
  // 优先按 updatedAt：用户更可能想回到「上次动过」的项目，
  // 而不一定是「最后创建」的。createdAt 作为并列时的兜底。
  const latest = await prisma.project.findFirst({
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  })

  // redirect 在 Server Component 里会抛 NEXT_REDIRECT 由框架接管，
  // 所以必须放在 return 之前、且不能包在 try/catch 里。
  if (latest) {
    redirect(`/projects/${latest.id}/lab`)
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <div className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">MethodAtlas</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          把论文里的方法拆成结构，看清技术现状，找出收录文献中反复出现却未见解决的空白，
          <br className="hidden sm:block" />
          再帮你把「下一个值得做的方向」验证一遍。
        </p>
      </div>

      <ol className="mb-10 space-y-4">
        {(
          [
            ['建一个项目', '一个项目对应一个研究方向。'],
            ['上传论文', '系统解析全文，抽取方法模块与支撑证据。'],
            ['看画布', '方法结构、相互继承关系、悬而未决的问题，一张图看完。'],
            ['提想法并击穿它', '系统会替你找反例，扛不住的直接淘汰。'],
          ] as const
        ).map(([title, desc], i) => (
          <li key={title} className="flex gap-4">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-300 text-xs font-medium text-slate-500">
              {i + 1}
            </span>
            <div>
              <div className="text-sm font-medium text-slate-900">{title}</div>
              <div className="mt-0.5 text-sm text-slate-500">{desc}</div>
            </div>
          </li>
        ))}
      </ol>

      <EmptyState
        title="还没有项目"
        hint="点下面的按钮进入项目页，用页面上的表单创建第一个项目。建完之后再打开根地址，就会直接进到工作台。"
        action={
          <a
            href="/projects"
            className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            开始 · 创建第一个项目
          </a>
        }
      />
    </div>
  )
}
