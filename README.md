# MethodAtlas —— AI 科研方法实验室

> 核心定位：从论文研究成果中提取方法结构，理解当前技术状态，发现长期未解决的问题，辅助研究者探索和验证潜在研究方向。

---

## 🚀 接手方请先看这里（部署 / 提交 / 演示）

| 你要做的事 | 看这份文档 |
|---|---|
| **部署到公网**（含"让 AI 真能用"的关键配置、平台选择、自查清单） | [docs/部署与提交指南.md](docs/部署与提交指南.md) |
| **录 3 分钟 DEMO 视频**（分镜 + 可直接照念的旁白） | [docs/DEMO视频脚本.md](docs/DEMO视频脚本.md) |

**三条最容易踩的坑（详细说明在上面那份部署指南里）**：

1. **不要用 Vercel。** 本项目用 SQLite 单文件 + 单次 AI 分析最长 2–4 分钟，
   Vercel 的临时磁盘会丢数据、函数超时只有 10–60 秒会掐断链路。
   请用**带持久磁盘**的容器平台（Railway / Fly / 自有服务器）。
   仓库已备好 `Dockerfile`，平台会自动识别 Docker 部署。

2. **唯一需要你填的密钥是 `LLM_API_KEY`，填在平台的环境变量界面里**（不要提交 `.env`）。
   另外 `NEXT_PUBLIC_APP_ORIGIN` **必须填**你的公网域名 ——
   漏了它会出现「首页能打开、一点按钮就 `Invalid Server Actions request`」，极难排查。

3. **镜像/包里自带演示数据**（`prisma/seed-demo.db`，8 篇论文的完整流水线结果），
   首次启动会复制到运行时库，所以**评委打开链接立刻有内容**，
   不需要现场跑 20 分钟的抽取流程。

**怎么确认 AI 真的接上了**：跑项目自带的自检（只读、不启服务、不写库）：

```bash
node scripts/llm-check.mjs
```

它拿 `.env` 的配置真实调一次接口并打印结果，退出码 `0` = 连通。
（⚠️ 别用 `/api/llm-status` 判断 —— 它返回的是"调用**失败过**没有"，
**没有 `provider` 字段**，配成 mock 时它同样是 `degraded: false`。）
画布右上角的**「离线模式」徽标**只在真模型**调用失败降级**时出现，
它不覆盖"本来就配成 mock"的情况。

---

## 已完成阶段

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| **P1** | 创建项目 → 上传 PDF → 解析 → Web 查看解析结果 | ✅ |
| **P2** | Method DNA 抽取 → 结构化方法对象 → Evidence 证据链 | ✅ |
| **P3** | Method Surgery（结构化手术）→ Method Evolution（技术演进脉络） | ✅ |
| **P4** | Research Debt（研究债务）→ Crossbreeder（方法组合器）→ Crash Test（撞车测试） | ✅ |
| **P5** | Evidence 强制层 → Evidence Drawer 全局化 → UI 打磨 → 演示数据一键灌入 → 部署配置 | ✅ |

> **完整价值链**：论文 → 方法(Method DNA) → 方法组件(Method Blocks) → 方法演化(Evolution)
> → Research Debt → 方法组合(Crossbreeder) → Candidate Idea → Crash Test

---

## 演示论文库：Wi-Fi 指纹数据增强技术演化链

本项目的示例论文库包含 8 篇关于 Wi-Fi 指纹数据增强的论文，按技术代际排序：

| # | 论文 | 年份 | 技术路线 |
|---|---|---|---|
| 1 | WiFi Fingerprint Augmentation | 2022 | 高斯过程回归（GPR） |
| 2 | GAN Based Data Augmentation | 2021 | GAN + 半监督 |
| 3 | LocGAN | 2023 | 半监督 GAN |
| 4 | CDPM | 2023 | 条件扩散概率模型 |
| 5 | LCVAE-CNN | 2025 | 位置条件 VAE + CNN |
| 6 | WIFIND | 2025 | 空间条件扩散模型 |
| 7 | Semi-Supervised Multi-Task | 2025 | 半监督多任务 Mean-Teacher |
| 8 | Bayesian-Boosted MetaLoc | 2025 | 元学习 + 贝叶斯（极稀疏场景） |

演化链叙事：**GPR（统计补全）→ GAN（对抗生成）→ 扩散模型（高质量生成）→ VAE（条件生成）→ 元学习（极稀疏 / 跨环境）**

> **两点如实说明（不要当成缺陷）**
>
> 1. **第 8 位与前 7 位不是同一条生成式路线。** 原始名单第 8 位写的是
>    「Attentional Graph Meta-Learning（图神经网络 + 元学习）」，但该 PDF 未提供；
>    实际入库的是 **Bayesian-Boosted MetaLoc（元学习 + 贝叶斯）**。
>    它的核心是**跨环境泛化与不确定性估计**，不是数据生成。
> 2. **演化关系不覆盖全部 8 篇。** Evolution 的产品原则是
>    「**没有明确证据就不连边，宁缺毋滥**」（见 `src/lib/method-evolution.ts` 顶部）。
>    实测该模型对这批语料建立 6 条关系，覆盖 6 篇；
>    **GPR 那一篇（传统统计插值）与 MetaLoc 那一篇（贝叶斯元学习）没有被连边** ——
>    因为它们与前 7 篇的**深度生成式**主线之间，模型找不到明确的"谁改进谁"证据。
>    两个未连边的论文**仍会出现在演化视图的时间线里**（时间线画的是全部论文、按年份排序），
>    只是没有连线。这是诚实的行为，不是漏跑。

