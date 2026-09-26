'use client'

/**
 * 空态提示块 —— 缩小并下沉到底部，把画布主体让出来。
 *
 * ── 本轮（P7-3）的关键改动 ──
 *
 * 原先空态是"画布中央 320px 白卡 + 一句话 + 主按钮"，占据视觉中心。
 * 但本轮给 5 个视图都加了**画布主体**（结构预览 / 时间线 / 宽卡 /
 * 组合式小图 / 检查项行），主体才是用户该看的东西 ——
 * 提示块继续霸占中央就会把主体压下去。
 *
 * 所以改成：
 *   - 位置：从 `items-center`（垂直居中）改为 `items-end`（贴底），
 *     且整体下沉到底部状态条上方
 *   - 尺寸：从 width 320 + 大内边距 收紧到 width 260 + 紧凑内边距
 *   - 视觉：保留白底 + 浅边框（与点阵网格分层），但不再抢中心
 *
 * 这样一来，用户第一眼看到的是"这个视图将来长什么样"（主体），
 * 第二眼才看到"现在还没有数据，点这里开始"（提示块）。
 *
 * 语义上仍然坚持：空态**不是**虚线占位节点。节点意味着"结构里的一环"，
 * 空态是"还没有结构"，两者混用会让人以为点了能展开。
 */
export function EmptyCanvas({
  title,
  hint,
  action,
  onAction,
  liftedByPanel = false,
}: {
  title: string
  hint?: string
  action?: string
  onAction?: () => void
  /**
   * ── U2 修复后：这个参数已成无害的历史遗留，保留只为兼容调用方签名 ──
   *
   * 旧逻辑：面板浮在画布之上（absolute bottom-0，38vh），会盖住空态
   * 提示块和「运行演化分析」这类主按钮，所以面板打开时要把提示块
   * 抬到面板上方（translateY(-38vh)）。
   *
   * 现在面板改成了挤压布局 —— 画布本身会收缩到面板上方，
   * 提示块锚在**收缩后的画布**底部，天然就不会被盖住。
   * 若继续上抬，反而会把它推出画布可视区（双重避让）。
   * 所以这里**忽略**该参数，只保留签名不破坏调用方。
   */
  liftedByPanel?: boolean
}) {
  return (
    <div
      data-empty-canvas
      className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-8 pb-14"
    >
      <div
        className="pointer-events-auto flex flex-col items-center rounded-panel border border-line bg-white/95 px-5 py-4 text-center backdrop-blur-sm"
        style={{ width: 260 }}
      >
        <p className="text-[13px] leading-5 text-ink">{title}</p>
        {hint && <p className="mt-1.5 text-[11px] leading-4 text-ink-muted">{hint}</p>}
        {action && (
          <button
            type="button"
            data-empty-action={action}
            onClick={onAction}
            className="mt-3 rounded-block border border-accent px-3.5 py-1.5 text-meta font-medium text-accent transition-colors hover:bg-accent-soft"
          >
            {action}
          </button>
        )}
      </div>
    </div>
  )
}
