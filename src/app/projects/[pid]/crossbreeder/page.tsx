import { labRedirect } from '@/lib/lab/redirects'

/** 组合想法页 → 单页画布的「组合想法视图」 */
export default function CrossbreederRedirect({
  params,
}: {
  params: { pid: string }
}) {
  labRedirect(params.pid, { view: 'idea' })
}
