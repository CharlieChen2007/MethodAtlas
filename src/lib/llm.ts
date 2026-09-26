/**
 * 统一 LLM Provider 接口
 *
 * 设计原则（来自项目要求）：
 *   1. 不绑定任何具体模型 —— provider / model / endpoint 全部由环境变量决定
 *   2. 所有调用统一返回结构化 JSON，由调用方给出 JSON Schema 做校验
 *   3. 失败可重试，重试时把校验错误回灌给模型，要求它修正
 *   4. 不做任何静默兜底 —— 校验不过就抛错，绝不写入脏数据
 *   5. **但调用层必须有容错** —— 真模型不可用时自动降级到 mock，页面不崩。
 *      降级会打日志 + 置运行状态标记（UI 显示「离线模式」徽标），
 *      详见 `callLLM()`。注意第 4 条讲的是"不写脏数据"，第 5 条讲的是
 *      "不崩页面"，两者不矛盾：降级后的数据由 mock 生成，会被如实标注来源。
 *
 * 支持的 provider：
 *   - openai-compatible：任何兼容 OpenAI /chat/completions 协议的服务
 *     （OpenAI、DeepSeek、通义千问、腾讯云 TokenHub、Moonshot、
 *       vLLM、Ollama、One-API 等）
 *   - mock：本地启发式抽取，用于无 API Key 时跑通链路 / 演示 / 测试，
 *           同时作为真模型失败时的兜底路径
 *
 * 环境变量：
 *   LLM_PROVIDER   = openai-compatible | mock      （默认 mock）
 *   LLM_MODEL      = 模型名，如 hy3 / gpt-4o-mini / deepseek-flash
 *   LLM_API_KEY    = API Key
 *   LLM_BASE_URL   = 接口地址，如 https://api.lkeap.cloud.tencent.com/plan/v3
 *   LLM_TIMEOUT_MS = 单次请求超时（默认 120000）
 *
 * ⚠️ LLM_PROVIDER 只接受上面两个值。写别的值会抛 CONFIG 错并降级 ——
 *    这是刻意的，"拼错 provider 却以为接上了真模型"是最危险的失败模式。
 */

export type LLMRole = 'system' | 'user' | 'assistant'

export interface LLMMessage {
  role: LLMRole
  content: string
}

export interface LLMCallOptions {
  messages: LLMMessage[]
  /** 期望模型返回 JSON；为 true 时启用 JSON 模式并做解析校验 */
  jsonMode?: boolean
  temperature?: number
  maxTokens?: number
  /** 调用用途标签，仅用于日志 */
  purpose?: string
}

export interface LLMResult {
  /** 原始文本响应 */
  text: string
  provider: string
  model: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'CONFIG'
      | 'NETWORK'
      | 'RATE_LIMIT'
      | 'BAD_RESPONSE'
      | 'SCHEMA'
      | 'TRUNCATED'
      | 'UNKNOWN'
  ) {
    super(message)
    this.name = 'LLMError'
  }
}

/**
 * 这两类错误重试**没有任何意义**，重试只会让用户多等一遍同样的时长：
 *
 *   · TRUNCATED —— 模型被 max_tokens 截断。同样的 prompt + 同样的预算，
 *                  结果必然一样。要修的是预算，不是重试。
 *   · RATE_LIMIT —— 限流。立刻重试通常还是限流，且会加重对方压力。
 *
 * 真实的教训：一篇长论文触发 TRUNCATED 后，原代码会重试 3 次，
 * 每次都烧满一次完整的推理（实测单次 30~110 秒），用户干等 3 分钟，
 * 最后看到的却只是"降级到 mock"。**失败要失败得快。**
 */
const NON_RETRYABLE: ReadonlySet<string> = new Set(['TRUNCATED', 'RATE_LIMIT'])

export function isRetryable(err: unknown): boolean {
  if (!(err instanceof LLMError)) return true
  return !NON_RETRYABLE.has(err.kind)
}

// ===================== Provider 配置读取 =====================

export interface LLMConfig {
  provider: 'openai-compatible' | 'mock'
  model: string
  apiKey: string
  baseUrl: string
  timeoutMs: number
}

/** LLM_PROVIDER 的合法取值 */
const VALID_PROVIDERS = ['mock', 'openai-compatible'] as const

