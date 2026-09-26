"""P9 取证截图：为 5 个问题各采一张"有说服力"的图。

和 verify-local.py 的区别：那个脚本是**断言**（退出码即结论），
这个是**取证**（人眼看得出改没改对）。所以它不去 rollback，
而是尽量把每个问题的"改前/改后关键界面"拍下来。

用法：python3 scripts/shot-p9.py [BASE_URL]
"""
import sys
from playwright.sync_api import sync_playwright

URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000') \
    + '/projects/cmu6r097y0000wdojhh6kwold/lab'
OUT = '/tmp'

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=2)

    # ── 问题 1：DNA 画布上的 Block 名字 ──
    pg.goto(f'{URL}?view=dna', wait_until='networkidle')
    pg.wait_for_selector('[data-canvas-stage]', timeout=20000)
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f'{OUT}/p9-q1-block-names.png')
    names = pg.evaluate("""() => [...document.querySelectorAll('[data-node]')]
      .filter(n => n.getAttribute('data-block'))
      .map(n => n.getAttribute('data-node-label') || n.getAttribute('title'))""")
    print('[Q1] 画布 Block 名字：')
    for n in names:
        print('   ', n)

    # ── 问题 2：演化面板「各论文的处理」 ──
    pg.goto(f'{URL}?view=evolution', wait_until='networkidle')
    pg.wait_for_selector('[data-canvas-stage]', timeout=20000)
    pg.wait_for_timeout(1200)
    card = pg.locator('[data-node]').first
    if card.count() > 0:
        card.click()
        pg.wait_for_timeout(1800)
    pg.screenshot(path=f'{OUT}/p9-q2-evolution.png')
    panel = pg.locator('[data-panel]').first.inner_text() if pg.locator('[data-panel]').count() > 0 else ''
    if '各论文的处理' in panel:
        print('[Q2] 演化的「各论文的处理」：')
        seg = panel.split('各论文的处理')[1].split('证据')[0]
        print('   ', seg.strip().replace('\n', '\n    ')[:300])

    # ── 问题 3：债务面板「涉及的论文」 ──
    pg.goto(f'{URL}?view=debt', wait_until='networkidle')
    pg.wait_for_selector('[data-canvas-stage]', timeout=20000)
    pg.wait_for_timeout(1200)
    card = pg.locator('[data-node]').first
    if card.count() > 0:
        card.click()
        pg.wait_for_timeout(1800)
    # 滚动面板到底部，让「涉及的论文」这一段完整入镜
    pg.evaluate("""() => {
      const p = document.querySelector('[data-panel]');
      if (p) { const sc = p.querySelector('div[class*="overflow"]'); (sc||p).scrollTop = 99999; }
    }""")
    pg.wait_for_timeout(500)
    pg.screenshot(path=f'{OUT}/p9-q3-debt.png')
    panel = pg.locator('[data-panel]').first.inner_text() if pg.locator('[data-panel]').count() > 0 else ''
    if '涉及的论文' in panel:
        print('[Q3] 债务的「涉及的论文」：')
        seg = panel.split('涉及的论文')[1].split('已有尝试')[0]
        print('   ', seg.strip().replace('\n', '\n    ')[:300])

    # ── 问题 4：组合想法冷启动为空 ──
    pg.goto(f'{URL}?view=idea', wait_until='networkidle')
    pg.wait_for_selector('[data-idea-workbench]', timeout=20000)
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f'{OUT}/p9-q4-idea-empty.png')
    wb = pg.locator('[data-idea-workbench]').first.inner_text()
    import re
    m = re.search(r'已生成的想法（\d+）', wb)
    print('[Q4] 冷启动：', m.group(0) if m else '(未找到计数)')
    print('[Q4] 生成按钮 disabled =', pg.locator('[data-generate-combo]').first.is_disabled())

    # ── 问题 5：击穿测试的档位与改法 ──
    #    用「选 2 个跨论文模块 → 生成 → 跑击穿」的完整链路造出数据
    print('[Q5] 先用真实交互造一条击穿测试…')
    opts = pg.locator('[data-block-option]')
    if opts.count() >= 2:
        groups = pg.evaluate("""() => {
          const wrap = document.querySelector('[data-idea-workbench]');
          const out = [];
          document.querySelectorAll('[data-block-option]').forEach(btn => {
            let el = btn, g = '';
            while (el && el !== wrap) {
              const t = el.getAttribute && el.getAttribute('data-paper-group');
              if (t) { g = t; break; }
              el = el.parentElement;
            }
            out.push({ id: btn.getAttribute('data-block-option'), group: g });
          });
          return out;
        }""")
        first_g = groups[0]['group'] if groups else ''
        pick = next((i for i, g in enumerate(groups) if g['group'] and g['group'] != first_g), None)
        if pick is not None:
            opts.nth(0).click(); pg.wait_for_timeout(250)
            opts.nth(pick).click(); pg.wait_for_timeout(350)
            gen = pg.locator('[data-generate-combo]')
            if not gen.first.is_disabled():
                gen.first.click()
                for _ in range(30):
                    pg.wait_for_timeout(1000)
                    if pg.locator('[data-idea-card]').count() > 0:
                        break
                pg.screenshot(path=f'{OUT}/p9-q4-idea-generated.png')
                ic = pg.locator('[data-idea-card]').first
                if ic.count() > 0:
                    ic.click(); pg.wait_for_timeout(1500)
                    rc = pg.locator('[data-panel-action="crashtest"]')
                    if rc.count() > 0:
                        rc.first.click()
                        for _ in range(40):
                            pg.wait_for_timeout(1000)
                            if pg.locator('[data-node^="crash-"]').count() > 0:
                                break
    pg.goto(f'{URL}?view=crashtest', wait_until='networkidle')
    pg.wait_for_selector('[data-canvas-stage]', timeout=20000)
    pg.wait_for_timeout(1000)
    cn = pg.locator('[data-node]').first
    if cn.count() > 0:
        cn.click()
        pg.wait_for_timeout(1800)
    # 往下滚，让「四项检查」全部入镜 —— 这样才能同时看到
    # 「通过」项**没有**改法行、「无法判断」项也**没有**改法行。
    #   用「四项检查」标题做锚点滚到它的位置，比硬编码 scrollTop 稳。
    pg.evaluate("""() => {
      const p = document.querySelector('[data-panel]');
      if (!p) return;
      const sc = p.querySelector('div[class*="overflow"]') || p;
      // 找到含「四项检查」的那个节点
      const all = p.querySelectorAll('*');
      for (const el of all) {
        if (el.children.length === 0 && /四项检查/.test(el.textContent || '')) {
          // 让这一段刚好停在面板可视区顶部
          sc.scrollTop = el.offsetTop - 20;
          return;
        }
      }
    }""")
    pg.wait_for_timeout(400)
    pg.screenshot(path=f'{OUT}/p9-q5-crashtest.png')
    panel = pg.locator('[data-panel]').first.inner_text() if pg.locator('[data-panel]').count() > 0 else ''
    print('[Q5] 击穿测试面板：')
    print('   ', panel.replace('\n', '\n    ')[:900])

    b.close()
print('\n截图已写入 /tmp/p9-*.png')
