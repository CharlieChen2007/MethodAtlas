# MethodAtlas · Windows / PowerShell 启动命令

> 面向在 **Windows** 上第一次跑起 MethodAtlas 的人。
> 按「窗口」组织，每个窗口都写清楚**成功标志**和**启动顺序**。
> 适用版本：**P7-5c 第二批**（问题 3 / 4 / 1 + 验收脚本合并与自动回滚）。

---

## 0. 先看这个：这一版需要几个窗口？

| 版本 | 窗口数 | 说明 |
|---|---|---|
| **当前版本（P7-5c / B1 方案）** | **1 个窗口** | PDF 解析内置在 Next.js 的 API Route 里（`pdfjs-dist`），**不需要**再起 Python 解析服务 |
| 旧版本（外部 parser-service） | 2 个窗口 | 需要额外起 FastAPI 解析服务（见文末附录） |

**结论：默认只开 1 个窗口就够了。**

> 为什么变了：问题 6 把上传解析从"调外部 Python 服务"改成"内置 Next.js API Route"
> （B1 方案）。这样解析链路的每一环都在同一个进程里，失败能给明确错误、
> 不会因为"忘了起解析服务"而静默失败。Python 服务成为**可选**。

> 本轮（P7-5c）没有改变窗口数。**上传按钮的位置变了**：
> 从右侧论文列表搬到了**画布左上角**（问题 1）。见第 3 节手工走查。

---

## 0.5 ⚠️ 先确认你在哪一层（90% 的启动失败都在这里）

压缩包解压后会**多一层同名目录**：

```
D:\MethodAtlas\              ← 解压根（"解压到 MethodAtlas\" 的落地处）
  └─ methodatlas\            ← 真正的项目根：package.json 在这里
       ├─ package.json
       ├─ pnpm-lock.yaml
       ├─ prisma\
       └─ src\
```

**你必须在 `methodatlas\` 这一层执行 pnpm 命令**，不是外面那层。

### 站错层时，pnpm 的报错长这样（都像"文件缺失"，其实不是）

```text
PS D:\MethodAtlas> pnpm install --frozen-lockfile
 ERR_PNPM_NO_LOCKFILE  Cannot install with "frozen-lockfile"
 because pnpm-lock.yaml is absent
PS D:\MethodAtlas> pnpm db:push
 Command "db:push" not found
PS D:\MethodAtlas> pnpm start
 Missing script: start
PS D:\MethodAtlas> pnpm install
 Lockfile is up to date ... Already up to date      ← 看起来"成功"，其实什么都没装
```

> **这些报错没有一条是"文件缺失"。** `pnpm-lock.yaml`(37KB) 与 `package.json`
> 都好好地在 `methodatlas\` 里，只是你当前目录是它们的**上一层**，pnpm 看不见。
>
> 最坑的是 `pnpm install` 那句 —— 它会打印 `Already up to date`，
> 让你以为装好了，然后 `pnpm start` 继续报不存在。

### 一行自检，把「该敲什么」直接打给你

```powershell
# 在解压根、项目根 都能运行
node check-dir.mjs
```

它会做**两件**事（对应下面 0.5 / 0.6 两个坑）：

1. **找项目根** —— 站错层就给你 `cd methodatlas`；
2. **查旧版残留** —— 目录是脏的就列出具体文件（见 0.6）。

三种结果的形态：

- **你在项目根、目录干净** → `① 目录 ✓` + `② 残留 ✓`，退出码 `0`：

  ```text
  MethodAtlas · 启动前自检
  ────────────────────────────────────────────────────────
  当前目录：D:\MethodAtlas\methodatlas

  ① 目录：✓ 你在项目根目录。
     D:\MethodAtlas\methodatlas
  ② 残留：✓ 未发现旧版本残留文件。

  可以开始了：
    pnpm install --frozen-lockfile
    pnpm db:push
    pnpm build
    pnpm start
  ```

- **你在解压根** → `✗ 你在「解压根」，不是项目根 —— 少进了一层。`，
  并直接给出可复制的 `cd methodatlas` + 后续命令，退出码 `1`：

  ```text
  MethodAtlas · 启动前自检
  ────────────────────────────────────────────────────────
  当前目录：D:\MethodAtlas

  结果：✗ 你在「解压根」，不是项目根 —— 少进了一层。

    真正要进的目录是：D:\MethodAtlas\methodatlas

  正确做法（复制即用）：

    cd methodatlas
    node check-dir.mjs
    pnpm install --frozen-lockfile
    pnpm db:push
    pnpm build
    pnpm start
  ```

- **目录脏（有旧版残留）** → `② 残留 ✗` 并列出命中文件，退出码 `1`（见 0.6）。

### 或者干脆用一键启动脚本

仓库自带 `一键启动.ps1`，它会**自己找到项目根**（当前目录或下一层子目录），
所以你停在解压根直接跑也行：

```powershell
# 在解压根即可，脚本会自动 cd 进 methodatlas\
.\一键启动.ps1
```

若提示「禁止运行脚本」：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\一键启动.ps1
```

