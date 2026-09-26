import { labRedirect } from '@/lib/lab/redirects'

/**
 * 方法 DNA 页 → 单页画布的「方法 DNA 视图」并聚焦该论文。
 */
export default function MethodDnaRedirect({
  params,
}: {
  params: { pid: string; paperId: string }
}) {
  labRedirect(params.pid, { view: 'dna', paperId: params.paperId })
}
