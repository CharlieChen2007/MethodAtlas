# P10 · Step 2 完成报告

> 两个遗留问题的修复：`en-summary` 旁路 + `suggestionFor` 改读模型输出
> 按你拍板的三个决定实施：**q-0 限 60 字 / q-1 新增 suggestion 字段 / q-2 同步补齐**

---

## 一、结论速览

| 项 | 状态 | 证据 |
|---|---|---|
| **问题 A**：`en-summary` 按数据来源分流 | ✅ 完成 | 真实数据 4/4 断言通过 |
| **问题 B**：`suggestionFor` 三级回落 | ✅ 完成 | 行为测试 33/33；真模型实测产出具体改法 |
| **P3 同步**：`llm-mock.ts` 补 suggestion | ✅ 完成 | mock 8 条 finding 全部带字段 |
| **额外发现并修复**：4 处 `maxTokens` 过小 | ✅ 完成 | 修复前静默降级到 mock，修复后 `degraded: false` |
| 生产构建 | ✅ 通过 | `pnpm build` 无错误 |
| 数据基线 | ✅ 与 P9 一致 | Paper 4 / Block 18 / Debt 1 / Idea 0 / Crash 0 / Surgery 0 / Relation 0 |

**实测 token 消耗**：10 次调用，117,860 tokens（prompt 42,830 + completion 75,030），**降级 0 次**。

---

## 二、问题 A：`en-summary` 旁路

### 2.1 问题是什么

P9 的 `en-summary.ts` 是给 **mock 时代**写的：那时 `context` / `description` 存的是**英文原句**（从论文里摘的），所以需要一套规则把英文归纳成中文（`《X》指出了「短语」`）。

接真 LLM 之后，模型**本来就输出中文**。同一套规则套上去，会把一句好好的中文再"归纳"一遍，结果更差：

| 来源 | 原始数据 | 旧行为（错） | 新行为（对） |
|---|---|---|---|
| mock | `However, RAG encodes retrieved passages jointly with the question...` | `《X》指出了「编码开销随段落数线性增长」` | 同左（不变） |
| 真模型 | `现有 RAG 方法在检索到无关段落时仍会强行生成，因为它们缺少…自我判断环节。` | `《X》指出了「生成内容的幻觉问题」` ← 把模型的分析压成了短语 | `《X》现有 RAG 方法在检索到无关段落时仍会强行生成…` ← 原样保留 |

**判定依据不能靠"文本是不是中文"猜** —— 英文论文标题、中英混排都会误判。必须知道**数据来源**。

### 2.2 怎么修的：写入时固化来源

按 **P2 原则**（按数据来源判定，不按当前配置判定），在写入时就把来源记下来。

**① Schema 新增字段**（`prisma/schema.prisma`）

```prisma
model DebtSource {
  provider String @default("")   // mock / 真实模型名
}
model Attempt {
  provider String @default("")   // 同上
}
```

> **为什么不复用 `evidenceStatus`**：`DebtSource` 与 `Attempt` 的 `evidenceStatus`
> 在 `research-debt.ts` 里**恒为 `UNCERTAIN`**（写死），它表达的是"单条证据是否逐句核对过"，
> 与"这段文字是规则拼的还是模型写的"无关。

**② 写入侧**（`src/lib/research-debt.ts`）—— 两处 create 都带上 `provider: result.provider`

**③ 视图层**（`src/lib/view-models.ts`）—— `DebtSourceView` / `AttemptView` 各加 `provider: string`

**④ 装配层**（`src/app/projects/[pid]/lab/page.tsx`）—— 透传 `provider`

**⑤ 分流函数**（`src/lib/lab/en-summary.ts`）

```ts
export function isMockSource(provider: string | undefined | null): boolean {
  const p = (provider ?? '').trim()
  if (!p) return true        // 历史数据（本字段引入前写入的）= mock 时代产物
  return p === 'mock'
}
```

