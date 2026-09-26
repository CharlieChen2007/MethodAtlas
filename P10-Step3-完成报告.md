# P10 Step 3 · 完成报告

> 本报告覆盖 **P10 计划 Step 3（9 个问题）与 Step 4（全链路验收）**。
> 承接 Step 1（配置层）与 Step 2（en-summary 旁路 / suggestion / 总结质量）。
>
> - 模型：`deepseek/deepseek-flash`（腾讯云 TokenHub 在线推理，OpenAI 兼容）
> - 仓库：`MethodAtlas`（Next.js 14.2.33 + Prisma 5.22 + SQLite）
> - 类型检查：`npx tsc --noEmit` 干净
> - 构建：`pnpm build` 通过
> - 回归：5 个脚本全绿（42 + 15 + 26 + 10 + 3 = **96 项断言，0 失败**）

---

## 一、先说这次改了什么模型

按要求切到了 `deepseek/deepseek-flash`。过程中发现一个**必须记录的坑**：

> **TokenHub 上的模型名必须带命名空间前缀。**

| 写法 | 结果 |
|---|---|
| `deepseek-flash` | ❌ HTTP 400 `{"code":"400004","message":"The model or service ID deepseek-flash does not exist..."}` |
| `deepseek/deepseek-flash` | ✅ 正常 |
| `hy3` | ✅ 正常（不带前缀，混元自家模型例外） |
| `hunyuan-turbos-latest` / `hunyuan-lite` | ❌ 同样 400004 |

这个坑已同步写进 **3 处**：`.env.example`（示例 D 的注释）、
`scripts/llm-check.mjs`（诊断提示）、`README.md`（兼容端点表）。
否则下一个接手的人会再踩一次，而且报错信息（"does not exist"）
会让人误以为是模型下线，而不是**名字格式**问题。

**速度实测**（同一环境）：

| 环节 | deepseek-flash |
|---|---|
| Method DNA 抽取 | 21.3s |
| 债务合成（4 篇论文） | 36.1s |
| 组合想法（21 模块 × 5 债务） | 72.1s |
| 方法手术 | 22.2s |

比 hy3 的 57s~2min 明显好，但它**仍带轻量推理**
（实测 `reasoning_content` 约 208 字符 / 105 reasoning tokens），
不是"秒回"级。所以 `max_tokens: 32000` 的预算**继续保留** ——
推理与 `content` 共享该预算，给少了会 `finish_reason: length` + `content: ""`
→ **静默降级到 mock**（Step 2 已记录，此处再次确认必要性）。

---

## 二、9 个问题逐个交代

### U1 · 首页直达工作台 + 空项目引导
**状态：Step 1 已顺带完成**（修根路径 404 时一并处理）。
根因是 `redirect()` 在静态预渲染页面里于 `next start` 下不生效，
已改为 `force-dynamic`。本次未再改动。

---

### U2 · BottomPanel 遮挡画布 → 挤压布局 ✅

**根因是两个叠加的 bug，其中第二个此前**完全没被发现**：**

1. `BottomPanel.tsx:68` 用了 `absolute inset-x-0 bottom-0` —— 面板是悬浮层，
   展开时**压在**画布上，而不是让画布收缩；
2. **`PANEL_H + 24` 拼出了非法 CSS `height:38vh24`**。
   `PANEL_H` 是字符串 `'38vh'`，`+` 做的是字符串拼接。
   浏览器**静默忽略**整条 `height` 声明 —— 所以即使改了定位方式，
   挤压也**不会生效，且不报任何错**。

**修复**：拆成 `PANEL_H_NUM` / `PANEL_H` / `PANEL_H_PX = calc(${PANEL_H_NUM}vh + 24px)`，
从同一个数字推导，改一处即可。外层改为 `relative shrink-0` 的真实占位元素，
高度随开合在 `0` 与 `PANEL_H_PX` 间过渡。

**实测证据**（浏览器量几何，`p10-evidence/u2-panel-*.png`）：

| 状态 | 画布区高度 | 面板占位高度 |
|---|---|---|
| 收起 | 845px | 0px |
| 展开 | 479px | 366px |

画布底边 y=534，面板顶边 y=542 → **零重叠**。

> 这个 bug 的教训值得记：非法 CSS 值不会报错，只会"什么都没发生"。
> 我是靠在真实浏览器里**量几何尺寸**才抓到的 —— 只读代码永远看不出来。

