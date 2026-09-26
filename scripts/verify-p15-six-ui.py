#!/usr/bin/env python3
"""
verify-p15-six-ui.py —— P15「六项 UI 统一调整」专项验收。

**零模型调用**：全部断言只读 DOM 几何/样式 + 点击纯前端交互（弹窗取消、
勾选想法、拖画布），不触碰任何 Server Action 的 LLM 链路，不烧 API 余额。

覆盖（对应用户六项需求）：
  A 重置按钮   P16 后重写为"还原断言"：尺寸恢复原值（字号 12/图标 13/
               分隔线 16px）；P19 后又从"右栏工具栏（击穿测试按钮下方）"
               迁到 **顶栏右侧动作区**（左栏展开态另有一份）——
               几何断言随之改成：顶栏那份 ⊆ [data-top-bar]、左栏那份位于
               击穿测试步骤下方、两份都与内容列零重叠；
               点击弹确认/取消正常（这部分不变）
  B DNA 图表   节点字体放大（标题 17px/摘要 14px）不溢出；
               P19：面板默认收起（点节点才滑出）；缩放控件条已整体删除，
               "两框异色"只剩面板一侧 → 改为断言缩放条确实不存在 +
               面板边框仍是视图浅蓝 #93c5fd 且宽 2px
  C 研究债务   P17 后：债务概览 dock 已删除（无 DOM/无文案）；
               画布债务列表 + 详情面板链路完好；画布占满列无空白占位
  D 组合想法   三栏分界线异色（绿 #86efac / 蓝 #93c5fd）；三栏字体统一
               （P18 问题 1：全局 Inter 栈，无衬线/等宽覆盖）；
               三栏 flex 占满无大空隙；
               手动输入 dock 中性细线（P16 问题二口径）+ 全局字体
  E 击穿色阶   已测想法相似度色互异；色相差单调（一档差对 < 多档差对）；
               清单左色条与对比面板色点同源同色；未测想法不参与
               （P19：清单是单选 tab、对比是覆盖式抽屉 → 多选走
                ?crashIdeaIds= 并先点 [data-compare-toggle]）
  F 全局背景   dna/evolution/debt 三画布 + 组合想法 + 项目页
               五处背景图案两两互异；全部 radial 点阵（无 linear、零 rgba
               函数、有点尺寸）合规；点色浅淡（亮度 ≥ 0.8）；
               dna 画布拖拽时底图 backgroundPosition 跟手
               （P19：crashtest 不再渲染画布，单独断言"它确实没有画布"）

前置：3000 端口 dev server；playwright chromium；先跑 verify-p15-seed.mjs
（脚本内自动执行，幂等：deleteMany 后重建 3 已测 + 1 未测想法）。
用法：python3 scripts/verify-p15-six-ui.py
"""

import asyncio
import re as _re
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


def hex_rgb(h):
    """#rrggbb -> 'rgb(r, g, b)'（与 getComputedStyle 口径一致）"""
    h = h.lstrip("#")
    return f"rgb({int(h[0:2], 16)}, {int(h[2:4], 16)}, {int(h[4:6], 16)})"


def hex_hue(h):
    """#rrggbb -> 色相 0~360"""
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    mx, mn = max(r, g, b), min(r, g, b)
    if mx == mn:
        return 0.0
    d = mx - mn
    if mx == r:
        hh = ((g - b) / d) % 6
    elif mx == g:
        hh = (b - r) / d + 2
    else:
        hh = (r - g) / d + 4
    return hh * 60


def hue_dist(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def brightness(h):
    """#rrggbb -> 感知亮度 0~1（图案浅淡纪律 ≥ 0.8）"""
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255


def run_seed():
    r = subprocess.run(
        ["node", "scripts/verify-p15-seed.mjs"],
        cwd=str(ROOT), capture_output=True, text=True, timeout=120,
    )
    return r.returncode == 0, (r.stdout + r.stderr).strip()


def overlap_area(a, b):
    """两个 boundingBox 字典的相交面积。0 = 零重叠。"""
    if not a or not b:
        return 0.0
    ox = max(0.0, min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]))
    oy = max(0.0, min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]))
    return ox * oy


async def set_rail_collapsed(page, collapsed: bool, settle=450):
    """把左侧导航栏切到指定开合态（P19：默认折叠 48px / 展开 248px）。

    data-view-step / data-view-state / 步骤文字、以及第二份重置簇，
    都**只在展开态渲染** —— 断言之前先把开合态摆正。
    """
    cur = await page.locator("[data-nav]").first.get_attribute("data-nav-collapsed")
    if (cur == "1") != collapsed:
        await page.locator("[data-rail-toggle]").first.click()
        await page.wait_for_timeout(settle)
    return await page.locator("[data-nav]").first.get_attribute("data-nav-collapsed")