---

## 快速开始（5 分钟跑通全链路）

> **交付包（zip）用户看这里。** 包里已经带了 `.env` 与初始化好的 `prisma/dev.db`，
> 所以**不需要** `cp .env.example .env`，也**不需要**任何外部解析服务。

```bash
# 0) 前置：Node ≥ 18（推荐 20/22）+ npm

# 1) 进到项目根目录（解压后是多一层 methodatlas/，别停在解压根）
cd methodatlas

# 自检：确认目录对、没有旧版本残留。会直接把下一步该敲什么打出来
node check-dir.mjs

# 2) 安装依赖（lock 文件在包里，用 frozen 保证可复现）
npm ci

# 3) 建库（数据已是最新 schema，这一步主要是生成 Prisma Client）
npm run db:push

# 4) 构建（包里不含 .next，必须先 build）
npm run build

# 5) 启动
npm run start

# 6) 打开 http://localhost:3000/projects
```

> **如果 3000 端口被占用**，用 PowerShell 语法换端口：
> ```powershell
> $env:PORT=3001; npm run start
> ```
> 不要写 `PORT=3001 npm run start` —— 那是 Linux/macOS 语法，PowerShell 不认
> （`run-next.mjs` 就是为了绕开这个平台差异而存在的）。

启动后**根路由 `/` 是 307 重定向**，这是正常的：项目没有首页，直接开
`http://localhost:3000/projects`。

### 可选：验证 LLM 连通（只读，3 秒）

```bash
node scripts/llm-check.mjs
```

直接拿 `.env` 里的配置调一次真实接口，打印 HTTP 状态、耗时、token 用量。
**没有 Key 也能跑通整个链路** —— 此时会自动降级到本地 mock，且页面会如实标注
数据来源（见下文「Mock 与真模型」）。

### 重新灌入演示数据（把 8 篇 Wi-Fi 指纹增强论文跑完整条链路）

```bash
npm run reseed:ips
```

> ⚠️ 这个脚本是早期 IPS 三篇语料时写的，跑它会**回到旧语料**。
> 当前演示库（8 篇 Wi-Fi 指纹数据增强）是用以下命令替换并跑通的：
>
> ```bash
> # 1) 开流水线接口后启动
> $env:ENABLE_PIPELINE_API=1; npm run dev
> # 2) 清空旧库 + 上传 8 篇（含逐篇 DNA 抽取）+ 演化/债务/想法/击穿
> node scripts/_swap-paper-library.mjs --apply
> ```

会删除旧的示例项目，重新上传并解析论文，然后跑
DNA → 演化 → 债务 → 想法 → 击穿。**走的是界面同一条 `/api/upload`**，
在进程内用 pdfjs 解析，**不依赖任何外部服务**。

只想看当前数据是否完整（不写库）：

```bash
npm run reseed:ips:check
```

> **命令行批量跑流水线时需要开 `ENABLE_PIPELINE_API`**（默认关闭）：
> ```powershell
> $env:ENABLE_PIPELINE_API=1; npm run dev
> ```
> 只在界面上点按钮的话不需要开。

---

## 快速开始（从源码开发）

```bash
# 0) 前置：Node ≥ 18（推荐 20/22）+ npm

# 1) 安装依赖
cd methodatlas && npm install

# 2) 配置环境（零配置即可跑通，无需任何 API Key）
cp .env.example .env

# 3) 建库
npm run db:push

# 4) 启动
ENABLE_PIPELINE_API=1 npm run dev        # PowerShell: $env:ENABLE_PIPELINE_API=1; npm run dev

# 5) 重新灌入演示数据
npm run reseed:ips

# 6) 打开 http://localhost:3000/projects
```

> `npm run reseed:ips` 会**真实调用**上传与流水线链路，跑完
> 论文 → Method DNA → 演化关系 → 研究债务 → 候选方案 → 撞车测试，
> 最后打印一份数据体检表。它不写假数据 —— 所以「reseed 成功」等价于「流水线可用」。

> **历史遗留**：`npm run seed`（`scripts/seed-demo.mjs`）是更早的 RAG 三篇演示路径，
> 它依赖一个独立的 Python 解析服务（`parser-service/`，8000 端口），
> **该目录未随包交付**。日常请用 `npm run reseed:ips`。

---

## 目录结构

```
/workspace
├── methodatlas/                    # Next.js 14 全栈应用
│   ├── prisma/schema.prisma        # 数据模型（13 张表）
│   ├── scripts/seed-demo.mjs       # 演示数据一键灌入（P5）
│   ├── src/app/                    # 页面与 Server Actions
│   │   └── api/pipeline/           # 流水线驱动接口（供 seed 用，默认关闭）
│   ├── src/components/             # 积木卡片 / 证据徽章 / 证据抽屉 / 空状态
│   ├── src/lib/
│   │   ├── llm.ts                  # 统一 LLM Provider（不绑定具体模型）
│   │   ├── llm-mock.ts             # 演示模式 provider（无需 API Key）
│   │   ├── method-dna.ts           # Method DNA 抽取服务
│   │   ├── method-surgery.ts       # Method Surgery 结构化手术分析
│   │   ├── method-evolution.ts     # Method Evolution 演化关系梳理
│   │   ├── research-debt.ts        # Research Debt 跨论文局限聚类（P4）
│   │   ├── crossbreeder.ts         # Crossbreeder 跨论文方法组合（P4）
│   │   ├── crash-test.ts           # Crash Test 对抗性验证（P4）
│   │   ├── actions/lab-actions.ts  # Surgery / Evolution 的 Server Actions
│   │   ├── actions/p4-actions.ts   # Debt / Crossbreed / CrashTest 的 Server Actions
│   │   ├── evidence.ts             # Evidence 四规则 + 统一强制层（P5）
│   │   ├── evidence-view.ts        # 证据视图工具函数（P5）
│   │   └── enums.ts                # 枚举常量与 JSON 工具
│   ├── .env.example                # 环境变量模板（含部署注意事项）
│   └── README.md                   # ← 本文件
├── sample-papers/                  # 演示用 PDF（IPS 三篇 + 早期 RAG 三篇）
└── MethodAtlas_Phase1_Plan.md      # 技术方案文档
```