---

### U3 · 工作流顺序倒置 ✅

**根因**：`workflow.ts` 的 `judge()` 里，`evolution` 与 `debt` **共用**
`data.debts.length` 作为完成判据。于是债务一产生，两步**同时**变 ✓，
而 `suggestNext()` 取"第一个未完成"，就**永久跳过** `evolution` —— 这就是顺序倒置。

**修复**：`evolution` 改判 `narratable = debts.filter(d => d.attempts.length > 0).length`
（有论文尝试解决，才谈得上"演进"）；`views.ts` 的 `getAvailability('evolution')`
同步区分 `empty`（画得出来吗）与 `done`（这步做完了吗）——
**画得出来 ≠ 这一步做完了**。

**回归**：`scripts/verify-u3-workflow.cjs` **15/15**。
浏览器实测导航条已变为 `论文 ✓ / 方法 DNA ✓ / 方法演化 ●★ / 研究债务 ✓ / 组合想法 ○→`，
`→` 正确落在「组合想法」。

---

### S1 · 思维导图动态阶段（按 P1 不额外调 LLM）✅

**旧行为**：固定渲染全部 7 个阶段列，空列画灰色虚线框「原文未描述」。

**为什么这是错的**（三条，写在代码注释里）：
1. **视觉噪音** —— 一篇论文通常只覆盖 3~4 个阶段，画布一半是"我们没有的东西"；
2. **信息误读** —— 「原文未描述」在一列里连出四次，读者会以为是**抽取失败**，
   而不是"这篇论文本来就不涉及"；
3. **连线为空而连** —— 为贯通而画的线，把"有内容"和"没内容"视觉上拉平了。

**修复**：`layout.ts` 引入 `activeStages = METHOD_STAGE_ORDER.filter(s => bucket.get(s)!.length > 0)`，
作用于 4 处（列高、列宽、建列循环、连线锚点），**删掉空列分支**与 `NARROW_W`；
`view-layout.ts` 的 `structureSkeleton()` 从 7 个幻影列缩减为 1 个占位。
按 P1 拍板：**不额外调 LLM**，只是忠实渲染真实出现过的阶段集合。

**实测证据**（`scripts/verify-s1-dynamic-stages.py`，浏览器量列数）：

| 论文 | Block 数 | 覆盖阶段 | 渲染列数 | 期望 | 结果 |
|---|---|---|---|---|---|
| RAG 2020 | 8 | CORE/TRAINING/EVAL | 4 | 4 | ✅ |
| FiD 2020 | 6 | CORE/EVAL | 3 | 3 | ✅ |
| Self-RAG 2023 | 4 | CORE/INFERENCE/EVAL | 4 | 4 | ✅ |
| Self-RAG（无结构） | 0 | — | 骨架占位 **1 个** | 1 | ✅ |

同时断言**画布上不存在「原文未描述」字样** —— 通过。
可见 `p10-evidence/s1-dna-3stages.png`：4 列，无灰框。

---

### S2 · Block 名字 ⚠️ **经实测：无需改代码**

**结论**：S2 报的"名字是句子残骸"问题，**已在 P9 问题 1 修复**。
我没有凭印象下这个结论，而是跑了三条断言（`scripts/verify-s2-block-names.cjs`）：

1. 全库 **18 个 Block**，`normalizeBlockName()` 跑一遍 **0 处会变** → 库里存的已是规范化结果；
2. 规范化**幂等**（跑两次 = 跑一次）→ 反复抽取不会劣化；
3. 渲染层有 `textOverflow: ellipsis` + `title` 属性 → 长名字在画布上截断
   （`RAG (Retrieval-aug…`）、悬停可见全文，展示层不需要额外处理。

顺带发现一个**容易误导后来人**的现象：`looksLikeSentenceFragment()`
会把 8 个 `缩写 (全称)` 形式的名字判为"残骸"（因为它按长度判断，
>30 字符即命中）。但这些名字**实际是合格的**（`isCleanName` 全部通过）。
这是那个启发式的保守性所致，**不是数据问题** ——
我在脚本注释里写清了这一点，避免下一个人再"修"一遍。

**回归**：**7/7 通过**（含缺编译产物时的优雅跳过）。

---

### S3 · 手术结论三段式 ✅

**根因（两层，实测确认）**：

