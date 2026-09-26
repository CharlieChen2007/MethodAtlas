"""P20 动效契约验收（零模型调用，约 40 秒）。

验的是**computed style**，不是"看起来动了"—— 因为动效最容易在后续
重构里被误改（时长变 800ms、缓动换回 ease、位移变成 40px），
肉眼不一定看得出来，但"克制"的边界一旦破掉就很烦人。

覆盖本轮 5 处动效 + 6 条禁令：

  ① 列表交错出场   债务列表 / 论文列表 / 击穿 tab / 模块与债务候选
                    → 逐项 +70ms、0.4s、cubic-bezier(0.34,1.56,0.64,1)、位移 12px
  ② 视图切换       只淡入 0.2s，**无位移**
  ③ 底部面板滑出   0.3s、cubic-bezier(0.16,1,0.3,1)、位移 16px
  ④ 节点选中       选中后 scale 1.02（不是 1.1 那种夸张放大）
  ⑤ 按钮按压       scale 0.98 / 100ms；画布节点按钮被排除

  禁令：无持续动画（除了既有的 ma-pulse 运行中呼吸）、无人为的
        animation-iteration-count: infinite、时长都不超过 500ms

用法：
  python scripts/verify-p20-animations.py            # 3000 端口
  MA_PORT=3100 python scripts/verify-p20-animations.py
"""
import os
import re
import sys

from playwright.sync_api import sync_playwright

PORT = os.environ.get("MA_PORT", "3000")
BASE = f"http://127.0.0.1:{PORT}/projects/cmu9my2ie0000z6pko5sqr27s/lab"
CHROME = os.environ.get("MA_CHROME")

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


# 只允许这些动画名出现（其余都是本轮之外的遗留，列出来便于发现新增的持续动画）
ALLOWED_ANIM = {
    "ma-slide-in",      # ① 列表交错
    "ma-panel-up",      # ③ 面板滑出
    "ma-view-fade",     # ② 视图淡入
    "ma-pulse",         # 既有：运行中呼吸（唯一的循环动画，且只在进行中出现）
    "ma-fade-in",       # 既有：抽屉/提示进场
    "ma-card-in",       # 既有：浮动卡片进场
    "ma-ok-flash",      # 既有：成功短闪
    "ma-shake-x",       # 既有：失败抖动
    "ma-reset-dip",     # 既有：重置回落
    "ma-gen-flash",     # 既有：生成完成
    "ma-run-done",      # 既有：击穿完成
    "none",
}

# 本轮 5 处动效的时长上限（ms）
MAX_MS = 500


def ms_of(v):
    """'0.4s' → 400；'70ms' → 70；'0s' → 0"""
    v = (v or "").strip()
    if v.endswith("ms"):
        return float(v[:-2])
    if v.endswith("s"):
        return float(v[:-1]) * 1000
    try:
        return float(v)
    except ValueError:
        return None