> **空串按 mock 处理是最安全的选择**：历史数据的 `context` 确实是英文原句，
> 走规则归纳才是对的。这个默认值不是随手写的。

超长截断（**q-0 拍板：限 60 字**）：

```ts
const MAX_MODEL_BODY_LEN = 60

function clampChinese(text: string, max = MAX_MODEL_BODY_LEN): string {
  const t = (text || '').trim()
  if (t.length <= max) return t
  const head = t.slice(0, max)
  const lastStop = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'),
                            head.lastIndexOf('！'), head.lastIndexOf('？'))
  if (lastStop >= max * 0.4) return head.slice(0, lastStop + 1)   // 在句边界收
  const lastComma = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'))
  if (lastComma >= max * 0.5) return head.slice(0, lastComma) + '。'
  return head + '…'
}
```

> **按句边界收，不是硬截断**：`…自我判断环节。` 读起来是完整的话，
> `…自我判断环` 读起来是坏的。这个细节决定了面板文字"像不像人写的"。

**⑥ 调用点切换**（`src/lib/lab/panel.ts`）—— 3 处全部改为 `xxxBySource(..., provider)`

### 2.3 实测证据

用**数据库里的真实记录**跑 `buildPanelContent()`，并注入一条真模型数据做对照：

```
═══ 「涉及的论文」区块 ═══

《Retrieval-Augmented Generati…》承认「知识访问与更新受限」          ← 历史数据，规则归纳
《Leveraging Passage Retrieval…》指出了「编码开销随段落数线性增长」    ← 历史数据，规则归纳
《Self-RAG: Learning to Retrie…》指出了「固定段落数浪费算力」          ← 历史数据，规则归纳
《Self-RAG: Learning to Retrie…》现有的 RAG 方法在检索到无关段落时仍会
    强行生成，因为它们缺少对检索结果是否支持生成内容的自我判断环节。   ← 真模型，原样保留
```

4/4 断言通过。同一个面板里两种来源并存，各走各的路。

---

## 三、问题 B：`suggestionFor` 改读模型输出

### 3.1 问题是什么

P9 修掉了"结论通过却让你改模块"的逻辑矛盾（静态表不再无视 outcome）。但改法**内容**仍然是人工写死的通用句 —— 只要撞上 `blockConflictCheck` 的 `warn`，无论方案是什么，拿到的都是同一句：

> 「两个模块在机制上不完全兼容，但可以共存：在它们之间补一个中间层来桥接。」

**没说哪两个模块、没说插什么、没说插在哪一环。** 用户读完还是不知道从哪下手。

而模型在写 `detail` 时是**看着具体模块组合**写的，它已经知道冲突落在哪两个环节上。

### 3.2 怎么修的：三级回落

```
优先级 0  门控：pass / unknown → null（**先于一切**，包括模型输出）
优先级 1  模型给的 check.suggestion → 直接用
优先级 2  静态表 SUGGESTION_TABLE[key][outcome] → 兜底
优先级 3  NO_SPECIFIC_SUGGESTION → 最后兜底
```

> **门控为什么必须在模型之前**：模型偶尔会在 PASS 项上顺手写一句
> "可进一步…"，那是套话不是改法。收了就重新制造"结论通过却让你改"的矛盾。
> 门控没有例外。

> **优先级 1 不区分 mock/真模型**：判断依据是"这条数据里到底有没有模型写的改法"，
> 而不是"当前配置跑的是不是 mock"。这与 **P2** 一致 —— 按数据来源判定。

**空值哨兵** —— 模型说"没有"不一定写空串：

```ts
const EMPTY_SENTINELS = new Set(['', '-', '无', '暂无', 'none', 'null', 'n/a', 'na'])
```

> 只过滤明确的"空"信号，**不设长度门槛**：`换掉检索模块。` 只有 7 个字但完全有效，
> 设门槛会把短而准的改法误杀。

### 3.3 三处改动（按 q-1 拍板：新增 `suggestion` 字段）

