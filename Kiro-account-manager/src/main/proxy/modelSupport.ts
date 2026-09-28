// 模型匹配 / 能力判断（纯函数模块，无 electron / 网络依赖，可直接单测）
//
// 旧 matchesRequestedModel 的两个问题：
//   1. 版本号按「token 集合」比较：claude-opus-5.5 的 token {5,5} ⊂ claude-opus-4.5 的 {4,5}
//      → 请求 Opus 5.5 会命中 Opus 4.5
//   2. key.includes 前缀匹配：claude-sonnet-4 会命中列表里排在前面的 claude-sonnet-4.5
// 这里改为「家族 + 有序版本号」精确比较。

export interface ModelLike {
  modelId: string
  modelName?: string
}

export type ClaudeFamily = 'opus' | 'sonnet' | 'haiku'

export interface ModelDescriptor {
  family?: ClaudeFamily
  /** 有序版本号，如 claude-opus-4.5 → [4,5]；CLAUDE_SONNET_4_20250514_V1_0 → [4] */
  version: number[]
  tokens: string[]
  key: string
}

const FAMILIES: ClaudeFamily[] = ['opus', 'sonnet', 'haiku']

/**
 * 不在 ListAvailableModels 中返回、但后端实际支持的模型。
 * value = CodeWhisperer 端点使用的内部 ID（空串表示原样透传）。
 */
const HIDDEN_MODELS: Record<string, string> = {
  'claude-3.7-sonnet': 'CLAUDE_3_7_SONNET_20250219_V1_0',
  'simple-task': ''
}

export function normalizeModelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function modelTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

export function isCodeWhispererModelId(modelId: string): boolean {
  return /^[A-Z0-9_]+$/.test(modelId) && modelId.includes('_')
}

/**
 * 归一化 Claude 版本号：claude-opus-4-6 → claude-opus-4.6（Claude Code 不允许模型名带 "."）。
 * 仅当 minor 是 1~2 位数字且其后不是更多数字时才转换，避免误伤日期快照（claude-sonnet-4-20250514）。
 */
export function normalizeClaudeVersion(modelId: string): string {
  return modelId.replace(
    /^(claude-(?:sonnet|haiku|opus))-(\d+)-(\d{1,2})(?=$|[^\d])/i,
    '$1-$2.$3'
  )
}

/**
 * 剥离 Claude Code 的上下文窗口后缀：claude-opus-4-6[1m] → claude-opus-4-6。
 * Kiro 后端不认识该后缀（原样透传会 400，CW 端点匹配失败会被降级）；
 * 上下文长度以 ListAvailableModels 返回的 maxInputTokens 为准。
 */
export function stripContextSuffix(modelId: string): { base: string; longContext: boolean } {
  const match = modelId.match(/^(.*?)\s*\[(\d+[km])\]$/i)
  if (!match) return { base: modelId, longContext: false }
  return { base: match[1], longContext: match[2].toLowerCase() === '1m' }
}

export function parseModelDescriptor(value: string): ModelDescriptor {
  const tokens = modelTokens(value)
  const family = FAMILIES.find(f => tokens.includes(f))
  const version: number[] = []
  if (tokens.includes('claude')) {
    for (const token of tokens) {
      // 日期快照（20250514）或 v1 版本后缀之后的数字不属于模型版本
      if (/^\d{6,}$/.test(token) || /^v\d+$/.test(token)) break
      if (/^\d{1,2}$/.test(token)) version.push(Number(token))
    }
  }
  return { family, version, tokens, key: normalizeModelKey(value) }
}

function sameVersion(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((t, j) => haystack[i + j] === t)) return true
  }
  return false
}

function descriptorMatches(candidate: ModelDescriptor, requested: ModelDescriptor): boolean {
  if (candidate.key === requested.key) return true
  if (requested.family || candidate.family) {
    // Claude：家族必须一致；请求带版本号时有序版本必须完全相等
    if (candidate.family !== requested.family) return false
    if (!candidate.tokens.includes('claude') || !requested.tokens.includes('claude')) return false
    if (requested.version.length === 0) return true
    return sameVersion(candidate.version, requested.version)
  }
  // 非 Claude（auto / glm-4.7 / deepseek-3.2 ...）：请求 token 须作为连续子序列出现
  const wanted = requested.tokens.filter(t => t !== 'latest' && t !== 'model')
  return containsSequence(candidate.tokens, wanted)
}

export function modelMatchesRequest(model: ModelLike, requestedModelId: string): boolean {
  const requested = parseModelDescriptor(stripContextSuffix(requestedModelId).base)
  if (descriptorMatches(parseModelDescriptor(model.modelId), requested)) return true
  return !!model.modelName && descriptorMatches(parseModelDescriptor(model.modelName), requested)
}

