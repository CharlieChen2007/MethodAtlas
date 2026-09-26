"""
P8 全量截图：八个问题各一张「效果图」。

用法：python3 scripts/shot-p8.py
输出：docs/screenshots/p8-*.png

设计说明：每张图都是"用户实际会看到的画面"，不做任何 DOM 注入改样式——
否则截图就变成了自证，而不是证据。
"""
import asyncio, subprocess, os
from playwright.async_api import async_playwright

BASE = 'http://localhost:3000'
SHOT = 'docs/screenshots'


def get_pid():
    out = subprocess.run(['node', '-e', """
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.project.findFirst().then(r=>{console.log(r?r.id:'');process.exit(0)});
"""], capture_output=True, text=True, cwd='.')
    return out.stdout.strip()


async def main():
    os.makedirs(SHOT, exist_ok=True)
    pid = get_pid()
    print('projectId =', pid)

    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        pg = await b.new_page(viewport={'width': 1500, 'height': 950})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:200]))

        def url(view, extra=''):
            return f"{BASE}/projects/{pid}/lab?view={view}{extra}"

        async def shot(name, note=''):
            await pg.screenshot(path=f'{SHOT}/{name}.png')
            print(f'  [OK] {name}.png  {note}')

        # ── 问题 1：上传按钮固定在画布左上角 ──
        await pg.goto(url('dna'), wait_until='networkidle')
        await pg.wait_for_timeout(1800)
        await shot('p8-q1-upload-fixed', '上传按钮左上角')

        # ── 问题 2：Block 角色已分化 ──
        blocks = pg.locator('[data-node^="block-"]')
        nb = await blocks.count()
        print('  block 节点数 =', nb)
        roles = set()
        for i in range(nb):
            try:
                roles.add((await pg.locator('[data-node^="block-"]').nth(i).inner_text())[:200])
            except Exception:
                pass
        if nb:
            await pg.locator('[data-node^="block-"]').first.click(force=True)
            await pg.wait_for_timeout(1200)
            txt = await pg.locator('[data-panel]').inner_text()
            print('  --- Block 面板 ---')
            print('  ' + txt[:300].replace('\n', '\n  '))
            await shot('p8-q2-block-role', '从 description 提炼的角色')

        # ── 问题 3：手术结论一句话 ──
        await pg.goto(url('dna'), wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        await pg.locator('[data-node^="block-"]').first.click(force=True)
        await pg.wait_for_timeout(1000)
        btn = pg.locator('[data-panel-action="surgery"]')
        if await btn.count():
            await btn.first.click(force=True)
            await pg.wait_for_timeout(5000)
            try:
                txt = await pg.locator('[data-panel]').inner_text(timeout=6000)
                print('  --- 手术结论 ---')
                print('  ' + txt[:400].replace('\n', '\n  '))
            except Exception:
                pass
            await shot('p8-q3-surgery-conclusion', '移除 X 后…因为 X 负责 Y')
        else:
            await shot('p8-q3-surgery-conclusion', '（未找到手术按钮）')

        # ── 问题 4：手术模式两次点击切换 ──
        #
        # ⚠️ 本段与上面的问题 3 都会**真的写库**（问题 3 运行手术、
        #    本段摘除后再恢复）。一次"摘除 + 恢复"净变化为 0，
        #    但问题 3 那一次是净 +1。所以最后必须统一清理，
        #    否则脚本会污染基线，让随后跑的验收脚本假失败。
        await pg.goto(url('dna'), wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        scissor = pg.locator('[data-surgery-toggle]')
        if await scissor.count():
            await scissor.first.click(force=True)
            await pg.wait_for_timeout(900)
            await shot('p8-q4-1-surgery-mode-on', '手术模式开启')
            node = pg.locator('[data-node^="block-"]').first
            await node.click(force=True)
            await pg.wait_for_timeout(4500)
            await shot('p8-q4-2-block-removed', '第一次点击 → 已摘除')
            node = pg.locator('[data-node^="block-"]').first
            await node.click(force=True)
            await pg.wait_for_timeout(4500)
            await shot('p8-q4-3-block-restored', '第二次点击 → 已恢复')
            # 退出手术模式
            sc = pg.locator('[data-surgery-toggle]')
            if await sc.count():
                await sc.first.click(force=True)
                await pg.wait_for_timeout(800)

        # ── 问题 5：演化一句话提炼 + 状态标签 ──
        await pg.goto(url('evolution'), wait_until='networkidle')
        await pg.wait_for_timeout(2000)
        cards = pg.locator('[data-node^="problem-"]')
        nc = await cards.count()
        print('  演化问题卡片数 =', nc)
        await shot('p8-q5-1-evolution-cards', '卡片=一句话问题名+状态标签')
        if nc:
            await cards.nth(0).click(force=True)
            await pg.wait_for_timeout(1500)
            txt = await pg.locator('[data-panel]').inner_text()
            print('  --- 演化面板 ---')
            print('  ' + txt[:400].replace('\n', '\n  '))
            await shot('p8-q5-2-evolution-panel', '状态在前，原文进查看证据')

        # ── 问题 6：研究债务同构 ──
        await pg.goto(url('debt'), wait_until='networkidle')
        await pg.wait_for_timeout(2000)
        dcards = pg.locator('[data-node^="debt-"]')
        nd = await dcards.count()
        print('  债务卡片数 =', nd)
        await shot('p8-q6-1-debt-cards', '卡片=一句话+状态标签')
        if nd:
            await dcards.nth(0).click(force=True)
            await pg.wait_for_timeout(1500)
            txt = await pg.locator('[data-panel]').inner_text()
            print('  --- 债务面板 ---')
            print('  ' + txt[:500].replace('\n', '\n  '))
            await shot('p8-q6-2-debt-panel', '《X》尝试了「Y」→ 结果：Z')

        # ── 问题 7：组合想法机制压到 1-2 句 + 待验证标签 ──
        await pg.goto(url('idea'), wait_until='networkidle')
        await pg.wait_for_timeout(2200)
        ic = pg.locator('[data-idea-card]')
        ni = await ic.count()
        print('  想法卡片数 =', ni)
        badge = pg.locator('[data-card-badge]')
        print('  待验证 badge 数 =', await badge.count())
        await shot('p8-q7-1-idea-workbench', '机制 1-2 句 + 待验证标签')
        if ni:
            await ic.first.click()
            await pg.wait_for_timeout(1800)
            await shot('p8-q7-2-idea-panel', '详细解释进查看详情折叠')

        # ── 问题 8：击穿测试给倾向 ──
        await pg.goto(url('crashtest'), wait_until='networkidle')
        await pg.wait_for_timeout(2200)
        cc = pg.locator('[data-node^="crash-"]')
        ncr = await cc.count()
        print('  击穿卡片数 =', ncr)
        await shot('p8-q8-1-crashtest-cards', '总体判定 + 四档检查')
        if ncr:
            await cc.first.click(force=True)
            await pg.wait_for_timeout(1800)
            txt = await pg.locator('[data-panel]').inner_text()
            print('  --- 击穿面板 ---')
            print('  ' + txt[:800].replace('\n', '\n  '))
            await shot('p8-q8-2-crashtest-panel', '四档：通过/需要调整/无法判断/不通过')

        # ── 清理：把截图过程写进库的 Surgery 记录还原回 0 ──
        #
        # 截图脚本只负责"出图"，不该改变被测系统状态。
        # 问题 3 那次手术是净 +1，不清理就会污染随后跑的验收脚本
        # （验收 9 会因"点到的 Block 已有记录"而变成恢复，全线假失败）。
        cleaned = await cleanup_surgeries(pg, pid)
        print(f'  [清理] 移除截图期间写入的 Surgery 记录 {cleaned} 条')

        print('--- pageerrors ---')
        for e in errs[:10]:
            print('  ', e)

        await b.close()


async def cleanup_surgeries(pg, pid) -> int:
    """在手术模式下逐个点掉带 Surgery 记录的 Block，直到库里清零。"""
    removed = 0
    for _ in range(10):
        n = _surgery_count()
        if n == 0:
            break
        await pg.goto(f"{BASE}/projects/{pid}/lab?view=dna", wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        sc = pg.locator('[data-surgery-toggle]')
        if await sc.count() == 0:
            break
        await sc.first.click(force=True)
        await pg.wait_for_timeout(800)
        targets = pg.locator('[data-surgery-target="1"]')
        if await targets.count() == 0:
            await sc.first.click(force=True)
            break
        await targets.first.click(force=True)
        await pg.wait_for_timeout(3500)
        if _surgery_count() < n:
            removed += 1
        await sc.first.click(force=True)
        await pg.wait_for_timeout(600)
    return removed


def _surgery_count() -> int:
    out = subprocess.run(['node', '-e', """
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.surgery.count().then(n=>{console.log(n);process.exit(0)});
"""], capture_output=True, text=True, cwd='.')
    try:
        return int(out.stdout.strip().splitlines()[-1])
    except Exception:
        return -1


asyncio.run(main())
