"""
问题 4 实测：手术模式「点两次切换」

验证链路（每步都截图）：
  1. 进 DNA 视图 → 点剪刀 → 进入手术模式
  2. 第一次点 Block A → 应摘除（节点红框 + 面板出现手术结论）
  3. 第二次点 Block A → 应恢复（红框消失 + 面板显示「已恢复」）
  4. 第三次点 Block A → 应再次摘除
  5. 清理：把这次产生的手术删掉

断言靠 DOM：
  · 面板文案含「已恢复」→ 恢复生效
  · data-intervened="1" → 摘除生效
"""
import asyncio, sys, json
from playwright.async_api import async_playwright

BASE = 'http://localhost:3000'
SHOT = 'docs/screenshots'

async def get_pid():
    """直接查库拿 projectId —— 从 HTML 正则抓不可靠（会命中 /projects/page 之类）"""
    import subprocess
    out = subprocess.run(
        ['node', '-e', """
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.project.findFirst().then(r=>{console.log(r?r.id:'');process.exit(0)});
"""], capture_output=True, text=True, cwd='.')
    return out.stdout.strip()

async def main():
    pid = await get_pid()
    print('projectId =', pid)
    if not pid:
        print('!! 拿不到 projectId'); return 1

    url = f'{BASE}/projects/{pid}?view=dna'
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        pg = await b.new_page(viewport={'width': 1500, 'height': 950})
        await pg.goto(url, wait_until='networkidle')
        await pg.wait_for_timeout(1500)

        # ① 进手术模式
        sc = pg.locator('[data-surgery-toggle]')
        await sc.click()
        await pg.wait_for_timeout(600)
        active = await sc.get_attribute('data-surgery-active')
        print('① 手术模式 active =', active)
        await pg.screenshot(path=f'{SHOT}/p8-q4-1-mode-on.png')

        # 找第一个可切的 block 节点
        targets = pg.locator('[data-surgery-target="1"]')
        n = await targets.count()
        print('   可切节点数 =', n)
        if n == 0:
            print('!! 没有可切节点'); await b.close(); return 1
        t0 = targets.nth(0)
        node_id = await t0.get_attribute('data-node')
        print('   选中节点 =', node_id)

        # ② 第一次点 → 摘除
        await t0.click(force=True)
        await pg.wait_for_timeout(3000)
        iv1 = await pg.locator(f'[data-node="{node_id}"]').get_attribute('data-intervened')
        panel1 = await pg.locator('[data-panel]').inner_text() if await pg.locator('[data-panel]').count() else ''
        print('② 第一次点 data-intervened =', iv1, '(应 1)')
        print('   面板前 120 字 =', panel1[:120].replace('\n', ' | '))
        await pg.screenshot(path=f'{SHOT}/p8-q4-2-removed.png')

        # ③ 第二次点同一节点 → 恢复
        await pg.locator(f'[data-node="{node_id}"]').click(force=True)
        await pg.wait_for_timeout(3000)
        iv2 = await pg.locator(f'[data-node="{node_id}"]').get_attribute('data-intervened')
        panel2 = await pg.locator('[data-panel]').inner_text() if await pg.locator('[data-panel]').count() else ''
        has_restore = '已恢复' in panel2
        print('③ 第二次点 data-intervened =', iv2, '(应 0)')
        print('   面板含「已恢复」 =', has_restore)
        print('   面板前 160 字 =', panel2[:160].replace('\n', ' | '))
        await pg.screenshot(path=f'{SHOT}/p8-q4-3-restored.png')

        # ④ 第三次点 → 应再次摘除
        await pg.locator(f'[data-node="{node_id}"]').click(force=True)
        await pg.wait_for_timeout(3000)
        iv3 = await pg.locator(f'[data-node="{node_id}"]').get_attribute('data-intervened')
        print('④ 第三次点 data-intervened =', iv3, '(应 1)')
        await pg.screenshot(path=f'{SHOT}/p8-q4-4-removed-again.png')

        # ⑤ 清理：再点一次恢复
        await pg.locator(f'[data-node="{node_id}"]').click(force=True)
        await pg.wait_for_timeout(3000)
        iv4 = await pg.locator(f'[data-node="{node_id}"]').get_attribute('data-intervened')
        print('⑤ 清理后 data-intervened =', iv4, '(应 0)')

        await b.close()

    ok = (active == '1' and iv1 == '1' and iv2 == '0' and has_restore and iv3 == '1' and iv4 == '0')
    print()
    print('==== 问题 4 结论：', '✅ 通过' if ok else '❌ 未通过', '====')
    return 0 if ok else 1

sys.exit(asyncio.run(main()))
