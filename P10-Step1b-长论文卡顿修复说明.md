# P10-Step1b 修复说明：长论文卡顿 + 降级到离线模式

> **一句话：这不是正常现象，是我引入的 bug。已修，并实测验证。**
>
> 你的日志把根因指得非常准确，我不用再猜。

---

## 一、病因：三个问题叠在一起

你贴的日志：

```
[llm] 真模型调用失败，已降级到 mock（purpose=method-dna-extraction）：
模型「hy3」的思考过程占满了 max_tokens=8000，正式回答被截断
（reasoning_content 长度 28426）
```

| # | 问题 | 说明 |
|---|---|---|
| 1 | **`maxTokens=8000` 装不下推理模型** | `hy3` 的 `reasoning_content`（思考）与 `content`（回答）**共享**这个预算。你的论文思考烧了 28426 字符，8000 tokens 早已耗尽，`content` 是空串 |
| 2 | **失败后还重试 3 次** | `callLLMStructured` 默认 `maxAttempts=3`。截断是**确定性失败** —— 同样的 prompt 同样的预算，重试 3 次结果必然一样，纯粹让用户多等两轮完整推理 |
| 3 | **每次调用各自 120 秒超时，没有总预算** | 3 次 × 120 秒 = 最坏 360 秒。界面全程无反应，看起来就是"卡死" |

所以你观察到的「卡顿很久 → 进入离线模式」，三个环节全部对上。

### 为什么之前那篇论文没事

我用 `scripts/llm-check.mjs` 探测了 `hy3` 在**同一套 prompt**下的开销：

| 输入规模 | 推理 tokens | 总完成 tokens | 耗时 |
|---|---|---|---|
| ~500 字符 | 0（不推理） | 539 | 4.7s |
| ~6000 字符 | 5678 | 6350 | 41s |
| ~24000 字符（当前截断上限） | 5291 | 5887 | 35s |

**正常情况下推理稳定在 5-6k tokens。** 你那次飙到 28426 是**异常值** ——
新论文的某些内容让 hy3 陷入了反复纠结。

这恰恰说明：**光把数字调大是治标**。真正的病是"截断后还要白重试 3 次"。

### 顺带科普：那两个 Warning 无害

```
Warning: TT: undefined function: 21
Warning: Bad value, for key "Trapped", in Info: False.
```

这是 pdfjs 解析 PDF 内嵌字体表时的常见提示 —— **不是错误**，
PDF 里字体缺了某些表项而已，正文照常提取。可以忽略。

---

## 二、修了什么（4 处）

### 1. `maxTokens` 8000 → 32000

`src/lib/method-dna.ts`。32000 对齐主流推理模型的 `max_tokens` 上限，
能容纳正常量级的思考（实测 5-6k，留足余量）。

### 2. 新增 `TRUNCATED` 错误类型 —— 截断**立刻失败**，不重试

`src/lib/llm.ts`。新增：

```ts
const NON_RETRYABLE = new Set(['TRUNCATED', 'RATE_LIMIT'])
export function isRetryable(err: unknown): boolean { ... }
```

在 `callLLMStructured` 的 catch 里：

```ts
if (!isRetryable(err)) throw err   // 立刻抛，不再开下一轮
```

**限流（429）也归入不可重试** —— 立刻重试通常还是限流，只会加重对方压力。

### 3. 新增总时间预算 `totalBudgetMs`

不再是"每次 120 秒 × 3 次"，而是**整体不超过一个预算**：

```
LLM_TOTAL_BUDGET_MS=240000   # 默认 4 分钟，可配
method-dna 单独设 300000     # 5 分钟（推理模型慢）
```

超了就直接失败，并把"已经跑了几次、最后错在哪"如实报出来。

### 4. 界面显示**实时耗时**，不再是一动不动的等待

`src/components/lab/ActionBar.tsx`。pending 期间每秒刷新：

```
● 正在上传「xxx.pdf」→ 解析 PDF 文本 → 抽取方法 DNA…   已等待 1 分 23 秒
  方法结构抽取由语义模型完成，一篇论文通常需要 30 秒～2 分钟，
  请勿关闭页面或重复提交。
```

