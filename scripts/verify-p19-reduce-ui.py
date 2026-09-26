"""P19 界面减展示改造 —— 专项验收（零模型调用，约 40 秒）。

覆盖本轮 14 项要求：
  问题1 折叠箭头方向        问题2 logo 移出画布        问题3 击穿视图 ≤3 层框
  细节1 开场页渐变按钮      细节2 缩放条已移出         细节3 状态色四档统一
  细节4 placeholder 加深    细节5 文案修正             细节6 AI placeholder 缩短
  减展示1 顶部一行          减展示2 左栏默认折叠       减展示3 无右栏/画布占满
  减展示4 底部面板默认折叠  减展示5 右下浮动按钮        第四部分 开场页纯白

前置：
  · 3000 端口有 next dev/start 在跑（可用 MA_PORT 覆盖）
  · 库里有 3 篇论文（baseline），无需生成想法 —— 需要想法的断言会自动跳过
  · pip 装好 playwright 且已有 chromium / 或设 MA_CHROME 指向本机 Chrome

用法：
  python scripts/verify-p19-reduce-ui.py
"""
import os
import sys

from playwright.sync_api import sync_playwright

PORT = os.environ.get("MA_PORT", "3000")
BASE = f"http://127.0.0.1:{PORT}/projects/cmu9my2ie0000z6pko5sqr27s/lab"
CHROME = os.environ.get("MA_CHROME")  # 可选：本机 Chrome 可执行文件路径

PASS = 0
FAIL = 0
SKIP = 0
FAILURES = []


def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {name}" + (f"  [{detail}]" if detail else ""))
    else:
        FAIL += 1
        FAILURES.append(name)
        print(f"  FAIL  {name}  [{detail}]")


def skip(name, why):
    global SKIP
    SKIP += 1
    print(f"  SKIP  {name}  ({why})")


def section(t):
    print("\n" + "=" * 68)
    print(t)
    print("=" * 68)