脚本依次做这些事：**定位项目根 → 启动前自检 → 装依赖 → 同步数据库 → 构建 → 启动**。
**自检不通过会直接中止**（退出码 1），不会带着脏目录硬着头皮去 build。

---

## 0.6 ⚠️ 另一个大坑：目录里有旧版本残留（build 失败 / 连不上都是它）

**症状**：`pnpm build` 报类型错误，然后 `pnpm start` 报
`Could not find a production build in the '.next' directory`，
浏览器 `ERR_CONNECTION_REFUSED`。看起来像三个独立的故障，其实是**同一个原因**：

```text
PS D:\MethodAtlas\methodatlas> pnpm build
...
  const activePaperId = useProjectUIStore((s) => s.activePaperId)
                        ^
Next.js build worker exited with code: 1
 ELIFECYCLE  Command failed with exit code 1.

PS D:\MethodAtlas\methodatlas> pnpm start
 ✓ Starting...
Error: Could not find a production build in the '.next' directory.
```

（浏览器：`ERR_CONNECTION_REFUSED` —— 因为 start 已经退出了，没人监听 3000）

### 为什么会这样

**你在同一个目录上反复覆盖解压过不同版本的包。**

```
D:\MethodAtlas\methodatlas\
  ├─ src\  ← 解压 P7-5c 新包：新文件被覆盖
  │        ← 但旧包独有的文件（如旧的 ProjectNav / store\project-ui.ts）
  │           **不会自动消失**，继续躺在 src\ 里
  └─ ...
```

`next build` 会把 `src\` 下**所有**文件都编译一遍，包括那些旧残留。
旧文件引用的是新版已删除的 store / 组件 → 立刻报「找不到导出 / 类型不匹配」。
build 失败 → 没有 `.next` 产物 → start 报找不到 production build → 浏览器拒绝连接。

> **关键**：这三条报错，**没有一条在说"你的目录是脏的"**。
> 你会去查类型定义、查 `.next` 目录、查端口 —— 方向全错。

### 怎么确认

```powershell
node check-dir.mjs
```

脏目录会明确列出来：

```text
  ① 目录：✓ 你在项目根目录。
     D:\MethodAtlas\methodatlas
  ② 残留：✗ 扫到 7 处旧版本痕迹 —— 这个目录是脏的。

     · src/components/legacy/ProjectNav.tsx
       命中「useProjectUIStore」：旧的 zustand 全局 store（P7 早期架构，现已删除）
     · src/components/legacy/ProjectNav.tsx
       命中「ProjectNav」：旧的左侧固定导航栏（B6 单页画布改造时删除）
     · src/store/project-ui.ts
       命中「from 'zustand'」：zustand 依赖（已从 package.json 移除）
     ...
```

它认识的「旧版哨兵」包括：`useProjectUIStore`、`ProjectNav`、
`activePaperId`、`activeMethodId`、`from 'zustand'` —— 这些在当前版本里
**已彻底删除**，出现即代表残留。（源码注释里提到它们**不算**，脚本会先剥注释再判断。）

### 怎么修（推荐 · 干净解压）

```powershell
# 1) 先停掉正在跑的服务（Ctrl+C），并关掉占用该目录的编辑器

# 2) 把旧目录改名留档（别直接删，万一还要查东西）
Rename-Item methodatlas methodatlas-old

# 3) 重新解压一份干净的包，然后标准流程
cd methodatlas
node check-dir.mjs            # 必须 ① ② 双 ✓
pnpm install --frozen-lockfile
pnpm db:push
pnpm build
pnpm start
```

### 怎么预防

**每次拿到新包，都解压到一个全新目录**（或先改名旧的），不要在旧目录上覆盖。
这一步比什么都管用 —— 覆盖解压正是残留的唯一来源。

```text
好的做法                          坏的做法
D:\MethodAtlas\                   D:\MethodAtlas\methodatlas\
  ├─ v1\                            └─ （旧包 + 新包混在一起）
  ├─ v2\  ← 新包解压到新目录              → 残留 → build 失败
  └─ v3\
```

---

## 1. 一次性准备（只做一遍）

以**管理员**或普通用户打开 **PowerShell**，进入项目目录：

```powershell
# 0) 先自检（强烈建议）：必须 ① ② 双 ✓
node check-dir.mjs

