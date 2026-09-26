#!/usr/bin/env python3
"""
S1 行为验证：思维导图只渲染"真的出现过"的阶段列。

断言：
  1. DNA 视图里阶段列数 == 该论文实际覆盖的阶段数（不含根节点列）
  2. 画布上不存在「原文未描述」占位节点
  3. 空结构态（0 block 的论文）只画 1 个占位（方法结构 · 待抽取），不是 7 个
"""
import sys, json
from playwright.sync_api import sync_playwright

T1 = "cmu6r09at0002wdoj2fld38sm"
T2 = "cmu6r09d00004wdojtu6qyfgw"
T3 = "cmu6r09f50006wdojocd6jnal"
T4 = "cmu74f31j0002byx6q492knjc"

ALL_PAPERS = [T1, T2, T3, T4]

"""
期望列数不再写死，改为**从数据库读实际 stage 覆盖**再 +1（根节点列）。

为什么（踩过的坑）：原来 T4 期望"0 blocks → 骨架 1 占位"，但后来对这篇
重跑了一次 DNA 抽取（P10 问题 3 的验证），它变成 5 blocks / 4 stages。
脚本于是报"❌ 期望骨架 1 个占位"—— 而实际渲染是对的（4 阶段 + 根 = 5 列）。
硬编码期望值会让脚本随数据变化而**假报失败**，所以改成按库实时计算。

── P10 Step6：论文列表也改成**动态取** ──
旧版本把 RAG 三篇的 id 写死在 T1~T4 上；替换成 IPS 三篇后这些 id 全不存在，
脚本在 4 篇论文上全部报"列数=0 ❌"（页面 404，画布为空）——
看起来像功能坏了，其实是测试数据的 id 过期了。
现在统一从库里取"当前项目的全部论文"，脚本与数据解耦。
"""
import subprocess, json as _json


def resolve_papers():
    """动态取项目 id + 全部论文 id（不再写死）。"""
    js = r'''
const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const pr = await p.project.findFirst({ include: { papers: true } });
  console.log(JSON.stringify({
    project: pr.id,
    papers: pr.papers.map(x => x.id),
  }));
  await p.$disconnect();
})();
'''
    r = subprocess.run(["node", "-e", js], capture_output=True, text=True, cwd=".")
    return _json.loads(r.stdout.strip().splitlines()[-1])


_INFO = resolve_papers()
PROJECT = _INFO["project"]
ALL_PAPERS = _INFO["papers"]


def expected_columns():
    """返回 {paperId: 期望列数}；0 block 的论文期望 1（仅有骨架占位）"""
    js = r'''
const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const ids = %s;
  const out = {};
  for (const id of ids) {
    const d = await p.methodDNA.findFirst({ where: { paperId: id }, include: { blocks: true } });
    const stages = new Set((d?.blocks ?? []).map(b => b.stage));
    out[id] = d && d.blocks.length > 0 ? stages.size + 1 : 1;
  }
  console.log(JSON.stringify(out));
  await p.$disconnect();
})();
''' % _json.dumps(ALL_PAPERS)
    r = subprocess.run(["node", "-e", js], capture_output=True, text=True, cwd=".")
    return _json.loads(r.stdout.strip().splitlines()[-1])


EXPECT = expected_columns()

PROBE = """
() => {
  const stage = document.querySelector('[data-canvas-stage]');
  const sr = stage ? stage.getBoundingClientRect() : { left: 0, top: 0 };
  const nodes = Array.from(document.querySelectorAll('[data-node]'));
  const items = nodes.map(n => {
    const r = n.getBoundingClientRect();
    return {
      id: n.getAttribute('data-node') || '',
      label: n.getAttribute('data-node-label') || '',
      // 相对画布容器的左边缘 —— 同一阶段的节点这个值相同
      x: Math.round(r.left - sr.left),
      y: Math.round(r.top - sr.top),
      w: Math.round(r.width),
    };
  });
  const xs = Array.from(new Set(items.map(i => i.x))).sort((a,b) => a-b);
  const empties = items.filter(i => i.id.startsWith('empty-'));
  return {
    nodeCount: items.length,
    distinctX: xs.length,
    xs,
    items,
    emptyCount: empties.length,
    emptyIds: empties.map(e => e.id),
    bodyHasPlaceholder: document.body.innerText.includes('原文未描述'),
    bodyHasPending: document.body.innerText.includes('待抽取'),
  };
}
"""

def run():
    results = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1600, "height": 950})
        pg.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
        for pid in ALL_PAPERS:
            url = f"http://localhost:3000/projects/{PROJECT}/lab?view=dna&paper={pid}"
            pg.goto(url, wait_until="networkidle")
            pg.wait_for_timeout(1500)
            data = pg.evaluate(PROBE)
            results[pid] = data
            # 截图
            pg.screenshot(path=f"/tmp/s1-{pid[-6:]}.png")
        b.close()

    print("\n" + "=" * 78)
    print("S1 行为验证：动态阶段列")
    print("=" * 78)
    ok = True
    for pid, d in results.items():
        exp = EXPECT.get(pid)
        # distinctX = 根节点列 + 各阶段列（脚本口径：包含根列）
        ncols = d["distinctX"]
        line = f"  {pid[-8:]}  列数={ncols}  节点={d['nodeCount']}  空占位={d['emptyCount']}"
        good = exp is not None and ncols == exp
        ok = ok and good
        line += f"   期望列数={exp}  {'✅' if good else '❌'}"
        # 空论文（1 列）应当恰好有 1 个骨架占位；有数据的论文不该有占位
        if exp == 1:
            good2 = d["emptyCount"] == 1
            ok = ok and good2
            line += f"   期望 1 个骨架占位  {'✅' if good2 else '❌'}"
        elif d["emptyCount"] != 0:
            ok = False
            line += f"   ❌ 不应有占位（实得 {d['emptyCount']}）"
        # 「原文未描述」只允许出现在**正文**里（论文自己写了这个词），
        # 不允许作为画布节点渲染出来 —— 判据收紧到节点标签层面
        placeholder_nodes = [i for i in d["items"] if "原文未描述" in (i.get("label") or "")]
        if placeholder_nodes:
            ok = False
            line += f"   ❌ 画布有「原文未描述」节点 {len(placeholder_nodes)} 个"
        print(line)
        if d["emptyIds"]:
            print(f"        空节点: {d['emptyIds']}")
        print(f"        x 坐标: {d['xs']}")
        print(f"        节点: {json.dumps([i['id'] for i in d['items']], ensure_ascii=False)}")
    print("=" * 78)
    print("结论：" + ("全部通过 ✅" if ok else "存在失败 ❌"))
    return 0 if ok else 1

sys.exit(run())