- **prompt 层**：`method-surgery.ts` 的 `blockRole` 只说"该模块在原方法中承担的作用"，
  没有约束它与 `lostCapability`、`impacts` 的分工 → 三字段容易写成同一句话的三种说法。
- **DNA 层（更上游）**：`method-dna.ts:484` 是 `role: (b.role || '').trim().slice(0, 500)`
  —— **对模型输出的直接透传**，而 prompt 只写了"它在整个方法里承担什么作用（role）"，
  没说清 role 与 description 的区别 → 模型把"描述的组成部分"当成了 role。

**修复**：
- `method-dna.ts` 的 prompt 加了「description 与 role 的分工」整节，
  含**四条硬规矩**（不复述 description / 不讲构成 / 功能动词开头 / 不写空话）
  与一组**正误对照示例**；JSON 模板里的字段提示也改成
  `"description": "这个模块是什么（构成/机制）"`、`"role": "拿掉它会失去哪件能力…"`。
- `method-surgery.ts` 加了「三个核心字段必须分工明确」整节，
  明确 `blockRole` = 前提、`lostCapability` = 结论（用户默认只看这一句）、
  `impacts` = 展开，并要求 **severity 拉开档次**。

**按 P3 完整同步 mock**（`llm-mock.ts`）：改为用 `deriveBlockRole()` 重算功能化 role，
`lostCapability` 改为
`移除<模块> 后，方法失去了<能力>这一环节的能力，核心流程会断在这里。`
—— 用「<模块名> 这一环节」而不是直接拼 role，避免"因为负责检索"这种语义重复的病句。

**顺带修掉一个真实缺陷**：`surgery-summary.ts` 的 `joinCauseAndEffect()` 只有一个分支，
一律套 `…——因为 X 负责<lost>`。当 `lost` 退化为一条 **impact 后果句**
（如"依赖该模块的下游模块会失去输入"）时，会产出病句：
> ~~移除 X 后，方法的核心流程会断在这里——因为 X **负责依赖该模块的下游模块会失去输入**~~

已加分支区分「能力名词短语」与「后果句」，后果句直接作结论陈述。
修复后输出：`移除无规则可命中的描述后，依赖该模块的下游模块会失去输入，需要另行补上。`

**回归**：`scripts/verify-s3-three-part.cjs` **26/26**，
断言含"两者措辞有实质差异（2-gram Jaccard < 0.62）"、
"severity 拉开了档次"、"不是同义反复"、"无旧模板标记"。

**真模型实测**（见对照文档例 2）：deepseek-flash 给出
`blockRole` 描述框架、`lostCapability` 说"失去了在生成时刻调用外部非参数化知识的能力"、
`impacts` **4 档 severity**（SEVERE/MODERATE/MINOR），
且**主动列出对自己结论不利的证据**（第 6 条 MINOR："移除反而省算力"）
与**自己证据的瑕疵**（"该消融针对的是移除检索，并非移除整个 RAG 框架，两者不等价"）。

---

### S4 · 真实归纳
**状态：Step 2 已解决**。本次未改。债务来源按 `provider` 分派中文归纳，
真模型写入的直接用（限 60 字）、mock 时代的走 `summarizePoint()` 老中文归纳。

---

### S5 · 杂交四段式推理 prompt ✅

**问题**：问题 7 曾把 `why` 压成"先结果、后理由"的**两句**。
两句里**没有衔接段** —— 用户看到的是"两个模块各自是什么"，
但看不到 **"所以为什么能对上"**，而后者才是判断一个组合有没有价值的关键。
面板把 `why` 整块渲染为「为什么能解决」，两句话撑不起这个标题。

**修复**：`crossbreeder.ts` 的 prompt 把 `why` 定义为**四段式推理链**
（①债务缺口 ②模块关键特性 ③**为什么能对上** ④可验证的预期），
每段给出写作要求与"应当放弃这个候选"的判据，并附一段**高粒度的四段式示例**。
第 3 段特别强调：**"如果你发现第 3 段只是把前两段重说一遍，
说明你没有真正想清楚这个组合，那就应当放弃这个候选"**。

**加了服务端结构校验**（关键）：prompt 是请求不是保证。新增 `whyIsFourPart()`，
校验段数 ≥3（给模型留容错）、总长下限、**必须存在衔接语义**
（匹配"所以/因此/正好/补上/消解"等），并接入 `whyIsVague()`。
措辞没变但内容合格的候选不会被误杀（用**段数**这类稳定形状判断，
不用关键词硬匹配）。