/**
 * 读取 LLM 配置。
 *
 * ── 为什么未知 provider 必须抛错（而不是静默落回 mock）──
 *
 * 旧实现是一行三元：
 *     provider: provider === 'openai-compatible' ? 'openai-compatible' : 'mock'
 * 任何**不等于** `openai-compatible` 的字符串都会被无声地当成 mock ——
 * 不报错、不警告、日志里也不提。后果非常隐蔽：
 *
 *     LLM_PROVIDER=deepseek          → 一直用 mock，用户以为接上了
 *     LLM_PROVIDER=OpenAI-Compatible → 大小写不对，仍然落回 mock
 *     LLM_PROVIDER=openai_compatible → 下划线而非连字符，仍然落回 mock
 *
 * 这三行都会"看起来配置好了、程序也照常跑"，但所有输出都是启发式假数据。
 * 在一个"可信度优先"的科研工具里，这是最危险的一类 bug —— **它不失败，
 * 它只是安静地说谎**。所以改成显式白名单校验 + 抛 CONFIG 错。
 *
 * 注意：这里抛错不会让页面崩 —— `callLLM()` 会捕获并降级到 mock（见下）。
 * 抛错的目的是**让日志里留下明确的配置错误**，而不是静默。
 */
export function getLLMConfig(): LLMConfig {
  const raw = (process.env.LLM_PROVIDER || 'mock').trim()

  if (!(VALID_PROVIDERS as readonly string[]).includes(raw)) {
    throw new LLMError(
      `LLM_PROVIDER 取值非法：「${raw}」。只接受 ${VALID_PROVIDERS.join(' | ')}。` +
        `若想接入 DeepSeek / 通义千问 / 腾讯云 TokenHub 等 OpenAI 兼容服务，` +
        `请填 openai-compatible，再用 LLM_BASE_URL 指定端点。`,
      'CONFIG'
    )
  }

  return {
    provider: raw as LLMConfig['provider'],
    model: (process.env.LLM_MODEL || 'mock-model').trim(),
    apiKey: (process.env.LLM_API_KEY || '').trim(),
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 120000),
  }
}

/**
 * 是否已配置可用的 LLM。
 *
 * 注意：`getLLMConfig()` 现在会对非法 provider 抛错，所以这里必须包一层 ——
 * 这个函数的语义是"能不能用"，不是"配置对不对"，不该因为配置写错就把调用方炸掉。
 * 配置非法时返回 false（等同于"没有可用配置"），由 callLLM 负责降级。
 */
export function isLLMConfigured(): boolean {
  let cfg: LLMConfig
  try {
    cfg = getLLMConfig()
  } catch {
    return false
  }
  if (cfg.provider === 'mock') return true
  return Boolean(cfg.apiKey && cfg.baseUrl)
}

// ===================== 低层调用 =====================

async function callOpenAICompatible(
  cfg: LLMConfig,
  opts: LLMCallOptions
): Promise<LLMResult> {
  if (!cfg.apiKey) {
    throw new LLMError(
      '未配置 LLM_API_KEY。请在 .env 中设置 LLM_API_KEY，或把 LLM_PROVIDER 设为 mock 以使用本地演示数据。',
      'CONFIG'
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens,
        ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    })

    if (res.status === 429) {
      throw new LLMError('LLM 接口限流（429），请稍后重试或切换模型。', 'RATE_LIMIT')
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new LLMError(
        `LLM 接口返回 ${res.status}: ${body.slice(0, 500)}`,
        'BAD_RESPONSE'
      )
    }

    const data = await res.json()
    const msg = data?.choices?.[0]?.message
    const text: string = msg?.content ?? ''

    if (!text) {
      /**
       * 推理型模型（如混元 hy3、DeepSeek-R1 系）先输出 reasoning_content
       * （思考过程），再输出 content（正式回答）。**两者共享 max_tokens 预算。**
       *
       * 所以当预算不足时，思考过程会把额度吃光，content 直接是空串 ——
       * 而 finish_reason 只是 'length'，看上去像"内容为空"。
       * 实测：同一套 prompt 在输入 1000 字符时思考只用 3.5k tokens，
       * 换成长论文可能涨到 28k，于是 8000 的预算全部被思考吃掉。
       *
       * 报错必须把"是哪种情况"说清楚，否则用户只会看到
       * "调用失败"，完全想不到要调 maxTokens。
       */
      const reasoning: string = msg?.reasoning_content ?? ''
      const finish = data?.choices?.[0]?.finish_reason ?? ''
      const budget = opts.maxTokens ?? '(未设置)'

      if (finish === 'length') {
        // kind 用 TRUNCATED —— 让上层知道"重试无用"，直接失败得更快
        throw new LLMError(
          reasoning
            ? `模型「${cfg.model}」在 max_tokens=${budget} 内没写完：` +
              `思考过程已占用 ${reasoning.length} 字符，正式回答被截断。` +
              `请调大 maxTokens（推理模型建议 ≥32000），或改用非推理模型。`
            : `模型「${cfg.model}」的回答在 max_tokens=${budget} 处被截断（未收到完整输出）。` +
              `请调大 maxTokens。`,
          'TRUNCATED'
        )
      }

      throw new LLMError('LLM 返回内容为空。', 'BAD_RESPONSE')
    }

    return {
      text,
      provider: cfg.provider,
      model: cfg.model,
      usage: {
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens,
      },
    }
  } catch (err) {
    if (err instanceof LLMError) throw err
    if ((err as Error).name === 'AbortError') {
      throw new LLMError(`LLM 请求超时（${cfg.timeoutMs}ms）。`, 'NETWORK')
    }
    throw new LLMError(`LLM 网络请求失败: ${(err as Error).message}`, 'NETWORK')
  } finally {
    clearTimeout(timer)
  }
}