async def group_a(page):
    """A 重置按钮：P16 问题一后的还原断言（尺寸原值 + 迁入右栏）。"""
    print("── A 重置按钮还原与新位置（P16 后口径） ──")
    await page.goto(f"{LAB}?view=dna", wait_until="networkidle")
    await page.wait_for_timeout(1200)

    cluster = page.locator("[data-reset-cluster]").first
    run_btn = page.locator("[data-reset-run]").first
    data_btn = page.locator("[data-reset-data]").first
    cb = await cluster.bounding_box()
    check("A1 重置簇存在且拿到 boundingBox", cb is not None)
    if not cb:
        return

    # A2-A6 尺寸还原（P15 曾放大 2 倍，P16 恢复原值）
    check("A2 重置簇高度恢复原值（≤ 32px 紧凑级）", cb["height"] <= 32,
          f"h={cb['height']:.0f}")
    fs = await run_btn.evaluate("el => getComputedStyle(el).fontSize")
    check("A3 重置按钮字号恢复 12px", fs == "12px", fs)
    icon_fs = await run_btn.evaluate(
        "el => getComputedStyle(el.querySelector('span')).fontSize")
    check("A4 图标字号恢复 13px", icon_fs == "13px", icon_fs)
    sep_h = await cluster.evaluate(
        "el => { const s = el.querySelector('span.bg-line');"
        "return s ? getComputedStyle(s).height : '' }")
    check("A5 分隔线高恢复 16px", sep_h == "16px", sep_h)
    btn_box = await run_btn.bounding_box()
    check("A6 按钮本身高恢复紧凑级（≤ 24px）",
          btn_box and btn_box["height"] <= 24,
          f"h={btn_box['height']:.0f}" if btn_box else "None")

    # A7-A10 几何（P19 新口径）
    #
    # ── 旧口径（P16）与它为什么作废 ──
    #   旧断言：重置簇 ⊆ 右栏 [data-nav]（那时是右栏）+ 位于击穿测试按钮
    #   正下方 + 与画布列零重叠。P19 把右栏整个删掉、重置簇搬进**顶栏右侧
    #   动作区**（左栏展开态的「设置」区另有一份），于是：
    #     · 右栏不存在 → "cluster ⊆ 右栏" 失去对象；
    #     · 顶栏那份在击穿按钮**上方**（一个在顶栏、一个在左栏），
    #       "正下方"只对左栏那份成立；
    #     · "与画布列零重叠（cluster 在画布右侧）"从恒真变成恒假 ——
    #       内容列现在在左栏**右**边，而位置关系改由 y 轴分离（顶栏在内容列上方）。
    #   换成等价契约（同样是"重置入口不许压住别的区域"）：
    #     ① 顶栏那份 ⊆ 顶栏；
    #     ② 左栏展开后那份位于最后一个流程步骤（击穿测试）下方；
    #     ③ 两份都与内容列矩形相交面积为 0（顶栏与内容列在 x 上是重叠的，
    #        所以必须按面积判，不能只看 x）。
    topbar = await page.locator("[data-top-bar]").first.bounding_box()
    # ── P19 修正 ①：内容列必须**显式排除左栏** ──
    # 旧写法 `[data-lab-body] > div` 取第一个子元素，而 P19 的第一个子元素
    # 正是左栏 [data-nav] 本身 —— 于是"与内容列零重叠"退化成"与左栏零重叠"，
    # 左栏那份重置簇必然被判成重叠（实测 3069px² 的假失败）。
    # ── P19 修正 ②：几何一律**在页面里现算**，不用 locator.bounding_box() ──
    # 左栏展开是 150ms 的宽度过渡。`locator.bounding_box()` 走的是
    # Playwright 自己的元素快照，会返回**过渡开始前**的陈旧盒子
    # （实测：nav 已经 248px，它仍报 content.x=48 —— 于是算出 3069px² 的
    # 幽灵重叠）。改用 evaluate + getBoundingClientRect()，拿的就是当帧真值。
    topbar = await page.locator("[data-top-bar]").first.bounding_box()
    content_col = await page.evaluate(
        """() => {
             const el = document.querySelector('[data-lab-body] > div:not([data-nav])');
             if (!el) return null;
             const r = el.getBoundingClientRect();
             return { x: r.x, y: r.y, width: r.width, height: r.height };
           }"""
    )
    check("A7 拿到顶栏/内容列 boundingBox",
          topbar is not None and content_col is not None,
          f"topbar={topbar is not None} content={content_col is not None}")
    if topbar and content_col:
        inside = (cb["x"] >= topbar["x"] - 1
                  and cb["y"] >= topbar["y"] - 1
                  and cb["x"] + cb["width"] <= topbar["x"] + topbar["width"] + 1
                  and cb["y"] + cb["height"] <= topbar["y"] + topbar["height"] + 1)
        check("A8 顶栏那份重置簇 boundingBox 完全在 [data-top-bar] 内", inside,
              f"cluster=({cb['x']:.0f},{cb['y']:.0f},{cb['width']:.0f}x{cb['height']:.0f})")
        # 左栏展开态那份：DOM 顺序 = 顶栏先、左栏后 → .nth(1)
        state = await set_rail_collapsed(page, False)
        # P19：等宽度过渡（150ms）真正走完再量几何 —— 见下方 content_col 注释
        await page.wait_for_timeout(400)
        n_clusters = await page.locator("[data-reset-cluster]").count()
        check("A9 左栏展开后出现第二份重置簇（顶栏 + 左栏 = 2）",
              state == "0" and n_clusters == 2, f"state={state} n={n_clusters}")
        # 两份簇 / 击穿步骤按钮的几何统一在页面里现算（避免过期快照）
        geo2 = await page.evaluate(
            """() => {
                 const rc = document.querySelectorAll('[data-reset-cluster]');
                 const bx = (e) => { if (!e) return null; const r = e.getBoundingClientRect();
                   return { x: r.x, y: r.y, width: r.width, height: r.height }; };
                 const crashBtn = document.querySelector('[data-nav] [data-view="crashtest"]');
                 return { railCluster: bx(rc[1]), all: rc.length, crashBtn: bx(crashBtn) };
               }"""
        )
        rcb = geo2["railCluster"] if geo2["all"] == 2 else None
        crash_btn = geo2["crashBtn"]
        below = all([rcb, crash_btn]) and rcb["y"] >= crash_btn["y"] + crash_btn["height"] - 1
        check("A9 左栏那份位于击穿测试步骤正下方", below,
              f"cluster.y={rcb['y']:.0f} >= crash.bottom={crash_btn['y'] + crash_btn['height']:.0f}"
              if rcb and crash_btn else "None")
        # 关键：**内容列的盒子也要在展开之后再取一次**。
        # content_col 是在还没展开左栏时量的（那时 x=48），拿它去和展开后的
        # 左栏簇比，等于用"折叠态的内容列位置"去判"展开态的簇" —— 必然假重叠。
        geo3 = await page.evaluate(
            """() => {
                 const bx = (e) => { if (!e) return null; const r = e.getBoundingClientRect();
                   return { x: r.x, y: r.y, width: r.width, height: r.height }; };
                 const rc = document.querySelectorAll('[data-reset-cluster]');
                 return { content: bx(document.querySelector('[data-lab-body] > div:not([data-nav])')),
                          top: bx(rc[0]), rail: bx(rc[1]) };
               }"""
        )
        content_col = geo3["content"]
        cb = geo3["top"]
        rcb = geo3["rail"]
        check("A10 两份 cluster 都与内容列零重叠（相交面积 = 0）",
              overlap_area(cb, content_col) <= 1
              and (rcb is None or overlap_area(rcb, content_col) <= 1),
              f"顶栏 {overlap_area(cb, content_col):.0f}px² / "
              f"左栏 {overlap_area(rcb, content_col):.0f}px²"
              f"｜content.x={content_col['x']:.0f} rail.right={rcb['x'] + rcb['width']:.0f}"
              if (cb and content_col and rcb) else "None")
        # 收尾：把左栏收回默认折叠态，别把展开态留给后面的组
        await set_rail_collapsed(page, True)

    # A11 点击正常：两个按钮都弹确认、取消不执行
    await run_btn.click()
    await page.wait_for_timeout(400)
    check("A11 点击重置弹二次确认", await page.locator("[data-confirm-dialog]").count() == 1)
    await page.locator("[data-confirm-cancel]").first.click()
    await page.wait_for_timeout(300)
    check("A12 取消后弹窗卸载", await page.locator("[data-confirm-dialog]").count() == 0)
    await data_btn.click()
    await page.wait_for_timeout(400)
    danger = await page.locator("[data-confirm-dialog][data-confirm-danger='1']").count()
    check("A13 彻底重置弹危险确认（红色语义）", danger == 1)
    await page.locator("[data-confirm-cancel]").first.click()
    await page.wait_for_timeout(300)


