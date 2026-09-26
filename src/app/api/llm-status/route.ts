import { NextResponse } from 'next/server'

import { getLLMRuntimeState } from '@/lib/llm'

/**
 * LLM 运行状态接口 —— 供画布轮询「离线模式」徽标。
 *
 * ── 为什么需要一个接口，而不是直接把状态塞进 Server Component ──
 *
 * 降级是**运行期事件**：它发生在用户点下"抽取方法结构"之后的某一刻，
 * 而页面是那一刻之前渲染的。若把状态当初始 props 传进去，
 * 值会永远停在"未降级"，除非用户手动刷新 —— 那就等于徽标不可见。
 *
 * 所以状态必须是"拉取"的：页面挂载后定时问一句"现在降级了吗"，
 * 一旦为真就把徽标点亮，此后不再熄灭（降级是粘性状态，
 * 见过一次就要让用户知道这次会话被污染过）。
 *
 * ── 为什么不做成无鉴权就危险的东西 ──
 * 它只返回布尔标记 + 累计 token 数，没有业务数据、没有密钥片段
 * （degradedReason 只取错误消息，调用失败时上游已确保不含 Authorization 头），
 * 所以不需要像 /api/pipeline 那样默认关闭。
 *
 * force-dynamic：绝不能缓存 —— 缓存住就等于徽标永远不更新。
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const state = getLLMRuntimeState()

  return NextResponse.json(
    {
      degraded: state.degraded,
      degradedReason: state.degradedReason,
      degradedAt: state.degradedAt,
      successCount: state.successCount,
      degradedCount: state.degradedCount,
      tokens: {
        prompt: state.promptTokens,
        completion: state.completionTokens,
        total: state.promptTokens + state.completionTokens,
      },
      byPurpose: state.byPurpose,
    },
    {
      headers: {
        // 双保险：即便上层加了缓存策略，也强制不缓存
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  )
}
