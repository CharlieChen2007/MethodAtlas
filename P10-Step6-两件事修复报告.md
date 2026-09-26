# P10 Step6 修复报告 —— 底部面板越界 + 内置论文替换为 IPS 三篇

> 本轮两件事一起做，均已完成并通过实测验收。
> 报告按约定格式给出：**改了哪些文件 / 实测证据（截图或输出）/ 遇到什么问题**。

---

## 一、结论速览

| 验收项 | 要求 | 实测结果 |
| --- | --- | --- |
| ① 面板不遮挡工具栏 | Playwright 测量零重叠 | ✅ 3/3 视口，`面板右 - 工具栏左 = -10.00px`，水平重叠 **0.00** |
| ② 三篇 IPS 全部解析成功 | 各有完整 DNA | ✅ 12 / 13 / 14 blocks，60 / 53 / 64 证据，**7 个阶段全覆盖** |
| ③ 演化页按「问题」组织 | 三篇形成清晰演化链 | ✅ 4 张问题卡片 + 3 条关系构成 Pazl(2013) → WiFi-Aug(2022) → CPD-PDR(2024) |
| ④ 债务/想法/击穿都有数据 | 均 > 0 | ✅ 债务 4 / 想法 3 / 击穿 3 |
| ⑤ 冷启动「已生成的想法（0）」 | 交付快照干净 | ✅ `prepack` 已挂 `reset-user-data.mjs`，快照非用户动作数据 |
| 附带 | RAG 三篇及其派生数据全清 | ✅ `RAG 残留 = 0` |

**链末状态**（跑完全链路、归零之前）：论文 3 ｜ DNA 3 ｜ 模块 39 ｜ 演化关系 3 ｜ 债务 4 ｜ 想法 3 ｜ 击穿 3 ｜ 手术 0 ｜ **RAG 残留 0**。

**交付快照状态**（`reset-user-data` 之后，即 zip 里的 `dev.db`）：论文 3 ｜ DNA 3 ｜ 模块 39 ｜ 证据 211 ｜ 演化关系 3 ｜ 债务 4 ｜ **想法 0 ｜ 击穿 0 ｜ 手术 0** ｜ RAG 残留 0。

---

## 二、第一件：底部面板越界遮挡右侧工具栏

### 根因

用户的判断是对的，而且比我最初的猜测更准：

- `data-lab-body` 是「画布列 + 右侧工具栏」这一行。
- `BottomPanel` 原来是**整个 shell 根 `flex-col` 的最后一个子节点**，宽度等于整页宽度。
- 面板自身还带 `mx-auto max-w-3xl`，即在一个「整页宽」的容器里居中一个 768px 的卡片。

两件事叠加的后果：面板既**对齐不到画布左边缘**，也**够不到画布右边缘**；而它的定位基准是整页，所以当画布列只占约 75% 页宽时，面板的右边缘必然越过画布列边界、压到工具栏上。

> 关键认知：面板要「只在画布区域内展开」，那么**它的容器就必须是画布列本身**，而不是再去算一个和画布等宽的像素值。把面板挪进画布列之后，「左边缘 = 画布左、右边缘 = 工具栏左」是**布局的自然结果**，不需要任何额外测量或魔法数字。

### 改了哪些文件

**1. `src/components/lab/LabShell.tsx`**

把 `BottomPanel` 从根 `flex-col` 的末位子节点，**移进画布列**，并把画布列改成 `flex-col`：

```tsx
<div className="relative flex h-full min-w-0 flex-[7] flex-col border-r border-line">
  <div className="relative min-h-0 w-full flex-1">
    <CanvasStage ... />
    <ActionBar feedback={feedback.feedback} onClear={feedback.clear} />
  </div>
  <BottomPanel
    content={panelContent}
    onClose={() => dispatch({ type: 'select', id: null })}
    onAction={handlePanelAction}
    pending={feedback.pending}
    prefillDebtTitle={contextDebtTitle}
    onPrefillConsumed={() => dispatch({ type: 'clearPrefill' })}
  />
</div>
```

**同一个改动也应用到 `view === 'idea'` 分支** —— 那条分支原本是 shell 根级出口，若不改，切到工作台视图时面板会**直接消失**。现在 `flex-[7]` 列同样变成 `flex-col`，`IdeaWorkbench` 包在 `flex-1 min-h-0` 里，`BottomPanel` 作为它的兄弟节点。

根级那份 `<BottomPanel .../>` 已删除，原注释块替换为「面板现在住在画布列里」的说明。`data-lab-body` 保持不变（它仍是画布+工具栏这一行，验收脚本依赖它）。

**2. `src/components/lab/BottomPanel.tsx`**

