# P10 Step 4 · Mock 与真模型输出对照

> 本文档是 **P10 Step 4 验收**的一手证据。
> 所有内容都是**实际运行的输出**，不是设计稿或示意。
>
> - 真模型：腾讯云 TokenHub `deepseek/deepseek-flash`（在线推理，OpenAI 兼容协议）
> - Mock：`LLM_PROVIDER=mock`（本地启发式，无网络调用）
> - 采集日期：2026-09-20
> - 复现方式：见文末「复现步骤」

---

## 0. 先给结论

| 维度 | Mock | 真模型 deepseek-flash |
|---|---|---|
| **响应速度** | 即时（<100ms） | DNA 21.3s · 债务 36.1s · 组合 72.1s · 手术 22.2s |
| **Block role 的具体性** | 模板句，多个模块**共用同一句** | 每个模块各不相同，且是真正的功能职责 |
| **手术结论的立场** | 一律 `INSUFFICIENT_EVIDENCE`（不敢下判断） | 敢给 `INFEASIBLE`，并说清为什么 |
| **影响力的严重度分级** | 集中在少数几档 | 4 档拉开（SEVERE/MODERATE/MINOR） |
| **证据强度** | `confidence=0.6` + `UNCERTAIN` | `confidence=0.9` + `CONFIRMED` |
| **债务条数** | 1 条（`INSUFFICIENT`） | 5 条（3 条跨论文，`CONFIRMED`） |
| **是否编造** | 不编造（这是它的设计目标） | 找到并引用了**真实的消融实验原句** |
| **能否给出可证伪预期** | 不能 | 能（带条件与比对对象） |

**一句话**：mock 的价值是"**在没有任何模型可用时，也不说谎、也不空转**"；
真模型的价值是"**敢下判断，且判断能被原文逐条核对**"。两者定位不同、不互相替代。

---

## 例 1 · Block 名字与角色

### 1.1 Mock（`provider: mock`，`confidence=0.6`）

RAG 论文（8 个模块）的 `role` 字段，**只有 4 种取值，多个模块完全相同**：

| Block 名字 | role |
|---|---|
| `RAG (Retrieval-augmented Generation)` | 基于编码结果生成最终输出 |
| `RAG architecture` | 基于编码结果生成最终输出 |
| `DPR (Dense Passage Retriever)` | 把输入文本编码成向量表示，供后续环节使用 |
| `RAG Passages Before` | 把输入文本编码成向量表示，供后续环节使用 |
| `TVR (Two Variants RAG-Sequence)` | 负责从语料库中检索出与问题相关的段落 |
| `TD (Text Documents)` | 负责从语料库中检索出与问题相关的段落 |
| `Fusion-in-Decoder` | 负责从语料库中检索出与问题相关的段落 |
| `ST (Separately Together)` | 负责从语料库中检索出与问题相关的段落 |
| `PPD (Providing Provenance for Decisions)` | 为生成的答案提供出处，使其可追溯 |
| `GFR (General-purpose Fine-tuning Recipe)` | 定义模型的训练目标与优化方式 |
| `RRB (RAG-Sequence and RAG-Token Both)` | 用于验证方法效果的评测环节 |

> **问题**：`TVR`、`TD`、`Fusion-in-Decoder`、`ST` 这**四个语义完全不同**的模块
> 拿到了**一字不差**的 role。用户点开哪个节点看到的都是同一句话 ——
> 这不是"角色说明"，是占位符。（注意：名字本身是合格的，问题在 role。）

### 1.2 真模型 deepseek-flash（`confidence=0.9`）

Self-RAG 论文（3 个模块）的 `role`，**每个都不相同，且都是"拿掉它会失去什么"**：

| Block 名字 | role |
|---|---|
| `Reflection Tokens (Self-Reflection)` | 负责产生对检索需求与生成内容可靠性的显式判断信号。 |
| `Adaptive Retrieval Decision` | 决定何时触发检索，避免在无需检索的查询上浪费计算、并避免无关段落拖累生成质量。 |
| `End-to-End Joint Training of Retrieval-Augmented Generation and Critique Decoding` | 使按需检索与自我批判的能力被内化进同一个生成模型，而不是依赖外部独立模块。 |

对应的 `description`（讲"是什么"）与 `role`（讲"失去了什么能力"）**明确分开**：

```
【Adaptive Retrieval Decision】
description: 由模型学习得到的按需检索决策，取代 RAG 中始终执行的固定检索阶段。
role       : 决定何时触发检索，避免在无需检索的查询上浪费计算、并避免无关段落拖累生成质量。
```

