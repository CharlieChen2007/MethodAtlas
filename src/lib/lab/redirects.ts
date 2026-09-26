/**
 * 旧路由 → 新单页画布 的跳转映射。
 *
 * P7 UI 重构把所有功能收进 `/projects/[pid]/lab` 一个页面，
 * 但旧链接（收藏夹、文档、别人发的链接）不能直接 404 —— 用户点进去
 * 应该看到"内容搬到了哪里"，而不是一片空白。
 *
 * 所以每个旧路由留一个极薄的 redirect 页面，把路径里的参数翻译成
 * `/lab?view=...&paper=...`。
 *
 * 这个文件是**唯一**的映射来源：路由页面只调用 `labRedirect()`，
 * 以后调整映射不用改 8 个文件。
 */

import { redirect } from 'next/navigation'
import type { ViewId } from '@/lib/lab/views'

export interface LabRedirectOptions {
  /** 目标视图 */
  view: ViewId
  /** 要聚焦的论文（DNA 视图用） */
  paperId?: string
  /**
   * 是否落地即进入「手术（剪刀）模式」（问题 2）。
   *
   * 旧的方法手术路由用它保住语义：用户点老链接是冲着"做手术"来的，
   * 重定向到 DNA 之后应该直接把剪刀拿出来，而不是让他自己再找一次。
   */
  surgery?: string
}

/**
 * 生成 /lab 的 URL 并 302 过去。
 *
 * 用 `redirect()` 而不是渲染一个"点击这里继续"的中转页：
 * 中转页会污染浏览器历史（用户按返回会回到中转页再被弹走，形成死循环），
 * 服务端 302 则让历史里只有最终地址。
 */
export function labRedirect(pid: string, opts: LabRedirectOptions): never {
  const sp = new URLSearchParams()
  sp.set('view', opts.view)
  if (opts.paperId) sp.set('paper', opts.paperId)
  if (opts.surgery) sp.set('surgery', opts.surgery)
  redirect(`/projects/${pid}/lab?${sp.toString()}`)
}