# 1) 进入项目根（注意：是内层的 methodatlas\）
cd D:\MethodAtlas\methodatlas

# 2) 确认关键文件都在
Get-ChildItem package.json, pnpm-lock.yaml, .env, prisma\dev.db, prisma\schema.prisma

# 3) 安装依赖（首次或依赖变更后）
pnpm install --frozen-lockfile

# 4) 对齐 Prisma Client（不清数据）
pnpm db:push

# 5) 构建生产包
pnpm build
```

> **关于 `.env`**：压缩包里**已经带了可用的 `.env`**（默认 `LLM_PROVIDER=mock`，
> 不含任何密钥），所以第 2 步列 `.env` 一定能列出来，`pnpm db:push` 不会缺
> `DATABASE_URL`。想接真实模型（OpenAI / DeepSeek / Ollama）时再改 `.env`，
> 参考同目录的 `.env.example`。
>
> 若 `.env` 因故缺失，`pnpm db:push` 会报
> `Environment variable not found: DATABASE_URL` —— 复制一份即可：
> ```powershell
> Copy-Item .env.example .env
> ```

**成功标志：**

| 步骤 | 成功时的输出 |
|---|---|
| `pnpm install` | 末尾出现 `Done in …`，无 `ERR_PNPM_` 开头 |
| `pnpm db:push` | `🚀  Your database is now in sync with your Prisma schema.` |
| `pnpm build` | 末尾打印路由表，含 `ƒ /projects/[pid]/lab`，且出现 `✓ Compiled successfully` |

> 如果 `pnpm` 不存在：`npm install -g pnpm`（需要 Node 18.17+，推荐 20/22）。
> 检查：`node -v`、`pnpm -v`。

---

## 2.【窗口 1：主服务】—— 唯一必需的窗口

```powershell
cd D:\MethodAtlas\methodatlas
pnpm start
```

> 想换端口（默认 3000）：
> ```powershell
> $env:PORT = "3100"; pnpm start
> ```
> 注意 PowerShell 里是 `$env:PORT = "3100"`（**不是** `set PORT=`，
> 那是 cmd 的写法）。端口解析已内置，Windows 下同样生效。

**成功标志（逐条对照）：**

1. 终端打印：
   ```
     ▲ MethodAtlas · next start
     - Local:   http://localhost:3000
   ```
2. 再出现一行：`✓ Ready in …ms`
3. 浏览器打开 <http://localhost:3000> → 自动跳到 `/projects`，能看到项目列表

> ⚠️ 只看到 `▲ MethodAtlas · next start` 和 `✓ Starting...` **不算成功** ——
> 还要出现 **`✓ Ready in …ms`**。若 `Starting...` 之后紧跟着
> `Error: Could not find a production build ...`，说明 `pnpm build` **没成功过**，
> 先回到第 1 节把 build 跑绿（多半是脏目录，见 0.6）。

**失败时的常见原因：**

| 报错 | 原因 | 处理 |
|---|---|---|
| `ERR_PNPM_NO_LOCKFILE` / `Command "db:push" not found` / `Missing script: start` | **目录不对**：站在解压根，没进 `methodatlas\` | 见第 0.5 节。`node check-dir.mjs` 一键诊断 |
| `Environment variable not found: DATABASE_URL` | `.env` 缺失 | `Copy-Item .env.example .env` |
| `pnpm build` 报类型错误（`no exported member` / 变量未定义） | **目录脏**：旧版本文件残留 | 见第 0.6 节。`node check-dir.mjs` 会列出残留文件 |
| `Could not find a production build in the '.next' directory` | `pnpm build` 没成功（多半是上一行的类型错误导致） | 先解决 build 报错，再 `pnpm start` |
| 浏览器 `ERR_CONNECTION_REFUSED` | `pnpm start` 已退出（多半是上面那条找不到 build） | 看 start 窗口的报错，往上追 |
| `还没构建过，找不到 .next 目录` | 跳过了 `pnpm build` | 回到第 1 节第 5 步 |
| `EADDRINUSE: address already in use :3000` | 3000 被占用 | `$env:PORT="3100"; pnpm start`，或杀掉占用端口的进程 |
| `Cannot find module '@prisma/client'` | 没跑 `pnpm db:push` | 回到第 1 节第 4 步 |
| `Unknown argument ...` 之类 schema 报错 | 数据库与 schema 不同步 | `pnpm db:push` |

---

## 3. 冒烟验证（可选，但推荐）

窗口 1 保持运行，**另开**一个 PowerShell 窗口：

```powershell
# 健康检查：能拿到 307（重定向到 /projects）就说明服务活着
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:3000/
```

**成功标志：** 输出 `307`。

然后浏览器里手工走一遍：

1. 打开 <http://localhost:3000> → 进项目 → 进「方法实验室」（`/lab`）
2. **画布左上角**点「＋」上传一个 PDF → 顶部出现进度提示，右侧论文列表 +1
   （**这是问题 6 的核心链路**，成功标志是列表真的多了一篇、状态栏论文数 +1）
   > 注意：上传按钮在 **画布左上角**（问题 1 之后从右栏搬过来的），
   > 与右上角的剪刀按钮左右对称 —— 左加右减。
3. 画布右上角点剪刀图标 → 点任意模块 → 底部面板出现「一句话结论」
4. 切到「方法演化」→ 卡片标题是**问题名**（不是"A → B"）→ 点开看状态与各论文处理
5. 切到「组合想法」→ 左边选债务、中间按论文分组选模块 → 点「生成组合」→
   右侧出现想法卡片（含"来自哪些模块 / 目标债务 / 机制"）
6. 切到「击穿测试」视图 → 点一张卡片 → 面板出现「可行 / 需要调整 / 不建议做」的判定

---

## 3.5 自动化验收（推荐跑一次）

手工走查之外，仓库里有一套**统一验收脚本**（162 条断言），
在另一个 PowerShell 窗口跑：

```powershell
python scripts/verify-local.py
```

**前置：**

```powershell
pip install playwright
python -m playwright install chromium
```

**成功标志：**

```
[基线] 论文 4 / 手术 0 / 关系 0 / 债务 1 / 想法 2
[基线] dev.db 已快照 · storage 已快照 · 备份于 C:\Users\...\Temp\verify-baseline-xxxx
   ...（逐条 PASS）