这个计数器没有"进度"含义，但它诚实地传达了一件关键的事：
**系统还活着，还在等模型。** 成本极低，消除的困惑很大 ——
原来的静止界面会让用户以为卡死，然后去刷新页面、重复提交。

---

## 三、实测验证

### 修复后跑同一篇论文

```
POST /api/pipeline {"action":"dna","paperId":"cmu74f31j0002byx6q492knjc"}

→ {"step":"method-dna","ok":true,"message":"抽取到 3 个方法模块，9 条证据（CONFIRMED）"}
```

```
总耗时: 57 秒
calls: 1                    ← 一次通过，零重试
tokens: prompt 1432 / completion 8762 / total 10194
degraded: false
```

**对比修复前**：3 次重试 × 每次烧满推理。现在 **1 次调用、57 秒、10k tokens**。

### 降级路径仍然完好

用无效 Key 复测：徽标正常亮起、`degraded:true`、业务接口仍返回 `ok:true`（页面不崩）。

---

## 四、性能参考（心里有个数）

| 场景 | 耗时 | tokens |
|---|---|---|
| 短论文（<2000 字符） | 5-10 秒 | ~500-1000 |
| **正常论文（已实测）** | **57 秒** | **~10k** |
| 长论文（接近 24000 字符上限） | 35-90 秒 | ~6-12k |
| 异常情况（模型反复纠结） | 最长 5 分钟后失败 | — |

`hy3` 是**推理模型**，为"想很久"而生。MethodAtlas 做的是**从论文里结构化抽取字段**，
属于"读得准"而不是"想得深"—— 这个任务用推理模型是**杀鸡用牛刀**。

想快的话，`.env` 里 `LLM_MODEL` 换成你可用列表里的：
`deepseek/deepseek-flash` 或 `glm-5.3-flash`（都是非推理，秒级响应）。
一行配置的事，代码不用动。

---

## 五、你要做的

```bash
pnpm install --frozen-lockfile
pnpm start
```

打开 `http://localhost:3000/`。

### 重点验证这一条

**上传一篇全新的长论文**，观察：

1. 顶部提示条是否**每秒在跳**「已等待 N 秒」
2. 是否在 1-2 分钟内出结果（而不是等 3 分钟然后离线）
3. 如果还是降级了，把服务端日志贴给我 —— 现在错误信息会明确区分
   「截断」/「超时」/「限流」/「网络」，不再是含糊的一句失败

### 如果又出现截断

说明 32000 也不够（罕见），日志会明确告诉你是截断而不是别的。
那时我们再看两件事：是否要改用非推理模型，或是否要把论文正文
的截断上限（当前 24000 字符）调小 —— **输入越短，思考开销越小**。

---

## 六、这一轮改了哪些文件

| 文件 | 改动 |
|---|---|
| `src/lib/llm.ts` | 新增 `TRUNCATED` 类型 + `isRetryable()`；截断/限流不再重试；新增 `totalBudgetMs` 总预算；截断报错区分"思考吃光预算"与"输出被截断" |
| `src/lib/method-dna.ts` | `maxTokens` 8000 → **32000**；`totalBudgetMs` 300000 |
| `src/components/lab/ActionBar.tsx` | pending 期间**实时显示已等待时长** + `hint` 说明字段 |
| `src/components/lab/LabShell.tsx` | 上传时传入 hint（"通常 30 秒～2 分钟，请勿重复提交"） |

**没动**：`prisma/schema.prisma`、业务逻辑、任何 Prompt。

---

## 七、基线数据

`prisma/dev.db` 已回滚到 **P9 干净基线**：

```
Paper 4 · MethodBlock 18 · ResearchDebt 1
CandidateIdea 0 · CrashTest 0 · Surgery 0 · Relation 0
```

---

## 八、请反馈

1. **上传长论文**：顶部提示条有没有在跳秒数？多久出结果？
2. 如果又降级了 —— **贴服务端日志**（现在会明确说是哪种失败）
3. 想不想换更快的模型？（`hy3` 57 秒/篇，演示时的体感差别很大）

确认后我做 **Step 2**（`en-summary` 旁路 + `suggestionFor` 改读模型输出）。
