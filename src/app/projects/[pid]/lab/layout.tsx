import { EvidenceDrawerProvider } from '@/components/EvidenceDrawer'

/**
 * 单页画布的全屏外壳。
 *
 * 这一层刻意只做三件事：占满视口、禁止滚动、提供证据抽屉 Context。
 * 页面自身永不滚动（overflow-hidden），滚动被限制在内部容器里。
 */
export default function LabLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <EvidenceDrawerProvider>
      <div className="h-screen w-screen overflow-hidden bg-white">
        {children}
      </div>
    </EvidenceDrawerProvider>
  )
}