async def group_b(page):
    """B DNA 图表：节点字体放大 + 两框边框异色。"""
    print("── B DNA 字号与两框异色 ──")
    await page.goto(f"{LAB}?view=dna", wait_until="networkidle")
    await page.wait_for_timeout(1500)

    node = page.locator("[data-node]").first
    check("B1 画布存在方法节点", await node.count() == 1)
    if await node.count():
        # B2/B3 字体放大：全画布节点中存在 17px 标题与 14px 摘要（原 13/11px）
        title_ok = await page.evaluate(
            """() => [...document.querySelectorAll('[data-node] span')]
                 .some(s => getComputedStyle(s).fontSize === '17px'
                            && (s.textContent || '').trim().length >= 2)""")
        check("B2 节点标题字号 17px（原 13px）", title_ok)
        sum_ok = await page.evaluate(
            """() => [...document.querySelectorAll('[data-node] span')]
                 .some(s => getComputedStyle(s).fontSize === '14px')""")
        check("B3 节点摘要字号 14px（原 11px）", sum_ok)
        # B4 不溢出：标题行高保持 22px（若字体撑破/换行，clientHeight 会异常）
        line_ok = await page.evaluate(
            """() => [...document.querySelectorAll('[data-node] span')]
                 .filter(s => getComputedStyle(s).fontSize === '17px')
                 .every(s => Math.abs(s.clientHeight - 22) <= 3)""")
        check("B4 放大后标题行高稳定（无换行/撑破，22px±3）", line_ok)

    # ── P19：面板默认收起，先点一个画布节点把它打开 ──
    #    旧脚本直接读 [data-panel] 的边框 —— section 恒在 DOM 里（外层 wrapper
    #    高度 0），读颜色能过，但"面板打开时的样子"根本没被验到。既然产品
    #    要求变成"点节点才滑出"，断言就必须先制造这个交互。
    node_root = page.locator('[data-node="root"]').first
    if await node_root.count() == 0:
        node_root = page.locator("[data-node]").first
    await node_root.click()
    await page.wait_for_timeout(600)
    # ── P21：DNA 的详情改由**右栏 DetailRail** 承担（底部面板已从该视图删除）──
    pstate = await page.evaluate("""() => {
      const rail = document.querySelector('[data-detail-rail]');
      if (!rail) return null;
      const body = rail.querySelector('[data-detail-body]');
      return { empty: rail.getAttribute('data-detail-empty'), hasBody: !!body };
    }""")
    check("B4b 点画布节点后右栏出现详情（P21：两栏取代底部面板）",
          bool(pstate) and pstate["empty"] == "0" and pstate["hasBody"], str(pstate))

    # B5 面板边框色（P19 后"两框异色"只剩面板一侧；P21 后该面板在右栏内）
    #  ⚠️ 必须先确认面板真的存在再 evaluate —— locator 找不到元素时
    #     .evaluate 会**硬等 30 秒超时**并抛异常，把"一条断言失败"变成
    #     "整个脚本崩掉"（本轮就是这么崩的）。所以这里先数一下。
    panel_n = await page.locator("[data-detail-rail] [data-panel]").count()
    if panel_n == 0:
        check("B5 详情面板边框 = 视图浅蓝 #93c5fd", False, "右栏里没有 [data-panel]")
    else:
        panel_border = await page.locator("[data-detail-rail] [data-panel]").first.evaluate(
            "el => getComputedStyle(el).borderBottomColor")
        check("B5 详情面板边框 = 视图浅蓝 #93c5fd",
              panel_border == hex_rgb("#93c5fd"), panel_border)
    # ── 旧 B6/B7/B8 量的是 [data-zoom-out] 的父元素（缩放控件条）：
    #    「缩放条边框 = 中性灰 #9ca3af」「两框异色」「缩放条边框宽 2px」。
    #    P19 把缩放条（data-zoom-in/out/reset/fit/value）从画布上**整体删除**，
    #    #9ca3af 那一侧不存在了 → 三条断言失去对象。换成等价契约：
    #      ① 缩放条确实不再存在（删除型改动要能被持续守住）；
    #      ② P15 那条"边框宽必须写整数 2px（1.5px 会被 Chromium 取整回 1px）"
    #         的纪律挪到面板上继续看护 —— 面板才是现在唯一有彩色边框的框。
    zoom_gone = (await page.locator("[data-zoom-in]").count() == 0
                 and await page.locator("[data-zoom-out]").count() == 0
                 and await page.locator("[data-zoom-reset]").count() == 0
                 and await page.locator("[data-zoom-fit]").count() == 0
                 and await page.locator("[data-zoom-value]").count() == 0)
    check("B6 缩放控件条已删除（P19：data-zoom-* 全部不存在）",
          zoom_gone, "仍有缩放控件残留")
    # 同 B5：先确认存在再 evaluate（空 locator 会硬等 30s 然后抛异常）
    if panel_n == 0:
        check("B7 面板边框宽 2px（P15 覆写生效，整数避免 Chromium 取整退化）",
              False, "右栏里没有 [data-panel]")
    else:
        panel_bw = await page.locator("[data-detail-rail] [data-panel]").first.evaluate(
            "el => getComputedStyle(el).borderTopWidth")
        check("B7 面板边框宽 2px（P15 覆写生效，整数避免 Chromium 取整退化）",
              panel_bw == "2px", panel_bw)
    # 画布上也不该再有 logo（P19：logo 只留左栏底部与开场页）
    check("B8 画布上已无 logo（P19：data-lab-logo 不存在，logo 在左栏 data-rail-logo）",
          await page.locator("[data-lab-logo]").count() == 0
          and await page.locator("[data-rail-logo]").count() == 1,
          f"lab-logo={await page.locator('[data-lab-logo]').count()}"
          f" rail-logo={await page.locator('[data-rail-logo]').count()}")


