#!/usr/bin/env python3
"""
P10 问题 1 回归：面板展开后，画布内容必须重新居中，所有节点都在可视区内。

复现条件（务必保留矮视口）：节点列越高越容易触发夹取分支。
  视口高时：面板开时 canvas 高 > 包围盒高，走居中分支，**测不出问题**
  视口矮时：面板开时 canvas 高 < 包围盒高，走夹取分支，**旧代码翻车**
所以三种高度（950/700/560）都要测，不能只测一种。

断言：
  1. 面板展开后，每个 [data-node] 的 top >= canvas.top - TOL
  2. 面板展开后，每个 [data-node] 的 bottom <= canvas.bottom + TOL

注意：论文 id 一律**动态取**（写死 id 在换论文后会失效 ——
旧版本写死了 RAG 三篇的 id，替换成 IPS 后整脚本报"画布容器未出现"）。
"""
import subprocess
import sys

from playwright.sync_api import sync_playwright

TOL = 1  # px
VIEWPORTS = [950, 700, 560]


def resolve_project_and_papers():
    """动态取项目 id + 该项目下所有论文（id/标题）。"""
    js = """
const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();
(async()=>{
  const pr=await p.project.findFirst({include:{papers:true}});
  console.log(JSON.stringify({project:pr.id,papers:pr.papers.map(x=>({id:x.id,title:x.title}))}));
  await p.$disconnect();
})()
"""
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, cwd=".")
    import json
    return json.loads(out.stdout.strip())


PROBE = """
() => {
  const stage = document.querySelector('[data-canvas-stage]');
  const sr = stage ? stage.getBoundingClientRect() : null;
  if (!sr) return { canvas: null, nodes: [] };
  const nodes = Array.from(document.querySelectorAll('[data-node]')).map(n => {
    const r = n.getBoundingClientRect();
    return { id: n.getAttribute('data-node') || '',
             label: (n.getAttribute('data-node-label') || '').slice(0, 22),
             top: r.top, bottom: r.bottom };
  });
  return { canvas: { top: sr.top, bottom: sr.bottom }, nodes };
}
"""


def check(pg, tag, project, pid, height):
    url = f"http://localhost:3000/projects/{project}/lab?view=dna&paper={pid}"
    pg.goto(url, wait_until="networkidle")
    pg.wait_for_timeout(1600)
    # 等画布容器真的挂上（首帧可能还在 hydration）
    try:
        pg.wait_for_selector("[data-canvas-stage]", timeout=8000)
    except Exception:
        print(f"  {tag} @{height}  ❌ 画布容器未出现")
        return False, 0
    pg.wait_for_timeout(500)

    # 1) 点空白关面板
    stage = pg.query_selector("[data-canvas-stage]")
    box = stage.bounding_box()
    pg.mouse.click(box["x"] + box["width"] - 30, box["y"] + box["height"] - 30)
    pg.wait_for_timeout(700)

    # 2) 点节点展开面板
    target = None
    for n in pg.query_selector_all("[data-node]"):
        nid = n.get_attribute("data-node") or ""
        if not nid.startswith("root") and not nid.startswith("empty"):
            target = n
            break
    if not target:
        print(f"  {tag} @{height}  ⏭  无可点节点，跳过")
        return True, 0
    target.click()
    pg.wait_for_timeout(1100)

    d = pg.evaluate(PROBE)
    c = d["canvas"]
    if not c:
        print(f"  {tag} @{height}  ❌ 拿不到画布")
        return False, 0

    bad = [n for n in d["nodes"]
           if n["top"] < c["top"] - TOL or n["bottom"] > c["bottom"] + TOL]
    ok = not bad
    print(f"  {tag} @{height}  可视区[{c['top']:.0f},{c['bottom']:.0f}] "
          f"节点={len(d['nodes'])} 越界={len(bad)}  {'✅' if ok else '❌'}")
    for n in bad:
        side = "顶出" if n["top"] < c["top"] - TOL else "底出"
        over = (c["top"] - n["top"]) if side == "顶出" else (n["bottom"] - c["bottom"])
        print(f"        ✗ {n['id'][:28]:30} [{n['top']:.0f},{n['bottom']:.0f}] {side} 超出 {over:.0f}px")
    return ok, len(d["nodes"])

def main():
    all_ok = True
    total = 0
    info = resolve_project_and_papers()
    project = info["project"]
    # 用「块数」给论文起标签，方便一眼看出哪篇是关键的矮视口场景
    papers = {}
    for i, x in enumerate(info["papers"]):
        papers[f"P{i}({x['title'][:22]})"] = x["id"]

    with sync_playwright() as p:
        b = p.chromium.launch()
        print("=" * 78)
        print("P10 问题 1 回归：面板展开后画布重新居中")
        print(f"  项目 {project} · {len(papers)} 篇论文")
        print("=" * 78)
        for height in VIEWPORTS:
            pg = b.new_page(viewport={"width": 1600, "height": height})
            pg.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
            print(f"\n── 视口高度 {height} ──")
            for tag, pid in papers.items():
                ok, n = check(pg, tag, project, pid, height)
                all_ok = all_ok and ok
                total += n
            pg.close()
        b.close()
    print("\n" + "=" * 78)
    print(f"结论：{'全部通过 ✅' if all_ok else '存在失败 ❌'}（共检查 {total} 个节点位置）")
    return 0 if all_ok else 1

sys.exit(main())
