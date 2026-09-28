// node --test test/unit  (Node >= 22.18 / 24: 原生 strip-types)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findMatchingModel,
  modelMatchesRequest,
  accountSupportsModel,
  stripContextSuffix,
  normalizeClaudeVersion,
  parseModelDescriptor,
  pickNearestEffort,
  pickLatestModelId,
  guessClaudeContextLength,
  getHiddenModelCodeWhispererId
} from '../../src/main/proxy/modelSupport.ts'

// 模拟 ListAvailableModels 返回（顺序故意把旧版本放前面，暴露「取第一个」类 bug）
const PRO_MODELS = [
  { modelId: 'auto', modelName: 'Auto' },
  { modelId: 'claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5' },
  { modelId: 'claude-sonnet-4', modelName: 'Claude Sonnet 4' },
  { modelId: 'claude-haiku-4.5', modelName: 'Claude Haiku 4.5' },
  { modelId: 'claude-opus-4.5', modelName: 'Claude Opus 4.5' },
  { modelId: 'claude-opus-4.6', modelName: 'Claude Opus 4.6' },
  { modelId: 'claude-opus-5.5', modelName: 'Claude Opus 5.5' }
]
const FREE_MODELS = PRO_MODELS.filter(m => !m.modelId.includes('opus'))
const CW_MODELS = [
  { modelId: 'CLAUDE_SONNET_4_20250514_V1_0', modelName: 'Claude Sonnet 4' },
  { modelId: 'CLAUDE_OPUS_4_5_20251101_V1_0', modelName: 'Claude Opus 4.5' },
  { modelId: 'CLAUDE_OPUS_5_5_20260801_V1_0', modelName: 'Claude Opus 5.5' }
]

test('版本号解析：有序、忽略日期快照和 V1 后缀', () => {
  assert.deepEqual(parseModelDescriptor('claude-opus-5.5').version, [5, 5])
  assert.deepEqual(parseModelDescriptor('CLAUDE_SONNET_4_20250514_V1_0').version, [4])
  assert.deepEqual(parseModelDescriptor('claude-3.7-sonnet').version, [3, 7])
  assert.equal(parseModelDescriptor('claude-3.7-sonnet').family, 'sonnet')
})

test('回归：Opus 5.5 不能匹配到 Opus 4.5（旧 token 集合比较会误中）', () => {
  assert.equal(modelMatchesRequest({ modelId: 'claude-opus-4.5' }, 'claude-opus-5.5'), false)
  assert.equal(findMatchingModel(PRO_MODELS, 'claude-opus-5.5')?.modelId, 'claude-opus-5.5')
  assert.equal(findMatchingModel(PRO_MODELS.filter(m => m.modelId !== 'claude-opus-5.5'), 'claude-opus-5.5'), undefined)
})

test('回归：claude-sonnet-4 不能前缀命中 claude-sonnet-4.5', () => {
  assert.equal(findMatchingModel(PRO_MODELS, 'claude-sonnet-4')?.modelId, 'claude-sonnet-4')
  assert.equal(findMatchingModel([{ modelId: 'claude-sonnet-4.5' }], 'claude-sonnet-4'), undefined)
})

test('家族不能串：opus 请求不会命中 sonnet', () => {
  assert.equal(findMatchingModel(FREE_MODELS, 'claude-opus-4.5'), undefined)
})

test('别名形式：短横版本 / [1m] 后缀 / CW 内部 ID', () => {
  assert.equal(findMatchingModel(PRO_MODELS, 'claude-opus-5-5')?.modelId, 'claude-opus-5.5')
  assert.equal(findMatchingModel(PRO_MODELS, 'claude-opus-5.5[1m]')?.modelId, 'claude-opus-5.5')
  assert.equal(findMatchingModel(CW_MODELS, 'claude-opus-5.5')?.modelId, 'CLAUDE_OPUS_5_5_20260801_V1_0')
  assert.equal(findMatchingModel(CW_MODELS, 'claude-sonnet-4')?.modelId, 'CLAUDE_SONNET_4_20250514_V1_0')
})

