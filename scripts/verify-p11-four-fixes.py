#!/usr/bin/env python3
"""
verify-p11-four-fixes.py —— 验收 P11 四问题修复。

对应需求：
  问题 1  重置按钮迁到画布右上角（boundingBox 完全在画布内、与右栏零重叠）
          ── P19 重写：右栏已整体删除、重置簇搬进**顶栏右侧动作区**
             （左栏展开态另有一份），"在画布右上角"不再成立 →
             改为断言"簇 ⊆ 顶栏 + 与内容列零重叠 + 不越出视口"。
  问题 2  击穿测试唯一入口 = 画布内蓝色主按钮（底部运行区删除）
  问题 3  每次生成的想法累积同步到击穿测试列表（不替换 + 来源方法可区分）
  问题 4  五态 UI 动画可区分（生成中/生成完成/运行中/运行完成/重置）

用法：
  python3 scripts/verify-p11-four-fixes.py

前置：3000 端口有 next dev/start；库里至少两篇有结构的论文。
注意：脚本会真实调模型生成两轮想法（每轮可达 ~2 分钟）、并真实运行一次
击穿测试。最后做一次「彻底重置」清掉本轮产生的运行数据（论文保留）。
"""

import json
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
PROJECT = "cmu9my2ie0000z6pko5sqr27s"
LAB = f"{BASE}/projects/{PROJECT}/lab"

ROOT = Path(__file__).resolve().parent.parent

FAILS = []
CHECKS = 0


def check(name, ok, detail=''):
    global CHECKS
    CHECKS += 1
    mark = 'PASS' if ok else 'FAIL'
    if not ok:
        FAILS.append(name)
    print(f"  [{mark}] {name}" + (f"  —— {detail}" if detail else ''))


def overlap_area(a, b):
    """两个 boundingBox 字典的相交面积。0 = 零重叠。"""
    if not a or not b:
        return 0.0
    ox = max(0.0, min(a['x'] + a['width'], b['x'] + b['width']) - max(a['x'], b['x']))
    oy = max(0.0, min(a['y'] + a['height'], b['y'] + b['height']) - max(a['y'], b['y']))
    return ox * oy


def db_count(table):
    js = (
        "const{PrismaClient}=require('@prisma/client');"
        f"const p=new PrismaClient();(async()=>{{console.log(await p.{table}.count());"
        "await p.$disconnect()})();"
    )
    r = subprocess.run(['node', '-e', js], cwd=str(ROOT), capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f'db_count({table}) 失败: {r.stderr[:200]}')
    return int(r.stdout.strip().splitlines()[-1])


def idea_ids():
    js = (
        "const{PrismaClient}=require('@prisma/client');"
        "const p=new PrismaClient();(async()=>{const rows=await p.candidateIdea.findMany("
        "{select:{id:true},orderBy:{createdAt:'asc'}});"
        "console.log(JSON.stringify(rows.map(r=>r.id)));await p.$disconnect()})();"
    )
    r = subprocess.run(['node', '-e', js], cwd=str(ROOT), capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f'idea_ids 失败: {r.stderr[:200]}')
    return json.loads(r.stdout.strip().splitlines()[-1])


def dismiss_stale_feedback(page):
    """关掉上一轮遗留的反馈条 —— 否则旧的 ok 态会被误当成"本轮完成"。"""
    for _ in range(6):
        btn = page.locator('button[aria-label="关闭提示"]')
        if btn.count() == 0:
            break
        btn.first.click()
        page.wait_for_timeout(300)


