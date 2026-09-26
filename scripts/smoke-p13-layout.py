#!/usr/bin/env python3
"""P13 布局冒烟：两处新位置（第三列下方输入框 / 画布下方 AI dock）。"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
LAB = f"{BASE}/projects/cmu9my2ie0000z6pko5sqr27s/lab"


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 950})
        page.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
        errs = []
        page.on('console', lambda m: errs.append(m.text[:120]) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errs.append(str(e)[:160]))

        # ── 1. idea 视图：表单在第三列下方 ──
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_selector('[data-idea-workbench]', timeout=20000)
        page.wait_for_timeout(1200)

        geo = page.evaluate(
            """() => {
              const cols = document.querySelectorAll('[data-idea-workbench] > section');
              const third = cols[cols.length - 1];
              const form = document.querySelector('[data-custom-idea-form]');
              const genBtn = document.querySelector('[data-generate-combo]');
              if (!third || !form || !genBtn) return { ok: false, why: `third=${!!third} form=${!!form} gen=${!!genBtn}` };
              const t = third.getBoundingClientRect(), f = form.getBoundingClientRect(), g = genBtn.getBoundingClientRect();
              return { ok: true, cols: cols.length,
                       inThirdCol: t.left <= f.left && f.right <= t.right,
                       belowGenBtn: f.top > g.bottom,
                       headerText: third.innerText.slice(0, 200) };
            }"""
        )
        print('── idea 视图 ──')
        print('列数:', geo.get('cols'), '| 表单在第三列内:', geo.get('inThirdCol'),
              '| 表单在生成按钮下方:', geo.get('belowGenBtn'))
        print('Header 文本含「手动添加模块」:', '手动添加模块' in (geo.get('headerText') or ''))
        if not geo.get('ok'):
            print('缺失:', geo.get('why'))
        body_text = page.evaluate('() => document.body.innerText')
        print('概览三态钩子保留:',
              page.locator('[data-idea-count]').count() == 1,
              '| 去击穿测试按钮:', page.locator('[data-goto-crashtest]').count())

        # ── 2. crashtest 视图：AI dock 在内容列底部（非浮动） ──
        # ── P19 变更 ──
        #   击穿视图不再渲染画布（[data-canvas-stage] 已不存在，中栏改由
        #   [data-crash-tabs] + 击穿报告承担），所以这里等 tab 条；
        #   dock 的"上方兄弟"也从中栏画布容器变成了整个中栏。
        #   默认折叠也变了：现在起手是 collapsed=1，要看展开态得点浮标。
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_selector('[data-crash-tabs]', timeout=20000)
        page.wait_for_timeout(1500)
        print('\n── crashtest 视图 ──')
        print('画布已按 P19 移除（中栏改为 tab + 报告）:',
              page.locator('[data-canvas-stage]').count() == 0)
        print('AI dock 默认折叠（P19）:',
              page.locator('[data-crash-chat]').first.get_attribute('data-collapsed') == '1')

        # 展开 dock（P19：开关是右下角浮标）
        page.locator('[data-explore-fab]').first.click()
        page.wait_for_timeout(600)

        dock = page.evaluate(
            """() => {
              const chat = document.querySelector('[data-crash-chat]');
              if (!chat) return { ok: false, why: 'no chat dock' };
              // 找它上方的内容容器：chat 的上一个兄弟元素
              const wrap = chat.previousElementSibling;
              if (!wrap) return { ok: false, why: 'no prev sibling' };
              const c = wrap.getBoundingClientRect();
              const d = chat.getBoundingClientRect();
              const cs = getComputedStyle(chat);
              return { ok: true,
                       position: cs.position,
                       belowCanvas: d.top >= c.bottom - 2,
                       canvasBottom: c.bottom, dockTop: d.top,
                       collapsed: chat.getAttribute('data-collapsed'),
                       dockH: d.height };
            }"""
        )
        print('dock 存在:', dock.get('ok'), dock.get('why', ''))
        if dock.get('ok'):
            print('position:', dock.get('position'), '| dock 在内容区下方:',
                  dock.get('belowCanvas'), f"(内容 bottom={dock.get('canvasBottom')} vs dock top={dock.get('dockTop')})")
            print('collapsed:', dock.get('collapsed'), '| dock 高度:', dock.get('dockH'))

        # 折叠交互
        page.locator('[data-chat-collapse]').first.click()
        page.wait_for_timeout(400)
        h_collapsed = page.evaluate(
            """() => { const el = document.querySelector('[data-crash-chat]'); return el.getBoundingClientRect().height; }"""
        )
        print('收起后高度:', h_collapsed, '(应 ≈ 标题行 36px)')
        page.locator('[data-chat-collapse]').first.click()
        page.wait_for_timeout(400)

        print('\nconsole 错误:', len(errs), errs[:3] if errs else '')
        browser.close()
        return 0


if __name__ == '__main__':
    sys.exit(main())
