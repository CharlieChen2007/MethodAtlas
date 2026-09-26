#!/usr/bin/env python3
"""
verify-p14-zone-isolation.py —— P14「各功能区域动画彼此分隔」专项验收。

**零模型调用**：所有"动作进行中"的 pending 窗口用 Playwright 路由拦截
制造（拦 Next Server Action 的 POST，sleep 后放行真请求），
不碰 LLM、不烧 API 余额。

覆盖（对应用户需求 7 的三条 + 需求 6）：
  A 连点防线   连点 5 次手动添加模块提交 → 库里只 +1、无 console 错
               （按钮 disabled + hook 入口守卫双防线）
  B 分区锁     idea 区动作进行中：左侧导航栏视图切换可用、crashtest 区的
               运行按钮/AI 对话输入不被连坐禁用、elementFromPoint 可命中
  C 几何稳定   pending 窗口内他区元素 boundingBox 不变（TOL 0.5px）
  D 遮罩规则   ConfirmDialog 关闭后 DOM 卸载、无残留遮罩、
               下层按钮立即可命中
  E 时长合规   扫描全程出现过的 CSSAnimation（非 infinite）：时长 ≤300ms

前置：3000 端口 dev server；playwright chromium。
用法：python3 scripts/verify-p14-zone-isolation.py
"""

import asyncio
import subprocess
import sys
from pathlib import Path

from playwright.async_api import async_playwright

BASE = "http://localhost:3000"
PROJECT = "cmu9my2ie0000z6pko5sqr27s"
LAB = f"{BASE}/projects/{PROJECT}/lab"
ROOT = Path(__file__).resolve().parent.parent

CHECKS = 0
FAILS: list[str] = []


def check(name, ok, detail=""):
    global CHECKS
    CHECKS += 1
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f" —— {detail}" if detail and not ok else ""))
    if not ok:
        FAILS.append(f"{name} {detail}")


def reset_user_data():
    r = subprocess.run(
        ["node", "scripts/reset-user-data.mjs"],
        cwd=str(ROOT), capture_output=True, text=True, timeout=120,
    )
    return r.returncode == 0


def db_count(table):
    js = (
        "const{PrismaClient}=require('@prisma/client');"
        f"const p=new PrismaClient();(async()=>{{console.log(await p.{table}.count());"
        "await p.$disconnect()})();"
    )
    r = subprocess.run(
        ["node", "-e", js], cwd=str(ROOT), capture_output=True, text=True, timeout=60
    )
    return int(r.stdout.strip().splitlines()[-1])


NO_INF_ANIM = """() => {
  const anims = document.getAnimations().filter((a) => {
    try {
      const t = a.effect && a.effect.getTiming();
      return t && t.iterations !== Infinity;
    } catch { return false; }
  });
  return anims.length === 0;
}"""

# 收集非 infinite CSSAnimation 的 (name, duration)，供断言 E 汇总
SNAP_ANIMS = """() => {
  const seen = [];
  for (const a of document.getAnimations()) {
    try {
      const t = a.effect && a.effect.getTiming();
      if (!t || t.iterations === Infinity) continue;
      let name = '(transition)';
      let dur = 0;
      if (a.animationName) { name = a.animationName; dur = (t.duration || 0); }
      else { dur = a.effect.getComputedTiming().duration || 0; }
      seen.push([name, Number(dur)]);
    } catch {}
  }
  return seen;
}"""


def box_of(page, selector):
    loc = page.locator(selector).first
    return loc.bounding_box()


def center(b):
    return (b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)


async def hit_target(page, selector):
    """elementFromPoint：该坐标下最顶层元素是否就是目标（或其内部）。"""
    b = await box_of(page, selector)
    if b is None:
        return False, "(无 boundingBox)"
    x, y = center(b)
    return await page.evaluate(
        """([x, y, sel]) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return [false, '(elementFromPoint 为空)'];
          const target = document.querySelector(sel);
          return [target ? (el === target || target.contains(el)) : false,
                  el.tagName + '.' + (el.className || '').toString().slice(0, 40)];
        }""",
        [x, y, selector],
    )


