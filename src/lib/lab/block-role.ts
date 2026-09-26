/**
 * Block 角色提炼 —— 问题 2 的核心逻辑。
 *
 * ── 为什么单独成一个模块 ──
 *
 * 这段规则有两个消费者：
 *   1. 数据层（llm-mock.ts）—— DNA 抽取时给每个 Block 写 role；
 *   2. 维护脚本（scripts/reseed-roles.mjs）—— 刷新存量 Block 的 role。
 *
 * 放在 llm-mock.ts 里时，脚本没法直接引用（那是 TS，脚本是纯 JS）。
 * 抽出来之后两边共用同一份规则，**不会出现"代码更新了但脚本还用旧规则"**。
 *
 * ── 原来的做法为什么必须废掉 ──
 * role 曾是写死的三选一模板：
 *     '【演示推断】从论文方法描述句中拆出的通用组件'
 *     '【演示推断】从论文方法描述句中识别出的组件'
 *     '【演示推断】未能识别为专用组件，按原文方法句兜底抽取'
 * 跟句子内容完全无关。实测 20 个 Block 只有 2 种 role —— 用户点开哪个节点
 * 看到的都是同一句话，这不是"角色说明"，是占位符。
 *
 * ── 现在的做法 ──
 * 从描述句里**找真正的功能动作**，映射成一句人话角色。命中不了就返回空字符串，
 * 由前端显示「未抽取到角色信息」。**宁可为空，也不编。**
 *
 * 规则按功能语义分组，而非照抄关键词顺序：一句话可能同时提到检索和编码
 * （"retriever ... bi-encoder architecture"），取"最像主语在做的事"的那个。
 * 所以顺序 = 该动作在方法流程中的主导性：检索 > 编码 > 生成 > 训练 > 评估 > 溯源。
 */
export function deriveBlockRole(sentence: string): string {
  const s = (sentence || '').toLowerCase()

  /**
   * ── 规则顺序很重要：先判"这句话在讲什么环节"，再判"涉及哪个组件" ──
   *
   * 第一版按「检索 > 编码 > 生成 > …」排，结果大量误判：
   *   · "RAG-Sequence and RAG-Token both achieve state-of-the-art results"
   *     —— 这是**评测结果**，却因为句子里有 retrieval 相关词被判成"检索"；
   *   · "introduce general-purpose fine-tuning recipe"
   *     —— 这是**训练**，同样被判成"检索"。
   *
   * 根因：`retriev` 在 RAG 类论文里几乎无处不在，它出现在句子里 ≠ 这句话
   * 在说"这个模块负责检索"。所以要先排除那些**整体语义明显属于其它环节**的
   * 句子（结果/评测、训练目标），再判断组件动作。
   */

  // ⓪ 先排除"结果陈述句" —— 这类句子讲的是效果，不是模块职责
  //    （"achieve state-of-the-art results" / "outperforms X on Y"）
  const isResultSentence =
    /\b(achieve|outperform|surpass|improve[sd]?|yield|obtain)\w*\b/.test(s) &&
    /\b(result|performance|accuracy|score|state-of-the-art|sota|baseline)\w*\b/.test(s)
  const isEvalSentence = /\b(evaluat|benchmark|test set|ablation|metric|dataset)\w*\b/.test(s)
  if (isEvalSentence && !/\b(we (?:introduce|propose|present))\b/.test(s)) {
    return '用于验证方法效果的评测环节'
  }

  // ① 训练 / 微调 —— 必须排在检索之前：
  //    "introduce general-purpose fine-tuning recipe" 这种句子也提 retrieval，
  //    但它的**主旨**是训练方法。
  if (
    /\b(fine-?tun\w*|finetun\w*|training recipe|train(?:ing)?\s+(?:the|a|our)|optimiz\w*|loss function|objective)\b/.test(
      s
    )
  ) {
    return '定义模型的训练目标与优化方式'
  }

  // ② 检索 —— 要求"主动检索"的表述，而不是仅仅出现 retrieval 字样。
  //    判据：动词在前（retrieve/fetch/obtain）+ 宾语是段落/文档类
  if (
    /\b(retriev\w+\s+(?:relevant|top|the|a|passages?|documents?|text)|fetch(?:es|ing)?\s+(?:the\s+)?(?:top|relevant|passages?|documents?)|use[ds]? to retrieve)\b/.test(
      s
    )
  ) {
    return '负责从语料库中检索出与问题相关的段落'
  }

  // ③ 并行/独立编码 —— 强调"分开处理再合并"这一机制
  if (/\b(encod\w+\s+(?:each|separately|independently)|independently\s+encod|encoded separately)\b/.test(s)) {
    return '把检索到的每个段落独立编码，避免相互干扰'
  }

  // ④ 一般的编码
  if (/\b(encoders?|encoding|embed\w*|bi-encoder)\b/.test(s)) {
    return '把输入文本编码成向量表示，供后续环节使用'
  }

  // ⑤ 解码 / 生成 —— 负责出答案
  if (/\b(decoders?|decoding|seq2seq|sequence-to-sequence|generat\w+)\b/.test(s)) {
    return '基于编码结果生成最终输出'
  }

  // ⑥ 检索（宽口径兜底）—— 走到这里说明前面没命中，
  //    但仍出现 retrieval 字样：给一个更保守的说法。
  if (/\b(retriev\w*|retrieval-augmented|dense passage)\b/.test(s)) {
    return '属于检索环节的一部分'
  }

  // ⑦ 溯源 —— 负责让答案可追溯
  if (/\b(provenance|attribut\w+|cite|source document)\b/.test(s)) {
    return '为生成的答案提供出处，使其可追溯'
  }

  // ⑧ 注意力机制
  if (/\battention\b/.test(s)) {
    return '在序列内部建立词与词之间的关联权重'
  }

  // ⑨ 预处理
  if (/\b(tokeniz\w*|preprocess\w*|pre-process\w*|chunk\w*|segment\w*)\b/.test(s)) {
    return '把原始输入切分、规范化，为后续处理做准备'
  }

  // 提炼不出来 —— 返回空，让前端如实显示"未抽取到角色信息"。
  // 绝不返回模板句：一句对所有节点都一样的"角色"，等于没给信息。
  return ''
}

/** 前端在 role 为空时显示的文案（集中一处，避免各组件各写各的） */
export const ROLE_EMPTY_HINT =
  '未抽取到角色信息 —— 该模块的描述句未包含可提炼的功能说明。'
