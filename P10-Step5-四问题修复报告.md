# P10 Step 5 · 四项修复完成报告

> 承接 Step 3/4。本轮按两个拍板点处理四件事：
> **问题 1（画布重新居中）→ 问题 3（DNA prompt 三层 + 面板说明）→ 问题 2（清空 dev.db + 脚本）**
>
> - 模型：`deepseek/deepseek-flash`（腾讯云 TokenHub 在线推理）
> - 类型检查：`npx tsc --noEmit` 干净
> - 构建：`pnpm build` 通过
> - 回归：**8 个脚本全绿**（见文末汇总）

---

## 拍板点落实情况

| 拍板 | 内容 | 落实 |
|---|---|---|
| **1** | 问题 3 的 UI 占位选 **A**：只画有 block 的阶段，无灰框、无空位 | ✅ 实测画布占位节点 = 0 |
| **2** | 清空 dev.db + 写 `reset-user-data.mjs` | ✅ 删除 8 行，全部归零 |

---

## 问题 1：面板展开后 Block 被顶出视口

### 根因（三个叠加的 bug，缺一不可）

| # | 位置 | 问题 |
|---|---|---|
| ① | `CanvasStage.tsx` `clampOffset` | 纵向夹取分支写 `clamp(desired + y)`，**保留了旧 y 偏移**，视口变矮时只夹取不重新居中 |
| ② | `CanvasStage.tsx` `scale` | 缩放**只按宽度**算（`view.w / contentW`）。宽度够宽时 scale=1，**纵向完全不受约束** |
| ③ | `BottomPanel.tsx` | 面板固定 `38vh`，矮窗口下把画布榨到 268px |

**为什么之前没发现**：RAG 这篇节点包围盒高 **478px**。视口 950 时面板开→画布 510px（`boxH < view.h`，走居中分支，正常）；视口 700 时才跌破 → 切到夹取分支 → 暴露。**用 950 高的视口怎么测都是好的。**

实测旧代码（视口 700）：
```
✗ RAG (Retrieval-augme…)  top = -69   完全在视口上方（超出 124px）
✗ DPR (Dense Passage R…)  top = 14    超出自 55px 边界 41px
```

### 修复

1. **`clampOffset` 增加 `resetY` 语义**：容器尺寸变化时丢弃旧 y、强制重新居中；只有**用户主动拖拽**才保留自定义偏移。
2. **`scale` 同时按宽和高适配**：新增 `ABS_MIN_SCALE = 0.5` 作为纵向硬下限（`MIN_SCALE = 0.8` 仍是横向可读性下限）。
   > 取舍说明：**内容完整性优先于字号**。少一个块会让用户误读方法结构，而字小一点仍可读、且收起面板即可恢复。
3. **面板高度加 `min(38vh, 320px)` 上限**：宽屏保持原观感，矮窗口把空间让给画布。

### 实测证据

`scripts/verify-u2-centering.py` —— 3 种视口高度 × 3 篇论文：

```
── 视口高度 950 ──   RAG ✅  FiD ✅  SelfRAG ✅
── 视口高度 700 ──   RAG ✅  FiD ✅  SelfRAG ✅
── 视口高度 560 ──   RAG ✅  FiD ✅  SelfRAG ✅
结论：全部通过 ✅（共检查 63 个节点位置，0 越界）
```

截图：`p10-evidence/p1-fixed-open-560.png`（560px 矮窗口 + 面板展开，6 个 Block 全在视口内）

---

## 问题 3：DNA 抽取不完整

### 先回答"是模型问题还是 prompt 问题"

**两者都有，主因是 prompt。** 对原文做关键词核查（`rawText` 2601 字符 / 5 页）：

| 阶段 | 原文实际命中 | 模型的说法 | 判定 |
|---|---|---|---|
| 检索器 | `retriev` **20 次** | "原文未描述检索器构成" | ❌ 模型过度保守 |
| 评估 | `em`/`accuracy`/`benchmark` **12 次** | "原文未给出数据集与评估协议" | ❌ 模型过度保守 |
| 训练细节 | 0 次 | "原文未描述损失函数" | ✅ 原文确实没写 |

**prompt 的三处缺陷**：
- ① 第 191 行「拿不准就归 CORE_METHOD」是**泄气阀**，鼓励模型一律塞进核心方法
- ② 没有「逐阶段扫一遍」的要求，只教"给已有 block 归类"
- ③ `uncertainties` 只是文本字段，模型写了但**画布上什么都不显示**

