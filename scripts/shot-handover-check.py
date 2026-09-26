#!/usr/bin/env python3
"""交接核验截图（零模型调用，不烧 API 余额）：idea / crashtest 两视图实拍。"""
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
PROJECT = "cmu9my2ie0000z6pko5sqr27s"
LAB = f"{BASE}/projects/{PROJECT}/lab"
OUT = Path("/workspace/MethodAtlas/交接核验截图")
OUT.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    page.goto(LAB, wait_until="networkidle")
    page.wait_for_timeout(1500)

    # idea 视图
    page.click('[data-view="idea"]')
    page.wait_for_timeout(1200)
    page.screenshot(path=str(OUT / "01-idea视图-手动添加模块.png"), full_page=False)

    # crashtest 视图（含画布下方 AI 讨论 dock）
    page.click('[data-view="crashtest"]')
    page.wait_for_timeout(1200)
    page.screenshot(path=str(OUT / "02-击穿测试-AI讨论dock.png"), full_page=False)

    # DNA 视图（默认主视图）
    page.click('[data-view="dna"]')
    page.wait_for_timeout(1200)
    page.screenshot(path=str(OUT / "03-方法DNA视图.png"), full_page=False)

    print("截图完成:", *[f.name for f in sorted(OUT.iterdir())], sep="\n  ")
    print("console 错误数:", len(errors))
    for e in errors[:5]:
        print("  ", e)
    browser.close()