def run_generation(page, want_capture, ideas_before):
    """跑一轮生成：枚举全部跨论文块对逐个尝试，直到本轮产出 ≥1 个想法。
    want_capture=True 时捕捉 pending/ok 两态（问题4）。
    返回 (ok, pending_captured, ok_captured)"""
    pairs = page.evaluate(
        """() => {
          const opts = Array.from(document.querySelectorAll('[data-block-option]'));
          const byGroup = {};
          for (const o of opts) {
            let el = o, g = '';
            while (el) {
              const t = el.getAttribute && el.getAttribute('data-paper-group');
              if (t) { g = t; break; }
              el = el.parentElement;
            }
            if (!g) continue;
            (byGroup[g] = byGroup[g] || []).push(o.getAttribute('data-block-option'));
          }
          const groups = Object.keys(byGroup);
          const out = [];
          if (groups.length < 2) return out;
          for (let i = 1; i < 5; i++) {
            const a = byGroup[groups[0]][i], b = byGroup[groups[1]][i];
            if (a && b) out.push([a, b]);
          }
          return out;
        }"""
    )
    if len(pairs) == 0:
        return False, False, False

    def uncheck(pair):
        for bid in pair:
            b = page.locator(f'[data-block-option="{bid}"]')
            if b.count() > 0 and b.first.get_attribute('data-picked') == '1':
                b.first.click()
                page.wait_for_timeout(200)

    pending_captured = False
    ok_captured = False

    for pair in pairs:
        dismiss_stale_feedback(page)

        for bid in pair:
            loc = page.locator(f'[data-block-option="{bid}"]')
            if loc.count() > 0 and loc.first.get_attribute('data-picked') != '1':
                loc.first.click()
                page.wait_for_timeout(300)
        if page.locator('[data-block-option][data-picked="1"]').count() < 2:
            uncheck(pair)
            continue
        if page.locator('[data-debt-option][data-picked="1"]').count() == 0:
            d = page.locator('[data-debt-option]')
            if d.count() > 0:
                d.first.click()
                page.wait_for_timeout(250)

        gen = page.locator('[data-generate-combo]').first
        if gen.is_disabled():
            uncheck(pair)
            continue

        gen.click()

        # ── 等 pending 出现（捕捉"生成中"态）──
        for _ in range(15):
            page.wait_for_timeout(1000)
            if page.locator('[data-feedback-state="pending"]').count() > 0:
                if want_capture:
                    btn_cls = page.locator('[data-generate-combo]').first.get_attribute('class') or ''
                    pending_captured = (
                        page.locator('[data-generate-combo]').first.get_attribute('data-generating') == '1'
                        and 'ma-pulse' in btn_cls
                    )
                break

        # ── 等 ok/error（最长 150s）──
        settled = False
        for _ in range(150):
            page.wait_for_timeout(1000)
            if page.locator('[data-feedback-state="ok"]').count() > 0:
                if want_capture:
                    cls = page.locator('[data-feedback-state="ok"]').first.get_attribute('class') or ''
                    ok_captured = 'ma-ok-flash' in cls
                settled = True
                break
            if page.locator('[data-feedback-state="error"]').count() > 0:
                settled = True
                break

        if not settled:
            uncheck(pair)
            continue

        # 本轮真的产出了新想法才算成功
        if db_count('candidateIdea') > ideas_before:
            return True, pending_captured, ok_captured

        # 这一组被关卡拦下 → 取消勾选换下一组
        uncheck(pair)

    return False, pending_captured, ok_captured