> `parser-service/`（Python PDF 解析服务）是**早期版本的遗留**，未随包交付。
> 当前上传链路 `/api/upload → src/lib/pdf-parse.ts` 在 **Node 进程内**用 pdfjs 解析，
> **不依赖任何外部服务**。只有历史脚本 `npm run seed` 仍指向它。

## 环境要求

- Node.js ≥ 18（推荐 20/22）+ npm（Node 自带）
- 无需 Python、无需 Docker、无需外部数据库（SQLite 本地文件）

> ⚠️ **本项目统一用 npm，不用 pnpm。** 实测 pnpm 在本机 Node 24 上会
> `thread '<unknown>' has overflowed its stack` 崩掉。交付包带的是
> `package-lock.json`，按上面的 `npm install` / `npm ci` 走即可。
> （历史文档里出现过 `pnpm` 命令，都已改成等价的 npm 写法。）

## 单进程即可运行

整个应用只需要**一个** Next.js 进程，PDF 解析在进程内完成，不需要另起服务。
启动步骤见上方「快速开始」，此处不重复。

（早期版本需要额外起一个 Python 解析服务；该依赖已随 `/api/upload` 的改造移除。）

### 试用完整链路

> **最快路径**：跑 `npm run reseed:ips`，IPS 三篇 + 全链路数据直接到位，跳过下面手动步骤。

手动路径（想自己点一遍时）：

1. 打开 `http://localhost:3000`
2. 创建项目（如「RAG 方法梳理」）
3. 上传 PDF（可用 `sample-papers/` 下的样例）
4. 状态变为「已解析」后，点卡片下方 **「抽取方法结构」**
5. 在 Method DNA 页点 **「抽取 Method DNA」**
6. 查看结构化方法对象 + 点证据徽章打开证据抽屉回溯原文
7. 点 **「进入方法手术台」** —— 选一个模块、选操作、填意图，得到影响分析
8. 上传 2 篇以上论文并抽取 DNA 后，在项目页进入 **「技术演进脉络」** 梳理关系
9. 进入 **「研究债务」** —— 把跨论文的局限聚合成领域长期未解决问题
10. 进入 **「方法组合器」** —— 跨论文重组模块生成候选方案，并逐个做 **「撞车测试」**

> **想要立即可演示的演化数据**：`npm run reseed:ips`（详见「演示数据」章节）。

---

## LLM 配置（P2 核心）

**设计原则：不绑定任何具体模型。** 换 provider / 模型只改环境变量，代码零改动。

默认 `LLM_PROVIDER=mock`，**无需 API Key 即可跑通全链路**，用于演示和测试。
Mock 模式会在界面上显示「演示模式 · 未接入真实模型」的显著提示，且整体证据强度
强制降级为「证据有限」，避免把启发式结果误认为模型产出。

启用真实模型（在 `methodatlas/.env` 中配置，或复制 `.env.example` 为 `.env.local`）：

```bash
LLM_PROVIDER=openai-compatible
LLM_MODEL=gpt-4o-mini          # 换成任意模型名
LLM_API_KEY=sk-xxxxxxxx
LLM_BASE_URL=https://api.openai.com/v1
```

已验证的兼容端点（任何实现 OpenAI `/chat/completions` 协议的服务都可用）：

| 服务 | LLM_BASE_URL | 示例模型 |
| --- | --- | --- |
| DeepSeek 开放平台（官方直连） | `https://api.deepseek.com/v1` | `deepseek-chat`、`deepseek-reasoner` |
| 腾讯云 TokenHub（在线推理） | `https://tokenhub.tencentmaas.com/v1` | `deepseek/deepseek-flash`、`hy3` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 本地 Ollama | `http://localhost:11434/v1` | `qwen2.5:14b` |

> ⚠️ **模型名的写法跟着端点走，不能混用**：
> DeepSeek 官方端点用**不带命名空间**的 `deepseek-chat`；
> 腾讯 TokenHub 用**带命名空间**的 `deepseek/deepseek-flash`。
> 把 A 家的模型名填给 B 家的端点会直接报错（400 或 401），这一点排查时最容易踩。

> ⚠️ **`LLM_PROVIDER` 只接受 `mock` 与 `openai-compatible` 两个值。**
> 写 `deepseek`、`hunyuan` 这类"看起来更直白"的值会**直接抛 CONFIG 错误**——
> 这是刻意的：早期版本会把无法识别的值静默当成 mock，导致"以为接了真模型，
> 其实一直在用本地启发式数据"，而且日志里毫无痕迹。接入任何 OpenAI 兼容服务
> 都填 `openai-compatible`，由 `LLM_BASE_URL` 区分。

