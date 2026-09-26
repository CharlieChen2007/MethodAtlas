import type { Config } from 'tailwindcss'

/**
 * MethodAtlas 视觉基调（P7 单页画布重构后）：
 * 极简专业 —— 纯白背景、深灰文字、单一强调色、几乎不用阴影。
 *
 * 设计约束（来自产品负责人）：
 *   - 背景纯白 #ffffff，主文字 #1a1a1a，次要 #6b7280
 *   - 强调色只用深蓝 #2563eb，且仅用于「选中」与「可操作」元素
 *   - 节点边框 #e5e7eb，连线 #d1d5db
 *   - 禁止：深色背景、大色块、渐变、发光、阴影堆叠、装饰性图标
 *
 * 因此这里刻意不提供阴影 token —— 需要阴影的地方应当重新考虑层次用
 * 间距/字重表达，而不是加 shadow。
 */
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // 文字层次：深 → 中 → 淡
        ink: {
          DEFAULT: '#1a1a1a', // 主文字
          muted: '#6b7280', // 次要文字
          faint: '#9ca3af', // 占位 / 禁用
        },
        // 线条层次
        line: {
          DEFAULT: '#e5e7eb', // 节点边框
          strong: '#d1d5db', // 连线
        },
        // 唯一强调色 —— 选中态与可操作元素
        accent: {
          DEFAULT: '#2563eb',
          soft: '#eff6ff',
        },
        // 风险 / 被干预
        danger: {
          DEFAULT: '#dc2626',
          soft: '#fef2f2',
        },
      },
      borderRadius: {
        block: '0.5rem', // 8px —— 节点
        panel: '0.75rem', // 12px —— 底部面板
      },
      fontSize: {
        // 字号下限 12px。P7 重构前全站有 124 处 text-[10px]/text-[11px]，
        // 低于可读下限；这里给出语义化的档位，新代码不要再用任意值字号。
        micro: ['11px', '16px'],
        meta: ['12px', '18px'],
        body: ['13px', '20px'],
      },
    },
  },
  plugins: [],
}

export default config
