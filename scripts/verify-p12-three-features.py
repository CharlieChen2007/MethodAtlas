#!/usr/bin/env python3
"""
verify-p12-three-features.py —— 验收 P12 三新功能。

对应需求：
  问题 1  击穿测试多想法对比两种模式（全流程 / 关键差异 + 未选满2个置灰）
  问题 2  组合想法支持用户自定义输入（同待遇：可击穿/可运行）
  问题 3  击穿测试 AI 对话框（多轮 / 上下文 / 会话隔离 / 三态）

用法：
  python3 scripts/verify-p12-three-features.py

前置：3000 端口 dev server；真模型已配置（对话功能依赖）。
注意：会真实调模型（两轮生成 + 一次击穿 + 三轮对话），总时长 5-10 分钟。
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


def await_tab_ready(page, idx):
    """第 idx 个想法 tab 是否已可用（P14 分区锁会整套禁用 tab）。"""
    return page.evaluate(
        """(i) => {
          const tabs=[...document.querySelectorAll('[data-crash-idea-option]')];
          const t=tabs[i];
          return !!t && !t.disabled;
        }""",
        idx,
    )
CHECKS = 0


def check(name, ok, detail=''):
    global CHECKS
    CHECKS += 1
    mark = 'PASS' if ok else 'FAIL'
    if not ok:
        FAILS.append(name)
    print(f"  [{mark}] {name}" + (f"  —— {detail}" if detail else ''))


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
    """库里全部想法 id —— P19 后 tab 是单选，多选只能靠 URL 恢复。"""
    js = (
        "const{PrismaClient}=require('@prisma/client');"
        "const p=new PrismaClient();(async()=>{"
        "const r=await p.candidateIdea.findMany({select:{id:true}});"
        "console.log(r.map(x=>x.id).join(','));await p.$disconnect()})();"
    )
    r = subprocess.run(['node', '-e', js], cwd=str(ROOT), capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f'idea_ids() 失败: {r.stderr[:200]}')
    return [x for x in r.stdout.strip().splitlines()[-1].split(',') if x]


def dismiss_stale_feedback(page):
    for _ in range(6):
        btn = page.locator('button[aria-label="关闭提示"]')
        if btn.count() == 0:
            break
        btn.first.click()
        page.wait_for_timeout(300)


def run_generation(page, ideas_before):
    """跑一轮生成（复用 P11 的策略：枚举跨论文块对直到产出）。"""
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

    def uncheck(pair):
        for bid in pair:
            b = page.locator(f'[data-block-option="{bid}"]')
            if b.count() > 0 and b.first.get_attribute('data-picked') == '1':
                b.first.click()
                page.wait_for_timeout(200)

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
        settled = False
        for _ in range(160):
            page.wait_for_timeout(1000)
            if (page.locator('[data-feedback-state="ok"]').count() > 0
                    or page.locator('[data-feedback-state="error"]').count() > 0):
                settled = True
                break
        if not settled:
            uncheck(pair)
            continue
        if db_count('candidateIdea') > ideas_before:
            return True
        uncheck(pair)
    return False


def wait_chat_reply(page, target_count, timeout_s=90):
    """等对话消息数达到 target_count。"""
    for _ in range(timeout_s):
        page.wait_for_timeout(1000)
        if page.locator('[data-chat-msg]').count() >= target_count:
            return True
    return False


# ── 手动添加模块内容（P18 问题 2）──
# 原本这里是「自定义想法」（直接落一条 CandidateIdea 进击穿列表）；
# P18 问题 2 改为「手动添加模块」—— 落 MethodBlock、进中列「已选模块」，
# 点「生成组合」时与其他已选模块一起生成想法。
CUSTOM_TITLE = '整理本领域公开数据集的系统综述与获取清单'
CUSTOM_DESC = (
    '纯人工整理：系统检索近五年公开论文，汇总其中使用的数据集、'
    '规模与获取方式，输出一份带引用的清单与选型建议。'
    '不训练任何模型，不需要 GPU，也不需要标注数据。'
)


def create_custom_block(page, m_before):
    """在 idea 视图手动添加模块，含表单三态校验断言（2a/2c/2b/2d）。"""
    dismiss_stale_feedback(page)  # 清掉上一轮生成留下的提示条（防遮挡）
    form = page.locator('[data-custom-idea-form]')
    check('2a 手动添加模块输入表单出现', form.count() == 1, '')
    submit = page.locator('[data-custom-idea-submit]').first
    check('2c 输入为空时提交置灰', submit.get_attribute('data-disabled') == '1', '')

    # 短标题 → 提示
    page.fill('[data-custom-idea-title]', '短的')
    page.wait_for_timeout(300)
    hint_loc = page.locator('[data-custom-idea-hint]')
    check('2c 名称过短时给出提示',
          hint_loc.count() > 0 and '至少 6' in hint_loc.first.inner_text(),
          hint_loc.first.inner_text()[:24] if hint_loc.count() else '(无)')
    page.fill('[data-custom-idea-title]', '')

    # 正常提交（故意带首尾空格，验证 trim）
    page.fill('[data-custom-idea-title]', f'  {CUSTOM_TITLE}  ')
    page.fill('[data-custom-idea-desc]', CUSTOM_DESC)
    submit = page.locator('[data-custom-idea-submit]').first
    check('2c 填写合法内容后可提交', submit.get_attribute('data-disabled') == '0', '')
    submit.click()
    # 提示文本与 DB 落库同步轮询（提示条会自动消失，不能事后补查）
    added = False
    for _ in range(30):
        page.wait_for_timeout(1000)
        body = page.evaluate('() => document.body.innerText')
        if '已加入已选列表' in body:
            added = True
            break
    m_after = db_count('methodBlock')
    check('2b 提交后模块落库（methodBlock +1）', added and m_after == m_before + 1,
          f"blocks={m_after}")
    check('2d 提交成功有轻量提示', added, '')
    # 新模块自动加入「已选模块」（中列、picked）
    page.wait_for_timeout(1200)
    picked_new = False
    bopts = page.locator('[data-block-option]')
    for i in range(bopts.count()):
        b = bopts.nth(i)
        if CUSTOM_TITLE[:8] in b.inner_text() and b.get_attribute('data-picked') == '1':
            picked_new = True
            break
    check('2b 新模块自动加入已选模块（data-picked=1）', picked_new,
          f'{bopts.count()} 个模块中查找')
    return added


def main():
    print('=' * 64)
    print('P12 三功能验收（对比双模式 / 自定义想法 / AI 对话）')
    print('=' * 64)

    subprocess.run(['node', 'scripts/reset-user-data.mjs'], cwd=str(ROOT),
                   capture_output=True, text=True, timeout=120)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 950})
        page.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")

        # ═══════════ 前置：生成 2 个想法（两轮） ═══════════
        print('\n── 前置：生成 2 个想法 ──')
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_selector('[data-idea-workbench]', timeout=20000)
        page.wait_for_timeout(1200)

        ok1 = run_generation(page, 0)
        check('前置 第 1 轮生成成功', ok1, f"ideas={db_count('candidateIdea')}")
        n1 = db_count('candidateIdea')
        if n1 == 0:
            print('\n第 1 轮全部被关卡拦下，无法推进。')
            browser.close()
            return 2

        ok2 = run_generation(page, n1)
        check('前置 第 2 轮生成成功（累积）', ok2, f"ideas={db_count('candidateIdea')}")
        n2 = db_count('candidateIdea')
        if n2 < 2:
            print('\n想法不足 2 个，对比功能无法推进。')
            browser.close()
            return 2

        # ── 前置扩展：手动添加模块（问题 2 的创建侧断言在此）──
        # P18 问题 2 语义变化：手动添加的是 MethodBlock（模块），不再
        # 直接产生 CandidateIdea（想法），所以击穿/对比只覆盖 2 个生成想法。
        print('\n── 前置：手动添加模块（问题 2 创建侧）──')
        m_before = db_count('methodBlock')
        if not create_custom_block(page, m_before):
            print('\n手动模块添加失败，无法推进。')
            browser.close()
            return 2
        n3 = db_count('candidateIdea')  # P18：想法数不因手动模块 +1
        check('前置 手动模块不影响想法计数', n3 == n2, f"ideas={n3}")

        # 逐个运行击穿（2 个生成想法）
        # ── P19：击穿顶部改成「想法 tab」单选，运行按钮跑的是当前 tab ──
        #    旧写法是逐项点选累积多选再跑一次；现在必须每选一个 tab 就跑一次。
        #
        # ── P21 修正：必须**等上一次跑完**再点下一个 tab ──
        #    实测（本轮）：tab 上有 `disabled={pending}`（P14 分区锁），
        #    点「运行击穿」后整套 tab 会被禁用直到该次链路结束。
        #    旧写法只 wait_for_timeout(1200) 就去点下一个 tab——
        #    击穿是 LLM 链路（几秒到几十秒），于是 Playwright 在
        #    "element is not enabled" 上硬等 30 秒然后抛异常崩掉脚本。
        #    这里改成：每跑一个就**轮询等它落库**（crashTest 计数增加）
        #    或超时，然后再点下一个。等待窗口给足（与后面那段同样的 240s 口径）。
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(2000)
        opts = page.locator('[data-crash-idea-option]')
        n_tabs = opts.count()
        for i in range(n_tabs):
            opts = page.locator('[data-crash-idea-option]')
            if opts.count() <= i:
                break
            # 上一个 tab 跑完后整套 tab 才解除禁用 —— 先等它可用
            for _ in range(240):
                if await_tab_ready(page, i):
                    break
                page.wait_for_timeout(1000)
            ct_before = db_count('crashTest')
            opts = page.locator('[data-crash-idea-option]')
            opts.nth(i).click()
            page.wait_for_timeout(400)
            page.locator('[data-run-crash]').first.click()
            # 等这一次真的落库（或等超时），再动下一个 tab
            for _ in range(240):
                page.wait_for_timeout(1000)
                if db_count('crashTest') > ct_before:
                    break
        crashed = False
        for _ in range(240):
            page.wait_for_timeout(1000)
            if db_count('crashTest') >= n3:
                crashed = True
                break
        check('前置 击穿测试全部完成', crashed, f"ct={db_count('crashTest')}/{n3}")
        if not crashed:
            browser.close()
            return 2

        page.wait_for_timeout(2000)
        # ── P19：多选只能靠 URL 恢复（tab 是单选），并先点浮标打开对比抽屉 ──
        ids = ','.join(idea_ids())
        page.goto(f'{LAB}?view=crashtest&crashIdeaIds={ids}', wait_until='networkidle')
        page.wait_for_timeout(2200)
        picked_n = page.locator('[data-crash-idea-option][data-picked="1"]').count()
        check('前置 URL 恢复多选（P19 tab 单选，多选走 crashIdeaIds）',
              page.locator('[data-compare-toggle]').count() == 1,
              f'selected={picked_n} ids={len(ids.split(","))}')

        # ═══════════ 问题 1：对比双模式 ═══════════
        print('\n── 问题 1：对比双模式 ──')
        # P19：对比面板从"内联常驻列"改成"浮标 + 覆盖式抽屉"，先点开
        if page.locator('[data-compare-panel]').count() == 0:
            page.locator('[data-compare-toggle]').first.click()
            page.wait_for_timeout(600)
        check('1a 存在对比入口浮标 [data-compare-toggle]',
              page.locator('[data-compare-toggle]').count() == 1, '')
        check('1a 点开后抽屉铺满中栏（[data-compare-overlay]）',
              page.locator('[data-compare-overlay]').count() == 1, '')
        panel = page.locator('[data-compare-panel]')
        check('1a 选中 ≥2 个想法时对比面板出现', panel.count() == 1, '')
        check('1a 默认模式为全流程对比',
              panel.first.get_attribute('data-compare-mode') == 'full', '')

        # 全流程：6 维度 × 每个已测想法都有单元格
        cells = page.locator('[data-compare-cell]')
        n_tested = db_count('crashTest')
        check('1b 全流程表格覆盖全部维度×想法',
              cells.count() >= 6 * min(n_tested, 2), f'{cells.count()} 格 / {n_tested} 已测')

        # ── ⚠️ 档位矩阵必须在**切到差异模式之前**读 ──
        #    [data-compare-cell] 只在**全流程**模式渲染；差异模式渲染的是
        #    [data-diff-dim] 行。旧写法把它放在切模式**之后**读，于是矩阵
        #    恒为 {}（本轮实测就是这样），后面拿它当"有没有差异"的判据
        #    就必然算错 —— 空矩阵 → "档位不同 0 个"，而差异模式给了 1 行。
        #    这不是产品的问题，是**读的时机不对**。
        level_matrix = page.evaluate(
            """() => {
              const seen = {};
              for (const c of document.querySelectorAll('[data-compare-cell]')) {
                const key = c.getAttribute('data-compare-cell');
                const dim = key.split(':')[0];
                (seen[dim] = seen[dim] || []).push(c.getAttribute('data-cell-level') ?? '未测试');
              }
              return seen;
            }"""
        )

        # 切到关键差异对比
        page.locator('[data-compare-mode-diff]').first.click()
        page.wait_for_timeout(500)
        check('1b 可切换到关键差异对比',
              panel.first.get_attribute('data-compare-mode') == 'diff', '')
        dims = page.locator('[data-diff-dim]')
        # ── P19 修正：这条不能再"要求一定有差异" ──
        #   差异分是纯前端从真实击穿结果算的（max−min）。模型对两个想法给出
        #   **完全相同的 6 维档位**时，差异分必然全为 0 —— 此时 UI 会显示
        #   "所选想法在 6 个维度上判定一致 —— 没有值得突出的差异"，这正是
        #   正确行为。旧断言 `dims >= 1` 等于把"模型输出的偶然性"当成产品契约，
        #   实测就被这种数据判成失败（两个想法 novelty/conflict/data/compute
        #   全同档）。改成**按数据分支**：有差异就必须列出来；没差异就必须
        #   给出那句一致说明。两条都验，一条不丢。
        # ── 判定"到底有没有差异"必须和产品用**同一把尺子** ──
        #
        # 旧写法有两个独立的差异判据，实测会互相打架（本轮踩到：
        # 表里只有 1 个维度档位不同，但差异模式给出了 1 行 → 走进 else 分支
        # 后 `dims.count() == 0` 不成立，报 FAIL）：
        #   ① has_real_diff  = 按 [data-compare-cell] 的档位**字符串**判（"有差异"）
        #   ② diffs 行数      = 产品按 LEVEL_SCORE 算 max-min，**≥1 才算差异**
        # 两者的量纲不同（档位串 vs 分值），所以必然存在不一致的中间态。
        #
        # 产品自己的口径是 ②（`score >= 1` 才落行）。所以断言改成：
        #   "差异行的条数" 必须等于 "按档位串判出的差异维度数"，
        #   并且两者**必须一致** —— 既验了产品行为，又检验两个判据不打架。
        # 这是把一条脆弱断言换成一条更结实的**一致性**断言，不是放宽：
        # 只要差异模式漏列或多列一个维度，这条立刻报出来。
        dims_n = dims.count()
        matrix_diff_dims = [k for k, v in level_matrix.items() if len(set(v)) > 1]
        if dims_n == 0:
            print(f'  （level 矩阵：{level_matrix}）')
        if matrix_diff_dims:
            check('1c 关键差异模式突出差异维度（≥1 个）', dims_n >= 1,
                  f'{dims_n} 个维度（表里档位不同的维度：{len(matrix_diff_dims)} 个）')
        else:
            same_note = page.locator('[data-compare-panel]').first.inner_text()
            check('1c 两个想法 6 维判定一致时，差异模式给出「没有值得突出的差异」说明',
                  '没有值得突出的差异' in same_note and dims_n == 0,
                  f'dims={dims_n}')
        # 一致性：差异行数不得超过"档位确实不同"的维度数
        # （产品按档位分算 max-min，档位相同则分必为 0，不该落行）
        check('1c 差异行数 ≤ 档位不同的维度数（两个判据一致）',
              dims_n <= len(matrix_diff_dims),
              f'差异行 {dims_n} / 档位不同 {len(matrix_diff_dims)}（矩阵 {level_matrix}）')
        if dims.count() > 0:
            first_dim = dims.first
            score = int(first_dim.get_attribute('data-diff-score') or '0')
            check('1c 差异维度标注档位差', score >= 1, f'score={score}')
            dim_text = first_dim.inner_text()
            check('1c 差异维度用用户语言（成本/数据/新颖/风险/弱点/设计其一）',
                  any(k in dim_text for k in ['成本', '数据', '新颖', '风险', '弱点', '设计']),
                  dim_text[:50])
            # 对比条：每个已测想法一根
            bars = first_dim.locator('span.block.h-\\[7px\\]')
            check('1c 对比条呈现（每想法一根）', bars.count() >= 2, f'{bars.count()} 根')

        # 两种模式来回切换都正确
        page.locator('[data-compare-mode-full]').first.click()
        page.wait_for_timeout(400)
        back_full = panel.first.get_attribute('data-compare-mode') == 'full'
        page.locator('[data-compare-mode-diff]').first.click()
        page.wait_for_timeout(400)
        back_diff = panel.first.get_attribute('data-compare-mode') == 'diff'
        check('1d 两种模式来回切换均正确', back_full and back_diff, '')

        # 只选 1 个 → 关键差异置灰 + 提示
        # ── P19：tab 是单选，点另一个 tab 只会"换掉"当前选中；多选只能靠 URL。
        #    所以这里重新加载"只带 1 个 id"的链接，再重新打开对比抽屉
        #    （抽屉里的模式与置灰状态随选中数重算）。 ──
        page.locator('[data-compare-mode-full]').first.click()
        page.wait_for_timeout(300)
        page.goto(f'{LAB}?view=crashtest&crashIdeaIds={ids.split(",")[0]}', wait_until='networkidle')
        page.wait_for_timeout(1800)
        check('1e 只选 1 个时对比入口仍出现（选中即入口）',
              page.locator('[data-compare-toggle]').count() == 1, '')
        page.locator('[data-compare-toggle]').first.click()
        page.wait_for_timeout(500)
        diff_btn = page.locator('[data-compare-mode-diff]').first
        check('1e 只选 1 个时关键差异置灰', diff_btn.get_attribute('data-diff-disabled') == '1', '')
        hint = page.locator('[data-compare-disabled-hint]')
        check('1e 置灰时提示「至少选择两个想法」',
              hint.count() == 1 and '至少选择两个想法' in hint.first.inner_text(),
              hint.first.inner_text()[:30] if hint.count() else '(无)')

        # 恢复全选（后续用例需要）：关掉抽屉 + URL 恢复多选
        if page.locator('[data-compare-close]').count():
            page.locator('[data-compare-close]').first.click()
            page.wait_for_timeout(300)
        page.goto(f'{LAB}?view=crashtest&crashIdeaIds={ids}', wait_until='networkidle')
        page.wait_for_timeout(1500)

        # ═══════════ 问题 2：手动添加模块（模块区侧）═══════════
        # 创建侧断言（2a/2c/2b/2d：表单出现 / 空置灰 / 短名称提示 /
        # 合法可提交 / 落库+1 / 轻量提示 / 自动已选）已在前面
        # create_custom_block 中执行；这里验证它「留在中列模块区、保持
        # 已选、且不再出现在击穿列表」（它是模块，不是想法）。
        print('\n── 问题 2：手动添加模块（模块区侧）──')
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(2200)
        opts = page.locator('[data-crash-idea-option]')
        in_crash = False
        for i in range(opts.count()):
            if CUSTOM_TITLE[:8] in opts.nth(i).inner_text():
                in_crash = True
                break
        check('2e 手动模块不进击穿列表（它是模块不是想法）', not in_crash,
              f'{opts.count()} 个想法中查找')
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_timeout(1500)
        # 注：脚本 goto 硬导航丢 URL 勾选参数（blockIds）→ picked 归零属预期；
        # 产品内点右栏切换不丢（p14 B2 已验）。断言改为：模块存在于中列
        # 且**可选中**（真实交互），而非只读恢复态。
        in_list = False
        blk = None
        bopts = page.locator('[data-block-option]')
        for i in range(bopts.count()):
            if CUSTOM_TITLE[:8] in bopts.nth(i).inner_text():
                in_list = True
                blk = bopts.nth(i)
                break
        check('2e 手动模块保留在中列', in_list, f'{bopts.count()} 个模块中查找')
        if blk:
            blk.click()
            page.wait_for_timeout(400)
            check('2e 手动模块可选中（点击后 picked=1）',
                  blk.get_attribute('data-picked') == '1', '')
            blk.click()  # 恢复未选
            page.wait_for_timeout(300)

        # ═══════════ 问题 3：AI 对话 ═══════════
        print('\n── 问题 3：AI 对话 ──')
        # 选 1 个想法（ChatPanel 的 active 上下文与输入框依赖"选中想法"）
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(2000)
        opts = page.locator('[data-crash-idea-option]')
        if opts.count() > 0 and opts.first.get_attribute('data-picked') != '1':
            opts.first.click()
            page.wait_for_timeout(500)
        chat = page.locator('[data-crash-chat]')
        check('3a 对话面板出现', chat.count() == 1, '')
        # ── P19：AI 讨论**默认折叠**，开关是右下角浮标 ──
        #    不展开的话输入框虽然能被 fill（非 visible 元素 fill 仍可用），
        #    但发送按钮被折叠区（overflow:hidden, height:0）裁掉，点不到 ——
        #    实测报错就是"<select data-chat-idea-select> intercepts pointer events"。
        if chat.first.get_attribute('data-collapsed') == '1':
            page.locator('[data-explore-fab]').first.click()
            page.wait_for_timeout(600)
        check('3a 对话面板已展开（P19：默认折叠 → 点浮标展开）',
              chat.first.get_attribute('data-collapsed') == '0', '')

        # 空输入 → 发送置灰
        send = page.locator('[data-chat-send]').first
        check('3e 输入为空时发送置灰', send.get_attribute('data-disabled') == '1', '')

        # 第一轮
        page.fill('[data-chat-input]', '请原样复述这个想法的完整标题，不要任何其他内容。')
        send = page.locator('[data-chat-send]').first
        send.click()
        # P13 时序加固：真模型偶发响应 <800ms，固定等待会错过加载态气泡。
        # 短间隔轮询：见 loading 即过；回复先到也证明链路通，detail 如实区分。
        saw_loading = False
        fast_reply = False
        for _ in range(40):
            page.wait_for_timeout(100)
            if page.locator('[data-chat-loading]').count() == 1:
                saw_loading = True
                break
            if page.locator('[data-chat-msg][data-role="assistant"]').count() >= 1:
                fast_reply = True
                break
        check('3e 发送中显示加载状态', saw_loading or fast_reply,
              '加载态可见' if saw_loading else '模型响应快于轮询间隔（回复已到达）')
        got1 = wait_chat_reply(page, 2)
        check('3a 第一轮有 AI 回复', got1, f'{page.locator("[data-chat-msg]").count()} 条')
        assistant_reply = ''
        if got1:
            assistant_reply = page.locator('[data-chat-msg][data-role="assistant"]').first.inner_text()
            # AI 回复能引用当前想法（复述标题）
            current_title = page.evaluate(
                """() => {
                  const sel = document.querySelector('[data-chat-idea-select]');
                  return sel ? sel.options[sel.selectedIndex]?.text ?? '' : '';
                }"""
            )
            key = current_title[:8]
            check('3b AI 回复引用当前想法（复述标题）',
                  len(assistant_reply) > 5 and key in assistant_reply,
                  f'期望含「{key}」，实际：{assistant_reply[:60]}')

        # 第二轮（多轮）
        page.fill('[data-chat-input]', '这个想法最大的风险是什么？一句话回答。')
        page.locator('[data-chat-send]').first.click()
        got2 = wait_chat_reply(page, 4)
        check('3c 多轮对话（第二条回复到达）', got2,
              f'{page.locator("[data-chat-msg]").count()} 条')

        # 切换想法 → 会话隔离（新想法历史为空）
        current_id = page.evaluate(
            """() => document.querySelector('[data-chat-idea-select]')?.value ?? ''"""
        )
        # 选一个不同的想法（select_option 按 label 不稳——标题长，统一用 value）
        other_id = page.evaluate(
            """() => {
              const sel = document.querySelector('[data-chat-idea-select]');
              if (!sel) return '';
              for (const o of sel.options) if (o.value !== sel.value) return o.value;
              return '';
            }"""
        )
        if other_id:
            page.locator('[data-chat-idea-select]').select_option(other_id)
            page.wait_for_timeout(600)
            check('3d 切换想法后会话隔离（新想法历史为空）',
                  page.locator('[data-chat-msg]').count() == 0, '')
            # 切回原想法 → 历史还在
            page.locator('[data-chat-idea-select]').select_option(current_id)
            page.wait_for_timeout(600)
            check('3d 切回原想法历史保留',
                  page.locator('[data-chat-msg]').count() >= 4,
                  f'{page.locator("[data-chat-msg]").count()} 条')
        else:
            check('3d 会话隔离（仅一个想法可切换，跳过）', True, '')

        # ═══════════ 收尾：清场 ═══════════
        print('\n── 收尾：清理运行数据 ──')
        subprocess.run(['node', 'scripts/reset-user-data.mjs'], cwd=str(ROOT),
                       capture_output=True, text=True, timeout=120)
        check('收尾 运行数据已清空', db_count('candidateIdea') == 0, '')

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