def main():
    launch_kwargs = {}
    if CHROME:
        launch_kwargs["executable_path"] = CHROME

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs)
        ctx = browser.new_context(viewport={"width": 1440, "height": 950})
        # 除开场页专项外，一律跳过开场页
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text()) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        def goto(view, extra=""):
            page.goto(f"{BASE}?view={view}{extra}", wait_until="domcontentloaded")
            page.wait_for_timeout(1200)

        # ── 第四部分 + 细节 1：开场页 ──
        section("第四部分 / 细节1：开场页纯白 + 蓝紫渐变按钮")
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_selector("[data-intro-page]", timeout=25000)
        page.wait_for_timeout(500)
        intro = page.evaluate(
            """() => {
              const el = document.querySelector('[data-intro-page]');
              const btn = document.querySelector('[data-intro-start]');
              const bs = getComputedStyle(btn);
              return {
                introBg: getComputedStyle(el).backgroundColor,
                bodyBg: getComputedStyle(document.body).backgroundColor,
                btnImg: bs.backgroundImage,
                btnColor: bs.color,
              };
            }"""
        )
        check("开场页背景纯白 #ffffff", intro["introBg"] == "rgb(255, 255, 255)", intro["introBg"])
        check("body 背景纯白 #ffffff", intro["bodyBg"] == "rgb(255, 255, 255)", intro["bodyBg"])
        check(
            "开始探索按钮为蓝紫渐变（非纯深蓝）",
            "linear-gradient" in intro["btnImg"] and "124, 58, 237" in intro["btnImg"],
            intro["btnImg"][:70],
        )
        check("按钮文字白色", intro["btnColor"] == "rgb(255, 255, 255)", intro["btnColor"])

        # 交叉淡入淡出 + 会话内跳过
        page.locator("[data-intro-start]").click()
        page.wait_for_timeout(260)
        cross = page.evaluate(
            """() => {
              const intro = document.querySelector('[data-intro-page]');
              const body = document.querySelector('[data-lab-body]');
              let root = body;
              while (root && root.parentElement && !root.style.opacity) root = root.parentElement;
              return { i: intro ? +getComputedStyle(intro).opacity : null,
                       w: +getComputedStyle(root).opacity };
            }"""
        )
        mid_ok = (
            cross["i"] is not None
            and 0.05 < cross["i"] < 0.95
            and 0.05 < cross["w"] < 0.95
        )
        check("点击后两层交叉过渡（非先淡出再淡入）", mid_ok, f"intro={cross['i']:.2f} workbench={cross['w']:.2f}")
        page.wait_for_timeout(900)
        check(
            "过渡结束后开场页卸载 + 写入 intro-seen",
            page.evaluate(
                "() => !document.querySelector('[data-intro-page]') && sessionStorage.getItem('intro-seen') === '1'"
            ),
        )

        # ── 减展示 1：顶部一行 ──
        section("减展示1：顶部一行紧凑工具栏")
        goto("dna")
        bar = page.evaluate(
            """() => {
              const b = document.querySelector('[data-top-bar]');
              if (!b) return null;
              const r = b.getBoundingClientRect();
              return { n: document.querySelectorAll('[data-top-bar]').length,
                       h: Math.round(r.height), overflow: b.scrollWidth > b.clientWidth + 1,
                       hasMenu: !!document.querySelector('[data-view-menu-toggle]'),
                       hasPaper: !!document.querySelector('[data-top-paper]'),
                       hasUpload: !!document.querySelector('[data-upload-toggle]'),
                       hasAnalyze: !!document.querySelector('[data-top-analyze]') };
            }"""
        )
        check("存在且仅有一个顶部工具栏", bar and bar["n"] == 1, str(bar and bar["n"]))
        check("顶部工具栏只有一行（高度 ≤ 56px）", bar and bar["h"] <= 56, f"{bar and bar['h']}px")
        check("顶部无自身溢出", bar and not bar["overflow"], "")
        check(
            "顶部含视图切换 / 当前论文 / 上传 / 分析",
            bar and bar["hasMenu"] and bar["hasPaper"] and bar["hasUpload"] and bar["hasAnalyze"],
            "",
        )

        # 视图下拉能切视图（第二出口可用）
        page.locator("[data-view-menu-toggle]").first.click()
        page.wait_for_timeout(400)
        menu_n = page.locator("[data-view-menu] [data-view]").count()
        check("视图下拉含 5 个视图项", menu_n == 5, f"{menu_n}")
        page.locator('[data-view-menu] [data-view="debt"]').first.click()
        page.wait_for_timeout(900)
        check("从下拉切视图生效", "view=debt" in page.url, page.url.split("view=")[-1][:12])

        # ── 减展示 2：左栏默认折叠 ──
        section("减展示2：左栏默认折叠 48px + 箭头方向正确")
        goto("dna")
        nav = page.evaluate(
            """() => {
              const n = document.querySelector('[data-nav]');
              const r = n.getBoundingClientRect();
              const btn = document.querySelector('[data-rail-toggle]');
              return { w: Math.round(r.width), collapsed: n.getAttribute('data-nav-collapsed'),
                       glyph: (btn.textContent || '').trim(),
                       asideCount: document.querySelectorAll('aside').length };
            }"""
        )
        check("左栏默认折叠", nav["collapsed"] == "1", nav["collapsed"])
        check("折叠宽度 48px", nav["w"] == 48, f"{nav['w']}px")
        check(
            "折叠态箭头指向右（点击会展开，不是被推出屏幕）",
            nav["glyph"] == "›",
            repr(nav["glyph"]),
        )
        # ── P21：右栏 DetailRail 也是一个 <aside>，所以现在是 2 个 ──
        #   断言改成"左栏 + 右栏各一个、不多不少"，仍守住"不许再多出第三栏"。
        check("页面内 aside 恰好两个（左栏 + P21 右栏详情）",
              nav["asideCount"] == 2, f"{nav['asideCount']}")

        page.locator("[data-rail-toggle]").first.click()
        page.wait_for_timeout(500)
        nav2 = page.evaluate(
            """() => {
              const n = document.querySelector('[data-nav]');
              const btn = document.querySelector('[data-rail-toggle]');
              return { w: Math.round(n.getBoundingClientRect().width),
                       collapsed: n.getAttribute('data-nav-collapsed'),
                       glyph: (btn.textContent || '').trim(),
                       papers: document.querySelectorAll('[data-paper-item]').length,
                       resetRun: document.querySelectorAll('[data-reset-run]').length };
            }"""
        )
        check("展开态箭头指向左", nav2["glyph"] == "‹", repr(nav2["glyph"]))
        check("展开宽度 200-320px", 200 <= nav2["w"] <= 320, f"{nav2['w']}px")
        # ── P21：论文切换搬到顶栏下拉，左栏不再有论文列表 ──
        #   断言改成"左栏已经无论文列表 + 顶栏有入口"，
        #   把"论文切换仍然存在"这件事换个位置继续守住。
        check("左栏已无论文列表（P21 搬到顶栏）", nav2["papers"] == 0, f"{nav2['papers']} 篇")
        check("顶栏仍有论文切换入口", page.locator("[data-top-paper]").count() == 1, "")
        check("展开态含两级重置", nav2["resetRun"] >= 1, "")
        page.locator("[data-rail-toggle]").first.click()  # 收回折叠
        page.wait_for_timeout(400)

        # ── 问题 2：logo 与缩放条都不在画布上 ──
        section("问题2 / 细节2：画布上无 logo、无缩放条")
        goto("dna")
        canvas_chrome = page.evaluate(
            """() => ({
              labLogo: document.querySelectorAll('[data-lab-logo]').length,
              zoom: document.querySelectorAll('[data-zoom-out],[data-zoom-reset],[data-zoom-in],[data-zoom-fit]').length,
              railLogo: document.querySelectorAll('[data-rail-logo]').length,
              stage: !!document.querySelector('[data-canvas-stage]'),
            })"""
        )
        check("画布上无 logo（data-lab-logo 已删）", canvas_chrome["labLogo"] == 0, "")
        check("缩放条整体移除（data-zoom-* 已删）", canvas_chrome["zoom"] == 0, "")
        check("logo 已迁到左栏底部", canvas_chrome["railLogo"] == 1, "")
        check("画布仍正常渲染", canvas_chrome["stage"], "")

        # ── 减展示 3 + 4：画布占比 / 面板默认折叠 ──
        section("减展示3+4：画布占满 + 底部面板默认折叠（点节点滑出 / 点空白收回）")
        ratios = []
        for w, h in [(1440, 950), (1280, 800), (1024, 700)]:
            page.set_viewport_size({"width": w, "height": h})
            for v in ["dna", "evolution", "debt", "idea", "crashtest"]:
                goto(v)
                m = page.evaluate(
                    """() => {
                      const nav = document.querySelector('[data-nav]');
                      // ── P21：演化/债务改成两栏，没有 [data-canvas-stage] 了 ──
                      // 内容列 = 左栏 + 右栏；这里量的是"左内容区"的宽度占比，
                      // 所以把时间线/债务列表也纳入候选（否则 target 为 null → 抛错）。
                      const target =
                        document.querySelector('[data-split-left]')
                        || document.querySelector('[data-canvas-stage]')
                        || document.querySelector('[data-idea-workbench]')
                        || document.querySelector('[data-crash-tabs]');
                      const r = target.getBoundingClientRect();
                      return { navW: Math.round(nav.getBoundingClientRect().width),
                               cw: Math.round(r.width), cx: Math.round(r.x),
                               sw: document.documentElement.scrollWidth, iw: innerWidth,
                               sh: document.documentElement.scrollHeight, ih: innerHeight };
                    }"""
                )
                ok = (
                    m["sw"] <= m["iw"] + 1
                    and m["sh"] <= m["ih"] + 1
                    and m["cx"] >= m["navW"] - 1
                )
                check(f"{w}x{h} {v}：内容区在左栏右侧且整页不滚动", ok, f"contentX={m['cx']} navW={m['navW']} {m['sw']}x{m['sh']}")
                if v == "dna":
                    ratios.append(round(m["cw"] / m["iw"] * 100))
        # ── P21：DNA 改成两栏（左 70% 画布 + 右 30% 详情），占视口从 ~97%
        #   降到 ~67% —— 这是**产品本轮明确要求**的，不是回归。
        #   断言改成：画布 ≥60%（两栏里的主体仍是画布），并确认右栏
        #   确实被内容占着（不是白白空着 —— 那才是 P19 要消灭的问题）。
        check("画布占视口 ≥60%（P21 两栏：左内容 + 右详情）",
              all(r >= 60 for r in ratios), f"dna 占比 {ratios}%")
        # 右栏占比要在**画布类视图**里量（循环最后停在 crashtest，那里没有右栏）
        goto("dna")
        page.wait_for_timeout(600)
        _rail_ratio = page.evaluate("""() => {
          const rail=document.querySelector('[data-detail-rail]');
          return rail ? Math.round(rail.getBoundingClientRect().width / innerWidth * 100) : 0;
        }""")
        check("右栏详情占视口 20–40%（P21：右侧不再空着）",
              20 <= _rail_ratio <= 40, f"右栏 {_rail_ratio}%")

        page.set_viewport_size({"width": 1440, "height": 950})
        goto("dna")
        closed = page.evaluate(
            """() => {
              // P21：DNA 详情在右栏（DetailRail），未选中时只有占位提示
              const rail = document.querySelector('[data-detail-rail]');
              if (!rail) return { empty: null };
              return { empty: rail.getAttribute('data-detail-empty') === '1' };
            }"""
        )
        # ── P21：DNA 的详情不再走底部面板，改由**右栏 DetailRail** 呈现 ──
        #   所以这里从"面板滑出/收回"改成"右栏由空变有内容、再变回空"：
        #   被验的不变量一模一样 —— 「点节点出详情、点空白收回、默认关着」。
        check("右栏默认只有占位提示（未选中不给内容）",
              closed.get("empty") is True, str(closed))
        node0 = page.locator("[data-node]").first
        node0.click()
        page.wait_for_timeout(800)
        opened = page.evaluate("""() => {
          const rail=document.querySelector('[data-detail-rail]');
          return { empty: rail ? rail.getAttribute('data-detail-empty') : null };
        }""")
        check("点节点后右栏出现详情（data-detail-empty=0）",
              opened["empty"] == "0", f"empty={opened['empty']}")
        stage = page.locator("[data-canvas-stage]").first.bounding_box()
        page.mouse.click(stage["x"] + stage["width"] - 40, stage["y"] + stage["height"] - 40)
        page.wait_for_timeout(800)
        reclosed = page.evaluate(
            "() => (document.querySelector('[data-detail-rail]')||{}).getAttribute"
            " && document.querySelector('[data-detail-rail]').getAttribute('data-detail-empty')"
        )
        check("点画布空白后右栏回到占位（详情收回）", reclosed == "1", f"empty={reclosed}")

        # ── 问题 3：击穿视图 ≤3 层框 ──
        section("问题3：击穿测试视图结构（tab + 报告 + AI 讨论）")
        goto("crashtest")
        crash = page.evaluate(
            """() => ({
              tabs: document.querySelectorAll('[data-crash-tabs]').length,
              tabsH: (() => { const t = document.querySelector('[data-crash-tabs]'); return t ? Math.round(t.getBoundingClientRect().height) : null; })(),
              runCard: document.querySelectorAll('[data-crash-run-card]').length,
              run: document.querySelectorAll('[data-run-crash]').length,
              chat: document.querySelectorAll('[data-crash-chat]').length,
              chatCollapsed: (() => { const c = document.querySelector('[data-crash-chat]'); return c ? c.getAttribute('data-collapsed') : null; })(),
              fab: document.querySelectorAll('[data-explore-fab]').length,
              stage: document.querySelectorAll('[data-canvas-stage]').length,
              compareBtn: document.querySelectorAll('[data-compare-toggle]').length,
              comparePanel: document.querySelectorAll('[data-compare-panel]').length,
              ideas: document.querySelectorAll('[data-crash-idea-option]').length,
            })"""
        )
        check("顶部存在想法 tab 条", crash["tabs"] == 1, "")
        check("tab 条仍带 data-crash-run-card（旧契约保留）", crash["runCard"] == 1, "")
        check("tab 条只占一行（高度 ≤ 64px）", crash["tabsH"] is not None and crash["tabsH"] <= 64, f"{crash['tabsH']}px")
        check("AI 讨论 dock 存在且默认折叠", crash["chat"] == 1 and crash["chatCollapsed"] == "1", f"collapsed={crash['chatCollapsed']}")
        check("右下角存在「与MethodAtlas共同探索」浮动按钮", crash["fab"] == 1, "")
        check("击穿视图不再渲染画布卡片层", crash["stage"] == 0, "")
        check("对比面板默认不占位（仅浮动按钮）", crash["comparePanel"] == 0, "")

        # 浮动按钮能展开 AI 讨论
        page.locator("[data-explore-fab]").first.click()
        page.wait_for_timeout(700)
        check(
            "点浮动按钮后 AI 讨论展开",
            page.locator("[data-crash-chat]").first.get_attribute("data-collapsed") == "0",
            "",
        )
        page.locator("[data-explore-fab]").first.click()
        page.wait_for_timeout(500)

        if crash["ideas"] >= 2:
            page.locator("[data-crash-idea-option]").nth(1).click()
            page.wait_for_timeout(800)
            check("切换 tab 后运行按钮可用（tab 即选中）",
                  not page.locator("[data-run-crash]").first.is_disabled(), "")
            check("浮动对比按钮出现", page.locator("[data-compare-toggle]").count() == 1, "")
            page.locator("[data-compare-toggle]").first.click()
            page.wait_for_timeout(700)
            drawer = page.evaluate(
                """() => {
                  const o = document.querySelector('[data-compare-overlay]');
                  const pn = document.querySelector('[data-compare-panel]');
                  if (!o || !pn) return null;
                  const pivot = o.parentElement.getBoundingClientRect();
                  const pr = pn.getBoundingClientRect();
                  return { pivotW: Math.round(pivot.width), panelW: Math.round(pr.width),
                           panelH: Math.round(pr.height), inside: pr.right <= pivot.right + 1 && pr.x >= pivot.x - 1 };
                }"""
            )
            check("对比抽屉铺满中栏（不是只有按钮大小）",
                  drawer and drawer["pivotW"] > 400 and drawer["panelW"] >= 400 and drawer["inside"],
                  str(drawer))
            page.locator("[data-compare-close]").first.click()
            page.wait_for_timeout(500)
            check("关闭后抽屉卸载", page.locator("[data-compare-overlay]").count() == 0, "")
        else:
            skip("tab 切换 / 对比抽屉", "库中想法 < 2（冷启动基线）")

        # ── 细节 3：状态色四档统一 ──
        section("细节3：状态色统一（四档四色）")
        goto("evolution")
        tones = page.evaluate(
            """() => {
              const out = [];
              for (const btn of document.querySelectorAll('[data-node^="problem-"]')) {
                const style = getComputedStyle(btn);
                const txt = btn.innerText.replace(/\\s+/g, ' ');
                out.push({ border: style.borderLeftColor, txt: txt.slice(0, 120) });
              }
              return out;
            }"""
        )
        WANT = {"已解决": "rgb(22, 163, 74)", "部分解决": "rgb(217, 119, 6)",
                "未解决": "rgb(220, 38, 38)", "指出问题": "rgb(156, 163, 175)"}
        mismatches = []
        seen_labels = set()
        for t in tones:
            for label, color in WANT.items():
                if label in t["txt"]:
                    seen_labels.add(label)
                    if t["border"] != color:
                        mismatches.append(f"{label}→{t['border']}（应 {color}）")
                    break
        check("演化卡片状态与色条一一对应", not mismatches, "；".join(mismatches) or f"检查了 {len(tones)} 张卡")
        check("本轮实际覆盖到「部分解决」档", "部分解决" in seen_labels or not tones,
              "、".join(sorted(seen_labels)))

        # ── 细节 4 / 6：placeholder 与文案 ──
        section("细节4+5+6：placeholder 加深 / 文案修正 / AI 输入提示缩短")
        goto("idea")
        ph = page.evaluate(
            """() => {
              const g = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el, '::placeholder').color : null; };
              const txt = document.body.innerText;
              const cnt = document.querySelector('[data-idea-count]');
              return { title: g('[data-custom-idea-title]'), desc: g('[data-custom-idea-desc]'),
                       ideaCount: cnt ? Number(cnt.getAttribute('data-idea-count') || '0') : 0,
                       hasNew: txt.includes('可在击穿测试视图中查看'),
                       hasOld: txt.includes('想法列表现有'),
                       hasNeverRun: txt.includes('还没有生成过组合') };
            }"""
        )
        check("模块名称 placeholder = #9ca3af", ph["title"] == "rgb(156, 163, 175)", str(ph["title"]))
        check("模块描述 placeholder = #9ca3af", ph["desc"] == "rgb(156, 163, 175)", str(ph["desc"]))
        # ── 文案分三态，断言按数据分支（别把"库里有想法"当契约）──
        #   有想法：“已生成 N 个想法，可在击穿测试视图中查看。”
        #   没有：  “还没有生成过组合。…”（冷启动基线就是这个）
        if ph["ideaCount"] > 0:
            check("文案已改为「已生成 N 个想法，可在击穿测试视图中查看」",
                  ph["hasNew"] and not ph["hasOld"], "")
        else:
            check("冷启动（0 想法）时文案为「还没有生成过组合…」且不含旧文案",
                  ph["hasNeverRun"] and not ph["hasOld"], "")
        goto("crashtest")
        page.locator("[data-explore-fab]").first.click()
        page.wait_for_timeout(700)
        chat_ph = page.evaluate(
            """() => {
              const el = document.querySelector('[data-chat-input]');
              return el ? el.getAttribute('placeholder') : null;
            }"""
        )
        if chat_ph is None:
            # 0 想法时 AI 讨论是空态（没有可讨论的对象，输入框不渲染）——
            # 与"提示太长"这件事无关，如实跳过而不是判失败。
            skip("AI 讨论输入框提示已缩短", "库里 0 想法（空态无输入框）")
        else:
            check("AI 讨论输入框提示已缩短", len(chat_ph) <= 14, repr(chat_ph))

        # ── 全局：控制台零报错 + 无模型名 ──
        section("全局约束：控制台零报错")
        real_errors = [e for e in errors if "favicon" not in e.lower()]
        check("全流程无控制台报错", not real_errors, " | ".join(real_errors[:3]) or "0 条")

        browser.close()

    print("\n" + "=" * 68)
    print(f"P19 专项验收：{PASS} 通过 / {FAIL} 失败 / {SKIP} 跳过")
    if FAILURES:
        print("失败项：")
        for f in FAILURES:
            print("  -", f)
    print("=" * 68)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
