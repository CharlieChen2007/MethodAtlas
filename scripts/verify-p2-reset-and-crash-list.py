#!/usr/bin/env python3
"""
verify-p2-reset-and-crash-list.py —— 验收「需求 A：重置按钮」+「需求 B：已生成想法搬到击穿测试」。

对应任务书的两组需求与验收标准：
  需求 A  新增「重置」按钮（一级/二级）+ 二次确认 + 运行态归零 + 基础数据不丢
  需求 B  「已生成想法」从组合想法移到击穿测试；先选想法再运行；未选置灰；空态引导

用法：
  python3 scripts/verify-p2-reset-and-crash-list.py

前置：3000 端口有 next dev/start 在跑；库里至少有一篇有结构（MethodBlock）的论文。

设计说明（为什么这么写）：
  · 前端面断言（DOM 属性/文案/禁用态）能覆盖的，全部用前端面断言 ——
    它们直接对应用户看到的东西。
  · 「重置后基础数据不丢」必须查库。界面看不出"论文还在不在"这件事的全貌，
    只有对比重置前后的 count 才有说服力。
  · 重置会**真的删数据**。所以本脚本在开始时先记录基线计数，结束时
    把结论打出来（不自动恢复数据）—— 使用者应当在一份可丢弃的库上跑。
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


def db_counts():
    js = (
        "const{PrismaClient}=require('@prisma/client');"
        "const p=new PrismaClient();"
        "(async()=>{const"
        " [papers,dnas,blocks,relations,debts,ideas,crashTests,surgeries]=await Promise.all(["
        "p.paper.count(),p.methodDNA.count(),p.methodBlock.count(),p.relation.count(),"
        "p.researchDebt.count(),p.candidateIdea.count(),p.crashTest.count(),p.surgery.count()]);"
        "console.log(JSON.stringify({papers,dnas,blocks,relations,debts,ideas,crashTests,surgeries}));"
        "await p.$disconnect()})();"
    )
    r = subprocess.run(['node', '-e', js], cwd=str(ROOT), capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f'db_counts 失败: {r.stderr[:300]}')
    return json.loads(r.stdout.strip().splitlines()[-1])


def main():
    print('=' * 64)
    print('需求 A（重置）+ 需求 B（想法列表搬家）验收')
    print('=' * 64)

    before = db_counts()
    print(f"[基线] {before}\n")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 950})
        page.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")

        # ============ 0. 生成至少 1 条想法（作为需求 B 的前置）============
        print('── 0. 前置：生成组合想法 ──')
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_selector('[data-idea-workbench]', timeout=20000)
        page.wait_for_timeout(1200)

        block_opts = page.locator('[data-block-option]')
        gen = page.locator('[data-generate-combo]')

        # ── 跨论文约束 ──
        # 工作台要求「必须来自 ≥2 篇不同论文」，而且每篇的第一个块往往是
        # PROBLEM 动机节点（不是可复用机制），拿它去组合会被模型判掉。
        # 所以：按 data-paper-group 分组，每组**跳过第 1 个**，取第 2 个，
        # 组成跨两篇论文的一对；若不成再依次换下标。
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
              // 每组可用下标（跳过第 0 个动机节点），最多试 4 个组合
              for (let k = 1; k < 5; k++) {
                const a = byGroup[groups[0]][k];
                const b = byGroup[groups[1]][k];
                if (a && b) out.push([a, b]);
              }
              return out;
            }"""
        )

        gen_ok = False
        for pair in pairs:
            # 先清掉上一轮的勾选
            for bid in pair:
                loc = page.locator(f'[data-block-option="{bid}"]')
                if loc.count() > 0:
                    loc.first.click()
                    page.wait_for_timeout(300)
            picked_n = page.locator('[data-block-option][data-picked="1"]').count()
            if picked_n < 2:
                continue
            if page.locator('[data-debt-option][data-picked="1"]').count() == 0:
                d = page.locator('[data-debt-option]')
                if d.count() > 0:
                    d.first.click()
                    page.wait_for_timeout(250)
            if gen.first.is_disabled():
                # 退回：取消这一对，继续下一组
                for bid in pair:
                    page.locator(f'[data-block-option="{bid}"]').first.click()
                    page.wait_for_timeout(200)
                continue
            gen.first.click()
            for _ in range(90):
                page.wait_for_timeout(1000)
                el = page.locator('[data-idea-count]').first
                if el.count() > 0 and int(el.get_attribute('data-idea-count') or '0') > 0:
                    gen_ok = True
                    break
                if _ >= 4 and _ % 3 == 0:
                    body = page.evaluate('() => document.body.innerText')
                    if ('没有找到值得组合' in body or '未通过关卡被拦下' in body
                            or '新方案未通过校验' in body):
                        break
            if gen_ok:
                break
            # 这一对没产出：取消后换下一对
            for bid in pair:
                page.locator(f'[data-block-option="{bid}"]').first.click()
                page.wait_for_timeout(200)
        check('前置：成功生成 ≥1 条组合想法', gen_ok, f'ideas={db_counts()["ideas"]}')
        if not gen_ok:
            print('\n前置不成立（本轮生成链路 0 候选），后续用例无法推进。')
            browser.close()
            return 2

        n_ideas = db_counts()['ideas']

        # ============ 需求 B ============
        print('\n── 需求 B：想法列表搬到击穿测试 ──')

        # B1 组合想法视图不再有「已生成的想法」列表
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_selector('[data-idea-workbench]', timeout=20000)
        page.wait_for_timeout(1000)
        wb_text = page.locator('[data-idea-workbench]').inner_text()
        check('B1 组合想法视图无「已生成的想法」列表',
              '已生成的想法' not in wb_text, '')
        check('B1 组合想法视图无想法卡片',
              page.locator('[data-idea-card]').count() == 0, '')
        # P13 问题 1 / P18 问题 2：第三列下方为「手动添加模块」输入对话框
        #（原「本次生成产出」概览压缩为附属行）
        check('B1/P13 第三列下方为「手动添加模块」输入对话框',
              '手动添加模块' in wb_text
              and page.locator('[data-custom-idea-form]').count() == 1, '')

        # B2（P16 问题二改写）：概览区的「去击穿测试选想法」按钮已删除，
        # 跳转出口 = 右栏工具栏的击穿测试视图按钮 + 生成反馈条的入口链接
        check('B2 概览区「去击穿测试」按钮已删除（P16 问题二）',
              page.locator('[data-goto-crashtest]').count() == 0, '')
        check('B2 右栏工具栏提供「击穿测试」视图入口',
              page.locator('[data-view="crashtest"]').count() > 0, '')

        # B6 生成的想法立即出现在击穿测试列表
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(1400)
        opts = page.locator('[data-crash-idea-option]')
        n_opts = opts.count()
        check('B6 击穿测试列表出现已生成的想法', n_opts >= 1, f'{n_opts} 个')
        check('B6 列表条数与库中想法数一致', n_opts == n_ideas, f'{n_opts} vs {n_ideas}')

        # B3 运行按钮初始置灰 + 提示
        run_btn = page.locator('[data-run-crash]').first
        check('B3 未选想法时运行按钮置灰', run_btn.is_disabled(), '')
        check('B4 未选想法时给出提示文案',
              '请先选择至少一个已生成想法' in page.locator('[data-crash-run-card]').inner_text(), '')

        # B3 选中想法 → 可运行；选中态写 URL
        opts.first.click()
        page.wait_for_timeout(500)
        check('B3 选中想法后运行按钮可用', not page.locator('[data-run-crash]').first.is_disabled(), '')
        check('B3 选中态写入 URL ?crashIdeaIds=', 'crashIdeaIds=' in page.url, page.url)

        # B3 运行击穿 → 结果绑定所选想法
        page.locator('[data-run-crash]').first.click()
        crashed = False
        for _ in range(45):
            page.wait_for_timeout(1000)
            if db_counts()['crashTests'] > 0:
                crashed = True
                break
        check('B3 运行击穿测试产出结果', crashed, f'crashTests={db_counts()["crashTests"]}')

        # B8 两视图往返不丢选中
        #     直接用一个真实存在的想法 id 构造 URL，验证 readUrl 能恢复选中。
        _an_idea = opts.first.get_attribute('data-crash-idea-option')
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_timeout(900)
        page.goto(f'{LAB}?view=crashtest&crashIdeaIds={_an_idea}', wait_until='networkidle')
        page.wait_for_timeout(1200)
        check('B8 带 ?crashIdeaIds 直连恢复选中（验收8）',
              page.locator('[data-crash-idea-option][data-picked="1"]').count() >= 1, '')
        # 切到 idea 再切回 crashtest（用导航，不是 goto），选中仍在
        page.locator('[data-view="idea"]').first.click()
        page.wait_for_timeout(1000)
        page.locator('[data-view="crashtest"]').first.click()
        page.wait_for_timeout(1200)
        check('B8 视图往返后选中不丢（验收8）',
              page.locator('[data-crash-idea-option][data-picked="1"]').count() >= 1, '')

        # B5 空态：无想法时引导先去组合想法
        #     用 URL 里塞一个不存在 id 不能模拟"无想法"，只能临时清库才能验；
        #     这里改为断言组件契约：data-crash-ideas-empty 在无想法时渲染。
        #     由于当前库里有想法，这一条用 DOM 存在性反向验证（有想法 → 无空态）。
        check('B5 有想法时不渲染空态（反向验证空态契约）',
              page.locator('[data-crash-ideas-empty]').count() == 0, '')

        # ============ 需求 A ============
        print('\n── 需求 A：重置按钮 ──')

        mid = db_counts()

        # A1 重置按钮在右栏工具栏内（P16 问题一：从画布右上角迁入）
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_timeout(1200)
        check('A1 右栏工具栏存在「重置」按钮',
              page.locator('[data-reset-run]').count() == 1, '')
        check('A1 右栏工具栏存在「彻底重置」按钮',
              page.locator('[data-reset-data]').count() == 1, '')

        # 先制造一些运行态：选中模块/债务 + 跑过标记
        page.locator('[data-block-option]').first.click()
        page.wait_for_timeout(400)
        ran_before = page.locator('[data-idea-count]').first.get_attribute('data-idea-count')

        # A3 点击重置 → 弹二次确认
        page.locator('[data-reset-run]').first.click()
        page.wait_for_timeout(500)
        check('A3 点击重置弹出二次确认框',
              page.locator('[data-confirm-dialog]').count() == 1, '')
        check('A3 确认框说明"基础数据保留"',
              '论文' in page.locator('[data-confirm-desc]').inner_text(), '')

        # A3 取消 → 不重置
        page.locator('[data-confirm-cancel]').first.click()
        page.wait_for_timeout(400)
        check('A3 取消后确认框关闭且未重置',
              page.locator('[data-confirm-dialog]').count() == 0
              and page.locator('[data-block-option][data-picked="1"]').count() >= 1, '')

        # A3 确认 → 运行态归零
        page.locator('[data-reset-run]').first.click()
        page.wait_for_timeout(400)
        page.locator('[data-confirm-ok]').first.click()
        page.wait_for_timeout(1200)
        check('A2 重置后已选模块归零',
              page.locator('[data-block-option][data-picked="1"]').count() == 0, '')
        check('A2 重置后已选债务归零',
              page.locator('[data-debt-option][data-picked="1"]').count() == 0, '')
        check('A4 重置后 URL 不再带 blockIds/ran',
              'blockIds=' not in page.url and 'ran=1' not in page.url, page.url)
        check('A4 重置后击穿选中归零',
              page.locator('[data-crash-idea-option][data-picked="1"]').count() == 0, '')

        # A2 已生成的想法本体不因一级重置而消失
        after_reset_run = db_counts()
        check('A2 一级重置不删除已生成的想法',
              after_reset_run['ideas'] == mid['ideas'],
              f'{after_reset_run["ideas"]} vs {mid["ideas"]}')

        # A3 二级重置（危险）→ 清库但保基础数据
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(1000)
        check('A2 一级重置后击穿测试列表仍能看到想法本体',
              page.locator('[data-crash-idea-option]').count() > 0, '')

        page.goto(f'{LAB}?view=dna', wait_until='networkidle')
        page.wait_for_timeout(1200)
        page.locator('[data-reset-data]').first.click()
        page.wait_for_timeout(500)
        check('A3 二级重置有二次确认',
              page.locator('[data-confirm-dialog][data-confirm-danger="1"]').count() == 1, '')
        page.locator('[data-confirm-ok]').first.click()
        page.wait_for_timeout(2500)

        after = db_counts()
        check('A2 二级重置清空想法', after['ideas'] == 0, f'ideas={after["ideas"]}')
        check('A2 二级重置清空击穿结果', after['crashTests'] == 0, f'ct={after["crashTests"]}')
        check('A2 二级重置保留了论文', after['papers'] == before['papers'],
              f'{after["papers"]} vs {before["papers"]}')
        check('A2 二级重置保留了 DNA', after['dnas'] == before['dnas'],
              f'{after["dnas"]} vs {before["dnas"]}')
        check('A2 二级重置保留了方法模块', after['blocks'] == before['blocks'],
              f'{after["blocks"]} vs {before["blocks"]}')
        check('A2 二级重置保留了演化关系', after['relations'] == before['relations'],
              f'{after["relations"]} vs {before["relations"]}')
        check('A2 二级重置保留了研究债务', after['debts'] == before['debts'],
              f'{after["debts"]} vs {before["debts"]}')

        # A2 重置后页面状态与首次进入一致
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(1400)
        check('A4 重置后击穿测试显示空态（引导去组合想法）',
              page.locator('[data-crash-ideas-empty]').count() == 1, '')
        check('A4 空态给出「去组合想法」出口',
              page.locator('[data-goto-idea]').count() == 1, '')

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