> ⚠️ **真模型调用失败会自动降级到 mock**，保证页面可用不致崩溃。
> 降级期间画布左上角显示琥珀色「离线模式」徽标，正常调用时徽标不出现，
> 服务端日志也会打印降级原因。当前会话的 token 消耗可通过
> `GET /api/llm-status` 查询。

配置后重新点「重新抽取 Method DNA」即可获得真实分析结果。

---

## Method DNA 抽取了什么

| 字段 | 含义 |
| --- | --- |
| **Task** | 该论文要解决的任务 |
| **Problem** | 针对的核心问题 |
| **Core Mechanism** | 核心机制 |
| **Method Blocks** | 方法的模块化拆分（12 种类型：编码器 / 解码器 / 注意力 / 损失 / 正则化 / 采样 / 预训练 / 微调 / 数据增强 / 整体架构 / 后处理 / 其他） |
| **Training / Inference** | 训练与推理策略 |
| **Computational Cost** | 计算成本 |
| **Limitations** | 论文自述的局限性（Research Debt 的原始素材） |
| **Uncertainties** | 因原文未说明而留空的字段清单 |

页面上 **Method Blocks 是积木卡片**（按类型着色，低饱和科研色板），可直接点击
「查看证据」回溯到原文 —— 每一块都可以被理解、比较，为后续的 Surgery 与
Crossbreeder 做准备。

---

## Evidence Chain（可信度地基）

项目硬约束：**任何 AI 生成的事实、关系、判断、推断都必须能关联 Evidence；
证据不足必须显式标记，禁止编造。**

实现方式：

1. **抽取时强制关联** —— Prompt 要求每个字段都带 `evidence` 数组（原文 quote + 页码 + 章节）
2. **原文核对** —— 抽取出的 quote 会与 PDF 原文做归一化匹配
   - 匹配通过 → `CONFIRMED`，置信度 95%（mock 模式 60%）
   - 匹配失败 → `UNCERTAIN`，置信度 50%（mock 模式 30%），留作人工复核
3. **落库校验**（`src/lib/evidence.ts`）
   - **R1** — 对象必须至少有 1 条证据，否则拒绝写入
   - **R2** — 不得引用 `INSUFFICIENT` 的证据
   - **R3** — 对象自身证据强度不能是 `INSUFFICIENT`
   - **R4** — 引用的证据 id 必须真实存在
4. **界面呈现** —— 每个结论旁有 📎 徽章（📌 论文事实 / 🔗 多论文综合 / 💭 模型推断），点击打开证据抽屉查看原文片段、页码、章节、置信度
5. **无证据时** —— 显示虚线边框的「原文未提供支撑证据」占位，并汇总到「证据不足说明」区块

**没有任何证据的抽取结果会直接抛错并拒绝写入数据库。**

---

## Method Surgery（P3）—— 结构化模拟分析，不是实验

对一个方法做「手术」：从 Method DNA 中取下一个模块（Remove / Disable / Replace），
推演会发生什么。**这是一个纯分析工具，不训练模型、不运行实验。**

页面顶部有明确的定位声明：

> 这不是实验，是结构化模拟分析。系统不会重新训练模型，也不会运行任何实验。
> 你选择的模块会被从方法结构中「取下」，系统基于论文中已有的证据，推演可能的影响、
> 检索是否有对应的消融实验，并给出判定。**当论文里找不到证据时，判定会明确落在
>「证据不足」，而不是编一个听起来合理的后果。**

手术结果包含：

| 字段 | 说明 |
| --- | --- |
| **判定（Verdict）** | `PLAUSIBLE` / `RISKY` / `INFEASIBLE` / `INSUFFICIENT_EVIDENCE` |
| **模块作用** | 该模块在原方法中承担什么（带证据） |
| **失去的能力** | 移除后方法不再具备什么 |
| **预期影响** | 逐条影响 + 严重度（无 / 轻微 / 中等 / 严重 / 致命）+ 各自的证据 |
| **消融实验证据** | 论文中是否有直接相关的消融数据；没有就明说「不是没有影响，而是不知道」 |
| **依赖链风险** | 是否有其他模块依赖被操作的模块 |
| **不确定性** | 因证据不足而无法判定的点 |

**判定降级规则**：只要缺少直接消融证据，判定就不会是 `PLAUSIBLE`，而是
`INSUFFICIENT_EVIDENCE`。宁可说「不知道」，不说「应该没事」。

---

## Method Evolution（P3）—— 技术演进脉络

在已抽取 Method DNA 的论文之间梳理真实的继承 / 改进 / 替换 / 分支 / 组合关系。
这是比赛「技术演进梳理」要求的直接落点，也是各能力之间的连接器。

**核心原则：宁缺毋滥。**

> 只有论文原文中有明确线索（如「we build upon X」「unlike X, we…」）时，系统才会建立
> 一条关系；置信度低于 0.5 的候选会被直接丢弃。同属一个领域、同样用了 Transformer，
> **不构成**演化关系。如果梳理结果是一条边都没有，那说明证据不支持 —— 这同样是一个有效结论。

实现上的关键约束：

- **方向固定由早到晚** —— 即使模型返回了倒流的边（把 2023 指向 2020），也会被纠正
- **每篇论文最多一条上游关系** —— 取线索最强的那一篇，避免织出一张毫无信息量的网
- **必须标题特征词与线索词共现** —— 防止把 A 论文的句子误当成 B 论文的证据
- **同一对论文去重** —— 一对论文之间只保留一条关系

