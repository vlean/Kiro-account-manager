// node --test test/unit  (Node >= 22.18 / 24: 原生 strip-types)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRegionFromArn,
  mapSsoRegionToApiRegion,
  resolveKiroApiRegion,
  getAlternateApiRegion,
  shouldTryAlternateRegion,
  getQServiceBaseUrl,
  getCodeWhispererBaseUrl,
  isValidAwsRegion
} from '../../src/main/regionResolver.ts'

const BUILDER_PLACEHOLDER = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
const EU_REAL = 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABCDEF'

test('parseRegionFromArn: 合法 ARN 返回区域', () => {
  assert.equal(parseRegionFromArn(EU_REAL), 'eu-central-1')
  assert.equal(parseRegionFromArn(BUILDER_PLACEHOLDER), 'us-east-1')
})

test('parseRegionFromArn: 非法 / 注入字符串返回 undefined', () => {
  assert.equal(parseRegionFromArn(undefined), undefined)
  assert.equal(parseRegionFromArn(''), undefined)
  assert.equal(parseRegionFromArn('not-an-arn'), undefined)
  assert.equal(parseRegionFromArn('arn:aws:codewhisperer:evil.com/x:1:profile/a'), undefined)
  assert.equal(parseRegionFromArn('arn:aws:codewhisperer::1:profile/a'), undefined)
})

test('mapSsoRegionToApiRegion: 只映射到两个部署区域', () => {
  assert.equal(mapSsoRegionToApiRegion(undefined), 'us-east-1')
  assert.equal(mapSsoRegionToApiRegion('us-east-1'), 'us-east-1')
  assert.equal(mapSsoRegionToApiRegion('eu-central-1'), 'eu-central-1')
  assert.equal(mapSsoRegionToApiRegion('eu-west-1'), 'eu-central-1')
  assert.equal(mapSsoRegionToApiRegion('ap-northeast-1'), 'us-east-1')
  assert.equal(mapSsoRegionToApiRegion('us-west-2'), 'us-east-1')
})

test('resolveKiroApiRegion: 真实 profileArn 区域优先于 SSO 区域', () => {
  // us-west-2 登录但 profile 在 eu-central-1（旧逻辑会打到 us-east-1）
  assert.deepEqual(
    resolveKiroApiRegion({ profileArn: EU_REAL, region: 'us-west-2' }),
    { region: 'eu-central-1', source: 'profileArn' }
  )
})

test('resolveKiroApiRegion: 共享占位符 ARN 不作为区域依据', () => {
  assert.deepEqual(
    resolveKiroApiRegion({ profileArn: BUILDER_PLACEHOLDER, region: 'eu-west-2' }, { sharedArns: [BUILDER_PLACEHOLDER] }),
    { region: 'eu-central-1', source: 'ssoRegion' }
  )
})

test('resolveKiroApiRegion: 无任何信息 → 默认 us-east-1', () => {
  assert.deepEqual(resolveKiroApiRegion({}), { region: 'us-east-1', source: 'default' })
  assert.deepEqual(
    resolveKiroApiRegion({ profileArn: 'garbage' }),
    { region: 'us-east-1', source: 'default' }
  )
})

test('跨区兜底：只有区域是猜的才允许', () => {
  assert.equal(getAlternateApiRegion('us-east-1'), 'eu-central-1')
  assert.equal(getAlternateApiRegion('eu-central-1'), 'us-east-1')
  assert.equal(getAlternateApiRegion('ap-south-1'), undefined)
  assert.equal(shouldTryAlternateRegion({ region: 'us-east-1', source: 'default' }), true)
  assert.equal(shouldTryAlternateRegion({ region: 'eu-central-1', source: 'ssoRegion' }), true)
  assert.equal(shouldTryAlternateRegion({ region: 'eu-central-1', source: 'profileArn' }), false)
})

test('URL 生成：按区域拼接，非法区域抛错', () => {
  assert.equal(getQServiceBaseUrl('eu-central-1'), 'https://q.eu-central-1.amazonaws.com')
  assert.equal(getCodeWhispererBaseUrl('us-east-1'), 'https://codewhisperer.us-east-1.amazonaws.com')
  assert.throws(() => getQServiceBaseUrl('evil.com/'), /Invalid AWS region/)
  assert.equal(isValidAwsRegion('us-gov-west-1'), true)
  assert.equal(isValidAwsRegion('US-EAST-1'), false)
})
