import { labRedirect } from '@/lib/lab/redirects'

/** 研究债务页 → 单页画布的「研究债务视图」 */
export default function ResearchDebtRedirect({
  params,
}: {
  params: { pid: string }
}) {
  labRedirect(params.pid, { view: 'debt' })
}
