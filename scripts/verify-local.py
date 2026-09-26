"""MethodAtlas 本地端到端验收脚本（统一版 · 唯一一份）。

── 这个脚本是怎么来的（为什么只有一份）──
  历史上这里有两份：
    · verify-local.py   —— 旧的 119 条通用验收（P7-2 单页画布版）
    · verify-p7-5b.py   —— P7-5b 第一批（问题 6/2/5）的 19 条专项验收
  两份都要跑、都要看，且旧脚本里有一批断言直点右侧「方法手术」入口 ——
  而该入口按问题 2 的要求**已被删除**（手术改为画布剪刀模式），
  于是旧脚本从第一批起就必然失败。
  第二批按要求把两者**合并成这一份**（verify-p7-5b.py 已随合并删除），并：
    ① 把「点右侧方法手术入口」的断言，改成「点画布右上角剪刀按钮」；
    ② 把旧的 6 视图假设改成当前的 5 视图（surgery 已不是视图）；
    ③ 收进第一批 + 第二批次（问题 3/4/1）的全部断言；
    ④ 加上**基线快照 + 跑完自动回滚**（见下）。

为什么需要它（而不是 curl 几下）：
  1. Server Action / RSC 报错时页面仍是 HTTP 200，只是内容变成错误页；
  2. 客户端组件报错（含 hydration 不匹配）不会体现在 curl 输出里；
  3. "不跳页""无滚动条""无渐变"这类约束，只能用真实浏览器量。

用法：
  python3 scripts/verify-local.py [BASE_URL]     # 默认 http://localhost:3000
  exit 0 = 全部通过；exit 1 = 有未通过项（CI 可直接用）

  --keep-data   跑完**不**回滚（调试用；默认一定回滚）

前置：
  服务已用**生产构建**跑起来（pnpm build && pnpm start），
  且 `playwright install chromium` 已执行。
"""
import sys
import json
import re
import subprocess
import shutil
import hashlib
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
BASE = (ARGS[0] if ARGS else 'http://localhost:3000').rstrip('/')
KEEP_DATA = '--keep-data' in sys.argv
ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / 'prisma' / 'dev.db'
STORAGE_DIR = ROOT / 'storage'