```diff
- className="pointer-events-auto mx-auto w-full max-w-3xl overflow-hidden border border-line bg-white"
+ className="pointer-events-auto mx-2 w-[calc(100%-16px)] overflow-hidden border border-line bg-white"
```

- 旧写法的 `mx-auto max-w-3xl` 是「在一个整页宽容器里居中一个 768px 卡片」——既对不齐画布左，也够不到画布右。
- 新写法：外层容器**就是**画布列，所以「填满它、左右各留 8px」天然满足「左边缘 = 画布左、右边缘 = 工具栏左」。
- `PANEL_H*` 常量与 `pointer-events-none` 外层包装均未改动。

### 实测证据

`scripts/verify-panel-toolbar.py` —— 3 个视口，进入 `/projects` → 第一篇论文 lab → `?view=dna`，打开面板后测量工具栏 `aside` 与 `[data-panel]` 的 boundingBox：

```
视口 1440x950：面板右 1314.00  工具栏左 1324.00  right-left = -10.00  水平重叠 = 0.00  ✅
视口 1280x800：面板右 1160.00  工具栏左 1170.00  right-left = -10.00  水平重叠 = 0.00  ✅
视口 1024x700：面板右  914.00  工具栏左  924.00  right-left = -10.00  水平重叠 = 0.00  ✅

结论：PASS —— 3/3 个视口：面板右边缘 <= 工具栏左边缘，零重叠。
```

断言为 `panel.right - toolbar.left <= TOL(0.5)` **且** `overlap_x(panel, toolbar) <= TOL`；两条同时成立。

截图：`p10-evidence/p6-panel-toolbar-{1440x950,1280x800,1024x700}.png`

> 为什么 `-10.00` 在每个视口都一样：面板的定位基准已经是画布列，而画布列与工具栏是固定比例的相邻兄弟，所以这个间隙**与视口宽度无关** —— 这正是把容器换成画布列带来的好处，不是巧合。

### 顺带挖出的真实 Bug（第一件验收带出来的）

去硬编码后的 `verify-u2-centering.py` 暴露出：**560px 视口下 Pazl 篇（15 节点、CORE_METHOD 列高 642px）超出画布 26px**（上下各一个节点越界 26px）。

- **根因**：`src/lib/lab/layout.ts` 的 `ABS_MIN_SCALE = 0.5` 太低（太小）了 —— 它是缩放下限，Pazl 篇在 560px 下需要 scale **0.38** 才能装下，0.5 的下限直接把内容顶出去。
- **修法**：`ABS_MIN_SCALE: 0.5 → 0.35`，并把注释里的实测数据一并重写（旧 RAG 三篇的测量 + 新 IPS 三篇的测量都留在注释里，说明这个数是量出来的不是拍的）。

```
CPD-PDR 396px @560 → 需要 0.62
WiFi-Aug 314px @560 → 需要 0.78
Pazl     642px @560 → 需要 0.38   ← 旧下限 0.5 顶不住，实测越界 26px
```

修后复测：**126 个节点位置，越界 0**（3 视口 × 3 篇）。

---

## 三、第二件：内置论文替换为 IPS 三篇

### 3.1 清除旧 RAG 数据

`scripts/reseed-ips.mjs` 第 1/5 步：按项目名匹配（`示例项目 · RAG 方法演进` **或** 名称含 `RAG`）删除项目，靠 Prisma 级联清掉全部派生数据（DNA / Blocks / Evidence / Relation / Debt / Idea / CrashTest / Surgery），并 `rmSync` 掉每篇论文的 `storage/papers/<paperId>` 目录；同时删同名 IPS 项目以保证可重复执行（幂等）。

删除后断言 `Self-RAG` 相关论文为 0。

### 3.2 上传 + 解析

走的是**和 UI 完全相同的路径** `/api/upload`（multipart），而不是绕开去直接 import `src/lib/pdf-parse.ts`：

> 早期草稿试过 `import '../src/lib/pdf-parse.ts'` —— 纯 Node 跑不了 TS。更重要的是，**绕开 UI 路径就等于验收了一条用户不会走的路**。改用 `/api/upload` 之后，上传、PDF 解析、`extractMethodDNA` 三件事在验收里都真实发生了。

三篇论文与解析结果：

| 论文 | 年份 | 页数 | Blocks | Evidence | 覆盖阶段 |
| --- | --- | --- | --- | --- | --- |
| A Practical Indoor Positioning System Based on Collaborative PDR and Wi-Fi Fingerprinting | 2024 | — | 12 | 60 | 7/7 |
| A WiFi Fingerprint Augmentation Method for 3-D Crowdsourced Indoor Positioning Systems | 2022 | — | 13 | 53 | 7/7 |
| Pazl: A mobile crowdsensing based indoor WiFi monitoring system | 2013 | — | 14 | 64 | 7/7 |

