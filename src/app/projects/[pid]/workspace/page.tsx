import { labRedirect } from '@/lib/lab/redirects'

/**
 * Workspace → 单页画布（方法 DNA 视图）。
 *
 * Workspace 原先承担"项目总览 + 论文列表 + 四阶段入口"，这些能力已被
 * 单页画布的「方法 DNA 视图 + 右侧论文切换器」覆盖。
 */
export default function WorkspaceRedirect({ params }: { params: { pid: string } }) {
  labRedirect(params.pid, { view: 'dna' })
}