页面提供：

- **拓扑排序的演进时间轴** —— 入度为 0 的先出，同层按年份，带上游/下游关系徽章
- **关系详情卡片** —— 理由、置信度、证据回溯，以及**人工确认 / 否决并删除**
  （人工确认会跳过模型自评，直接置为已确认）

---


LLM 输出不稳定是这类系统最大的工程风险。本项目做了三层防护：

1. **JSON Schema 校验**（`src/lib/llm.ts` 的 `validateShape`）—— 字段缺失、类型错误、字符串过短都会被拦下
2. **失败自动重试 + 错误回灌** —— 把校验错误作为新消息发回模型，要求它按结构重新输出（默认最多 3 次）
3. **绝不静默兜底** —— 3 次仍不合格则抛错，不写入任何数据

已用模拟端点验证：第一次返回缺字段的结构被拒绝，第二次重试成功落库。

---

## Research Debt（P4）—— 把「局限」升级成「领域欠下的债」

一篇论文自述的局限，是**这篇论文**的缺点。若同一类问题被不同年份的多篇论文
反复提到、跨年未解决，它就不再是某一篇的缺点，而是这个领域长期欠下的债。

所以这一步做的不是「提取局限性列表」，而是**跨论文聚类**：
把 N 篇论文各自提到的局限，归并成 M 个（M ≪ N）长期未解决问题。

| 字段 | 说明 |
| --- | --- |
| **category** | 泛化性 / 计算成本 / 数据 / 可解释性 / 鲁棒性 / 评测方法 / 理论保证 / 其他 |
| **occurrenceCount** | 有几篇论文提到了它（真实计数，不拍脑袋） |
| **sources（DebtSource）** | 每篇论文各自**怎么描述**这个问题，各自带证据 |
| **attempts（Attempt）** | 谁尝试解决过、结果如何（成功 / 部分成功 / 失败 / 引入新问题） |
| **currentStatus** | 这条债务目前的状态 |

**单篇论文的局限不会被算作领域债务** —— 它还不够格。页面上两类分开计数
（「跨论文领域债务」与「单篇论文局限」），避免把一篇论文的缺点夸大成领域问题。

> 「一个被反复尝试却始终没解决好的问题，才是最值得关注的债务。」

这一步之所以关键：**它是候选方案的合法性来源**。Candidate Idea 必须建立在
Research Debt 之上，否则所谓的研究方向推导就只是让模型自由发挥。

---

## Crossbreeder（P4）—— 方法组合器，以及它拒绝做什么

把**不同论文**的 Method Blocks 重新组合，生成候选方案。
素材只有三样：方法模块 · 研究债务 · 原文证据。

「随便组合两个模块」能生成无穷多个听起来像那么回事的 idea，
所以系统设了三道**强制关卡**，任何一关不过就直接丢弃：

| 关卡 | 检查内容 | 否则 |
| --- | --- | --- |
| **1. 模块必须跨论文** | 两个模块若来自同一篇论文，那不是组合，是把作者自己的东西换个说法 | 丢弃 |
| **2. 必须关联债务并说清 why** | 说不出「用这个补上那个缺口」的，是套话（正则识别"可以提高性能"类表述） | 丢弃 |
| **3. 证据必须能在原文中核对上** | 核对不上的证据等于没有证据 | 丢弃 |

被拦下的候选**会如实显示计数与原因** —— 系统真的在把关，这本身是可见的。

> **宁可产出 0 个候选，也不要产出漂亮的空话。0 是一个可接受的、诚实的答案。**

---

## Crash Test（P4）—— 唯一一个设计目标是「否定」的模块

前面的模块都在「生成」东西。如果最后一环还在生成，整个系统就变成了一个 idea
制造机 —— 而研究者最不缺的就是方向，真正稀缺的是**知道哪个方向不值得走**。

四项**对抗性检验**，每一项的目标都是找问题，不是找优点：

| 检验 | 在找什么 |
| --- | --- |
| **noveltyCheck** | 这个想法是不是早就有人做过了？ |
| **blockConflictCheck** | 被组合的模块，机制上是不是互相打架？ |
| **dataRequirement** | 它需要的数据真的存在、真的拿得到吗？ |
| **computeRequirement** | 它需要多少算力？做得到吗？ |

每项给出 `PASS` / `CONCERN` / `BLOCKER` 三档，综合判定包含两个**否定性结论**：

- `LIKELY_EXISTS` —— 很可能已被做过（最常见的否定）
- `INFEASIBLE` —— 不可行

**判定规则**：只要出现任意一个 `BLOCKER`，判定就不能是 `PROMISING`；
新颖性检验出现 `BLOCKER` 时会直接落到 `LIKELY_EXISTS`。

> **没有找到反证，不等于想法成立。** 证据不足以判断时，判定落在「证据不足」，
> 而不是乐观地给「有前景」。**未被否决 ≠ 可行。**

---

## 已知局限（如实告知）

### P1 遗留

1. **PDF 元数据是启发式提取** —— 标题取 PDF 内置 metadata 或首页首行；年份优先取正文前两页出现的年份，取不到才退回 PDF 创建年份（PDF 创建时间常被导出工具改写成当天，所以优先级放在后面）
2. **扫描件 PDF（无文本层）解析失败**，状态标记为「解析失败」
3. **解析是同步等待**，超大 PDF 会慢

### P2 新增

