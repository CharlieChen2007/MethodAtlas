# P10-Step1 本地验证指引（v3 · 已实测连通）

> **结论先说：真 LLM 已经跑通了。** 我把正确的端点和 Key 都写进了 `.env`，
> 你解压后直接 `pnpm start` 就能用，**不需要再配任何东西**。

---

## 一、之前为什么一直 401 —— 根因找到了

**TokenHub 有两个互不通用入口，Key 也不通用。** 你截图里那把 Key 是在
「**API Key 管理**」页创建的，属于**在线推理**线；而我上一版给你的
`api.lkeap.cloud.tencent.com/plan/v3` 是 **Token Plan 订阅**线。

| 入口 | Base URL | Key 从哪来 |
|---|---|---|
| **在线推理（按量）** | `https://tokenhub.tencentmaas.com/v1` | TokenHub → **API Key 管理** ← **你的 Key 属于这里** |
| Token Plan（包月） | `https://api.lkeap.cloud.tencent.com/plan/v3` | TokenHub → **Token Plan** 页 |

**最坑的地方**：用错入口时 `api.lkeap` 返回的 401 是
`{"code":"not_authorized"}`，而且**不带任何 Key 也是同样的错误** ——
它完全不会提示你"该去哪个控制台取密钥"。我上一版让你"确认 Key 完整"，
方向就是错的，抱歉。

**已修正**：`.env` 里的 `LLM_BASE_URL` 改成了 `tokenhub.tencentmaas.com/v1`，
Key 也填好了。`scripts/llm-check.mjs` 的探测集也换成了这两个真实入口。

---

## 二、实测证据（这次是真的连通，不是降级）

### `node scripts/llm-check.mjs`

```
② 真实调用
   POST https://tokenhub.tencentmaas.com/v1/chat/completions
   → HTTP 200  ·  1446ms
③ 结果：✓ 连通成功
```

`GET /v1/models` 也通了，账号下 **online** 的模型包括：
`hy3`、`hy4-preview`、`glm-5.3` 系列、`deepseek-v4-pro`、`kimi-k3`、
`minimax-m3`、`mimo-v2.5-pro` 等 100+ 个。

### 真实跑一遍 DNA 抽取

```
POST /api/pipeline {"action":"dna","paperId":"cmu74f31j0002byx6q492knjc"}

→ {"step":"method-dna","ok":true,
   "message":"抽取到 3 个方法模块，8 条证据（CONFIRMED）"}
```

耗时 **108 秒**（hy3 是推理模型，慢但质量高）。`/api/llm-status`：

```json
{
  "degraded": false,
  "degradedReason": null,
  "successCount": 2,
  "degradedCount": 0,
  "tokens": { "prompt": 2993, "completion": 14342, "total": 17335 },
  "byPurpose": {
    "method-dna-extraction": { "calls": 2, "promptTokens": 2993, "completionTokens": 14342 }
  }
}
```

**`degraded: false` + `tokens.total: 17335` = 真模型确实被调用了。**

### 质量对比（这是最有说服力的部分）

同一篇 Self-RAG 论文，mock 与 hy3 的抽取结果：

| | mock | **混元 hy3（真实）** |
|---|---|---|
| 模块名 | `核心方法`、`编码器`、`RAG architecture` | `Reflection Token Generation`<br>`Adaptive Retrieval Decision`<br>`Integrated Architecture` |
| 证据状态 | `UNCERTAIN` | **`CONFIRMED`** |
| task | 泛化描述 | 「引入 Self-RAG 框架，训练语言模型自适应检索并借助反射令牌反思生成。」 |
| problem | 泛化描述 | 「大型语言模型常产生无事实支持的响应，尤其在知识密集型任务上。」 |

**Block 名字这一条**：mock 给的是"核心方法/编码器"这类模板词，
hy3 给的是 `Reflection Token Generation`（反射令牌生成）这种
**真正抓到了论文技术点的命名**。你提的「Block 名字不要粗暴截断」问题，
根因就在这里 —— mock 的名字本来就没信息量，截不截都难看。
接上真模型后这一步**自动改善**，Step 3 只需要处理显示层的截断策略。

### 界面侧

浏览器实测：**没有出现降级徽标**（正确 —— 只有失败时才显示），
控制台 **0 错误**。截图见 `p10-real-llm.png`。

---

## 三、顺手修掉的一个真问题：推理模型被 `max_tokens` 截断

hy3 这类推理模型会先输出 `reasoning_content`（思考过程），再输出
`content`（正式回答）。**如果 `max_tokens` 被思考过程吃光，`content` 就是空串。**

我实测到了：`max_tokens: 8` 时返回
`{"content":"", "reasoning_content":"用户要求只输出…"}` ——
这种情况原来会被判成"LLM 返回内容为空"，**完全看不出是被长度截断的**。