**按 P3 完整同步 mock**：mock 的 `why` 也改成四段，四段**确实回答四个不同问题**。

**这里抓到一个真问题**：`whyIsVague()` 加上四段校验后，
问题 7 的**旧两句式会被判为"空话"**。如果只改 prompt 不改 mock，
降级模式下 mock 自己产出的 why 就过不了校验 →
**所有候选被静默丢光（0 个 idea）**，而且**不会报任何错**。
这正是我在测试脚本里专门断言"mock 的 why 必须通过 whyIsVague"的原因。
（`scripts/verify-s5-fourpart.cjs` 里那个"两段式（问题 7 的旧格式）"
用例就是钉这个回归的。）

**回归**：**10/10**。真模型实测产出 3 个候选**全部通过四段校验**，
第 3 段写出"正因为段落表示是可分别寻址的槽位，第 1 段里缺失的那个
『事后削弱手段』才有了物理落点"—— 显式回指前两段并给出机制。
详见对照文档例 4。

---

### S6 · 击穿测试推理轨迹 + 针对性建议
**状态：Step 2 已解决**。本次未改（`suggestion` 字段已补齐并同步 mock）。

---

### 遗留问题（本次新增记录）

**`Surgery` 表没有 `provider` 字段**。P2 拍板要求"靠数据来源判断 mock/真模型"，
`DebtSource` / `Attempt` 已加上，但 `Surgery` 漏了。
目前只能**间接**判断：真模型写 `confidence=0.9` + `CONFIRMED`，
mock 写 `0.6` + `UNCERTAIN`（实测确认这个区分是可靠的，两组数据清晰分离）。

- 影响：**低**。降级时 verdict 会被强制降为 `INSUFFICIENT_EVIDENCE`，
  这个行为本身就能暴露降级。
- 建议：P11 补 `Surgery.provider`，与另外两张表对齐，让来源判断不必再靠 confidence 反推。

---

## 三、Step 4 · 全链路验收

完整对照见 **`P10-Step4-Mock与真模型对照.md`**。摘录关键结论：

| 维度 | Mock | deepseek-flash |
|---|---|---|
| Block role | 模板句，TVR/TD/FiD/ST **四个模块共用同一句** | 每个模块各不相同，且是真正的功能职责 |
| 手术结论 | 一律 `INSUFFICIENT_EVIDENCE` | 敢给 `INFEASIBLE`，14 条证据 |
| severity 分级 | 集中少数档 | 4 档拉开（SEVERE/MODERATE/MINOR） |
| 证据强度 | `confidence=0.6` + `UNCERTAIN` | `confidence=0.9` + `CONFIRMED` |
| 债务条数 | 1 条（粗颗粒） | 5 条（3 跨论文，颗粒度可动手） |
| 编造 | 不编造（设计目标） | 引用**真实存在的消融实验原句** |

**降级验证**（把 Key 换成无效值后实测）：

| 检查项 | 结果 |
|---|---|
| 是否降级 | ✅ 耗时 0.80s（vs 真模型 21.3s），`evidenceStatus` 从 `CONFIRMED` 变 `UNCERTAIN` |
| 是否阻断用户 | ✅ 否，HTTP 200 + `ok:true`，仍返回可用结果 |
| 日志是否打印 | ✅ `[llm] 真模型调用失败，已降级到 mock（purpose=method-dna-extraction）：LLM 接口返回 401: {...}`（含 TokenHub `request_id`，便于提工单） |
| 徽标是否出现 | ✅ `/api/llm-status` 返回 `{"degraded":true,"degradedReason":"LLM 接口返回 401: ..."}`，画布左上角出现琥珀色 `● 离线模式` |

徽标截图：`p10-evidence/step4-offline-badge.png`。
该图同时再次印证 **S1**（4 列、无「原文未描述」）与 **U2**（面板在画布下方，非叠加）。

---

## 四、按"每完成一步交付"要求的汇总

### 改了哪些文件