> description 说的是"它由什么构成"，role 说的是"它决定了什么、拿掉会怎样"。
> 这正是 S3 给 DNA 抽取 prompt 加的那条「description 与 role 的分工」约束
> 所要求的效果 —— **实测生效**。

---

## 例 2 · 手术结论（S3 三段式）

同一个动作：**移除 RAG 论文的 `RAG (Retrieval-augmented Generation)` 模块**。

### 2.1 Mock

```
verdict        : INSUFFICIENT_EVIDENCE
blockRole      : 基于编码结果生成最终输出
lostCapability : 移除RAG (Retrieval-augmented Generation) 后，方法失去了基于编码结果生成最终输出这一环节的能力，核心流程会断在这里。
```

impact（只有 1 条，severity 一律 MODERATE）：

```
[MODERATE] 方法将不再具备「基于编码结果生成最终输出」的能力
          理由: 该模块在原文中被描述为承担「基于编码结果生成最终输出」，移除后这部分能力不再具备。
```

> mock **诚实地承认自己判不了**（`INSUFFICIENT_EVIDENCE`），这是对的；
> 但它能给的信息也就到"失去了某项能力"为止，说不出**后果有多严重**。

### 2.2 真模型 deepseek-flash

```
verdict        : INFEASIBLE          ← 敢下负面结论
evidenceStatus : CONFIRMED
证据条数        : 14

blockRole      : 把「先按输入检索到维基百科证据段落、再让 seq2seq 生成器同时以
                 参数化记忆和检索到的非参数化记忆为条件产出答案」这一检索—生成
                 联合通道封装成一个可端到端微调的框架，并由此派生出
                 RAG-Sequence / RAG-Token 两种边际化生成方式。

lostCapability : 移除后，方法整体失去了「在生成时刻调用外部非参数化知识」的能力，
                 只能退回为仅凭参数化记忆作答的闭卷 seq2seq 模型，因此无法再借助
                 检索证据达成知识密集型问答上的高准确率，也无法为答案提供检索来源。
```

六个 impact，**severity 拉开四档**：

| severity | effect（节选） |
|---|---|
| SEVERE | 在 Natural Questions、TriviaQA、WebQuestions 三个开放域问答任务上的准确率无法再保持最优水平：论文把「超越闭卷模型与 retrieve-and-extract 基线」直接归功于 RAG 本身…… |
| SEVERE | 答案的溯源能力（提供证据来源）随之消失：论文把「为决策提供依据」列为预训练语言模型尚未解决、而 RAG 试图解决的一类问题…… |
| MODERATE | 世界知识不再可更新、可扩展：原本只要替换外部文档索引就能改变模型所依赖的知识，移除后知识被重新锁死在参数里…… |
| MODERATE | 缓解幻觉的机制被削弱：论文指出参数化模型可能产生幻觉，且即使在 RAG 下、当外部语料缺失相关文档时模型仍会幻觉…… |
| MODERATE | RAG-Sequence / RAG-Token 两种生成变体在结构上不再成立…… |
| MINOR | **推理阶段的计算开销反而下降**：论文把检索步骤视为额外推理成本、限制其在延迟敏感场景的部署，移除该模块后这部分开销消失——这是一项**方向为正**的副作用，但以牺牲上述准确率与可溯源性为代价。 |

> **三个值得注意的地方：**
>
> 1. **它写出了对自己结论不利的证据**。第 6 条 MINOR 是"移除反而省算力"——
>    模型没有为了把结论说得更严重而隐掉这一条。这正是 prompt 里
>    「不要为了让用户高兴而给出乐观结论」的反向约束在起作用：
>    它同样不为了让结论**更惨**而隐瞒反向影响。
> 2. **它主动指出了自己证据的瑕疵**。`unknown` 第 2 条：
>    > 「原文中的消融针对的是『移除检索 / 非参数化记忆』，并非『移除整个 RAG 框架』；
>    > 两者高度相关但不等价……本分析把该消融作为最接近的代理证据使用。」
>
>    这是**自己给自己扣分**，属于高可信输出的标志。
> 3. **`verdict = INFEASIBLE` 有原文兜底**。引用的第 2 条证据原文是：
>    > `Ablation studies confirm that the non-parametric memory is critical: removing retrieval le…`
>
>    —— 它引的是**论文里真实存在的消融实验原句**（`confidence=0.9`, `CONFIRMED`），
>    不是编出来的。

---

## 例 3 · 演化摘要 / 债务合成

同一项目（4 篇论文）跑「债务合成」。

### 3.1 Mock

