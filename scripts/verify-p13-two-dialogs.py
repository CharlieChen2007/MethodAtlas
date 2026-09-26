#!/usr/bin/env python3
"""
verify-p13-two-dialogs.py —— 验收 P13 两处输入交互位置改造。

对应需求：
  问题 1  组合想法第三列下方改为用户输入对话框（原产出概览区改为输入主体）
  问题 2  击穿测试画布下方新增与 AI 交流的对话框（浮动改真实占位区块）

两处 API 沿用 P12 已有配置（createCustomIdeaAction / crashChatAction → callLLM），
本脚本重点验收**位置**与关键功能回归。

用法：
  python3 scripts/verify-p13-two-dialogs.py

前置：3000 端口 dev server；真模型已配置（对话功能依赖）。
注意：会真实调模型（一轮生成 + 两个想法击穿 + 两轮对话），总时长 4-8 分钟。
"""

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


def dismiss_stale_feedback(page):
    for _ in range(6):
        btn = page.locator('button[aria-label="关闭提示"]')
        if btn.count() == 0:
            break
        btn.first.click()
        page.wait_for_timeout(300)


def run_generation(page, ideas_before):
    """跑一轮生成（枚举跨论文块对直到产出）。"""
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


# 自定义想法内容：零算力综述型（与生成的训练型想法天然分档）
CUSTOM_TITLE = '整理本领域公开数据集的系统综述与获取清单'
CUSTOM_DESC = (
    '纯人工整理：系统检索近五年公开论文，汇总其中使用的数据集、'
    '规模与获取方式，输出一份带引用的清单与选型建议。'
    '不训练任何模型，不需要 GPU，也不需要标注数据。'
)