> 顺带验证了更早的「问题 3：DNA prompt 三层修改」是有效的：旧 RAG 那次运行每篇只抽出 **3 个 block / 3 个阶段**，现在是 12~14 个 block / 7 阶段全覆盖。同一套 prompt，产出量级差了一个数量级，说明那轮修改确实落地了。

`extractMethodDNA` 本身是幂等的（先删该论文已有的 `methodDNA`/`evidenceRef` 再重建），所以第 3/5 步对已有 block 的论文**跳过重复抽取**，只对缺 block 的论文补跑 `dna`。

### 3.3 演化链：1 条 → 3 条（本轮最难的一处）

**现象**：第一轮只产出 **1 条**关系，验收第 ③ 条（「形成一条清晰的演化链」）不达标。

**排查过程**（这一步值得记下来，因为险些误判成代码 bug）：

1. 加了 `EVO_DEBUG=1` 诊断（仅 stderr，默认关闭），打印论文顺序、模型返回的原始 `relations` 数、每条 `sourceIndex->targetIndex type conf ev`，以及**每个 `skipped++` 分支的原因**（`bad index` / `bad type` / `low confidence` / `no evidence` / `duplicate pair`）。
2. 诊断输出显示 `skipped 0` —— **没有任何东西被过滤掉**。模型就是只返回了 1 条。
3. 模型自己的 `notes` 写得很明白：它**主动拒绝**了 [0]↔[1] 和 [1]↔[2]，理由是「原文未提及 / 无互相引用」。

**根因**：不是代码，是 prompt 的证据观太窄。旧 prompt 只认「引用级证据」（A 明确写了「基于 B / 沿用 B / 不同于 B」），但这三篇 IPS 论文**互不引用** —— 它们各自独立地面对「室内定位的指纹成本与漂移」这同一个问题。按旧标准，这种「同一问题、不同路线」的关系会被全部丢掉，而这恰好是演化链最该表达的东西。

**修法**：重写 `SYSTEM_PROMPT`，从「只认引用级」改为**两层证据模型**：

- **★ 第一层（引用级）**：明确的「基于 X / 沿用 X / 不同于 X / 用 X 替代 Y」→ confidence `0.8~1.0`
- **★ 第二层（问题级）**：无互相引用，但同时满足（a）在解决**同一个可辨识的研究问题**，（b）机制上可比（改进 / 不同路线 / 分支 / 组合）→ confidence `0.5~0.75`
- **✘ 无效**：仅共享一个大领域、没有共同的具体问题、也没有机制层面的推进 —— 只有这种情况才不连边

配套改动：
- 规则 1 重写：证据可以来自**任一**相关论文（例如后一篇的引言在描述问题）。
- 新增规则 4：N 篇论文常常形成一条链或多个边 —— 如实连接，「不确定」交给 confidence 表达，而不是靠不连边来回避。
- 新 confidence 表：`0.8~1.0` 引用级 ／ `0.6~0.8` 问题级+机制明确 ／ `0.5~0.6` 问题级+需推断 ／ `<0.5` 不输出。
- 要求 `reason` 同时写清 **(a) 共同面对的问题** 和 **(b) 后者相对前者的推进**。

**结果：1 条 → 3 条**，构成完整链条：

```
2013 Pazl: A mobile crowdsensing based…  →  2022 A WiFi Fingerprint Augmentation…   BRANCH  0.5  UNCERTAIN
2022 A WiFi Fingerprint Augmentation…    →  2024 A Practical Indoor Positioning…    BRANCH  0.5  UNCERTAIN
2013 Pazl: A mobile crowdsensing based…  →  2024 A Practical Indoor Positioning…    BRANCH  0.6  UNCERTAIN
```

> 3 条正好等于 3 篇论文的两两组合上限 `C(3,2) = 3`。代码里 `pairSeen` 对每个无序论文对只允许一条关系，所以这是这一数据集能达到的**满图**。

**P3 同步**：`src/lib/llm-mock.ts` 的演化 mock 同步升级为同一套两层模型 —— 第一层走关键词共现（confidence `0.55`），第二层走共享领域术语命中数 `>= 2`（confidence `0.5`，刚好在 `MIN_CONFIDENCE = 0.5` 之上）。新增 `TOKEN_TERMS`/`sharedTopicHits()`，`Candidate` 接口加 `citationLevel: boolean`，选择时优先引用级、其次命中数多者。

### 3.4 想法生成：0 条 → 3 条