| 文件 | 改了什么 |
|---|---|
| `src/lib/crash-test.ts` | `RawFinding` 加 `suggestion: string`；`FINDING_SPEC` 加 `suggestion: { type:'string', min:0 }`；prompt 新增【suggestion】段落；5 处持久化块写入 |
| `src/lib/view-models.ts` | `CrashCheckView` 加 `suggestion?: string` |
| `src/app/projects/[pid]/lab/page.tsx` | 解析层读 `suggestion`，**缺失时给空串不给兜底文案** |
| `src/lib/lab/crash-summary.ts` | `suggestionFor()` 重写为三级；`buildCrashConclusion` 先透传再回落 |

> **`min: 0` 是刻意的**：不强制模型必须给。校验层不拦，由读侧三级回落兜住 ——
> 这样"模型改法质量不稳"不会让整次调用判为 SCHEMA 失败。
> 强硬要求反而会让模型为了通过校验而编造套话。

> **解析层不能填兜底值**：一填就分不清"模型真的给了"和"我们替它填的"，
> 优先级 2 的回落链直接断掉。

**Prompt 侧的关键约束**（`crash-test.ts`）：

- 明确禁止通用套话，并**举反例**：`建议进一步验证` / `可以尝试优化` /
  `在二者之间加一个中间层来桥接`（没说加在哪、加什么）
- 要求写成能直接动手的动作，并**举正例**
- 明确 `level` 与 `suggestion` 的配套关系：
  - `PASS` → 必须留空 `""`
  - `CONCERN` → 必须给：怎么缓解、缓解后还剩什么风险
  - `BLOCKER` → 必须给：换掉什么或改成什么；确实救不回来就明说"建议放弃该组合"

### 3.4 P3 同步：`llm-mock.ts` 也补齐（按 q-2 拍板）

mock 的 8 条 finding 全部加上 `suggestion`，规则与模型侧一致：

- `PASS` → 空串
- `UNKNOWN` → 空串
- `CONCERN` / `BLOCKER` → 写这条结论对应的改法

> mock 的改法自然比真模型**通用**（它没有读模块细节的能力），
> 这恰恰是要展示的差异：**差异必须来自能力，不是来自格式。**

### 3.5 实测证据

**行为测试 33/33 通过**，覆盖：门控拦模型输出、空值哨兵回落、短句不被误杀、
未知检查项走兜底、P9 矛盾不复现。

**真模型端到端实测**（hy3，`evidenceStatus: CONFIRMED`）：

```
想法：Self-Reflective Retrieval with Separately-Encoded Passage Fusion

── 新颖性  level=PASS ──
   suggestion: 【空串 —— 门控正确拦截】

── 模块冲突  level=CONCERN ──
   suggestion: 将基座统一为encoder-decoder模型（如T5），在decoder端添加反射令牌预测，
   encoder端对question+passage独立编码（FiD方式）。具体：用T5-base初始化，在输入序列
   前加特殊令牌触发检索决策，decoder生成反射令牌后，对选定段落调用T5 encoder独立编码
   并拼接隐藏态给decoder交叉注意力。断开检索决策与编码的梯度耦合以避免训练不稳定。

── 数据可行性  level=CONCERN ──
   suggestion: 直接复用Self-RAG论文发布的反射令牌标注数据（如他们生成的critique数据），
   在FiD架构（T5）上微调，避免从头标注。若需新域，采用蒸馏法用大模型自动打反射标签，
   仅在小规模验证集上人工校验。

── 算力可行性  level=CONCERN ──
   suggestion: 限制检索段落数至top-5（而非100），采用T5-base（220M）而非大模型，先在
   小规模QA数据上验证概念。训练时梯度检查点+段落编码缓存，将FiD编码与反射头训练分阶段：
   先冻检索训解码融合，再联合微调。
```

**对比静态表**：