验收结果：162/162 通过
全部通过 ✓
[回滚] 已恢复基线：论文 4 / 手术 0 / 关系 0 / 债务 1 / 想法 2 ✓
```

### 脚本会自动清理数据（重要）

验收脚本会真的上传论文、跑手术、生成想法 —— 也就是**会往库里写数据**。
脚本已经做到：

1. **开跑前**记录基线：各表计数 + 拷贝 `prisma/dev.db` + 快照 `storage/` 目录；
2. **跑完自动恢复**到基线（文件级还原，无论写了什么都能原样回退）；
3. **恢复失败会报错**（红色 `[回滚][ERROR]` + 非 0 退出码），
   并打印备份目录，供你手动把 `dev.db` 与 `storage` 覆盖回去。

也就是说：**跑完不需要手动清库**。若想保留数据用于调试：

```powershell
python scripts/verify-local.py --keep-data
```

> `--keep-data` 会明确提示"环境可能仍是脏的"，不会假装干净。

**退出码怎么读：**

| 退出码 | 含义 |
|---|---|
| `0` | 断言全过 **且** 回滚成功 |
| `1` | 有断言没过，**或** 回滚失败（两者都算失败） |

> 为什么回滚失败也算失败：脏数据会污染下一次运行（制造假通过/假失败），
> 比"某条断言没过"更严重 —— CI 必须红。

---

## 4. 启动顺序（总结）

**当前版本（单窗口）：**

```
[窗口 1] pnpm start  →  浏览器 http://localhost:3000
```

就这两步。没有窗口 2。

---

## 附录：什么时候才需要第 2 个窗口（旧的外部解析服务）

**只有在**你显式关掉了内置解析、希望走外部 Python `parser-service` 时，
才需要下面这个窗口。默认 `.env` 里 `PARSER_SERVICE_URL` 仍指向它，
但**内置解析是优先路径**，解析服务没起也不影响上传。

**前置：** Python 3.9+，且装过 `fastapi` / `uvicorn` / `pymupdf` 等依赖。

```
[窗口 2：解析服务]（可选）
cd C:\path\to\parser-service
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

**成功标志：**

1. 终端出现 `Uvicorn running on http://127.0.0.1:8000`
2. 另开窗口验证：
   ```powershell
   curl.exe -s http://127.0.0.1:8000/health
   ```
   → 返回 `{"status":"ok"}`

**启动顺序（含可选窗口）：**

```
[窗口 2：解析服务]  uvicorn …          ← 可选，先起
        ↓
[窗口 1：主服务]    pnpm start          ← 必需
        ↓
                    浏览器打开 localhost:3000
```

> 若解析服务未起，上传走内置 pdfjs 路径，**功能不受影响** ——
> 这正是问题 6 的修复目标：链路完整、失败有明确提示、不静默。