**现象**：`crossbreed` 产出 **0 条**候选。

**排查过程**（`CB_DEBUG=1` 诊断，三轮迭代）：

| 轮次 | 诊断输出 | 判断 |
| --- | --- | --- |
| 第 1 轮 | `gate3b evidence UNVERIFIED` ×1 + `gate1 single-paper (papers=1)` ×2 | 一半是「同一篇论文内部组合」（不是跨论文），一半是证据校验不过 |
| 第 2 轮 | 跨论文问题修好了（3 条全是跨论文），但 **3 条全部** `gate3b` 不过 | 性质变了，说明是同一个更深的根因 |
| 第 3 轮 | — | **定位到根因** |

**真正的根因**：给模型看的 block `description`/`role` 是**中文 LLM 摘要**，而 `paper.rawText` 是**英文原文**。模型「抄」的是中文，拿去和英文原文做字符串匹配，**永远匹配不上**。这不是模型不听话，是我们给的输入和校验用的语料不是同一种语言。

**修法**：让**原文逐字进入提示词**。

`src/lib/crossbreeder.ts` 里 block 池新增英文原文片段 —— 从 `block.method.paper.evidenceRefs` 按 `evidenceIds` 取出 `quote`，格式化成：

```
    原文片段（证据请从这里逐字复制）：
      · [p3] <english quote… (≤220 字符)>
```

债务列表同样补 `[原文·pN] <english quote>`（每个 source 最多 2 条）。查询相应改成 `method: { include: { paper: { include: { evidenceRefs: true } } } }` 与 `sources: { include: { paper: { include: { evidenceRefs: true } } } }`。

同时**加固 SYSTEM_PROMPT**（P3 要求：prompt 改了 mock 必须同步）：

- 关卡 1：输出前先数一遍**不同论文标题**的个数（`>= 2`），并把「同一篇论文内部组合」点名为**最常见的失败原因**。
- 关卡 3：引用必须是**逐字连续原文**（不许改写 / 翻译 / 概括 / 拼接），并明确告知「引文会与原文做字符串匹配」。
- 新增「【输出前的自检（必须逐条过一遍，不要跳过）】」：Q1（去重后是否 ≥ 2 篇论文？）、Q2（每条 evidence 是否逐字连续原文？）、Q3（第 3 段是否真说出了「某特性以某方式补上某缺口」？），收尾一句「宁可只输出 1 个站得住的候选，也不要输出 3 个过不了关卡的候选」。

**结果：0 条 → 3 条**，全部跨论文（各涉及 2 篇）、全部 `CONFIRMED`、`why` 全部 4/4 段齐全：

```
CONFIRMED | blocks=3 | ev=4 | 以活动地标事件驱动 Wi-Fi 校正：用上下楼梯/电梯事件替代固定步数阈值触发指纹扫描
CONFIRMED | blocks=2 | ev=2 | 用建筑地图约束替换欧氏距离判据：地图可行位置集合对 Wi-Fi 指纹预测的接受/拒绝门控
CONFIRMED | blocks=4 | ev=5 | MGPR 虚拟参考点把「省 RP」与「校正可接受」解耦：用 1 m 网格增强指纹库降低扫描时…
```

模型自己的 `notes` 甚至解释了它**主动丢弃**了一个「看着诱人但不成立」的组合：「说得说不出 MGPR 的哪个具体机制补上了众包标签生成的具体缺口…故丢弃」—— 这正是关卡设计想要的行为。

> **crossbreeder 的 mock 未作改动**：检查后确认它已经（a）用 `pickDistinctPair` 强制跨论文配对，（b）输出 4 段式 `why`（①缺口 ②特性 ③衔接 ④可预期），（c）用模块描述作证据 —— 与加固后的 prompt 语义一致，不需要改。
### 3.5 击穿测试：2/3 → 3/3，并修掉一个静默丢字段

**现象（第一层）**：3 条里 1 条失败，报
`结构化校验未通过：$.findings[0..6].suggestion 缺少必填字段; $.findings[0..6].evidence 缺少必填字段`

**根因**：`src/lib/llm.ts` 的 `validateShape` 对 `type: 'object'` 的判定是 **`if (!(key in obj))` —— 要求每个声明过的键必须存在**，哪怕该项写的是 `min: 0`（即「值可以为空」≠「键可以省」）。

