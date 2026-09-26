#!/usr/bin/env python3
"""
P10 问题 3 回归：面板必须列出"未抽取阶段说明"。

拍板 1 选 A：结构图上只画有 block 的阶段（不画灰框占位）。
于是"为什么少了阶段"必须由面板承担 —— 本节验证它确实出现了。

注意：论文 id 动态取（旧版本写死了 RAG 那篇的 id，换 IPS 后 404）。
优先选**有 uncertainties 且缺阶段最多**的那篇，最能验证本节；
若所有论文都覆盖了全部 7 个阶段（比如 IPS 这种情况），
则本节退化为验证"没有未抽取阶段时，本节不出现且仍无灰框占位"。
"""
import subprocess
import sys
import json

from playwright.sync_api import sync_playwright

STAGES = ["PROBLEM", "INPUT", "PREPROCESSING", "CORE_METHOD", "TRAINING", "INFERENCE", "EVALUATION"]


def resolve():
    js = """
const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();
(async()=>{
  const pr=await p.project.findFirst({include:{papers:{include:{methodDNA:{include:{blocks:true}}}}}});
  const papers=pr.papers.map(x=>{
    const stages=[...new Set((x.methodDNA?.blocks??[]).map(b=>b.stage))];
    let unc=[]; try{unc=JSON.parse(x.methodDNA?.uncertainties??'[]')}catch(e){}
    return {id:x.id,title:x.title,stages,uncCount:unc.length};
  });
  console.log(JSON.stringify({project:pr.id,papers}));
  await p.$disconnect();
})()
"""
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, cwd=".")
    return json.loads(out.stdout.strip())


info = resolve()
project = info["project"]
# 选"缺阶段最多"的那篇；并列时取 uncertainties 多的
papers = sorted(info["papers"], key=lambda x: (len(STAGES) - len(x["stages"]), -x["uncCount"]), reverse=True)
paper = papers[0]
missing = [s for s in STAGES if s not in paper["stages"]]
URL = f"http://localhost:3000/projects/{project}/lab?view=dna&paper={paper['id']}"

print("=" * 70)
print("P10 问题 3 回归：面板「未抽取阶段说明」")
print("=" * 70)
print(f"  选中论文: {paper['title'][:50]}")
print(f"  覆盖阶段: {paper['stages']}")
print(f"  缺少阶段: {missing if missing else '（无）'}")
print(f"  uncertainties: {paper['uncCount']} 条")
print()

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1600, "height": 950})
    pg.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
    pg.goto(URL, wait_until="networkidle")
    pg.wait_for_timeout(2000)

    # 点根节点展开论文面板
    pg.wait_for_selector("[data-node]", timeout=8000)
    root = None
    for n in pg.query_selector_all("[data-node]"):
        if (n.get_attribute("data-node") or "") == "root":
            root = n
            break
    if root is None:
        root = pg.query_selector_all("[data-node]")[0]
    root.click()
    pg.wait_for_timeout(1100)

    # 面板里有没有"未抽取阶段说明"
    panel = pg.query_selector("[data-panel]")
    txt = panel.inner_text() if panel else ""
    has_head = "未抽取阶段说明" in txt

    # 图上是否真的没有灰框占位（拍板 1：只画有 block 的阶段）
    stage_nodes = pg.evaluate(
        """() =>
      Array.from(document.querySelectorAll('[data-node]'))
        .map(n => n.getAttribute('data-node') || '')
        .filter(id => id.startsWith('stage-'))
    """
    )
    empty_nodes = [s for s in stage_nodes if 'empty' in s]

    # 契约：有缺失阶段 → 必须出现本节；无缺失阶段 → 本节不应出现（画布干净）
    if missing:
        head_ok = has_head
        head_msg = "✅" if head_ok else "❌ 应当出现"
    else:
        head_ok = not has_head
        head_msg = "✅ 无缺失阶段，未出现（正确）" if head_ok else "❌ 无缺失阶段却出现"

    print(f"  面板含「未抽取阶段说明」: {has_head}  {head_msg}")
    print(f"  阶段节点: {stage_nodes}")
    print(f"  灰框占位节点: {len(empty_nodes)}  {'✅' if not empty_nodes else '❌ 不应有占位'}")

    # 打印该节内容（供人工核对措辞）
    if panel and has_head:
        raw = panel.inner_text()
        idx = raw.find("未抽取阶段说明")
        if idx >= 0:
            print("\n--- 该节实际内容 ---")
            print(raw[idx:idx + 900])

    pg.screenshot(path="p10-evidence/p3-uncertain-section.png")
    b.close()

    ok = head_ok and not empty_nodes
    print("\n结论：" + ("通过 ✅" if ok else "失败 ❌"))
    sys.exit(0 if ok else 1)
