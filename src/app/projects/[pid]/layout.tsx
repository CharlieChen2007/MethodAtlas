import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { EvidenceDrawerProvider } from '@/components/EvidenceDrawer'
import { ProjectMainShell } from '@/components/RouteShells'

/**
 * 项目壳层。
 *
 * P7 重构后本层只剩两件事：
 *   1. 校验项目存在（不存在直接 404，而不是让子页面各自处理）
 *   2. 提供证据抽屉 Context
 *
 * 原来的 `ProjectNav` 侧栏已删除 —— `[pid]` 下的所有子路由现在都 redirect
 * 到 `/lab`，而 `/lab` 自己是全屏单页（导航即右侧工具栏），不需要全局侧栏。
 * 保留 `ProjectMainShell` 是因为它负责"非 lab 路由"的常规容器样式，
 * 万一以后有新的非 lab 页面，不需要再改这里。
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: { pid: string }
}) {
  const project = await prisma.project.findUnique({
    where: { id: params.pid },
    select: { id: true, name: true },
  })

  if (!project) notFound()

  return (
    <EvidenceDrawerProvider>
      <ProjectMainShell>{children}</ProjectMainShell>
    </EvidenceDrawerProvider>
  )
}