**修法**：在击穿测试 prompt 的输出段追加「★★ 输出的强制完整性要求 ★★」，写明：5 个 finding 数组（`noveltyCheck` / `blockConflictCheck` / `dataRequirement` / `computeRequirement` / `findings`）里**每一个元素**都必须同时具备 `finding / level / detail / suggestion / evidence` 五个字段；`suggestion` 即使是 PASS 也要写空串 `""`，`evidence` 没有原文也要写 `[]`，`detail` 也不能省。一句话：**「键不能省，值可以为空」**。`FINDING_SPEC` 保持不动（`suggestion: { type:'string', min:0 }`、`evidence: EVIDENCE_SPEC`）。

**结果**：重试后通过 → **3/3**（`LIKELY_EXISTS` / `RISKY` / `LIKELY_EXISTS`）。

**现象（第二层，深挖时发现）**：我一直以为「3/3 都过了校验」就等于字段齐了。深挖落库数据时发现**并没有**：

```
■ 用建筑地图约束替换欧氏距离判据…  → LIKELY_EXISTS | CONFIRMED
   noveltyCheck          1  {"BLOCKER":1}
   blockConflictCheck    2  {"CONCERN":2}
   dataRequirement       2  {"CONCERN":2}
   computeRequirement    1  {"PASS":1}
   findings.extra        5  {"BLOCKER":1,"CONCERN":4} | 缺字段=true   ← 这里
■ 以活动地标事件驱动 Wi-Fi 校正…    → LIKELY_EXISTS | CONFIRMED
   findings.extra        3  {"CONCERN":3} | 缺字段=true               ← 这里
```

逐条打印键名后确认为：`findings.extra` 的每一项 keys 是 `finding,level,detail,suggestion` —— **只有 `findings` 这一个数组丢了 `evidence`**，四个命名数组全齐。

**根因**：`src/lib/crash-test.ts` 落库处，四个命名数组都写了 `evidenceIds: cleanEvidence(f.evidence).map(...)`，唯独 `findings.extra` 的映射漏了这一个字段。

> 这是最需要说清的一处：它**不是「少个字段」这么轻**。
> ① prompt 要求模型每个 finding 都给 evidence，`validateShape` 也因此把缺键判为整次失败 —— 我们向模型索取了证据，落库时又把它丢掉，等于**收了钱不做事**；
> ② 前端 `allFindings` 与面板的「证据」按钮按同一套形状读数据，`extra` 少了这一项，**同一个页面上两类 finding 长得不一样**；
> ③ 最要命的是**静默** —— 模型明明给了引用原文，用户在 `findings` 里却看不到出处，**无从核对**。

**修法**：给 `findings.extra` 补上与四个命名数组**完全一致**的写法（先 `cleanEvidence` 过滤 quote 过短的，再映射成被 verify 通过、真实落库的 `paperId`）：

```ts
findings: JSON.stringify({
  extra: (t.findings ?? []).map((f) => ({
    finding: f.finding,
    level: normalizeLevel(f.level),
    detail: f.detail,
    suggestion: (f.suggestion ?? '').trim().slice(0, 500),
    evidenceIds: cleanEvidence(f.evidence)
      .map((e) => verifiedEv.find((v) => v.page === e.page &&
        v.quote.slice(0, 100) === e.quote.slice(0, 100))?.paperId ?? null)
      .filter((x): x is string => Boolean(x)),
  })),
  ...
```

并在 prompt 里补上针对性的第二段：明确点名「最容易漏掉 evidence 的，恰恰是最后一个 `findings` 数组」，并给出一张**逐数组、逐元素**的自查表（5 个数组各一行，`findings` 那行标 ★「这一项最容易漏」）。

**P3 同步**：`src/lib/llm-mock.ts` 的击穿 mock 给 `findings: []` 加上了字段注释，说明「形态上必须与真模型完全同形（P2 按数据来源判定 mock/真模型 —— 形状不一致正是已经踩过的坑）」，将来 mock 若要补 findings 也必须带 evidence。

**验证（修复后对真模型重跑一次完整的击穿测试）**：

清除已有结果后重跑 `crashtest`，`{"ok":true,"message":"3 个方案已测试，0 个失败"}`，落库复核：

```
■ 以活动地标事件驱动 Wi-Fi 校正…     → LIKELY_EXISTS | CONFIRMED
   findings.extra = 3 条 | 缺 evidenceIds 键 = 0 | 带非空证据 = 2
■ 用建筑地图约束替换欧氏距离判据…     → LIKELY_EXISTS | CONFIRMED
   findings.extra = 4 条 | 缺 evidenceIds 键 = 0 | 带非空证据 = 4
■ MGPR 虚拟参考点把「省 RP」与「校正可接受」解耦… → RISKY | CONFIRMED
   findings.extra = 4 条 | 缺 evidenceIds 键 = 0 | 带非空证据 = 3

结论: ✅ 所有 findings.extra 均已带 evidenceIds，静默丢字段已修复
```

