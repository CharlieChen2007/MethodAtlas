#!/usr/bin/env python3
"""
P10 问题 2 回归：冷启动时「已生成的想法（0）」。

背景：库里曾残留上一次验收跑出的 3 条真数据（**不是**预置逻辑 ——
CandidateIdea 全仓只有 crossbreeder.ts 一处写入点），用户误以为被预置。
本脚本验证「冷启动 = 用户没动过手时，想法数必须为 0」。

── 关于验收标准 #4 与 #5 的冲突（P10 Step6 说明）──
用户既要求「债务、想法、击穿测试都有数据」（#4），又要求
「冷启动时『已生成的想法（0）』」（#5）。这两条**不可能同时在同一份库里成立**：
  · #4 描述的是「用户跑完链路之后」的状态
  · #5 描述的是「用户还没跑之前」的状态
所以正确的关系是**时序**关系，不是并存关系：
  冷启动（0）→ 用户点「生成」→ 有数据（N）
本脚本验证这个时序的两端都能成立：
  1. 先确认「用户没跑过」时显示 0（用 --expect-cold 时断言）
  2. 再确认「跑过之后」确实有数据（用 --expect-data 时断言）
默认只做**非破坏性**检查：如实报告当前是哪一端，不擅自改库。

用法：
  python3 scripts/verify-cold-start.py                 # 只报告现状
  python3 scripts/verify-cold-start.py --expect-cold   # 断言当前是冷启动（0）
  python3 scripts/verify-cold-start.py --expect-data   # 断言当前已有想法（>0）
"""
import subprocess
import sys

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"


def project_id() -> str:
    """动态取项目 id —— 写死 id 会在换论文后失效（旧脚本就是这么坏掉的）。"""
    out = subprocess.run(
        ["node", "-e",
         "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();"
         "(async()=>{const pr=await p.project.findFirst();console.log(pr.id);await p.$disconnect()})()"],
        capture_output=True, text=True, cwd=".",
    )
    return out.stdout.strip()


def idea_count() -> int:
    out = subprocess.run(
        ["node", "-e",
         "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();"
         "(async()=>{console.log(await p.candidateIdea.count());await p.$disconnect()})()"],
        capture_output=True, text=True, cwd=".",
    )
    try:
        return int(out.stdout.strip())
    except ValueError:
        return -1


def main():
    expect_cold = "--expect-cold" in sys.argv
    expect_data = "--expect-data" in sys.argv

    pid = project_id()
    assert pid, "取不到项目 id"
    n_db = idea_count()

    url = f"{BASE}/projects/{pid}/lab?view=idea"
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1600, "height": 950})
        pg.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
        pg.goto(url, wait_until="networkidle")
        pg.wait_for_timeout(2200)

        body = pg.evaluate("() => document.body.innerText")

        # 冷启动文案（「已生成的想法（0）」）—— 只在 0 想法时出现
        has_zero_label = "已生成的想法（0）" in body
        # 有数据时的文案（形如「已生成的想法（3）」）
        import re
        m = re.search(r"已生成的想法（(\d+)）", body)
        ui_count = int(m.group(1)) if m else None

        cards = pg.evaluate("""() =>
          Array.from(document.querySelectorAll('[data-node]'))
            .map(n => n.getAttribute('data-node') || '')
            .filter(id => id.startsWith('idea') || id.startsWith('card-'))
        """)

        print("=" * 66)
        print("P10 问题 2 回归：冷启动「已生成的想法（0）」")
        print("=" * 66)
        print(f"  项目 id            : {pid}")
        print(f"  库里想法数          : {n_db}")
        print(f"  界面显示想法数       : {ui_count}")
        print(f"  含「已生成的想法（0）」: {has_zero_label}")
        print(f"  画布 idea 卡片节点数  : {len(cards)}")

        pg.screenshot(path="p10-evidence/p2-cold-start.png")
        b.close()

    ok = True
    mode = "仅报告"
    if expect_cold:
        mode = "断言冷启动（0）"
        ok = (n_db == 0) and has_zero_label and (len(cards) == 0)
    elif expect_data:
        mode = "断言已有数据（>0）"
        ok = (n_db > 0)

    print(f"\n模式：{mode}")
    # 无论哪种模式，都不允许"数据库 0 条但界面显示非 0"这种不一致
    if n_db == 0 and ui_count not in (0, None):
        ok = False
        print("  ✘ 库里 0 条但界面显示非 0 —— 出现了不该有的预置")
    if n_db > 0 and has_zero_label:
        ok = False
        print("  ✘ 库里有数据但界面显示 0 —— 计数与实际不一致")

    print("结论：" + ("通过 ✅" if ok else "失败 ❌"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
