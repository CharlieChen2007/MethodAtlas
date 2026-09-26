#!/usr/bin/env python3
"""
shot-p13.py —— P13 两处输入交互新布局截图（交接文档配图）。

产出 4 张图到 /workspace/MethodAtlas/：
  P13-截图-第三列下方输入框.png     idea 视图：右栏下半区的手动输入对话框
  P13-截图-输入框校验提示.png       短标题时的提示态
  P13-截图-画布下方AI对话.png       crashtest 视图：画布下方 dock（含真实回复）
  P13-截图-AI对话收起态.png        dock 收起只剩标题行

前置：3000 端口 dev server + 真模型配置（一轮对话）。
用法：python3 scripts/shot-p13.py
"""

import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
PROJECT = "cmu9my2ie0000z6pko5sqr27s"
LAB = f"{BASE}/projects/{PROJECT}/lab"
OUT = Path("/workspace/MethodAtlas")

ROOT = Path(__file__).resolve().parent.parent


def db_count(table):
    js = (
        "const{PrismaClient}=require('@prisma/client');"
        f"const p=new PrismaClient();(async()=>{{console.log(await p.{table}.count());"
        "await p.$disconnect()})();"
    )
    r = subprocess.run(['node', '-e', js], cwd=str(ROOT), capture_output=True, text=True, timeout=60)
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


def main():
    print('=' * 60)
    print('P13 新布局截图')
    print('=' * 60)

    subprocess.run(['node', 'scripts/reset-user-data.mjs'], cwd=str(ROOT),
                   capture_output=True, text=True, timeout=120)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 950})

        # ── 准备：一轮生成 ──
        page.goto(f'{LAB}?view=idea', wait_until='networkidle')
        page.wait_for_selector('[data-idea-workbench]', timeout=20000)
        page.wait_for_timeout(1200)
        if not run_generation(page, 0):
            print('!! 生成失败')
            browser.close()
            return 1
        print(f'生成完成：{db_count("candidateIdea")} 个想法')

        # ── 图 1：第三列下方输入框（填写态）──
        page.fill('[data-custom-idea-title]', '用课程作业真题微调小模型做自动评分')
        page.fill('[data-custom-idea-desc]',
                  '收集本课程历年作业与评分标准，微调 7B 级开源模型，'
                  '在助教评分前给出一版参考分与评语，助教只需修正差异项。')
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / 'P13-截图-第三列下方输入框.png'))
        print('图 1 完成')

        # ── 图 2：校验提示态（短标题）──
        page.fill('[data-custom-idea-title]', '短的')
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / 'P13-截图-输入框校验提示.png'))
        print('图 2 完成')

        # ── 图 3：画布下方 AI 对话（真实回复）──
        page.goto(f'{LAB}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(2200)
        opts = page.locator('[data-crash-idea-option]')
        opts.first.click()
        page.wait_for_timeout(500)
        page.fill('[data-chat-input]', '这个想法最大的风险是什么？两句话回答。')
        page.locator('[data-chat-send]').first.click()
        for _ in range(90):
            page.wait_for_timeout(1000)
            if page.locator('[data-chat-msg][data-role="assistant"]').count() >= 1:
                break
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / 'P13-截图-画布下方AI对话.png'))
        print('图 3 完成')

        # ── 图 4：收起态 ──
        page.locator('[data-chat-collapse]').first.click()
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / 'P13-截图-AI对话收起态.png'))
        print('图 4 完成')

        browser.close()

    # ── 清场 ──
    subprocess.run(['node', 'scripts/reset-user-data.mjs'], cwd=str(ROOT),
                   capture_output=True, text=True, timeout=120)
    print(f'已清场：ideas={db_count("candidateIdea")}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