async def group_c(page):
    """C 研究债务（P17 后：债务概览 dock 已删，断言改为删除 + 链路完好）。"""
    print("── C 研究债务：概览已删 + 画布链路完好 ──")
    await page.goto(f"{LAB}?view=debt", wait_until="networkidle")
    await page.wait_for_timeout(1500)

    dock = page.locator("[data-debt-dock]")
    check("C1 债务概览 dock 已删除（DOM 中不存在）", await dock.count() == 0)
    check("C2 页面不再出现「债务概览」文案",
          "债务概览" not in await page.evaluate("() => document.body.innerText"))

    # ── P21：债务视图改成「左 40% 列表 + 右 60% 详情」，不再有画布 ──
    rows = page.locator("[data-debt-list-item]")
    n_rows = await rows.count()
    check("C3 债务列表仍在（项 ≥1）", n_rows >= 1, f"rows={n_rows}")

    # 删除后无空白占位：左内容列占满可用高度（右栏是详情，不是空白）
    split = page.locator("[data-split-left]").first
    left_box = await split.bounding_box()
    rail_n = await page.locator("[data-detail-rail]").count()
    check("C4 债务视图是两栏（左内容列 + 右详情栏都有），无空白占位",
          bool(left_box) and left_box["height"] >= 400 and rail_n == 1,
          f"left={left_box['height']:.0f}px rail={rail_n}" if left_box else "None")

    # 点行 → 右栏详情（原 dock 承担的入口已归左侧列表独享）
    if n_rows:
        await rows.first.click()
        await page.wait_for_timeout(700)
        st = await page.evaluate("""
          () => {
            const rail = document.querySelector('[data-detail-rail]');
            if (!rail) return null;
            // P21：详情在右栏；data-panel 在想法/击穿视图才有
            const body = rail.querySelector('[data-detail-body]');
            return { empty: rail.getAttribute('data-detail-empty'),
                     hasBody: !!body,
                     text: (rail.innerText || '').trim().slice(0, 40) };
          }""")
        check("C5 点债务项 → 右栏出现债务详情",
              bool(st) and st["empty"] == "0" and st["hasBody"], str(st))
        if st and st["hasBody"]:
            await page.locator('[data-detail-rail] button[aria-label="关闭详情"]').first.click()
            await page.wait_for_timeout(500)
            st2 = await page.evaluate("""
              () => {
                const rail = document.querySelector('[data-detail-rail]');
                return rail ? rail.getAttribute('data-detail-empty') : null;
              }""")
            check("C6 关闭后右栏回到占位态（详情收回）", st2 == "1", f"empty={st2}")

    # 切视图往返：列表仍在（P21：左侧债务列表取代原画布列表）
    await page.goto(f"{LAB}?view=dna", wait_until="networkidle")
    await page.wait_for_timeout(1000)
    check("C7 非 debt 视图无债务列表（视图隔离）",
          await page.locator("[data-debt-list-item]").count() == 0)
    await page.goto(f"{LAB}?view=debt", wait_until="networkidle")
    await page.wait_for_timeout(1000)
    check("C8 回到债务视图列表恢复",
          await page.locator("[data-debt-list-item]").count() == n_rows)


