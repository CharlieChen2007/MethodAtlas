"""
问题 5 / 6 截图：Evolution 卡片一句话提炼 + 状态标签；Debt 面板结论优先。
"""
import asyncio, subprocess, sys
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
    pid = get_pid()
    print('projectId =', pid)
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        pg = await b.new_page(viewport={'width': 1500, 'height': 950})

        # ── 问题 5：演化视图 ──
        await pg.goto(f"{BASE}/projects/{pid}/lab?view=evolution", wait_until='networkidle')
        await pg.wait_for_timeout(2000)
        await pg.screenshot(path=f'{SHOT}/p8-q5-1-evolution-cards.png')

        # 点第一张问题卡片 → 面板
        cards = pg.locator('[data-node^="problem-"]')
        n = await cards.count()
        print('演化卡片数 =', n)
        if n:
            await cards.nth(0).click(force=True)
            await pg.wait_for_timeout(1200)
            panel = await pg.locator('[data-panel]').inner_text()
            print('--- 演化面板 ---')
            print(panel[:600])
            await pg.screenshot(path=f'{SHOT}/p8-q5-2-evolution-panel.png')

        # ── 问题 6：债务视图 ──
        await pg.goto(f"{BASE}/projects/{pid}/lab?view=debt", wait_until='networkidle')
        await pg.wait_for_timeout(2000)
        await pg.screenshot(path=f'{SHOT}/p8-q6-1-debt-cards.png')

        dcards = pg.locator('[data-node^="debt-"]')
        dn = await dcards.count()
        print('债务卡片数 =', dn)
        if dn:
            await dcards.nth(0).click(force=True)
            await pg.wait_for_timeout(1200)
            panel = await pg.locator('[data-panel]').inner_text()
            print('--- 债务面板 ---')
            print(panel[:800])
            await pg.screenshot(path=f'{SHOT}/p8-q6-2-debt-panel.png')

        await b.close()
    return 0

sys.exit(asyncio.run(main()))