**已修**（`src/lib/llm.ts`）：现在会明确报出

```
模型「hy3」的思考过程占满了 max_tokens=xxx，正式回答被截断
（reasoning_content 长度 N）。请调大 maxTokens 后重试。
```

---

## 四、你解压后要做什么

**只有两步：**

```bash
pnpm install --frozen-lockfile   # 本包已含 .next，可以跳过 build
pnpm start
```

然后打开 **`http://localhost:3000/`** —— 会直接跳进画布
（根路径 404 的问题也一起修了）。

想自己验一下连通：

```bash
node scripts/llm-check.mjs       # 不用起服务，3 秒出结果
```

### 三个已知提示，都不是问题

| 提示 | 要不要管 |
|---|---|
| `ERR_PNPM_IGNORED_BUILDS`（prisma） | **不用管**。pnpm 10 的安全策略，`prisma generate` 在 `db:push`/`build` 里已显式执行 |
| `The "pnpm" field is no longer read` | 不用管。配置迁移提示，无功能影响 |
| `Update available 5.22.0 -> 8.0.0` | **别升**。Prisma 5 → 8 是大版本跨越，会破坏 schema |

---

## 五、这一版改了哪些文件

| 文件 | 改了什么 |
|---|---|
| `.env` | **端点改正** → `tokenhub.tencentmaas.com/v1`；Key 已填；补上两个入口的差异说明 |
| `.env.example` | 同步，说明两个入口的 Key 不通用 |
| `src/lib/llm.ts` | ① 未知 provider **显式报错** ② `callLLM()` **三段式降级** ③ 运行状态（降级标记 + token 计数）④ **推理模型截断显式报错** |
| `src/app/api/llm-status/route.ts` | **新增**，降级状态 + token 统计 |
| `src/components/lab/CanvasStage.tsx` | **新增「离线模式」琥珀色徽标** |
| `src/components/lab/LabShell.tsx` | 每 5 秒轮询降级状态，拿到就停 |
| `src/app/page.tsx` | **修根路径 404**：`redirect` → 动态落点页（顺带做了 U1 首页直达） |
| `scripts/llm-check.mjs` | **新增**：连通性自检 + 端点横比诊断 |
| `check-dir.mjs` | 输出同步；补上 `ERR_PNPM_IGNORED_BUILDS` 与根路径 404 说明 |
| `README.md` | 兼容端点表更新 + 两条警告 |

**没动**：`prisma/schema.prisma`、任何业务逻辑、任何 Prompt。

---

## 六、两个关键设计（你定的，我照做）

### 1. `LLM_PROVIDER` 写错不再静默降级

旧代码 `provider === 'openai-compatible' ? ... : 'mock'` —— 任何不认识的值
都**静默变成 mock**。`LLM_PROVIDER=deepseek` / `OpenAI-Compatible` /
`openai_compatible` 三种写法**全都会安静地跑 mock**。
在一个讲可信度的工具里，这是最危险的 bug。现在白名单校验，不认识就抛 `CONFIG` 错。

### 2. 降级必须**可见**

```
① provider=mock        → 直接用 mock（正常路径，不算降级，不显徽标）
② provider=真 LLM，成功 → 用真结果（记 token，不显徽标）  ← 当前状态
③ provider=真 LLM，失败 → 落 mock 兜底 + 日志 + 徽标亮起
```

徽标在画布左上角（避开右上角"方法手术"按钮），悬停看原因。
**不打断体验，但绝不隐藏。**

---

## 七、基线数据

`prisma/dev.db` 已回滚到 **P9 干净基线**（我测试产生的数据已清掉）：

```
Paper 4 · MethodBlock 18 · ResearchDebt 1
CandidateIdea 0 · CrashTest 0 · Surgery 0 · Relation 0
```

> 备份：`cp prisma/dev.db prisma/dev.db.bak`

---

## 八、性能提醒

`hy3` 是**推理模型**，一次 DNA 抽取要 **~108 秒**、**17k tokens**。
你连续跑几次验收的话：

- 慢是正常的，不是卡死（`LLM_TIMEOUT_MS=120000` 够用）
- 想快：`.env` 里 `LLM_MODEL` 换成 `hy3` 之外的轻量模型，
  比如 `deepseek/deepseek-flash` 或 `glm-5.3-flash`（都在你的可用列表里）
- 演示前建议先跑一次预热，避免评委面前等两分钟

---

## 九、请反馈

1. 解压后 `pnpm start` + 打开 `http://localhost:3000/` —— **能不能正常进**
2. 想不想换更快的模型（`hy3` 108 秒/次，演示可能偏慢）
3. `p10-real-llm.png` 里那种真实 Block 名字，你看着还行吗
   —— 这直接决定 Step 3 里「名字别粗暴截断」怎么改

确认后我做 **Step 2**（`en-summary` 旁路 + `suggestionFor` 改读模型输出）。