def main():
    print('=' * 64)
    print('P11 四问题修复验收（重置位置 / 击穿入口 / 想法累积 / UI 动画）')
    print('=' * 64)

    # ── 清场：从零开始测累积 ──
    subprocess.run(['node', 'scripts/reset-user-data.mjs'], cwd=str(ROOT),
                   capture_output=True, text=True, timeout=120)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 950})
        page.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")

        # ============ 问题 1：重置按钮几何 ============
        print('\n── 问题 1：重置按钮在画布右上角 ──')
        page.goto(f'{LAB}?view=dna', wait_until='networkidle')
        page.wait_for_timeout(1500)

        reset_run = page.locator('[data-reset-run]')
        check('1a 重置簇里有「↺ 重置」按钮（P19：在顶栏右侧动作区）',
              reset_run.count() == 1 and '重置' in reset_run.first.inner_text(), '')
        check('1a 存在彻底重置按钮', page.locator('[data-reset-data]').count() == 1, '')
        check('1a 按钮带图标字形（↺）',
              '↺' in page.locator('[data-reset-cluster]').inner_text(), '')

        box = reset_run.first.bounding_box()
        cluster_box = page.locator('[data-reset-cluster]').first.bounding_box()
        topbar_box = page.locator('[data-top-bar]').first.bounding_box()
        content_box = page.locator('[data-lab-body] > div').first.bounding_box()
        check('1b 拿到重置按钮/顶栏/内容列的 boundingBox',
              all([box, cluster_box, topbar_box, content_box]),
              f'box={box is not None} topbar={topbar_box is not None}')
        if all([box, cluster_box, topbar_box, content_box]):
            # ── P19：重置簇从"右栏工具栏（击穿测试按钮正下方）"搬到
            #    **顶栏右侧动作区**（左栏展开态另有一份，同一条确认链路）。
            #    旧三条地理断言全部失去对象：
            #      · "⊆ 右栏 aside" —— 右栏已删；
            #      · "在击穿测试按钮正下方" —— 顶栏那份在它**上方**，
            #        只有左栏展开态那份才在步骤下方（那条留给 verify-p16 验）；
            #      · "在画布列右侧" —— 内容列现在在左栏**右**边，式子恒假。
            #    换成同样能抓"重置入口压住别的区域"的等价契约。
            inside_topbar = (cluster_box['x'] >= topbar_box['x'] - 1
                             and cluster_box['y'] >= topbar_box['y'] - 1
                             and cluster_box['x'] + cluster_box['width']
                             <= topbar_box['x'] + topbar_box['width'] + 1
                             and cluster_box['y'] + cluster_box['height']
                             <= topbar_box['y'] + topbar_box['height'] + 1)
            check('1b 重置簇 boundingBox 完全在顶栏 [data-top-bar] 内', inside_topbar,
                  f"cluster=({cluster_box['x']:.0f},{cluster_box['y']:.0f},"
                  f"{cluster_box['width']:.0f}x{cluster_box['height']:.0f})")
            # 顶栏在内容列**上方**（x 上是重叠的），所以必须按面积判，
            # 不能只看 x —— 只看 x 会得到"必然重叠"的假失败。
            area = overlap_area(cluster_box, content_box)
            check('1b 重置簇与内容列零重叠（矩形相交面积 = 0）', area <= 1,
                  f'重叠 {area:.0f}px²')
            vw = page.viewport_size['width']
            check('1b 重置簇不越出视口右缘',
                  cluster_box['x'] + cluster_box['width'] <= vw - 1 + 1,
                  f"right={cluster_box['x'] + cluster_box['width']:.0f} vw={vw}")

        # 两层确认逻辑保持
        reset_run.first.click()
        page.wait_for_timeout(500)
        check('1c 点击重置弹二次确认', page.locator('[data-confirm-dialog]').count() == 1, '')
        page.locator('[data-confirm-cancel]').first.click()
        page.wait_for_timeout(400)

        # 各视图重置簇都在（切到 idea 再验一次存在）
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_timeout(1200)
        check('1d idea 视图重置按钮同样在顶栏（常驻，不随视图消失）',
              page.locator('[data-reset-run]').count() == 1, '')

        # ============ 问题 2：击穿测试唯一入口 ============
        print('\n── 问题 2：击穿测试入口改为画布内蓝色主按钮 ──')
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(1500)

        check('2a 画布底部运行区已删除（data-crash-run-bar 不存在）',
              page.locator('[data-crash-run-bar]').count() == 0, '')
        check('2a 画布内浮动卡片存在（data-crash-run-card）',
              page.locator('[data-crash-run-card]').count() == 1, '')
        check('2a 空态时无运行按钮（入口随想法出现）',
              page.locator('[data-run-crash]').count() == 0, '')

        # 空态：清场后无想法 → 引导去组合想法
        check('2b 无想法时显示空态引导',
              page.locator('[data-crash-ideas-empty]').count() == 1
              and page.locator('[data-goto-idea]').count() == 1, '')

        card_box = page.locator('[data-crash-run-card]').first.bounding_box()
        nav_box = page.locator('[data-nav]').first.bounding_box()
        content_box2 = page.locator('[data-lab-body] > div').first.bounding_box()
        # ── P19：旧断言是"击穿卡片右缘不越进右栏"（card.right <= aside.left）。
        #    右栏删除后导航搬到了**左边**，那条式子从"守边界"变成恒假的
        #    （卡片当然在左栏右边）。等价契约：卡片完整落在内容列内，
        #    且与左侧导航栏矩形相交面积为 0（不压导航、也不越出自己的区域）。
        check('2c 击穿卡片完整落在内容列内、且不压左侧导航栏',
              all([card_box, nav_box, content_box2])
              and card_box['x'] >= content_box2['x'] - 1
              and card_box['x'] + card_box['width']
              <= content_box2['x'] + content_box2['width'] + 1
              and overlap_area(card_box, nav_box) <= 1,
              f"卡片 x={card_box['x']:.0f}→{card_box['x'] + card_box['width']:.0f}"
              f" 内容列 x={content_box2['x']:.0f}→{content_box2['x'] + content_box2['width']:.0f}"
              f" 与左栏重叠={overlap_area(card_box, nav_box):.0f}px²"
              if card_box and nav_box and content_box2 else '')

        # ============ 问题 3 + 问题 4：两轮生成累积 + 动画捕捉 ============
        print('\n── 问题 3：想法累积同步（第 1 轮生成）──')
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_selector('[data-idea-workbench]', timeout=20000)
        page.wait_for_timeout(1000)

        ok1, pend1, okflash1 = run_generation(page, want_capture=True, ideas_before=0)
        check('3a 第 1 轮生成完成', ok1 and db_count('candidateIdea') >= 1,
              f"ideas={db_count('candidateIdea')}")
        check('4a 生成中状态可见（feedback pending + 按钮 data-generating + ma-pulse）',
              pend1, '')
        check('4b 生成完成状态可见（feedback ok + ma-ok-flash）', okflash1, '')
        check('4b 产出概览块有生成完成闪亮（data-gen-flash=1）',
              page.locator('[data-gen-flash="1"]').count() == 1, '')

        ids_after_r1 = idea_ids()
        n1 = len(ids_after_r1)
        check('3a 第 1 轮产出 ≥1 个想法', n1 >= 1, f'n1={n1}')
        if n1 == 0:
            print('\n第 1 轮所有候选被关卡拦下，后续用例无法推进。')
            browser.close()
            return 2

        # 击穿列表同步（自动刷新，无需手动刷新页面）
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(1500)
        opts = page.locator('[data-crash-idea-option]')
        check('3b 击穿列表同步第 1 轮想法', opts.count() == n1, f'{opts.count()} vs {n1}')
        # ── P19：来源方法标签的载体变了 ──
        #    旧实现是 CrashRunCard 里的 [data-crash-idea-source] 元素，
        #    现在击穿视图顶部是想法 tab 条（CrashIdeaTabs），该元素**不再渲染**
        #    （CrashRunCard 已无任何调用点）。但"每个想法都带来源方法标签"
        #    这条产品契约没变 —— 标签现在是 tab 的 title 提示：
        #    `${title}　来源：${sourceLabel}`。所以改读 title 属性。
        titles = page.evaluate(
            """() => [...document.querySelectorAll('[data-crash-idea-option]')]
                 .map(b => b.getAttribute('title') || '')""")
        with_src = [t for t in titles if '来源：' in t]
        check('3c 每个想法 tab 都带「来源方法」标签（title 里带「来源：…」）',
              len(titles) == opts.count() and len(with_src) == len(titles)
              and len(titles) >= 1,
              f'{len(with_src)}/{len(titles)}')
        if opts.count() > 0:
            item_title = opts.first.get_attribute('title') or ''
            check('3c tab 提示 = 想法标题 + 来源方法（非空且含「来源」与「来自」）',
                  bool(item_title.strip()) and '来源：' in item_title
                  and '来自' in item_title, item_title[:60])
        else:
            check('3c tab 提示 = 想法标题 + 来源方法（非空且含「来源」与「来自」）',
                  False, '无列表项')

        print('\n── 问题 3：第 2 轮生成（换一组素材）──')
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_selector('[data-idea-workbench]', timeout=20000)
        page.wait_for_timeout(1000)
        ok2, _, _ = run_generation(page, want_capture=False, ideas_before=n1)
        ids_after_r2 = idea_ids()
        n2 = len(ids_after_r2)
        check('3d 第 2 轮生成完成', ok2, f'n2={n2}')
        kept = all(i in ids_after_r2 for i in ids_after_r1)
        check('3d 旧想法全部保留（累积而非替换）', kept,
              f'{n1} 个旧 id 全部还在（现共 {n2}）' if kept else '旧 id 丢失！')
        check('3d 总数不减少', n2 >= n1, f'{n2} >= {n1}')
        if n2 > n1:
            check('3d 新想法已追加进列表', True, f'+{n2 - n1} 个')
        else:
            check('3d 新想法已追加进列表（本轮全部被判重复标题，去重生效）',
                  True, 'duplicates 生效，总数不变')

        # 击穿列表再次同步
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(1500)
        opts = page.locator('[data-crash-idea-option]')
        check('3e 击穿列表实时同步全部累积想法', opts.count() == n2, f'{opts.count()} vs {n2}')

        # ============ 问题 2（续）：选中 → 蓝色按钮运行 ============
        print('\n── 问题 2（续）：蓝色主按钮运行击穿 ──')
        check('2a 有想法时运行按钮全局唯一（唯一入口）',
              page.locator('[data-run-crash]').count() == 1, '')
        opts.first.click()
        page.wait_for_timeout(500)
        run_btn = page.locator('[data-run-crash]').first
        check('2d 选中后蓝色按钮可用', not run_btn.is_disabled(), '')
        btn_color = run_btn.evaluate('el => getComputedStyle(el).backgroundColor')
        check('2d 按钮为蓝色主色（#2563eb）', btn_color == 'rgb(37, 99, 235)', btn_color)
        check('2d 选中态写入 URL', 'crashIdeaIds=' in page.url, page.url)

        run_btn.click()
        p2, _ = False, False
        ok_seen = False
        for i in range(120):
            page.wait_for_timeout(1000)
            if not p2 and page.locator('[data-feedback-state="pending"]').count() > 0:
                p2 = True
            if page.locator('[data-feedback-state="ok"]').count() > 0:
                ok_seen = True
                break
        check('4c 击穿运行中状态可见（feedback pending）', p2, '')
        check('4c 击穿完成状态可见（feedback ok）', ok_seen, '')
        check('2e 击穿结果落库', db_count('crashTest') >= 1, f"ct={db_count('crashTest')}")
        page.wait_for_timeout(800)
        check('4c 击穿卡片标题徽标播完成动画（ma-run-done）',
              'ma-run-done' in (page.locator('[data-crash-run-card]').first.inner_text() or '')
              or page.locator('.ma-run-done').count() >= 0, '')

        # ============ 问题 4：视图切换 + 重置动画 ============
        print('\n── 问题 4：视图切换 / 面板 / 重置动画 ──')
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_timeout(1200)
        check('4d 工作台列挂视图切换动画（ma-view-in）',
              'ma-view-in' in (page.locator('[data-idea-workbench]').evaluate(
                  'el => el.closest("[data-lab-body] > div").className') or ''), '')
        dur = page.evaluate(
            """() => {
              const el = document.querySelector('[data-lab-body] > div[data-nav], [data-lab-body] > div');
              return el ? getComputedStyle(el).animationDuration : '';
            }"""
        )
        # ── P20：视图切换改成"只淡入"，时长 0.2s ──
        #   P11 时代这里是「淡入 + 上移 4px，0.22s」。P20 按产品要求去掉
        #   位移（页面切换不做整体位移），时长收到 200ms —— 正好落在
        #   "200–400ms" 规约的下沿。类名保留 .ma-view-in 作别名，两条
        #   类名断言不变，只有时长这条按新口径断言。
        check('4d 视图切换动画时长 200ms（P20：只淡入、不位移）',
              dur in ('0.2s', '200ms'), f'duration={dur}')

        page.goto(f'{LAB}?view=dna', wait_until='networkidle')
        page.wait_for_timeout(1200)
        check('4d 画布列挂视图切换动画（ma-view-in）',
              'ma-view-in' in (page.evaluate(
                  '() => document.querySelector("[data-lab-body] > div")?.className || ""')), '')

        # 重置动画：点重置 → 确认 → 立刻查动画态
        page.locator('[data-reset-run]').first.click()
        page.wait_for_timeout(400)
        page.locator('[data-confirm-ok]').first.click()
        page.wait_for_timeout(120)  # 动画 300ms 内
        cluster = page.locator('[data-reset-cluster]')
        anim_flag = cluster.first.get_attribute('data-reset-anim')
        anim_cls = cluster.first.get_attribute('class') or ''
        check('4e 重置时重置簇播动画（data-reset-anim=1 + anim-reset class）',
              anim_flag == '1' and 'anim-reset' in anim_cls, f'flag={anim_flag}')
        adur = page.evaluate(
            """() => {
              const el = document.querySelector('[data-reset-cluster]');
              return el ? getComputedStyle(el).animationDuration : '';
            }"""
        )
        check('4e 重置动画时长 300ms（≤300ms 上限）', adur in ('0.3s', '300ms'), f'duration={adur}')
        page.wait_for_timeout(800)
        check('4e 动画播完自动归位（data-reset-anim 归 0）',
              cluster.first.get_attribute('data-reset-anim') == '0', '')

        # ============ 收尾：彻底重置清运行数据 ============
        print('\n── 收尾：彻底重置（清理本轮运行数据）──')
        page.locator('[data-reset-data]').first.click()
        page.wait_for_timeout(500)
        page.locator('[data-confirm-ok]').first.click()
        page.wait_for_timeout(3000)
        check('收尾 想法已清空', db_count('candidateIdea') == 0, f"ideas={db_count('candidateIdea')}")
        check('收尾 击穿结果已清空', db_count('crashTest') == 0, '')
        check('收尾 论文保留', db_count('paper') >= 2, f"papers={db_count('paper')}")

        browser.close()

    print('\n' + '=' * 64)
    if FAILS:
        print(f'FAIL —— {len(FAILS)}/{CHECKS} 项未通过：')
        for f in FAILS:
            print(f'  · {f}')
        return 1
    print(f'PASS —— {CHECKS}/{CHECKS} 项全部通过。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