def main():
    launch = {"executable_path": CHROME} if CHROME else {}

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch)
        ctx = browser.new_context(viewport={"width": 1440, "height": 950})
        # 跳过开场页（否则它会盖在最上层，拦截所有点击）
        ctx.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text()) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        def goto(view):
            page.goto(f"{BASE}?view={view}", wait_until="domcontentloaded")

        def anim_of(sel):
            """读某个选择器的动画参数（取前 6 个元素的 computed style）"""
            return page.evaluate(
                """(s) => [...document.querySelectorAll(s)].slice(0, 6).map(e => {
                     const cs = getComputedStyle(e);
                     return { name: cs.animationName, dur: cs.animationDuration,
                              delay: cs.animationDelay, timing: cs.animationTimingFunction,
                              fill: cs.animationFillMode, iter: cs.animationIterationCount };
                   })""",
                sel,
            )

        # ── ① 列表交错出场 ──
        section("① 列表交错出场（逐项 +70ms / 0.4s / 轻微弹性 / 12px）")
        # 先在 dna 静置，再切到 debt —— 列表随视图 remount 才会播
        goto("dna")
        page.wait_for_timeout(1600)
        page.locator('[data-view="debt"]').first.click()
        page.wait_for_timeout(90)
        rows = anim_of("[data-debt-list-item]")
        if not rows:
            check("债务列表项存在", False, "没抓到 [data-debt-list-item]")
        else:
            check("债务列表行带 ma-slide-in 动画",
                  all(r["name"] == "ma-slide-in" for r in rows), rows[0]["name"])
            check("时长 0.4s", all(ms_of(r["dur"]) == 400 for r in rows), rows[0]["dur"])
            check("缓动 cubic-bezier(0.34,1.56,0.64,1)",
                  all("cubic-bezier(0.34, 1.56, 0.64, 1)" == r["timing"] for r in rows), rows[0]["timing"])
            check("fill-mode=both（延迟期间保持起始态，不闪）",
                  all(r["fill"] == "both" for r in rows), rows[0]["fill"])
            delays = [ms_of(r["delay"]) for r in rows]
            # 前 3 项按规约 +70ms 递增；第 4 项起封顶 100ms（否则整串会突破 500ms）
            expect = [0, 70, 100] + [100] * max(0, len(rows) - 3)
            check(f"逐项递增且第 4 项起封顶（实测 {delays}）", delays == expect[: len(rows)], str(delays))
            total = max(delays) + 400
            check(f"最长收敛时间 ≤ 500ms（实测 {total}ms）", total <= MAX_MS + 0.5, f"{total}ms")

        # 位移幅度：直接验 keyframes —— 定格在中途量 translateY
        goto("dna")
        page.wait_for_timeout(1600)
        page.add_style_tag(content=".ma-list-item{animation-play-state:paused !important}")
        page.locator('[data-view="debt"]').first.click()
        page.wait_for_timeout(120)
        dy = page.evaluate(
            """() => {
                 const e = document.querySelector('[data-debt-list-item]');
                 if (!e) return null;
                 const m = new DOMMatrixReadOnly(getComputedStyle(e).transform);
                 return Math.round(m.m42);   // translateY
               }"""
        )
        check("位移幅度在 8~16px 之间（起始 12px）", dy is not None and 8 <= abs(dy) <= 16, f"translateY={dy}px")

        # 论文列表（左栏展开时）
        goto("dna")
        page.wait_for_timeout(1600)
        page.locator("[data-rail-toggle]").first.click()
        page.wait_for_timeout(90)
        papers = anim_of("[data-paper-item]")
        if papers:
            pd = [ms_of(r["delay"]) for r in papers]
            check("论文列表也带交错动画（前 3 项递增、之后封顶）",
                  all(r["name"] == "ma-slide-in" for r in papers)
                  and pd == ([0, 70, 100] + [100] * max(0, len(papers) - 3))[: len(papers)],
                  f"{len(papers)} 项 delays={pd}")
        else:
            skip("论文列表交错", "左栏没有论文项")

        # 击穿 tab
        goto("crashtest")
        page.wait_for_timeout(90)
        tabs = anim_of("[data-crash-idea-option]")
        if tabs:
            check("击穿想法 tab 带交错动画",
                  all(r["name"] == "ma-slide-in" for r in tabs), f"{len(tabs)} 项")
        else:
            skip("击穿 tab 交错", "库里没有想法（冷启动）")

        # 组合想法：模块/债务候选
        goto("idea")
        page.wait_for_timeout(1500)
        opts = anim_of("[data-debt-option]")
        if opts:
            od = [ms_of(r["delay"]) for r in opts]
            check("组合想法的债务候选带交错动画（前 3 项递增、之后封顶）",
                  all(r["name"] == "ma-slide-in" for r in opts)
                  and od == ([0, 70, 100] + [100] * max(0, len(opts) - 3))[: len(opts)],
                  f"{len(opts)} 项 delays={od}")
        else:
            skip("模块/债务候选交错", "没有候选数据")

        # ── ② 视图切换：只淡入、无位移 ──
        section("② 视图切换：只淡入 0.2s，无位移")
        goto("idea")
        page.wait_for_timeout(90)
        v = page.evaluate(
            """() => {
                 const e = document.querySelector('.ma-view-fade, .ma-view-in');
                 if (!e) return null;
                 const cs = getComputedStyle(e);
                 return { name: cs.animationName, dur: cs.animationDuration, timing: cs.animationTimingFunction };
               }"""
        )
        check("视图容器有淡入动画", v and v["name"] == "ma-view-fade", str(v and v["name"]))
        check("时长 0.2s", v and ms_of(v["dur"]) == 200, str(v and v["dur"]))
        # keyframes 里不得有 translate —— 动画结束后计算值是 none，量不到位移，
        # 所以直接翻 CSSOM 的 @keyframes 规则。
        kf = page.evaluate(
            """() => {
                 for (const ss of document.styleSheets) {
                   let rules; try { rules = ss.cssRules } catch { continue }
                   for (const r of rules || []) {
                     if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'ma-view-fade') {
                       const txt = [...r.cssRules].map(k => k.style.transform || '').join('|');
                       return { found: true, hasTransform: txt.includes('translate') || txt.includes('scale') };
                     }
                   }
                 }
                 return { found: false, hasTransform: false };
               }"""
        )
        check("视图淡入 keyframes 不含位移",
              kf["found"] and not kf["hasTransform"], str(kf))

        # ── ③ 底部面板滑出 ──
        section("③ 底部面板展开：滑出 0.3s 弹性缓动")
        goto("dna")
        page.wait_for_timeout(2000)
        page.locator("[data-node]").first.click()
        page.wait_for_timeout(90)
        panel = page.evaluate(
            """() => {
                 const s = document.querySelector('[data-panel][data-panel-variant="slide"]')
                        || document.querySelector('[data-panel]');
                 if (!s) return null;
                 const cs = getComputedStyle(s);
                 return { name: cs.animationName, dur: cs.animationDuration, timing: cs.animationTimingFunction };
               }"""
        )
        check("面板带 ma-panel-up 动画", panel and panel["name"] == "ma-panel-up", str(panel and panel["name"]))
        check("时长 0.3s", panel and ms_of(panel["dur"]) == 300, str(panel and panel["dur"]))
        check("缓动 cubic-bezier(0.16,1,0.3,1)",
              panel and panel["timing"] == "cubic-bezier(0.16, 1, 0.3, 1)", str(panel and panel["timing"]))
        # 收起时不应还挂着滑出动画
        page.locator('[data-panel] [aria-label="关闭详情"]').first.click()
        page.wait_for_timeout(500)
        closed = page.evaluate(
            """() => {
                 const s = document.querySelector('[data-panel]');
                 return s ? getComputedStyle(s).animationName : 'none';
               }"""
        )
        check("收起后不再挂滑出动画（收起语义是让出空间）", closed in ("none", ""), str(closed))

        # ── ④ 节点选中：轻微放大 ──
        section("④ 节点选中：轻微放大 1.02 / 150ms")
        goto("dna")
        page.wait_for_timeout(2000)
        before = page.evaluate(
            """() => { const n = document.querySelector('[data-node]');
                       const m = new DOMMatrixReadOnly(getComputedStyle(n).transform);
                       return { scale: +m.a.toFixed(3), transition: getComputedStyle(n).transitionDuration }; }"""
        )
        page.locator("[data-node]").first.click()
        page.wait_for_timeout(400)
        after = page.evaluate(
            """() => { const n = document.querySelector('[data-node]');
                       const m = new DOMMatrixReadOnly(getComputedStyle(n).transform);
                       return { scale: +m.a.toFixed(3) }; }"""
        )
        check("未选中 scale = 1", abs(before["scale"] - 1) < 0.001, str(before["scale"]))
        check("选中后 scale = 1.02（轻微，不是 1.1）", abs(after["scale"] - 1.02) < 0.001, str(after["scale"]))
        check("节点过渡时长 0.15s", "0.15s" in before["transition"], before["transition"])

        # ── ⑤ 按钮按压反馈 ──
        section("⑤ 按钮按压：scale(0.98) / 100ms；画布节点被排除")
        btn = page.evaluate(
            """() => {
                 const b = document.querySelector('[data-top-analyze]') || document.querySelector('button:not([data-node])');
                 const cs = getComputedStyle(b);
                 return { transition: cs.transition, isNode: b.hasAttribute('data-node') };
               }"""
        )
        check("界面按钮有 transform 过渡且 0.1s", "0.1s" in btn["transition"], btn["transition"])
        node = page.evaluate(
            """() => { const b = document.querySelector('[data-node]');
                       return { transition: getComputedStyle(b).transition,
                                hasPressOnly: /transform 0\\.1s/.test(getComputedStyle(b).transition) }; }"""
        )
        check("画布节点按钮未套用 0.1s 按压过渡（它有选中放大那套）",
              not node["hasPressOnly"], node["transition"][:60])
        # 按压后的实际缩放：用 CDP 强制 :active 不可行 —— 改为读规则文本
        rule = page.evaluate(
            """() => {
                 for (const ss of document.styleSheets) {
                   let rules; try { rules = ss.cssRules } catch { continue }
                   for (const r of rules || []) {
                     if (r.selectorText && r.selectorText.includes(':active') && r.style && r.style.transform) {
                       return { sel: r.selectorText, tf: r.style.transform };
                     }
                   }
                 }
                 return null;
               }"""
        )
        check("存在 :active → scale(0.98) 规则", rule and "scale(0.98)" in rule["tf"], str(rule))

        # ── 禁令检查 ──
        section("禁令：无持续动画 / 时长不超 500ms")
        goto("dna")
        page.wait_for_timeout(2200)
        audit = page.evaluate(
            """() => {
                 const bad = [], inf = [], long = [];
                 for (const el of document.querySelectorAll('*')) {
                   const cs = getComputedStyle(el);
                   const names = (cs.animationName || 'none').split(',').map(s => s.trim());
                   if (names.length === 1 && names[0] === 'none') continue;
                   const iters = (cs.animationIterationCount || '').split(',').map(s => s.trim());
                   const durs = (cs.animationDuration || '').split(',').map(s => s.trim());
                   for (let i = 0; i < names.length; i++) {
                     const n = names[i];
                     if (n === 'none') continue;
                     if (iters[i] === 'infinite') inf.push(n + '@' + el.tagName);
                     const s = durs[i] || '0s';
                     const ms = s.endsWith('ms') ? parseFloat(s) : parseFloat(s) * 1000;
                     if (ms > 500) long.push(n + '=' + s + '@' + el.tagName);
                   }
                 }
                 return { inf: [...new Set(inf)], long: [...new Set(long)] };
               }"""
        )
        check("静止状态下没有任何 infinite 循环动画（无持续动画）",
              not audit["inf"], "、".join(audit["inf"]) or "0 处")
        check("所有动画时长 ≤ 500ms", not audit["long"], "、".join(audit["long"]) or "0 处")

        # 动画名白名单：发现未登记的新动画就报出来（防止后续偷偷加持续动画）
        names = page.evaluate(
            """() => {
                 const out = new Set();
                 for (const el of document.querySelectorAll('*')) {
                   const n = getComputedStyle(el).animationName;
                   if (n && n !== 'none') n.split(',').forEach(x => out.add(x.trim()));
                 }
                 return [...out];
               }"""
        )
        unknown = [n for n in names if n not in ALLOWED_ANIM]
        check("没有未登记的动画（白名单外）", not unknown, "、".join(unknown) or f"已登记 {len(names)} 个")

        # 控制台
        section("全局：控制台零报错")
        real = [e for e in errors if "favicon" not in e.lower()]
        check("全流程无控制台报错", not real, " | ".join(real[:3]) or "0 条")

        browser.close()

    print("\n" + "=" * 68)
    print(f"P20 动效验收：{PASS} 通过 / {FAIL} 失败 / {SKIP} 跳过")
    if FAILURES:
        print("失败项：")
        for f in FAILURES:
            print("  -", f)
    print("=" * 68)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