### 三层修改（`method-dna.ts`）

| 层 | 改动 |
|---|---|
| **① 去泄气阀** | 改为「**尽力抽取，不要主动放弃**」：原文提到某阶段就要抽，哪怕只有一句话；CORE_METHOD 仅用于"确实是方法本体组件但无法归类" |
| **② 逐阶段自检** | 新增「输出前的逐阶段自检」，要求逐阶段扫一遍，**并按论文实际覆盖的阶段**（不硬套 7 个）；扫到内容就补 block |
| **③ 两分法标注** | 对每个未成块的阶段必须写清是「**原文未涉及 X 阶段**」还是「**原文提到 X（含引用）但证据不足**」，**不允许什么都不说就跳过** |

同步：
- **`llm-mock.ts`（P3 义务）**：mock 也逐阶段产出同构说明，否则切 mock 时面板说明会缺项
- **`panel.ts`**：新增「未抽取阶段说明」小节

### 实测效果（对同一篇 Self-RAG 重跑真模型）

| | 改动前 | 改动后 |
|---|---|---|
| blocks | **3** | **5** |
| stage 覆盖 | CORE_METHOD, TRAINING | **PROBLEM, CORE_METHOD, TRAINING, EVALUATION** |
| **新增抽出** | — | ✅ **PROBLEM**（固定检索缺陷的问题刻画）<br>✅ **EVALUATION**（评估与消融实验） |

新的 `uncertainties` 严格执行两分法：
```
原文未涉及 INPUT 阶段：没有描述输入数据的形态或来源。
原文未涉及 PREPROCESSING 阶段：没有描述输入如何被切分或编码为特征。
原文提到推理成本可变（p5：'Adaptive retrieval introduces variable inference cost…'），
但未描述具体的推理/解码流程，故未拆分 INFERENCE 阶段的独立 block…
```

### 面板效果（拍板 1 选 A）

```
未抽取阶段说明
以下 3 个阶段没有抽到模块，结构图上不显示：
· 输入：原文未涉及 INPUT 阶段：没有描述输入数据的形态或来源。
· 预处理：原文未涉及 PREPROCESSING 阶段：…
· 推理：原文提到推理成本可变（p5：'…'），但未描述具体的推理/解码流程…
```

画布侧实测：**占位节点 0 个** —— 只画有 block 的阶段，无灰框。

### 顺带修掉一个隐藏 bug

排查中发现面板用 `papers.find(p => p.title === node.title)` 反查论文，
但**库里有同标题的两篇 Self-RAG**（stage 覆盖不同）→ 命中错误的那一篇，
展示的是**另一篇论文**的阶段分布。已改为根节点携带 `refId`（paperId）按 id 精确匹配。

---

## 问题 2：组合想法"又出现预置"

### 结论：不是预置逻辑，是我上次验收留下的真数据

**证据一**：全仓只有一处写 `CandidateIdea`：
```
src/lib/crossbreeder.ts:580   ← 唯一写入点，用户点"组合想法"才执行
scripts/seed-demo.mjs:397     ← 只 count，不创建
```

**证据二**：3 条的 `createdAt` 同为 `2026-09-20T06:59:53Z`（一次批量生成），
`evidenceStatus` 两条 `CONFIRMED`（真模型跨论文证据才有），`why` 是完整四段式推理链
→ **是 Step 4 我跑真链路产出的，并随 `dev.db` 一起打进了 zip**。属于**交付疏漏**。

### 处理

1. **`scripts/reset-user-data.mjs`**（新增）—— 分级清理：

   | 类别 | 表 | 处理 |
   |---|---|---|
   | 演示底座 | Project / Paper / EvidenceRef / MethodDNA / MethodBlock / Relation / ResearchDebt + DebtSource + Attempt | **保留** |
   | 用户动作 | CandidateIdea + CandidateIdeaDebt / Surgery + SurgeryLog / CrashTest | **清除** |

   - 支持 `--dry-run`（只报告）、`--all`（连债务一起清）
   - 清理后**自带断言**：用户动作表必须全部归零，否则退出码 1
   - 挂到 `package.json`：`pnpm reset:user-data`

2. **执行结果**：
   ```
   删除 candidateIdeaDebt 3 行 / candidateIdea 3 行 / surgeryLog 1 行 / surgery 1 行
   共删除 8 行，用户动作表已全部归零 ✅
   冷启动基线：组合想法 0 条、手术 0 条、击穿测试 0 条
   ```