4. **演示模式（mock）的抽取质量有限** —— mock 用关键词 + 句子筛选做启发式抽取，能验证链路通畅，但**不具备语义理解能力**。可能出现 Block 描述不够精准、部分模块因证据去重被跳过。真实质量需配置 `LLM_API_KEY` 后获得
5. **长论文会截断** —— 正文超过 24000 字符时只取前部分参与抽取（Prompt 中已明确告知模型）
6. **证据原文核对是字符串匹配** —— PDF 解析产生的断行、连字符会让部分真实引用匹配失败，被降级为 `UNCERTAIN`（保守处理，不会误标为高可信）
7. **页码以 PDF 解析结果为准**，与论文印刷页码可能有偏移

### P3 新增

8. **Surgery 在演示模式下几乎总是「证据不足」** —— 这是刻意设计，不是缺陷。mock 不具备因果推理能力，不会编造后果，所以判定会保守地落在 `INSUFFICIENT_EVIDENCE`
9. **Evolution 在演示模式下可能产出零条关系** —— 同样刻意保守：只有线索词与前序论文标题特征词共现才连边。没有边是有效结论，不是失败
10. **章节标注是启发式的** —— 解析器按章节标题切分段落，标题不规范的 PDF 可能识别失败，此时抽取会退回单句关键词猜测章节

### P4 新增

11. **演示模式下 Research Debt 靠关键词归类，不做语义合并** —— 只有被 ≥ 2 篇论文命中的类目才会输出，且**不会编造「尝试解决」的记录**（这需要真实语义判断）。同一问题在不同论文里的不同说法，mock 无法识别为同一件事
12. **演示模式下 Crash Test 的四项检验全部是「需关注」** —— 因为 mock 没有检索与机制推理能力，它诚实地写「这不代表没问题，只代表没查」，而不是假装找到了问题。判定统一降级为 `INSUFFICIENT_EVIDENCE`
13. **演示模式下 Crossbreeder 的 why 是模板化推断** —— 只保证「模块跨论文 + 关联债务 + 证据可核对」三条结构约束成立，内容合理性需人工判断
14. **Crash Test 的新颖性检索范围仅限项目内论文** —— 它不是文献检索系统，只能回答「我手上这几篇里有没有做过」。真正的查新仍需外部数据库

### P5 新增

15. **Crash Test 是 Evidence 强制层唯一被豁免的写入路径** —— 这一点必须说清楚，否则会被误读为「规则有漏洞」。

    统一强制层（`guardEvidenceWrite` / `assertEvidencePolicy`）要求：任何落库的科研对象，其自身证据强度不能是 `INSUFFICIENT`。
    其余 8 个写入路径（Method DNA / Method Block / Surgery / Relation / Research Debt / Candidate Idea / 等）**全部受此约束**，
    且已通过正反两组实测：合法数据放行、混入 `INSUFFICIENT` 必被拦下。

    唯独 Crash Test 例外。原因是 `INSUFFICIENT` 对 Crash Test 而言是**合法终态**而非缺陷：

    > Crash Test 的职责是「尝试否定一个想法」。当项目内论文不足以判断新颖性 / 可行性时，
    > 它的正确行为是明确回答「**我查不到，所以我不下结论**」，而不是随便给一个倾向性判定。
    > 这个「查不到」以 `INSUFFICIENT_EVIDENCE` 落库，是**证据不足这一结论本身的记录**，
    > 不是「一个证据不足的结论」—— 两者含义正好相反。

    若强行套用 R3 规则，会导致「敢于承认查不到」的诚实判定反而无法保存，只剩「随便给个结论」才能落库 —— 那是**把设计逼向说谎**。
    因此 `crashTestAction` 刻意不做该体检，并在 `src/lib/evidence.ts` 模块注释、`guardEvidenceWrite` 文档、`crashTestAction` 三处写明原因。

16. **演示数据灌入依赖一个默认关闭的接口** —— `scripts/seed-demo.mjs` 通过 `/api/pipeline` 驱动流水线（这样才是走真实服务层而非伪造数据）。该接口**无鉴权**，默认关闭，需显式设置 `ENABLE_PIPELINE_API=1` 才可用。请勿在公网部署中开启。

17. **上传上限是 50MB** —— 由 `next.config.mjs` 的 `serverActions.bodySizeLimit` 控制。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| Web | Next.js 14 (App Router) + TypeScript + Tailwind CSS |
| ORM / DB | Prisma 5 + SQLite |
| PDF 解析 | FastAPI + pdfplumber + PyMuPDF |
| LLM | 统一 Provider 接口，可选 `mock` / `openai-compatible`，**不绑定具体模型** |
| UI | 积木风格卡片（80%）+ 拼图缺角隐喻（20%，预留给 Research Debt） |
| 图论 | 自实现拓扑排序（Kahn 算法）绘制演进脉络，无额外依赖 |
| 跨论文聚类 | Research Debt 按类目聚类 + 真实计数，不引入向量库（避免过度工程） |

---

## P5 —— 可信度收口与可交付性

P5 没有增加新功能，做的是三件"让已有能力真正立得住"的事。

### ① Evidence 统一强制层

**问题**：P1–P4 各服务层**各自**做证据筛选，规则分散在多处。随着写入路径增至 9 条，
"某个新路径忘了校验"变成迟早会发生的事 —— 而这类疏漏的代价是**一条不可追溯的科研结论进了库**。

**解决**：把校验收成两层，放在 `src/lib/evidence.ts`：