11 条 `findings.extra`（修复前是 8 条），**缺键 0**，其中 9 条落到了真实的 `paperId` 上 —— 模型给的引用原文现在**用户在界面上能看到了**。

> 附带效果：三份报告的 `evidenceStatus` 从 `CONFIRMED / INSUFFICIENT / CONFIRMED` 变成**三份全 `CONFIRMED`**。原因是 evidence 计数现在把 `extra` 里的引用也算进去了（`MGPR` 那份由 4 条证据升到 13 条），跨过了「≥2 条即 CONFIRMED」的门槛。这说明修掉的不是一个孤立的字段，而是**证据统计口径本身的漏算**。

**顺带做的横向审计**：为避免同类问题在其他模块复发，逐个核对了各模块「声明字段 vs 落库映射」：

| 模块 | 声明 | 落库 | 结论 |
| --- | --- | --- | --- |
| `crossbreeder.ts` | `RawCandidate`: title/description/blockIndexes/debtIndexes/why/evidence | 6/6 全写 | ✅ |
| `method-evolution.ts` | `RawRelation`: sourceIndex/targetIndex/type/reason/confidence/evidence | 6/6 全写 | ✅ |
| `research-debt.ts` | `RawDebt` + `RawDebtSource` + `RawAttempt` | 全写（含 `provider` 数据来源固化） | ✅ |
| `crash-test.ts` | `RawFinding` × 5 数组 | **`findings.extra` 漏 evidence** | ⚠️ 已修 |

**`findings.extra` 是唯一一处**，已修。这也解释了为什么之前「3/3 通过」的结论并不完整 —— 校验层只保证**送进来的 shape 合法**，不保证**存下去的 shape 完整**，这两件事之间的缝正好在这里。

---

## 四、改了哪些文件（汇总）

| 文件 | 变动 | 归属 |
| --- | --- | --- |
| `src/components/lab/LabShell.tsx` | `BottomPanel` 从 shell 根移入画布列（画布分支 + `idea` 分支都改），画布列改 `flex-col`；删根级面板 | 第一件 |
| `src/components/lab/BottomPanel.tsx` | `mx-auto max-w-3xl` → `mx-2 w-[calc(100%-16px)]` | 第一件 |
| `src/lib/lab/layout.ts` | `ABS_MIN_SCALE` `0.5 → 0.35`，注释重写为实测数据 | 第一件（验收带出的真实 Bug） |
| `src/lib/method-evolution.ts` | `SYSTEM_PROMPT` 重写为两层证据模型 + confidence 表；新增 `EVO_DEBUG=1` 诊断 | 第二件（演化 1→3） |
| `src/lib/crossbreeder.ts` | block / debt 池补**逐字英文原文**；查询加 `paper.evidenceRefs`；`SYSTEM_PROMPT` 加固（关卡 1/3 + 输出前自检）；新增 `CB_DEBUG=1` 诊断 | 第二件（想法 0→3） |
| `src/lib/crash-test.ts` | prompt 追加强制完整性要求 + `findings` 专项自查表；**落库处给 `findings.extra` 补 `evidenceIds`** | 第二件（击穿 2/3→3/3 + 修静默丢字段） |
| `src/lib/llm-mock.ts` | 演化 mock 同步两层模型（`TOKEN_TERMS`/`sharedTopicHits`/`citationLevel`）；击穿 mock `findings` 补同形注释 | 第二件（P3 同步） |
| `scripts/reseed-ips.mjs` | **新增** IPS 替换驱动（5 步，走真实 `/api/upload`，幂等） | 第二件 |
| `scripts/verify-panel-toolbar.py` | **新增** 第一件验收（3 视口零重叠断言） | 第一件 |
| `scripts/verify-ips.py` | **新增** 第二件 UI 验收 | 第二件 |
| `scripts/diag-evolution.mjs` | **新增** 演化诊断（论文顺序 / 已有关系 / 最大可能配对） | 第二件 |
| `scripts/verify-cold-start.py` | **重写**：解掉硬编码项目 id，改为 `--expect-cold` / `--expect-data` 双向模式 | 第二件（验收 ⑤） |
| `scripts/verify-u2-centering.py` | **去硬编码**：项目与论文 id 从 Prisma 动态解析 | 第一件 |
| `scripts/verify-p3-uncertain.py` | **重写**：去硬编码 + 契约反转为条件式 | 第一件 |
| `scripts/verify-s1-dynamic-stages.py` | **去硬编码**：论文列表从 DB 取 | 第一件 |
| `package.json` | 新增 `reseed:ips` / `reseed:ips:check` | 第二件 |
| `sample-papers/` | 新增 `ips-1-cpd-pdr-wifi.pdf` / `ips-2-wifi-crowdsourced-3d.pdf` / `ips-3-pazl-crowdsensing.pdf` | 第二件 |