async def group_d(page):
    """D 组合想法：分区异色分界线 + 三栏异字体 + 紧凑布局。"""
    print("── D 组合想法分区与字体 ──")
    await page.goto(f"{LAB}?view=idea", wait_until="networkidle")
    await page.wait_for_timeout(1500)

    wb = page.locator("[data-idea-workbench]")
    check("D1 工作台存在", await wb.count() == 1)
    if not await wb.count():
        return
    n_sec = await wb.evaluate("el => el.querySelectorAll(':scope > section').length")
    check("D2 三栏结构（3 个直接子 section）", n_sec == 3, f"n={n_sec}")

    b_r = await wb.evaluate(
        "el => getComputedStyle(el.querySelectorAll(':scope > section')[0]).borderRightColor")
    b_l = await wb.evaluate(
        "el => getComputedStyle(el.querySelectorAll(':scope > section')[2]).borderLeftColor")
    check("D3 左栏右分界线 = 浅绿 #86efac", b_r == hex_rgb("#86efac"), b_r)
    check("D4 右栏左分界线 = 浅蓝 #93c5fd", b_l == hex_rgb("#93c5fd"), b_l)
    check("D5 两条分界线颜色明显区分", b_r != b_l)

    ffs = await wb.evaluate(
        """el => [...el.querySelectorAll(':scope > section')]
                .map(s => getComputedStyle(s).fontFamily)""")
    # P18 问题 1：全局字体统一为 Inter 栈（原衬线/等宽覆盖已删除）
    check("D6 左栏使用全局字体（Inter 开头，无衬线覆盖）",
          ffs and ffs[0].startswith("Inter"), ffs[0][:40] if ffs else "")
    check("D7 中栏使用全局字体（Inter 开头，无等宽覆盖）",
          len(ffs) > 1 and ffs[1].startswith("Inter"),
          ffs[1][:40] if len(ffs) > 1 else "")
    check("D8 三栏字体一致（P18 问题 1：统一全局 Inter 栈）",
          len(ffs) == 3 and len(set(ffs)) == 1, f"distinct={len(set(ffs))}")

    # D9（P16 问题二改写）：黄粗线 → 中性细线；衬线 → 等宽（对齐中列模块池）
    dock = await wb.evaluate(
        """el => { const f = el.querySelector('[data-custom-idea-form]');
             const d = f ? f.parentElement.parentElement : null;
             if (!d) return null;
             const cs = getComputedStyle(d);
             return { top: cs.borderTopColor, w: parseFloat(cs.borderTopWidth),
                      ff: cs.fontFamily }; }""")
    check("D9 手动输入 dock 顶部为中性细线（#e5e7eb，≤1.5px）",
          dock is not None and dock["top"] == hex_rgb("#e5e7eb") and dock["w"] <= 1.5,
          f"top={dock['top'] if dock else '无'} w={dock['w'] if dock else '-'}")
    check("D9b 手动输入 dock 使用全局字体（P18 问题 1：Inter 开头）",
          dock is not None and dock["ff"].startswith("Inter"),
          (dock["ff"][:40] if dock else "无"))

    # 紧凑布局：三栏宽度铺满工作台，无大空隙
    widths = await wb.evaluate(
        """el => { const w = el.getBoundingClientRect().width;
             const secs = [...el.querySelectorAll(':scope > section')]
               .map(s => s.getBoundingClientRect().width);
             return {w, sum: secs.reduce((a, b) => a + b, 0), secs}; }""")
    fill = widths["sum"] / widths["w"] if widths["w"] else 0
    check("D10 三栏宽度铺满工作台（≥98%，无大空隙）", fill >= 0.98,
          f"sum={widths['sum']:.0f} w={widths['w']:.0f} fill={fill:.3f}")
    check("D11 每栏宽度 ≥ 120px（不塌缩）",
          all(w >= 120 for w in widths["secs"]),
          f"secs={[round(w) for w in widths['secs']]}")


