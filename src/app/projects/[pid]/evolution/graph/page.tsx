import { labRedirect } from '@/lib/lab/redirects'

/** 方法演化图 → 单页画布的「方法演化视图」 */
export default function EvolutionGraphRedirect({
  params,
}: {
  params: { pid: string }
}) {
  labRedirect(params.pid, { view: 'evolution' })
}
