import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { EvidenceDrawerProvider } from '@/components/EvidenceDrawer'
import { EmptyState } from '@/components/EmptyState'
import { PAGE_PATTERN_PROJECTS } from '@/lib/lab/palette'
import { createProject } from './actions'

export default async function ProjectsPage() {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { papers: true } },
    },
  })

  return (
    <EvidenceDrawerProvider>
      <div
        className="space-y-8"
        style={{
          // P15 需求六：项目列表页底纹（双层错位灰点，与其他界面互不相同）
          backgroundColor: PAGE_PATTERN_PROJECTS.bg,
          backgroundImage: PAGE_PATTERN_PROJECTS.image,
          backgroundSize: PAGE_PATTERN_PROJECTS.size,
        }}
      >
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          项目
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          每个项目对应一个研究方向。创建项目后上传论文，系统会解析论文并抽取方法结构。
        </p>
      </div>

      {/* 新建项目 */}
      <form
        action={createProject}
        className="block-card space-y-4 border-slate-200 bg-white p-5"
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-900">新建项目</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
          <input
            name="name"
            required
            placeholder="项目名称，如：RAG 方法梳理"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <input
            name="description"
            placeholder="项目描述（可选）"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <button
            type="submit"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
          >
            创建
          </button>
        </div>
      </form>

      {/* 项目列表 */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">
          全部项目（{projects.length}）
        </h2>

        {projects.length === 0 ? (
          <EmptyState
            title="还没有项目"
            hint="每个项目对应一个研究方向。先用上面的表单创建一个，然后上传论文。"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="block-card p-5"
              >
                <h3 className="font-medium text-slate-900">{project.name}</h3>
                {project.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-slate-500">
                    {project.description}
                  </p>
                )}
                <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
                  <span>{project._count.papers} 篇论文</span>
                  <span>
                    {project.createdAt.toLocaleDateString('zh-CN')}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
      </div>
    </EvidenceDrawerProvider>
  )
}