async def group_e(page):
    """E 击穿色阶：相似度色单调 + 清单色条与对比面板同源。"""
    print("── E 击穿测试相似度色阶 ──")
    await page.goto(f"{LAB}?view=crashtest", wait_until="networkidle")
    await page.wait_for_timeout(1500)

    options = page.locator("[data-crash-idea-option]")
    n = await options.count()
    check("E1 击穿视图存在想法清单（seed 后 ≥4 个）", n >= 4, f"n={n}")
    if n < 3:
        return

    sim_map = {}   # ideaId -> hex
    untested_idx = []
    for i in range(n):
        el = options.nth(i)
        oid = await el.get_attribute("data-crash-idea-option")
        if await el.get_attribute("data-already-ran") == "1":
            # P19：想法清单是**单选 tab**（点第二个只留第二个选中），
            # 所以这里只读属性、不点选 —— 多选改由下面的 URL 一次性构造。
            sim_map[oid] = await el.get_attribute("data-sim-color")
        else:
            untested_idx.append(i)
    check("E2 已测想法 ≥3 个且均有相似度色", len(sim_map) >= 3,
          f"{ {k: v for k, v in sim_map.items()} }")
    untested_nocolor = True
    for i in untested_idx:
        if await options.nth(i).get_attribute("data-sim-color"):
            untested_nocolor = False
    check("E3 未测想法无相似度色（不参与）",
          len(untested_idx) >= 1 and untested_nocolor,
          f"untested={len(untested_idx)}")
    ids = list(sim_map)
    colors = list(sim_map.values())
    check("E4 已测想法色两两互异", len(set(colors)) == len(colors), f"{colors}")

    # 色相单调：找一档差对（seed 里 A-B dist=1）与多档差对（A-C dist=13）。
    # 稳健口径：任意两想法的色相差应随 seed 设计单调 —— 这里直接断言
    # 「最小色相差对 < 最大色相差对」且色相都落在算法值域 200~340。
    hues = {k: hex_hue(v) for k, v in sim_map.items()}
    pairs = [(a, b, hue_dist(hues[a], hues[b]))
             for i, a in enumerate(ids) for b in ids[i + 1:]]
    pairs.sort(key=lambda p: p[2])
    lo, hi = pairs[0], pairs[-1]
    check("E5 色相全部落在算法值域（200~340）",
          all(198 <= h <= 342 for h in hues.values()),
          f"{ {k: round(v, 1) for k, v in hues.items()} }")
    check("E6 色相差单调（最小差对 < 最大差对，且最小差 < 25°）",
          hi[2] > lo[2] and lo[2] < 25,
          f"min={lo[0][:6]}~{lo[1][:6]}:{lo[2]:.1f}° max={hi[0][:6]}~{hi[1][:6]}:{hi[2]:.1f}°")

    # 清单左色条 = sim 色
    for i in range(n):
        el = options.nth(i)
        oid = await el.get_attribute("data-crash-idea-option")
        if oid in sim_map:
            left = await el.evaluate(
                "el => getComputedStyle(el).borderLeftColor")
            lw = await el.evaluate("el => getComputedStyle(el).borderLeftWidth")
            check(f"E7 清单 {oid[-6:]} 左色条 = sim 色（3px）",
                  left == hex_rgb(sim_map[oid]) and lw == "3px",
                  f"{left} {lw}")

    # ── 对比抽屉表头色点与清单同源同色 ──
    #
    # P19 两处交互变化，多选与开面板的路径都得换：
    #   ① 想法清单收窄成**单选 tab** → "选多个"只能走 URL
    #      ?crashIdeaIds=a,b,c（readCrashIds 逐个校验存在性后恢复成集合，
    #      这条 URL 契约 P19 没变）。这里把**全部已测想法**带进 URL：
    #      抽屉里的色阶是对"选中集合"用同一个 computeIdeaColors 算的，
    #      只带一个的话走的是单想法兜底色相，两边不可比（假失败）。
    #   ② 对比面板不再是内联常驻列 → 先点左下角浮动入口
    #      [data-compare-toggle]，才渲染覆盖式抽屉 [data-compare-overlay]，
    #      里面才是 [data-compare-panel]（data-compare-* 内部钩子全保留）。
    picked_url = f"{LAB}?view=crashtest&crashIdeaIds=" + ",".join(list(sim_map))
    await page.goto(picked_url, wait_until="networkidle")
    await page.wait_for_timeout(1200)
    check("E8 选中想法后出现「想法对比」浮动入口（data-compare-toggle）",
          await page.locator("[data-compare-toggle]").count() == 1)
    await page.locator("[data-compare-toggle]").first.click()
    await page.wait_for_timeout(400)
    cmp_panel = page.locator("[data-compare-panel]")
    check("E8b 点入口后渲染覆盖式抽屉（data-compare-overlay + 面板）",
          await page.locator("[data-compare-overlay]").count() == 1
          and await cmp_panel.count() >= 1)
    if await cmp_panel.count():
        dots = page.locator("[data-compare-panel] [data-sim-color]")
        dot_n = await dots.count()
        check("E9 对比面板存在 ≥3 个相似度色点", dot_n >= 3, f"n={dot_n}")
        dot_set = set()
        for i in range(dot_n):
            c = await dots.nth(i).get_attribute("data-sim-color")
            dot_set.add(c)
        check("E10 面板色点与清单色同源（同一组 hex）",
              dot_set == set(colors), f"panel={sorted(dot_set)} list={sorted(set(colors))}")

    # 未测想法无 3px 色条
    for i in range(n):
        el = options.nth(i)
        if await el.get_attribute("data-already-ran") != "1":
            lw = await el.evaluate("el => getComputedStyle(el).borderLeftWidth")
            check(f"E11 未测想法 {await el.get_attribute('data-crash-idea-option')} 无 3px 色条",
                  lw in ("1px", "2px"), f"lw={lw}")