| 文件 | 改动 | 对应问题 |
|---|---|---|
| `.env` | 模型切 `deepseek/deepseek-flash` | 模型切换 |
| `.env.example` | 示例 D 补充命名空间规则 + 双端点陷阱 | 模型切换 |
| `README.md` | 兼容端点表补 TokenHub 行 | 模型切换 |
| `scripts/llm-check.mjs` | 诊断提示补 400004 / 命名空间 | 模型切换 |
| `src/lib/workflow.ts` | `judge()` 拆开 evolution 与 debt 判据 | U3 |
| `src/lib/lab/views.ts` | `getAvailability('evolution')` 区分 empty/done | U3 |
| `src/components/lab/BottomPanel.tsx` | 悬浮层 → 真实占位；修 `38vh24` 非法 CSS | U2 |
| `src/components/lab/LabShell.tsx` | 注释同步 | U2 |
| `src/components/lab/EmptyCanvas.tsx` | 移除双重偏移 | U2 |
| `src/lib/lab/layout.ts` | `activeStages` 过滤；删空列分支与 `NARROW_W` | S1 |
| `src/lib/lab/view-layout.ts` | `structureSkeleton()` 7 列 → 1 占位 | S1 |
| `src/lib/method-dna.ts` | role/description 分工 prompt + 正误示例 | S3 |
| `src/lib/method-surgery.ts` | 三字段分工 prompt | S3 |
| `src/lib/llm-mock.ts` | 手术三字段 + 四段式 why（P3 同步） | S3 / S5 |
| `src/lib/lab/surgery-summary.ts` | 修后果句被套进"因为…负责…"的病句 | S3 |
| `src/lib/crossbreeder.ts` | 四段式 prompt + `whyIsFourPart()` 结构校验 | S5 |

### 新增回归脚本

| 脚本 | 断言数 | 覆盖 |
|---|---|---|
| `scripts/verify-s1-dynamic-stages.py` | 4 场景 | S1 列数 / 无占位字样 |
| `scripts/verify-s2-block-names.cjs` | 7 | S2 名字规范化 + 展示层截断 |
| `scripts/verify-s3-three-part.cjs` | 26 | S3 三字段分工 + mock 同步 |
| `scripts/verify-s5-fourpart.cjs` | 10 | S5 四段式 + mock 不被误杀 |

加上既有的 `verify-step2.mjs`（42）与 `verify-u3-workflow.cjs`（15），
**共 96 项断言，全部通过**。

### 遇到的问题（逐个）

1. **`deepseek-flash` 400 400004** —— 需带命名空间 `deepseek/deepseek-flash`，
   已记入 3 处文档。
2. **U2 的真凶是非法 CSS `height:38vh24`** —— 字符串拼接导致，
   浏览器静默忽略、**不报错**，只读代码看不出来，靠在浏览器量几何才抓到。
3. **`pkill`/`kill` 正则匹配到自己所在的 shell** —— 改用先列 PID 再逐个 kill。
4. **`PANEL_H + 24` 这类问题无法靠类型检查发现** —— TS 层面 `string + number` 合法。
5. **`Surgery` 表缺 `provider`** —— 记录为 P11 待办（见上）。
6. **确认回归脚本的 `@/` 别名在编译产物里需要重写** ——
   tsc 会按 rootDir 摊平目录（`@/lib/lab/x` → `<outDir>/lab/x.js`），
   解析器需同时尝试原始路径与去掉 `lib/` 前缀的路径。

---

## 五、当前状态与 P11 建议

**仓库状态**：可构建、可运行、回归全绿。`.env` 指向 deepseek-flash，
`.env` 已被 `.gitignore` 忽略，**Key 未出现在任何源码或文档中**。
真模型全链路跑过一遍（DNA / 债务 / 组合 / 手术），
产出留在本地 SQLite 供人工查看。

**P11 建议按此优先级**：

1. **补 `Surgery.provider`** —— 让 mock/真模型的来源判断不再靠 confidence 反推；
2. **mock 的 role 模板化问题**（对照文档例 1）——
   mock 给 `TVR/TD/FiD/ST` 四个模块发了同一句 role。
   这不是 bug（启发式确实分不清），但可以在 UI 上**明确标注"本条为启发式推断"**，
   避免用户把它当成模型判断；
3. **组合想法的耗时（72s）值得优化** —— 目前是全池 21 模块 × 5 债务一次性喂给模型。
   三栏工作台已经支持用户预选，可考虑**默认收窄池子**（如按债务先筛候选模块），
   把首屏等待压到 30s 内。