| | 模块冲突这一项给的改法 |
|---|---|
| 静态表（P9） | 「两个模块在机制上不完全兼容，但可以共存：在它们之间补一个中间层来桥接（例如在不可微检索后接一个可微重排序）。」 |
| 真模型（P10） | 「将基座统一为 encoder-decoder 模型（如 T5）…**用 T5-base 初始化**，在 decoder 端添加反射令牌预测…**断开检索决策与编码的梯度耦合以避免训练不稳定**。」 |

真模型给出了**具体的统一基座（T5-base）**、**插入位置（decoder 端反射令牌头）**、
以及**真正的风险诊断（梯度耦合导致训练不稳定）**。这是可执行的工程方案，不是方向性提示。

---

## 四、额外发现并修复的问题（重要）

### 4.1 撞车测试在读真模型时**静默降级到 mock**

第一次跑真模型撞车测试时，结果是：

```
[llm] 真模型调用失败，已降级到 mock（purpose=crash-test）：
模型「hy3」在 max_tokens=6000 内没写完：思考过程已占用 14345 字符，正式回答被截断。
```

**这个问题比"慢"严重得多**：击穿测试**静默变成了 mock 结论**。用户看到的
「模块冲突：可行」其实来自本地启发式，不是模型判断。而 Step 2 的 suggestion 改造
恰好依赖模型输出 —— 预算不够 = 模型永远给不出 suggestion = **新功能在真模型下等于没上**。

### 4.2 根因是所有调用点的 `maxTokens` 都按非推理模型估的

审计后发现 5 处都有同样的问题：

| 文件 | 修复前 | 修复后 |
|---|---|---|
| `method-dna.ts` | 32000 ✅（P10 Step1 已修） | 32000 |
| `crash-test.ts` | **6000** ❌ | 32000 |
| `method-surgery.ts` | **6000** ❌ | 32000 |
| `method-evolution.ts` | **6000** ❌ | 32000 |
| `research-debt.ts` | **8000** ❌ | 32000 |
| `crossbreeder.ts` | **6000** ❌（勉强跑过） | 32000 |

全部补上 `totalBudgetMs: 300000`。

### 4.3 修复后实测

```
llm-status:
  degraded       false
  degradedCount  0
  successCount   10
  tokens.total   117860
```

**10 次真模型调用，0 次降级。** 两个候选方案的撞车测试都拿到 `evidenceStatus: CONFIRMED`
（mock 恒为 `INSUFFICIENT`，这是区分来源的可靠信号）。

---

## 五、改了哪些文件

### 问题 A（6 个文件）
| 文件 | 改动 |
|---|---|
| `prisma/schema.prisma` | `DebtSource.provider` / `Attempt.provider` |
| `src/lib/research-debt.ts` | 2 处写入带 `provider` |
| `src/lib/view-models.ts` | 2 个 View 加 `provider` |
| `src/app/projects/[pid]/lab/page.tsx` | 透传 `provider` |
| `src/lib/lab/en-summary.ts` | `clampChinese` / `isMockSource` / 两个 `BySource` |
| `src/lib/lab/panel.ts` | 3 处调用点切换 |

### 问题 B（5 个文件）
| 文件 | 改动 |
|---|---|
| `src/lib/crash-test.ts` | `RawFinding.suggestion` + `FINDING_SPEC` + prompt + 5 处写入 + **`maxTokens` 6000→32000** |
| `src/lib/lab/crash-summary.ts` | 三级回落重写 |
| `src/lib/view-models.ts` | `CrashCheckView.suggestion?` |
| `src/app/projects/[pid]/lab/page.tsx` | 解析 `suggestion` |
| `src/lib/llm-mock.ts` | `MockFinding.suggestion` + 8 条 finding 补齐（P3） |

### 顺带修复（4 个文件）
`method-surgery.ts` / `method-evolution.ts` / `research-debt.ts` / `crossbreeder.ts` —— `maxTokens` 统一到 32000 + `totalBudgetMs`

