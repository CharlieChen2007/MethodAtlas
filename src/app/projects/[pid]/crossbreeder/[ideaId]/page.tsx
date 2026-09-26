import { labRedirect } from '@/lib/lab/redirects'

/**
 * 单个组合想法详情 → 单页画布的「组合想法视图」。
 *
 * 点击某张想法卡片即可在底部面板看到同样的详情，所以这里不需要
 * 在 URL 里携带 ideaId —— 那会给新页面引入"选中态进 URL"的复杂度，
 * 而选中态本来就是临时聚焦，不该被分享。
 */
export default function CrossbreederIdeaRedirect({
  params,
}: {
  params: { pid: string; ideaId: string }
}) {
  labRedirect(params.pid, { view: 'idea' })
}