3. **冷启动断言**（`scripts/verify-cold-start.py`）：
   ```
   含「已生成的想法（0）」: True  ✅
   画布 idea 卡片节点数: 0  ✅
   结论：通过 ✅
   ```
   截图 `p10-evidence/p2-cold-start.png`：显示"已生成的想法（0）"+ 空态引导，
   同时演示底座（5 条债务 / 23 个模块）完整保留。

---

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src/components/lab/CanvasStage.tsx` | `clampOffset` 加 `resetY`；`scale` 同时按宽高适配；新增 `V_PAD` |
| `src/lib/lab/layout.ts` | 新增 `ABS_MIN_SCALE = 0.5`；`LayoutNode.refId`；`layoutStructure` 接 `paperId` |
| `src/components/lab/BottomPanel.tsx` | 面板高度 `min(38vh, 320px)` |
| `src/lib/lab/view-layout.ts` | 两处调用传 `paperId`；`structureSkeleton` 带 `refId` |
| `src/lib/method-dna.ts` | prompt 三层修改（去泄气阀 / 逐阶段自检 / 两分法标注） |
| `src/lib/llm-mock.ts` | P3 同步：逐阶段产出同构的未覆盖说明 |
| `src/lib/lab/panel.ts` | 新增「未抽取阶段说明」；按 `refId` 反查论文；notes 匹配支持中英文阶段名 |
| `src/lib/view-models.ts` | `PaperView.uncertainties` |
| `src/app/projects/[pid]/lab/page.tsx` | 带出 `uncertainties` |
| `scripts/reset-user-data.mjs` | **新增**：分级清理用户动作数据 |
| `scripts/verify-u2-centering.py` | **新增**：3 视口 × 3 论文几何断言 |
| `scripts/verify-p3-uncertain.py` | **新增**：面板未抽取阶段说明 + 无占位断言 |
| `scripts/verify-cold-start.py` | **新增**：冷启动「已生成的想法（0）」断言 |
| `scripts/verify-s1-dynamic-stages.py` | 期望列数改为**从库实时计算**，消除硬编码导致的假报失败 |
| `package.json` | 新增 `reset:user-data` |

## 遇到什么问题

1. **`next start` 服务会静默变成"旧构建"** —— 排查中反复出现 `ChunkLoadError`，
   根因是端口 3000 被上一次的 server 占着，新 server `EADDRINUSE` 启动失败，
   浏览器拿到的是旧 chunk。已写 `/tmp/restart-server.sh` 按**端口**找占用进程
   （不用 `pkill -f`，那会误杀自己的 shell）。
2. **同标题论文导致面板张冠李戴** —— 见问题 3 末节，已用 `refId` 修掉。
3. **notes 匹配只认中文阶段名会漏** —— 模型写的是 `EVALUATION`（英文枚举），
   而标签是"评估"，导致所有阶段被误报"原文未涉及"。已改为中英文双匹配。
4. **S1 脚本假报失败** —— 问题 3 的验证重跑了 DNA，那篇论文从 0 blocks 变成 5 blocks，
   而脚本硬编码"期望骨架 1 占位"。已改为从库实时计算期望值。

## 回归汇总（8 个脚本全绿）

| 脚本 | 结果 |
|---|---|
| `verify-u2-centering.py` | ✅ 63 个节点位置，0 越界 |
| `verify-p3-uncertain.py` | ✅ 面板说明 + 0 占位 |
| `verify-cold-start.py` | ✅ 已生成的想法（0） |
| `verify-s1-dynamic-stages.py` | ✅ 4 篇论文列数全部符合 |
| `verify-u3-workflow.cjs` | ✅ 15 / 0 |
| `verify-s3-three-part.cjs` | ✅ 26 / 0 |
| `verify-s5-fourpart.cjs` | ✅ 10 / 0 |
| `verify-s2-block-names.cjs` | ✅ 3 / 0（1 跳过） |

`npx tsc --noEmit` 干净；`pnpm build` 通过。

## 安全

- `.env` 已移除临时验收开关 `ENABLE_PIPELINE_API`（`grep -c` → 0）
- 密钥不落在源码 / 脚本 / 文档里：`grep -rn "sk-" src/ scripts/ *.md` 只应命中占位符（`sk-xxxxxxxx`）
- `.env` 在 `.gitignore` 中