```
债务条数 : 1
标题     : 计算开销与可扩展性
状态     : INSUFFICIENT          ← 按 P2 设计，mock 一律写 INSUFFICIENT
来源论文 : 3 篇
尝试     : 1
```

### 3.2 真模型 deepseek-flash

```
债务条数 : 5（其中 3 条跨论文）
耗时     : 36.1s
```

| 债务标题 | 提及次数 | 来源论文 | 已有尝试 | 状态 |
|---|---|---|---|---|
| 检索增强模型的训练与多段落编码开销过大 | 2 | 2 | 1 | CONFIRMED |
| 推理阶段检索成本高且不可预测，难以生产部署 | 3 | 3 | 2 | CONFIRMED |
| 生成可靠性受制于外部语料与检索结果的质量 | 3 | 3 | 2 | CONFIRMED |
| 参数化知识难以溯源与更新，决策依据不透明 | 1 | 1 | 1 | UNCERTAIN |
| 自反思式训练依赖额外人工标注数据 | 1 | 1 | 0 | UNCERTAIN |

> **关键差异在于颗粒度。** mock 只给出 1 条粗颗粒的「计算开销与可扩展性」；
> 真模型把它拆成了**两条可分别动手的问题**：
> 「训练与多段落编码开销过大」（训练侧）与
> 「推理阶段检索成本高且不可预测」（推理侧）。
>
> 这个差别直接决定了下游能不能用 —— 例 4 里最好的那两条候选想法，
> 正是建立在这两条**被拆开之后**的债务上的。如果债务只有一条粗的，
> 候选想法也只能停在"降低开销"这种无法证伪的层面。

---

## 例 4 · 组合想法（S5 四段式推理链）

同样的素材池跑「组合想法」。真模型产出 3 个候选，**全部通过了四段式结构校验**。
下面完整摘录其中一条的 `why`（这是 S5 的核心交付物）：

**标题**：用 FiD 的逐段落表示槽位把相关性反思信号从"输入端硬过滤"改造成解码器侧的连续逐段落门控

**四段式 why**：

```
第 1 段（债务缺口）：
  检索段落的质量决定生成质量，固定检索与自适应检索都会混入无关段落。
  Self-RAG 用相关性反思 token 缓解，但其使用方式是"判为不相关就在解码前丢弃
  （或触发重新检索）"。这个二值丢弃有两个具体症结：(a) 一旦某段被判为相关，
  它在上下文里与真正相关的段落完全不可区分，模型若高估了某段的相关性，
  解码器没有任何手段可以事后削弱它；(b) 丢弃是硬的，边界相关的段落只能全用或全弃。
  更关键的是，在 RAG 式联合编码下，段落文本早已被融合进同一条编码序列，
  即使事后发现某段有害，也只能通过重编码或重新检索来回收……

第 2 段（模块特性）：
  FiD 的结构特性是"先分离、后融合"：每篇检索段落与问题一起被单独编码，
  得到一份属于该段落自己的表示，随后这些表示被拼接送入解码器，
  由解码器对它们联合做交叉注意力（"Each retrieved passage is encoded separately
  together with the question..."）。也就是说，解码器对每一篇段落拥有一个
  可分别寻址的表示槽位。

第 3 段（为什么能对上）：
  正因为段落表示是可分别寻址的槽位，第 1 段里缺失的那个"事后削弱手段"
  才有了物理落点：Self-RAG 的反思信号不必只被消费在输入端做成硬过滤，
  而可以转化为作用在单个槽位上的连续权重（按相关性分数缩放该段落的 key/value），
  把"接受/丢弃"变成"按可信度使用"。这同时补上两个症结——(a) 模型高估相关性时
  解码器仍可压低该段落的注意力权重……(b) 边界相关段落可以被部分保留而非被迫全弃。
  并且因为门控作用于已经算好的表示、发生在解码器侧，不需要重新编码或重新检索，
  因此不会引入第 1 段末尾那种为修复而付出的额外检索成本。

第 4 段（可验证的预期）：
  若成立，在 k=10 篇检索段落、其中插入 1–3 篇与问题高度相似但与答案无关的
  干扰段落的设定下，门控变体的 EM 应接近"用 oracle 过滤掉全部干扰段落"的上界，
  并显著高于 Self-RAG 式硬过滤；且随着干扰段落……
```

> **第 3 段是这次 S5 改造的靶心。** 注意它做了三件 mock 的模板句做不到的事：
>
> 1. **显式回指前两段**——"第 1 段里缺失的那个『事后削弱手段』才有了物理落点"、
>    "这正是第 2 段那种『单元化』特性所补的"；
> 2. **说清机制而非重述**——不是"FiD 很高效所以能解决"，而是
>    "把连续权重作用在**已算好的槽位**上，因此**不需要重编码**，所以不引入新成本"；
> 3. **给出可证伪的条件**——`k=10`、插入 `1–3` 篇干扰段落、
>    比对 `oracle 过滤上界`。这是一个能设计出实验去否证的预期，不是"性能会提升"。

