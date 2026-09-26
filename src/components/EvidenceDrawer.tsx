'use client'

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useState } from 'react'
import {
  EVIDENCE_SOURCE_ICON,
  EVIDENCE_SOURCE_LABEL,
  EVIDENCE_STATUS_COLOR,
  EVIDENCE_STATUS_LABEL,
} from '@/lib/enums'
import { RightDrawer } from './RightDrawer'
import type { EvidenceItem } from '@/lib/evidence-view'

export type { EvidenceItem } from '@/lib/evidence-view'

type DrawerPanel =
  | { mode: 'evidence'; title: string; items: EvidenceItem[] }
  | { mode: 'detail'; title: string; content: ReactNode; subtitle?: string }

interface EvidenceDrawerContextValue {
  /** 打开证据列表抽屉 */
  open: (items: EvidenceItem[], title?: string) => void
  /** 打开自定义详情抽屉 */
  openDetail: (title: string, content: ReactNode, subtitle?: string) => void
  /** 关闭整个抽屉 */
  close: () => void
}

const EvidenceDrawerContext = createContext<EvidenceDrawerContextValue | null>(null)

/** 在页面树里包一层 Provider，即可让任意子组件调出右侧抽屉（证据或自定义详情） */
export function EvidenceDrawerProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [stack, setStack] = useState<DrawerPanel[]>([])
  const top = stack.length > 0 ? stack[stack.length - 1] : null

  const open = useCallback((items: EvidenceItem[], title?: string) => {
    setStack((prev) => [...prev, { mode: 'evidence', title: title || '证据详情', items }])
  }, [])

  const openDetail = useCallback((title: string, content: ReactNode, subtitle?: string) => {
    setStack((prev) => [...prev, { mode: 'detail', title, content, subtitle }])
  }, [])

  const close = useCallback(() => setStack([]), [])

  const renderContent = () => {
    if (!top) return null
    if (top.mode === 'evidence') {
      return <EvidenceDrawerContent items={top.items} />
    }
    return top.content
  }

  const subtitle = top?.mode === 'evidence' ? `共 ${top.items.length} 条证据 · 全部可回溯到论文原文` : top?.subtitle

  return (
    <EvidenceDrawerContext.Provider value={{ open, openDetail, close }}>
      {children}
      <RightDrawer
        open={Boolean(top)}
        title={top?.title || ''}
        subtitle={subtitle}
        onClose={close}
      >
        {renderContent()}
      </RightDrawer>
    </EvidenceDrawerContext.Provider>
  )
}

/** 在客户端组件里取抽屉控制器 */
export function useEvidenceDrawer() {
  const ctx = useContext(EvidenceDrawerContext)
  if (!ctx) {
    throw new Error('useEvidenceDrawer 必须在 EvidenceDrawerProvider 内部使用')
  }
  return ctx
}

/** 标准证据列表内容 */
function EvidenceDrawerContent({ items }: { items: EvidenceItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        没有关联证据。按项目规则，无证据的结论不应被采信。
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {items.map((ev, i) => (
        <article
          key={ev.id}
          className="rounded-lg border border-slate-200 bg-slate-50/50 p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-400">#{i + 1}</span>
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700">
              {EVIDENCE_SOURCE_ICON[ev.source] ?? '·'}
              {EVIDENCE_SOURCE_LABEL[ev.source] ?? ev.source}
            </span>
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                EVIDENCE_STATUS_COLOR[ev.status] ??
                'bg-slate-100 text-slate-600 border-slate-200'
              }`}
            >
              {EVIDENCE_STATUS_LABEL[ev.status] ?? ev.status}
            </span>
            {ev.pageNumber !== null && (
              <span className="text-[11px] text-slate-500">第 {ev.pageNumber} 页</span>
            )}
            {ev.section && <span className="text-[11px] text-slate-400">{ev.section}</span>}
          </div>

          {ev.paperTitle && (
            <p className="mt-2 text-[11px] text-slate-500">来源：{ev.paperTitle}</p>
          )}

          {/**
           * ── 问题 5：证据核对闭环 —— 「打开 PDF 对应页」──
           *
           * 原状态：证据抽屉给出了论文标题、页码、原文片段，但**到此为止**。
           * 用户要核对"这句话真的在原文第 2 页吗"，只能自己去找那份 PDF、
           * 自己翻到第 2 页 —— 核对链路断在这里，"可回溯"就成了口号。
           *
           * 现在：给一个直达链接，点了直接在浏览器内置阅读器里打开原文
           * 并跳到该页（`#page=N` 是 PDF Open Parameters 标准，主流内置
           * 阅读器都认）。
           *
           * 为什么用 `<a target="_blank">` 而不是开一个内嵌 iframe：
           *   浏览器内置 PDF 阅读器功能完整（翻页/缩放/搜索/复制），
           *   自己套 iframe 反而阉割了体验，还要处理弹窗拦截与尺寸问题。
           *   新标签打开、原页面不丢，用户的核对上下文还在。
           *
           * 没有 paperId（历史/合成证据）时不渲染链接 —— 只给有原文的。
           */}
          {ev.paperId ? (
            <a
              href={`/api/paper/${ev.paperId}${
                ev.pageNumber !== null ? `#page=${ev.pageNumber}` : ''
              }`}
              target="_blank"
              rel="noreferrer"
              data-open-pdf={ev.paperId}
              className="mt-2 inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50"
            >
              打开 PDF 对应页
              {ev.pageNumber !== null && <span className="text-slate-400">（第 {ev.pageNumber} 页）</span>}
              <span aria-hidden className="text-slate-400">↗</span>
            </a>
          ) : (
            ev.paperTitle && (
              <p className="mt-2 text-[10px] text-slate-400">
                （该证据未关联可打开的原文文件）
              </p>
            )
          )}

          {ev.quote ? (
            <blockquote className="mt-2.5 border-l-2 border-line-strong bg-white py-2 pl-3 pr-2 text-xs leading-relaxed text-slate-700">
              {ev.quote}
            </blockquote>
          ) : (
            <p className="mt-2.5 text-xs text-slate-400">该证据没有可展示的原文片段</p>
          )}

          <div className="mt-2 text-[10px] text-slate-400">
            置信度 {Math.round(ev.confidence * 100)}%
          </div>
        </article>
      ))}
    </div>
  )
}
