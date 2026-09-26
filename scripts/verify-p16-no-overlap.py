#!/usr/bin/env python3
"""
verify-p16-no-overlap.py —— P16「三问题」专项验收（零模型调用）。

覆盖（对应用户 P16 三个问题）：
  A 静态遍历   dna/evolution/debt/idea/crashtest 五视图 + 展开左栏 dna +
               窄视口(1024) crashtest：页面全部可见交互元素
               （button/a/input/textarea/select）两两 boundingBox 相交检测，
               嵌套父子豁免、≤2px 渗出豁免；模态弹窗（按设计覆盖）豁免
  B 浮层开合   ConfirmDialog 卸载后下层立即可命中；手术模式提示不挡上传
               按钮；AI 对话默认折叠 → 由右下角浮标展开（P19）；
               对比抽屉（P19：先点 [data-compare-toggle] 才渲染 [data-compare-overlay]，
               里面才是 [data-compare-panel]）；
               收尾无残留全屏遮罩（fixed 大面积元素）
  C 高度变化   dna 点节点 → BottomPanel 挤出后画布仍在（P19：缩放条与画布上的
               logo 已整体删除 → 改为断言"确实不存在 + logo 迁到左栏"）；
               debt 点债务行 → 详情面板挤出（P17 后无债务概览 dock）；
  D 快速切换   五视图 3 轮快速连点 + 左栏两次展开/折叠，零 console 错误
  E 重置新位置（P19 口径）cluster ⊆ 顶栏 [data-top-bar]、左栏展开态那份位于击穿测试
               步骤正下方、与内容列零重叠；
               尺寸原值（字号 12/图标 13/分隔线 16）；点击弹二次确认；
               折叠态 ↺ mini 按钮（P19 里默认就是折叠态）存在且可用

── P19 布局（为什么本脚本的选择器这么写）──
  · 右栏 RightToolbar 已整体删除；导航改成**默认折叠 48px** 的左侧栏
    <aside data-nav>：折叠态只有单字字形（结/演/债/合/试）+ ↺ + logo，
    没有任何中文标签 → 一律按 data-view id 定位，绝不按文字找按钮。
  · data-view-step / data-view-state / 步骤文字只在**展开态（248px）**渲染，
    所以凡是要读"步骤编号 / 状态"的地方，先展开左栏。
  · [data-view] 在顶栏下拉里还有一份（只有菜单打开时才有 DOM）；左栏那份
    常驻 —— 菜单默认关着，所以 .first 命中的是左栏。
  · [data-reset-cluster] 现在有**两份**：顶栏右侧动作区（.first）与左栏
    展开态的「设置」区（.nth(1)）。

前置：3000 端口 dev server；playwright chromium；脚本先跑 verify-p15-seed.mjs
（幂等：清空后重建 3 已测 + 1 未测想法，供 crashtest 视图浮层渲染）。
用法：python3 scripts/verify-p16-no-overlap.py
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
    print(f"[{mark}] {name}" + (f"  ({detail})" if detail else ""))
    if not ok:
        FAILS.append(name)


def hex_rgb(h):
    h = h.lstrip("#")
    return f"rgb({int(h[0:2], 16)}, {int(h[2:4], 16)}, {int(h[4:6], 16)})"


# 页面内执行的交互元素重叠扫描。
# 返回 {n: 元素数, overlaps: [{a, b, ox, oy}]}。
#
# 豁免口径（与产品语义对齐，报告中有记录）：
#   1. 模态弹窗 [data-confirm-dialog] 子树 —— 按设计覆盖全页；
#   2. 父子嵌套（DOM contains）—— 同一控件的内部结构；
#   3. ≤2px 渲染渗出 —— 亚像素取整噪声；
#   4. 恰有一方在 [data-canvas-layer]（画布 transform 内容层）内：
#      a) 内容层被 stage 的 overflow:hidden 裁剪，bbox 越界 ≠ 视觉越界
#         （节点铺满内容层、fit 缩放后 rect 可延伸到右栏下方）；
#      b) 画布内容可拖拽平移，缩放条/运行卡等浮动控件覆盖内容
#         属既有设计（同一展示区内部，非"其他区域"）。
#      双方都在内容层外的配对（右栏/底部面板/各 dock/浮层彼此）
#      仍然全量检测 —— 这才是"展示区互相遮挡"的对象。
#   5. 滚动裁切（P18 问题 3b 后新增）—— 想法清单是 overflow-y-auto +
#      max-h-24vh 的滚动容器：被裁掉的列表项 getBoundingClientRect 仍返回
#      完整几何（视觉上不可见），与容器下方元素产生"虚假相交"。判定时把
#      交集矩形依次 clip 到双方全部 overflow 祖先的可见盒内，clip 完消失
#      的不算交叠（真实可见交叠仍会命中）。
#
# ⚠ P19 需知：crashtest 视图里右下角浮标 [data-explore-fab]（absolute
#   bottom-3 right-3，浮在内容列上）与底部的 AI 对话 dock 在几何上是**叠**
#   的（dock 标题行 px-3 的右缘 = 浮标 right-3 的右缘，垂直方向也相交）。
#   本扫描不为此加豁免 —— 如果它报出 button[data-explore-fab] ×
#   select[data-chat-idea-select] 的交叠，那是**真阳性**（浮标压住了 dock
#   右下的控件），属于 src/ 里的布局问题，不该靠改脚本来掩盖。
SCAN_JS = """
() => {
  const sel = 'button, a, input, textarea, select';
  const els = [...document.querySelectorAll(sel)].filter(el => {
    if (el.closest('[data-confirm-dialog]')) return false;  // 豁免 1
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return true;
  });
  const items = els.map(el => {
    const r = el.getBoundingClientRect();
    let name = el.tagName.toLowerCase();
    for (const a of el.attributes) {
      if (a.name === 'data-node') { name += `#${a.value.slice(0, 20)}`; break; }
      if (a.name.startsWith('data-') && a.name !== 'data-picked') {
        name += `[${a.name}]`; break;
      }
    }
    const t = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 14);
    return { name: name + (t ? `「${t}」` : ''), x: r.x, y: r.y, w: r.width, h: r.height,
             inLayer: !!el.closest('[data-canvas-layer]'), el };
  });
  // 豁免 5 辅助：把交集矩形 clip 到元素全部 overflow 祖先的可见盒。
  // 任一步 clip 后交集消失（≤2px）→ 交叠是滚动裁切造成的假阳性。
  const clipToScrollAncestors = (el, rect) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      const ov = cs.overflow + ' ' + cs.overflowX + ' ' + cs.overflowY;
      if (/auto|scroll|hidden/.test(ov)) {
        const pr = p.getBoundingClientRect();
        const cx = Math.max(rect.x, pr.x), cy = Math.max(rect.y, pr.y);
        const cw = Math.min(rect.x + rect.w, pr.x + pr.width) - cx;
        const ch = Math.min(rect.y + rect.h, pr.y + pr.height) - cy;
        if (cw <= 2 || ch <= 2) return null;
        rect = { x: cx, y: cy, w: cw, h: ch };
      }
      p = p.parentElement;
    }
    return rect;
  };
  const overlaps = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;      // 豁免 2
      if (A.inLayer !== B.inLayer) continue;                         // 豁免 4
      const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      if (ox > 2 && oy > 2) {                                        // 豁免 3
        // 豁免 5：clip 到双方滚动祖先可见盒后再判
        let vis = { x: Math.max(A.x, B.x), y: Math.max(A.y, B.y), w: ox, h: oy };
        vis = clipToScrollAncestors(A.el, vis);
        if (vis) vis = clipToScrollAncestors(B.el, vis);
        if (vis && vis.w > 2 && vis.h > 2) {
          overlaps.push({ a: A.name, b: B.name, ox: Math.round(vis.w), oy: Math.round(vis.h) });
        }
      }
    }
  }
  return { n: items.length, overlaps };
}
"""

# elementFromPoint 命中检测：点 (x,y) 的最顶层元素是否落在 expect 选择器
# 的子树内（下层立即可点击 = 关闭浮层后命中本体而非残留遮罩）。
HIT_JS = """
([sel]) => {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, why: 'no-element' };
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { ok: !!hit && el.contains(hit),
           hit: hit ? (hit.tagName + (hit.className && typeof hit.className === 'string'
             ? '.' + hit.className.split(' ').slice(0, 2).join('.') : '')) : 'none' };
}
"""


def overlap_area(a, b):
    """两个矩形（boundingBox 字典）的相交面积。0 = 零重叠。"""
    if not a or not b:
        return 0.0
    ox = max(0.0, min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]))
    oy = max(0.0, min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]))
    return ox * oy


async def set_rail_collapsed(page, collapsed: bool, settle=450):
    """把左侧导航栏切到指定开合态（P19：默认折叠 48px / 展开 248px）。

    为什么需要它：data-view-step / data-view-state / 步骤文字**只在展开态渲染**，
    cluster 的第二份也只在展开态存在 —— 断言前先把状态摆正，
    否则量到的是空集合（那是脚本自己在错误前提下量，不是产品缺陷）。
    """
    cur = await page.locator("[data-nav]").first.get_attribute("data-nav-collapsed")
    if (cur == "1") != collapsed:
        await page.locator("[data-rail-toggle]").first.click()
        await page.wait_for_timeout(settle)
    return await page.locator("[data-nav]").first.get_attribute("data-nav-collapsed")


def run_seed():
    r = subprocess.run(
        ["node", "scripts/verify-p15-seed.mjs"],
        cwd=str(ROOT), capture_output=True, text=True, timeout=120,
    )
    return r.returncode == 0, (r.stdout + r.stderr).strip()


async def scan_view(page, label, timeout=1200):
    """在一个已就位的视图上跑 A 组扫描并断言零重叠。"""
    await page.wait_for_timeout(timeout)
    res = await page.evaluate(SCAN_JS)
    if res["overlaps"]:
        for o in res["overlaps"][:6]:
            print(f"      ✗ {o['a']} × {o['b']} (交叠 {o['ox']}x{o['oy']}px)")
    check(f"A {label}：{res['n']} 个交互元素两两零重叠",
          len(res["overlaps"]) == 0,
          f"n={res['n']} overlaps={len(res['overlaps'])}")


async def main():
    print("=" * 64)
    print("P16 三问题验收（重置位置 / 组合想法样式 / 全局无遮挡）")
    print("=" * 64)

    ok, out = run_seed()
    check("前置 seed 想法（3 已测 + 1 未测）", ok, out.splitlines()[-1] if out else "")
    if not ok:
        return 1

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        errors: list[str] = []
        page = await browser.new_page(viewport={"width": 1440, "height": 950})
        await page.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        # ══════════ A. 静态遍历：五视图 + 两个变体 ══════════
        print("── A 静态遍历：交互元素两两零重叠 ──")
        for view in ["dna", "evolution", "debt", "idea", "crashtest"]:
            await page.goto(f"{LAB}?view={view}", wait_until="networkidle")
            await scan_view(page, f"{view} 视图(1440)", timeout=1500)

        # A 变体 1：左栏**展开态**（248px：流程步骤 + 论文列表 + 第二份重置簇）
        #   注意 P19 的默认态就是折叠态 —— 上面五视图那一轮扫的已经是折叠态，
        #   这里点一下 [data-rail-toggle] 才是"展开"，扫完再点回来。
        await page.goto(f"{LAB}?view=dna", wait_until="networkidle")
        await page.wait_for_timeout(1200)
        state = await set_rail_collapsed(page, False)
        check("A 左栏展开态就位（data-nav-collapsed=0）", state == "0", f"state={state}")
        await scan_view(page, "dna 视图·左栏展开态", timeout=500)
        state = await set_rail_collapsed(page, True)
        check("A 左栏回到折叠态（data-nav-collapsed=1）", state == "1", f"state={state}")

        # A 变体 2：窄视口 crashtest（浮层最密：run-card + compare + chat）
        page_n = await browser.new_page(viewport={"width": 1024, "height": 800})
        await page_n.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
        page_n.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        await page_n.goto(f"{LAB}?view=crashtest", wait_until="networkidle")
        await scan_view(page_n, "crashtest 视图(1024 窄视口)", timeout=1500)
        await page_n.close()

        # ══════════ B. 浮层开合 ══════════
        print("── B 浮层开合 ──")

        # B1 ConfirmDialog：开 → 取消 → 卸载 → 下层立即可命中
        await page.goto(f"{LAB}?view=dna", wait_until="networkidle")
        await page.wait_for_timeout(1200)
        await page.locator("[data-reset-run]").first.click()
        await page.wait_for_timeout(400)
        check("B1 重置点击弹二次确认",
              await page.locator("[data-confirm-dialog]").count() == 1)
        await page.locator("[data-confirm-cancel]").first.click()
        await page.wait_for_timeout(250)
        check("B1 取消后弹窗卸载",
              await page.locator("[data-confirm-dialog]").count() == 0)
        hit = await page.evaluate(HIT_JS, ['[data-view="debt"]'])
        check("B1 弹窗关闭后下层按钮立即可命中", hit["ok"], str(hit))
        # 残留遮罩扫描：无 fixed 且面积 ≥ 视口 80% 的元素
        residual = await page.evaluate("""
          () => [...document.querySelectorAll('body *')].filter(el => {
            const cs = getComputedStyle(el);
            if (cs.position !== 'fixed') return false;
            const r = el.getBoundingClientRect();
            return r.width * r.height >= innerWidth * innerHeight * 0.8;
          }).length""")
        check("B1 关闭后无残留全屏遮罩", residual == 0, f"fixed 大面积元素 {residual} 个")

        # B2 手术模式：提示条出现但不挡上传按钮；退出后提示消失
        surgery = await page.locator("[data-surgery-toggle]").count()
        check("B2 dna 视图存在手术按钮", surgery == 1, f"count={surgery}")
        if surgery:
            await page.locator("[data-surgery-toggle]").first.click()
            await page.wait_for_timeout(400)
            check("B2 手术模式提示条出现",
                  await page.locator("[data-surgery-hint]").count() == 1)
            # P19：顶栏也新加了一枚上传按钮 → [data-upload-toggle] 有 2 个。
            # 这一节问的是"手术提示条会不会挡住**画布上**的上传按钮"，
            # 所以必须限定在 [data-canvas-stage] 内取（否则命中的是顶栏那枚
            # —— 它在页头、永远不会被画布内的提示条挡住，断言会恒真）。
            hit_up = await page.evaluate(HIT_JS, ['[data-canvas-stage] [data-upload-toggle]'])
            check("B2 手术模式下上传按钮仍可命中", hit_up["ok"], str(hit_up))
            hint_box = await page.locator("[data-surgery-hint]").first.bounding_box()
            up_box = await page.locator(
                "[data-canvas-stage] [data-upload-toggle]").first.bounding_box()
            no_cover = (hint_box and up_box and (
                hint_box["x"] + hint_box["width"] <= up_box["x"] + 1
                or up_box["x"] + up_box["width"] <= hint_box["x"] + 1
                or hint_box["y"] + hint_box["height"] <= up_box["y"] + 1
                or up_box["y"] + up_box["height"] <= hint_box["y"] + 1))
            check("B2 手术提示与上传按钮零重叠", bool(no_cover),
                  f"hint={hint_box} upload={up_box}")
            await scan_view(page, "dna 视图·手术模式", timeout=300)
            await page.locator("[data-surgery-toggle]").first.click()
            await page.wait_for_timeout(300)
            check("B2 退出手术模式后提示条消失",
                  await page.locator("[data-surgery-hint]").count() == 0)

        # B3+D 前置：crashtest 视图，选 2 个**已测**想法 → 对比抽屉可 diff
        #
        # P19 两处交互变化，必须按新交互写：
        #   ① 想法清单从"多选"收窄成"单选 tab"：点第二个 tab 只留第二个选中，
        #      所以"选 2 个"只能走 URL ?crashIdeaIds=a,b（readCrashIds 逐个校验
        #      存在性后恢复成多选集合 —— 这条 URL 契约 P19 没变）。
        #   ② 对比面板不再是内联常驻列：要先点 [data-compare-toggle]，
        #      才渲染覆盖式抽屉 [data-compare-overlay]，里面才是
        #      [data-compare-panel]（data-compare-* 的内部钩子全部保留）。
        await page.goto(f"{LAB}?view=crashtest", wait_until="networkidle")
        await page.wait_for_timeout(1500)
        opts = page.locator("[data-crash-idea-option]")
        n_opts = await opts.count()
        check("B3 seed 后存在想法选项", n_opts >= 2, f"n={n_opts}")
        tested_ids = await page.evaluate(
            """() => [...document.querySelectorAll('[data-crash-idea-option][data-already-ran="1"]')]
                 .map(b => b.getAttribute('data-crash-idea-option'))""")
        check("B3 seed 后存在 ≥2 个已测想法（diff 模式的前置）",
              len(tested_ids) >= 2, f"tested={len(tested_ids)}")
        if len(tested_ids) >= 2:
            await page.goto(f"{LAB}?view=crashtest&crashIdeaIds=" + ",".join(tested_ids[:2]),
                            wait_until="networkidle")
            await page.wait_for_timeout(1200)
            check("B3 选中想法后出现「想法对比」浮动入口（data-compare-toggle）",
                  await page.locator("[data-compare-toggle]").count() == 1)
            await page.locator("[data-compare-toggle]").first.click()
            await page.wait_for_timeout(400)
            check("B3 点入口后渲染覆盖式抽屉（data-compare-overlay）",
                  await page.locator("[data-compare-overlay]").count() == 1)
            cmp_n = await page.locator("[data-compare-panel]").count()
            check("B3 抽屉内对比面板出现", cmp_n == 1, f"count={cmp_n}")
            if cmp_n:
                # 多选真的恢复了：表头按每个选中想法各出一列色点
                cols = await page.locator("[data-compare-idea-color]").count()
                check("B3 对比面板按 2 个选中想法各出一列（多选恢复）",
                      cols == 2, f"cols={cols}")
                # 模式切换（纯前端）不报错、面板仍 1 个
                await page.locator("[data-compare-mode-diff]").first.click()
                await page.wait_for_timeout(300)
                check("B3 切 diff 模式正常",
                      await page.locator("[data-compare-panel]").count() == 1
                      and await page.locator("[data-compare-panel]").first.get_attribute(
                          "data-compare-mode") == "diff")
                await scan_view(page, "crashtest 视图·diff 模式", timeout=300)
                await page.locator("[data-compare-mode-full]").first.click()
                await page.wait_for_timeout(300)
                # 关掉抽屉：它是覆盖层，留着会挡住中栏的点击（后面还有 C 组断言）
                if await page.locator("[data-compare-close]").count():
                    await page.locator("[data-compare-close]").first.click()
                    await page.wait_for_timeout(300)
                    check("B3 关闭后抽屉卸载",
                          await page.locator("[data-compare-overlay]").count() == 0)
        else:
            check("B3 选中想法后出现「想法对比」浮动入口（data-compare-toggle）",
                  False, "已测想法不足 2 个，无法验 diff")

        # B4 ChatPanel 折叠/展开
        # ── P19：AI 对话**默认折叠**，开关移到右下角浮标
        #    「与MethodAtlas共同探索」[data-explore-fab]。
        #    旧断言的顺序（"点一下变折叠"）已经不成立 —— 默认就是折叠的，
        #    所以改成：默认折叠 → 点浮标展开 → 点标题行折叠钮收回。
        chat = await page.locator("[data-crash-chat]").count()
        check("B4 AI 对话框存在", chat == 1)
        if chat:
            collapsed0 = await page.locator("[data-crash-chat]").first.get_attribute(
                "data-collapsed")
            check("B4 AI 对话框默认折叠（data-collapsed=1）", collapsed0 == "1", collapsed0)
            check("B4 右下角有「共同探索」浮标（data-explore-fab）",
                  await page.locator("[data-explore-fab]").count() == 1)
            await page.locator("[data-explore-fab]").first.click()
            await page.wait_for_timeout(350)
            collapsed1 = await page.locator("[data-crash-chat]").first.get_attribute(
                "data-collapsed")
            check("B4 点浮标后展开（data-collapsed=0）", collapsed1 == "0", collapsed1)
            hit_chat = await page.evaluate(HIT_JS, ['[data-chat-input]'])
            check("B4 展开后输入框可命中", hit_chat["ok"], str(hit_chat))
            await scan_view(page, "crashtest 视图·chat 展开", timeout=300)
            await page.locator("[data-chat-collapse]").first.click()
            await page.wait_for_timeout(350)
            collapsed2 = await page.locator("[data-crash-chat]").first.get_attribute(
                "data-collapsed")
            check("B4 标题行的折叠钮能收回（data-collapsed=1）", collapsed2 == "1", collapsed2)

        # ══════════ C. 高度变化 ══════════
        print("── C 高度变化 ──")

        # C1 dna：点节点 → BottomPanel 挤出
        await page.goto(f"{LAB}?view=dna", wait_until="networkidle")
        await page.wait_for_timeout(1500)
        node = page.locator("[data-node]").first
        if await node.count():
            await node.click()
            await page.wait_for_timeout(600)
            # ── P21：DNA 详情在右栏 DetailRail（底部面板已从该视图删除）──
            rail_state = await page.evaluate("""() => {
              const rail = document.querySelector('[data-detail-rail]');
              if (!rail) return null;
              return { empty: rail.getAttribute('data-detail-empty'),
                       hasBody: !!rail.querySelector('[data-detail-body]') };
            }""")
            check("C1 点节点后右栏出现详情（P21 两栏）",
                  bool(rail_state) and rail_state["empty"] == "0" and rail_state["hasBody"],
                  str(rail_state))
            overflow = await page.evaluate(
                "() => document.documentElement.scrollHeight - innerHeight")
            check("C1 面板挤出后整页无滚动（≤2px 余量）", overflow <= 2,
                  f"scrollHeight 超出 {overflow}px")
            # ── P19：旧断言「缩放条仍在画布列内」失去对象 ──
            #    缩放条（data-zoom-in/out/reset/fit/value）与画布上的 logo
            #    （data-lab-logo）已被产品**整体删除**（"logo 和缩放条从画布
            #    移走"），[data-zoom-fit] 的 boundingBox 恒为 None。
            #    换成两条等价契约：① 它们确实不在 DOM 里（删除型改动要能被
            #    持续守住，防止被谁"顺手加回来"）；② logo 的新家在左栏底部
            #    [data-rail-logo]，仍然在页面上（不是把 logo 弄丢了）。
            zoom_gone = (await page.locator("[data-zoom-in]").count() == 0
                         and await page.locator("[data-zoom-out]").count() == 0
                         and await page.locator("[data-zoom-reset]").count() == 0
                         and await page.locator("[data-zoom-fit]").count() == 0
                         and await page.locator("[data-zoom-value]").count() == 0)
            check("C1 缩放条已从画布删除（P19：data-zoom-* 全部不存在）",
                  zoom_gone, "仍有缩放控件残留")
            check("C1 画布上已无 logo，logo 迁到左栏底部（data-rail-logo）",
                  await page.locator("[data-lab-logo]").count() == 0
                  and await page.locator("[data-rail-logo]").count() == 1,
                  f"lab-logo={await page.locator('[data-lab-logo]').count()}"
                  f" rail-logo={await page.locator('[data-rail-logo]').count()}")
            await scan_view(page, "dna 视图·详情展开", timeout=300)
            # 关闭详情（右栏头部的 ✕）。P21 的收起语义 = 右栏回到占位态
            # （data-detail-empty=1 且有 [data-detail-placeholder]）。
            close_n = await page.locator(
                '[data-detail-rail] button[aria-label="关闭详情"]').count()
            if close_n:
                await page.locator(
                    '[data-detail-rail] button[aria-label="关闭详情"]').first.click()
                await page.wait_for_timeout(450)
                wrap = await page.evaluate("""() => {
                  const rail = document.querySelector('[data-detail-rail]');
                  return rail ? { empty: rail.getAttribute('data-detail-empty'),
                                  hasPh: !!rail.querySelector('[data-detail-placeholder]') } : null;
                }""")
                check("C1 关闭详情后右栏回到占位态",
                      wrap and wrap["empty"] == "1" and wrap["hasPh"], str(wrap))

        # C2 debt（P17 后：债务概览 dock 已删）—— 画布列表承担全部债务入口，
        # 点行 → 详情面板，验证"面板挤出后画布仍可用、无空白占位"
        await page.goto(f"{LAB}?view=debt", wait_until="networkidle")
        await page.wait_for_timeout(1500)
        check("C2 debt 视图无债务概览 dock",
              await page.locator("[data-debt-dock]").count() == 0)
        # ── P21：债务视图 = 左 40% 列表 + 右 60% 详情，不再有画布 ──
        rows = page.locator("[data-debt-list-item]")
        n_rows = await rows.count()
        check("C2 左侧债务列表存在", n_rows >= 1, f"rows={n_rows}")
        if n_rows:
            await rows.first.click()
            await page.wait_for_timeout(700)
            left_box = await page.locator("[data-split-left]").first.bounding_box()
            check("C2 详情展开后左内容列仍有高度（两栏并列，不是遮挡）",
                  left_box and left_box["height"] >= 100,
                  f"left={left_box['height']:.0f}px" if left_box else "None")
            await scan_view(page, "debt 视图·详情展开", timeout=300)
            hit_row = await page.evaluate(HIT_JS, ['[data-debt-list-item]'])
            check("C2 详情展开后债务项仍可命中", hit_row["ok"], str(hit_row))
            await page.locator('[data-detail-rail] button[aria-label="关闭详情"]').first.click()
            await page.wait_for_timeout(400)

        # C3 crashtest：默认态（P19 起 AI 讨论默认折叠）无溢出
        await page.goto(f"{LAB}?view=crashtest", wait_until="networkidle")
        await page.wait_for_timeout(1500)
        overflow_c = await page.evaluate(
            "() => document.documentElement.scrollHeight - innerHeight")
        check("C3 crashtest 默认态整页无滚动", overflow_c <= 2,
              f"超出 {overflow_c}px")

        # ══════════ D. 快速切换零报错 ══════════
        print("── D 快速切换 ──")
        errors.clear()
        for _ in range(3):
            for v in ["dna", "evolution", "debt", "idea", "crashtest"]:
                await page.locator(f'[data-view="{v}"]').first.click()
                await page.wait_for_timeout(150)
        await page.locator("[data-rail-toggle]").first.click()
        await page.wait_for_timeout(250)
        await page.locator("[data-rail-toggle]").first.click()
        await page.wait_for_timeout(250)
        check("D 五视图 3 轮连点 + 左栏展开/折叠两次：零 console 错误",
              len(errors) == 0, str(errors[:3]))
        cur = await page.evaluate("() => new URLSearchParams(location.search).get('view')")
        check("D 最终视图停在 crashtest", cur == "crashtest", f"view={cur}")

        # ══════════ E. 重置新位置（P19 口径）══════════
        print("── E 重置簇新位置 ──")
        await page.goto(f"{LAB}?view=dna", wait_until="networkidle")
        await page.wait_for_timeout(1200)
        cluster = page.locator("[data-reset-cluster]").first   # .first = 顶栏那份
        cb = await cluster.bounding_box()
        topbar = await page.locator("[data-top-bar]").first.bounding_box()
        content = await page.locator("[data-lab-body] > div").first.bounding_box()
        # ── P19：重置簇从"右栏工具栏内、击穿测试按钮正下方、画布右侧"
        #    改成"顶栏右侧动作区"（左栏展开态另有一份，同一条确认链路）。
        #    旧三条地理断言全部失去对象：右栏已删 / cluster 现在在顶栏 /
        #    画布列现在在左栏**右边**（"cluster 在画布右侧"从恒真变成恒假）。
        #    换成同样能抓回归的新契约：
        #      ① 顶栏那份完全落在 [data-top-bar] 内（不会溢出去压内容区）
        #      ② 左栏展开后有自己的那份，且位于最后一个流程步骤（击穿测试）下方
        #      ③ 顶栏那份与内容列**矩形相交面积为 0**（不是只看 x ——
        #         顶栏与内容列在 x 上本来就重叠，靠 y 分离，所以必须算面积）
        check("E1 cluster ⊆ 顶栏 [data-top-bar]",
              all([cb, topbar]) and cb["x"] >= topbar["x"] - 1
              and cb["y"] >= topbar["y"] - 1
              and cb["x"] + cb["width"] <= topbar["x"] + topbar["width"] + 1
              and cb["y"] + cb["height"] <= topbar["y"] + topbar["height"] + 1,
              f"cluster=({cb['x']:.0f},{cb['y']:.0f},{cb['width']:.0f}x{cb['height']:.0f})"
              f" topbar={topbar}")
        state = await set_rail_collapsed(page, False)
        n_clusters = await page.locator("[data-reset-cluster]").count()
        check("E2 左栏展开后出现第二份重置簇（顶栏 + 左栏 = 2）",
              state == "0" and n_clusters == 2, f"state={state} n={n_clusters}")
        rcb = (await page.locator("[data-reset-cluster]").nth(1).bounding_box()
               if n_clusters == 2 else None)
        crash_btn = await page.locator('[data-nav] [data-view="crashtest"]').first.bounding_box()
        check("E2 左栏那份位于击穿测试步骤正下方",
              all([rcb, crash_btn])
              and rcb["y"] >= crash_btn["y"] + crash_btn["height"] - 1,
              f"y={rcb['y']:.0f} ≥ crash.bottom={crash_btn['y'] + crash_btn['height']:.0f}"
              if rcb and crash_btn else "None")
        check("E3 cluster 与内容列零重叠（矩形相交面积 = 0）",
              overlap_area(cb, content) <= 1,
              f"重叠 {overlap_area(cb, content):.0f}px²")
        fs = await page.locator("[data-reset-run]").first.evaluate(
            "el => getComputedStyle(el).fontSize")
        icon_fs = await page.locator("[data-reset-run] span").first.evaluate(
            "el => getComputedStyle(el).fontSize")
        sep_h = await cluster.evaluate(
            "el => { const s = el.querySelector('span.bg-line');"
            "return s ? getComputedStyle(s).height : '' }")
        check("E4 尺寸原值：字号 12 / 图标 13 / 分隔线 16",
              fs == "12px" and icon_fs == "13px" and sep_h == "16px",
              f"{fs}/{icon_fs}/{sep_h}")
        await page.locator("[data-reset-run]").first.click()
        await page.wait_for_timeout(400)
        check("E5 点击重置弹二次确认",
              await page.locator("[data-confirm-dialog]").count() == 1)
        await page.locator("[data-confirm-cancel]").first.click()
        await page.wait_for_timeout(250)
        # 折叠态 mini 按钮（P19：默认态就是折叠态，这里先把 E2 展开的栏收回去）
        state = await set_rail_collapsed(page, True)
        check("E6 左栏回到折叠态（mini 按钮的前置）", state == "1", f"state={state}")
        mini = await page.locator("[data-reset-cluster-mini]").count()
        check("E6 折叠态存在 ↺ mini 重置按钮", mini == 1, f"count={mini}")
        if mini:
            mb = await page.locator("[data-reset-cluster-mini]").first.bounding_box()
            check("E6 mini 按钮为 32px 方形",
                  mb and abs(mb["width"] - 32) <= 2 and abs(mb["height"] - 32) <= 2,
                  f"{mb['width']:.0f}x{mb['height']:.0f}" if mb else "None")
            await page.locator("[data-reset-cluster-mini]").first.click()
            await page.wait_for_timeout(400)
            check("E6 mini 按钮点击弹二次确认",
                  await page.locator("[data-confirm-dialog]").count() == 1)
            await page.locator("[data-confirm-cancel]").first.click()
            await page.wait_for_timeout(250)

        # ══════════ 收尾：全程零 console 错误 ══════════
        check("F 全程零 console 错误", len(errors) == 0, str(errors[:3]))

        await browser.close()

    print()
    print(f"共 {CHECKS} 项，失败 {len(FAILS)} 项")
    if FAILS:
        for f in FAILS:
            print(f"  ✗ {f}")
        return 1
    print("✓ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
