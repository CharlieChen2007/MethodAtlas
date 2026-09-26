# MethodAtlas 一键启动脚本（Windows / PowerShell）
#
# 用法：
#   1) 在资源管理器里右键此文件 → 「使用 PowerShell 运行」
#      或在 PowerShell 里：  .\一键启动.ps1
#   2) 若提示"禁止运行脚本"，先执行：
#         Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#
# 它会自己找到项目根（哪怕你停在解压出来的外层目录），
# 然后依次跑：目录自检 → 装依赖 → 同步数据库 → 构建 → 启动。

$ErrorActionPreference = 'Stop'

function Write-Step($n, $text) {
  Write-Host ""
  Write-Host ("=" * 60) -ForegroundColor DarkGray
  Write-Host "  [$n] $text" -ForegroundColor Cyan
  Write-Host ("=" * 60) -ForegroundColor DarkGray
}

# ── 找到项目根：当前目录 or 下一层子目录 ──
function Resolve-ProjectRoot {
  if ((Test-Path "package.json") -and (Test-Path "prisma\schema.prisma")) {
    return (Get-Location).Path
  }
  $cand = Get-ChildItem -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName "package.json") } |
    Select-Object -First 1
  if ($cand) { return $cand.FullName }
  return $null
}

Write-Step 0 "定位项目根目录"
$root = Resolve-ProjectRoot
if (-not $root) {
  Write-Host "✗ 找不到项目根（应含 package.json / prisma\schema.prisma）。" -ForegroundColor Red
  Write-Host "  请确认压缩包已完整解压。" -ForegroundColor Red
  exit 1
}
if ($root -ne (Get-Location).Path) {
  Write-Host "→ 你在外层目录，自动进入：$root" -ForegroundColor Yellow
}
Set-Location $root
Write-Host "✓ 项目根：$root" -ForegroundColor Green

# ── 前置检查 ──
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "✗ 找不到 node。请先安装 Node.js 18.17+（推荐 20/22）。" -ForegroundColor Red
  exit 1
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "! 找不到 pnpm，尝试用 corepack 启用…" -ForegroundColor Yellow
  corepack enable
  corepack prepare pnpm@latest --activate
}
Write-Host ("✓ node " + (node -v) + " / pnpm " + (pnpm -v)) -ForegroundColor Green

# ── 启动前自检（目录 + 旧版残留）──
Write-Step 0 "启动前自检（目录 + 旧版残留）"
if (Test-Path "check-dir.mjs") {
  node check-dir.mjs
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "✗ 自检未通过，已中止 —— 先按上面的提示处理后重跑。" -ForegroundColor Red
    Write-Host "  （最常见：在同目录反复覆盖解压，导致旧文件残留）" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "! 未找到 check-dir.mjs，跳过自检" -ForegroundColor Yellow
}

# ── 装依赖 ──
Write-Step 1 "安装依赖（pnpm install --frozen-lockfile）"
if (Test-Path "pnpm-lock.yaml") {
  pnpm install --frozen-lockfile
} else {
  Write-Host "! 未找到 pnpm-lock.yaml，改用普通安装（会重新生成 lockfile）" -ForegroundColor Yellow
  pnpm install
}

# ── 同步数据库 ──
Write-Step 2 "同步数据库结构（pnpm db:push）"
pnpm db:push

# ── 构建 ──
Write-Step 3 "生产构建（pnpm build）"
pnpm build

# ── 启动 ──
Write-Step 4 "启动服务（pnpm start）"
Write-Host "浏览器打开： http://localhost:3000" -ForegroundColor Green
Write-Host "换端口：     `$env:PORT=`"3100`"; pnpm start" -ForegroundColor DarkGray
Write-Host ""
pnpm start