### 新增验收脚本（2 个）
- `scripts/verify-step2.mjs` —— 42 项静态断言（结构是否接通）
- `scripts/verify-step2-realdata.cjs` —— 用真实数据库记录跑面板函数（行为是否正确）

---

## 六、验收步骤（本地）

```powershell
# 1. 停掉旧服务，清掉旧构建（避免跑在旧代码上）
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue

# 2. 安装 + 同步 schema（新增了 provider 字段，必须执行）
pnpm install --frozen-lockfile
pnpm db:push

# 3. 静态验收：应输出「通过 42 · 失败 0」
node scripts/verify-step2.mjs

# 4. 真实数据验收：应输出「通过 4 · 失败 0」
node scripts/verify-step2-realdata.cjs

# 5. 构建 + 启动
pnpm build
pnpm start
```

打开 <http://localhost:3000>（会自动跳到实验室）。建议现场验证顺序：

1. **上传一篇论文** → 观察是否**不出现**"离线模式"徽标（出现说明降级了，看日志原因）
2. **看思维导图 Block 名字** → 真模型给的是语义名（如 `Reflection Token Generation`），不是 `核心方法`
3. **跑一次撞车测试** → 看「怎么改」这一段：应该是**针对这个方案具体模块**的句子，
   而不是「在二者之间补一个中间层来桥接」这种通用句
4. **PASS 项下面不应有「怎么改」** → 这是 P9 那条矛盾修复的回归检查

---

## 七、遇到什么问题

1. **Prisma 不支持 `/** */` 块注释** —— schema 里我用了 JSDoc 风格注释，`prisma validate`
   报 15 个 "not a valid field or attribute definition"。改用 `//` 行注释后通过。
   （注释内容很长，`//` 逐行写确实更啰嗦，但 Prisma schema 只认这个。）

2. **prompt 里写反引号会破坏模板字符串** —— 我在 `SYSTEM_PROMPT`（反引号模板串）里写了
   带 `` `suggestion` `` 的说明，直接把 TS 语法搞崩。改成不加反引号后正常。
   > 这类问题的特点是**构建期就炸**，不会漏到运行时，所以不影响交付质量。

3. **静态断言脚本自己误报 3 处** —— 我把注释里的函数名算成了"残留调用"，
   把多行字符串值算漏了。修正后 42/42。**这提醒一件事：断言失败要先看是不是断言写错了**，
   否则会去改本来正确的代码。

4. **撞车测试静默降级** —— 见第四节。这个不在原计划里，是跑真模型时**实际撞出来的**，
   也是本轮最有价值的发现：如果不实测，新功能会在交付时表现为"看起来上了、实际没生效"。

---

## 八、下一步

Step 2 完成。按原定顺序，接下来是 **Step 3：你提过的 9 个问题**：

- U1 首页直达工作台 + 空项目引导页 —— 已随 P10 Step1 的 404 修复**部分完成**
- U2 `BottomPanel.tsx:68` 遮挡式布局 → 改成挤压布局
- U3 `workflow.ts` 的 `evolution` / `debt` 共用 `debts.length` 作为完成判据 → 顺序倒置的根因
- S1 动态阶段（按 **P1**：不额外调 LLM，忠实渲染实际出现过的 stage 集合）
- S2 Block 名字
- S3 手术结论三段式 prompt
- S4 真实归纳 —— **本轮 Step2 已解决**
- S5 杂交四段式推理 prompt
- S6 击穿测试推理链 + 针对性建议 —— **本轮 Step2 已解决**

> **一个待你决策的问题**：hy3 是推理模型，一篇论文要 57 秒～2 分钟，撞车测试两篇花了约 3 分钟。
> 演示时如果时间紧，可考虑的替代（你的 Key 上都可用）：
> `deepseek/deepseek-flash`、`glm-5.3-flash` —— 非推理模型，改 `LLM_MODEL` 一行即可，
> 而且不需要 32000 的预算。要不要我在 Step 3 里顺便做一个速度对照？