对照 mock 的 `why`（同一条债务、同一个位置）：

```
①债务的缺口：「计算开销与可扩展性」卡在原方案只解决了「负责从语料库中检索出
  与问题相关的段落」这一面，没有处理它在规模上去之后才暴露的那一段。
②模块的特性：「Fusion-in-Decoder」的机制是负责从语料库中检索出与问题相关的段落，
  这一能力此前没有被放进与「计算开销与可扩展性」相同的流程里。
③为什么能对上：把「Fusion-in-Decoder」的这项能力接在「RAG…」之后，
  正好补上第①段里那段没人负责的缺口——两者出自不同论文、从未同框，
  所以这是一个尚未被验证过的接法。
④可验证的预期：若这个组合成立，在固定现有算力预算下逐步加大处理规模时，
  相对只用「RAG…」的基线应当观察到质量继续上升而不是提前持平。
```

> mock 的版本**形状合规**（四段齐全、能过 `whyIsVague`），
> 但**内容是模板套出来的**：第②段把 FiD 的机制说成"负责检索"（错的，
> FiD 的机制是融合），第③段只是把①②连起来说了一遍，没有解释机制。
>
> 这不是 mock 的缺陷，**是它的定义**：启发式没有语义理解能力，
> 它只能保证"结构不塌、不说假话"，不能保证"推理成立"。
> 这也正是为什么真模型降级到 mock 时，界面必须打「离线模式」徽标 ——
> **用户必须知道当前这条推理是模板还是真推理。**

---

## 附：Token 消耗与耗时实测

单次调用实测（deepseek-flash，TokenHub 在线推理）：

| 环节 | 耗时 | 产出 | 备注 |
|---|---|---|---|
| Method DNA 抽取 | 21.3s | 3 模块 / 12 条证据 | 完整论文，`CONFIRMED` |
| 债务合成 | 36.1s | 5 条债务（3 跨论文） | 4 篇论文 |
| 组合想法 | 72.1s | 3 个候选（全过四段校验） | 素材池 21 模块 × 5 债务 |
| 方法手术 | 22.2s | 14 条证据 | 含 Ablation 检索 |

**关于速度**：deepseek-flash 单环节 20~72s，相比 hy3 的 57s~2min 有明显改善，
但它**仍带轻量推理**（实测 `reasoning_content` 约 208 字符 / 105 reasoning tokens），
所以不是"秒回"级。`max_tokens` 仍需给足（当前 32000），
因为它与 `content` **共享预算** —— 预算被推理吃光会出现
`finish_reason: length` + `content: ""`，进而**静默降级到 mock**。
这是 Step 2 已记录在案的坑，此处再次确认其必要性。

---

## 复现步骤

```bash
# 1) 切到 mock，跑基线
LLM_PROVIDER=mock pnpm dev
curl -X POST localhost:3000/api/pipeline -H 'Content-Type: application/json' \
  -d '{"action":"dna","paperId":"<paperId>"}'    # 依次 dna/debt/crossbreed/surgery

# 2) 切到真模型（.env 里设好 LLM_PROVIDER=openai-compatible 等四项后重启）
#    注意模型名必须带命名空间：deepseek/deepseek-flash
curl -X POST localhost:3000/api/pipeline -H 'Content-Type: application/json' \
  -d '{"action":"dna","paperId":"<paperId>"}'

# 3) 若要启用 pipeline 接口，需显式设置（默认关闭）
#    ENABLE_PIPELINE_API=1
```

> `ENABLE_PIPELINE_API` 默认关闭，仅用于灌演示数据/验收；
> 生产环境不要设置。本文档的实测是在**临时开启**该开关下完成的，
> 验收结束后已移除。

---

## 三条可自动复跑的回归

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `scripts/verify-s3-three-part.cjs` | 手术结论三字段分工 + mock 同步 | 26 / 26 通过 |
| `scripts/verify-s5-fourpart.cjs` | 四段式推理链 + mock 不被误杀 | 10 / 10 通过 |
| `scripts/verify-s2-block-names.cjs` | Block 名字规范化与展示层截断 | 7 / 7 通过 |

```bash
node scripts/verify-s3-three-part.cjs
node scripts/verify-s5-fourpart.cjs
node scripts/verify-s2-block-names.cjs
```