---

## 五、遇到的问题（与处理）

1. **绕开 UI 上传路径** —— 初版 `reseed-ips.mjs` 试图直接 `import` TS 版的 pdf-parse，纯 Node 跑不了；更重要的是那等于验收了一条用户不会走的路。改为走真实 `/api/upload`，让上传 / 解析 / DNA 抽取都在验收里真实发生。

2. **演化只有 1 条关系** —— 一度想去找代码里的过滤 bug，`EVO_DEBUG=1` 显示 `skipped 0`（没有任何东西被过滤），才转向 prompt：模型是**主动拒绝**连边的。根因是旧 prompt 只认引用级证据，而 IPS 三篇互不引用。改为两层证据模型后 1→3。

3. **想法 0 条** —— 三轮诊断才定位：block 描述是**中文摘要**，`rawText` 是**英文原文**，模型抄中文去和英文做字符串匹配，必然不中。修法是让逐字英文原文直接进提示词。**这个坑的教训是：校验用的语料和喂给模型的语料必须是同一种语言。**

4. **击穿测试校验失败** —— `validateShape` 要求「声明过的键必须存在」（`min: 0` 只是「值可为空」）。prompt 补「键不能省，值可以为空」后 2/3→3/3。

5. **静默丢字段（本轮最有价值的一处）** —— 3/3 通过校验**不等于**字段完整：`findings.extra` 落库时漏了 `evidenceIds`。校验层保证的是「送进来的 shape 合法」，不保证「存下去的 shape 完整」。已修，并横向审计了其余三个模块确认是孤例。

6. **Pazl 篇 560px 越界 26px** —— 去硬编码后的居中验收脚本暴露出 `ABS_MIN_SCALE = 0.5` 顶不住该篇 642px 的列高（需要 0.38）。下限降到 0.35，复测 126/126 越界 0。

7. **面板在 `idea` 视图下会消失** —— 若只改画布分支，工作台视图的面板（原本在 shell 根）就没地方了。两个分支一起改。

8. **三个验收脚本依赖已删除的 RAG 项目 id** —— 换论文后全部报「画布容器未出现」/ `wait_for_selector` 超时。逐一改为从 Prisma 动态解析项目与论文 id。

---

## 六、验收脚本全量结果

以下为本轮**最终构建**（打包进 zip 的那一版）上的实测结果：

| 脚本 | 结果 |
| --- | --- |
| `verify-panel-toolbar.py` | **PASS**（3/3 视口，`right-left = -10.00`，水平重叠 0.00） |
| `verify-ips.py` | **PASS**（论文 3；节点 13/14/15；演化含「问题」；债务 4 / 想法 3 / 击穿 3） |
| `verify-cold-start.py --expect-cold` | **PASS**（DB 0，UI 0，含「已生成的想法（0）」= True，画布 idea 卡片 0） |
| `verify-u2-centering.py` | **PASS**（126/126 节点，越界 0） |
| `verify-p3-uncertain.py` | **PASS**（无缺失阶段 → 该段未出现，正确；灰框占位 0） |
| `verify-s1-dynamic-stages.py` | **PASS**（每篇 8 列 / 13·14·15 节点 / 空占位 0） |
| `verify-s5-fourpart.cjs` | 10 通过 / 0 失败 |
| `verify-s3-three-part.cjs` | 26 通过 / 0 失败 |
| `verify-u3-workflow.cjs` | 15 通过 / 0 失败 |
| `verify-s2-block-names.cjs` | 3 通过 / 0 失败（1 跳过） |
| `npx tsc --noEmit` | 干净（0 error） |
| `npx next build` | 通过 |

**击穿测试真模型重跑**：`{"ok":true,"message":"3 个方案已测试，0 个失败"}`。

---

## 七、冷启动与交付快照

用户验收 ⑤ 要求「冷启动时已生成的想法（0）」。这里要说清一处**看起来矛盾、实际不矛盾**的地方：

验收 ④ 要求「债务、想法、击穿测试都有数据」，验收 ⑤ 要求「冷启动想法为 0」—— 这两条描述的是**同一条时间轴的两端**，不是两个同时成立的状态：

```
冷启动（0 想法）  ──用户点「杂交」──▶  生成 N 条想法（有数据）
```

`CandidateIdea` 全仓只有 `crossbreeder.ts` 一处写入点，**没有任何预置逻辑**。所以「用户打开就看到 3 条想法」从来不是代码问题，而是**交付前没有归零**。这个归零动作已固化为 `scripts/reset-user-data.mjs`，并挂在 `prepack` 上：