async def group_f(page, browser):
    """F 全局背景：画布视图图案互异 + 合规 + 跟手（P19：crashtest 已无画布）。"""
    print("── F 全局背景图案 ──")
    patterns = {}

    async def grab(view):
        await page.goto(f"{LAB}?view={view}", wait_until="networkidle")
        await page.wait_for_timeout(1000)
        # ── P21：底图的宿主变了 —— dna 仍有画布；evolution/debt 改成两栏后
        #    画布不存在了，底图落在左内容列 [data-split-left] 上。
        #    按视图选宿主，仍然给**每个**视图记一份，保证"底图两两互异"
        #    这条断言覆盖到全部视图（不是缩小范围）。 ──
        host_sel = "[data-canvas-stage]" if view == "dna" else "[data-split-left]"
        if await page.locator(host_sel).count() == 0:
            patterns[view] = {"bi": "none", "bs": "", "missing": host_sel}
            return patterns[view]
        st = await page.locator(host_sel).first.evaluate(
            """el => { const cs = getComputedStyle(el);
                 return {bi: cs.backgroundImage, bs: cs.backgroundSize}; }""")
        patterns[view] = st
        return st

    # ── P19+P21：crashtest 自 P19 起就不渲染画布；P21 又把 evolution/debt
    #    改成两栏（画布同样没了）。所以底图按"视图 → 宿主"取，
    #    crashtest 单独验它确实没有画布。 ──
    for v in ("dna", "evolution", "debt"):
        await grab(v)
    await page.goto(f"{LAB}?view=crashtest", wait_until="networkidle")
    await page.wait_for_timeout(1200)
    check("F1 crashtest 不再渲染画布，改为想法 tab 条 + 报告 dock（P19）",
          await page.locator("[data-canvas-stage]").count() == 0
          and await page.locator("[data-crash-tabs]").count() == 1
          and await page.locator("[data-crash-run-card]").count() == 1,
          f"canvas={await page.locator('[data-canvas-stage]').count()}"
          f" tabs={await page.locator('[data-crash-tabs]').count()}")
    check("F1b 三个视图（dna 画布 / evolution·debt 左内容列）都拿到底图",
          all(patterns[v].get("bi", "none") != "none"
              for v in ("dna", "evolution", "debt")),
          str({v: patterns[v].get("bi", "")[:28] for v in patterns}))

    for v, st in patterns.items():
        bi = st["bi"]
        ok_shape = ("radial-gradient" in bi) and ("linear-gradient" not in bi)
        # computed style 会把 transparent 序列化成 rgba(0,0,0,0)，需剔除后
        # 只数真实颜色 stop —— 口径对齐 verify-local 豁免判定（stops ≤ 2）
        stops = [m for m in _re.findall(r"rgba?\([^)]+\)", bi)
                 if not m.startswith("rgba(0, 0, 0, 0")]
        check(f"F2 {v} 图案合规（radial 点阵/颜色 stop ≤2/有平铺尺寸）",
              ok_shape and len(stops) <= 2 and st["bs"] not in ("", "auto"),
              f"stops={len(stops)} bs={st['bs']}")

    # 源码层面：图案颜色全 hex（零 rgba()/rgb() 函数 —— verify-local 最稳口径）
    pal_src = (ROOT / "src" / "lib" / "lab" / "palette.ts").read_text(encoding="utf-8")
    sec7 = pal_src.split("7. 视图背景图案")[1]
    src_rgba = len(_re.findall(r"rgba?\(", sec7))
    check("F2b 图案源码零 rgba()/rgb()（颜色全 hex）", src_rgba == 0,
          f"src_rgba={src_rgba}")

    # 图案点色提取与浅淡断言（hex stop 亮度 ≥ 0.8）
    for v, st in patterns.items():
        hexes = _re.findall(r"#[0-9a-fA-F]{6}", st["bi"])
        if hexes:
            bmin = min(brightness(h) for h in hexes)
            check(f"F3 {v} 图案色浅淡（亮度 ≥ 0.8，不抢内容）", bmin >= 0.8,
                  f"min={bmin:.2f} {[h for h in hexes if brightness(h) < 0.85]}")

    keys = list(patterns)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            check(f"F4 {keys[i]} 与 {keys[j]} 图案互异",
                  patterns[keys[i]]["bi"] != patterns[keys[j]]["bi"]
                  or patterns[keys[i]]["bs"] != patterns[keys[j]]["bs"])

    # 组合想法工作台 + 项目列表页
    await page.goto(f"{LAB}?view=idea", wait_until="networkidle")
    await page.wait_for_timeout(1200)
    wb_bg = await page.locator("[data-idea-workbench]").first.evaluate(
        """el => { const cs = getComputedStyle(el);
             return {bi: cs.backgroundImage, bs: cs.backgroundSize}; }""")
    check("F5 工作台有点阵底图", "radial-gradient" in wb_bg["bi"])
    check("F6 工作台图案与三个画布互异",
          all(wb_bg["bi"] != patterns[v]["bi"] or wb_bg["bs"] != patterns[v]["bs"]
              for v in patterns), "")
    patterns["workbench"] = wb_bg

    await page.goto(f"{BASE}/projects", wait_until="networkidle")
    await page.wait_for_timeout(1000)
    pg_bg = await page.evaluate(
        """() => { const el = document.querySelector('.space-y-8');
             if (!el) return {bi: 'MISSING', bs: 'auto'};
             const cs = getComputedStyle(el);
             return {bi: cs.backgroundImage, bs: cs.backgroundSize}; }""")
    check("F7 项目列表页有点阵底图", "radial-gradient" in (pg_bg["bi"] or ""),
          str(pg_bg))
    all_bis = [p["bi"] for p in patterns.values()] + [pg_bg["bi"]]
    check("F8 项目页图案与全部其他页互异",
          all_bis.count(pg_bg["bi"]) == 1, f"出现 {all_bis.count(pg_bg['bi'])} 次")

    # 跟手性：dna 视图拖拽 → backgroundPosition 变化。
    # 用合成 PointerEvent 序列（isPrimary + buttons）—— Playwright 的
    # page.mouse 在此环境下无法触发 React 的 pointer 合成事件处理（实测），
    # 而组件拖拽逻辑（两段式 capture）对真实用户操作正常。
    # 另：用全新 page 打开 —— 同 page 软导航多次后事件通路不可靠（实测）。
    page2 = await browser.new_page(viewport={"width": 1440, "height": 960})
    await page2.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
    await page2.goto(f"{LAB}?view=dna", wait_until="networkidle")
    await page2.wait_for_timeout(2000)
    pos1 = await page2.locator("[data-canvas-stage]").first.evaluate(
        "el => getComputedStyle(el).backgroundPosition")
    pos2_ack = await page2.evaluate(
        """() => {
          const stage = document.querySelector('[data-canvas-stage]');
          const r = stage.getBoundingClientRect();
          // 找一个不撞节点的空白起点（节点 onPointerDown stopPropagation 会吃掉拖拽）
          let sx = null, sy = null;
          for (let y = r.top + 40; y < r.bottom - 60 && sx === null; y += 50) {
            for (let x = r.left + 40; x < r.right - 260; x += 60) {
              const el = document.elementFromPoint(x, y);
              const blank = el && (el === stage
                || (el.tagName === 'DIV' && !el.className && stage.contains(el)));
              if (blank) { sx = x; sy = y; break; }
            }
          }
          if (sx === null) return 'NO_BLANK_SPOT';
          const mk = (type, x, y, buttons) => new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerId: 1, pointerType: 'mouse', isPrimary: true,
            button: type === 'pointermove' ? -1 : 0, buttons,
            clientX: x, clientY: y,
          });
          stage.dispatchEvent(mk('pointerdown', sx, sy, 1));
          for (let k = 1; k <= 8; k++) {
            stage.dispatchEvent(mk('pointermove', sx - k * 30, sy - k * 20, 1));
          }
          stage.dispatchEvent(mk('pointerup', sx - 240, sy - 160, 0));
          return 'dispatched@' + Math.round(sx) + ',' + Math.round(sy);
        }""")
    await page2.wait_for_timeout(250)
    # React setState 异步 commit —— 等 250ms 后重新读；dispatch 的同步返回值
    # 是 commit 前的旧值，不能作为断言依据（实测踩过）。
    pos2 = await page2.locator("[data-canvas-stage]").first.evaluate(
        "el => getComputedStyle(el).backgroundPosition")
    check("F9 拖拽画布底图跟手（backgroundPosition 变化）",
          pos1 != pos2 and str(pos2_ack).startswith("dispatched"),
          f"{pos1} -> {pos2} ({pos2_ack})")
    await page2.close()


async def main():
    ok, msg = run_seed()
    print(f"seed: {'OK' if ok else 'FAILED'} {msg[:120]}")
    if not ok:
        print("seed 失败，终止（后续断言依赖 A/B/C 已测 + D 未测数据）")
        sys.exit(2)

    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1440, "height": 960})
        await page.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        await group_a(page)
        await group_b(page)
        await group_c(page)
        await group_d(page)
        await group_e(page)
        await group_f(page, browser)

        await browser.close()

    print(f"\nconsole 错误: {len(errors)}")
    for e in errors[:5]:
        print(f"  ! {e[:160]}")
    check("G1 全程零 console 错误", len(errors) == 0, "; ".join(errors[:2]))

    print(f"\n===== P15 六项验收: {CHECKS - len(FAILS)}/{CHECKS} 通过 =====")
    if FAILS:
        print("失败项:")
        for f in FAILS:
            print(f"  - {f}")
        sys.exit(1)


asyncio.run(main())