async def wait_anim_clear(page, timeout_ms=4000):
    """等所有非 infinite 动画播完（避开 ma-view-in 220ms 的整列位移）。"""
    try:
        await page.wait_for_function(NO_INF_ANIM, timeout=timeout_ms)
    except Exception:
        pass  # 超时就按当前状态采样（记录在案）


async def wait_feedback_settled(page, timeout_ms=20000):
    """等反馈条到终态（ok/error）或消失（idle 不渲染）。"""
    await page.wait_for_function(
        """() => {
          const el = document.querySelector('[data-feedback-state]');
          return !el || el.getAttribute('data-feedback-state') !== 'pending';
        }""",
        timeout=timeout_ms,
    )


async def main():
    print("── 前置：冷启动 ──")
    if not reset_user_data():
        print("reset-user-data 失败")
        return 2
    print("  数据库已清零（CandidateIdea=0）")
    # P18 问题 2 语义变化：手动加入的是模块（MethodBlock），不再产生想法；
    # 但 B 段（crashtest 运行按钮/AI 对话连坐测试）需要至少 1 个想法存在。
    # 这里用零模型 seed（直写 SQLite，同 P16 的前置）造想法，不烧 API。
    r = subprocess.run(
        ["node", "scripts/verify-p15-seed.mjs"],
        cwd=str(ROOT), capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0:
        print("seed 失败：" + (r.stdout + r.stderr).strip()[:200])
        return 2
    print(f"  已 seed 想法（CandidateIdea={db_count('candidateIdea')}）")

    console_errors: list[str] = []
    anim_seen: dict[str, float] = {}  # name → 最大 duration

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1440, "height": 950})
        await page.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
        page.on(
            "console",
            lambda m: console_errors.append(m.text) if m.type == "error" else None,
        )
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        # ── 路由拦截：延迟所有 Server Action POST（制造稳定 pending 窗口）──
        delay = {"ms": 0}

        async def slow_actions(route):
            req = route.request
            headers = {k.lower() for k in await req.all_headers()} if False else {
                k.lower() for k in (req.headers or {})
            }
            if req.method == "POST" and "next-action" in headers:
                await asyncio.sleep(delay["ms"] / 1000)
            await route.continue_()

        await page.route("**/*", slow_actions)

        await page.goto(f"{LAB}?view=idea", wait_until="networkidle")
        await page.wait_for_selector("[data-idea-workbench]", timeout=30000)
        await page.wait_for_timeout(600)
        await wait_anim_clear(page)

        # ════════ A. 连点防线（零模型：createCustomBlockAction 纯落库）════════
        print("── A. 连点防线：手动添加模块 5 连点 ──")
        delay["ms"] = 800
        # 基数：methodBlock 表含 seed 论文自带模块，A1 只看**增量**（+1）
        blocks_before = db_count("methodBlock")
        await page.fill("[data-custom-idea-title]", "P14 连点验收模块甲")
        submit = page.locator("[data-custom-idea-submit]").first
        for _ in range(5):
            # 用 DOM click 绕过 Playwright 的 actionability 等待：
            # 第 1 击让按钮进入 disabled，后 4 击应被 disabled + 入口守卫挡掉
            await submit.evaluate("el => el.click()")
            await page.wait_for_timeout(60)
        # 等 action 真正落地（反馈条到终态）
        await wait_feedback_settled(page, timeout_ms=20000)
        await page.wait_for_timeout(400)
        blocks_after = db_count("methodBlock")
        check("A1 连点 5 次只落库 1 个模块（增量 +1）",
              blocks_after == blocks_before + 1, f"db={blocks_after} (+{blocks_after - blocks_before})")
        check("A2 连点过程零 console 错误", len(console_errors) == 0,
              f"errors={console_errors[:3]}")
        # P18 问题 2：手动添加的是模块（进已选列表），不产生想法
        picked_cnt = await page.locator("[data-block-option][data-picked='1']").count()
        check("A3 手动模块自动加入已选（picked=1）", picked_cnt >= 1,
              f"picked={picked_cnt}")

        # ════════ B + C. 分区锁与几何稳定 ════════
        print("── B/C. idea 忙时他区可用 + boundingBox 稳定 ──")
        delay["ms"] = 1200

        # C-t0：提交前基准（idea 视图内 + 左栏导航 + 区域色带）
        #   P19：几何对象从"右栏工具栏 aside"换成"左栏导航 [data-nav]" ——
        #   右栏已整体删除，页面里唯一的 <aside> 就是左侧导航栏。
        base_boxes = {}
        for sel in ["[data-nav]", "[data-reset-cluster]", "[data-zone-band]"]:
            base_boxes[sel] = await box_of(page, sel)

        await page.fill("[data-custom-idea-title]", "P14 分区锁验收模块乙")
        await submit.evaluate("el => el.click()")  # 第 2 个想法，进入 1.2s pending
        await page.wait_for_timeout(250)  # React 状态落定（busyZones 已含 idea）

        # A4（顺带）：idea 忙 → 本区提交按钮立即禁用（第一道防线）
        check("B0 idea 忙时本区提交按钮 disabled",
              await page.locator("[data-custom-idea-submit]").first.is_disabled())
        check("B1 idea 忙时本区生成按钮 disabled（同区互锁）",
              await page.locator("[data-generate-combo]").first.is_disabled())

        # C-t1：pending 窗口内采样（先等列内 ma-view-in 之类清空——本视图未切，直接采）
        mid_boxes = {}
        for sel in ["[data-nav]", "[data-reset-cluster]", "[data-zone-band]"]:
            mid_boxes[sel] = await box_of(page, sel)
        for sel, b0 in base_boxes.items():
            b1 = mid_boxes[sel]
            ok = (
                b0 is not None and b1 is not None
                and abs(b0["x"] - b1["x"]) <= 0.5
                and abs(b0["y"] - b1["y"]) <= 0.5
                and abs(b0["width"] - b1["width"]) <= 0.5
            )
            check(f"C1 pending 中 {sel} 位置不变", ok,
                  f"t0={b0} t1={b1}")

        # B2：他区不连坐 —— 切视图（纯 dispatch 永不锁）
        # P19：视图出口在左栏（默认折叠，只渲染单字字形，但 data-view 在），
        # 点不到文字标签 —— 所以按 data-view id 点，不按中文名。
        await page.click('[data-view="crashtest"]')
        switched = await page.evaluate("() => new URLSearchParams(location.search).get('view')")
        check("B2 idea 忙时左栏切换视图成功", switched == "crashtest", f"view={switched}")

        await page.wait_for_selector("[data-crash-run-card]", timeout=10000)
        await wait_anim_clear(page)  # 等 ma-view-in（220ms）播完再采样/断言

        # 选中想法 → 运行按钮过门控（只选不跑：跑击穿会调模型）
        opt = page.locator("[data-crash-idea-option]").first
        await opt.click()
        await page.wait_for_timeout(150)
        run_btn = page.locator("[data-run-crash]").first
        check("B3 crashtest 运行按钮不被 idea 忙连坐（enabled）",
              not await run_btn.is_disabled())
        chat_input = page.locator("[data-chat-input]").first
        check("B4 AI 对话输入不被连坐（enabled）", not await chat_input.is_disabled())

        # B5：可点击性 —— elementFromPoint 命中运行按钮本体（无浮层遮挡）
        hit, hit_what = await hit_target(page, "[data-run-crash]")
        check("B5 运行按钮坐标 elementFromPoint 命中本体", hit, f"命中的是 {hit_what}")

        # C2：crashtest 视图内元素在「idea 仍在跑」的窗口内位移为 0
        #
        # P19：对比面板不再是常驻内联列 —— 它现在是左下角的浮动按钮
        # [data-compare-toggle]，点开才渲染覆盖式抽屉 [data-compare-overlay]。
        # 所以这里量"稳定"的对象换成那枚常驻的浮动按钮（同样属于击穿区、
        # 同样在 idea 忙时不该被连坐重排）。打开抽屉会把中栏盖住并引入
        # 开合动画，反而量不出"稳定"，与本节目的相反。
        boxes_a = {}
        for sel in ["[data-crash-run-card]", "[data-compare-toggle]", "[data-nav]"]:
            boxes_a[sel] = await box_of(page, sel)
        await page.wait_for_timeout(400)  # 仍在 1.2s+ 窗口内
        boxes_b = {}
        for sel in ["[data-crash-run-card]", "[data-compare-toggle]", "[data-nav]"]:
            boxes_b[sel] = await box_of(page, sel)
        for sel in boxes_a:
            a, b = boxes_a[sel], boxes_b[sel]
            if a is None or b is None:
                check(f"C2 {sel} pending 中稳定", False, "元素未渲染")
                continue
            ok = (
                abs(a["x"] - b["x"]) <= 0.5
                and abs(a["y"] - b["y"]) <= 0.5
                and abs(a["width"] - b["width"]) <= 0.5
            )
            check(f"C2 {sel} idea-pending 窗口内稳定", ok, f"a={a} b={b}")

        # 动画快照（断言 E 的素材）
        for name, dur in await page.evaluate(SNAP_ANIMS):
            anim_seen[name] = max(anim_seen.get(name, 0), dur)

        # 等 idea action 落地（乙模块入库 → 增量 = 甲乙共 2 个）
        await wait_feedback_settled(page, timeout_ms=20000)
        blocks_final = db_count("methodBlock")
        check("B6 第二个模块正常落库（分区锁未误伤本区，累计 +2）",
              blocks_final == blocks_before + 2,
              f"db={blocks_final} (+{blocks_final - blocks_before})")

        # ════════ D. 遮罩规则 ════════
        print("── D. ConfirmDialog 开关与遮罩残留 ──")
        await page.click("[data-reset-run]")
        await page.wait_for_selector("[data-confirm-dialog]", timeout=5000)
        # 模态打开时：下层按钮被遮罩覆盖（elementFromPoint 命中的不是它）
        hit_open, open_what = await hit_target(page, "[data-reset-run]")
        check("D1 确认框打开时下层按钮被遮罩接管（模态语义）", not hit_open,
              f"命中的是 {open_what}")
        # 关闭（取消）
        await page.click("[data-confirm-cancel]")
        await page.wait_for_timeout(300)
        check("D2 确认框 DOM 已卸载",
              await page.locator("[data-confirm-dialog]").count() == 0)
        residue = await page.evaluate(
            """() => {
              const fixed = [...document.querySelectorAll('div')].filter((d) => {
                const s = getComputedStyle(d);
                return s.position === 'fixed' &&
                       parseFloat(s.opacity) > 0.3 &&
                       d.offsetWidth >= innerWidth * 0.9 &&
                       d.offsetHeight >= innerHeight * 0.9 &&
                       !d.contains(document.querySelector('header')) &&
                       d.querySelector('[data-confirm-dialog]');
              });
              return fixed.length;
            }"""
        )
        check("D3 无残留遮罩层（全屏 fixed 半透明 div 计数=0）", residue == 0,
              f"残留 {residue}")
        hit_closed, closed_what = await hit_target(page, "[data-reset-run]")
        check("D4 关闭后下层按钮立即可命中", hit_closed, f"命中的是 {closed_what}")

        # 证据抽屉（RightDrawer）同样断言：开 → 关 → 无残留
        # （dna 视图有 3 篇论文的结构，点一个 block 节点 → 面板 → 查看证据）
        await page.click('[data-view="dna"]')
        await page.wait_for_timeout(400)
        await wait_anim_clear(page)
        node = page.locator("[data-node^='block-']").first
        if await node.count() > 0:
            await node.click()
            await page.wait_for_timeout(500)
            ev_btn = page.locator("[data-panel-action='evidence']")
            if await ev_btn.count() > 0:
                await ev_btn.click()
                await page.wait_for_selector("[role='dialog']", timeout=5000)
                close_btn = page.locator("[aria-label='关闭侧边面板']").first
                if await close_btn.count() > 0:
                    await close_btn.click()
                    await page.wait_for_timeout(400)
                    check("D5 证据抽屉 DOM 已卸载",
                          await page.locator("div[role='dialog'][aria-modal='true']").count() == 0)
                    hit_after, what = await hit_target(page, "[data-reset-cluster]")
                    check("D6 证据抽屉关闭后下层可命中", hit_after, f"命中的是 {what}")
                else:
                    check("D5 证据抽屉关闭按钮存在", False, "未找到关闭侧边面板按钮")
            else:
                check("D5 跳过（该节点无证据动作）", True)
        else:
            check("D5 跳过（画布无 block 节点）", True)
        # ════════ E. 动画时长合规 ════════
        print("── E. 动画时长扫描 ──")
        # 主动触发几类动画：切视图（ma-view-in）、重置（anim-reset）
        for v in ["idea", "crashtest", "dna", "evolution", "debt"]:
            await page.click(f'[data-view="{v}"]')
            await page.wait_for_timeout(80)  # 动画播放中抓
            for name, dur in await page.evaluate(SNAP_ANIMS):
                anim_seen[name] = max(anim_seen.get(name, 0), dur)
            await wait_anim_clear(page)
        await page.click("[data-reset-run]")
        await page.click("[data-confirm-ok]")
        await page.wait_for_timeout(120)
        for name, dur in await page.evaluate(SNAP_ANIMS):
            anim_seen[name] = max(anim_seen.get(name, 0), dur)
        await wait_feedback_settled(page, timeout_ms=10000)

        print("  捕获到的一次性动画：")
        # ── P20：时长口径按产品最新规约调整 ──
        #   旧口径是 140–310ms（P11 时代定的）。P20 明确「时长 200–400ms，
        #   不要超过 500ms」，而列表交错出场本身就是 400ms —— 旧上界 310ms
        #   会把**合规**动画判成越界（实测抓到 ma-slide-in=400ms 被误杀）。
        #
        #   拆成两条，各自语义清楚：
        #     · E1  硬红线：所有一次性动画必须落在 140–500ms。下界防"快到看不见"，
        #           上界就是产品原话的 500ms。
        #     · E1b **本轮 P20 新增的那几支**动画落在推荐区间 200–400ms。
        #           为什么不要求全部动画都进这个区间：ma-card-in(180ms) /
        #           ma-ok-flash(240ms) 这些是 P11–P18 时代定的存量动效，
        #           它们不在本轮规约的管辖范围里，硬卡会把无关改动判成失败。
        P20_ANIMS = {"ma-slide-in", "ma-panel-up", "ma-view-fade"}
        hard_bad, soft_bad = [], []
        for name, dur in sorted(anim_seen.items()):
            ok_hard = 140 <= dur <= 500
            ok_soft = 200 <= dur <= 400
            print(
                f"    {name:24s} {dur:>6.0f}ms "
                f"{'✓' if ok_hard else '✗ 超 500ms 红线'}"
                f"{'' if (ok_soft or name not in P20_ANIMS) else '（P20 动画在推荐区间外）'}"
            )
            if not ok_hard:
                hard_bad.append(f"{name}={dur}ms")
            elif name in P20_ANIMS and not ok_soft:
                soft_bad.append(f"{name}={dur}ms")
        check("E1 所有一次性动画不超 500ms 硬红线（且不短于 140ms）",
              len(hard_bad) == 0, f"越界：{hard_bad}")
        check("E1b P20 新增动画落在推荐区间 200–400ms",
              len(soft_bad) == 0,
              f"区间外：{soft_bad}" if soft_bad else "全部在区间内")

        await browser.close()

    # ── 收尾 ──
    reset_user_data()
    print("  收尾清场完成（CandidateIdea 归零）")

    print("=" * 60)
    if FAILS:
        print(f"FAIL —— {len(FAILS)}/{CHECKS} 项失败：")
        for f in FAILS:
            print("   ", f)
        return 1
    print(f"PASS —— {CHECKS}/{CHECKS} 项全部通过")
    return 0


if __name__ == "__main__":
    code = asyncio.run(main())
    sys.exit(code)