test('不带版本号的家族请求取最新版本', () => {
  assert.equal(findMatchingModel(PRO_MODELS, 'claude-opus')?.modelId, 'claude-opus-5.5')
})

test('非 Claude 模型按连续 token 匹配', () => {
  assert.equal(findMatchingModel(PRO_MODELS, 'auto')?.modelId, 'auto')
  assert.equal(findMatchingModel([{ modelId: 'glm-4.7' }, { modelId: 'glm-4' }], 'glm-4')?.modelId, 'glm-4')
})

test('accountSupportsModel：Free 号不支持 Opus，未知情况不排除', () => {
  assert.equal(accountSupportsModel(PRO_MODELS, 'claude-opus-5.5'), true)
  assert.equal(accountSupportsModel(FREE_MODELS, 'claude-opus-5.5'), false)
  assert.equal(accountSupportsModel(undefined, 'claude-opus-5.5'), undefined)
  assert.equal(accountSupportsModel([], 'claude-opus-5.5'), undefined)
  assert.equal(accountSupportsModel(FREE_MODELS, 'CLAUDE_OPUS_4_5_20251101_V1_0'), undefined)
  assert.equal(accountSupportsModel(FREE_MODELS, 'claude-3.7-sonnet'), undefined)
  assert.equal(accountSupportsModel(FREE_MODELS, undefined), undefined)
})

test('隐藏模型映射到 CW ID', () => {
  assert.equal(getHiddenModelCodeWhispererId('claude-3.7-sonnet'), 'CLAUDE_3_7_SONNET_20250219_V1_0')
  assert.equal(getHiddenModelCodeWhispererId('simple-task'), 'simple-task')
  assert.equal(getHiddenModelCodeWhispererId('claude-opus-5.5'), undefined)
})

test('stripContextSuffix / normalizeClaudeVersion', () => {
  assert.deepEqual(stripContextSuffix('claude-opus-4-6[1m]'), { base: 'claude-opus-4-6', longContext: true })
  assert.deepEqual(stripContextSuffix('claude-opus-5.5'), { base: 'claude-opus-5.5', longContext: false })
  assert.equal(normalizeClaudeVersion('claude-opus-5-5'), 'claude-opus-5.5')
  assert.equal(normalizeClaudeVersion('claude-sonnet-4-20250514'), 'claude-sonnet-4-20250514')
})

test('pickNearestEffort：取最近档位，平局取低档，不再默认最贵', () => {
  assert.equal(pickNearestEffort('high', ['low', 'medium', 'high']), 'high')
  assert.equal(pickNearestEffort('low', ['medium', 'high', 'max']), 'medium')
  assert.equal(pickNearestEffort('xhigh', ['low', 'medium', 'high']), 'high')
  assert.equal(pickNearestEffort('max', ['low', 'medium', 'high', 'xhigh']), 'xhigh')
  // medium 与 low/high 距离相同 → 取低档
  assert.equal(pickNearestEffort('medium', ['low', 'high']), 'low')
  assert.equal(pickNearestEffort('HIGH', ['low', 'high']), 'high')
  assert.equal(pickNearestEffort('weird', ['low', 'high']), 'high')
  assert.equal(pickNearestEffort('weird', ['low', 'medium']), 'medium')
})

test('pickLatestModelId：一键配置取最新 opus / haiku', () => {
  const ids = ['auto', 'claude-opus-4.5', 'claude-opus-5.5', 'claude-opus-4.6', 'CLAUDE_OPUS_5_5_20260801_V1_0', 'claude-haiku-4.5', 'claude-sonnet-4.5']
  assert.equal(pickLatestModelId(ids, 'opus'), 'claude-opus-5.5')
  assert.equal(pickLatestModelId(ids, 'haiku'), 'claude-haiku-4.5')
  assert.equal(pickLatestModelId(['auto'], 'opus'), undefined)
})

test('guessClaudeContextLength：5.x 走 Claude 兜底，[1m] → 1M', () => {
  assert.equal(guessClaudeContextLength('claude-opus-5.5'), 200000)
  assert.equal(guessClaudeContextLength('claude-opus-5.5[1m]'), 1000000)
  assert.equal(guessClaudeContextLength('gpt-4o'), undefined)
})