// ===================== 降级状态与用量统计 =====================

/**
 * 进程级运行状态 —— 降级标记 + Token 累计。
 *
 * ── 为什么放在模块作用域而不是数据库 ──
 *
 * 这两样东西都是**运行期观测数据**，不是业务数据：
 *   · 降级标记回答"此刻这个进程还在用真模型吗"
 *   · 用量统计回答"这次演示烧了多少 token"
 * 它们没有历史价值，也不需要跨进程共享，引入一张表属于过度工程。
 * 进程重启即归零，这恰好是演示场景想要的语义。
 *
 * ⚠️ Next.js dev 模式下模块可能被多次求值（HMR），累计值可能偏小。
 *    这是可接受的 —— 它服务于"量级感知"，不是计费凭证。
 */
interface LLMRuntimeState {
  /** 是否发生过降级（真 LLM 失败 → 落 mock） */
  degraded: boolean
  /** 降级原因（取最后一次），供日志与诊断使用 */
  degradedReason: string | null
  /** 降级发生时间 */
  degradedAt: string | null
  /** 成功完成的真 LLM 调用次数 */
  successCount: number
  /** 降级发生的调用次数 */
  degradedCount: number
  /** 累计 prompt tokens（仅真 LLM 调用有值） */
  promptTokens: number
  /** 累计 completion tokens */
  completionTokens: number
  /** 按 purpose 分组的明细，便于看"钱花在哪一步" */
  byPurpose: Record<string, { calls: number; promptTokens: number; completionTokens: number }>
}

const runtime: LLMRuntimeState = {
  degraded: false,
  degradedReason: null,
  degradedAt: null,
  successCount: 0,
  degradedCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  byPurpose: {},
}

/** 读当前运行状态（只读快照，避免调用方改内部对象） */
export function getLLMRuntimeState(): Readonly<LLMRuntimeState> & {
  byPurpose: Record<string, { calls: number; promptTokens: number; completionTokens: number }>
} {
  return {
    ...runtime,
    byPurpose: Object.fromEntries(
      Object.entries(runtime.byPurpose).map(([k, v]) => [k, { ...v }])
    ),
  }
}

/** 累加一次成功调用的用量 */
function recordUsage(
  purpose: string | undefined,
  usage: { promptTokens?: number; completionTokens?: number } | undefined
): void {
  const p = usage?.promptTokens ?? 0
  const c = usage?.completionTokens ?? 0
  runtime.promptTokens += p
  runtime.completionTokens += c
  runtime.successCount += 1

  const key = purpose || '(unnamed)'
  const slot = runtime.byPurpose[key] ?? { calls: 0, promptTokens: 0, completionTokens: 0 }
  slot.calls += 1
  slot.promptTokens += p
  slot.completionTokens += c
  runtime.byPurpose[key] = slot
}

/**
 * 标记降级，并打一行日志。
 *
 * ── 为什么降级必须留下痕迹 ──
 *
 * 降级的产品意图是"API 挂了也别让页面崩"，但**绝不能让它无声发生**。
 * 演示场景下，如果 API 失效而界面毫无表示，演示者会拿 mock 输出
 * 当成真模型结果讲 —— 这正好是这个项目最反对的事（把启发式当模型产出）。
 * 所以：
 *   · 日志里留一行（开发者可见）
 *   · 运行状态里留标记（UI 渲染「离线模式」徽标）
 */
function markDegraded(purpose: string | undefined, err: Error): void {
  runtime.degraded = true
  runtime.degradedReason = err.message
  runtime.degradedAt = new Date().toISOString()
  runtime.degradedCount += 1
  console.warn(
    `[llm] 真模型调用失败，已降级到 mock（purpose=${purpose || '(unnamed)'}）：${err.message}`
  )
}

// ===================== 主入口 =====================