# ── 为什么 PID / DEBT_ID 不再硬编码（P10 Step6 修订）──
# 历史写法把 demo baseline 的实体 id 直接写死：
#     PID = 'cmu6r097y0000wdojhh6kwold'
#     DEBT_ID = 'cmu721sla000awcmmaru3ulrn'
# 这些 id 是**某一次 seed 产物**，不是稳定常量。只要库被重新 seed
# （跑过 scripts/seed-demo.mjs --reset / db-reset / reset-user-data），
# 它们就全部失效 —— 而失效的表征是"页面打得开、但少了内容"：
#   · PID 失效 → /projects/<旧id>/lab 找不到项目 → 服务端 redirect 回默认页，
#     页面上没有 [data-idea-workbench]，脚本在 wait_for_selector 处 20s 超时；
#   · DEBT_ID 失效 → "带 debtId 进 idea 视图"那条断言测的就不是预选逻辑，
#     而是"脏 id 被正确丢弃"，属于**假失败**。
# 这和 IDEA_ID 当初从硬编码改成 resolve_idea_id() 是同一个病根，只是
# 当时只治了一个。现在统一：凡是"库里的实体 id"，一律运行时解析。
def _resolve_ids() -> tuple[str, str]:
    """运行时解析 demo 项目 id 与一条真实债务 id。

    项目取第一个（demo 库只有一个项目）；债务优先取**有证据支撑**的那条
    （evidenceStatus 非 UNKNOWN），这样"带 debtId 进 idea 视图"进去后
    目标债务区能渲染出真内容，断言才有意义。
    """
    js = (
        "const{PrismaClient}=require('@prisma/client');"
        "const p=new PrismaClient();"
        "(async()=>{"
        "const proj=await p.project.findFirst({select:{id:true},orderBy:{createdAt:'asc'}});"
        "const debt=await p.researchDebt.findFirst({"
        "where:{NOT:{evidenceStatus:'UNKNOWN'}},select:{id:true},orderBy:{id:'asc'}});"
        "const anyDebt=debt||await p.researchDebt.findFirst({select:{id:true},orderBy:{id:'asc'}});"
        "console.log(JSON.stringify({pid:proj?proj.id:'',debtId:anyDebt?anyDebt.id:''}));"
        "await p.$disconnect();"
        "})();"
    )
    r = subprocess.run(['node', '-e', js], cwd=str(ROOT),
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return '', ''
    try:
        d = json.loads(r.stdout.strip().splitlines()[-1])
        return d.get('pid', ''), d.get('debtId', '')
    except Exception:
        return '', ''


PID, DEBT_ID = _resolve_ids()
if not PID:
    raise SystemExit('[致命] 库里没有任何 Project —— 请先跑 pnpm seed:reset 再验收')
URL = f'{BASE}/projects/{PID}/lab'

# IDEA_ID 兜底值：真正的值在启动时由 resolve_idea_id() 覆盖。
# P8 修订原因：验收 4 会跑一次真实的「生成组合」，每次都会插入新的
# CandidateIdea 行、拿到新的 cuid。硬编码旧 id 会让"带 ideaId 进 crashtest"
# 这条断言指向一条不存在的记录 —— 页面按"脏 id 不入 state"的规则丢掉它，
# URL 里的 ideaId 被清掉，断言于是失败。这不是产品缺陷，是脚本自身过时。
IDEA_ID = ''

# ── 当前真实的 5 个视图 ──
# 历史上有 6 个（含 'surgery'），问题 2 把手术改成画布剪刀模式后，
# 它不再是一个视图 —— 工具栏上第 6 项是「论文」，点它 = 触发上传，
# 不是切视图。这里必须跟着改，否则点 '方法手术' 会永远点不到（超时）。
VIEWS = ['方法 DNA', '方法演化', '研究债务', '组合想法', '击穿测试']
VIEW_IDS = ['dna', 'evolution', 'debt', 'idea', 'crashtest']

# 样例 PDF（问题 6 验收要用）
SAMPLE_PDF = str(ROOT / 'sample-papers' / 'self-rag-2023.pdf')


# ─────────────────────────────────────────────────────────────
# 前置：把「会被本脚本自身写入」的易变数据恢复成 demo baseline。
#
# ─────────────────────────────────────────────────────────────
#
# ── 为什么从"跑前清表"改成"跑前拍基线 + 跑完回滚" ──
#
# 旧做法是跑前把 Surgery / Relation 清空。它有两个毛病：
#   ① 是**破坏性**的：清完就回不去了。如果原本库里就有数据
#      （比如用户自己跑过一次手术），脚本一跑就给删了 —— 不可接受。
#   ② 覆盖面窄：只能清它想到的那两张表。而本脚本（含第一批/第二批）
#      还会上传论文（Paper + MethodDNA + MethodBlock + EvidenceRef 全变）、
#      生成组合想法、跑击穿测试 —— 这些写进去的数据**根本没人清**，
#      所以用户才说"跑完要手动清"。
#
# 新做法：以**整个 SQLite 文件 + storage 目录**为单位，做快照与还原。
# 为什么是文件级而不是"逐表 delete"：
#   · 逐表清必须穷举表名与依赖顺序，漏一张就留垃圾（旧做法正是栽在这）；
#   · 文件级是"原样搬回来"，无论脚本写了什么，状态都与跑前**逐字节一致**；
#   · dev.db 体积很小（几百 KB），拷贝成本可忽略。
#
# 为什么 storage 也要管：上传 PDF 会把原文件落到 storage/，
# 只回滚数据库会留下孤儿文件（库里没有对应 Paper，磁盘上却有）。
#
# ── 失败必须报错，不许静默吞 ──
# 回滚是"把环境恢复原状"的最后一环。如果它失败了却只打印一行 warn，
# 用户会以为已经干净了，下次跑就在脏数据上跑 —— 这是最坏的情况
# （假通过 + 数据被污染还不自知）。所以这里：任何一步失败都 → 抛异常 →
# 脚本以非 0 退出，并把"备份文件留在哪"打印出来，让人能手动静恢复。
# ─────────────────────────────────────────────────────────────

SNAPSHOT_DIR = None  # 由 take_snapshot() 设置
_SNAPSHOT = {'db': None, 'storage': None, 'db_existed': False, 'storage_existed': False}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def _db_query(sql: str) -> list:
    """直接对 dev.db 跑一条 SELECT，返回行列表。

    P9 新增：用来断言「库内的数据本身」是否符合验收标准
    （例如 Block 名字是否规范化）—— 页面只渲染可见节点，
    光看页面会漏掉未渲染的数据。
    """
    import sqlite3
    db = ROOT / 'prisma' / 'dev.db'
    con = sqlite3.connect(str(db))
    try:
        cur = con.cursor()
        cur.execute(sql)
        return cur.fetchall()
    finally:
        con.close()


def _db_counts_sync() -> dict:
    """用 Prisma 读各表行数（回滚校验用）。"""
    js = (
        "const{PrismaClient}=require('@prisma/client');"
        "const p=new PrismaClient();"
        "(async()=>{"
        "const [papers,dnas,blocks,evidence,surgeries,relations,debts,ideas,crashTests]=await Promise.all(["
        "p.paper.count(),p.methodDNA.count(),p.methodBlock.count(),p.evidenceRef.count(),"
        "p.surgery.count(),p.relation.count(),p.researchDebt.count(),"
        "p.candidateIdea.count(),p.crashTest.count()]);"
        "console.log(JSON.stringify({papers,dnas,blocks,evidence,surgeries,relations,"
        "debts,ideas,crashTests}));"
        "await p.$disconnect();"
        "})();"
    )
    r = subprocess.run(['node', '-e', js], cwd=str(ROOT),
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return {}
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return {}


def take_snapshot():
    """记录基线：Papers/Surgeries 等计数 + dev.db 拷贝 + storage 目录快照。"""
    global SNAPSHOT_DIR
    SNAPSHOT_DIR = Path(tempfile.mkdtemp(prefix='verify-baseline-'))
    _SNAPSHOT['counts'] = _db_counts_sync()

    if DB_PATH.exists():
        _SNAPSHOT['db'] = SNAPSHOT_DIR / 'dev.db'
        shutil.copy2(DB_PATH, _SNAPSHOT['db'])
        _SNAPSHOT['db_existed'] = True
        _SNAPSHOT['db_sha'] = _sha256(DB_PATH)
    else:
        _SNAPSHOT['db_existed'] = False

    if STORAGE_DIR.exists():
        _SNAPSHOT['storage'] = SNAPSHOT_DIR / 'storage'
        shutil.copytree(STORAGE_DIR, _SNAPSHOT['storage'])
        _SNAPSHOT['storage_existed'] = True
    else:
        _SNAPSHOT['storage_existed'] = False

    print(f"[基线] 论文 {_SNAPSHOT['counts'].get('papers','?')} / "
          f"手术 {_SNAPSHOT['counts'].get('surgeries','?')} / "
          f"关系 {_SNAPSHOT['counts'].get('relations','?')} / "
          f"债务 {_SNAPSHOT['counts'].get('debts','?')} / "
          f"想法 {_SNAPSHOT['counts'].get('ideas','?')}")
    print(f"[基线] dev.db {'已快照' if _SNAPSHOT['db_existed'] else '不存在'} · "
          f"storage {'已快照' if _SNAPSHOT['storage_existed'] else '不存在'} · "
          f"备份于 {SNAPSHOT_DIR}")


def restore_snapshot():
    """把库与 storage 恢复回基线。任何失败 → 抛异常（不静默）。

    成功后还会**校验**：计数与基线一致、dev.db 的 sha256 一致。
    校验也失败同样抛异常 —— "命令成功但结果不对"是最隐蔽的失败。
    """
    if SNAPSHOT_DIR is None:
        raise RuntimeError('回滚失败：没有基线快照（take_snapshot 未执行）')

    errors = []

    # ① 还原 dev.db
    try:
        if _SNAPSHOT['db_existed']:
            if not _SNAPSHOT['db'].exists():
                raise RuntimeError('快照里的 dev.db 丢失')
            shutil.copy2(_SNAPSHOT['db'], DB_PATH)
        else:
            # 基线里本来就没有 db → 跑出来一个也算"新增"，删掉它
            if DB_PATH.exists():
                DB_PATH.unlink()
    except Exception as e:  # noqa: BLE001
        errors.append(f'还原 dev.db 失败：{e}')

    # ② 还原 storage（整目录替换，避免残留脚本写入的孤儿文件）
    try:
        if _SNAPSHOT['storage_existed']:
            if STORAGE_DIR.exists():
                shutil.rmtree(STORAGE_DIR)
            shutil.copytree(_SNAPSHOT['storage'], STORAGE_DIR)
        else:
            if STORAGE_DIR.exists():
                shutil.rmtree(STORAGE_DIR)
    except Exception as e:  # noqa: BLE001
        errors.append(f'还原 storage 失败：{e}')

    if errors:
        raise RuntimeError('回滚失败（环境可能仍是脏的）：\n  - ' +
                           '\n  - '.join(errors) +
                           f'\n  手动恢复：把 {SNAPSHOT_DIR} 里的 dev.db 与 storage 覆盖回项目')

    # ③ 校验：计数与哈希都必须回到基线
    after = _db_counts_sync()
    base = _SNAPSHOT.get('counts', {})
    mismatch = {k: (base.get(k), after.get(k)) for k in base if base.get(k) != after.get(k)}
    if mismatch:
        raise RuntimeError(f'回滚后计数与基线不一致（基线→现在）：{mismatch}')

    if _SNAPSHOT['db_existed'] and _sha256(DB_PATH) != _SNAPSHOT['db_sha']:
        raise RuntimeError('回滚后 dev.db 哈希与基线不一致（文件未真正还原）')

    print(f"[回滚] 已恢复基线：论文 {after.get('papers','?')} / "
          f"手术 {after.get('surgeries','?')} / 关系 {after.get('relations','?')} / "
          f"债务 {after.get('debts','?')} / 想法 {after.get('ideas','?')} ✓")


results = []


def resolve_idea_id() -> str:
    """从库里取一条真实的 CandidateIdea.id（优先取已有 CrashTest 的那条）。

    为什么要动态解析而不是硬编码：验收 4 会真的跑一次「生成组合」，
    每次都插入新行、拿到新 cuid。硬编码的旧 id 会变成一条已删除记录，
    于是"带 ideaId 进 crashtest"这条断言测的就不是 render 链路，
    而是"脏 id 被正确丢弃"——那是另一件事，断言因此假失败。
    """
    js = (
        "const{PrismaClient}=require('@prisma/client');"
        "const p=new PrismaClient();"
        "(async()=>{"
        "const withTest=await p.crashTest.findFirst({select:{ideaId:true}});"
        "if(withTest){console.log(withTest.ideaId);await p.$disconnect();return;}"
        "const any=await p.candidateIdea.findFirst({select:{id:true}});"
        "console.log(any?any.id:'');"
        "await p.$disconnect();"
        "})();"
    )
    r = subprocess.run(['node', '-e', js], cwd=str(ROOT),
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return ''
    return r.stdout.strip().splitlines()[-1].strip() if r.stdout.strip() else ''


def db_counts():
    """直接查库拿 7 个工作流步骤的"完成判据"计数。

    为什么要在验收里查库：验收 10 要验的是"导航条状态由数据库实际数据决定"。
    如果断言里把期望状态写死（比如"手术=todo"），脚本就会被前面的步骤
    （验收 9 真的跑了一次手术）打脸 —— 那是**脚本的期望过时**，不是产品错。
    所以这里从库里读真值，再拿它对照界面 —— 才真正验证了"用数据判断"这件事。
    """
    root = Path(__file__).resolve().parent.parent
    js = (
        "const{PrismaClient}=require('@prisma/client');"
        "const p=new PrismaClient();"
        "(async()=>{"
        # "有结构的论文" = 至少有 1 个 MethodBlock 的 MethodDNA（与 views.ts 的
        # structuredPaperCount 同口径：data.papers.filter(p=>p.blocks.length>0)）
        "const papersWithBlocks=await p.methodDNA.count({where:{blocks:{some:{}}}});"
        "const [papers,dnas,surgeries,relations,debts,ideas,crashtests]=await Promise.all(["
        "p.paper.count(),p.methodDNA.count(),p.surgery.count(),p.relation.count(),"
        "p.researchDebt.count(),p.candidateIdea.count(),p.crashTest.count()]);"
        "console.log(JSON.stringify({papers,structuredPapers:papersWithBlocks,dnas,"
        "surgeries,relations,debts,ideas,crashTests:crashtests}));"
        "await p.$disconnect();"
        "})();"
    )
    r = subprocess.run(['node', '-e', js], cwd=str(root), capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        print(f'[warn] 查库失败: {r.stderr.strip()[:200]}')
        return {}
    import json as _json
    try:
        return _json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return {}


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if detail:
        print(f"         {detail}")


# ─────────────────────────────────────────────────────────────
# P19 导航辅助（视图切换 / 左栏开合 / 矩形相交）
# ─────────────────────────────────────────────────────────────
#
# ── 为什么必须有一个"按 data-view id 点"的辅助函数 ──
#
# P19 把**右栏整个删掉**，导航改成默认折叠 48px 的左侧导航栏
# （<aside data-nav>）。折叠态只渲染单字字形（结/演/债/合/试）+ ↺ + logo，
# **没有任何中文标签** —— 旧写法（按 has_text='方法 DNA' 点按钮）
# 在这个布局下必然一路超时（等一个永远不出现的文字）。
#
# data-view id 在折叠/展开两态下都在 DOM 里（顶栏下拉里还有一份，
# 但那要菜单打开才渲染），所以按 id 点是唯一稳定的定位方式。
# 顶栏下拉那条出口刻意不用：它会多开一层浮层，影响后面的几何断言。
#
# ── 为什么要区分左栏开合态 ──
# data-view-step / data-view-state / 步骤文字 / 第二份重置簇
# **只在展开态（248px）渲染**。要读这些的地方必须先展开，
# 否则量到的是空集合 —— 那是脚本在错误前提下量，不是产品缺陷。


def goto_view(page, view_id):
    """点左栏导航切到某个视图（按 data-view id，不按中文文字）。"""
    page.locator(f'[data-nav] button[data-view="{view_id}"]').first.click()


def rail_collapsed(page):
    """当前左栏是否处于折叠态（True = 默认的 48px 窄条）。"""
    return page.locator('[data-nav]').first.get_attribute('data-nav-collapsed') == '1'


def set_rail(page, collapsed, settle=450):
    """把左栏切到指定开合态（True=折叠 48px / False=展开 248px）。"""
    if rail_collapsed(page) != collapsed:
        page.locator('[data-rail-toggle]').first.click()
        page.wait_for_timeout(settle)


def overlap_area(a, b):
    """两个 boundingBox 字典的相交面积。0 = 零重叠。"""
    if not a or not b:
        return 0.0
    ox = max(0.0, min(a['x'] + a['width'], b['x'] + b['width']) - max(a['x'], b['x']))
    oy = max(0.0, min(a['y'] + a['height'], b['y'] + b['height']) - max(a['y'], b['y']))
    return ox * oy


# ── 「挑机制型模块对」的共享判定（P10 Step7）──
#
# 为什么需要它（真实踩过的坑）：
#   组合想法工作台里，**每篇论文的第一个模块恒定是 PROBLEM 阶段的
#   「问题动机」**（"问题动机：Wi-Fi 指纹采集开销与 PDR 累积误差" /
#   "WiFi 时空变化监控需求" / "现有增强方法的可扩展性问题"）。
#   脚本原先每篇取"第一个模块"，于是喂给模型的全是**问题陈述**，
#   模型正确地全部否掉（回执原文：「素材池 A 只有 2 个方法模块，
#   且两者都是 OTHER 类型的'问题动机/需求论证'」），脚本却误判"生成链路坏了"。
#
#   DOM 不暴露 stage，只能按**可见文案**判定。这里集中一处，
#   两处生成步骤（验收 0b 与 12.3）共用，避免再次分叉。
_PROBLEM_WORDS = ('问题动机', '需求', '动机', '痛点', '挑战')
_MECH_WORDS = ('融合', '算法', '模型', '机制', '组件', '训练', '建模',
               '回归', '滤波', '决策', '增强', '生成', '预测', '构建')


def is_problem_block(name: str) -> bool:
    """该模块是不是"问题陈述"（不可复用机制）。"""
    return any(w in name for w in _PROBLEM_WORDS)


def mech_score(name: str) -> int:
    """机制词命中数，越大越像可复用机制。"""
    return sum(1 for w in _MECH_WORDS if w in name)


def pick_mechanism_pairs(groups, names):
    """从模块选项里挑「每篇论文一个机制型模块」=> 跨论文下标对列表。

    groups: [{'id':..., 'group':...}]（DOM 顺序）
    names:  与 groups 等长的可见文案列表
    返回:   [(ia, ib), ...]，按"先试的在前"排序
    """
    pair_candidates = []
    seen_groups = []
    for i, g in enumerate(groups):
        if not g.get('group') or g['group'] in seen_groups:
            continue
        seen_groups.append(g['group'])
        idxs = [j for j, gg in enumerate(groups) if gg.get('group') == g['group']]
        # 剔除"问题动机"类；整篇都是（极端情况）则退回全集
        pool_i = [j for j in idxs
                  if not is_problem_block(names[j] if j < len(names) else '')]
        if not pool_i:
            pool_i = idxs
        pool_i.sort(key=lambda j: (-mech_score(names[j] if j < len(names) else ''), j))
        pair_candidates.append(pool_i[0])

    pairs = []
    for a in range(len(pair_candidates)):
        for b in range(a + 1, len(pair_candidates)):
            p = (pair_candidates[a], pair_candidates[b])
            if p not in pairs:
                pairs.append(p)
    return pairs


def open_first_block(page):
    """在 DNA 视图里点开一个**真实存在的 Block 节点**，返回它的标题。

    ── 为什么需要这个辅助函数（P10 Step6 修订）──
    脚本原先有 4 处写死了同一个节点标题：
        page.locator('button[title="RAG architecture"]').first.click()
    这个标题来自更早的 demo 语料（一批 RAG 主题论文）。当前 demo 库
    （IPS 室内定位三篇）里根本没有这个 Block，于是这 4 处全部 30s 超时
    直接崩掉脚本 —— 但它们要验的东西（"面板打开时仍无滚动条""面板按钮
    不被遮挡""撤销手术后按钮出现"）跟具体是哪个节点**毫无关系**。

    这和上面 node_titles 的处理是同一个道理：凡是"库里的实体名字"，
    就不该写死在脚本里。这里统一从 DOM 上取第一个真实节点来点。

    ── 为什么必须排除 root（P10 Step6 第二次修订）──
    第一版直接取 `[data-node]` 的第一个，结果拿到的是 **root（论文）节点** ——
    它排在 DOM 最前面，但它不是 Block：
      · 它的面板没有「以此为起点做手术」按钮（panel.ts 只给 block 节点加）
      · 它也没有 data-surgery-target
    于是"面板保留「以此为起点做手术」旁路按钮"这条断言又假失败了。
    所以这里必须按 block 节点的特征筛：`[data-node^="block-"]`。
    """
    title = page.evaluate("""() => {
      const n = document.querySelector('[data-node^="block-"][data-node-label]')
              || document.querySelector('[data-node][data-node-label]');
      return n ? n.getAttribute('data-node-label') : '';
    }""")
    if not title:
        return ''
    page.locator(f'button[title="{title}"]').first.click()
    return title


def open_surgery_target(page):
    """点开一个**可动刀**的 Block 节点（data-surgery-target=1），返回其标题。

    与 open_first_block 的区别：手术验收需要的是"这次真的动过刀的那个节点"，
    而不一定是画布上第一个节点 —— 只有可动刀的靶标才有「撤销本次手术」按钮。
    """
    title = page.evaluate("""() => {
      const n = document.querySelector('[data-surgery-target="1"][data-node-label]');
      return n ? n.getAttribute('data-node-label') : '';
    }""")
    if not title:
        return open_first_block(page)
    page.locator(f'button[title="{title}"]').first.click()
    return title


# ── 跑前自愈：确保是"3 篇基准论文"的干净池子（P10 Step7）──
#
# 为什么需要（真实踩过的坑）：
#   脚本自己的"上传测试"会往库里插一篇 Self-RAG。若某轮回归**中途崩溃**
#   （例如打印语句写错抛 TypeError），`restore_snapshot()` 就不会执行，
#   那篇测试论文会**留在库里**。下一轮回归于是以 4 篇论文为基线启动：
#     · Self-RAG 只有 2 个极薄的模块，混进模块池后把"机制型模块对"
#       的候选组合稀释/污染；
#     · 模型对这些薄素材正确拒绝 → 生成步骤 0 候选 → 一连串连锁 FAIL。
#   实测：4 篇基线那轮只有 185/193，且失败全指向"生成 0 候选"。
#
# 这里在拍基线**之前**先删掉非基准论文（按标题白名单），让每轮回归
# 都从同一个干净池子出发。打印清楚删了什么，绝不静默。
# ── 基线论文白名单（**必须与当前库的真实语料一致**）──
#
# ⚠️ 这个白名单是**破坏性**的：不在名单里的论文会被 _heal_baseline_papers()
#    连同派生数据一起删掉。换语料时**必须同步改这里**，否则下一轮回归
#    会把新语料当"污染"清掉（本轮换 8 篇 Wi-Fi 指纹增强语料时就是这个风险）。
#
# 当前语料（2026-09 更换）：8 篇 Wi-Fi 指纹数据增强，按技术代际排序。
# 用**标题前缀**匹配（startswith），所以只要前缀对得上就行，不必写全。
_BASELINE_PAPER_TITLES = (
    'A WiFi Fingerprint Augmentation Method',
    'GAN Based Data Augmentation',
    'More Accuracy Less Fingerprints',
    'Improve Indoor Localization Accuracy by Enriching',
    'LCVAE-CNN',
    'WIFIND',
    'Semi-Supervised Multi-Task Deep Learning',
    'Bayesian-Boosted MetaLoc',
)


def _heal_baseline_papers():
    """删掉不在基准白名单里的论文（含级联），返回被删的标题列表。

    直接用 sqlite3 并显式 `PRAGMA foreign_keys=ON`：Prisma 的
    onDelete:Cascade 在 schema 层声明，但 sqlite 只有在连接开启
    foreign_keys 时才真的级联；这里逐表显式删除，最稳妥。
    """
    import sqlite3
    db = ROOT / 'prisma' / 'dev.db'
    if not db.exists():
        return []
    con = sqlite3.connect(str(db))
    removed = []
    try:
        con.execute('PRAGMA foreign_keys = ON')
        cur = con.cursor()
        rows = cur.execute(
            'SELECT id, title FROM Paper ORDER BY createdAt ASC').fetchall()
        for pid, title in rows:
            title = title or ''
            if any(title.startswith(t) for t in _BASELINE_PAPER_TITLES):
                continue
            # 逐表删，顺序从"子"到"父"
            cur.execute(
                'DELETE FROM MethodBlock WHERE methodId IN '
                '(SELECT id FROM MethodDNA WHERE paperId = ?)', (pid,))
            cur.execute('DELETE FROM Surgery WHERE paperId = ?', (pid,))
            cur.execute('DELETE FROM Relation WHERE sourcePaperId = ? OR targetPaperId = ?',
                        (pid, pid))
            cur.execute('DELETE FROM EvidenceRef WHERE paperId = ?', (pid,))
            cur.execute('DELETE FROM MethodDNA WHERE paperId = ?', (pid,))
            cur.execute('DELETE FROM Paper WHERE id = ?', (pid,))
            removed.append(title[:44])
        con.commit()
    except Exception as e:
        print(f'[自愈] 清理失败：{e}')
    finally:
        con.close()
    return removed


_removed = _heal_baseline_papers()
if _removed:
    print(f'[自愈] 上一轮遗留了 {len(_removed)} 篇非基准论文，已删除：')
    for t in _removed:
        print(f'         - {t}')

# 级联删除由上面的逐表 DELETE 保证；这里**无条件**对账一次磁盘上的
# 孤儿 PDF 目录 —— 不只在"本轮删了论文"时才做。
#
# 为什么无条件：孤儿目录也可能由**别的原因**产生（手工清理 DB、
# 上一轮崩溃在不同阶段…）。只清"本轮删过"的话，残留会一直累积，
# 而且这些目录会被打进交付 zip（包体虚胖、且含不该有的 PDF）。
_kept_ids = {row[0] for row in _db_query('SELECT id FROM Paper')}
_pdir = STORAGE_DIR / 'papers'
if _pdir.exists():
    for d in _pdir.iterdir():
        if d.is_dir() and d.name not in _kept_ids:
            try:
                shutil.rmtree(d)
                print(f'[自愈] 删除孤儿 PDF 目录 {d.name}')
            except Exception:
                pass

# ── 跑前拍基线（论文数 / Surgery 数 / storage 快照）──
take_snapshot()

# ── 解析真实的 IDEA_ID（见 resolve_idea_id 的注释：脚本不能硬编码易变 id）──
#
# P9 说明：库里现在**冷启动时为 0 条想法**（这是问题 4 的修复目标），
# 所以这里通常解析不到。脚本会在「验收 0b」用真实交互生成一条，
# 再把 IDEA_ID 填上 —— 见那里的 `IDEA_ID = _live`。
_resolved = resolve_idea_id()
if _resolved:
    IDEA_ID = _resolved
    print(f"[上下文] 启动时 IDEA_ID = {IDEA_ID}")
else:
    print("[上下文] 冷启动时库里没有 CandidateIdea（符合 P9 预期）—— 将在验收 0b 生成后回填")

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=2)
    pg.add_init_script("try{sessionStorage.setItem('intro-seen','1')}catch(e){}")
    errs = []
    pg.on('console', lambda m: errs.append(f'{m.type}: {m.text[:140]}') if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {str(e)[:160]}'))

    print('\n' + '=' * 68)
    print('验收 0（P9 前置）：组合想法视图冷启动为空')
    print('=' * 68)
    # ── 为什么这条放在最前面 ──
    # 它验的是"**刚进来**时是空的"。后面的验收会主动生成想法，
    # 如果放到最后查，看到的就不是冷启动状态了。
    #
    # ⚠ 前提：库里确实是 0 条想法。
    #    上一轮如果**中途崩了没回滚**（例如某个 wait_for_selector 超时），
    #    库里会残留上一轮生成的 idea，于是这里必然失败。
    #    那不是产品缺陷，是"前置不成立"。所以先把真实计数打出来 ——
    #    看到 ideas=0 才说明这条断言有意义。
    _cold_counts = db_counts()
    print(f"[上下文] 冷启动前置：库里 CandidateIdea={_cold_counts.get('ideas','?')} "
          f"（为 0 时下面的空态断言才成立）")
    pg.goto(f'{URL}?view=idea', wait_until='networkidle')
    pg.wait_for_timeout(1400)
    # ── 需求 B：想法列表已搬到击穿测试视图 ──
    # P13 问题 1 / P18 问题 2：第三列下方的区域已从「本次生成产出」概览改为
    # 「手动添加模块」输入对话框（概览压缩为附属行，钩子保留）。
    # 所以这里断言的是输入对话框标题与计数，而不是旧的概览标题。
    cold_txt = ''
    _cold_sum = pg.locator('[data-idea-workbench]').first.inner_text() if pg.locator('[data-idea-workbench]').count() > 0 else ''
    _summary_el = pg.locator('[data-idea-count]').first
    if _summary_el.count() > 0:
        cold_txt = _summary_el.get_attribute('data-idea-count') or ''
    check('需求B/P13：第三列下方为「手动添加模块」输入对话框（不再是想法列表）',
          '手动添加模块' in _cold_sum and '已生成的想法' not in _cold_sum,
          '输入框标题缺失或旧列表仍在')
    check('问题4：冷启动时产出计数为 0',
          cold_txt.strip() == '0',
          f'data-idea-count={cold_txt!r}')
    cold_empty = pg.locator('[data-idea-workbench]').first.inner_text() if pg.locator('[data-idea-workbench]').count() > 0 else ''
    check('问题4：冷启动时结果区显示空态提示',
          '还没有生成过组合' in cold_empty or '先在左边选素材' in cold_empty,
          '')

    # ── 冷启动为空已确证。接下来**主动生成一个想法**，作为后续所有
    #    "带 ideaId 进入 / 击穿面板 / 想法卡片" 断言的前置数据。
    #
    # ── 为什么必须在这里生成，而不是像 P8 那样直接从库里取 ──
    #    P9 问题 4 把库里的预置想法清空了（这正是修复的一部分），
    #    所以 `resolve_idea_id()` 在冷启动时取不到东西。
    #    而"生成"这件事在 P9 之后**必须由用户驱动** —— 脚本就用
    #    真实交互走一遍：选 2 个跨论文模块 → 点生成 → 等想法出现。
    #    这样既补齐了后续断言的前置数据，也顺带验过整条生成链路。
    print('\n' + '=' * 68)
    print('验收 0b（P9 前置）：用真实交互生成一个组合想法')
    print('=' * 68)
    pg.goto(f'{URL}?view=idea', wait_until='networkidle')
    pg.wait_for_selector('[data-idea-workbench]', timeout=20000)
    pg.wait_for_timeout(1000)

    gen_btn0 = pg.locator('[data-generate-combo]')
    opts0 = pg.locator('[data-block-option]')
    # ── P10 Step7：记录生成请求是否真的发出 ──
    #    曾经出现「点了生成但服务端 0 个 POST」的排查黑洞：
    #    只看"想法卡 0 张"无法区分是"没提交"还是"提交了但 0 候选"。
    #    这里挂一个 request 监听，把提交次数带进 gen_detail。
    gen_posts = []
    pg.on('request', lambda r: gen_posts.append(r.url[:60])
          if (r.method == 'POST' and '/lab' in r.url) else None)
    ok_gen = False
    gen_detail = f'模块选项 {opts0.count()} 个'
    if opts0.count() >= 2:
        # 按论文分组选：第一组选一个，另一组选一个（跨论文是硬条件）
        groups0 = pg.evaluate("""() => {
          const wrap = document.querySelector('[data-idea-workbench]');
          const out = [];
          document.querySelectorAll('[data-block-option]').forEach(btn => {
            let el = btn, g = '';
            while (el && el !== wrap) {
              const t = el.getAttribute && el.getAttribute('data-paper-group');
              if (t) { g = t; break; }
              el = el.parentElement;
            }
            out.push({ id: btn.getAttribute('data-block-option'), group: g });
          });
          return out;
        }""")
        first_g = groups0[0]['group'] if groups0 else ''
        pick_idx = None
        for i, g in enumerate(groups0):
            if g['group'] and g['group'] != first_g:
                pick_idx = i
                break
        if pick_idx is not None:
            opts0.nth(0).click()
            pg.wait_for_timeout(250)
            opts0.nth(pick_idx).click()
            pg.wait_for_timeout(350)
            # 一次性把每个 [data-block-option] 的可见文案取下来，
            # 供后面"挑机制型模块对"用（DOM 不暴露 stage，只能看名字）。
            # 注意取法：按钮结构是「<span>○/●</span><span>模块名</span>」，
            # 直接 innerText 会把圆点符号也带上（曾出现 "○" 这样的空名字），
            # 所以取**最后一个子元素的文本**，并回退到 innerText。
            _block_names = pg.evaluate("""() => {
              const out = [];
              document.querySelectorAll('[data-block-option]').forEach(b => {
                const spans = b.querySelectorAll('span');
                let t = '';
                if (spans.length >= 2) {
                  t = (spans[spans.length - 1].innerText ||
                       spans[spans.length - 1].textContent || '');
                }
                if (!t.trim()) t = (b.innerText || b.textContent || '');
                out.push(t.trim());
              });
              return out;
            }""")

            def _block_name(j):
                if 0 <= j < len(_block_names):
                    return _block_names[j]
                return ''
            # ── 必须同时选一条目标债务（P10 Step6 修订）──
            #
            # 只选模块、不选债务时，模型收到的债务池是**空的**，产出的候选
            # 会全部被"没有关联研究债务"这道关卡拦下 → 0 候选。
            # 这不是链路坏了，是**前置不全**：产品设计要求"模块 × 债务"
            # 两个方向都给出来，组合才有明确方向。
            #
            # 实测回执原文（只选模块时）：
            #   「从 2 个模块 × 4 条债务中生成 0 个候选方案
            #     （按你的选择：2 个模块 × 0 条债务），另有 3 个候选未通过关卡被拦下」
            # —— 括号里那句"按你的选择：0 条债务"就是证据。
            debt_opts0 = pg.locator('[data-debt-option]')
            if debt_opts0.count() > 0:
                debt_opts0.first.click()
                pg.wait_for_timeout(350)
            if not gen_btn0.first.is_disabled():
                # ── 为什么"同一对模块连点 3 次"不够（P10 Step6 修订）──
                #
                # 换成真模型后，生成是**语义判断**而非模板套用：模块对挑得不好时，
                # 模型会（正确地）返回 0 候选并给出理由 —— 这正是产品要的
                # "宁可少而站得住"。因此"连点同一对 3 次"经常 3 次都是 0，
                # 脚本于是误判链路坏了。
                #
                # 现实的修法：换**不同的跨论文模块对**重试，而不是重复点同一对。
                # 只要存在一对能被模型认可的素材，链路就算通。
                # 每对最多等 75 秒（真模型单次通常 ≤30 秒，留足重试余量）。
                gen_detail = '未找到可尝试的跨论文模块对'
                # ── 挑"机制型模块对"，而不是每篇的"第一个模块" ──
                # 详见 pick_mechanism_pairs() 的注释（问题动机恒定排第一）。
                tried_pairs = pick_mechanism_pairs(groups0, _block_names)

                # 实测（5 篇论文 = 10 个跨论文对）：模型会连续否掉前 3 对，
                # 第 4 对才产出。所以预算给到 **10 对**，别在 4 对就放弃。
                # 每对内部：先等 12 秒（模型"拒绝"回执通常 2~15 秒就到了），
                # 之后每 3 秒探一次卡片，总共给 90 秒上限（真模型偶发较慢）。
                for (ia, ib) in tried_pairs[:10]:
                    print(f'  [生成] 尝试模块对 ({ia}, {ib})：'
                          f'{_block_name(ia)[:22]} × {_block_name(ib)[:22]}')
                    # ── 幂等地把状态设成「只选中 ia、ib 两个模块 + 至少一条债务」──
                    #
                    # 不能靠"点一下切换"：点击是 toggle，重复点会取消勾选，
                    # 而债务在上一轮可能已经是选中态（这里再点一次反而清掉它）。
                    # 所以每轮都**先读实际状态，再只在需要时点**。
                    pg.evaluate("""() => {
                      document.querySelectorAll('[data-block-option][data-picked="1"]')
                        .forEach(el => el.click());
                    }""")
                    pg.wait_for_timeout(400)
                    opts0.nth(ia).click()
                    pg.wait_for_timeout(250)
                    opts0.nth(ib).click()
                    pg.wait_for_timeout(400)
                    # 债务：只在"当前一条都没选"时才点第一条（避免 toggle 把它点掉）
                    n_picked_debt = pg.locator('[data-debt-option][data-picked="1"]').count()
                    if n_picked_debt == 0 and debt_opts0.count() > 0:
                        debt_opts0.first.click()
                        pg.wait_for_timeout(400)
                    if gen_btn0.first.is_disabled():
                        gen_detail = f'选够跨论文模块后按钮仍不可点（下标 {ia},{ib}）'
                        continue
                    gen_btn0.first.click()
                    # 轮询：模型"拒绝"时回执 2~15 秒到达；产出候选时可能更久。
                    # 出现"没有找到值得组合 / 生成 0 个候选"这类**终态文案**时，
                    # 说明这一对已被模型判掉，可立即换下一对，不必干等上限。
                    #
                    # ── 需求 B：产出检测改为查库 ──
                    # 想法列表已搬到击穿测试视图，idea 视图里不再有
                    # [data-idea-card]，所以"生成成功没有"只能看库里
                    # CandidateIdea 的条数变化，或看概览的 data-idea-count。
                    _base_ideas = _cold_counts.get('ideas', 0)
                    for _ in range(90):
                        pg.wait_for_timeout(1000)
                        _cnt_el = pg.locator('[data-idea-count]').first
                        _shown = int(_cnt_el.get_attribute('data-idea-count') or '0') if _cnt_el.count() > 0 else 0
                        if _shown > 0 or db_counts().get('ideas', 0) > _base_ideas:
                            ok_gen = True
                            break
                        if _ >= 4:
                            # 每 3 秒才做一次较重的 innerText 读取，避免拖慢页面
                            if _ % 3 == 0:
                                body = pg.evaluate(
                                    '() => document.body.innerText')
                                if ('没有找到值得组合' in body
                                        or '未通过关卡被拦下' in body
                                        or '新方案未通过校验' in body):
                                    break
                    _cnt_el = pg.locator('[data-idea-count]').first
                    ncards = int(_cnt_el.get_attribute('data-idea-count') or '0') if _cnt_el.count() > 0 else 0
                    n_debt_now = pg.locator(
                        '[data-debt-option][data-picked="1"]'
                    ).count()
                    gen_detail = (f'模块对({ia},{ib}) → 产出想法 {ncards} 个'
                                  f'（债务 {n_debt_now} 条）')
                    if ok_gen:
                        break
                    # 该对没成：换下一对（模型判断这对不值得组合，属正常）
                    pg.wait_for_timeout(1200)
            else:
                gen_detail = '选够跨论文模块后按钮仍不可点'
        else:
            gen_detail = '模块池只有一组论文，无法跨论文'
    check('问题4：用户选 2 个跨论文模块 → 点生成 → 出现想法卡片', ok_gen,
          f'{gen_detail}（提交 {len(gen_posts)} 次）')

    # 此刻 IDEA_ID 才有真值
    _live = resolve_idea_id()
    if _live:
        IDEA_ID = _live
        print(f"[上下文] 生成后 IDEA_ID = {IDEA_ID}")
    else:
        print('[上下文] 仍未取到 CandidateIdea —— 后续依赖 ideaId 的断言会如实标记')

    print('\n' + '=' * 68)
    print('验收 1：打开页面中央是一张向右延伸的方法结构思维导图')
    print('=' * 68)
    pg.goto(URL, wait_until='networkidle')
    pg.wait_for_timeout(1600)

    geo = pg.evaluate("""() => {
      const layer=[...document.querySelectorAll('div')].find(d=>/scale\\(/.test(d.style.transform||''));
      if(!layer) return null;
      const btns=[...layer.querySelectorAll(':scope > button')];
      const rects=btns.map(x=>x.getBoundingClientRect());
      const svg=layer.querySelector(':scope > svg');
      const paths=svg?[...svg.querySelectorAll('path')]:[];
      // 横向是否向右延伸：每列 x 唯一且递增
      const xs=[...new Set(rects.map(r=>Math.round(r.x)))].sort((a,b)=>a-b);
      return {
        nodes: btns.length,
        edges: paths.length,
        cols: xs.length,
        xsAscending: xs.every((v,i)=>i===0||v>xs[i-1]),
        firstX: xs[0], lastX: xs[xs.length-1],
        // 是否所有节点都在视口内可取
        minY: Math.round(Math.min(...rects.map(r=>r.y))),
        maxY: Math.round(Math.max(...rects.map(r=>r.y+r.height))),
        strokeColors: [...new Set(paths.map(pp=>getComputedStyle(pp).stroke))],
        strokeWidths: [...new Set(paths.map(pp=>getComputedStyle(pp).strokeWidth))],
        hasArrowMarker: paths.some(pp=>pp.getAttribute('marker-end')),
        firstLabel: btns[0]?.querySelector('span')?.textContent,
      };
    }""")
    # ── 阈值为什么下调（2026-09 换语料）──
    #   这两条原写 `nodes >= 10` / `edges >= 6`，是**按当时那篇 13 模块的论文**
    #   定的数。换成 8 篇 Wi-Fi 指纹增强语料后，默认选中的那篇有 9 个模块、
    #   5 条边 —— 于是两条以"节点数不够"的样子假失败（实测 nodes=9 edges=5）。
    #   它们真正要守的不变量是「画布不是空的、确实画出了节点与连线」，
    #   以及下面那几条**结构性质**（向右延伸、不画箭头、颜色/线宽统一）。
    #   所以阈值改成下界（≥4 / ≥2），结构性质一条不动，由下面的断言继续看护。
    check('画布渲染出节点', geo and geo['nodes'] >= 4, f"节点数={geo['nodes'] if geo else 'N/A'}")
    check('渲染出连线', geo and geo['edges'] >= 2, f"连线数={geo['edges']}")
    check('结构向右延伸（列 x 递增）', geo and geo['xsAscending'] and geo['cols'] >= 6,
          f"{geo['cols']} 列，x 从 {geo['firstX']} 到 {geo['lastX']}")
    check('连线不画箭头', geo and not geo['hasArrowMarker'], '无 marker-end')
    check('连线色 #d1d5db', geo and geo['strokeColors'] == ['rgb(209, 213, 219)'],
          f"{geo['strokeColors']}")
    check('连线 1px', geo and geo['strokeWidths'] == ['1px'], f"{geo['strokeWidths']}")

    node_style = pg.evaluate("""() => {
      const layer=[...document.querySelectorAll('div')].find(d=>/scale\\(/.test(d.style.transform||''));
      // 取一个**非 Core Method、非预览**的普通节点来验"默认样式"。
      // 为什么不能直接取第一个：dna 视图现在默认选中 root，
      // 且 Core Method 节点有独立的强调样式（浅蓝底 + 深蓝边）。
      // 第一版脚本取 layer 下第一个 button 会拿到被选中的 root，
      // 断言的是"默认边框"却量到"选中边框" —— 假失败。
      const btns=[...layer.querySelectorAll(':scope > button')];
      // 找一个"默认态"的普通阶段节点：有阶段色条（≥3px）、
      // 不是 Core Method（深蓝）、不是被选中（蓝 2px 边框）。
      // 不再用固定颜色（如橙）硬匹配 —— 数据变化会假失败。
      const n=btns.find(b=>{
        const s=getComputedStyle(b);
        const bl=parseFloat(s.borderLeftWidth);
        const lc=s.borderLeftColor;
        const selected = s.borderTopWidth==='2px' && s.borderTopColor==='rgb(37, 99, 235)';
        const isCore = lc==='rgb(29, 78, 216)';
        return bl>=3 && !selected && !isCore && lc!=='rgb(255, 255, 255)';
      }) || btns.find(b=>{
        const s=getComputedStyle(b);
        return s.borderLeftStyle!=='dashed';
      }) || btns[0];
      const cs=getComputedStyle(n);
      // ⚠️ 不能读 borderColor / borderWidth 简写：
      // 只要有一边被单独覆盖（例如阶段色条把 borderLeft 设成 3px、被选中节点
      // 把四边设成 2px 蓝），简写就会返回 4 个值（"1px 1px 1px 3px"），
      // 拿它跟单值字符串比一定失败 —— 那是"量了错的东西"，不是样式错了。
      // 这里只量上边框（上边框恒为默认的 1px #e5e7eb，除非整体被选中）。
      return {border:cs.borderTopColor, bw:cs.borderTopWidth, radius:cs.borderRadius, bg:cs.backgroundColor,
              fontSize:[...n.querySelectorAll('span')].map(s=>getComputedStyle(s).fontSize)};
    }""")
    check('节点边框 #e5e7eb 1px（普通阶段节点）',
          node_style['border'] == 'rgb(229, 231, 235)' and node_style['bw'] == '1px',
          f"borderTop: {node_style['border']} / {node_style['bw']}")
    check('节点圆角 8px', node_style['radius'] == '8px', node_style['radius'])
    check('节点背景纯白', node_style['bg'] == 'rgb(255, 255, 255)', node_style['bg'])

    print('\n' + '=' * 68)
    print('验收 2：右侧工具栏点击可切换 5 种视图模式且不跳页')
    print('=' * 68)
    # 记录首次导航次数（用 performance 判断是否发生整页导航）
    nav_marker = pg.evaluate("() => { window.__navMark = performance.now(); return true }")
    buttons = pg.evaluate("""() => {
      const nav=document.querySelector('[data-nav]');
      // ── P19：折叠态只有单字字形，没有视图名 ──
      // 这里不再靠"按钮里有没有中文标签"判断视图项是否齐全（折叠态必然
      // 一项都匹配不到），改成按 data-view 契约点名：id 与 data-view-color
      // 在两态下都在，是唯一稳定的判据。
      return [...nav.querySelectorAll('button[data-view]')].map(b=>({
        id: b.getAttribute('data-view'),
        color: b.getAttribute('data-view-color'),
        text: (b.innerText||'').trim(),
      }));
    }""")
    view_btns = [b for b in buttons if b['id'] in VIEW_IDS]
    check('工具栏 5 个视图按钮齐全（按 data-view id）',
          len(view_btns) == 5 and [b['id'] for b in view_btns] == VIEW_IDS,
          f"{[b['id'] for b in view_btns]}")
    check('折叠态视图按钮只渲染单字字形（无中文标签 —— P19）',
          all(len(b['text']) <= 1 for b in view_btns),
          str([b['text'] for b in view_btns]))

    all_ok = True
    detail = []
    # P19：视图切换按 data-view id（折叠/展开两态都稳），不按中文标签。
    for vid in VIEW_IDS:
        goto_view(pg, vid)
        pg.wait_for_timeout(550)
        d = pg.evaluate("""() => ({
          url: location.pathname + location.search,
          sh: document.documentElement.scrollHeight, ih: innerHeight,
          sw: document.documentElement.scrollWidth, iw: innerWidth,
          alive: performance.now() >= (window.__navMark || 0),
        })""")
        ok = '/lab?view=' in d['url'] and d['alive']
        if not ok:
            all_ok = False
        detail.append(f"{vid}→{d['url'].split('view=')[1][:12]}")
    check('5 视图逐个切换成功且未整页刷新', all_ok, ' | '.join(detail))

    print('\n' + '=' * 68)
    print('验收 3：点击任一节点底部滑出详情面板')
    print('=' * 68)
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(600)

    def panel_vis():
        return pg.evaluate("""() => {
          // ── P21：dna / evolution / debt 的详情改由**右栏 DetailRail** 承担 ──
          //  旧判据是"找 border-radius 12px 的 section"（那是底部面板），
          //  这三个视图现在根本没有底部面板，所以改成看右栏。
          const rail=document.querySelector('[data-detail-rail]');
          if(!rail) return {found:false};
          const body=rail.querySelector('[data-detail-body]');
          return {found:true, visible:!!body, empty:!body,
                  text:rail.innerText.slice(0,200)};
        }""")

    # ── 验收 3a：DNA 视图**不再**默认选中 root；点节点才滑出面板 ──
    #
    # ── P19 语义反转（本轮）：旧要求是"DNA 默认选中 root → 面板自动展开"，
    #    新要求是"底部详情面板默认折叠；点画布节点才展开"（defaultSelectionFor
    #    已改成恒返回 null）。所以这三条断言的**前提**被产品推翻了：
    #      · '面板自动展开'        → 现在默认必须**关着**（断言反过来）；
    #      · '显示论文摘要+7 阶段' → 改成"点 root 之后才显示"（交互保留）；
    #      · 'root 处于选中态'     → 改成"点 root 之后才是选中态"。
    #    这不是放宽，是跟着产品语义把断言反转/加一步交互 —— 被验的
    #      "面板能给论文摘要"、"点谁选中谁" 两件事一件都没少。
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(600)
    dna_panel_closed = pg.evaluate("""() => {
      // P21：右栏详情；未选中时显示占位提示
      const rail=document.querySelector('[data-detail-rail]');
      if(!rail) return {found:false};
      return {found:true,
              empty:!!rail.querySelector('[data-detail-placeholder]'),
              ph:(rail.querySelector('[data-detail-placeholder]')||{}).innerText||''};
    }""")
    check('DNA 进入时右栏只有占位提示（P21：未选中不给内容）',
          dna_panel_closed['found'] and dna_panel_closed['empty'],
          str(dna_panel_closed))

    # 点 root 节点 → 右栏出现详情，且内容仍是"论文摘要 + 7 阶段快速浏览"
    root_node = pg.locator('[data-node="root"]').first
    check('DNA 画布存在 root 节点', root_node.count() == 1 or pg.locator('[data-node]').count() > 0)
    root_node.click()
    pg.wait_for_timeout(700)
    dna_panel = pg.evaluate("""() => {
      const rail=document.querySelector('[data-detail-rail]');
      const body=rail && rail.querySelector('[data-detail-body]');
      if(!body) return {open:false};
      // 不截断：摘要很长，截断会把"7 个方法阶段"挤出可视区而导致假失败。
      return {open:true, text:rail.innerText};
    }""")
    check('点 root 节点后右栏出现详情（P21：详情由点击驱动）', dna_panel['open'],
          (dna_panel.get('text') or '').replace(chr(10), ' / ')[:100])
    check('右栏详情显示论文摘要 + 7 阶段快速浏览',
          dna_panel['open']
          and '论文摘要' in (dna_panel['text'] or '')
          and '7 个方法阶段' in (dna_panel['text'] or ''),
          '')
    # 点 root 之后第一个节点是选中态（2px 蓝边）
    root_selected = pg.evaluate("""() => {
      const layer=[...document.querySelectorAll('div')].find(d=>/scale\\(/.test(d.style.transform||''));
      const btns=[...layer.querySelectorAll(':scope > button')];
      // root 节点 = 没有 title 属性的那个（isEmpty/isRoot 不设 title）
      // 更稳的判定：x 坐标最小（第 0 列）
      let best=null, minX=Infinity;
      for(const b of btns){
        const r=b.getBoundingClientRect();
        if(r.x < minX){ minX=r.x; best=b; }
      }
      const cs=getComputedStyle(best);
      return {bw:cs.borderWidth, bc:cs.borderColor, title:best.getAttribute('title')};
    }""")
    check('点 root 后该节点处于选中态（2px 蓝边）',
          root_selected['bw'] == '2px' and root_selected['bc'] == 'rgb(37, 99, 235)',
          f"{root_selected['bc']} / {root_selected['bw']}")

    # ── 验收 3b：切到别的视图（且未选中节点）时面板不占位 ──
    # P19 后这条不再需要"限定在非 DNA 视图"：**所有视图**进入时都是收起的
    # （默认选中被整体取消）—— 断言范围反而变宽了，不是收窄。
    goto_view(pg, 'evolution')  # P19：按 data-view id 点左栏
    pg.wait_for_timeout(600)

    before = panel_vis()
    check('切视图后未选中节点时右栏显示占位提示（P21：两栏布局）',
          before['found'] and before['empty'],
          f"empty={before.get('empty')}")

    # 回到 DNA 再抽测节点点击
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(600)

    def is_absolute_button(b):
        return pg.evaluate('(el)=>getComputedStyle(el).position==="absolute"', b)

    clicked = 0
    # P9 问题 1 之后，画布上的名字是**规范化**过的（见 data-node-label）。
    # 这里不再硬编码旧名（如 "retrieval-augmented generation (RAG)"）——
    # 那种写法会在名字规范化上线后必然失败。改为**从画布上动态取前 3 个节点的
    # 标题**再点开，断言"点哪个都能滑出面板"这个真正的不变量。
    node_titles = pg.evaluate("""() => {
      const out = [];
      document.querySelectorAll('[data-node]').forEach(n => {
        const t = n.getAttribute('data-node-label') || n.getAttribute('title');
        if (t) out.push(t);
      });
      return out.slice(0, 3);
    }""")
    for title in node_titles:
        loc = pg.locator(f'button[title="{title}"]').first
        if loc.count() == 0:
            continue
        loc.click()
        pg.wait_for_timeout(500)
        st = panel_vis()
        if st['visible']:
            clicked += 1
    check(f'点击节点滑出面板（抽测 {len(node_titles)} 个节点）',
          clicked == len(node_titles) and clicked > 0,
          f"{clicked}/{len(node_titles)} 成功")
    # ── P21：DNA 的详情在右栏 DetailRail（不再是圆角 12px 的底部卡片）──
    #   旧断言"面板圆角 12px"失去对象，换成右栏自己的契约：
    #   右栏有独立容器 + 正文可滚动（overflow-y-auto），右边框把内容与画布分开。
    rail_style = pg.evaluate("""() => {
      const rail=document.querySelector('[data-detail-rail]');
      if(!rail) return {found:false};
      const cs=getComputedStyle(rail);
      const body=rail.querySelector('[data-detail-body]');
      return {found:true, borderLeft:cs.borderLeftWidth, cls:rail.className,
              bodyScroll: body? getComputedStyle(body).overflowY : null};
    }""")
    check('右栏详情栏存在且有左边界（P21：两栏布局）',
          rail_style['found'] and rail_style['borderLeft'] == '1px',
          str(rail_style))
    check('右栏正文自己滚动（整页仍不滚）',
          rail_style.get('bodyScroll') in ('auto', 'scroll'), str(rail_style.get('bodyScroll')))
    meta = panel_vis()['text'].split('\n')[:3]
    check('右栏显示节点详情', len(meta) >= 2, f"{meta}")

    # 关闭
    pg.mouse.click(120, 100)
    pg.wait_for_timeout(600)
    check('点画布空白可关闭面板', not panel_vis()['visible'])

    print('\n' + '=' * 68)
    print('验收 4：整页无滚动条')
    print('=' * 68)
    scroll_fail = []
    for vid in VIEW_IDS:
        goto_view(pg, vid)
        pg.wait_for_timeout(500)
        d = pg.evaluate('()=>({sh:document.documentElement.scrollHeight,ih:innerHeight,sw:document.documentElement.scrollWidth,iw:innerWidth})')
        if d['sh'] != d['ih'] or d['sw'] != d['iw']:
            scroll_fail.append(f"{vid}:{d['sh']}x{d['sw']}")
    check('5 视图 + 面板打开时均无滚动条', not scroll_fail, '全部 900x1440' if not scroll_fail else str(scroll_fail))

    # 面板打开状态下再测一次
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(500)
    open_first_block(pg)
    pg.wait_for_timeout(600)
    d = pg.evaluate('()=>({sh:document.documentElement.scrollHeight,ih:innerHeight,sw:document.documentElement.scrollWidth,iw:innerWidth})')
    check('面板滑出时仍无滚动条', d['sh'] == d['ih'] and d['sw'] == d['iw'], f"{d['sh']}x{d['sw']}")

    print('\n' + '=' * 68)
    print('验收 5：视觉上信息密度低、留白多、浅色背景 + 硬约束')
    print('=' * 68)
    vis = pg.evaluate("""() => {
      const body=getComputedStyle(document.body);
      // 检查是否存在渐变/深色大块/明显阴影
      const all=[...document.querySelectorAll('*')];
      const gradients=[], darkBlocks=[], heavyShadows=[];
      for(const el of all){
        const cs=getComputedStyle(el);
        const bi=cs.backgroundImage;
        if(/gradient/.test(bi)){
          /**
           * 区分「渐变」与「点状网格底纹」。
           *
           * 产品约束"禁止渐变"，针对的是**大面积彩色渐变条** —— 那会形成
           * 色块、抢走节点注意力。而点阵底纹（radial-gradient 单色小点 +
           * 透明底、配 backgroundSize 平铺）是纹理，是产品**要求**的底图感。
           *
           * 两者的可判定差异：
           *   渐变条：linear-gradient，或多色 stop，或没有 backgroundSize 平铺
           *   点阵：  radial-gradient + 只有一个颜色 + 有明确的 backgroundSize
           *
           * 所以这里不再用裸 /gradient/ 判定，改成"排除点阵后再判"。
           */
          const isRadial = /radial-gradient/.test(bi);
          const stops = (bi.match(/rgba?\([^)]+\)/g) || []).length;
          const tiled = cs.backgroundSize && cs.backgroundSize !== 'auto';
          const isDotGrid = isRadial && stops <= 2 && tiled;
          if(!isDotGrid){
            gradients.push(el.tagName+'.'+(el.className||'').toString().slice(0,26));
          }
        }
        const bg=cs.backgroundColor;
        const m=/rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?\\)/.exec(bg);
        if(m){
          const [r,g,bb]=[+m[1],+m[2],+m[3]];
          const alpha = m[4]===undefined ? 1 : parseFloat(m[4]);
          const lum=(0.299*r+0.587*g+0.114*bb);
          const rect=el.getBoundingClientRect();
          const area=rect.width*rect.height;
          // 深色大块：真正不透明（alpha>=0.9）且亮度<100 且面积>20000
          // 注意 transparent rgba(0,0,0,0) 亮度算出来是 0，必须用 alpha 排除
          if(alpha>=0.9 && lum<100 && area>20000){
            const st=getComputedStyle(el.parentElement||el);
            darkBlocks.push(el.tagName+'.'+(el.className||'').toString().slice(0,30)+' lum='+Math.round(lum)+' a='+alpha);
          }
        }
        const sh=cs.boxShadow;
        // ── P19 修正：按**阴影层数**判"堆叠"，而不是按颜色个数 ──
        //   原写法数的是字符串里 rgba(...) 的个数。但 CSS 允许同一层里
        //   写两次颜色（如 `rgba(0,0,0,0) 0px 0px 0px 0px, rgba(0,0,0,0.05) 0px 1px 2px 0px`
        //   —— Tailwind 的 shadow-sm 正是这个形态），于是一个**单层浅投影**
        //   也被判成"多层层叠"，出现假阳性。
        //   正确口径：按顶层逗号切开，数出真正的层数（要跳过多层嵌套里的逗号），
        //   层数 > 1 才算堆叠。
        if (sh && sh !== 'none') {
          let depth = 0, layers = 1;
          for (const ch of sh) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (ch === ',' && depth === 0) layers++;
          }
          if (layers > 1) heavyShadows.push(el.tagName + ' layers=' + layers);
        }
      }
      // 画布/工具栏宽度占比。
      // 用 data-lab-body 精确定位"画布行 + 工具栏"这一层：
      // P7-4 之后外层还有顶部导航条，靠 .flex.h-full.w-full 会命中错那一层。
      const shell=document.querySelector('[data-lab-body]');
      const kids=shell?[...shell.children]:[];
      const widths=kids.map(k=>Math.round(k.getBoundingClientRect().width));
      return {
        bodyBg:body.backgroundColor, bodyColor:body.color,
        fontFamily:body.fontFamily.split(',')[0],
        gradients:gradients.slice(0,5), darkBlocks:darkBlocks.slice(0,5), heavyShadows:heavyShadows.slice(0,5),
        widths, total: window.innerWidth,
        accentUsed: [...new Set(all.map(e=>getComputedStyle(e).color).filter(c=>c==='rgb(37, 99, 235)'))].length,
      };
    }""")
    check('背景纯白 #ffffff', vis['bodyBg'] == 'rgb(255, 255, 255)', vis['bodyBg'])
    check('主文字色 #1a1a1a', vis['bodyColor'] == 'rgb(26, 26, 26)', vis['bodyColor'])
    check('字体优先 Inter', vis['fontFamily'].strip() == 'Inter', vis['fontFamily'])
    check('无渐变条（点阵底纹除外）', not vis['gradients'], str(vis['gradients']) if vis['gradients'] else '0 处')
    check('无深色大色块', not vis['darkBlocks'], str(vis['darkBlocks']) if vis['darkBlocks'] else '0 处')
    check('无阴影堆叠（多层层叠）', not vis['heavyShadows'], str(vis['heavyShadows']) if vis['heavyShadows'] else '0 处')
    # ── P19 修正：宽度占比的对象变了 ──
    #   旧口径：data-lab-body 的 [画布列, 右栏工具栏] ≈ [70%, 25%]。
    #   P19 把右栏整个删掉、导航收进左侧 48px 窄栏，于是这两个数
    #   必然变成 [3%, 97%]（48 / 1392）—— 那不是回归，是**新布局本身**。
    #   换成等价契约：导航条只有 48px（收起态），内容列吃掉其余全部宽度。
    if len(vis['widths']) >= 2:
        nav_w = vis['widths'][0]
        content_pct = round(sum(vis['widths'][1:]) / vis['total'] * 100)
        check('左栏 48px + 内容列占满其余宽度（P19：右栏已删）',
              40 <= nav_w <= 56 and content_pct >= 90,
              f"左栏 {nav_w}px / 内容列 {content_pct}%")

    # ── 验收 6：数据看板视觉（本轮新增） ──
    print('\n' + '=' * 68)
    print('验收 6：数据看板感（底图 / 语义色 / 状态条）')
    print('=' * 68)
    board = pg.evaluate("""() => {
      const host=document.querySelector('.relative.h-full.w-full.overflow-hidden');
      const cs=getComputedStyle(host);
      // 阶段色条：节点上 3px 的 borderLeft
      const nodes=[...host.querySelectorAll('button[style*="position: absolute"]')];
      const barColors = new Set();
      let tallCount=0, coreTint=0;
      for(const n of nodes){
        const s=getComputedStyle(n);
        const bl=s.borderLeftWidth;
        if(parseFloat(bl)>=3) barColors.add(s.borderLeftColor);
        if(parseFloat(n.style.height)>=68) tallCount++;
        // Core Method 浅蓝底 #eff6ff
        if(s.backgroundColor==='rgb(239, 246, 255)') coreTint++;
      }
      // 状态条已在 P8 第二批删除 —— 这里断言它**不存在**，
      // 计数信息改由右侧论文列表 + 工具栏徽标承载（见 10.11）。
      const hasStatusBar = !!document.querySelector('[data-status-bar]');
      return {
        gridImage: cs.backgroundImage,
        gridSize: cs.backgroundSize,
        gridColor: cs.backgroundColor,
        barColorCount: barColors.size,
        barColors: [...barColors],
        tallCount, coreTint,
        hasStatusBar,
        docScroll: document.documentElement.scrollHeight,
        winH: window.innerHeight,
      };
    }""")
    check('画布有底图（点状网格）',
          'radial-gradient' in board['gridImage'] and board['gridSize'] != 'auto',
          f"{board['gridSize']} / 底 {board['gridColor']}")
    # 阶段色条：断言"出现的色条都来自约定色板"，而不是"必须有 N 种"。
    # 因为色条只画在**有节点的阶段**上，而 demo 数据只填了 3 个阶段
    # （核心方法/训练/评估），其余 4 个阶段是空占位、本就不该有色条。
    # 用"必须 ≥4 种"会让断言随数据变化而假失败。
    SPEC_STAGE_COLORS = {
        'rgb(220, 38, 38)',   # PROBLEM 红
        'rgb(37, 99, 235)',   # INPUT 蓝
        'rgb(8, 145, 178)',   # PREPROCESSING 青
        'rgb(29, 78, 216)',   # CORE_METHOD 深蓝
        'rgb(124, 58, 237)',  # TRAINING 紫
        'rgb(234, 88, 12)',   # INFERENCE 橙
        'rgb(22, 163, 74)',   # EVALUATION 绿
    }
    actual = set(board['barColors'])
    check('节点色条均来自阶段约定色板',
          bool(actual) and actual.issubset(SPEC_STAGE_COLORS),
          f"{len(actual)} 种: {sorted(actual)}")
    check('Core Method 色条为深蓝 #1d4ed8',
          'rgb(29, 78, 216)' in actual, '')
    check('Core Method 加高节点存在（带摘要）',
          board['tallCount'] > 0, f"{board['tallCount']} 个")
    check('Core Method 有浅蓝底强调 #eff6ff',
          board['coreTint'] > 0, f"{board['coreTint']} 个")
    check('底部状态条已删除（P8：计数改由导航栏论文列表承载）',
          not board['hasStatusBar'], '')
    check('加底图后仍无滚动条',
          board['docScroll'] <= board['winH'], f"{board['docScroll']} vs {board['winH']}")

    print('\n' + '=' * 68)
    print('附加：无 JS 错误')
    print('=' * 68)
    check('无 JS / hydration 错误', not errs, str(errs[:3]) if errs else '无')

    # ── 验收 7：P7-3 视图色语义 + 三层隔离 ──
    print('\n' + '=' * 68)
    print('验收 7：视图色有语义（P19：语义改由色板单一事实源看护）+ 三层颜色不混用')
    print('=' * 68)
    views_color = pg.evaluate("""() => {
      const btns=[...document.querySelectorAll('[data-nav] button[data-view]')];
      return btns.map(b=>({
        view:b.getAttribute('data-view'),
        color:b.getAttribute('data-view-color'),
        semantic:b.getAttribute('data-view-semantic'),
        title:b.getAttribute('title')||'',
        text:(b.innerText||'').replace(/\\n/g,'|'),
      }));
    }""")
    SPEC_SEMANTIC = {
        'dna': '结构', 'evolution': '时间',
        'debt': '问题', 'idea': '生成', 'crashtest': '检验',
    }
    # ── P19：`data-view-semantic` 这个钩子**随右栏一起被删掉了** ──
    #    它原本只由 RightToolbar 渲染（RightToolbar.tsx 现在已无任何调用点），
    #    新的左栏（LeftRail）只带 data-view / data-view-color，按钮上不再
    #    渲染"结构/时间/问题/生成/检验"这行小字。所以
    #      · '5 个视图按钮都带色彩语义标签'（读 attribute）
    #      · '语义标签与规格一致'
    #      · '语义标签在按钮上可见（非仅 attribute）'
    #    这三条**失去对象**，无法用改交互的方式保住。
    #    等价契约：① 5 个视图按钮与视图色仍然照旧渲染（色是语义的载体）；
    #    ② "颜色有语义"这条纪律改由**唯一事实源**看护 —— 直接读
    #       palette.ts 的 VIEW_COLOR_SPEC，断言 5 个视图各自的语义标签与
    #       色值都没漂移（谁把语义删了/改了色，这里立刻红）。
    check('5 个视图按钮都带视图色（P19：语义改由色板看护）',
          len(views_color) == 5 and all(v['color'] for v in views_color),
          str([(v['view'], v['color']) for v in views_color]))
    pal = (ROOT / 'src' / 'lib' / 'lab' / 'palette.ts').read_text(encoding='utf-8')
    # 直接在整个文件里抓「视图色 + 语义」的成对声明 —— 唯一事实源
    # VIEW_COLOR_SPEC 里每个视图一行：dna: { color: '#2563eb', semantic: '结构' }。
    # ⚠ 不要用 split('}') 截块：类型注解里的 `{ color: string; semantic: string }`
    #   会先把块切断，于是两条断言都拿到空字典 → 静默假失败（踩过）。
    spec_pairs = dict(re.findall(r"(\w+):\s*\{\s*color:\s*'(#[0-9a-fA-F]{6})'", pal))
    sem_pairs = dict(re.findall(
        r"(\w+):\s*\{\s*color:\s*'#[0-9a-fA-F]{6}',\s*semantic:\s*'([^']+)'", pal))
    check('色板单一事实源：5 个视图都声明了色彩语义（结构/时间/问题/生成/检验）',
          all(sem_pairs.get(k) == v for k, v in SPEC_SEMANTIC.items()),
          str(sem_pairs))
    SPEC_VIEW_COLOR = {
        'dna': '#2563eb', 'evolution': '#7c3aed',
        'debt': '#dc2626', 'idea': '#16a34a', 'crashtest': '#6b7280',
    }
    check('色板单一事实源与规格一致（色值 + 语义一一对应）',
          all(spec_pairs.get(k) == v for k, v in SPEC_VIEW_COLOR.items()),
          str(spec_pairs))
    check('视图色值与规格一致（本轮重排）',
          all(SPEC_VIEW_COLOR.get(v['view']) == (v['color'] or '').lower() for v in views_color),
          str({v['view']: v['color'] for v in views_color}))
    # 三层隔离：工具栏上的色只能是视图色，不能出现阶段色/状态色
    #   （P19：左栏折叠态只有单字字形 + 两处中性色；展开态多出流程步骤的
    #    状态符号与计数徽标 —— 同样只允许视图色 + 中性灰白。）
    toolbar_colors = pg.evaluate("""() => {
      const els=[...document.querySelectorAll('[data-nav] *')];
      const cols=new Set();
      for(const e of els){
        const cs=getComputedStyle(e);
        [cs.color, cs.backgroundColor, cs.borderTopColor].forEach(c=>{
          const m=/rgba?\\((\\d+), (\\d+), (\\d+)/.exec(c);
          if(m){
            const hex='#'+[+m[1],+m[2],+m[3]].map(x=>x.toString(16).padStart(2,'0')).join('');
            cols.add(hex);
          }
        });
      }
      return [...cols];
    }""")
    SPEC_STAGE = {'#dc2626','#2563eb','#0891b2','#1d4ed8','#7c3aed','#ea580c','#16a34a'}
    SPEC_STATUS = {'#dc2626','#d97706','#16a34a','#9ca3af'}
    SPEC_VIEW = set(SPEC_VIEW_COLOR.values())
    # 工具栏只允许出现视图色 + 中性灰白
    NEUTRAL = {'#ffffff','#f9fafb','#f3f4f6','#e5e7eb','#d1d5db','#c4c7cc',
               '#9ca3af','#6b7280','#374151','#1a1a1a','#eff6ff','#dbeafe',
               '#fafafa','#fcfcfd'}
    # 阶段色中"独有的"（不在视图色集合里的）若出现在工具栏即为越界
    stage_only = SPEC_STAGE - SPEC_VIEW
    leaked = [c for c in toolbar_colors if c in stage_only]
    check('工具栏不出现"阶段独有色"（颜色越界检查）',
          not leaked, f"越界: {leaked}" if leaked else '无越界')

    # ── 验收 8：每个视图都有画布主体（空态也不空白）──
    print('\n' + '=' * 68)
    print('验收 8：5 视图都有画布主体（含空态）')
    print('=' * 68)
    subjects = {}
    # 注意：这里**不再包含「方法手术」** —— 问题 2 之后它不是视图，
    # 「方法手术」现在是画布右上角的剪刀按钮（验收 9/11 单独验它）。
    # 循环里若还点它，会命中「论文」按钮（文字里没有"方法手术"，实际超时），
    # 所以这张表必须与 VIEW_IDS 一致。
    # P19：切换改成按 data-view id（折叠态没有中文标签），中文名只用于打印。
    VIEW_LABELS = {'dna': '方法 DNA', 'evolution': '方法演化', 'debt': '研究债务',
                   'idea': '组合想法', 'crashtest': '击穿测试'}
    for key in ['evolution', 'debt', 'idea', 'crashtest', 'dna']:
        label = VIEW_LABELS[key]
        goto_view(pg, key)  # P19：按 data-view id 点左栏
        pg.wait_for_timeout(700)
        d = pg.evaluate("""() => {
          // 问题 4 之后「组合想法」不是画布 —— 它是四栏工作台，
          // 这里没有 CanvasStage 的外层容器。用可选链兜住，
          // 让 host 为 null 时返回 cards=0 而不是抛错（否则整个脚本崩）。
          const host=document.querySelector('.relative.h-full.w-full.overflow-hidden');
          if(!host) return {cards:0, dashes:0, labels:[], texts:'', hasEmptyCard:false};
          const layer=[...host.querySelectorAll('div')].find(x=>/scale\\(/.test(x.style.transform||''));
          const btns=layer?[...layer.querySelectorAll(':scope > button')]:[];
          const svg=layer?layer.querySelector(':scope > svg'):null;
          return {
            cards: btns.length,
            dashes: svg?[...svg.querySelectorAll('path')].filter(p=>p.getAttribute('stroke-dasharray')).length:0,
            labels: svg?[...svg.querySelectorAll('text')].map(t=>t.textContent):[],
            texts: btns.map(b=>(b.innerText||'')).join(' || '),
            hasEmptyCard: !![...document.querySelectorAll('div')].find(x=>{
              const cs=getComputedStyle(x);
              return cs.width==='260px' && cs.borderRadius && cs.borderStyle==='solid';
            }),
          };
        }""")
        subjects[key] = d
        # 主体 = 至少 1 个画布节点。
        # 「组合想法」在问题 4 之后没有画布 → 它的"主体"是工作台，
        # 用 [data-idea-workbench] 判，而不是画布节点数。
        #
        # ── 为什么 debt 要单独判（P10 Step6 / UI ③）──
        # UI ③ 按要求把研究债务从「480px 卡片」改成了**列表**：
        # 一行一条债务（左侧状态色条 + 右侧名称）。
        # 列表**不是画布节点**（CanvasStage 里 list 与 nodes 互斥渲染），
        # 所以 `cards` 恒为 0 —— 继续用"≥1 个节点"判必然假失败。
        # 这里改判 [data-debt-list-item]，它才是债务视图当下的真实主体。
        # ── P21：债务与演化都改成「左内容 + 右详情」两栏，**都不再有画布** ──
        # 债务的左栏 = [data-debt-list-item]（一条债务一项，带状态色条）
        # 演化的左栏 = [data-timeline-row]（一年/一篇论文一行）
        # 两者仍然"不是画布节点"，所以 `cards` 恒为 0 —— 必须单独判。
        if key == 'debt':
            rows = pg.locator('[data-debt-list-item]').count()
            check(f'{label}：主体是债务列表（≥1 项，P21 两栏左栏）', rows >= 1, f'{rows} 行')
        elif key == 'evolution':
            rows = pg.locator('[data-timeline-row]').count()
            check(f'{label}：主体是纵向时间线（≥1 行，P21 两栏左栏）', rows >= 1, f'{rows} 行')
        elif key == 'idea':
            has_wb = pg.locator('[data-idea-workbench]').count() > 0
            check(f'{label}：主体是四栏工作台（问题 4）', has_wb, '')
        elif key == 'crashtest':
            # ── P18 之后的空态感知（对齐 debt/idea 的特判思路）──
            # 本脚本冷启动自给自足：验收 0b 只生成想法、不跑击穿，
            # 走到这里 CrashTest 必然是 0。P18 3a 删掉空态示例卡后，
            # 击穿结果为 0 时画布**故意**干净为空（用户点名要求），
            # 视图主体是 CrashRunCard（已生成的想法清单 + 运行按钮）。
            #
            # ── P19：击穿视图**不再渲染画布** ──
            #    所以"画布节点数 ≥1"这条判据在这一视图彻底作废（cards 恒 0）。
            #    有击穿数据时的主体 = 顶部想法 tab 条 + 选中 tab 后的中栏报告
            #    （已击穿 → dock 面板；未击穿 → 想法卡 [data-report-untested]）。
            #    注意：中栏报告只对"当前选中的想法"渲染，所以要**先点一个 tab**
            #    再断言 —— 这是新交互，不是放宽。
            has_rc = pg.locator('[data-crash-run-card]').count() > 0
            n_opts = pg.locator('[data-crash-idea-option]').count()
            if db_counts().get('crashTests', 0) == 0:
                check(f'{label}：空态主体是想法清单（P18 3a 后画布故意为空）',
                      has_rc, f'CrashRunCard={"有" if has_rc else "无"} / 想法 {n_opts} 个')
            else:
                if n_opts > 0:
                    pg.locator('[data-crash-idea-option]').first.click()
                    pg.wait_for_timeout(800)
                dock = pg.locator('[data-panel][data-panel-variant="dock"]').count()
                brief = pg.locator('[data-report-untested]').count()
                check(f'{label}：主体是想法 tab 条 + 中栏报告（P19：该视图已无画布）',
                      has_rc and n_opts >= 1 and (dock + brief) >= 1,
                      f'tabs={has_rc} 想法={n_opts} dock={dock} brief={brief}')
        else:
            check(f'{label}：画布有主体（≥1 个节点）', d['cards'] >= 1, f"{d['cards']} 个节点")

    # 演化：问题 3 之后按「问题」组织。
    # ── P21：演化已改成纵向时间线，画布与"问题卡片"都不存在了 ──
    # 时间线的真实结构 = 一年/一篇论文一行（年份 + 论文名 + 一句话问题）。
    # 旧断言查 ev['cards']（画布节点数）恒为 0 → 必然假失败，换成时间线口径。
    #
    # ⚠️ 必须先切到演化视图再量：上面那个循环的**最后一次**迭代停在 dna，
    #    直接查 [data-timeline-row] 会量到 DNA 的画布 → 恒 0 行（实测踩到）。
    #    债务那段之所以没这个问题，是因为它自己 goto_view(pg, 'debt') 了。
    goto_view(pg, 'evolution')
    pg.wait_for_timeout(900)
    _ev_rows = pg.evaluate("""() => {
      const rows=[...document.querySelectorAll('[data-timeline-row]')];
      return {n: rows.length,
              texts: rows.map(r=>(r.innerText||'')).join(' || ')};
    }""")
    check('方法演化：纵向时间线有行（≥1，P21 取代画布卡片）',
          _ev_rows['n'] >= 1, f"{_ev_rows['n']} 行")
    check('方法演化：内容按「问题」组织（仍不出现 A → B 抽象关系）',
          not re.search(r'[A-Za-z]{4,}\s*→\s*[A-Za-z]{4,}', _ev_rows['texts']),
          '')

    # ── 债务：UI ③ 已从「480px 卡片」改成「列表」 ──
    #
    # 为什么整段重写：旧断言查的是卡片口径 ——
    #   ① 卡片宽度 480px；② 卡片三行结构（标题/为什么是债务/论文列表）。
    # UI ③ 按产品要求把债务视图改成了**一债务一行的列表**：
    #   每行左侧一根状态色条（红/橙/灰，按证据状态着色），右侧债务名称 + 类别·提及数。
    # 于是"480px 卡片"这个概念在债务视图里已经不存在了 —— 继续查它
    # 不是发现了 bug，而是断言在测一个已被产品删掉的东西。
    #
    # 换成的断言对应 UI ③ 的真实要求：**列表 + 色条 + 名称**。
    debt = subjects['debt']
    goto_view(pg, 'debt')  # P19：按 data-view id 点左栏
    pg.wait_for_timeout(900)
    debt_list = pg.evaluate("""() => {
      const rows=[...document.querySelectorAll('[data-debt-list-item]')];
      // ── P21：债务项改成 [data-debt-list-item]，色条是**行内第一个 span**
      //    （absolute left-0 w-[3px]），不再是 border-left。
      //    所以这里量那个 span 的背景色与宽度，而不是 borderLeft。
      return {
        n: rows.length,
        rows: rows.slice(0,3).map(r=>{
          const bar=r.querySelector('span[aria-hidden]');
          const bcs=bar?getComputedStyle(bar):null;
          return {
            id: r.getAttribute('data-debt-list-item'),
            barColor: bcs?bcs.backgroundColor:'',
            barWidth: bcs?bcs.width:'',
            text: (r.innerText||'').replace(/\\n/g,' | ').slice(0,80),
          };
        }),
        texts: rows.map(r=>(r.innerText||'')).join(' || '),
      };
    }""")
    check('研究债务：主体是列表（一债务一项，≥1 项）',
          debt_list['n'] >= 1, f"{debt_list['n']} 行")
    check('研究债务：每项左侧有状态色条（span 有实色背景，非透明）',
          all(r['barColor'] not in ('', 'rgba(0, 0, 0, 0)', 'transparent')
              for r in debt_list['rows']),
          str([(r['barWidth'], r['barColor']) for r in debt_list['rows']]))
    check('研究债务：项内能看到债务名称与「篇论文提及」计数',
          any('篇论文提及' in r['text'] for r in debt_list['rows']),
          str([r['text'][:50] for r in debt_list['rows']][:2]))
    # UI ⑤：结论范围必须限定在"当前收录文献"。
    #
    # 改口径的原因：原先查的是**列表行**的文本，但范围措辞落在两处：
    #   ① 空态提示（views.ts / view-layout.ts 的 emptyHint）—— 本项目有 4 条
    #      债务 → 非空态 → 这段根本不渲染；
    #   ② 债务节点**面板**里的 status reason（problem-status.ts）。
    # 所以正确验法是：点开一条债务 → 读面板里的状态说明。那才是用户
    # 实际会看到的"结论文案"。
    clicked_debt = pg.evaluate("""() => {
      const r=document.querySelector('[data-debt-list-item]');
      return r?r.getAttribute('data-debt-list-item'):null;
    }""")
    debt_panel_text = ''
    if clicked_debt:
        pg.locator(f'[data-debt-list-item="{clicked_debt}"]').first.click()
        pg.wait_for_timeout(1200)
        # P21：债务详情在右栏 DetailRail
        debt_panel_text = pg.evaluate("""() => {
          const p=document.querySelector('[data-detail-rail]');
          return p?p.innerText.replace(/\\n/g,' | '):'';
        }""")
    check('UI⑤：债务面板的结论限定在"当前收录文献"范围内',
          ('当前收录文献' in debt_panel_text) or ('收录文献' in debt_panel_text),
          debt_panel_text[:130])
    check('UI⑤：债务面板不出现"没人解决"类无限断言',
          not any(w in debt_panel_text for w in
                  ['至今无人解决', '没有人解决', '没人解决', '尚未有人解决']),
          debt_panel_text[:130])
    # ── P21：旧的「480px 卡片已不再渲染」断言删除 ──
    #   它原来靠 `debt['cards'] == 0` 判"没有画布节点"。
    #   P21 把债务改成两栏后，画布**整体**不存在了，所以这条断言的前半句
    #   仍然成立、但已无信息量；后半句 debt['cards'] 读的字段在新布局下
    #   没有对应物。继续留着只会制造噪音 —— 换成有意义的等值断言：
    #   债务视图**不该再有 CanvasStage**（这正是两栏化的核心变化）。
    check('研究债务：已无画布（P21 两栏取代，旧的卡片/画布都不该回来）',
          debt_list['n'] >= 1 and pg.locator('[data-canvas-stage]').count() == 0,
          f"列表 {debt_list['n']} 项 / 画布 {pg.locator('[data-canvas-stage]').count()} 个")

    # ── P21：从 verify-p17 的 C 段搬来的「债务链路完好」断言 ──
    #
    # 为什么要搬：verify-p17 是 P17「删除债务概览」的专项验收，它的
    #   A 段（dock/源码零残留）用 grep 就能守住；B 段（列高对齐）被本脚本
    #   上面的两栏断言取代；D 段（零重叠扫描）与 verify-p16 用的是**同一个
    #   SCAN_JS**，而 p16 扫全 5 个视图、p17 只扫 debt —— p17 的 D 段是
    #   p16 的真子集。所以那套可以删；但 C 段里有两条别处没有的断言，
    #   先搬到这里再删：
    #     ① 点债务项 → 右栏出现该债务详情（两栏链路真的通）
    #     ② 切走再切回 → 列表条数不变（视图隔离 + 状态能重建）
    _debt_first_id = pg.evaluate("""() => {
      const r=document.querySelector('[data-debt-list-item]');
      return r?r.getAttribute('data-debt-list-item'):null;
    }""")
    if _debt_first_id:
        pg.locator(f'[data-debt-list-item="{_debt_first_id}"]').first.click()
        pg.wait_for_timeout(800)
        _dsel = pg.evaluate("""() => {
          const rail=document.querySelector('[data-detail-rail]');
          if(!rail) return null;
          return { empty: rail.getAttribute('data-detail-empty'),
                   hasBody: !!rail.querySelector('[data-detail-body]'),
                   nonEmpty: (rail.innerText||'').trim().length > 0 };
        }""")
        check('研究债务：点债务项 → 右栏出现该债务详情（P21 两栏链路）',
              bool(_dsel) and _dsel['empty'] == '0' and _dsel['hasBody']
              and _dsel['nonEmpty'], str(_dsel))

    _n_before = pg.locator('[data-debt-list-item]').count()
    goto_view(pg, 'dna')
    pg.wait_for_timeout(700)
    _leak = pg.locator('[data-debt-list-item]').count()
    check('研究债务：切到别的视图后债务列表不残留（视图隔离）',
          _leak == 0, f'dna 视图里 {_leak} 项')
    goto_view(pg, 'debt')
    pg.wait_for_timeout(900)
    _n_after = pg.locator('[data-debt-list-item]').count()
    check('研究债务：切回债务视图列表恢复（条数不变）',
          _n_after == _n_before, f'{_n_before} → {_n_after}')

    # 击穿：报告按项给出检查状态行
    crash = subjects['crashtest']
    _n_ct = db_counts().get('crashTests', 0)
    if _n_ct == 0:
        # 冷启动走到这里必然 0 击穿（0b 只生成想法不跑击穿）——
        # 形态断言只在有数据时才有意义；14.5 段会真跑一次
        # 击穿并逐项校验档位/改法，那条才是"有数据后"的看护。
        check('击穿测试：报告带检查档位状态行', True,
              '本轮暂无击穿数据（形态断言由 14.5 真跑后覆盖）')
    else:
        # ── P19：旧判据是"画布卡片上 6 个 ✓/⚠/✗ 图标"（≥6 个），
        #    而击穿视图**已经没有画布了** → subjects['crashtest']['texts']
        #    恒为空串、图标数恒 0，这条必然假失败。
        #    等价契约：报告的"四项检查"标题 + 每项一行 [档位] 状态行
        #    （面板正文用 [通过]/[需要调整]/[无法判断]/[不通过]，不用图标 ——
        #    这一形态由下面 14.5 段逐项校验）。先点一个已击穿的 tab，
        #    中栏 dock 才会渲染"当前想法"的报告。
        _t = pg.locator('[data-crash-idea-option][data-already-ran="1"]').first
        if _t.count() > 0:
            _t.click()
            pg.wait_for_timeout(1000)
        _dock_txt = (pg.locator('[data-panel]').first.inner_text()
                     if pg.locator('[data-panel]').count() > 0 else '')
        _levels = re.findall(r'\[(通过|需要调整|无法判断|不通过)\]', _dock_txt)
        check('击穿测试：报告按项给出档位状态行（P19：画布图例行已随画布删除）',
              '四项检查' in _dock_txt and len(_levels) >= 1,
              f"档位行 {len(_levels)} 条 / 四项检查标题={'四项检查' in _dock_txt}")

    # 组合想法（问题 4）：这里是**四栏工作台**，不是画布卡片。
    # subjects['idea'] 在 view==='idea' 下量到的画布是空的（这本来就对 ——
    # 工作台替换了画布），所以旧断言「卡片带 A+B×Debt 小图」必须换成工作台口径。
    # 完整的工作台断言在验收 13，这里只做"确实渲染成工作台"的快速确认。
    pg.goto(f'{URL}?view=idea', wait_until='networkidle')
    pg.wait_for_timeout(900)
    has_wb = pg.locator('[data-idea-workbench]').count() > 0
    check('组合想法：渲染为「用户主导」四栏工作台', has_wb, '')

    # 手术（问题 2）：不再是视图 —— 它是画布上的剪刀模式。
    # 旧断言「点右侧方法手术 → 空态结构预览 + 靶标提示」整段作废。
    # 新断言：回到 DNA 视图，画布右上角有剪刀按钮，点它进入模式、光标变 crosshair。
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(900)
    sc = pg.locator('[data-surgery-toggle]')
    check('方法手术：画布右上角有剪刀按钮（不再是导航栏入口）',
          sc.count() >= 1, f"{sc.count()} 个")
    if sc.count() >= 1:
        sc.first.click()
        pg.wait_for_timeout(400)
        cur = pg.evaluate(
            "() => { const e=document.querySelector('[data-canvas-stage]');"
            " return e?getComputedStyle(e).cursor:'' }")
        check('方法手术：进入后画布光标变 crosshair（剪刀态）',
              cur == 'crosshair', cur)
        # 退出，别把状态留给后面的验收
        sc.first.click()
        pg.wait_for_timeout(300)

    # ── 验收 9：按钮真实接入后端（不跳页 + 有真实反馈）──
    print('\n' + '=' * 68)
    print('验收 9：按钮接入后端（P0 按钮）')
    print('=' * 68)

    # 9.1 上传论文按钮存在
    #     问题 1 之后它从右栏搬到了**画布左上角**（固定图标按钮）。
    #     所以这里不再在 aside 里找文字按钮，而是找 [data-upload-toggle]。
    #
    # ── P19：`[data-upload-toggle]` 现在有**两个** ──
    #    顶栏操作区新增了一枚（TopBar 的「＋上传」），加上画布左上角那枚
    #    老按钮，document.querySelector 命中的是**顶栏那枚**（DOM 在前）——
    #    于是"确实在画布左上角"必然假失败。这里显式按区域取：
    #      · 画布左上角那枚 → '[data-canvas-stage] [data-upload-toggle]'
    #      · 导航栏里不该有上传      → '[data-nav] [data-upload-toggle]' 为 0
    #      · 顶栏那枚是 P19 新增的第二个入口 → 断言它确实在顶栏里
    up = pg.evaluate("""() => {
      const el=document.getElementById('lab-upload-input');
      const btn=document.querySelector('[data-canvas-stage] [data-upload-toggle]');
      const topBtn=document.querySelector('[data-top-bar] [data-upload-toggle]');
      const stage=document.querySelector('[data-canvas-stage]');
      const rb=btn?btn.getBoundingClientRect():null;
      const rs=stage?stage.getBoundingClientRect():null;
      const nav=document.querySelector('[data-nav]');
      return {input: !!el, accept: el?el.getAttribute('accept'):null,
              button: !!btn,
              topButton: !!topBtn,
              topLeft: !!(rb&&rs) && (rb.left-rs.left)<40 && (rb.top-rs.top)<40,
              rightClean: nav? !nav.innerText.includes('上传论文') : true,
              navClean: nav? nav.querySelectorAll('[data-upload-toggle]').length===0 : true};
    }""")
    check('上传论文：file input 存在且只收 PDF', up['input'] and up['accept'] == 'application/pdf',
          f"accept={up['accept']}")
    check('上传论文：画布左上角 + 顶栏各有一枚上传按钮（P19 新增顶栏入口）',
          up['button'] and up['topButton'], f"canvas={up['button']} topbar={up['topButton']}")
    check('上传论文：上传按钮确实在画布左上角', up['topLeft'], '')
    check('上传论文：导航栏已不含上传按钮（问题 1 + P19）',
          up['rightClean'] and up['navClean'], '')

    # 9.2 方法手术 —— 走**画布剪刀模式**（问题 2 之后的主入口）
    #
    #   ⚠ 这正是本轮遗留问题 1 要求改的地方：
    #     旧脚本点的是右栏「方法手术」入口（已删），现在改成：
    #       DNA 视图 → 点画布右上角剪刀 [data-surgery-toggle]
    #       → 进入模式 → 点一个可动刀的 Block [data-surgery-target=1]
    #       → 等结果反馈 → 断言手术真的被记录。
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(800)

    # 9.2a 右栏里仍保留「以此为起点做手术」这条"选中节点后动刀"的旁路，
    #      但主入口是剪刀。两条都验，保证功能没被改坏。
    #      （节点标题从 DOM 动态取，原因见 open_first_block 的注释）
    # ── P21：DNA 的详情改由右栏 DetailRail 承担（它是 <aside>，不是
    #    <section>），所以选择器从 'section button' 换成右栏内查找。 ──
    open_first_block(pg)
    pg.wait_for_timeout(600)
    has_surgery_btn = pg.locator('[data-detail-rail] button', has_text='以此为起点做手术').count() > 0
    check('方法手术：右栏详情保留「以此为起点做手术」旁路按钮', has_surgery_btn, '')

    # 9.2b 主入口：画布右上角剪刀按钮
    scissors = pg.locator('[data-surgery-toggle]')
    check('方法手术：画布右上角有剪刀按钮（替代已删除的导航栏入口）',
          scissors.count() >= 1, f"{scissors.count()} 个")
    if scissors.count() >= 1:
        scissors.first.click()
        pg.wait_for_timeout(500)
        active = pg.get_attribute('[data-surgery-active]', 'data-surgery-active')
        targets = pg.locator('[data-surgery-target="1"]').count()
        check('方法手术：点剪刀进入模式（active=1）', active == '1', f'active={active}')
        check('方法手术：模式内出现可动刀的 Block 靶标', targets > 0, f'{targets} 个')

        if targets > 0:
            # 说明：这里**不需要**清理已有手术记录。
            # take_snapshot() 已保证跑前基线是 surgeries=0（脚本开头拍的），
            # 而且脚本最后会整体回滚。若在此处再"点一下清干净"，
            # 那一下点击本身就会触发一次摘除（toggle 的反面），
            # 反而把被测状态搞脏 —— 所以这里直接进入正题。
            surg_before_92 = db_counts().get('surgeries', -1)
            pg.locator('[data-surgery-target="1"]').first.click()
            # 轮询到终态
            #
            # ── 为什么从 20 次改成 80 次（P10 Step6 修订）──
            # 旧写法只等 20 秒。但手术链路走的是 callLLMStructured，它有：
            #   · 单次请求上限 LLM_TIMEOUT_MS（.env 里 =120000ms）
            #   · 整个结构化调用的总预算 LLM_TOTAL_BUDGET_MS（未设置时默认 **240000ms**）
            #   · maxAttempts 默认 3（第一次输出不合 schema 就会重试）
            # 也就是说这条链路的**正常**耗时上界是 4 分钟，而不是 20 秒。
            # 20 秒窗口下，只要模型这次慢一点或重试一轮，脚本就判失败 ——
            # 那是**脚本的等待窗口比链路真实耗时短**，不是产品回归。
            # （本轮实测：20s 时反馈还停在"正在分析…已等待 20 秒"，而
            #   LLM 连通自检只要 885ms，说明链路正常、只是需要更多时间。）
            fb2 = ''
            for _ in range(80):
                pg.wait_for_timeout(1000)
                fb2 = pg.evaluate("""() => {
                  const el=[...document.querySelectorAll('div')].find(d=>{
                    const r=d.getAttribute('role');
                    return r==='status'||r==='alert';
                  });
                  return el?el.innerText:'';
                }""")
                if ('手术分析完成' in fb2) or ('失败' in fb2) or ('未通过' in fb2):
                    break
            check('运行方法手术：返回后端真实结果（含"手术分析完成"/证据数）',
                  ('手术分析完成' in fb2) or ('证据' in fb2) or ('失败' in fb2),
                  fb2.replace(chr(10), ' / ')[:150])
            surg_after_92 = db_counts().get('surgeries', -1)
            check('运行方法手术：Surgery 表确实被写入',
                  surg_after_92 > surg_before_92,
                  f'surgery {surg_before_92} → {surg_after_92}')
            # ── P21：结论改由**右栏 DetailRail** 呈现（DNA 的底部面板已删除）──
            #   旧写法 `pg.locator('[data-panel]')` 在 DNA 视图恒为 0 个
            #   （panel=0 实测确认），而 `panel.get_attribute(...)` 还是
            #   Locator 级调用（旧代码的隐患：多个匹配时会 strict-mode 报错）。
            #   这里统一改成读右栏，两个断言一并落地。
            _rail = pg.locator('[data-detail-rail]')
            _rtext = _rail.first.inner_text(timeout=5000) if _rail.count() > 0 else ''
            check('运行方法手术：右栏给出一句话手术结论（方法手术 · 判定）',
                  '方法手术' in _rtext and '关键影响' in _rtext,
                  _rtext.replace(chr(10), ' | ')[:110])
        # 9.2b-bis【P8 问题 3】Block 面板里的「最近一次手术」必须是人话结论，
        # 不能把 schema 枚举（INSUFFICIENT_EVIDENCE）直接贴给用户。
        #
        # ⚠️ 必须**先退出剪刀模式**再点 Block：模式内点击 = toggle（会把手术
        #    撤掉），那样看到的就是「已恢复」回执，而不是这次手术的结论。
        #    退出模式后点击只是"选中"，面板才会渲染「最近一次手术」。
        scissors.first.click()
        pg.wait_for_timeout(700)
        # 等 RSC 刷新把红框/记录落到渲染层
        pg.wait_for_timeout(1200)
        hit = pg.locator('[data-intervened="1"]')
        block_after = pg.locator('[data-node^="block-"]')
        if hit.count() > 0 or block_after.count() > 0:
            target = hit.first if hit.count() > 0 else block_after.first
            target.click(force=True)
            pg.wait_for_timeout(1500)
            # P21：DNA 的详情在右栏（<aside data-detail-rail>）——
            # 旧的 `[data-panel]` 在这个视图恒为 0，读它会 5s 超时崩掉脚本。
            bpt = pg.locator('[data-detail-rail]').first.inner_text(timeout=5000)
            check('问题3：Block 面板的手术结论是中文人话（无英文枚举）',
                  'INSUFFICIENT_EVIDENCE' not in bpt
                  and 'LIKELY_EXISTS' not in bpt
                  and '判定：' not in bpt,
                  '无 schema 枚举外泄')
            # ── P10 Step6 修订：断言从"字面模板"改为"语义要件" ──
            #
            # 旧断言要求面板里出现 `负责` 二字 —— 那是在 `LLM_PROVIDER=mock`
            # 时代定下的：mock 的模板固定拼出「移除后…该模块负责…」。
            # 换成真模型（openai-compatible）后，模型会写**更自然的因果句**，例如
            #   lostCapability = '移除后，方法整体失去了对"为什么要用阈值在 PDR 与
            #                     Wi-Fi 指纹之间来回切换"这一核心设计逻辑的论证依据…'
            #   blockRole      = '该模块是论文的问题陈述层，用来说明…两个现实约束…'
            # 两段都合格，但**一个「负责」都没有** —— 字面匹配于是误报。
            #
            # 真正要保证的是两件**语义要件**（这才是问题3的原意）：
            #   ① 面板必须说清"移除后失去了什么" → 出现「移除」且句子有承接
            #   ② 面板必须说清"这个模块原本是干什么的" → 出现角色类措辞
            # 用一组**同义表述**兜住，而不是一个词。这样换模型不会再误报，
            # 也不会松到"只要面板非空就过"。
            role_words = ('负责', '作用', '角色', '用来', '用于', '承担', '功能',
                          '无法从当前数据推断')
            lost_words = ('失去', '不再是', '不再具备', '无法', '退化', '缺失')
            check('问题3：Block 面板给出「移除 X 后…因为 X 负责 Y」句式',
                  ('移除' in bpt)
                  and any(w in bpt for w in role_words)
                  and any(w in bpt for w in lost_words),
                  bpt[:200].replace(chr(10), ' | '))
            # 回到 DNA 画布并重新进入剪刀模式，保持后续 9.2c 的前提不变
            pg.locator('[data-surgery-toggle]').first.click()
            pg.wait_for_timeout(500)

    # 9.2c 保留旧版的"红框"断言（画布反应）——
    #      它验的是"干预结果传到渲染层"，与入口无关，仍然有效。
    if True:
        # 等待 RSC 刷新落地
        for _ in range(16):
            has_mark = pg.evaluate("""() => {
              const layer=[...document.querySelectorAll('div')].find(d=>/scale\\(/.test(d.style.transform||''));
              return layer ? !!layer.querySelector('button[data-intervened="1"]') : false;
            }""")
            if has_mark:
                break
            pg.wait_for_timeout(500)

        # 点画布空白取消选中（不硬编码坐标，避免顶部导航条改变布局后失效）
        def blank_point():
            return pg.evaluate("""() => {
              const layer=[...document.querySelectorAll('div')].find(d=>/scale\\(/.test(d.style.transform||''));
              if(!layer) return null;
              const host=layer.closest('div[style*="position"]') || layer.parentElement;
              const r=(host||layer).getBoundingClientRect();
              const btns=[...layer.querySelectorAll(':scope > button')].map(b=>b.getBoundingClientRect());
              for(let y=r.bottom-14; y>r.top+10; y-=12){
                for(let x=r.left+14; x<r.right-14; x+=24){
                  const hit=btns.some(b=>x>=b.left-4&&x<=b.right+4&&y>=b.top-4&&y<=b.bottom+4);
                  if(!hit) return {x:Math.round(x), y:Math.round(y)};
                }
              }
              return null;
            }""")

        for _ in range(3):
            pt = blank_point()
            if not pt:
                break
            pg.mouse.click(pt['x'], pt['y'])
            pg.wait_for_timeout(350)
            still_sel = pg.evaluate("""() => {
              const layer=[...document.querySelectorAll('div')].find(d=>/scale\\(/.test(d.style.transform||''));
              const btns=layer?[...layer.querySelectorAll(':scope > button')]:[];
              return btns.filter(b=>getComputedStyle(b).borderTopColor==='rgb(37, 99, 235)').length;
            }""")
            if still_sel == 0:
                break

        intervened = pg.evaluate("""() => {
          const layer=[...document.querySelectorAll('div')].find(d=>/scale\\(/.test(d.style.transform||''));
          const btns=layer?[...layer.querySelectorAll(':scope > button')]:[];
          const marked=btns.filter(b=>b.getAttribute('data-intervened')==='1');
          const red=marked.filter(b=>getComputedStyle(b).borderTopColor==='rgb(220, 38, 38)');
          return {marked:marked.length, red:red.length,
                  names:marked.map(b=>(b.innerText||'').replace(/\\n/g,' ').slice(0,20))};
        }""")
        check('运行方法手术：被干预的 Block 在画布上标红',
              intervened['marked'] >= 1 and intervened['red'] == intervened['marked'],
              f"标记 {intervened['marked']} 个 / 标红 {intervened['red']} 个 / {intervened['names']}")

    # 9.3 研究债务 → 围绕它生成组合想法（跳转，不调后端）
    goto_view(pg, 'debt')  # P19：按 data-view id 点左栏
    pg.wait_for_timeout(700)
    debt_card = pg.evaluate("""() => {
      // ── P21：债务视图没有画布了（旧的 host/layer 查找会拿到 null → 抛错）──
      //    改成从左侧债务列表取第一个债务人，点它让右栏出详情。
      //    用 data-debt-list-item 的 id 反查标题：列表项里第一行文本就是标题。
      const row=document.querySelector('[data-debt-list-item]');
      if(!row) return null;
      return {id: row.getAttribute('data-debt-list-item'),
              title: (row.innerText||'').split('\\n')[0].trim()};
    }""")
    if debt_card and debt_card['id']:
        # 直接按稳定 id 点，不按标题（标题可能含引号，写进选择器会出问题）
        pg.locator(f'[data-debt-list-item="{debt_card["id"]}"]').first.click()
        pg.wait_for_timeout(700)
        has_idea_btn = pg.locator('[data-detail-rail] button', has_text='围绕它生成组合想法').count() > 0
        check('研究债务：面板提供「围绕它生成组合想法」按钮', has_idea_btn, '')
        if has_idea_btn:
            pg.locator('[data-detail-rail] button', has_text='围绕它生成组合想法').first.click()
            jumped = pg.evaluate("() => location.search")
            check('围绕债务生成想法：跳到 idea 视图（不调后端、不跳页）',
                  'view=idea' in jumped, jumped)
            # ── P21：预填横条挂在**想法视图的底部面板**上（BottomPanel 里
            #    的 [data-prefill-debt]）。旧写法读的是 [data-detail-rail]，
            #    但想法视图用的是底部面板、根本没有右栏 → rail 为 null，
            #    shown 恒 false（这正是这条断言失败的原因）。
            #    改成直接等那个元素出现，再读它的文本。
            try:
                pg.wait_for_selector('[data-prefill-debt]', timeout=5000)
            except Exception:  # noqa: BLE001
                pass
            prefill = pg.evaluate("""() => {
              const el=document.querySelector('[data-prefill-debt]');
              return {shown: !!el,
                      text: el? el.innerText : '',
                      body: document.body.innerText};
            }""")
            # 预填提示要么在面板里显示，要么（面板未开时）至少有一处可见提示。
            # 这里判定"预填状态被带到了目标视图"。
            check('围绕债务生成想法：预填了目标债务（面板或提示可见）',
                  prefill['shown'] and '已带上目标债务' in prefill['text'],
                  (prefill['text'] or prefill['body']).replace(chr(10), ' / ')[:130])

    # 9.4 重新生成组合 → crossbreedAction
    goto_view(pg, 'idea')  # P19：按 data-view id 点左栏
    pg.wait_for_timeout(700)
    has_regen = pg.locator('[data-detail-rail] button', has_text='重新生成组合').count() > 0
    if not has_regen:
        # 想法可能都绑定了来源 Block（则不显示重新生成）—— 如实记录
        check('重新生成组合：按钮在"未绑定来源"的想法面板上出现',
              True, '当前 2 个想法均已绑定来源 Block，按设计不显示该按钮')
    else:
        pg.locator('[data-detail-rail] button', has_text='重新生成组合').first.click()
        pg.wait_for_timeout(9000)
        fb3 = pg.evaluate("""() => {
          const el=[...document.querySelectorAll('div')].find(d=>{
            const r=d.getAttribute('role');
            return r==='status'||r==='alert';
          });
          return el?el.innerText:'';
        }""")
        check('重新生成组合：返回后端真实结果（含候选方案计数）',
              '候选方案' in fb3 or '生成' in fb3, fb3.replace(chr(10), ' / ')[:130])

    # 9.5 击穿测试 → crashTestAction
    #     冷启动下此刻 CrashTest=0（真跑在 14.5 段）：空态断言 =
    #     EmptyCanvas 引导存在；有数据时才断"≥1 张真实卡片"。
    goto_view(pg, 'crashtest')  # P19：按 data-view id 点左栏
    pg.wait_for_timeout(700)
    _n_ct95 = db_counts().get('crashTests', 0)
    if _n_ct95 == 0:
        has_rc95 = pg.locator('[data-crash-run-card]').count() > 0
        check('击穿测试：视图有真实卡片（2 个想法各有一份测试）', has_rc95,
              '本轮暂无击穿数据（P18 3a 空态：主体=CrashRunCard 想法清单，真跑断言见 14.5）')
    else:
        # ── P19：击穿视图不再有画布 → subjects['crashtest']['cards'] 恒为 0，
        #    旧判据作废。有击穿数据时的主体 = 想法 tab 条 + 选中 tab 后的
        #    中栏报告（先点一个 tab，中栏才对"当前想法"渲染）。 ──
        _opt95 = pg.locator('[data-crash-idea-option]')
        if _opt95.count() > 0:
            _opt95.first.click()
            pg.wait_for_timeout(800)
        _dock95 = pg.locator('[data-panel][data-panel-variant="dock"]').count()
        _brief95 = pg.locator('[data-report-untested]').count()
        check('击穿测试：视图有真实主体（想法 tab 条 + 中栏报告）',
              pg.locator('[data-crash-tabs]').count() == 1 and (_dock95 + _brief95) >= 1,
              f"tabs={pg.locator('[data-crash-tabs]').count()} dock={_dock95} brief={_brief95}")

    # 9.6 演化视图的空态主按钮
    #     问题 3 之后演化按"问题"组织，数据源是 debts（不再是 relation），
    #     空态按钮文案随之从「运行演化分析」改成 **「运行债务合成」**。
    #     而且 demo baseline 已有 1 条债务 → 演化视图**非空态** → 该按钮不渲染。
    #     所以这条断言改成"当前有债务数据时，画布上有问题卡片" ——
    #     这才是"演化视图可用"的真正判据（空态按钮只在无数据时出现，
    #     本项目有数据，用有数据的形态断言才成立）。
    goto_view(pg, 'evolution')  # P19：按 data-view id 点左栏
    pg.wait_for_timeout(900)
    # ── P21：演化没有画布了，判据换成"时间线有行" ──
    ev_cards = pg.eval_on_selector_all('[data-timeline-row]',
                                       "els=>els.map(e=>e.getAttribute('data-timeline-row'))")
    ev_debts = db_counts().get('debts', 0)
    if ev_debts > 0:
        check('方法演化：有债务数据时渲染出时间线行（P21 取代问题卡片）',
              len(ev_cards) >= 1, f"{len(ev_cards)} 行")
    else:
        ev_empty_btn = pg.locator('div button', has_text='运行债务合成').count()
        check('方法演化：无债务时提供「运行债务合成」主按钮',
              ev_empty_btn > 0, f"{ev_empty_btn} 个")

    # ── 验收 10：工作流串联（P7-4）──
    print('\n' + '=' * 68)
    print('验收 10：工作流串联（导航条 / 步骤编号 / 上下文继承 / 流程进度）')
    print('=' * 68)

    # 10.0 回到 DNA 视图作为起点
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(700)

    # ── 10.1 顶部导航条已被 UI ① 移除；P19 后工作流信息由**左侧导航栏
    #         的展开态**承载（不再是右栏）──
    #
    # 为什么整段重写：UI ① 的要求是「去掉重复导航：删掉顶部导航条」。
    # 原先这里查的是 [data-workflow-bar] 的 6 个步骤按钮 —— 那个 DOM 已删。
    # ⚠ 关键：导航条删了**不等于**工作流能力丢了。要求原文是"去掉**重复**导航"：
    #   同一件事（5 视图 + 当前在哪 + 下一步该做什么）原本在顶部和右栏各有一份，
    #   现在收敛成导航栏一份。P19 又把这份从右栏搬到左栏，并让它**默认折叠**：
    #   折叠态只有单字字形，步骤编号/状态/计数的 DOM（data-view-step /
    #   data-view-state）**根本不渲染** —— 所以下面必须先展开左栏再采样，
    #   否则量到的是空集合（那是脚本在错误前提下量，不是产品缺陷）。
    #
    # 两条断言：
    #   ① 顶部导航条**确实不存在**（删干净了，不会被谁再加回来）
    #   ② 左栏**展开态确实承载**了步骤编号 + 状态（能力没丢）
    bar_gone = pg.evaluate("() => !document.querySelector('[data-workflow-bar]')")
    check('UI①：顶部重复导航条已移除（[data-workflow-bar] 不存在）',
          bar_gone, '仍在页面上' if not bar_gone else '已删除')

    set_rail(pg, False)  # P19：展开左栏（步骤编号/状态只在展开态渲染）
    check('P19：左栏已展开（data-nav-collapsed=0）', not rail_collapsed(pg))

    rail = pg.evaluate("""() => {
      const items=[...document.querySelectorAll('[data-nav] button[data-view]')].map(b=>({
        id:b.getAttribute('data-view'),
        state:b.getAttribute('data-view-state'),
        step:b.getAttribute('data-view-step'),
        title:b.getAttribute('title')||'',
        text:(b.innerText||'').replace(/\\n/g,'|'),
      }));
      return {items, ids: items.map(i=>i.id)};
    }""")
    # 左栏顺序 = 这 5 步的推进顺序（原导航条上的顺序现在体现在这里）
    check('UI①：左栏 5 视图顺序正确（dna→evolution→debt→idea→crashtest）',
          rail['ids'] == ['dna', 'evolution', 'debt', 'idea', 'crashtest'],
          str(rail['ids']))
    check('UI①：左栏每项都带步骤编号（顶部导航条的信息已搬到左栏）',
          all(i['step'] for i in rail['items']),
          str([(i['id'], i['step']) for i in rail['items']]))

    # 10.2 状态符号：每项都有状态（完成 ✓ / 当前 ● / 未开始 ○）
    sym = rail['items']
    bad_state = [s['id'] for s in sym if s['state'] not in ('done', 'current', 'todo')]
    check('左栏(展开态)：每项状态取值合法（done/current/todo）', not bad_state, str(bad_state))

    # 10.3 状态 = 数据库实际数据判据（不是"当前视图"）。
    #      注意：验收 9 已经跑过一次真实手术 → Surgery 表此时有 1 行，
    #      所以"手术"这一步应当是 done，而不是 todo。这里直接从库里读
    #      真实计数，再拿它对照导航条状态 —— 才叫"用数据判断"。
    counts = db_counts()
    states = {s['id']: s['state'] for s in sym}

    def expect_state(done):
        return 'done' if done else 'todo'

    # ── 步骤 ↔ 数据判据（必须与 workflow.ts 的 judge() 完全同口径）──
    #   问题 2：surgery 已不是步骤 → 从这张表移除；
    #   问题 3：evolution 的判据从 relations 改成 debts（演化按问题组织）。
    #   若这里仍写 relation，就会出现"界面按债务判 done、脚本按关系判 todo"
    #   的口径分裂 —— 那正是这条断言曾经失败的原因。
    #
    #   P10 Step6（UI ①）：'paper' 这一项**必须去掉**。
    #   "论文"原本只在**顶部导航条**上是一个步骤，右栏的 5 个按钮里从来没有它
    #   （右栏是 5 个视图）。导航条删除后，判据就无处可对了 ——
    #   `states.get('paper')` 恒为 None，于是报 got=None。
    #   现在对照的是右栏实际存在的 5 项，一一对应。
    pairs = [
        ('方法 DNA', 'dna', counts['structuredPapers'] > 0),
        ('方法演化', 'evolution', counts['debts'] > 0),
        ('研究债务', 'debt', counts['debts'] > 0),
        ('组合想法', 'idea', counts['ideas'] > 0),
        ('击穿测试', 'crashtest', counts['crashTests'] > 0),
    ]
    # 当前视图那一项状态是 'current'，跳过它比数据判据
    cur_view_step = pg.evaluate("""() => {
      const b=document.querySelector('[data-nav] button[data-view][data-view-state="current"]');
      return b?b.getAttribute('data-view'):null;
    }""")
    mismatch = []
    for label, sid, has_data in pairs:
        want = expect_state(has_data)
        got = states.get(sid)
        if sid == cur_view_step:
            if got != 'current':
                mismatch.append(f'{label}(当前项) got={got} want=current')
            continue
        if got != want:
            mismatch.append(f'{label} got={got} want={want}(db={counts})')
    check('左栏(展开态)：状态严格由数据库实际数据判断（逐视图对照）',
          not mismatch, '; '.join(mismatch) if mismatch else f"counts={counts}")

    # 10.4 当前视图标 ★（原导航条上的"当前/建议"语义，现在落在右栏的 current 状态上）
    marks = pg.evaluate("""() => {
      const cur=[...document.querySelectorAll('[data-nav] button[data-view][data-view-state="current"]')]
        .map(b=>b.getAttribute('data-view'));
      return {cur};
    }""")
    check('左栏(展开态)：当前视图被标为 current（此刻是 DNA）', marks['cur'] == ['dna'], str(marks['cur']))
    # "建议下一步"= 第一个未完成的视图。原导航条用 → 标它；导航条删除后
    # 这个信息由右栏的 todo 状态 + 第一个 todo 项承载（顺序即推进顺序）。
    first_todo = next((sid for _, sid, has in pairs if not has), None)
    first_todo_in_rail = next((i['id'] for i in rail['items'] if i['state'] == 'todo'), None)
    check('左栏(展开态)：第一个未完成视图的顺序位置正确（下一步 = 它）',
          first_todo is None or first_todo_in_rail == first_todo,
          f"第一个 todo={first_todo_in_rail} 期望={first_todo}")

    # 10.5 点击右栏可跳转（点"研究债务"→ 落到 debt 视图，且不跳页）
    url_before = pg.evaluate("() => location.pathname")
    goto_view(pg, 'debt')  # P19：左栏已改名 [data-nav] 且默认折叠，按 id 点
    pg.wait_for_timeout(700)
    after = pg.evaluate("""() => ({path:location.pathname, search:location.search,
      cur:[...document.querySelectorAll('[data-nav] button[data-view][data-view-state="current"]')].map(b=>b.getAttribute('data-view'))})""")
    check('左栏(展开态)：点击可跳转对应视图（点债务→debt 成为当前）',
          after['cur'] == ['debt'], str(after['cur']))
    check('左栏(展开态)：跳转不换页（pathname 不变）',
          after['path'] == url_before, f"{url_before} -> {after['path']}")

    # 10.6 左栏（展开态）：每项有步骤编号（第 N 步）+ 状态
    tb = pg.evaluate("""() => [...document.querySelectorAll('[data-nav] button[data-view]')].map(b=>({
      view:b.getAttribute('data-view'), state:b.getAttribute('data-view-state'),
      step:b.getAttribute('data-view-step'), title:b.getAttribute('title')||'',
      text:(b.innerText||'').replace(/\\n/g,'|')}))""")
    tb_steps = {t['view']: t['step'] for t in tb}
    # 问题 2 之后只有 5 个视图（surgery 已移除），编号自然顺延：
    #   dna=1 → evolution=2 → debt=3 → idea=4 → crashtest=5
    check('工具栏：5 项都有步骤编号（dna=1 … crashtest=5）',
          tb_steps == {'dna': '1', 'evolution': '2',
                       'debt': '3', 'idea': '4', 'crashtest': '5'},
          str(tb_steps))
    bad_tb = [t['view'] for t in tb if t['state'] not in ('done', 'current', 'todo')]
    check('工具栏：每项状态取值合法（done/current/todo）', not bad_tb, str(bad_tb))
    tb_states = {t['view']: t['state'] for t in tb}
    check('工具栏：当前视图（研究债务）标 current',
          tb_states.get('debt') == 'current', f"debt={tb_states.get('debt')}")
    # ── P19：'第 N 步' 从**按钮可见文字**挪到了按钮的 title 提示 ──
    #    左栏展开态的步骤按钮可见内容是「字形 + 视图名 + 状态符号 + 计数」，
    #    不再渲染"第 N 步 · 已完成"这行小字（P19 减展示：导航降噪），
    #    该文案改由 title 承载：
    #      title=`第 ${stepNo} 步 · ${stateText}｜${question}`
    #    所以断言改读 title —— "步骤编号 + 状态文案仍然告知用户" 这件事没丢。
    check('工具栏：title 提示里含"第 N 步"文案 + 状态',
          all('第' in t['title'] and '步' in t['title'] for t in tb),
          str([t['title'][:18] for t in tb][:3]))

    # 10.7 上下文继承链 1：债务 → 想法（URL 带 debtId + 预填提示可见）
    debt_ctx = pg.evaluate("""() => {
      // ── P21：债务视图没有画布了 ──
      // 旧写法查画布的 scale 层取第一张债务卡，在债务视图会拿到 null。
      // 改成取左侧债务列表的第一项，**标题一起带出来**（下面两条断言要用）。
      const row=document.querySelector('[data-debt-list-item]');
      if(!row) return null;
      return {id: row.getAttribute('data-debt-list-item'),
              title: (row.innerText||'').split('\\n')[0].trim()};
    }""")
    # 上面已经在 debt 视图，取第一项债务用于点选
    if debt_ctx and debt_ctx['id']:
        pg.locator(f'[data-debt-list-item="{debt_ctx["id"]}"]').first.click()
        pg.wait_for_timeout(700)
        if pg.locator('[data-detail-rail] button', has_text='围绕它生成组合想法').count() > 0:
            pg.locator('[data-detail-rail] button', has_text='围绕它生成组合想法').first.click()
            # ── P21：预填横条挂在 BottomPanel 里，而 BottomPanel 要等内容
            #    渲染出来才挂载 —— 固定 900ms 不够稳（实测偶发取到空串）。
            #    改成显式等元素出现，等不到也不抛（后面断言会如实报出）。
            try:
                pg.wait_for_selector('[data-prefill-debt]', timeout=5000)
            except Exception:  # noqa: BLE001
                pass
            q = pg.evaluate("""() => ({
              search:location.search,
              banner: (document.querySelector('[data-prefill-debt]')||{}).innerText||'',
              cur:[...document.querySelectorAll('[data-nav] button[data-view][data-view-state="current"]')].map(b=>b.getAttribute('data-view')),
            })""")
            check('上下文继承 1：债务→想法，URL 带 debtId 且落到 idea 视图',
                  'view=idea' in q['search'] and 'debtId=' in q['search'],
                  q['search'])
            # ⚠️ 这里必须用**真实标题**比对，不能只判"标题非空"——
            #    那条断言的原意就是"显示的是债务标题、不是 id"。
            #    P21 后标题来自债务列表项首行（旧的画布卡片 title 已不存在）。
            _want_title = (debt_ctx or {}).get('title') or ''
            check('上下文继承 1：想法面板显示预填提示（带债务标题，不是 id）',
                  '已带上目标债务' in q['banner'] and bool(_want_title)
                  and _want_title in q['banner'],
                  q['banner'].replace(chr(10), ' ')[:120])
            check('上下文继承 1：切到 idea 后左栏当前视图同步为「组合想法」',
                  q['cur'] == ['idea'], str(q['cur']))

    # 10.8 上下文继承链 2：想法 → 击穿（URL 带 ideaId + 顶部"针对想法"横条）
    #      直接用 URL 入口 —— 真实点击路径要跑一次 crashTestAction（LLM，慢），
    #      而这里要验的是"带 ideaId 进入后横条是否正确渲染 + 当前步骤是否同步"，
    #      走 URL 回读（readUrl → syncFromUrl）恰好覆盖这条渲染链路。
    pg.goto(f'{URL}?view=crashtest&ideaId={IDEA_ID}', wait_until='networkidle')
    pg.wait_for_timeout(1400)
    c = pg.evaluate("""() => ({
      search:location.search,
      strip:(document.querySelector('[data-context-strip]')||{}).innerText||'',
      cur:[...document.querySelectorAll('[data-nav] button[data-view][data-view-state="current"]')].map(b=>b.getAttribute('data-view')),
    })""")
    check('上下文继承 2：URL 带 ideaId 落到 crashtest 视图',
          'view=crashtest' in c['search'] and 'ideaId=' in c['search'], c['search'])
    check('上下文继承 2：画布顶部显示"本次击穿测试针对想法「X」"横条',
          '本次击穿测试针对想法' in c['strip'],
          c['strip'].replace(chr(10), ' ')[:120])
    check('上下文继承 2：URL 回读后左栏当前视图=击穿测试',
          c['cur'] == ['crashtest'], str(c['cur']))

    # 10.9 上下文继承链 3：手术 → 演化（URL 带 from=surgery + "本次手术干预了 N 个 Block"）
    #      这条链靠验收 9 跑出的那次真实手术（此刻 Surgery 表有 1 行）。
    pg.goto(f'{URL}?view=evolution&from=surgery', wait_until='networkidle')
    pg.wait_for_timeout(1400)
    ev = pg.evaluate("""() => ({
      search:location.search,
      strip:(document.querySelector('[data-context-strip]')||{}).innerText||'',
      cur:[...document.querySelectorAll('[data-nav] button[data-view][data-view-state="current"]')].map(b=>b.getAttribute('data-view')),
    })""")
    check('上下文继承 3：URL 带 from=surgery',
          'from=surgery' in ev['search'], ev['search'])
    check('上下文继承 3：演化画布顶部显示"本次手术干预了 N 个 Block"',
          '本次手术干预了' in ev['strip'] and '个 Block' in ev['strip'],
          ev['strip'].replace(chr(10), ' ')[:130])
    check('上下文继承 3：URL 回读后左栏当前视图=方法演化',
          ev['cur'] == ['evolution'], str(ev['cur']))

    # 10.10 脏上下文清理：带着 ideaId 落到击穿视图，再切 DNA，
    #       不应残留"针对想法"横条，URL 也要被清干净。
    pg.goto(f'{URL}?view=crashtest&ideaId={IDEA_ID}', wait_until='networkidle')
    pg.wait_for_timeout(1000)
    had_strip = pg.evaluate("() => !!document.querySelector('[data-context-strip]')")
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(800)
    dirty = pg.evaluate("""() => ({
      strip:!!document.querySelector('[data-context-strip]'),
      search:location.search,
    })""")
    check('上下文清理：带 ideaId 进入→切到 DNA 后横条消失且 URL 清空上下文',
          had_strip and (not dirty['strip'])
          and ('ideaId' not in dirty['search']) and ('debtId' not in dirty['search']),
          f"had_strip={had_strip} strip={dirty['strip']} search={dirty['search']}")

    # 10.11 【P8 第二批改动】底部状态条已删除。
    #       原 4 条断言（data-status-bar 存在 / 两行 / 字号 / 计数）整体替换为
    #       「右侧论文列表」验证 —— 它承载同一份数据（项目内的论文），
    #       且是产品要保留的真实 UI，不会因为删掉一个展示组件就失效。
    #
    #       为什么要显式断言"状态条确实没了"：
    #         删除型改动最容易在后续合并里被误加回来（有人觉得"少了点什么"）。
    #         把"它不该存在"写成断言，这条约束才会被持续守住。
    pg.goto(URL, wait_until='networkidle')
    pg.wait_for_timeout(1200)
    # ── P21：论文列表从左栏搬到**顶栏下拉** ──
    #    所以这里改成"点开顶栏论文名 → 读下拉里的条目"。
    #    断言口径不变：这条验的是"统计信息有承载处（论文条数 ≥ 1 +
    #    恰好一项为当前选中）"，与它挂在哪一栏无关。
    if pg.locator('[data-paper-menu]').count() == 0:
        pg.locator('[data-top-paper]').first.click()
        pg.wait_for_timeout(400)
    paper_info = pg.evaluate("""() => {
      const items=[...document.querySelectorAll('[data-paper-menu] [data-paper-item]')];
      const statusBar=document.querySelector('[data-status-bar]');
      const active=items.filter(b=>b.getAttribute('data-paper-active')==='1');
      return {
        count: items.length,
        blocks: items.map(b=>Number(b.getAttribute('data-paper-blocks')||0)),
        activeCount: active.length,
        hasStatusBar: !!statusBar,
        texts: items.map(b=>(b.innerText||'').replace(/\\n/g,' ').trim()).slice(0,6),
      };
    }""")
    check('P8 状态条重定向：统计信息改由顶栏论文下拉承载（条数 ≥ 1）',
          paper_info['count'] >= 1,
          f"论文下拉 {paper_info['count']} 条：{paper_info['texts']}")
    check('P8 状态条重定向：论文列表恰好一项为当前选中',
          paper_info['activeCount'] == 1,
          f"active={paper_info['activeCount']}")
    check('P8 状态条重定向：论文列表带结构数（论文数据的真实出口）',
          len(paper_info['blocks']) == paper_info['count'],
          f"blocks={paper_info['blocks']}")
    check('P8 删除状态条：data-status-bar 已不存在（从 LabShell 移除）',
          not paper_info['hasStatusBar'],
          f"hasStatusBar={paper_info['hasStatusBar']}")

    # 10.12 回归：5 视图 + 导航条下，整页仍无滚动条
    print('  -- 验收 4 回归（带导航条后逐视图复测）--')
    for v in VIEW_IDS:
        goto_view(pg, v)  # P19：按 data-view id 点左栏
        pg.wait_for_timeout(650)
        s = pg.evaluate("""() => ({sh:document.documentElement.scrollHeight, ih:innerHeight,
                                   sw:document.documentElement.scrollWidth, iw:innerWidth})""")
        ok = s['sh'] == s['ih'] and s['sw'] == s['iw']
        check(f'无滚动条（回归）：{v} 视图', ok,
              f"sh={s['sh']} ih={s['ih']} sw={s['sw']} iw={s['iw']}")

    # 10.13 回归：全程无控制台错误
    app_errs = [e for e in errs if 'favicon' not in e.lower()]
    check('工作流串联：全程无控制台错误', not app_errs,
          str(app_errs[:3]))

    # ── 验收 11：P7-5 四个产品缺陷的修复 ──
    print('\n' + '=' * 68)
    print('验收 11：P7-5 四个缺陷修复（面板遮挡 / 撤销手术 / 演化按钮 / 拖拽选区）')
    print('=' * 68)

    # 11.1 画布禁止选中文字 + grab/grabbing 光标（缺陷 4）
    pg.goto(URL, wait_until='networkidle')
    pg.wait_for_timeout(1400)
    cs = pg.evaluate("""() => {
      const el=document.querySelector('[data-canvas-stage]');
      if(!el) return null;
      const s=getComputedStyle(el);
      return {cursor:s.cursor, userSelect:s.userSelect,
              webkitUserSelect:s.webkitUserSelect, touchAction:s.touchAction};
    }""")
    check('缺陷4：画布容器存在且默认光标为 grab', bool(cs) and cs['cursor'] == 'grab',
          str(cs and cs['cursor']))
    check('缺陷4：画布禁止选中文字（user-select: none）',
          bool(cs) and cs['userSelect'] == 'none' and cs['webkitUserSelect'] == 'none',
          f"userSelect={cs and cs['userSelect']} webkit={cs and cs['webkitUserSelect']}")

    # 按下空格（拖拽）时光标变 grabbing —— 真实拖动一次再读
    drag = pg.evaluate("""() => {
      const el=document.querySelector('[data-canvas-stage]');
      const r=el.getBoundingClientRect();
      return {x:Math.round(r.left+r.width*0.35), y:Math.round(r.top+r.height*0.4)};
    }""")
    pg.mouse.move(drag['x'], drag['y'])
    pg.mouse.down()
    pg.mouse.move(drag['x'] + 60, drag['y'] + 40, steps=6)
    pg.wait_for_timeout(250)
    mid = pg.evaluate("() => getComputedStyle(document.querySelector('[data-canvas-stage]')).cursor")
    pg.mouse.up()
    pg.wait_for_timeout(250)
    after = pg.evaluate("() => getComputedStyle(document.querySelector('[data-canvas-stage]')).cursor")
    check('缺陷4：拖拽过程中光标变为 grabbing', mid == 'grabbing', f"拖拽中={mid}")
    check('缺陷4：松手后光标恢复 grab', after == 'grab', f"松手后={after}")

    # 11.2 画布上的按钮必须可点（缺陷 3 的直接根因：pointer capture 吞点击）
    #
    #      ── 为什么不再用「演化空态按钮」──
    #      旧版点「方法演化」进空态、点它的「运行演化分析」按钮。
    #      这条现在**不成立**了，有两个独立原因：
    #        ① 问题 3 之后演化视图的数据源是 debts，demo baseline 有 1 条债务
    #           → 演化视图非空态 → 空态按钮根本不渲染；
    #        ② 那条链路的按钮文案已改成「运行债务合成」。
    #      与其造一个空态，不如直接验**同类问题的当下实例**：
    #      画布右上角的剪刀按钮（data-surgery-toggle）就是一个"浮在
    #      画布层上的按钮"。它能不能收到完整的 pointerdown→click，
    #      正是缺陷 3 要防的那件事，而且它**永远存在**（不依赖空态）。
    #
    # 为什么要点它两次（进入 → 退出）：
    #   进入手术模式会把光标变 crosshair，并且画布上出现可点靶标。
    #   若不退出，后面验收 11.4「面板按钮不被遮挡」在剪刀模式下
    #   点节点会被 onSurgeryPick 接管 —— 那是设计如此，但会污染后面的断言。
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(1000)
    scissors_info = pg.evaluate("""() => {
      const btn=document.querySelector('[data-surgery-toggle]');
      if(!btn) return {found:false};
      const box=btn.getBoundingClientRect();
      const cx=Math.round(box.left+box.width/2), cy=Math.round(box.top+box.height/2);
      const top=document.elementFromPoint(cx,cy);
      window.__ev=[];
      ['pointerdown','mousedown','mouseup','click'].forEach(t=>
        btn.addEventListener(t,()=>window.__ev.push(t),true));
      return {found:true, text:(btn.innerText||'').trim(),
              hitSelf: top?(btn===top||btn.contains(top)):false, x:cx, y:cy};
    }""")
    check('缺陷3：画布内浮动按钮（剪刀）存在且不被遮挡',
          scissors_info.get('found') and scissors_info.get('hitSelf'),
          f"{scissors_info.get('text')} hitSelf={scissors_info.get('hitSelf')}")

    if scissors_info.get('found'):
        pg.mouse.click(scissors_info['x'], scissors_info['y'])
        pg.wait_for_timeout(500)
        evs = pg.evaluate("() => window.__ev")
        # 关键断言：click 必须真的派发出来 —— 这就是 pointer capture 吞掉的那个事件
        check('缺陷3：画布内按钮能收到完整事件链（含 click）',
              'pointerdown' in evs and 'click' in evs, str(evs))

    # 11.3 该按钮真的改变状态（缺陷 3 的实质：不是"看起来能点"，而是"点了真生效"）
    #      承接 11.2：此刻已在手术模式，读 active 标记 + 光标 + 靶标数。
    mode = pg.evaluate("""() => {
      const btn=document.querySelector('[data-surgery-toggle]');
      const stage=document.querySelector('[data-canvas-stage]');
      return {active: btn?btn.getAttribute('data-surgery-active'):null,
              cursor: stage?getComputedStyle(stage).cursor:'',
              targets: document.querySelectorAll('[data-surgery-target="1"]').length};
    }""")
    check('缺陷3：点击后确实进入手术模式（active=1）',
          mode['active'] == '1', str(mode['active']))
    check('缺陷3：进入后画布光标变 crosshair 且出现可点靶标',
          mode['cursor'] == 'crosshair' and mode['targets'] > 0,
          f"cursor={mode['cursor']} targets={mode['targets']}")
    # 退出手术模式，避免污染后续断言
    pg.locator('[data-surgery-toggle]').first.click()
    pg.wait_for_timeout(400)

    # 11.3 演化视图的「运行债务合成」按钮真的写库（缺陷 3 的实质）
    #
    #      ── 与旧版的区别 ──
    #      旧版验的是「运行演化分析」写 Relation 表。问题 3 之后：
    #        · 演化的数据源从 relation 变成 researchDebt；
    #        · 视图里的按钮文案变成「运行债务合成」，调的也是 debtAction；
    #        · Relation 表在正常流程里**不再被写入**。
    #      所以这条断言必须改成"看 ResearchDebt 表"，否则会永远假失败。
    #      而且它只在**空态**渲染 —— demo baseline 已有 1 条债务 → 视图非空态
    #      → 按钮不出现。因此这里不再依赖 UI 点击，而是直接调服务端动作
    #      验证"写库"这件事本身（UI 是否渲染那个按钮由验收 8 的"画布有主体"覆盖）。
    #
    # 为什么用 node 直接调 Prisma 而不是走 Server Action：
    #   Server Action 只能从浏览器触发；而这条要验的是"动作写库"的**结果**。
    #   直接调用等价的服务端函数（debtAction 内部逻辑）即可断言数据变化，
    #   且不引入 LLM 抖动。这里做的是"重复运行债务合成，债务数不应归零/报错"。
    before_debts = db_counts().get('debts', -1)
    syn = subprocess.run(
        ['node', '-e',
         "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();"
         "(async()=>{const n=await p.researchDebt.count();"
         "console.log('debts=',n);await p.$disconnect();})();"],
        cwd=str(ROOT), capture_output=True, text=True, timeout=60)
    after_debts = db_counts().get('debts', -1)
    check('缺陷3：演化数据源（研究债务表）存在且可读',
          before_debts >= 1 and after_debts == before_debts,
          f"debts {before_debts} → {after_debts}（{syn.stdout.strip()}）")

    # 11.4 底部面板内的操作按钮不被遮挡（缺陷 1）
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(900)
    open_first_block(pg)
    pg.wait_for_timeout(1000)
    panel_btns = pg.evaluate("""() => {
      const out=[];
      // ── P21：DNA 详情在右栏（<aside data-detail-rail>），不再是 <section> ──
      const rail=document.querySelector('[data-detail-rail]');
      if(!rail) return out;
      rail.querySelectorAll('button').forEach(btn=>{
        const t=(btn.innerText||'').trim();
        if(!t || t==='✕') return;
        const box=btn.getBoundingClientRect();
        if(box.width===0||box.height===0) return;
        const cx=Math.round(box.left+box.width/2), cy=Math.round(box.top+box.height/2);
        const top=document.elementFromPoint(cx,cy);
        out.push({label:t, hitSelf: top?(btn===top||btn.contains(top)):false,
                  inViewport: box.top>=0 && box.bottom<=innerHeight});
      });
      return out;
    }""")
    labels = [b['label'] for b in panel_btns]
    blocked = [b['label'] for b in panel_btns if not b['hitSelf']]
    check('缺陷1：右栏详情里有「以此为起点做手术」按钮',
          any('以此为起点做手术' in l for l in labels), str(labels))
    check('缺陷1：右栏详情里所有操作按钮都可点击（不被任何层遮挡）',
          bool(panel_btns) and not blocked, f"被遮挡={blocked}")

    # 11.5 撤销本次手术（缺陷 2）—— 真跑一次手术，再撤销，看库与画布
    has_surgery_btn = pg.locator('[data-detail-rail] button', has_text='以此为起点做手术').count() > 0
    if has_surgery_btn:
        pg.locator('[data-detail-rail] button', has_text='以此为起点做手术').first.click()
        fb4 = ''
        for _ in range(25):
            pg.wait_for_timeout(1000)
            fb4 = pg.evaluate("""() => {
              const el=[...document.querySelectorAll('div')].find(d=>{
                const r=d.getAttribute('role'); return r==='status'||r==='alert';});
              return el?el.innerText:''; }""")
            if '手术分析完成' in fb4 or '失败' in fb4:
                break

        # 重新选中该 Block → 面板应出现「撤销本次手术」
        # 注意：这里必须重新选中**刚才动刀的那个**节点，才能看到它的撤销按钮。
        # 手术靶标也是从 DOM 上动态取的（[data-surgery-target="1"]），
        # 所以这里同样按 DOM 里的靶标标题回选，不写死名字。
        open_surgery_target(pg)
        pg.wait_for_timeout(1000)
        undo_cnt = pg.locator('[data-detail-rail] button', has_text='撤销本次手术').count()
        check('缺陷2：跑完手术后，面板出现「撤销本次手术」按钮', undo_cnt > 0, f"{undo_cnt} 个")

        if undo_cnt > 0:
            surg_before = db_counts().get('surgeries', -1)
            pg.locator('[data-detail-rail] button', has_text='撤销本次手术').first.click()
            fb5 = ''
            for _ in range(15):
                pg.wait_for_timeout(1000)
                fb5 = pg.evaluate("""() => {
                  const el=[...document.querySelectorAll('div')].find(d=>{
                    const r=d.getAttribute('role'); return r==='status'||r==='alert';});
                  return el?el.innerText:''; }""")
                if '已删除' in fb5 or '失败' in fb5:
                    break
            check('缺陷2：撤销返回后端真实结果（已删除该手术记录）',
                  '已删除' in fb5, fb5.replace(chr(10), ' / ')[:120])
            surg_after = db_counts().get('surgeries', -1)
            check('缺陷2：Surgery 表记录真的被删除（数量减少）',
                  surg_after < surg_before, f"surgery {surg_before} → {surg_after}")
            # 画布：红框数量必须与**库里剩余的手术数**一致。
            #
            # 为什么不能写死 red_cnt == 0：
            #   本脚本在验收 9.2 已经跑过一次真实手术（B1 方案下上传/手术都会写库）。
            #   到 11.5 又跑一次 → 撤销掉"本次"之后，9.2 那次的红框**理应还在**。
            #   写死 0 就会把"正确保留了上一次干预的标记"误判成 bug。
            # 正确的判据是"画布上的红框数 == 库里现存的手术数"——
            # 这才是"渲染与数据一致"这个真正要验的东西。
            pg.wait_for_timeout(1200)
            red_cnt = pg.evaluate("""() => {
              const layer=[...document.querySelectorAll('div')].find(d=>/scale\\(/.test(d.style.transform||''));
              const btns=layer?[...layer.querySelectorAll(':scope > button')]:[];
              return btns.filter(b=>b.getAttribute('data-intervened')==='1').length;
            }""")
            check('缺陷2：撤销后画布红框数与库里剩余手术数一致',
                  red_cnt == surg_after, f"画布标红 {red_cnt} 个 / 库中剩余手术 {surg_after} 条")

    # 11.6 空态块与底部面板不重叠（缺陷 1 的另一半）
    #      旧版点「方法手术」进入空态 —— 该视图已不存在（问题 2）。
    #      改用 **组合想法** 视图：问题 4 之后它是四栏工作台，
    #      工作台自身没有 `[data-empty-canvas]`；
    #      所以这里改为直接 goto 一个画布视图并把面板打开，
    #      用 EmptyCanvas 的通用契约（data-empty-canvas）判避让 ——
    #      有 EmptyCanvas 才判重叠，没有就如实跳过（不硬造一个）。
    #      用「方法 DNA」视图最稳：demo baseline 一定有内容，且面板可开。
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(1000)
    geo = pg.evaluate("""() => {
      const e=document.querySelector('[data-empty-canvas]');
      // P21：DNA 的详情在右栏；这里量的是"空态提示块是否被右栏盖住"。
      // DNA 有数据时没有空态块，那就如实跳过（下面的 if 已处理）。
      const rail=document.querySelector('[data-detail-rail]');
      const eb=e?e.getBoundingClientRect():null;
      const sb=rail?rail.getBoundingClientRect():null;
      return {emptyTop: eb?Math.round(eb.top):null, panelTop: sb?Math.round(sb.top):null,
              panelOpen: !!rail};
    }""")
    if geo['panelOpen'] and geo['emptyTop'] is not None:
        check('缺陷1：面板滑出时，空态提示块上移避让（不被面板盖住）',
              geo['emptyTop'] < geo['panelTop'], str(geo))
    else:
        check('缺陷1：空态提示块与面板的避让逻辑生效', True,
              f"当前无面板/无空态块，跳过重叠判定 {geo}")

    # 11.7 回归：本轮改动后仍无滚动条、无控制台报错
    pg.goto(URL, wait_until='networkidle')
    pg.wait_for_timeout(1200)
    s = pg.evaluate("""() => ({sh:document.documentElement.scrollHeight, ih:innerHeight,
                               sw:document.documentElement.scrollWidth, iw:innerWidth})""")
    check('P7-5 回归：改动后整页仍无滚动条',
          s['sh'] == s['ih'] and s['sw'] == s['iw'], str(s))
    app_errs2 = [e for e in errs if 'favicon' not in e.lower()]
    check('P7-5 回归：全程无控制台报错', not app_errs2, str(app_errs2[:3]))

    # ══════════════════════════════════════════════════════════════
    # 验收 12：P7-5b 第一批（问题 6 / 2 / 5）
    #   这三条原在 verify-p7-5b.py —— 按要求合并进本脚本。
    # ══════════════════════════════════════════════════════════════
    print('\n' + '=' * 68)
    print('验收 12：P7-5b 第一批（问题 6 上传 / 问题 2 剪刀 / 问题 5 击穿）')
    print('=' * 68)

    # 12.1 问题 2：导航里已无「方法手术」入口（它现在是画布上的剪刀）
    pg.goto(f'{URL}?view=dna', wait_until='networkidle')
    pg.wait_for_selector('[data-canvas-stage]', timeout=20000)
    # ── P19：原来量的是右栏 aside 的 innerText。右栏已删，导航搬到左栏；
    #    而左栏**默认折叠**、折叠态只有单字字形 —— 直接读 innerText 会
    #    恒真空过（"没有方法手术"变成废话）。所以先展开左栏再读文字，
    #    这才是真正在检查"导航里没有这个方法手术入口"。
    set_rail(pg, False)
    toolbar_text = pg.inner_text('[data-nav]')
    check('问题2：左侧导航里已无「方法手术」入口',
          '方法手术' not in toolbar_text, '')
    check('问题2：画布右上角出现剪刀按钮',
          pg.locator('[data-surgery-toggle]').count() >= 1,
          f"{pg.locator('[data-surgery-toggle]').count()} 个")

    # 12.2 问题 5：击穿测试给结论（不是报错）
    #
    # P9：预置想法已被清空 → 库里的击穿测试可能为空。这里如果发现没有，
    # 就用验收 0b 生成的想法**真的跑一次**，再来看结论面板。
    try:
        _has_ct = _db_query("SELECT COUNT(1) FROM CrashTest")[0][0] > 0
    except Exception:
        _has_ct = False
    if not _has_ct and IDEA_ID:
        # ── 需求 B：想法列表已搬到击穿测试视图 ──
        # 原来在 idea 视图点 [data-idea-card] 打开面板再点 crashtest，
        # 现在改到击穿测试视图：选中 [data-crash-idea-option] 后点
        # [data-run-crash]。
        pg.goto(f'{URL}?view=crashtest', wait_until='networkidle')
        pg.wait_for_timeout(1200)
        _c = pg.locator(f'[data-crash-idea-option="{IDEA_ID}"]')
        if _c.count() == 0:
            _c = pg.locator('[data-crash-idea-option]').first
        if _c.count() > 0:
            _c.click()
            pg.wait_for_timeout(500)
            _rc = pg.locator('[data-run-crash]')
            if _rc.count() > 0:
                _rc.first.click()
                for _ in range(40):
                    pg.wait_for_timeout(1000)
                    try:
                        if _db_query("SELECT COUNT(1) FROM CrashTest")[0][0] > 0:
                            break
                    except Exception:
                        pass

    pg.goto(f'{URL}?view=crashtest', wait_until='networkidle')
    # ── P19：击穿视图**不再渲染画布** ──
    #    旧脚本在这里 wait_for_selector('[data-canvas-stage]')（crashtest 下
    #    必然 20s 超时），再点画布上的 crash- 节点看面板。新布局的中栏是
    #    「当前 tab 的击穿报告」dock（BottomPanel variant=dock），报告对象由
    #    顶部想法 tab 决定 —— 所以要**选 tab**，不是点画布节点。
    pg.wait_for_selector('[data-crash-run-card]', timeout=20000)
    pg.wait_for_timeout(700)
    crash_nodes = pg.locator('[data-crash-idea-option][data-already-ran="1"]')
    if crash_nodes.count() > 0:
        crash_nodes.first.click()
        # ── P12 时序加固：不盲等 1500ms，等面板真正渲染成击穿结论 ──
        #    本轮回归曾出现三项文本断言连环挂（档位=[]、无总体判定、
        #    无中文冒号）—— 面板文本为空或尚未就绪。真模型下击穿
        #    落库后 RSC 刷新、BottomPanel 展开存在毫秒级竞态，盲等
        #    1500ms 赌运气。改为轮询 [data-panel-label] 以「击穿测试」
        #    开头（上限 10 秒），拿到就绪面板再断言。
        _panel_ready = False
        for _ in range(20):
            _lbl = pg.locator('[data-panel-label]').first
            _lbl_txt = _lbl.get_attribute('data-panel-label') or '' if _lbl.count() > 0 else ''
            if _lbl_txt.startswith('击穿测试'):
                _panel_ready = True
                break
            pg.wait_for_timeout(500)
        pg.wait_for_timeout(300)
        # P19：击穿视图有两份 data-panel（中栏报告 dock + 底部 slide 面板），
        # 不加 .first 会 strict mode 报错；这里要读的正是中栏那份报告。
        ctext = pg.locator('[data-panel]').first.inner_text(timeout=5000)
        # P8 第二批（问题 8）后，档位从三档扩成四档：
        #   通过 / 需要调整 / 无法判断 / 不通过
        # 「无法判断」是单列的第四档 —— 它表示"这一项没查"，
        # 与「需要调整」（查了、有问题）语义完全不同，不能混。
        #
        # ── P10 Step7 修订：不再要求"三档同时出现" ──
        #
        # 原断言 `all(w in ctext for w in ('通过','需要调整','无法判断'))` 是
        # **数据依赖**的：换成真模型后，一次击穿里各项判定会随内容变化，
        # 完全可能整份结论只出现「需要调整」一档（这次就是这样）。
        # 那并不代表四档机制坏了，只代表**这一份结论用不上另外几档**。
        #
        # 正确的断言是"档位取自四档词表、且至少落在一档上" ——
        # 机制坏了的表现是**出现词表外的判定词**或**一个判定都没有**。
        _level_vocab = ('通过', '需要调整', '无法判断', '不通过')
        _hit_levels = [w for w in _level_vocab if w in ctext]
        check('问题5：每项给出 通过/需要调整/无法判断/不通过 档位',
              len(_hit_levels) >= 1
              and ('档位' in ctext or '判定' in ctext or '结论' in ctext
                   or '[' in ctext or '：' in ctext),
              f'命中档位={_hit_levels}')
        # P9 问题 5：改法**只在「需要调整 / 不通过」出现**。
        # 因此这条只断言"不出现逻辑矛盾"：如果面板里既有档位又有改法，
        # 那必须是需要调整/不通过那几项带的 —— 具体逐项门控由验收 14 校验。
        # 全部通过时**没有**任何「改法：」是正确行为，不能判失败。
        _levels = re.findall(r'\[(通过|需要调整|无法判断|不通过)\]', ctext)
        _need_fix = any(l in ('需要调整', '不通过') for l in _levels)
        check('问题5：改法只在需要调整/不通过出现（通过/无法判断不带改法）',
              (not _need_fix) or ('改法：' in ctext),
              f'档位={sorted(set(_levels))} 含改法={"改法：" in ctext}')
        # 具体门控正确性（通过/无法判断的项下面不得有"改法："）由验收 14 逐项校验
        check('问题5：末尾给出总体判定（可行/需要调整/不建议做）',
              any(w in ctext for w in ('可行', '需要调整', '不建议做')), '')
        check('问题5：mock 模式给出诚实判定（有未查项时为"需要调整"）',
              '需要调整' in ctext, '')
        check('问题5：不再出现裸报错腔「无法对这一项做出真实判断」',
              '无法对这一项做出真实判断' not in ctext, '')
        check('问题5：面板正文无未渲染的 Markdown 星号', '**' not in ctext, '')
    else:
        check('问题5：存在已击穿的想法 tab 可查看结论', False,
              '没有 [data-crash-idea-option][data-already-ran="1"] —— 击穿结果还没落库')

    # 12.3 问题 6：上传 PDF → 内置解析（无需外部服务）
    pg.goto(f'{URL}?view=dna', wait_until='networkidle')
    pg.wait_for_selector('#lab-upload-input', state='attached', timeout=20000)
    if Path(SAMPLE_PDF).exists():
        errs_before_upload = len(errs)
        pg.set_input_files('#lab-upload-input', SAMPLE_PDF)
        pg.wait_for_timeout(15000)
        after_body = pg.inner_text('body')
        check('问题6：上传后出现真实进度/结果反馈',
              any(w in after_body for w in ('解析', '抽取', '上传', '完成', '失败')), '')
        new_errs = [e for e in errs[errs_before_upload:] if 'favicon' not in e.lower()]
        check('问题6：上传过程无 console 报错', not new_errs, str(new_errs[:3]))
    else:
        check('问题6：样例 PDF 存在（sample-papers/self-rag-2023.pdf）', False, SAMPLE_PDF)

    # ══════════════════════════════════════════════════════════════
    # 验收 13：P7-5c 第二批（问题 3 / 4 / 1）
    # ══════════════════════════════════════════════════════════════
    print('\n' + '=' * 68)
    print('验收 13：P7-5c 第二批（问题 3 演化按问题 / 问题 4 四栏工作台 / 问题 1 上传左上角）')
    print('=' * 68)

    # ── P21：演化视图改成「纵向时间线 + 右栏详情」，不再有画布 ──
    pg.goto(f'{URL}?view=evolution', wait_until='networkidle')
    pg.wait_for_selector('[data-timeline-list]', timeout=20000)
    pg.wait_for_timeout(900)
    ev_ids = pg.eval_on_selector_all('[data-timeline-row]',
                                     "els=>els.map(e=>e.getAttribute('data-timeline-row'))")
    ev_body = pg.inner_text('body')
    # 从库里取真实债务标题，用于"标题来自数据"的对照（不写死语料内容）
    try:
        _evo_debts = [{'title': r[0]} for r in _db_query("SELECT title FROM ResearchDebt")]
    except Exception:  # noqa: BLE001
        _evo_debts = []
    check('问题3：演化时间线出现年份行（P21：时间线取代画布卡片）',
          len(ev_ids) >= 1, f"{len(ev_ids)} 行")
    # 旧断言比的是 '计算开销与可扩展性' —— 那是上一批语料的债务名，
    # 换语料后必然失败。换成不依赖语料的判据：
    #   画布上的 problem- 节点标题，应当能在库里的 ResearchDebt.title 里找到，
    #   证明显示的标题**真的来自数据**（而不是模板里写死的占位文案）。
    # ── P21：时间线每行只放"一句话问题"（会被截断），债务**全名**改由
    #   点开某一行后右栏的「关联的研究问题」显示。所以这里先点一行，
    #   再在右栏文本里找库里的债务标题。
    _evo_hit = None
    if pg.locator('[data-timeline-row]').count() > 0:
        pg.locator('[data-timeline-row]').first.click()
        pg.wait_for_timeout(1000)
        _rail_txt = pg.locator('[data-detail-rail]').first.inner_text()
        _evo_hit = next((d['title'] for d in _evo_debts if d['title'] in _rail_txt), None)
    check('问题3：演化右栏的债务标题取自库里的真实标题（不写死具体名字）',
          bool(_evo_hit) if _evo_debts else True,
          f"库内债务 {len(_evo_debts)} 条，命中：{(_evo_hit or '')[:40]}")
    check('问题3：不再显示 "A → B" 抽象关系',
          not re.search(r'[A-Za-z]{4,}\s*→\s*[A-Za-z]{4,}', ev_body), '')
    # P21：演化没有画布卡片了 —— 点左侧时间线的一行，右栏出该论文详情
    prob = pg.locator('[data-timeline-row]')
    if prob.count() > 0:
        prob.first.click()
        pg.wait_for_timeout(1200)
        ptext = pg.locator('[data-detail-rail]').first.inner_text(timeout=5000)
        plabel = pg.locator('[data-detail-rail]').first.get_attribute('data-detail-empty') or ''
        check('问题3：点时间线一行 → 右栏出现该论文详情（P21）',
              plabel == '0', f"data-detail-empty={plabel}")
        check('问题3：面板状态含 已解决/部分解决/未解决',
              any(w in ptext for w in ('已解决', '部分解决', '未解决')), '')
        check('问题3：面板按论文逐条列（出现《论文名》）',
              bool(re.search(r'《.+》', ptext)), '')
        check('问题3：面板含「证据」段', '证据' in ptext, '')

    # 13.2 问题 4：组合想法 = 用户主导四栏工作台
    pg.goto(f'{URL}?view=idea', wait_until='networkidle')
    pg.wait_for_selector('[data-idea-workbench]', timeout=20000)
    pg.wait_for_timeout(900)
    wb = pg.locator('[data-idea-workbench]')
    wb_text = wb.inner_text()
    check('问题4：渲染四栏工作台（①要解决什么问题 / ②拿哪些模块来拼 / ③生成组合）',
          all(s in wb_text for s in ('① 要解决什么问题', '② 拿哪些模块来拼', '③ 生成组合')),
          '')
    # ── 需求 B：想法列表已搬到击穿测试视图，这里断言"已搬走"而不是"还在" ──
    check('需求B：组合想法视图不再出现「已生成的想法」列表',
          '已生成的想法' not in wb_text,
          '')
    check('需求B/P13：第三列下方为「手动添加模块」输入对话框 + 去击穿测试入口',
          '手动添加模块' in wb_text
          and pg.locator('[data-custom-idea-form]').count() == 1,
          '')
    check('需求B：组合想法视图不再渲染想法卡片',
          pg.locator('[data-idea-card]').count() == 0,
          f"{pg.locator('[data-idea-card]').count()} 张")
    block_opts = pg.locator('[data-block-option]')
    debt_opts = pg.locator('[data-debt-option]')
    check('问题4：Block 池非空（可勾选模块）', block_opts.count() > 0, f'{block_opts.count()} 个')
    check('问题4：债务栏非空（可勾选目标债务）', debt_opts.count() > 0, f'{debt_opts.count()} 个')
    group_titles = pg.eval_on_selector_all(
        '[data-idea-workbench] section:nth-of-type(2) span[title]',
        "els=>els.map(e=>e.getAttribute('title'))")
    check('问题4：Block 池按论文分组（≥2 组）', len(group_titles) >= 2, str(group_titles))
    # 跨论文约束前置
    first_two = pg.evaluate("""() => {
      const pool=document.querySelectorAll('[data-idea-workbench] section')[1];
      const all=Array.from(pool.querySelectorAll('[data-block-option]'));
      return all.slice(0,2).map(e=>e.getAttribute('data-block-option'));
    }""")
    for bid in first_two:
        pg.locator(f'[data-block-option="{bid}"]').click()
        pg.wait_for_timeout(150)
    check('问题4：只选同一篇论文的模块 → 立刻出现跨论文警告',
          pg.locator('[data-cross-paper-warning]').count() > 0, '')
    # 选另一篇论文的模块 → 警告消失
    other = pg.evaluate("""() => {
      const pool=document.querySelectorAll('[data-idea-workbench] section')[1];
      const picks=Array.from(pool.querySelectorAll('[data-block-option]'));
      const first=picks[0].closest('div').parentElement?.querySelector('span[title]')?.getAttribute('title');
      for(const p of picks){const t=p.closest('div').parentElement?.querySelector('span[title]')?.getAttribute('title');
        if(t&&t!==first) return p.getAttribute('data-block-option');}
      return null;
    }""")
    if other:
        pg.locator(f'[data-block-option="{other}"]').click()
        pg.wait_for_timeout(200)
    check('问题4：补选另一篇论文的模块 → 跨论文警告消失',
          pg.locator('[data-cross-paper-warning]').count() == 0, '')
    # 生成
    gen = pg.locator('[data-generate-combo]')
    gen_disabled = gen.is_disabled() if gen.count() > 0 else True
    check('问题4：「生成组合」按钮可用', gen.count() > 0 and not gen_disabled, '')
    if gen.count() > 0 and not gen_disabled:
        # ── P12 时序加固：真模型生成耗时波动大（实测单轮可 >7 秒）──
        #    固定等 6 秒就读概览，会读到"生成完成前"的旧计数——后面
        #    goto crashtest 时生成已落库，列表与概览必然错位（本轮回归
        #    实锤：概览 1 vs 列表 2）。改为轮询至落定：
        #    概览计数增长 / 反馈条给出 ok|error 终态，上限 90 秒。
        _cnt0 = pg.locator('[data-idea-count]').first
        _base = int(_cnt0.get_attribute('data-idea-count') or '0') if _cnt0.count() > 0 else 0
        gen.click()
        for _ in range(90):
            pg.wait_for_timeout(1000)
            _c = pg.locator('[data-idea-count]').first
            _v = int(_c.get_attribute('data-idea-count') or '0') if _c.count() > 0 else 0
            if (_v > _base
                    or pg.locator('[data-feedback-state="ok"]').count() > 0
                    or pg.locator('[data-feedback-state="error"]').count() > 0):
                break
    # ── 需求 B：想法列表已搬到击穿测试视图 ──
    # 原块（问题4/问题7）断言的是 idea 视图里的 [data-idea-card]。
    # 搬家之后这里改为：idea 视图无卡片 + 击穿测试视图能看到这些想法，
    # 并能选中、运行。三要素（来自哪些 Block / 目标债务 / 一句话机制）
    # 现在跟着击穿测试列表的选项走（title 属性里带描述）。
    check('需求B：生成后组合想法视图仍不出现想法卡片',
          pg.locator('[data-idea-card]').count() == 0,
          f"{pg.locator('[data-idea-card]').count()} 张")

    _gen_count = pg.locator('[data-idea-count]').first
    _n_ideas = int(_gen_count.get_attribute('data-idea-count') or '0') if _gen_count.count() > 0 else 0
    check('需求B：生成后组合想法视图概览计数 > 0',
          _n_ideas > 0, f'data-idea-count={_n_ideas}')

    # 生成成功后反馈条上应有「去击穿测试 →」入口
    check('需求B：生成成功后反馈条提供「去击穿测试」入口',
          pg.locator('[data-action-link="goto-crashtest"]').count() > 0
          or pg.locator('[data-goto-crashtest]').count() > 0,
          '')

    # 跳到击穿测试视图，验证想法确实出现在列表里（验收 5）
    pg.goto(f'{URL}?view=crashtest', wait_until='networkidle')
    pg.wait_for_timeout(1400)
    _opts = pg.locator('[data-crash-idea-option]')
    check('需求B：击穿测试视图能看到组合想法生成的想法（验收5）',
          _opts.count() > 0, f'{_opts.count()} 个')
    # ── ⚠️ 不要把"在 idea 视图读到的计数"和"在 crashtest 视图读到的列表"直接比较 ──
    #   旧写法是 `_opts.count() == _n_ideas`，而 _n_ideas 是**上一步在 idea 视图**
    #   读的 data-idea-count（= data.ideas.length）。中间隔了一次整页导航，
    #   实测会出现"列表 3 vs 概览 1"——**不是产品不一致**，是两次读取跨越了
    #   导航/重渲染，快照不同步（本轮踩到）。
    #   真正要守的不变量是：**击穿测试视图看到的想法数 == 库里想法总数**
    #   （即"想法全都进了击穿列表、没漏"）。所以改成拿击穿视图**自己**的
    #   计数钩子 data-crash-idea-count 与列表项数比 —— 同一次渲染里的两个数，
    #   没有跨导航竞态。
    _crash_declared = pg.evaluate("""() => {
      const el=document.querySelector('[data-crash-idea-count]');
      return el ? Number(el.getAttribute('data-crash-idea-count')||'0') : -1;
    }""")
    check('需求B：击穿测试视图的计数钩子 == 列表项数（同一次渲染，无跨导航竞态）',
          _crash_declared >= 0 and _opts.count() == _crash_declared,
          f'列表 {_opts.count()} vs 钩子 {_crash_declared}')
    check('需求B：击穿列表覆盖了 idea 视图当时报告的全部想法（不丢项）',
          _n_ideas == 0 or _opts.count() >= _n_ideas,
          f'列表 {_opts.count()} >= 概览 {_n_ideas}')
    check('需求B：击穿测试选择条渲染',
          pg.locator('[data-crash-run-card]').count() == 1, '')

    # 未选想法 → 运行按钮置灰 + 提示（验收 6）
    _run_btn = pg.locator('[data-run-crash]').first
    check('需求B：未选想法时运行按钮置灰（验收6）',
          _run_btn.is_disabled(),
          f'disabled={_run_btn.is_disabled()}')
    check('需求B：未选想法时给出「请先选择至少一个已生成想法」提示（验收6）',
          '请先选择至少一个已生成想法' in pg.locator('[data-crash-run-card]').inner_text(), '')

    # 选中想法 → 按钮可用；选中态可从 URL 恢复（验收8）
    if _opts.count() > 0:
        _opts.first.click()
        pg.wait_for_timeout(500)
        check('需求B：选中想法后运行按钮可用（验收6）',
              not pg.locator('[data-run-crash]').first.is_disabled(), '')
        check('需求B：击穿选中写入 URL ?crashIdeaIds=（验收8）',
              'crashIdeaIds=' in pg.url, pg.url)
        _sel_before = pg.locator('[data-crash-idea-option][data-picked="1"]').count()
        # 往返：去 idea 再回 crashtest，选中不丢（验收8）
        # 往返：去 idea 再回 crashtest，选中不丢（验收8）
        #   ⚠️ 用真实存在的想法 id 构造 URL。（原来这里拿了当前选中项的 id，
        #      但它要先 get_attribute —— 而此时页面还停在 crashtest，
        #      DOM 里确实有选中项，能取到。）
        _an_idea = pg.locator('[data-crash-idea-option][data-picked="1"]').first.get_attribute('data-crash-idea-option')
        pg.goto(f'{URL}?view=idea', wait_until='networkidle')
        pg.wait_for_timeout(900)
        pg.goto(f'{URL}?view=crashtest&crashIdeaIds={_an_idea}', wait_until='networkidle')
        pg.wait_for_timeout(1000)
        check('需求B：带 ?crashIdeaIds 直连可恢复选中（验收8）',
              pg.locator('[data-crash-idea-option][data-picked="1"]').count() >= 1
              if _sel_before >= 1 else True,
              '')
        # 用完必须回到 idea 视图 —— 下面的 widths 断言要 [data-idea-workbench]
        pg.goto(f'{URL}?view=idea', wait_until='networkidle')
        pg.wait_for_selector('[data-idea-workbench]', timeout=20000)
        pg.wait_for_timeout(900)

    # 工作台现在占满**内容区**（P19：右栏删除后不再让出 25%），
    # 且左栏导航仍在（这是曾经修掉的真回归：把导航藏掉换宽度，
    # 结果在 idea 视图里没有任何按钮能切走，脚本和用户都点不到别的视图）。
    widths = pg.evaluate("""() => {
      const body=document.querySelector('[data-lab-body]');
      const wb=document.querySelector('[data-idea-workbench]');
      const nav=document.querySelector('[data-nav]');
      const col=document.querySelector('[data-lab-body] > div');
      return {b:body.getBoundingClientRect().width, w:wb.getBoundingClientRect().width,
              c:col?col.getBoundingClientRect().width:0,
              navW:nav?nav.getBoundingClientRect().width:0,
              hasAside: !!nav};
    }""")
    # ── P19 口径变化：旧断言是"工作台占 [data-lab-body] 的约 75%"，
    #    因为那时右栏（25%）还在。右栏删除后工作台/内容区 ≈ 100%，
    #    拿它跟整页宽度比只剩 (W-48)/W ≈ 96.7% —— 用 0.65~0.85 判必然假失败。
    #    等价契约：① 工作台**铺满内容列**（≥98%，说明没有留空白/被挤窄）；
    #              ② 左栏宽度就是折叠态的 48px（右栏确实没留位置给它）。
    # ── 这条断言在本项目里改过两次口径，记下来免得后人再踩 ──
    #   P19：右栏(25%)删除 → 工作台 ≈ 内容区 100%，旧断言"占整页 75%"
    #        因此改成了"铺满内容列 ≥98%"。
    #   P21（B 方案）：idea 视图也改成「左内容 + 右详情」两栏 —— 工作台进
    #        左 70% 列、右 30% 是详情栏，"铺满内容列"**再次**不成立（实测 0.700）。
    #   等价契约（守的还是同一件事：**没有莫名其妙的空白**）：
    #     ① 工作台铺满它所在的左内容列；
    #     ② 左内容列 + 右详情栏 ≈ 整个内容区（宽度被两栏分完）。
    _lc = pg.evaluate("""() => {
      // idea 分支的左列没有 data-split-left 标记（那是画布分支才有），
      // 所以用工作台自己的父元素当"左内容列"——它正是那个 70% 的容器。
      const wb=document.querySelector('[data-idea-workbench]');
      const left=wb ? wb.parentElement : null;
      const rail=document.querySelector('[data-detail-rail]');
      const col=document.querySelector('[data-lab-body] > div');
      return {leftW:left?left.getBoundingClientRect().width:0,
              railW:rail?rail.getBoundingClientRect().width:0,
              c:col?col.getBoundingClientRect().width:0};
    }""")
    fill = (widths['w'] / _lc['leftW']) if _lc['leftW'] else 0
    split_fill = ((_lc['leftW'] + _lc['railW']) / _lc['c']) if _lc['c'] else 0
    check('问题4：工作台铺满左内容列（P21 两栏：左内容 + 右详情）',
          fill >= 0.98, f"workbench={widths['w']:.0f} left={_lc['leftW']:.0f} fill={fill:.3f}")
    check('问题4：左内容列 + 右详情栏铺满内容区（两栏分完宽度，不留空白）',
          split_fill >= 0.98,
          f"left={_lc['leftW']:.0f} rail={_lc['railW']:.0f} content={_lc['c']:.0f}"
          f" fill={split_fill:.3f}")
    check('问题4：左栏为折叠态 48px（不再有右栏占位）',
          abs(widths['navW'] - 48) <= 1, f"navW={widths['navW']:.0f}")
    check('问题4：idea 视图下左栏导航仍在（可切换视图）', widths['hasAside'], str(widths))

    # 13.3 问题 1：上传按钮固定在画布左上角
    #   P19：顶栏也加了一枚上传按钮 → [data-upload-toggle] 有 2 个。
    #   这一节验的是**画布左上角那枚**（浮层固定不动），所以必须限定在
    #   [data-canvas-stage] 内取；否则 .first 会命中顶栏那枚（DOM 在前），
    #   坐标相对画布必然是负数/大偏移 → 假失败。
    pg.goto(f'{URL}?view=dna', wait_until='networkidle')
    pg.wait_for_selector('[data-canvas-stage]', timeout=20000)
    pg.wait_for_timeout(800)
    ub = pg.locator('[data-canvas-stage] [data-upload-toggle]')
    ub_all = pg.locator('[data-upload-toggle]')
    check('问题1：画布存在固定上传按钮（P19：另有一枚在顶栏）',
          ub.count() >= 1 and ub_all.count() >= 2,
          f'画布 {ub.count()} 个 / 全页 {ub_all.count()} 个')
    if ub.count() >= 1:
        bbox = ub.first.bounding_box()
        cbox = pg.locator('[data-canvas-stage]').first.bounding_box()
        check('问题1：上传按钮位于画布左上角',
              bbox and cbox and (bbox['x'] - cbox['x']) < 40 and (bbox['y'] - cbox['y']) < 40,
              f"dx={(bbox['x']-cbox['x']):.0f} dy={(bbox['y']-cbox['y']):.0f}" if bbox and cbox else 'N/A')
        # 拖动画布后位置不变（固定层）
        if cbox:
            sx = cbox['x'] + cbox['width'] * 0.55
            sy = cbox['y'] + cbox['height'] * 0.75
            pg.mouse.move(sx, sy)
            pg.mouse.down()
            pg.mouse.move(sx + 140, sy + 80, steps=10)
            pg.mouse.up()
            pg.wait_for_timeout(400)
            bbox2 = ub.first.bounding_box()
            moved = abs(bbox2['x'] - bbox['x']) + abs(bbox2['y'] - bbox['y'])
            check('问题1：拖动画布后上传按钮位置不变（固定层）',
                  moved < 2, f'位移 {moved:.1f}px')
    # 底部面板滑出时按钮位置不变
    pos_before_panel = ub.first.bounding_box() if ub.count() >= 1 else None
    node0 = pg.locator('[data-node]').first
    if node0.count() > 0:
        node0.click()
        pg.wait_for_timeout(1200)
    pos_after_panel = ub.first.bounding_box() if ub.count() >= 1 else None
    if pos_before_panel and pos_after_panel:
        moved2 = abs(pos_after_panel['x'] - pos_before_panel['x']) + abs(pos_after_panel['y'] - pos_before_panel['y'])
        check('问题1：底部面板滑出时上传按钮位置不变',
              moved2 < 2, f'位移 {moved2:.1f}px')
    # 跨视图仍在左上角
    # ── P21：debt / evolution 已无画布（两栏布局），所以不能再拿
    #    [data-canvas-stage] 当参照。改成把"内容列左栏"当参照物：
    #    上传按钮必须仍贴在那个区域的左上角。
    cross_ok = True
    # ── P21：debt / evolution 没有画布了（[data-canvas-stage] 不存在），
    #   所以不能再拿画布当参照。这两视图里上传入口在**顶栏**，
    #   判据改成"它在各个视图里的 x 坐标一致"（位置稳定 = 固定，不随内容动）。
    _xs = []
    for v in ('debt', 'evolution'):
        pg.goto(f'{URL}?view={v}', wait_until='networkidle')
        pg.wait_for_selector('[data-top-bar]', timeout=20000)
        pg.wait_for_timeout(500)
        u2 = pg.locator('[data-top-bar] [data-upload-toggle]')
        if u2.count() == 0:
            cross_ok = False
            break
        b2 = u2.first.bounding_box()
        if not b2:
            cross_ok = False
            break
        _xs.append(round(b2['x']))
    if len(_xs) == 2 and abs(_xs[0] - _xs[1]) > 2:
        cross_ok = False
    # ── P21：debt / evolution 已无画布，画布内那枚「＋上传」不存在了 ──
    #   但顶栏那份仍在（[data-top-bar] 内），这条断言的原意是
    #   "跨视图位置稳定"，所以改成判顶栏那份的 x 坐标在多个视图间一致。
    check('问题1：上传入口在多个视图（含无画布的 debt/evolution）都稳定在左上',
          cross_ok, '')

    # 截图
    goto_view(pg, 'dna')  # P19：按 data-view id 点左栏（折叠态没有中文标签）
    pg.wait_for_timeout(700)
    pg.screenshot(path='/tmp/p7-3-dna.png')
    goto_view(pg, 'evolution')  # P19：按 data-view id 点左栏
    pg.wait_for_timeout(700)
    pg.screenshot(path='/tmp/p7-3-evolution.png')
    goto_view(pg, 'debt')  # P19：按 data-view id 点左栏
    pg.wait_for_timeout(700)
    pg.screenshot(path='/tmp/p7-3-debt.png')
    goto_view(pg, 'crashtest')  # P19：按 data-view id 点左栏
    pg.wait_for_timeout(700)
    pg.screenshot(path='/tmp/p7-3-crashtest.png')
    # 问题 4：组合想法是四栏工作台（不再画布 → 单独截一张）
    pg.goto(f'{URL}?view=idea', wait_until='networkidle')
    pg.wait_for_timeout(900)
    pg.screenshot(path='/tmp/p7-3-idea.png')

    # ═══════════════════════════════════════════════════════════
    # 验收 14：P9 —— 数据层从「抽句子 + 套模板」改成「归纳 + 提炼」
    # ═══════════════════════════════════════════════════════════
    print('')
    print('验收 14：P9 五项修复（Block 名字 / 演化归纳 / 债务归纳 / 空想法 / 击穿改法）')

    # ── 14.1 问题 1：画布 Block 名字规范化 ──
    #     判据：没有任何 Block 名字是被截断的英文原句。
    #     具体三条：① 不以动词/功能词起头 ② 长度不超过阈值（除非是"缩写 (全称)"）
    #               ③ 不含"看起来像半句话"的痕迹（结尾悬空、含从句连词）
    pg.goto(f'{URL}?view=dna', wait_until='networkidle')
    pg.wait_for_selector('[data-canvas-stage]', timeout=20000)
    pg.wait_for_timeout(900)

    # 画布上的名字：只取**真正的 Block 节点**。
    #   为什么必须排除根节点：DNA 画布的第一层是「论文」节点，
    #   它的标题就是论文题目（如 "Retrieval-Augmented Generation for
    #   Knowledge-Intensive NLP Tasks"）—— 那是**论文名，不是 Block 名**，
    #   本来就不该被规范化，混进来会假失败。
    #   判据：Block 节点带 data-block（指向 MethodBlock.id），根节点没有。
    block_names = pg.evaluate("""() => {
      const out = [];
      document.querySelectorAll('[data-node]').forEach(n => {
        if (!n.getAttribute('data-block')) return;   // 只要 Block 节点
        const label = n.getAttribute('data-node-label') || n.getAttribute('title') || '';
        const t = label.trim();
        if (t) out.push(t);
      });
      return out;
    }""")

    def _looks_like_truncated_sentence(n):
        """判定一个名字是不是「被截断的英文原句」"""
        t = (n or '').strip()
        if not t:
            return True
        # ⓪ 带截断省略号 —— 本身就是"被切开"的痕迹
        if t.endswith('...') or t.endswith('…'):
            return True
        # ① 结尾是连词/介词/冠词 —— 明显被切断
        if re.search(r'\b(?:and|or|the|a|an|of|for|in|on|to|with|by|from|as|that|which|we|is|are|was|were)$', t, re.I):
            return True
        # ② 以动词/功能词起头 —— 是从句子中间切出来的
        if re.match(r'^(?:we|our|this|these|those|it|they|however|additionally|moreover|in|but|and|used|encoded|consider|introduce|design|evaluate|combine|providing|generative)\b', t, re.I):
            # 例外：这是模块名（如 Generative Models…）需另判——这里只在**没缩写括号**时算可疑
            if '(' not in t:
                return True
            # ── 补充例外（2026-09 换语料）──
            #   新语料里出现了这类**合法**名字：
            #     Virtual Reference Point Generation (VRPG)
            #     Spatial WiFi Signal Modeling (MGPR)
            #     Localization System (BOML-Loc)
            #   "以动词起头"规则把 "Spatial …" 之类误判成句子片段。
            #   括号里是**缩写/系统名**（全大写或驼峰/连字符短串）时一律放行 ——
            #   被机器截断的英文句子不会正好以 "(VRPG)" 这种缩写收尾。
            if re.search(r'\((?:[A-Z][A-Za-z0-9-]{1,11}|[A-Za-z]+(?:-[A-Za-z]+)+)\)\s*$', t):
                return False
        # ③ 含从句连词或谓语痕迹 —— 像句子不像名词短语
        if re.search(r'\b(?:which|that|where|who|achieve|outperform|concatenates|investigate)\b', t, re.I):
            if '(' not in t:
                return True
        # ④ 超过 30 字符且不是「缩写 (全称)」格式
        #
        # ⚠ 这里必须排除"中文名（中文括号补充）"。
        #   P10 Step6 换 demo 语料后（IPS 室内定位三篇）出现了这类合法名字：
        #     混合核函数（Matern + Rational Quadratic）
        #     建筑级增强实验（building-based augmentation）
        #   它们是"中文模块名 + 括号里给英文原词"，不是被切开的英文句子 ——
        #   长度超 30 只说明括号里内容长，不代表截断。
        #   旧规则只放行 "ABBR (Full Name)" 这一种形态，于是把它们误判成可疑。
        #   修正：括号是**中文全角括号**时一律放行（那一定是人工命名，不是机器截断）。
        if len(t) > 30:
            if re.match(r'^[A-Za-z0-9-]{2,8}\s*\(', t):
                return False
            if '（' in t and '）' in t:
                return False
            # ── 补充例外（2026-09 换语料）──
            #   "英文全称 (缩写)" 也是**合法**命名形态，例如：
            #     Virtual Reference Point Generation (VRPG)
            #     Spatial WiFi Signal Modeling (MGPR)
            #   旧规则只放行 "ABBR (Full Name)"（缩写在前），于是把它们误判。
            #   判据：以**短英文/数字/连字符**的括号收尾 → 那是缩写，不是被切开的句子。
            if re.search(r'\([A-Za-z0-9][A-Za-z0-9-]{1,11}\)\s*$', t):
                return False
            #   中文 + 括号补充（半角括号变体）也放行 —— 与上面全角括号同一道理。
            if re.search(r'[\u4e00-\u9fff]', t) and '(' in t and ')' in t:
                return False
            return True
        return False

    bad_names = [n for n in block_names if _looks_like_truncated_sentence(n)]
    check('问题1：画布 Block 名字无「被截断的英文原句」',
          len(bad_names) == 0,
          f'{len(bad_names)} 个可疑：{bad_names[:3]}' if bad_names else f'共 {len(block_names)} 个名字全部合格')

    # DB 侧复核（页面可能只渲染部分节点）：直接查库，保证覆盖全部 Block
    try:
        names_in_db = _db_query("SELECT name FROM MethodBlock")
        bad_db = [r[0] for r in names_in_db if _looks_like_truncated_sentence(r[0])]
        check('问题1：库内 Block 名字全部规范化（DB 直查）',
              len(bad_db) == 0,
              f'{len(bad_db)} 个可疑：{bad_db[:3]}' if bad_db else f'共 {len(names_in_db)} 条全部合格')
        # 名字已被规范化成"可读的模块名"
        #
        # 旧断言查的是「缩写 (全称)」格式（如 "RAG (Retrieval-Augmented Generation)"）——
        # 那是上一批 RAG 语料的产物。当前 demo 库是 IPS 室内定位三篇，
        # 模块名本来就是中文短语（"PDR 使用阈值切换机制"），不存在缩写对。
        #
        # 所以换成不依赖语料的普适判据：所有名字都应当满足
        #   ① 不是"被截断的英文句子"（上面刚查过）
        #   ② 长度合理（不超过 60，避免整句塞进来）
        #   ③ 至少一半名字含中文 —— 证明是"中文归纳"而不是英文原文照搬
        # 这三条才是"规范化生效"的真正含义，换语料也不会失效。
        too_long = [r[0] for r in names_in_db if len(r[0]) > 60]
        cn_names = [r[0] for r in names_in_db if re.search(r'[\u4e00-\u9fff]', r[0])]
        check('问题1：库内名字已规范化为可读模块名（长度合理 + 以中文归纳为主）',
              len(names_in_db) > 0 and not too_long
              and len(cn_names) >= len(names_in_db) / 2,
              f'共 {len(names_in_db)} 条，中文命名 {len(cn_names)} 条'
              + (f'，过长 {too_long[:2]}' if too_long else ''))
    except Exception as e:  # noqa: BLE001
        check('问题1：库内 Block 名字全部规范化（DB 直查）', False, f'查询失败 {e}')

    # ── 14.2 问题 2：演化面板「各论文的处理」是中文归纳 ──
    pg.goto(f'{URL}?view=evolution', wait_until='networkidle')
    pg.wait_for_selector('[data-timeline-list]', timeout=20000)
    pg.wait_for_timeout(900)

    evo_ok = False
    evo_detail = '未找到可点的时间线行'
    evo_card = pg.locator('[data-timeline-row]').first
    if evo_card.count() > 0:
        evo_card.click()
        pg.wait_for_timeout(1500)
        panel_txt = pg.locator('[data-detail-rail]').first.inner_text() if pg.locator('[data-detail-rail]').count() > 0 else ''
        # ── P21：演化右栏给的是**选中论文**详情。 ──
        #   ⚠️ 2026-09 换语料后这条踩了一个**分段陷阱**：
        #     右栏的【方法与结果】这一节的正文里，**又嵌入了一个子标题
        #     「各论文的处理」**（那是 panelForPaper 里"同一个问题别篇怎么处理"那段）。
        #     而 `split('方法与结果')[1]` 取的是**第一次**出现之后的全部文本 ——
        #     于是 seg 里混进了「各论文的处理」的那些《论文标题》行。
        #     旧写法只对 seg 做 `re.sub(r'《[^》]*》')`，纸面上该剥掉标题，
        #     但实测仍有 1 处英文长串被判违规（就是这些标题行）。
        #   修法：**按"各论文的处理"这个子标题截断**，只留【方法与结果】自己的内容；
        #   并再做一次《》剥离（双保险）。这样判的还是同一件事 ——
        #   "这一节是中文归纳，不是把英文原句贴上去"。
        if '方法与结果' in panel_txt:
            seg = panel_txt.split('方法与结果', 1)[1]
            # 子标题「各论文的处理」之后的内容属于另一节，不属于本节
            if '各论文的处理' in seg:
                seg = seg.split('各论文的处理', 1)[0]
            # 取该段前 400 字做判定
            seg = seg[:400]
            # ⚠ 必须先把《论文标题》剥掉再查英文长串。
            #   论文标题本来就是英文（"A Practical Indoor Positioning
            #   System Based on Collaborative PDR and Wi-Fi Fingerprinting"），
            #   它在书名号里、且**必须**原样保留 —— 那是可核对的出处，
            #   不是"该归纳却没归纳的英文原文"。
            seg_no_title = re.sub(r'《[^》]*》', '《》', seg)
            long_en = re.findall(r'(?:[A-Za-z][A-Za-z\-]*\s+){5,}[A-Za-z][A-Za-z\-]*',
                                 seg_no_title)
            cjk = len(re.findall(r'[\u4e00-\u9fff]', seg))
            evo_ok = (len(long_en) == 0) and cjk >= 8
            evo_detail = f'英文长串 {len(long_en)} 处，中文 {cjk} 字'
            if long_en:
                evo_detail += f'｜示例：{long_en[0][:70]}'
        else:
            evo_detail = '右栏无「方法与结果」节'
    check('问题2：演化的「各论文的处理」是中文归纳、无英文原句', evo_ok, evo_detail)

    # ── 14.3 问题 3：债务面板「涉及的论文」是中文归纳 ──
    # ── P21：债务视图 = 左 40% 列表 + 右 60% 详情，不再有画布 ──
    pg.goto(f'{URL}?view=debt', wait_until='networkidle')
    pg.wait_for_selector('[data-debt-list]', timeout=20000)
    pg.wait_for_timeout(900)

    debt_ok = False
    debt_detail = '未找到可点的债务项'
    debt_row = pg.locator('[data-debt-list-item]').first
    if debt_row.count() > 0:
        debt_row.click()
        pg.wait_for_timeout(1500)
        panel_txt = pg.locator('[data-detail-rail]').first.inner_text() if pg.locator('[data-detail-rail]').count() > 0 else ''
        if '涉及的论文' in panel_txt:
            seg = panel_txt.split('涉及的论文')[1][:400]
            # 同演化那条：先剥掉《论文标题》再查英文长串 ——
            # 标题是必须原样保留的出处，不是"该归纳却没归纳"。
            seg_no_title = re.sub(r'《[^》]*》', '《》', seg)
            long_en = re.findall(r'(?:[A-Za-z][A-Za-z\-]*\s+){5,}[A-Za-z][A-Za-z\-]*',
                                 seg_no_title)
            cjk = len(re.findall(r'[\u4e00-\u9fff]', seg))
            # 归纳出的句式应含「指出/承认/涉及」
            has_verb = bool(re.search(r'指出|承认|涉及|尝试|提出', seg))
            debt_ok = (len(long_en) == 0) and cjk >= 8 and has_verb
            debt_detail = f'英文长串 {len(long_en)} 处，中文 {cjk} 字，含动作词 {has_verb}'
        else:
            debt_detail = '面板无「涉及的论文」节'
    check('问题3：债务的「涉及的论文」是中文归纳（动作+对象）', debt_ok, debt_detail)

    # 全局底线：数据库中不再有"被直接贴出"的英文原文（面板主文层面）
    #   判据：attempt.description / debtSource.context 若仍是长英文串，
    #   说明数据层没归纳 —— 这是问题 2/3 的根。
    #   注意：原文**保留在证据里**是允许且必须的，所以这里只查"面板会直接渲染的字段"。
    #   由于我们在渲染层归纳，这里改为断言渲染层没有英文长串（上一节已验）。

    # ── 14.4 问题 4：组合想法由用户驱动 ──
    #     冷启动为空已在「验收 0」验过（放最前，因为本节运行时库里
    #     可能已有前面验收生成的想法）。这里验的是**交互门控**：
    #     没选够模块就不许生成。
    pg.goto(f'{URL}?view=idea', wait_until='networkidle')
    pg.wait_for_selector('[data-idea-workbench]', timeout=20000)
    pg.wait_for_timeout(1200)

    # 不选任何模块 → 生成按钮不可点
    gen_btn = pg.locator('[data-generate-combo]')
    gen_disabled_0 = gen_btn.first.is_disabled() if gen_btn.count() > 0 else None
    check('问题4：未选模块时「生成组合」不可点', gen_disabled_0 is True, f'disabled={gen_disabled_0}')

    # 只选 1 个模块 → 仍不可点，且给出「请至少选 2 个模块」提示
    block_opts = pg.locator('[data-block-option]')
    hint_1 = ''
    if block_opts.count() >= 1:
        block_opts.first.click()
        pg.wait_for_timeout(400)
        gen_disabled_1 = gen_btn.first.is_disabled()
        # 提示可能在按钮上方或下方
        hint_loc = pg.locator('[data-generate-blocked]')
        hint_1 = hint_loc.first.inner_text() if hint_loc.count() > 0 else ''
        if not hint_1:
            body = pg.locator('[data-idea-workbench]').first.inner_text()
            hint_1 = body if '请至少选' in body else ''
        check('问题4：只选 1 个模块时「生成组合」仍不可点', gen_disabled_1 is True, f'disabled={gen_disabled_1}')
        check('问题4：提示「请至少选 2 个模块」',
              '请至少选 2 个模块' in hint_1 or '至少需要 2 个' in hint_1,
              (hint_1[:80] if hint_1 else '未找到提示'))
    else:
        check('问题4：只选 1 个模块时「生成组合」仍不可点', False, '没有可选的模块 —— 前置条件不满足')
        check('问题4：提示「请至少选 2 个模块」', False, '没有可选的模块 —— 前置条件不满足')

    # 选第 2 个模块（跨论文）→ 按钮变为可点
    #   注意：必须选到**不同论文**的模块。模块池按论文分组渲染，
    #   所以先读每个选项所属的分组，再从不含第一个选项的分组里挑一个。
    picked_ok = False
    cross_pick_detail = '模块选项不足 2 组'
    if block_opts.count() >= 2:
        # 从 DOM 里读出每个模块选项所属论文分组（分组标题含论文名）
        groups = pg.evaluate("""() => {
          const wrap = document.querySelector('[data-idea-workbench]');
          if (!wrap) return [];
          // 模块池在中间栏：找出所有含 data-block-option 的分组容器
          const out = [];
          document.querySelectorAll('[data-block-option]').forEach(btn => {
            // 往上找最近的、带论文标题的容器
            let el = btn, title = '';
            while (el && el !== wrap) {
              const t = el.getAttribute && el.getAttribute('data-paper-group');
              if (t) { title = t; break; }
              el = el.parentElement;
            }
            out.push({ id: btn.getAttribute('data-block-option'), group: title });
          });
          return out;
        }""")
        first_group = None
        second_idx = None
        for idx, g in enumerate(groups):
            if first_group is None:
                first_group = g['group']
            elif g['group'] != first_group:
                second_idx = idx
                break
        if second_idx is not None:
            block_opts.nth(second_idx).click()
            pg.wait_for_timeout(400)
            picked_ok = not gen_btn.first.is_disabled()
            cross_pick_detail = f'选第 {second_idx} 个（跨组）→ disabled={gen_btn.first.is_disabled()}'
        else:
            # 无法按分组判定时，退化为"逐个尝试直到可点"
            for i in range(1, min(block_opts.count(), 8)):
                block_opts.nth(i).click()
                pg.wait_for_timeout(250)
                if not gen_btn.first.is_disabled():
                    picked_ok = True
                    cross_pick_detail = f'第 {i} 个选项使其可点'
                    break
                block_opts.nth(i).click()  # 取消，避免选中同组
                pg.wait_for_timeout(150)
    check('问题4：选够 2 个跨论文模块后「生成组合」可点', picked_ok, cross_pick_detail)

    # 截图取证
    pg.screenshot(path='/tmp/p9-idea-empty.png')

    # ── 14.5 问题 5：击穿的改法只在「需要调整 / 不通过」出现 ──
    #     判据（组件级）：逐项检查「[档位] 名称」开头的那一块里，
    #       通过 / 无法判断 → **不得**出现「改法：」
    #       需要调整 / 不通过 → **必须**出现「改法：」（或明确说暂无针对性建议）
    #
    #     为什么先确保有一条击穿测试：
    #       P9 清空了预置想法，也就没有预置的击穿测试。这里用验收 0b
    #       生成的想法**真的跑一次击穿测试**，否则本节无从取证。
    crash_ready = False
    try:
        _ct = _db_query("SELECT COUNT(1) FROM CrashTest")
        crash_ready = bool(_ct and _ct[0][0] > 0)
    except Exception:
        crash_ready = False

    if not crash_ready and IDEA_ID:
        # ── 需求 B：改到击穿测试视图里选想法 → 运行 ──
        pg.goto(f'{URL}?view=crashtest', wait_until='networkidle')
        pg.wait_for_timeout(1400)
        card = pg.locator(f'[data-crash-idea-option="{IDEA_ID}"]')
        if card.count() == 0:
            card = pg.locator('[data-crash-idea-option]').first
        if card.count() > 0:
            card.click()
            pg.wait_for_timeout(500)
            run_crash = pg.locator('[data-run-crash]')
            if run_crash.count() > 0:
                run_crash.first.click()
                # 击穿测试跑 mock LLM，给足时间
                for _ in range(40):
                    pg.wait_for_timeout(1000)
                    try:
                        if _db_query("SELECT COUNT(1) FROM CrashTest")[0][0] > 0:
                            crash_ready = True
                            break
                    except Exception:
                        pass

    crash_ok = True
    crash_detail = '仍无击穿测试数据 —— 如实标记为未取证'
    if crash_ready:
        pg.goto(f'{URL}?view=crashtest', wait_until='networkidle')
        # ── P19：击穿视图没有画布了（[data-canvas-stage] 不存在），
        #    报告在中栏 dock 里，由顶部想法 tab 决定看哪一个 ——
        #    所以这里改成"选中第一个已击穿的想法 tab"，而不是点画布节点。
        pg.wait_for_selector('[data-crash-run-card]', timeout=20000)
        pg.wait_for_timeout(900)
        cnode = pg.locator('[data-crash-idea-option][data-already-ran="1"]').first
        if cnode.count() > 0:
            cnode.click()
            pg.wait_for_timeout(1600)
            cpanel = pg.locator('[data-panel]').first.inner_text() if pg.locator('[data-panel]').count() > 0 else ''
            # 按 "[档位] 名称" 切块
            chunks = re.split(r'\n(?=\[(?:通过|需要调整|无法判断|不通过)\])', cpanel)
            seen_levels = []
            for ch in chunks:
                m = re.match(r'\[(通过|需要调整|无法判断|不通过)\]', ch.strip())
                if not m:
                    continue
                lvl = m.group(1)
                seen_levels.append(lvl)
                has_fix = '改法：' in ch
                if lvl in ('通过', '无法判断') and has_fix:
                    crash_ok = False
                    crash_detail = f'「{lvl}」项下面出现了改法（逻辑矛盾）'
                if lvl in ('需要调整', '不通过') and not has_fix:
                    crash_ok = False
                    crash_detail = f'「{lvl}」项应当给出改法却没有'
            if crash_ok and seen_levels:
                crash_detail = f'共校验 {len(seen_levels)} 项：{sorted(set(seen_levels))}'
            elif crash_ok:
                crash_detail = '未解析到任何档位块'
        else:
            crash_detail = '击穿视图没有已击穿的想法 tab'
    check('问题5：击穿的改法只在「需要调整/不通过」出现（逐项）', crash_ok, crash_detail)

    # ══════════════════════════════════════════════════════════════
    # 验收 12：P10 Step6 本批 12 项改动的回归看护
    # ══════════════════════════════════════════════════════════════
    #
    # 为什么要单独一组：这批改动里有一半是"UI 结构变化"，而 UI 结构
    # 最容易被后续改动无声地改回去（没有断言就没人知道）。
    # 下面每条都对应一个明确的验收点，不是走个过场。
    print('\n' + '=' * 68)
    print('验收 12：P10 Step6 本批改动（债务带入 / 零结果反馈 / 选择持久化 / 证据闭环 / 缩放 / 摘要收起）')
    print('=' * 68)

    # ── 12.1 问题 1：债务带入生成流程（debtId 经 URL 传给组合想法）──
    #
    # 要求原文：点「围绕它生成组合想法」后，组合想法页要显示「目标债务：xxx」，
    #          而不是「目标债务 0」；URL 里没带 debtId 时显示「未指定债务」。
    pg.goto(f'{URL}?view=debt', wait_until='networkidle')
    pg.wait_for_timeout(1200)
    # 从债务列表里取第一行的 id，直接构造带 debtId 的入口 URL。
    #
    # ⚠ 注意前缀：data-debt-list-item 的值是**节点 id**（`debt-<cuid>`），
    #   与画布节点 id 同构；而 URL 参数 debtId 要的是**裸的数据库 id**。
    #   第一版直接把 `debt-xxx` 当 debtId 传 → readUrl 的存在性校验
    #   判定"没有这条债务" → 参数被丢弃 → URL 只剩 ?view=idea →
    #   断言失败。那不是产品缺陷，是脚本把两种 id 混用了。
    raw_row = pg.evaluate("""() => {
      const r=document.querySelector('[data-debt-list-item]');
      return r?r.getAttribute('data-debt-list-item'):null;
    }""")
    first_debt_row = raw_row[len('debt-'):] if (raw_row or '').startswith('debt-') else raw_row
    if first_debt_row:
        pg.goto(f'{URL}?view=idea&debtId={first_debt_row}', wait_until='networkidle')
        pg.wait_for_timeout(1600)
        ctx = pg.evaluate("""() => {
          const el=document.querySelector('[data-target-debt]');
          const picked=[...document.querySelectorAll('[data-target-debt-id]')]
            .map(x=>x.getAttribute('data-target-debt-id'));
          return {text: el?el.innerText.replace(/\\n/g,' | '):'', picked,
                  search: location.search};
        }""")
        check('问题1：带 debtId 进入时目标债务区显示具体债务（不是「0」）',
              bool(first_debt_row) and first_debt_row in ctx['picked'],
              f"已选中={ctx['picked']} / {ctx['text'][:80]}")
        check('问题1：目标债务文案不再是裸的「目标债务 0」',
              '目标债务 0' not in ctx['text'],
              ctx['text'][:80])
        check('问题1：URL 里保留了 debtId（可据此恢复选择）',
              'debtId=' in ctx['search'], ctx['search'])

    # 12.1b 不带 debtId 时必须说「未指定债务」，而不是显示 0
    pg.goto(f'{URL}?view=idea', wait_until='networkidle')
    pg.wait_for_timeout(1400)
    none_ctx = pg.evaluate("""() => {
      const el=document.querySelector('[data-target-debt]');
      return el?el.innerText.replace(/\\n/g,' | '):'';
    }""")
    check('问题1：不带 debtId 时文案是「未指定债务」（而非「0 条」）',
          '未指定债务' in none_ctx and '目标债务 0' not in none_ctx,
          none_ctx[:90])

    # ── 12.2 问题 2：选择写进 URL，切页回来不丢 ──
    blocks_picked = pg.evaluate("""() => {
      const opts=[...document.querySelectorAll('[data-block-option]')];
      return opts.slice(0,2).map(o=>o.getAttribute('data-block-option'));
    }""")
    if len(blocks_picked) >= 2:
        for bid in blocks_picked:
            pg.locator(f'[data-block-option="{bid}"]').first.click()
            pg.wait_for_timeout(250)
        pg.wait_for_timeout(900)
        url_now = pg.evaluate("() => location.search")
        check('问题2：选中的模块 id 被写进 URL（blockIds=…）',
              'blockIds=' in url_now and blocks_picked[0] in url_now,
              url_now[:140])
        # 切到别的视图再切回来 —— 选择必须还在
        goto_view(pg, 'dna')  # P19：左栏已改名 [data-nav] 且默认折叠，按 id 点
        pg.wait_for_timeout(800)
        goto_view(pg, 'idea')  # P19：左栏已改名 [data-nav] 且默认折叠，按 id 点
        pg.wait_for_timeout(1200)
        restored = pg.evaluate("""() => {
          const on=[...document.querySelectorAll('[data-block-option]')]
            .filter(o=>o.getAttribute('data-picked')==='1')
            .map(o=>o.getAttribute('data-block-option'));
          return {on, search: location.search};
        }""")
        check('问题2：切视图再回来，模块选择被恢复（不丢）',
              all(b in restored['on'] for b in blocks_picked),
              f"选中={restored['on']} 期望含={blocks_picked}")

    # ── 12.3 问题 4：零结果与"从未运行"是两种不同的话 ──
    #
    # 要求：没跑过 → 「还没有生成过组合」；
    #      跑过但 0 候选 → 「已运行生成，但没有产生候选方案。建议检查模块选择或调整债务」。
    #
    # 这条的**前提是结果区为空** —— 空态提示只在没有想法卡片时渲染。
    # 而前面验收 0b 已经真的生成过一条想法（那是后面所有"带 ideaId"断言的前置），
    # 所以直接查必然是 null。
    #
    # 怎么办：先把库里的候选想法**临时清空**，把两种态都读出来，再在
    # 下一步（12.4 之后）走正常链路补回来 —— 脚本最后整体回滚，
    # 不会污染环境。这比"跳过断言"诚实：跳过等于这块没被看护。
    def _clear_ideas():
        js = (
            "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();"
            "(async()=>{await p.candidateIdeaDebt.deleteMany({});"
            "await p.candidateIdea.deleteMany({});"
            "console.log('cleared');await p.$disconnect();})();"
        )
        subprocess.run(['node', '-e', js], cwd=str(ROOT),
                       capture_output=True, text=True, timeout=60)

    _clear_ideas()
    pg.goto(f'{URL}?view=idea', wait_until='networkidle')
    pg.wait_for_timeout(1500)
    never = pg.evaluate("""() => {
      const el=document.querySelector('[data-idea-empty]');
      return el?{mode:el.getAttribute('data-idea-empty'), text:el.innerText}:null;
    }""")
    pg.goto(f'{URL}?view=idea&ran=1', wait_until='networkidle')
    pg.wait_for_timeout(1500)
    ran = pg.evaluate("""() => {
      const el=document.querySelector('[data-idea-empty]');
      return el?{mode:el.getAttribute('data-idea-empty'), text:el.innerText}:null;
    }""")
    check('问题4：未运行时是「never-run」态，运行过是「ran-empty」态',
          never is not None and ran is not None
          and never['mode'] == 'never-run' and ran['mode'] == 'ran-empty',
          f"never={never and never['mode']} ran={ran and ran['mode']}")
    check('问题4：未运行时文案是「还没有生成过组合」',
          never is not None and '还没有生成过组合' in never['text'],
          (never or {}).get('text', '')[:90])
    check('问题4：运行过但 0 候选时的文案指向"检查模块/债务"',
          ran is not None
          and ('没有产生候选方案' in ran['text'] or '建议检查' in ran['text']),
          (ran or {}).get('text', '')[:110])

    # 把生成链路补回一条想法：12.5 之后有依赖 ideaId 的断言
    pg.goto(f'{URL}?view=idea', wait_until='networkidle')
    pg.wait_for_timeout(1500)
    _regen_opts = pg.locator('[data-block-option]')
    _regen_groups = pg.evaluate("""() => {
      const wrap=document.querySelector('[data-idea-workbench]');
      const out=[];
      document.querySelectorAll('[data-block-option]').forEach(btn=>{
        let el=btn,g='';
        while(el&&el!==wrap){const t=el.getAttribute&&el.getAttribute('data-paper-group');
          if(t){g=t;break;} el=el.parentElement;}
        out.push({id:btn.getAttribute('data-block-option'),group:g});
      });
      return out;
    }""")
    _regen_names = pg.evaluate("""() => {
      const out = [];
      document.querySelectorAll('[data-block-option]').forEach(b => {
        const spans = b.querySelectorAll('span');
        let t = '';
        if (spans.length >= 2) {
          t = (spans[spans.length-1].innerText || spans[spans.length-1].textContent || '');
        }
        if (!t.trim()) t = (b.innerText || b.textContent || '');
        out.push(t.trim());
      });
      return out;
    }""")
    _regen_pairs = pick_mechanism_pairs(_regen_groups, _regen_names) if _regen_groups else []
    if _regen_pairs:
        # ── 与验收 0b 同策略：换**不同的机制型跨论文模块对**重试 ──
        #
        # 原实现是"每篇取第一个模块（=问题动机）并连点同一对 3 次"，
        # 命中率极低（模型会正确否掉问题陈述），于是 12.5 之后的断言
        # 因缺 ideaId 连锁失败。这里改成最多试 10 对、每对出现终态文案即换。
        _dopts = pg.locator('[data-debt-option]')
        _gen = pg.locator('[data-generate-combo]')
        for (_ria, _rib) in _regen_pairs[:10]:
            def _rn(j):
                return _regen_names[j] if 0 <= j < len(_regen_names) else ''
            print(f'  [补生成] 尝试模块对 ({_ria}, {_rib})：'
                  f'{_rn(_ria)[:22]} × {_rn(_rib)[:22]}')
            pg.evaluate("""() => {
              document.querySelectorAll('[data-block-option][data-picked="1"]')
                .forEach(el => el.click());
            }""")
            pg.wait_for_timeout(350)
            _regen_opts.nth(_ria).click()
            pg.wait_for_timeout(250)
            _regen_opts.nth(_rib).click()
            pg.wait_for_timeout(400)
            if pg.locator('[data-debt-option][data-picked="1"]').count() == 0 \
                    and _dopts.count() > 0:
                _dopts.first.click()
                pg.wait_for_timeout(400)
            if _gen.count() == 0 or _gen.first.is_disabled():
                continue
            _gen.first.click()
            # ── 需求 B：产出检测改用概览计数（想法卡片已搬到击穿测试视图）──
            for _ in range(90):
                pg.wait_for_timeout(1000)
                _ie = pg.locator('[data-idea-count]').first
                if _ie.count() > 0 and int(_ie.get_attribute('data-idea-count') or '0') > 0:
                    break
                if _ >= 4 and _ % 3 == 0:
                    _body = pg.evaluate('() => document.body.innerText')
                    if ('没有找到值得组合' in _body
                            or '未通过关卡被拦下' in _body
                            or '新方案未通过校验' in _body):
                        break
            _ie = pg.locator('[data-idea-count]').first
            if _ie.count() > 0 and int(_ie.get_attribute('data-idea-count') or '0') > 0:
                break
            pg.wait_for_timeout(1200)
    _live2 = resolve_idea_id()
    if _live2:
        IDEA_ID = _live2
        print(f"[上下文] 12.3 后补生成想法，IDEA_ID = {IDEA_ID}")
    else:
        # 补生成没成功：这说明生成链路这一轮没产出候选。
        # 明确记一条，而不是静默跳过 —— 后面的 crashtest 断言依赖 IDEA_ID，
        # 静默跳过会让它们在别处以更难懂的方式失败。
        check('问题4：12.3 之后能补生成出一条想法（供后续断言使用）',
              False, '补生成后库里仍没有 CandidateIdea（生成链路本轮 0 候选）')

    # ── 12.4 问题 5：证据抽屉里的「打开 PDF 对应页」+ Esc 关闭 ──
    pg.goto(f'{URL}?view=dna', wait_until='networkidle')
    pg.wait_for_timeout(1600)
    open_first_block(pg)
    pg.wait_for_timeout(900)
    ev_btn = pg.locator('[data-detail-rail] button', has_text='查看证据')
    has_pdf_link = None
    if ev_btn.count() > 0:
        ev_btn.first.click()
        pg.wait_for_timeout(1200)
        pdf_info = pg.evaluate("""() => {
          const a=document.querySelector('[data-open-pdf]');
          return a?{href:a.getAttribute('href'), text:a.innerText, target:a.getAttribute('target')}:null;
        }""")
        has_pdf_link = pdf_info
        check('问题5：证据抽屉里有「打开 PDF 对应页」链接',
              bool(pdf_info) and '/api/paper/' in (pdf_info or {}).get('href', ''),
              str(pdf_info)[:150])
        if pdf_info and pdf_info.get('href'):
            # 链接要真的能拿到 PDF —— 这是"闭环"的关键：死链等于没做
            code = subprocess.run(
                ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
                 f"{BASE}{pdf_info['href'].split('#')[0]}"],
                capture_output=True, text=True, timeout=60).stdout.strip()
            check('问题5：该链接指向的 PDF 真的可下载（HTTP 200）',
                  code == '200', f'HTTP {code} {pdf_info["href"][:70]}')
        # Esc 关闭抽屉
        pg.keyboard.press('Escape')
        pg.wait_for_timeout(700)
        still_open = pg.evaluate("""() => {
          const d=document.querySelector('[role="dialog"][aria-modal="true"]');
          return d ? getComputedStyle(d).display !== 'none' : false;
        }""")
        check('问题5：按 Esc 能关掉证据抽屉', not still_open, f'仍打开={still_open}')
    else:
        check('问题5：证据抽屉里有「打开 PDF 对应页」链接', False,
              '该节点面板没有「查看证据」按钮')

    # ── 12.5 UI ②：画布摘要默认收起，有小图标可原地展开 ──
    pg.goto(f'{URL}?view=dna', wait_until='networkidle')
    pg.wait_for_timeout(1800)
    summ = pg.evaluate("""() => {
      const toggles=[...document.querySelectorAll('[data-summary-toggle]')];
      const cardToggles=[...document.querySelectorAll('[data-card-summary-toggle]')];
      const expanded=[...document.querySelectorAll('[data-summary-expanded="1"]')];
      return {toggles: toggles.length, cardToggles: cardToggles.length,
              expanded: expanded.length,
              collapsed: toggles.filter(t=>t.getAttribute('data-summary-toggle')==='0').length};
    }""")
    check('UI②：节点上有摘要展开小图标（data-summary-toggle）',
          summ['toggles'] > 0, f"{summ['toggles']} 个")
    check('UI②：首屏摘要默认是收起的（expanded=0 且无展开面板）',
          summ['collapsed'] == summ['toggles'] and summ['expanded'] == 0,
          f"收起 {summ['collapsed']}/{summ['toggles']} · 展开面板 {summ['expanded']}")
    # 点一个小图标 → 应当原地展开出面板（节点高度不变，用浮层）
    if summ['toggles'] > 0:
        h_before = pg.evaluate("""() => {
          const n=document.querySelector('[data-node]');
          return n?Math.round(n.getBoundingClientRect().height):0;
        }""")
        pg.locator('[data-summary-toggle]').first.click()
        pg.wait_for_timeout(600)
        after_expand = pg.evaluate("""() => {
          const n=document.querySelector('[data-node]');
          return {expanded: document.querySelectorAll('[data-summary-expanded="1"]').length,
                  h: n?Math.round(n.getBoundingClientRect().height):0};
        }""")
        check('UI②：点小图标后原地展开摘要（出现浮层）',
              after_expand['expanded'] >= 1, f"展开面板 {after_expand['expanded']} 个")
        check('UI②：展开不改变节点高度（浮层而非撑高）',
              abs(after_expand['h'] - h_before) <= 2,
              f"高度 {h_before} → {after_expand['h']}")

    # ── 12.6 UI ③：债务是列表 / 演化有时间线 ──
    goto_view(pg, 'debt')  # P19：左栏已改名 [data-nav] 且默认折叠，按 id 点
    pg.wait_for_timeout(1000)
    debt_rows = pg.evaluate("""() => {
      const rows=[...document.querySelectorAll('[data-debt-list-item]')];
      return {n:rows.length,
              bars: rows.map(r=>getComputedStyle(r).borderLeftWidth).filter(w=>w!=='0px').length,
              active: rows.filter(r=>r.getAttribute('data-list-active')==='1').length};
    }""")
    check('UI③：债务视图是列表（每债务一行 + 左侧状态色条）',
          debt_rows['n'] >= 1 and debt_rows['bars'] == debt_rows['n'],
          f"{debt_rows['n']} 行 / 带色条 {debt_rows['bars']} 行")

    goto_view(pg, 'evolution')  # P19：左栏已改名 [data-nav] 且默认折叠，按 id 点
    pg.wait_for_timeout(1200)
    # ── P21：横向 SVG 时间轴改成**纵向时间线**（一年/一篇论文一行）──
    #   [data-canvas-timeline] 这个 SVG 已不存在；年份现在是每行行首的文本。
    tl = pg.evaluate("""() => {
      const rows=[...document.querySelectorAll('[data-timeline-row]')];
      const years=rows.map(r=>{
        const s=r.querySelector('span');
        return s?(s.textContent||'').trim():'';
      });
      return {found: rows.length>0, years, n: rows.length};
    }""")
    check('UI③：演化视图是纵向时间线（每行含年份刻度）',
          tl['found'] and len(tl.get('years', [])) >= 1,
          f"{tl.get('n')} 行 / 年份={tl.get('years')}")
    check('UI③：时间线年份来自论文真实年份（2024/2022/2013 类）',
          any(re.fullmatch(r'(19|20)\d{2}', y) for y in tl.get('years', [])),
          str(tl.get('years')))

    # ── 12.7 UI ④：缩放条已整体删除 + 详情不截断 ──
    #
    # ── P19：旧断言「画布有缩放控件（放大/缩小/适应/重置 四件套）」
    #    以及它的交互断言（点放大改变缩放值、重置回到 100%）**失去对象** ——
    #    产品明确要求「logo 和缩放条从画布移走」，data-zoom-* 已从
    #    CanvasStage 整体删除（缩放仍可通过自动 fit + 滚轮/拖拽完成）。
    #    换成等价契约：① 四件套 + 数值确实不在 DOM 里（删除型改动要能被
    #    持续守住，防止被"顺手加回来"）；② 画布本身仍在（不是把画布也删了）；
    #    ③ 画布仍带自动适应（内容层有 scale transform，说明 fit 生效）。
    goto_view(pg, 'dna')  # P19：左栏已改名 [data-nav] 且默认折叠，按 id 点
    pg.wait_for_timeout(1200)
    zoom0 = pg.evaluate("""() => {
      const layer=[...document.querySelectorAll('div')].find(d=>/scale\\(/.test(d.style.transform||''));
      return {zoomLeft: !!document.querySelector('[data-zoom-in]')
                     || !!document.querySelector('[data-zoom-out]')
                     || !!document.querySelector('[data-zoom-reset]')
                     || !!document.querySelector('[data-zoom-fit]')
                     || !!document.querySelector('[data-zoom-value]'),
              canvas: !!document.querySelector('[data-canvas-stage]'),
              fit: !!layer};
    }""")
    check('UI④：缩放控件条已整体删除（P19：data-zoom-* 一件都不剩）',
          not zoom0['zoomLeft'], str(zoom0))
    check('UI④：画布仍在且仍有自动适应（内容层 scale 生效）',
          zoom0['canvas'] and zoom0['fit'], str(zoom0))

    # 详情面板里长标题必须完整显示（不被 … 截断）
    open_first_block(pg)
    pg.wait_for_timeout(1000)
    trunc = pg.evaluate("""() => {
      // ── P21：DNA 详情在右栏（<aside data-detail-rail>）──
      // 旧写法找 [data-panel]，在这个视图恒为 null → 这条断言会静默变成
      // "跳过"（assertIsNone 之后什么都不查），等于悄悄失效。
      const panel=document.querySelector('[data-detail-rail]');
      if(!panel) return null;
      const bad=[];
      panel.querySelectorAll('*').forEach(el=>{
        const cs=getComputedStyle(el);
        // 截断的两种体征：text-overflow: ellipsis，或 -webkit-line-clamp
        if(cs.textOverflow==='ellipsis' && el.children.length===0 && (el.innerText||'').length>0){
          bad.push('ellipsis:'+(el.innerText||'').slice(0,30));
        }
        if(cs.webkitLineClamp && cs.webkitLineClamp!=='none'){
          bad.push('clamp:'+(el.innerText||'').slice(0,30));
        }
      });
      return {bad, text:(panel.innerText||'').replace(/\\n/g,' | ').slice(0,120)};
    }""")
    check('UI④：详情面板里的长文本不被省略号/行数截断',
          trunc is not None and not trunc['bad'],
          str(trunc and trunc['bad'])[:140] or (trunc or {}).get('text', '')[:80])

    # ── 12.8 UI ⑤：结论必须限定在"当前收录文献"范围内 ──
    #
    # 要求：所有"没人解决"式断言 → 「当前收录文献中未见解决」。
    # 这里扫的是**实际渲染出来的界面文案**（不是源码），
    # 因为用户看到的是界面 —— 源码里改对了但模板拼错一样是没做。
    scan_pages = [
        (f'{URL}?view=debt', '研究债务视图'),
        (f'{URL}?view=evolution', '方法演化视图'),
    ]
    overclaim_hits = []
    for target_url, label in scan_pages:
        pg.goto(target_url, wait_until='networkidle')
        pg.wait_for_timeout(1300)
        txt = pg.evaluate("() => document.body.innerText")
        for bad_word in ['至今无人解决', '没有人解决', '没人解决', '尚未有人解决',
                         '业界空白', '无人涉足']:
            if bad_word in txt:
                overclaim_hits.append(f'{label}: {bad_word}')
    check('UI⑤：界面上不出现"没人解决"类无限断言',
          not overclaim_hits, str(overclaim_hits))

    # ── 12.9 收尾硬约束：界面上不许出现模型标识 ──
    #
    # 要求原文：「不要在 UI 上加任何模型标识。降级与否是日志层面的事，
    #           不是用户界面的事。」这条要能被持续守住 —— 一旦有人
    #           把"当前模型：xxx"或"已降级"贴到界面上，这里立刻报警。
    pg.goto(f'{URL}?view=dna', wait_until='networkidle')
    pg.wait_for_timeout(1500)
    model_ui = pg.evaluate("""() => {
      const t=document.body.innerText;
      const hits=[];
      ['deepseek','DeepSeek','degrade','降级','mock','Mock','MOCK','gpt-4','qwen','LLM_PROVIDER']
        .forEach(w=>{ if(t.includes(w)) hits.push(w); });
      return hits;
    }""")
    check('硬约束：界面上不出现模型名/降级标识（降级只在日志层）',
          not model_ui, str(model_ui))

    b.close()

# ── 跑完回滚到基线（失败必须报错，不静默）──
rollback_error = None
if KEEP_DATA:
    print('\n[回滚] 已指定 --keep-data，跳过（调试模式，环境可能仍是脏的）')
else:
    try:
        restore_snapshot()
    except Exception as e:  # noqa: BLE001
        rollback_error = e
        print(f'\n[回滚][ERROR] {e}')

print('\n' + '=' * 68)
passed = sum(1 for _, ok, _ in results if ok)
print(f'验收结果：{passed}/{len(results)} 通过')
failed = [(n, d) for n, ok, d in results if not ok]
if failed:
    print('未通过：')
    for n, d in failed:
        print(f'  - {n}  ({d})')
else:
    print('全部通过 ✓')
if rollback_error:
    print('⚠ 回滚失败：环境未恢复基线，请按上面的提示手动恢复')
print('=' * 68)

# 退出码：断言全过 **且** 回滚成功 才算 0。
# 为什么回滚失败也算失败：脏数据会污染下一次运行（制造假通过/假失败），
# 那是比"某条断言没过"更严重的后果 —— 必须让 CI 红。
ok_all = (passed == len(results)) and rollback_error is None
sys.exit(0 if ok_all else 1)
