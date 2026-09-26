'use client'

import { usePathname } from 'next/navigation'

/**
 * 单页画布（/lab）与其余页面的外壳分流器。
 *
 * 背景：Next.js App Router 里父 layout 无法被跳过，而根 layout 有一处
 * 硬编码会破坏画布的「全屏不滚动」：
 *   `<div className="pt-12">`（为 fixed 顶栏留白）
 *
 * B6 之后旧的多页路由已全部 redirect 到 /lab，`ProjectNav` 侧栏与
 * zustand store 一并删除，所以本组件只剩「顶栏在 /lab 下要不要渲染」
 * 这一个判断。
 *
 * 简化说明：原先 NonLab 分支还有 `<main className="ml-52 p-6">` 为左侧
 * 导航预留 208px 内边距，导航删掉后那圈留白就是纯浪费 —— 已改为普通容器。
 * 保留分流逻辑本身，是因为 /projects 列表页仍然需要顶部留白。
 */

/** 判断当前是否处于单页画布路由（/projects/<pid>/lab） */
function isLabRoute(pathname: string | null): boolean {
  return Boolean(pathname && /^\/projects\/[^/]+\/lab(\/|$)/.test(pathname))
}

/** 根外壳：/lab 下不要顶部留白，其余路径保留 pt-12 */
export function RootShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  if (isLabRoute(pathname)) {
    return <div className="h-screen overflow-hidden">{children}</div>
  }
  return <div className="pt-12">{children}</div>
}

/** 顶栏：/lab 下不渲染（画布自己占满整屏） */
export function TopHeader({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  if (isLabRoute(pathname)) return null
  return <>{children}</>
}

/**
 * 项目外壳。
 *
 * /lab 下：占满全屏、禁止滚动。
 * 其余路径：普通块级容器 —— 不再预留左侧导航宽度（导航已删除）。
 */
export function ProjectMainShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  if (isLabRoute(pathname)) {
    return <div className="h-full w-full overflow-hidden">{children}</div>
  }
  return <div className="min-h-[calc(100vh-3rem)]">{children}</div>
}