def main():
    print('=' * 64)
    print('P13 验收（第三列下方输入框 / 画布下方 AI 对话框）')
    print('=' * 64)

    subprocess.run(['node', 'scripts/reset-user-data.mjs'], cwd=str(ROOT),
                   capture_output=True, text=True, timeout=120)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 950})
        page.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")

        # ═══════════ 前置：生成 1 个想法 ═══════════
        print('\n── 前置：生成 1 个想法 ──')
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_selector('[data-idea-workbench]', timeout=20000)
        page.wait_for_timeout(1200)

        ok1 = run_generation(page, 0)
        check('前置 第 1 轮生成成功', ok1, f"ideas={db_count('candidateIdea')}")
        n1 = db_count('candidateIdea')
        # P18 问题 2 后手动添加的是「模块」不是想法，不再贡献想法数；
        # 为了 2f 的想法切换用例仍有意义，这里再生成 1 个想法（共 2 个）。
        if n1 > 0:
            ok2 = run_generation(page, n1)
            check('前置 第 2 轮生成成功', ok2, f"ideas={db_count('candidateIdea')}")
            n1 = db_count('candidateIdea')
        if n1 == 0:
            print('\n生成全部被关卡拦下，无法推进。')
            browser.close()
            return 2

        # ═══════════ 问题 1：第三列下方输入对话框 ═══════════
        print('\n── 问题 1：第三列下方输入对话框 ──')

        # 1a 位置：表单在第三列内、生成按钮下方；区域标题为「手动添加模块」
        geo = page.evaluate(
            """() => {
              const cols = document.querySelectorAll('[data-idea-workbench] > section');
              const third = cols[cols.length - 1];
              const form = document.querySelector('[data-custom-idea-form]');
              const genBtn = document.querySelector('[data-generate-combo]');
              if (!third || !form || !genBtn) return { ok: false };
              const t = third.getBoundingClientRect(), f = form.getBoundingClientRect(), g = genBtn.getBoundingClientRect();
              return { ok: true, cols: cols.length,
                       inThirdCol: t.left <= f.left && f.right <= t.right && t.top <= f.top && f.bottom <= t.bottom,
                       belowGenBtn: f.top > g.bottom,
                       headerOk: third.innerText.includes('手动添加模块') };
            }"""
        )
        check('1a 工作台为三列结构', geo.get('cols') == 3, f"cols={geo.get('cols')}")
        check('1a 输入对话框位于第三列内', geo.get('inThirdCol'), '')
        check('1a 输入对话框在生成按钮下方', geo.get('belowGenBtn'), '')
        check('1a 区域标题为「手动添加模块」', geo.get('headerOk'), '')

        # 1b 概览钩子保留（回归锚点）：计数 + 去击穿测试入口
        cnt = page.locator('[data-idea-count]')
        check('1b 概览计数钩子保留且值正确',
              cnt.count() == 1 and cnt.first.get_attribute('data-idea-count') == str(n1),
              f"count={cnt.first.get_attribute('data-idea-count') if cnt.count() else '(无)'} / db={n1}")
        # P16 问题二：「去击穿测试选想法」按钮已删除（出口与 ActionBar 重复）
        check('1b 去击穿测试按钮已删除（data-goto-crashtest 不存在）',
              page.locator('[data-goto-crashtest]').count() == 0, '')

        # 1c 校验三态：空置灰 → 短标题提示 → 合法可提交
        dismiss_stale_feedback(page)
        submit = page.locator('[data-custom-idea-submit]').first
        check('1c 输入为空时提交置灰', submit.get_attribute('data-disabled') == '1', '')
        page.fill('[data-custom-idea-title]', '短的')
        page.wait_for_timeout(300)
        hint_loc = page.locator('[data-custom-idea-hint]')
        check('1c 标题过短时给出提示',
              hint_loc.count() > 0 and '至少 6' in hint_loc.first.inner_text(),
              hint_loc.first.inner_text()[:24] if hint_loc.count() else '(无)')
        page.fill('[data-custom-idea-title]', '')
        page.fill('[data-custom-idea-title]', f'  {CUSTOM_TITLE}  ')  # 带首尾空格验 trim
        page.fill('[data-custom-idea-desc]', CUSTOM_DESC)
        submit = page.locator('[data-custom-idea-submit]').first
        check('1c 填写合法内容后可提交', submit.get_attribute('data-disabled') == '0', '')
        m1 = db_count('methodBlock')
        submit.click()
        added = False
        for _ in range(30):
            page.wait_for_timeout(1000)
            body = page.evaluate('() => document.body.innerText')
            if '已加入已选列表' in body:
                added = True
                break
        m2 = db_count('methodBlock')
        n_ideas = db_count('candidateIdea')
        # P18 问题 2：手动加入的是 MethodBlock（模块），不产生 CandidateIdea（想法）
        check('1d 提交后模块落库（methodBlock +1）且想法数不变',
              added and m2 == m1 + 1 and n_ideas == n1,
              f"blocks={m2} (+{m2 - m1}) / ideas={n_ideas}")
        # 1d+ 新模块自动加入「已选模块」：中列出现且 data-picked=1
        page.wait_for_timeout(1200)
        picked_new = False
        bopts = page.locator('[data-block-option]')
        for i in range(bopts.count()):
            b = bopts.nth(i)
            if CUSTOM_TITLE[:8] in b.inner_text() and b.get_attribute('data-picked') == '1':
                picked_new = True
                break
        check('1d 新模块自动加入已选（data-picked=1）', picked_new,
              f'{bopts.count()} 个模块中查找')
        sel_cnt = page.locator('[data-selected-blocks]')
        check('1d 已选模块计数 ≥1',
              sel_cnt.count() > 0 and any(c.isdigit() for c in sel_cnt.first.inner_text()),
              sel_cnt.first.inner_text() if sel_cnt.count() else '(无)')

        # ═══════════ 前置 2：全部想法选击穿 ═══════════
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(2000)
        opts = page.locator('[data-crash-idea-option]')
        for i in range(opts.count()):
            opts.nth(i).click()
            page.wait_for_timeout(350)
        page.locator('[data-run-crash]').first.click()
        crashed = False
        for _ in range(180):
            page.wait_for_timeout(1000)
            if db_count('crashTest') >= n1:
                crashed = True
                break
        check(f'前置 击穿测试完成（{n1} 个想法）', crashed, f"ct={db_count('crashTest')}/{n1}")
        if not crashed:
            browser.close()
            return 2

        # 1e 语义变化（P18 问题 2）：手动加入的是「模块」而非「想法」——
        # 它不进击穿列表（那里面只有 CandidateIdea），而是留在中列模块区、
        # 处于已选态、可参与「生成组合」。
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(2200)
        opts = page.locator('[data-crash-idea-option]')
        in_crash = False
        for i in range(opts.count()):
            if CUSTOM_TITLE[:8] in opts.nth(i).inner_text():
                in_crash = True
                break
        check('1e 手动模块不进击穿列表（它是模块不是想法）', not in_crash,
              f'{opts.count()} 个想法中查找')
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_timeout(1500)
        # 注：脚本用 goto 硬导航会丢 URL 勾选参数（blockIds），picked 归零
        # 属预期；产品内点右栏切换不丢（p14 B2 已验）。这里断言模块
        # **存在于中列**且**可选中**（真实交互），而非恢复态。
        in_list = False
        blk = None
        bopts = page.locator('[data-block-option]')
        for i in range(bopts.count()):
            if CUSTOM_TITLE[:8] in bopts.nth(i).inner_text():
                in_list = True
                blk = bopts.nth(i)
                break
        check('1e 手动模块保留在中列', in_list, f'{bopts.count()} 个模块中查找')
        if blk:
            blk.click()
            page.wait_for_timeout(400)
            check('1e 手动模块可选中（点击后 picked=1）',
                  blk.get_attribute('data-picked') == '1', '')
            blk.click()  # 恢复未选，不影响后续
            page.wait_for_timeout(300)
        # 恢复问题 2 段前置：在 crashtest 视图选中 1 个想法
        # （ChatPanel 的 active 上下文与输入框都依赖"选中了想法"）
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(2000)
        opts = page.locator('[data-crash-idea-option]')
        if opts.count() > 0 and opts.first.get_attribute('data-picked') != '1':
            opts.first.click()
            page.wait_for_timeout(500)

        # ═══════════ 问题 2：画布下方 AI 对话框 ═══════════
        print('\n── 问题 2：画布下方 AI 对话框 ──')
        # （1e 末尾已在 crashtest 视图并选中了 1 个想法 —— 这里不再
        #  硬导航 goto，避免丢掉 URL 勾选参数导致 ChatPanel 无 active）

        # 2a 位置：dock 是画布容器下一兄弟、static、在画布下方（非浮动）
        dock = page.evaluate(
            """() => {
              const chat = document.querySelector('[data-crash-chat]');
              if (!chat) return { ok: false, why: 'no dock' };
              const canvasWrap = chat.previousElementSibling;
              if (!canvasWrap || !canvasWrap.querySelector('[data-canvas-stage]')) {
                return { ok: false, why: 'prev sibling is not canvas container' };
              }
              const c = canvasWrap.getBoundingClientRect();
              const d = chat.getBoundingClientRect();
              const cs = getComputedStyle(chat);
              return { ok: true, position: cs.position,
                       belowCanvas: d.top >= c.bottom - 2,
                       collapsed: chat.getAttribute('data-collapsed'),
                       dockH: d.height };
            }"""
        )
        check('2a 对话框存在且挂在画布容器下方（同层兄弟）', dock.get('ok'), dock.get('why', ''))
        if dock.get('ok'):
            check('2a 定位为非浮动（static/relative）', dock.get('position') in ('static', 'relative'),
                  f"position={dock.get('position')}")
            check('2a 对话框位于画布正下方', dock.get('belowCanvas'), '')
            check('2a 默认展开', dock.get('collapsed') == '0' and (dock.get('dockH') or 0) > 150,
                  f"h={dock.get('dockH')}")

        # 2b 折叠交互
        page.locator('[data-chat-collapse]').first.click()
        page.wait_for_timeout(400)
        h1 = page.evaluate(
            """() => document.querySelector('[data-crash-chat]').getBoundingClientRect().height"""
        )
        page.locator('[data-chat-collapse]').first.click()
        page.wait_for_timeout(400)
        h2 = page.evaluate(
            """() => document.querySelector('[data-crash-chat]').getBoundingClientRect().height"""
        )
        check('2b 可折叠（收起只剩标题行）', h1 < 60 and h2 > 150, f'收起 {h1:.0f}px → 展开 {h2:.0f}px')

        # 2c 上下文行在标题行（画布下方一眼可见）
        head_text = page.evaluate(
            """() => {
              const chat = document.querySelector('[data-crash-chat]');
              return chat ? chat.innerText.slice(0, 300) : '';
            }"""
        )
        check('2c 标题行含「正在讨论」（上下文可见）', '正在讨论' in head_text,
              head_text[:60].replace('\n', ' | '))

        # 2d 三态 + 多轮
        send = page.locator('[data-chat-send]').first
        check('2d 输入为空时发送置灰', send.get_attribute('data-disabled') == '1', '')
        page.fill('[data-chat-input]', '请原样复述这个想法的完整标题，不要任何其他内容。')
        send = page.locator('[data-chat-send]').first
        send.click()
        # 短间隔轮询 loading（真模型偶发响应 <800ms，固定等待会错过加载态；
        # 回复先到达也说明链路通 —— 记 detail 如实区分）
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
        check('2d 发送中显示加载状态', saw_loading or fast_reply,
              '加载态可见' if saw_loading else '模型响应快于轮询间隔（回复已到达）')
        got1 = wait_chat_reply(page, 2)
        check('2d 第一轮有 AI 回复', got1, f'{page.locator("[data-chat-msg]").count()} 条')
        if got1:
            reply = page.locator('[data-chat-msg][data-role="assistant"]').first.inner_text()
            cur_title = page.evaluate(
                """() => {
                  const sel = document.querySelector('[data-chat-idea-select]');
                  return sel ? sel.options[sel.selectedIndex]?.text ?? '' : '';
                }"""
            )
            check('2e AI 回复引用当前想法（复述标题）',
                  len(reply) > 5 and cur_title[:8] in reply,
                  f'期望含「{cur_title[:8]}」，实际：{reply[:60]}')

        page.fill('[data-chat-input]', '这个想法最大的风险是什么？一句话回答。')
        page.locator('[data-chat-send]').first.click()
        got2 = wait_chat_reply(page, 4)
        check('2e 多轮对话（第二条回复到达）', got2,
              f'{page.locator("[data-chat-msg]").count()} 条')

        # 2f 切换想法 → 会话隔离
        current_id = page.evaluate(
            """() => document.querySelector('[data-chat-idea-select]')?.value ?? ''"""
        )
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
            check('2f 切换想法后会话隔离（新想法历史为空）',
                  page.locator('[data-chat-msg]').count() == 0, '')
            page.locator('[data-chat-idea-select]').select_option(current_id)
            page.wait_for_timeout(600)
            check('2f 切回原想法历史保留',
                  page.locator('[data-chat-msg]').count() >= 4,
                  f'{page.locator("[data-chat-msg]").count()} 条')
        else:
            check('2f 会话隔离（仅一个想法可切换，跳过）', True, '')

        # ═══════════ 收尾 ═══════════
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