/**
 * 发起一次 LLM 调用 —— **带自动降级**。
 *
 * ── 降级契约 ──
 *
 *   1. 配置是 mock           → 直接用 mock（这是正常路径，**不算降级**）
 *   2. 配置是真 LLM，调用成功 → 用真结果（记用量，不显示徽标）
 *   3. 配置是真 LLM，调用失败 → **落 mock 兜底**，标记降级（UI 显示徽标）
 *
 * 第 3 条覆盖所有失败类型：网络不可达、超时、401 密钥无效、429 限流、
 * 模型返回的 JSON 解析失败、schema 校验三轮不过……
 * **一律兜底**，因为对用户来说它们的差别只是"这次没成"，
 * 而页面崩掉的代价远大于拿到一份保守的启发式结果。
 *
 * 唯一的例外是 `getLLMConfig()` 自己抛的 CONFIG 错（provider 写错）——
 * 它也走降级，但日志里会留下明确的配置错误，便于排查。
 */
export async function callLLM(opts: LLMCallOptions): Promise<LLMResult> {
  let cfg: LLMConfig

  try {
    cfg = getLLMConfig()
  } catch (err) {
    // 配置本身非法 —— 同样降级，但日志里留明确原因
    markDegraded(opts.purpose, err as Error)
    const { mockLLMResponse } = await import('./llm-mock')
    return mockLLMResponse(opts, { model: 'mock-model' })
  }

  // ① 正常路径：配置就是 mock
  if (cfg.provider === 'mock') {
    const { mockLLMResponse } = await import('./llm-mock')
    return mockLLMResponse(opts, cfg)
  }

  // ② 真 LLM 路径
  try {
    const res = await callOpenAICompatible(cfg, opts)
    recordUsage(opts.purpose, res.usage)
    return res
  } catch (err) {
    // ③ 失败 → 兜底到 mock
    markDegraded(opts.purpose, err as Error)
    const { mockLLMResponse } = await import('./llm-mock')
    return mockLLMResponse(opts, { model: 'mock-model' })
  }
}
// ===================== JSON 解析与 Schema 校验 =====================

/**
 * 从模型响应里抠出 JSON。
 * 兼容三种情况：纯 JSON、```json 代码块包裹、前后带解释文字。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()

  // 1) 直接解析
  try {
    return JSON.parse(trimmed)
  } catch {
    /* 继续尝试 */
  }

  // 2) 剥离 markdown 代码块
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      /* 继续尝试 */
    }
  }

  // 3) 截取第一个 { 到最后一个 }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      /* 落到下面抛错 */
    }
  }

  throw new LLMError(
    `模型响应不是合法 JSON。原始响应前 500 字符：${trimmed.slice(0, 500)}`,
    'SCHEMA'
  )
}

/** 极简结构校验器 —— 只校验我们真正依赖的字段，避免引入额外依赖 */
export type FieldSpec =
  | { type: 'string'; min?: number }
  | { type: 'number' }
  | { type: 'boolean' }
  | { type: 'array'; of: FieldSpec }
  | { type: 'object'; fields: Record<string, FieldSpec>; allowExtra?: boolean }

export interface ValidationIssue {
  path: string
  message: string
}

export function validateShape(
  value: unknown,
  spec: FieldSpec,
  path = '$'
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const typeOk = (t: string) => {
    if (t === 'array') return Array.isArray(value)
    if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
    return typeof value === t
  }

  if (!typeOk(spec.type)) {
    issues.push({
      path,
      message: `期望 ${spec.type}，实际是 ${
        Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
      }`,
    })
    return issues
  }

  if (spec.type === 'string') {
    const s = value as string
    const min = spec.min ?? 1
    if (s.trim().length < min) {
      issues.push({ path, message: `字符串过短（要求至少 ${min} 字符，实际 ${s.trim().length}）` })
    }
  }

  if (spec.type === 'array') {
    ;(value as unknown[]).forEach((item, i) => {
      issues.push(...validateShape(item, spec.of, `${path}[${i}]`))
    })
  }

  if (spec.type === 'object') {
    const obj = value as Record<string, unknown>
    for (const [key, childSpec] of Object.entries(spec.fields)) {
      if (!(key in obj)) {
        issues.push({ path: `${path}.${key}`, message: '缺少必填字段' })
        continue
      }
      issues.push(...validateShape(obj[key], childSpec, `${path}.${key}`))
    }
  }

  return issues
}

// ===================== 带校验 + 重试的结构化调用 =====================