| 层 | 函数 | 时机 | 检查 |
| --- | --- | --- | --- |
| 不变量 | `guardEvidenceWrite` | 落库后（各 Service 内） | R3：对象自身证据强度非 `INSUFFICIENT` |
| 全量 | `assertEvidencePolicy` | 需要完整校验时 | R1 证据非空 / R2 引用非 INSUFFICIENT / R3 对象自身非 INSUFFICIENT / R4 引用 id 真实存在 |

**为什么是"落库后复查"而不是"写入前拦截"**：
Service 在事务里边生成边写入，**写入前拿不到最终状态**（比如一条关系要等所有证据都落完才知道整体强度）。
所以强制层的定位是"落库后体检"，发现问题即抛 `EvidencePolicyError`。

**验证**（一个只"从不报错"的校验等于没有校验，所以做了正反两组）：

```
正向：5 个 Server Action 全部跑通，nonCrashTestInsufficient = 0
       evolution / surgery / debt / crossbreed 均正常写入，无一条被误拦
反向：✓ 全部合法（CONFIRMED / UNCERTAIN）→ 期望应通过 → 已通过
       ✓ 空数组                        → 期望应通过 → 已通过
       ✓ 单条 INSUFFICIENT             → 期望应抛错 → 已抛错（R3_OBJECT_INSUFFICIENT）
       ✓ 合法中混入一条 INSUFFICIENT    → 期望应抛错 → 已抛错（R3_OBJECT_INSUFFICIENT）
```

> Crash Test 是唯一豁免路径，原因见「已知局限 #15」。

### ② Evidence Drawer 全局化

**问题**：P4 最大的缺口是"**声称可追溯，但实际点不开**"。
Research Debt 页展示了各论文的局限原文，但那些片段是**静态文本**，用户无法看到它出自哪篇、哪页、哪一节。

**解决**：

- 新增 `src/lib/evidence-view.ts`，把 `EvidenceItem` 类型下沉到 lib 层（Server Component 需要 import 它），
  并收敛原先散落 5 处的 `evidenceId → EvidenceItem` 映射
- 新增 `EvidenceTrigger`（单一按钮）与 `EvidenceSummary`（"N 条 + 前几条摘录"），
  把「展示哪些证据」与「按钮长什么样」解耦
- 8 个页面全部接入，无证据时降级渲染 `NoEvidenceHint` 而**不静默留白**

**效果**：Research Debt 页点开抽屉后能看到 3 条证据，分别来自 RAG 2020 / FiD 2020 / Self-RAG 2023，
各自带页码、章节与原文引用 —— **原先不可点击的静态片段现在真的能回溯了**。

### ③ 三态空状态

新增 `EmptyState` 组件，用 `tone` 区分三类语义：

| tone | 含义 | 视觉 |
| --- | --- | --- |
| `idle` | 还没开始做 | 中性灰 + 虚线 |
| `empty` | 做了，但没有结果 | 蓝色（强调"这是一个有效结论"） |
| `blocked` | 前置条件不满足 | 琥珀色 + 虚线 + 提示缺什么 |

这个区分本身就是产品态度的一部分：

> **本系统里「没有结果」是一个正当结论，不应该被渲染成失败。**

---

## 演示数据

### 一键灌入（当前推荐）

```bash
npm run reseed:ips       # 需要应用已在 3000 端口运行
```

会删掉旧的示例项目，重新上传并解析 IPS 三篇论文，然后跑完
DNA → 演化 → 债务 → 想法 → 击穿。走的是界面同一条 `/api/upload`。

| 命令 | 行为 |
| --- | --- |
| `npm run reseed:ips` | 幂等重灌。删旧示例项目后重新上传 + 跑全链路 |
| `npm run reseed:ips:check` | 只体检现有数据，不写入 |

灌入结果（演示模式 / 无需 API Key）：

```
✓ 论文                3      （IPS 三篇：CPD-PDR 2024 / WiFi-Aug 2022 / Pazl 2013）
✓ 方法结构             3
✓ 方法模块            39
✓ 演化关系             3
✓ 研究债务             4
✓ 债务来源             7
✓ 组合想法             3
✓ 击穿测试             3
```

### 历史命令：`npm run seed`（RAG 三篇，需 Python 解析服务）

| 命令 | 行为 |
| --- | --- |
| `npm run seed` | 幂等灌入。项目已存在则跳过，只做体检 |
| `npm run seed:reset` | 先删旧项目（含 PDF 存储目录）再重灌 |
| `npm run seed:check` | 只体检现有数据，不写入 |

> ⚠️ 这三个命令走的是**早期的 RAG 三篇**路径，且需要另起
> `parser-service/`（Python，8000 端口）—— **该目录未随包交付**。
> 未起服务时 `npm run seed` 会直接失败并提示「解析服务不可达」。
> 请改用 `npm run reseed:ips`。

### 为什么这是"真"灌入

脚本走的路径是：

```
读 PDF → 调解析服务 /parse → 写 Paper
       → 调 /api/pipeline 的 dna       → 服务层 extractMethodDNA
       → 调 surgery / evolution / debt / crossbreed / crashtest
```

即**调用与 UI 完全相同的服务函数**，而不是直接 INSERT 数据库。
因此"seed 成功"等价于"流水线真的可用"，而不是"数据库里有几行"。
反过来，任何一步失败都会如实报错并停止，**不会伪造数据让体检表看起来漂亮**。

> 脚本在前置条件不满足时（解析服务没起、流水线接口没开、样例 PDF 缺失）
> 会明确告知缺什么、怎么启动，而不是抛一个栈。

---

