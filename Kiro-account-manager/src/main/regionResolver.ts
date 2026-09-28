// Kiro API 区域决策中心（纯函数模块，无 electron / 网络依赖，可直接单测）
//
// 背景：Kiro 后端（q.* / codewhisperer.*）只部署在 us-east-1 与 eu-central-1。
// 账号的「API 区域」和「SSO 登录区域」不是一回事：
//   - Enterprise(IdC) 账号可能在 eu-west-1 登录，但 profile 位于 eu-central-1
//   - profileArn（arn:aws:codewhisperer:{region}:{acct}:profile/{id}）里的区域才是权威值
// 旧实现在 5 处各写了一份 `startsWith('eu-') ? eu-central-1 : us-east-1`，
// 且流式端点完全写死 us-east-1。本模块统一优先级：
//   1. 真实 profileArn 中的区域（排除所有账号共享的占位符/固定 ARN）
//   2. SSO 区域映射（eu-* → eu-central-1，其它 → us-east-1）
//   3. 默认 us-east-1

export const KIRO_API_REGIONS = ['us-east-1', 'eu-central-1'] as const
export const DEFAULT_KIRO_API_REGION = 'us-east-1'

export type RegionSource = 'profileArn' | 'ssoRegion' | 'default'

export interface ResolvedRegion {
  region: string
  source: RegionSource
}

export interface RegionInput {
  profileArn?: string | null
  /** 账号的 SSO / OIDC 区域 */
  region?: string | null
}

export interface ResolveRegionOptions {
  /** 所有账号共享的固定 ARN（BuilderId 占位符 / Social 固定 ARN），其区域不代表账号真实区域 */
  sharedArns?: Iterable<string>
}

// 严格的 AWS 区域格式；ARN 可能来自导入数据，拼 URL 前必须校验，防止 host 注入
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/

export function isValidAwsRegion(region: string | null | undefined): region is string {
  return typeof region === 'string' && REGION_RE.test(region)
}

/** 从 codewhisperer / q profileArn 中解析区域；格式不合法返回 undefined */
export function parseRegionFromArn(arn: string | null | undefined): string | undefined {
  if (!arn) return undefined
  const parts = arn.split(':')
  // arn : partition : service : region : account : resource
  if (parts.length < 6 || parts[0] !== 'arn') return undefined
  const region = parts[3]
  return isValidAwsRegion(region) ? region : undefined
}

/** SSO 区域 → Kiro API 区域（只有两个部署区域） */
export function mapSsoRegionToApiRegion(ssoRegion: string | null | undefined): string {
  if (!ssoRegion) return DEFAULT_KIRO_API_REGION
  if ((KIRO_API_REGIONS as readonly string[]).includes(ssoRegion)) return ssoRegion
  if (ssoRegion.startsWith('eu-')) return 'eu-central-1'
  return DEFAULT_KIRO_API_REGION
}

export function resolveKiroApiRegion(input: RegionInput, options: ResolveRegionOptions = {}): ResolvedRegion {
  const shared = new Set(options.sharedArns ?? [])
  if (input.profileArn && !shared.has(input.profileArn)) {
    const arnRegion = parseRegionFromArn(input.profileArn)
    if (arnRegion) return { region: arnRegion, source: 'profileArn' }
  }
  if (input.region) {
    return { region: mapSsoRegionToApiRegion(input.region), source: 'ssoRegion' }
  }
  return { region: DEFAULT_KIRO_API_REGION, source: 'default' }
}

/**
 * 备用区域（用于 403 兜底）。只在两个已知部署区域之间切换；
 * 未知区域返回 undefined（不猜测）。
 */
export function getAlternateApiRegion(region: string): string | undefined {
  if (region === 'us-east-1') return 'eu-central-1'
  if (region === 'eu-central-1') return 'us-east-1'
  return undefined
}

/** 区域来源不是权威 profileArn 时才允许跨区重试（ARN 已明确区域，跨区只会浪费一次请求） */
export function shouldTryAlternateRegion(resolved: ResolvedRegion): boolean {
  return resolved.source !== 'profileArn' && getAlternateApiRegion(resolved.region) !== undefined
}

function assertRegion(region: string): string {
  if (!isValidAwsRegion(region)) {
    throw new Error(`Invalid AWS region: ${region}`)
  }
  return region
}

export function getQServiceBaseUrl(region: string): string {
  return `https://q.${assertRegion(region)}.amazonaws.com`
}

export function getCodeWhispererBaseUrl(region: string): string {
  return `https://codewhisperer.${assertRegion(region)}.amazonaws.com`
}
