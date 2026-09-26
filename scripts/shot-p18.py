#!/usr/bin/env python3
"""
shot-p18.py —— P18 交付实测截图（零模型，生产 server 上跑）。

产出 7 张图到 /workspace/MethodAtlas/：
  P18-截图-01-开场页.png                首次进入：Logo 居中 + 开始探索按钮
  P18-截图-02-交叉过渡中.png            点击开始探索后 250ms（淡出淡入进行中）
  P18-截图-03-idea工作台-logo右下.png    工作台右下角 80×80 logo + 手动添加模块表单
  P18-截图-04-手动添加模块表单.png      表单填写态（含论文下拉）
  P18-截图-05-击穿测试-竖排卡片.png      击穿卡竖向堆叠 + 缩小的想法面板
  P18-截图-06-对比面板折叠.png          想法对比面板折叠竖条
  P18-截图-07-对比面板展开-画布右移.png  对比面板展开（真实占位，画布收缩）

前置：3000 端口生产/dev server；零模型（seed 直写 SQLite）。
用法：python3 scripts/shot-p18.py
"""

import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
OUT = Path("/workspace/MethodAtlas")
ROOT = Path(__file__).resolve().parent.parent

import json


def first_project_id():
    js = (
        "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();"
        "(async()=>{const pr=await p.project.findFirst();console.log(pr.id);await p.$disconnect()})();"
    )
    r = subprocess.run(['node', '-e', js], cwd=str(ROOT), capture_output=True, text=True, timeout=60)
    return r.stdout.strip().splitlines()[-1]


def main():
    print('=' * 60)
    print('P18 实测截图')
    print('=' * 60)
    pid = first_project_id()
    lab = f'{BASE}/projects/{pid}/lab'
    print(f'项目：{pid}')

    # 清场 + 零模型 seed（4 个想法：3 已测 + 1 未测，给击穿视图素材）
    subprocess.run(['node', 'scripts/reset-user-data.mjs'], cwd=str(ROOT),
                   capture_output=True, text=True, timeout=120)
    subprocess.run(['node', 'scripts/verify-p15-seed.mjs'], cwd=str(ROOT),
                   capture_output=True, text=True, timeout=120)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        # 新 context = 干净 sessionStorage → 开场页必然显示
        ctx = browser.new_context(viewport={"width": 1440, "height": 950})
        page = ctx.new_page()

        # ── 图 1：开场页（Logo 居中 36vh + 开始探索）──
        page.goto(f'{lab}?view=dna', wait_until='networkidle')
        page.wait_for_timeout(2500)
        assert page.locator('[data-intro-page]').count() == 1, '开场页未出现'
        page.screenshot(path=str(OUT / 'P18-截图-01-开场页.png'))
        print('图 1 完成（开场页）')

        # ── 图 2：交叉过渡中（点击后 ~250ms，两层都在半透明）──
        page.locator('[data-intro-start]').click()
        page.wait_for_timeout(250)
        page.screenshot(path=str(OUT / 'P18-截图-02-交叉过渡中.png'))
        print('图 2 完成（交叉过渡中）')
        # 等过渡彻底结束
        page.wait_for_timeout(800)
        assert page.locator('[data-intro-page]').count() == 0, '开场页未卸载'
        # 验证会话内跳过：软导航走一圈再截图对比（不截图，只断言）
        page.goto(f'{lab}?view=idea', wait_until='networkidle')
        page.wait_for_timeout(1200)
        assert page.locator('[data-intro-page]').count() == 0, '会话内跳过失效'

        # ── 图 3：idea 工作台（右下角 logo + 三栏 + 手动添加模块）──
        page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / 'P18-截图-03-idea工作台-logo右下.png'))
        print('图 3 完成（idea 工作台 + 右下角 logo）')

        # ── 图 4：手动添加模块表单（填写态，含论文下拉展开可读）──
        page.fill('[data-custom-idea-title]', '整理本领域公开数据集的系统综述与获取清单')
        page.fill('[data-custom-idea-desc]',
                  '系统检索近五年公开论文，汇总其中使用的数据集、规模与获取方式，'
                  '输出一份带引用的清单与选型建议。不训练任何模型。')
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / 'P18-截图-04-手动添加模块表单.png'))
        print('图 4 完成（手动添加模块表单填写态）')

        # ── 图 5：击穿测试（选中 2 个想法 → 击穿卡竖排 + 想法面板缩小）──
        # seed 已带 3 个已测想法 → 直接看竖排卡片。
        # 注意：这里只选 2 个（不全选）。若图 5 全选 + 展开，图 7 再展开
        # 后会与图 5 完全相同（面板默认展开，折叠→展开回到同一状态机点）。
        page.goto(f'{lab}?view=crashtest', wait_until='networkidle')
        page.wait_for_timeout(2000)
        opts = page.locator('[data-crash-idea-option]')
        picked = 0
        for i in range(opts.count()):
            if picked >= 2:
                break
            if opts.nth(i).get_attribute('data-picked') != '1':
                opts.nth(i).click()
                page.wait_for_timeout(250)
                picked += 1
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / 'P18-截图-05-击穿测试-竖排卡片.png'))
        print('图 5 完成（击穿测试：竖排卡片，选中 2 想法）')


        # ── 图 6：对比面板折叠（36px 竖条 + ▶）──
        page.locator('[data-compare-collapse]').first.click()
        page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / 'P18-截图-06-对比面板折叠.png'))
        print('图 6 完成（对比面板折叠竖条）')

        # ── 图 7：对比面板展开（画布内容右移 = 真实占位）──
        # 展开后全选剩余想法 → 与图 5（2 想法）画面不同，避免两张图重复。
        page.locator('[data-compare-expand]').first.click()
        page.wait_for_timeout(600)
        for i in range(opts.count()):
            if opts.nth(i).get_attribute('data-picked') != '1':
                opts.nth(i).click()
                page.wait_for_timeout(250)
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / 'P18-截图-07-对比面板展开-画布右移.png'))
        print('图 7 完成（对比面板展开：画布右移）')

        browser.close()

    # 清场（回滚 seed，交付快照干净）
    subprocess.run(['node', 'scripts/reset-user-data.mjs'], cwd=str(ROOT),
                   capture_output=True, text=True, timeout=120)
    print('已清场')
    return 0


if __name__ == '__main__':
    sys.exit(main())
