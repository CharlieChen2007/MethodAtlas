import { labRedirect } from '@/lib/lab/redirects'

/**
 * 项目首页 —— P7 起统一落到单页画布。
 *
 * 曾经的 Dashboard 只做了一次 `redirect(.../workspace)`，现在 workspace
 * 本身也已是 redirect，所以这里直接指向终点，少一跳。
 */
export default function ProjectDashboard({ params }: { params: { pid: string } }) {
  labRedirect(params.pid, { view: 'dna' })
}