```
【清理后】
  crashTest            0 ✅
  candidateIdeaDebt    0 ✅
  candidateIdea        0 ✅
  surgeryLog           0 ✅
  surgery              0 ✅
  attempt              6      ← 保留（演示底座）
  debtSource           7      ← 保留（演示底座）
  researchDebt         4      ← 保留（演示底座）

结论：共删除 10 行，用户动作表已全部归零 ✅
冷启动基线：组合想法 0 条、手术 0 条、击穿测试 0 条。
```

保留的是「演示底座」（论文 / DNA / 模块 / 证据 / 演化关系 / 研究债务）—— 用户一进去就有东西可看；清掉的是「只有点按钮才会产生」的用户动作。UI 侧复核：

```
项目 id            : cmu9my2ie0000z6pko5sqr27s
库里想法数          : 0
界面显示想法数       : 0
含「已生成的想法（0）」: True
画布 idea 卡片节点数  : 0

模式：断言冷启动（0）
结论：通过 ✅
```

### 交付物

`/workspace/MethodAtlas-P10-Step6.zip`（**4.1 MB，180 个文件**）

包含：`.env`、冷启动干净的 `prisma/dev.db`、全部新增脚本与本报告。
排除：`node_modules`、`.next`、`storage`、`*.tsbuildinfo`、全部 PNG、`.git`。

排除项已逐条复核（`grep -c` 结果为 **0**）。

### 快照可运行性验证

打包后**把 zip 解压到干净目录、重新装依赖、重新构建、重新起服务**，在**快照自己的服务器**（3100 端口）上而不是开发环境上复测，确保「交付的东西本身是好的」而不是「我的工作目录是好的」：

```
pnpm install --prefer-offline   → Done in 1.5s（lock 文件完整，依赖可复现）
npx next build                  → 通过
npx next start -p 3100
  /projects                        → HTTP 200
  /projects/<pid>/lab?view=dna      → HTTP 200
  /projects/<pid>/lab?view=evolution → HTTP 200
```

**第一件（快照上复测）**：

```
[1440x950] 工具栏左=1081.00 面板右=1071.00 right-left=-10.00 水平重叠=0.00 PASS
[1280x800] 工具栏左= 961.00 面板右= 951.00 right-left=-10.00 水平重叠=0.00 PASS
[1024x700] 工具栏左= 769.00 面板右= 759.00 right-left=-10.00 水平重叠=0.00 PASS
结论：PASS —— 3/3 视口零重叠 ✅
```

**第二件（快照上复测）**：

```
[DNA] 右侧论文条目 = 3   ✅
      论文[0] → 13 个节点   ✅
      论文[1] → 14 个节点   ✅
      论文[2] → 15 个节点   ✅
[演化] 画布节点 = 4  含『问题』= True   ✅
[研究债务] 徽标 = 4   ✅ 演示底座保留
[组合想法] 徽标 = 0   ✅ 冷启动归零（正确）
[击穿测试] 徽标 = 0   ✅ 冷启动归零（正确）

# 官方冷启动脚本在快照服务器上：
库里想法数 0 / 界面显示想法数 0 / 含「已生成的想法（0）」= True / 画布 idea 卡片 0
结论：通过 ✅
```

> 「组合想法 0 / 击穿测试 0」在快照里是**预期值**，正是用户验收 ⑤ 要的冷启动状态；这与「债务 4 保留」共同构成「演示底座保留、用户动作归零」的交付契约。

---

## 八、约定与约束遵守情况

- **P1（动态阶段不额外调 LLM）**：本轮未引入任何额外的模型调用。演化从 1 条变 3 条是**同一个 prompt 下的同一次调用**，不增加成本。
- **P2（按数据来源判定 mock/真模型）**：击穿 mock 的 `findings` 注释即按此原则书写（形状必须与真模型同形，判定看 `provider`）。
- **P3（prompt 改动必须完整同步 mock）**：演化 prompt 的两层模型已同步到 `llm-mock.ts`；击穿 prompt 的 `findings` 同形要求已同步到 mock 注释。
- **硬约束「不要把 Key 写进任何代码或文档」**：`reseed-ips.mjs` 的 `readEnvModel()` 只读 `.env` 里**最后一行** `LLM_MODEL=`，从不打印 Key；本报告与全部脚本、注释中均无任何 Key 字样。

---

*生成日期：本轮 Step6 收尾 · 交付快照：论文 3 / 模块 39 / 证据 211 / 关系 3 / 债务 4 / 想法 0 / 击穿 0 / 手术 0 / RAG 残留 0*
