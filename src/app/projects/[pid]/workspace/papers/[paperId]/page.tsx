import { labRedirect } from '@/lib/lab/redirects'

/**
 * 单篇论文详情 → 单页画布的「方法 DNA 视图」并聚焦该论文。
 *
 * 把 paperId 带过去，用户看到的仍是"这一篇"的方法结构，
 * 而不是被丢回第一篇文章。
 */
export default function PaperRedirect({
  params,
}: {
  params: { pid: string; paperId: string }
}) {
  labRedirect(params.pid, { view: 'dna', paperId: params.paperId })
}
