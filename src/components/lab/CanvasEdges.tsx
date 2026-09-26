'use client'

import type { LayoutEdge, LayoutNode } from '@/lib/lab/layout'

/**
 * 连线层 —— 单层 SVG，按节点坐标画浅灰细贝塞尔曲线，**不画箭头**。
 *
 * 为什么不用图库：连线只是"从父节点右边缘到子节点左边缘"的曲线，
 * 逻辑极简单；引入图库反而会用它的自动布局覆盖我们确定性的层级坐标。
 *
 * ── P7-3：虚线 + 标签 ──
 * 演化视图空态要表达"论文之间的关系还没建立"。这不是"没有连线"，
 * 而是"连线本该在这里、但还说不出来" —— 用**虚线 + 中点标签
 * 「关系待建立」**表达。实线代表已证实的关系，虚线代表待建立的，
 * 这条区分让用户一眼看出"还差什么"。
 *
 * 标签画在中点上方 8px，字号 10px、颜色比线深一档，保证可读。
 */
export function CanvasEdges({
  nodes,
  edges,
  width,
  height,
}: {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  width: number
  height: number
}) {
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const drawn = edges
    .map((e, i) => {
      const from = byId.get(e.from)
      const to = byId.get(e.to)
      if (!from || !to) return null

      // 起点：父节点右边缘中点；终点：子节点左边缘中点
      // 终点 y 优先用边自带的锚点（多节点列指向列中心，避免线歪向列首）
      const x1 = from.x + from.w
      const y1 = from.y + from.h / 2
      const x2 = to.x
      const y2 = e.toAnchorY ?? to.y + to.h / 2
      // 控制点偏移取水平间距的一半，曲线更柔和
      const dx = Math.max(12, (x2 - x1) / 2)

      return { key: `${e.from}->${e.to}-${i}`, x1, y1, x2, y2, dx, edge: e }
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))

  return (
    <svg
      width={width}
      height={height}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        pointerEvents: 'none', // 不拦截节点的点击/拖拽
        overflow: 'visible',
      }}
      aria-hidden
    >
      {drawn.map(({ key, x1, y1, x2, y2, dx, edge }) => (
        <path
          key={key}
          d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
          fill="none"
          stroke="#d1d5db"
          strokeWidth={1}
          // 虚线：尚未证实的关系（演化视图空态）
          strokeDasharray={edge.dashed ? '4 4' : undefined}
        />
      ))}

      {/* 连线标签：画在弧线中点上方，说明这条线为什么是虚的 */}
      {drawn
        .filter((d) => d.edge.label)
        .map((d) => {
          const mx = (d.x1 + d.x2) / 2
          const my = (d.y1 + d.y2) / 2
          return (
            <text
              key={`label-${d.key}`}
              x={mx}
              y={my - 8}
              textAnchor="middle"
              fontSize={10}
              fill="#9ca3af"
            >
              {d.edge.label}
            </text>
          )
        })}
    </svg>
  )
}