/** 比较版本号数组：a > b 返回正数 */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 在模型列表中查找请求的模型：
 *   1. modelId / modelName 规范化后完全相等
 *   2. 家族 + 版本精确匹配；多个候选时取 modelId 最短的（最「纯」的变体）；
 *      请求不带版本号（claude-opus）时取最新版本
 */
export function findMatchingModel<T extends ModelLike>(models: readonly T[], requestedModelId: string): T | undefined {
  const base = stripContextSuffix(requestedModelId.trim()).base
  if (!base) return undefined
  const key = normalizeModelKey(base)
  const exact = models.find(m => normalizeModelKey(m.modelId) === key)
    || models.find(m => !!m.modelName && normalizeModelKey(m.modelName) === key)
  if (exact) return exact

  const candidates = models.filter(m => modelMatchesRequest(m, base))
  if (candidates.length <= 1) return candidates[0]
  const requested = parseModelDescriptor(base)
  if (requested.family && requested.version.length === 0) {
    return [...candidates].sort((a, b) =>
      compareVersions(parseModelDescriptor(b.modelId).version, parseModelDescriptor(a.modelId).version)
    )[0]
  }
  return [...candidates].sort((a, b) => a.modelId.length - b.modelId.length)[0]
}

export function isHiddenModel(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(HIDDEN_MODELS, stripContextSuffix(modelId).base.trim().toLowerCase())
}

/** 隐藏模型在 CodeWhisperer 端点使用的 ID（未知返回 undefined） */
export function getHiddenModelCodeWhispererId(modelId: string): string | undefined {
  const key = stripContextSuffix(modelId).base.trim().toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(HIDDEN_MODELS, key)) return undefined
  return HIDDEN_MODELS[key] || stripContextSuffix(modelId).base.trim()
}

/**
 * 账号是否支持请求的模型：
 *   true  — 模型列表中能匹配到
 *   false — 模型列表完整且匹配不到（可以放心切号）
 *   undefined — 无法判断（列表未知/不完整、CW 内部 ID、隐藏模型）→ 不据此排除账号
 */
export function accountSupportsModel(
  models: readonly ModelLike[] | undefined,
  requestedModelId: string | undefined
): boolean | undefined {
  if (!requestedModelId || !models || models.length === 0) return undefined
  const base = stripContextSuffix(requestedModelId.trim()).base
  if (!base || isCodeWhispererModelId(base) || isHiddenModel(base)) return undefined
  return !!findMatchingModel(models, base)
}

// effort 从低到高的规范顺序（Kiro schema 里可能出现的所有取值）
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 请求的 effort 不在模型支持列表中时取「最接近」的档位，平局取更低（更便宜）的一档。
 * 旧实现直接取列表最后一个（通常是最贵的 max/xhigh），请求 low 反而按最高档计费。
 */
export function pickNearestEffort(requested: string, available: readonly string[], fallback = 'high'): string {
  const want = requested.toLowerCase()
  if (available.length === 0) return want || fallback
  if (available.includes(want)) return want
  const wantRank = EFFORT_ORDER.indexOf(want)
  const ranked = available
    .map(value => ({ value, rank: EFFORT_ORDER.indexOf(value.toLowerCase()) }))
    .filter(item => item.rank >= 0)
  if (wantRank < 0 || ranked.length === 0) {
    return available.includes(fallback) ? fallback : available[available.length - 1]
  }
  ranked.sort((a, b) => Math.abs(a.rank - wantRank) - Math.abs(b.rank - wantRank) || a.rank - b.rank)
  return ranked[0].value
}

/** 在一组模型 ID 中选出指定家族的最新版本（一键配置客户端用：Claude Code 的 opus/haiku 快捷模型） */
export function pickLatestModelId(ids: readonly string[], family: ClaudeFamily): string | undefined {
  const candidates = ids
    .filter(id => !isCodeWhispererModelId(id))
    .map(id => ({ id, desc: parseModelDescriptor(id) }))
    .filter(item => item.desc.family === family && item.desc.tokens.includes('claude'))
  if (candidates.length === 0) return undefined
  candidates.sort((a, b) =>
    compareVersions(b.desc.version, a.desc.version) || a.id.length - b.id.length
  )
  return candidates[0].id
}

/** Claude 系列上下文长度的关键词兜底（ListAvailableModels 缓存未填充时用） */
export function guessClaudeContextLength(modelId: string): number | undefined {
  const { base, longContext } = stripContextSuffix(modelId)
  const desc = parseModelDescriptor(base)
  if (!desc.tokens.includes('claude')) return undefined
  if (longContext) return 1000000
  return desc.family || desc.version.length > 0 ? 200000 : undefined
}
