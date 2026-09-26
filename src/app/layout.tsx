import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'
import { RootShell, TopHeader } from '@/components/RouteShells'

export const metadata: Metadata = {
  title: 'MethodAtlas —— AI 科研方法实验室',
  description:
    '从论文研究成果中提取方法结构，理解当前技术状态，发现长期未解决的问题，辅助研究者探索和验证潜在研究方向',
  /**
   * ── P18 问题 5：favicon 用 logo 的图形部分 ──
   * 用户上传的 logo（金字塔 + DNA 双螺旋，白底蓝紫）图形与文字
   * 之间有清晰的空白分隔带，favicon 用裁出的纯图形
   * （public/logo-graphic.png 缩的 favicon-32.png），小尺寸下
   * 文字不可读只会糊成一团。
   */
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/logo-graphic.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-white text-ink">
        <TopHeader>
          <header className="fixed left-0 right-0 top-0 z-20 flex h-12 items-center border-b border-line bg-white/90 px-4 backdrop-blur">
            <Link href="/projects" className="flex items-baseline gap-2">
              <span className="text-base font-semibold tracking-tight text-ink">
                MethodAtlas
              </span>
              <span className="text-xs text-ink-muted">AI 科研方法实验室</span>
            </Link>
          </header>
        </TopHeader>
        <RootShell>{children}</RootShell>
      </body>
    </html>
  )
}