export interface StructuredCallOptions<T> {
  messages: LLMMessage[]
  spec: FieldSpec
  /** 把通过校验的原始对象转成强类型结果 */
  coerce: (raw: unknown) => T
  /** 附加校验（业务规则），返回问题列表 */
  extraValidate?: (value: T) => ValidationIssue[]
  maxAttempts?: number
  temperature?: number
  maxTokens?: number
  purpose?: string
  /**
   * 整体（含所有重试）的时间预算，毫秒。
   * 不传则读 LLM_TOTAL_BUDGET_MS，再兜底 240000（4 分钟）。
   */
  totalBudgetMs?: number
}

export interface StructuredCallResult<T> {
  value: T
  attempts: number
  provider: string
  model: string
  /** 前几次失败的原因，便于排查与展示 */
  warnings: string[]
}

/**
 * 调 LLM 并要求返回满足 spec 的 JSON。
 * 校验失败时把错误回灌给模型重试，超过 maxAttempts 直接抛错。
 * 绝不返回未通过校验的数据。
 *
 * ── 总时间预算（totalBudgetMs）──
 * 单次调用有 `LLM_TIMEOUT_MS` 兜底，但那是**每次**调用的上限。
 * 重试 3 次意味着最坏情况下用户要等 3 倍 —— 推理模型下一个论文
 * 抽取就可能从 30 秒拖到 3 分钟，而且全程界面无反应，看起来就是卡死。
 *
 * 所以这里再加一道总预算：无论重试几次，整体不超过 `totalBudgetMs`。
 * 超了就带着"已经跑了几次、最后错在哪"如实失败，
 * 而不是让用户继续等一个大概率也不会成功的重试。
 *
 * 默认值取 4 分钟：够一次完整推理 + 一次重试，又不至于让人以为页面挂了。
 */
export async function callLLMStructured<T>(
  opts: StructuredCallOptions<T>
): Promise<StructuredCallResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 3
  const totalBudgetMs =
    opts.totalBudgetMs ??
    Number(process.env.LLM_TOTAL_BUDGET_MS || 240000)
  const deadline = Date.now() + totalBudgetMs

  const warnings: string[] = []
  const baseMessages = [...opts.messages]

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 进下一轮之前先看预算够不够 —— 不够就别开新的一轮了
    if (attempt > 1 && Date.now() >= deadline) {
      throw new LLMError(
        `结构化输出连续失败，且已超出总时间预算 ${Math.round(totalBudgetMs / 1000)} 秒` +
          `（已完成 ${attempt - 1} 次尝试）。最后一次错误：${lastError?.message ?? '未知'}`,
        'UNKNOWN'
      )
    }
    const messages =
      attempt === 1
        ? baseMessages
        : [
            ...baseMessages,
            ...(warnings.length
              ? [
                  {
                    role: 'user' as const,
                    content:
                      '上一次你的输出未通过校验，错误如下：\n' +
                      warnings.map((w) => `- ${w}`).join('\n') +
                      '\n请严格按要求的 JSON 结构重新输出，只输出 JSON，不要任何解释文字。',
                  },
                ]
              : []),
          ]

    try {
      const res = await callLLM({
        messages,
        jsonMode: true,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        purpose: opts.purpose,
      })

      const raw = extractJson(res.text)
      const issues = validateShape(raw, opts.spec)

      if (issues.length > 0) {
        lastError = new LLMError(
          `结构化校验未通过：${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
          'SCHEMA'
        )
        warnings.push(...issues.map((i) => `${i.path}: ${i.message}`))
        continue
      }

      const value = opts.coerce(raw)

      if (opts.extraValidate) {
        const extra = opts.extraValidate(value)
        if (extra.length > 0) {
          lastError = new LLMError(
            `业务校验未通过：${extra.map((i) => `${i.path} ${i.message}`).join('; ')}`,
            'SCHEMA'
          )
          warnings.push(...extra.map((i) => `${i.path}: ${i.message}`))
          continue
        }
      }

      return {
        value,
        attempts: attempt,
        provider: res.provider,
        model: res.model,
        warnings,
      }
    } catch (err) {
      lastError = err as Error
      warnings.push((err as Error).message)
      // 配置类错误重试也没用，直接抛
      if ((err as LLMError).kind === 'CONFIG') throw err
      /**
       * 截断 / 限流同样不该重试 —— 见 NON_RETRYABLE 的注释。
       * 这里**必须立刻抛出**，否则用户要为每一次注定失败的重试
       * 再等一整个推理周期（hy3 实测 30~110 秒/次）。
       */
      if (!isRetryable(err)) throw err
    }
  }

  throw new LLMError(
    `LLM 结构化输出在 ${maxAttempts} 次尝试后仍不合格。最后一次错误：${
      lastError?.message ?? '未知'
    }`,
    'SCHEMA'
  )
}