## 部署

### 单进程

| 进程 | 默认端口 | 启动 |
| --- | --- | --- |
| Web（Next.js） | 3000 | `npm run build && npm run start` |

**本项目不依赖 Docker**，也不需要外部数据库 —— SQLite 是本地文件。
PDF 解析在 Web 进程内完成（`src/lib/pdf-parse.ts`，pdfjs），**不需要额外的解析服务**。

### 三个必须注意的坑

#### 坑 1：SQLite 相对路径

`DATABASE_URL="file:./dev.db"` 是**相对于 `prisma/schema.prisma` 所在目录**解析的，
实际指向 `<项目根>/prisma/dev.db`，而不是 `<项目根>/dev.db`。

由此带来的典型故障：换目录启动后看不到数据，表现为"表不存在"或空列表 ——
**看起来像数据丢了，其实只是找错了地方**。

> **固定部署请改用绝对路径**：
> ```
> DATABASE_URL="file:/var/lib/methodatlas/dev.db"
> ```
> 构建时若检测到相对路径，控制台会打印一条提示。

#### 坑 2：上传大小上限需两侧一致

上传上限由 `next.config.mjs` 的 `serverActions.bodySizeLimit` 控制（当前 50MB）。
超限时 `/api/upload` 返回 413 并提示如何调整。

> 早期版本还有一个独立的 Python 解析服务，有 `PARSER_HOST` /
> `PARSER_ALLOW_ORIGINS` / `PARSER_MAX_UPLOAD_MB` 三个环境变量。
> **该服务已不再参与运行时链路**（解析已移入 Next 进程内），
> `.env` 里的 `PARSER_SERVICE_URL` 现在只被历史脚本 `npm run seed` 使用。

#### 坑 3：`/api/pipeline` 默认关闭

演示数据接口默认关闭，需显式 `ENABLE_PIPELINE_API=1`。
它**没有鉴权**，能触发模型调用与数据写入 —— **公网部署请勿开启**。
开启时构建会打印警告。

### 生产环境检查清单

- [ ] `DATABASE_URL` 改为绝对路径
- [ ] **不要**设置 `ENABLE_PIPELINE_API`
- [ ] 配置真实 `LLM_PROVIDER` / `LLM_API_KEY`（mock 仅用于演示）
- [ ] SQLite 单文件写入并发有限；多用户场景请评估迁移到 Postgres（`schema.prisma` 的 `provider` 一改即可，应用层已用 TS 常量代替原生 enum，迁移成本可控）

---

## 试用完整价值链（不想跑 reseed 时的手动路径）

```bash
# 1) 用 sample-papers/ 下的 IPS 三篇（已随包提供）
# 2) 依次上传到同一个项目，每篇都点「抽取方法结构」
# 3) 进入「技术演进脉络」→ 梳理演化关系
# 4) 进入「研究债务」→ 识别研究债务（跨论文局限聚类）
# 5) 进入「方法组合器」→ 生成候选方案 → 逐个做「撞车测试」
```

走完之后你会看到：三篇论文的同类局限被合并成**一条**跨论文债务、
两三个跨论文组合候选、以及对每个候选的**对抗性检验报告**。
演示模式下这些结论会统一标注为「证据有限 / 证据不足」—— 这是诚实，不是失败。

---

## 交付验证记录（P5）

以下验证均在本仓库实际执行过，不是"设计上应该可以"。

### ① 从空库一键灌演示数据

```
$ rm prisma/dev.db && npm run db:push && npm run reseed:ips
✓ 论文 3 · 方法结构 3 · 方法模块 39 · 演化关系 3
✓ 研究债务 4（跨论文） · 组合想法 3 · 击穿测试 3
✓ 全链路数据齐备，可直接演示
```
幂等重跑计数不变；`--reset` 会连 PDF 存储目录一并清理（不会留下孤儿目录）。

### ② 全链路页面与证据抽屉

9 个页面全部 HTTP 200，控制台零错误；6 处证据入口均可点开抽屉，
抽屉内每条证据带来源论文、页码、章节与原文引用。

### ③ 证据强制层（正反两面）

```
模型                 INSUFFICIENT   总数
MethodDNA              0        3
MethodBlock            0       13
Surgery                0        1
Relation               0        2
ResearchDebt           0        1
CandidateIdea          0        2
CrashTest              2        2  (豁免)
EvidenceRef            0       43
✓ 除 CrashTest 外无 INSUFFICIENT 记录 —— 统一强制层生效
```

反向用例（单条 `INSUFFICIENT` 混入合法数据）确认会被拦下并抛 `R3_OBJECT_INSUFFICIENT` ——
**一个只"从不报错"的校验等于没有校验。**

### ④ 交付包可在全新环境跑起来

把打包出的 zip 解压到空目录，**包里已带 `.env` 与初始化好的 `prisma/dev.db`**，
所以只需：

```
cd methodatlas
node check-dir.mjs
npm ci
npm run db:push
npm run build
npm run start
```

即可构建成功并跑通全链路（无需 `cp .env.example .env`，也无需任何 Python 解析服务）。

### ⑤ 部署风险已实测

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| 上传大小限制 | 提交 60MB PDF | `413`，提示上限 50MB 及如何调整 |
| CORS 收紧 | 从恶意来源发 OPTIONS | 不回显允许头 |
| CORS 正常来源 | 从 `localhost:3000` 发 | 正常放行 |
| 演示接口默认关闭 | 不带环境变量访问 | `403` + 如何开启的说明 |
