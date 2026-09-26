import { labRedirect } from '@/lib/lab/redirects'

/**
 * 方法手术旧路由 → 单页画布。
 *
 * ── 问题 2 之后的行为变化 ──
 * 手术不再是独立视图（改成画布右上角的剪刀模式），所以这里重定向到
 * 「方法 DNA」——那正是用户该落地的位置：结构图 + 右上角剪刀。
 * 顺带在 URL 上带 `?surgery=1`，由 LabShell 解析后**自动进入剪刀模式**，
 * 这样老书签/老链接点进来仍然是"我要做手术"的语义，而不是莫名落到普通 DNA。
 */
export default function MethodSurgeryRedirect({
  params,
}: {
  params: { pid: string; methodId: string }
}) {
  labRedirect(params.pid, { view: 'dna', surgery: '1' })
}
