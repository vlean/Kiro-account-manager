// 反代端到端路由测试：真实 ProxyServer + 伪造的 Kiro 后端（stub 全局 fetch），不走网络
// 运行：node --test test/unit
//
// 覆盖：
//   - 流式端点按账号 API 区域生成 URL（EU profileArn → *.eu-central-1）
//   - 区域是猜的时 403 → 换另一个部署区域重试
//   - 多账号按模型选号：Opus 5.5 请求跳过没有该模型的 Free 号
//   - 所有账号都没有该模型 → 400 MODEL_NOT_AVAILABLE（不再静默降级成 Sonnet 4）
//   - [1m] 后缀被剥离、短横版本号被归一化
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Module from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const require = createRequire(import.meta.url)

// ---- 伪造 Kiro 后端 ----
const calls = []
const MODELS = {
  pro: ['claude-sonnet-4.5', 'claude-sonnet-4', 'claude-haiku-4.5', 'claude-opus-4.5', 'claude-opus-5.5'],
  free: ['claude-sonnet-4.5', 'claude-sonnet-4', 'claude-haiku-4.5']
}
const tokenPlan = new Map() // accessToken → 'pro' | 'free'
const forbiddenRegions = new Set() // 这些区域的 generateAssistantResponse 返回 403

function encodeEvent(eventType, payload) {
  const enc = new TextEncoder()
  const name = enc.encode(':event-type')
  const value = enc.encode(eventType)
  const headers = new Uint8Array(1 + name.length + 1 + 2 + value.length)
  let o = 0
  headers[o++] = name.length
  headers.set(name, o); o += name.length
  headers[o++] = 7
  headers[o++] = value.length >> 8
  headers[o++] = value.length & 0xff
  headers.set(value, o)
  const body = enc.encode(JSON.stringify(payload))
  const total = 12 + headers.length + body.length + 4
  const buf = new Uint8Array(total)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, total)
  dv.setUint32(4, headers.length)
  buf.set(headers, 12)
  buf.set(body, 12 + headers.length)
  return buf
}

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const auth = (init.headers?.Authorization || init.headers?.authorization || '').replace('Bearer ', '')
  const call = { host: url.host, path: url.pathname, token: auth, body: init.body ? JSON.parse(init.body) : undefined }
  calls.push(call)
  const region = url.host.split('.')[1]
  if (url.pathname === '/ListAvailableModels') {
    const plan = tokenPlan.get(auth)
    return new Response(JSON.stringify({ models: (MODELS[plan] || []).map(modelId => ({ modelId, modelName: modelId })) }), { status: 200 })
  }
  if (url.pathname === '/generateAssistantResponse' || url.pathname === '/SendMessageStreaming') {
    if (forbiddenRegions.has(region)) {
      return new Response('{"message":"AccessDeniedException: profile belongs to a different region"}', { status: 403 })
    }
    const model = call.body.conversationState.currentMessage.userInputMessage.modelId
    return new Response(encodeEvent('assistantResponseEvent', { content: `ok ${model} @${region}` }), { status: 200 })
  }
  return new Response('not found', { status: 404 })
}

let ProxyServer
let logStore
let userData
const originalFetch = globalThis.fetch
const originalLoad = Module._load

before(async () => {
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) delete process.env[k]
  userData = mkdtempSync(join(tmpdir(), 'kam-test-'))
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { app: { getPath: () => userData, getVersion: () => '0.0.0', isPackaged: false } }
    return originalLoad.call(this, request, ...rest)
  }
  const esbuild = require('esbuild')
  // 产物放在仓库 out/（已 gitignore）下，才能解析到 node_modules 里的外部依赖
  const outfile = join(root, 'out', 'test-bundle', `proxyServer-${process.pid}.cjs`)
  esbuild.buildSync({
    stdin: {
      contents: "export { ProxyServer } from './src/main/proxy/proxyServer'\nexport { proxyLogStore } from './src/main/proxy/logger'\n",
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    outfile, logLevel: 'error'
  })
  globalThis.fetch = fakeFetch
  const mod = require(outfile)
  ProxyServer = mod.ProxyServer
  // 日志持久化指向临时目录（否则 30s 节流写盘定时器会写空路径并拖住进程退出）
  logStore = mod.proxyLogStore
  logStore.initialize(userData)
})

after(async () => {
  await logStore?.flushSaveNow()
  globalThis.fetch = originalFetch
  Module._load = originalLoad
  rmSync(userData, { recursive: true, force: true })
  rmSync(join(root, 'out', 'test-bundle'), { recursive: true, force: true })
})

let nextPort = 25580 + Math.floor(Math.random() * 1000)

async function withServer(accounts, config, fn) {
  const port = nextPort++
  const server = new ProxyServer({ port, host: '127.0.0.1', logRequests: false, maxRetries: 3, ...config })
  for (const acc of accounts) server.getAccountPool().addAccount({ expiresAt: Date.now() + 3600_000, ...acc })
  await server.start()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await server.stop(0)
  }
}

async function claude(base, model, stream = false) {
  const res = await originalFetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 64, stream, messages: [{ role: 'user', content: 'hi' }] })
  })
  return { status: res.status, text: await res.text() }
}

const streamCalls = () => calls.filter(c => c.path === '/generateAssistantResponse')

test('EU profileArn 账号：流式请求打到 eu-central-1', async () => {
  calls.length = 0
  tokenPlan.set('tok-eu', 'pro')
  await withServer([{
    id: 'eu', email: 'eu@test', accessToken: 'tok-eu', provider: 'Enterprise', authMethod: 'IdC',
    region: 'eu-west-1', profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/REALEU'
  }], { enableMultiAccount: false, preferredEndpoint: 'codewhisperer' }, async (base) => {
    const r = await claude(base, 'claude-opus-5.5')
    assert.equal(r.status, 200, r.text)
    assert.match(r.text, /ok claude-opus-5\.5 @eu-central-1/)
  })
  assert.ok(streamCalls().length > 0)
  for (const c of calls) assert.match(c.host, /\.eu-central-1\.amazonaws\.com$/, `${c.host}${c.path}`)
})

test('区域是猜的且 403 → 换另一部署区域重试成功', async () => {
  calls.length = 0
  tokenPlan.set('tok-guess', 'pro')
  forbiddenRegions.add('us-east-1')
  try {
    await withServer([{ id: 'g', accessToken: 'tok-guess', provider: 'BuilderId', authMethod: 'IdC' }],
      { enableMultiAccount: false, preferredEndpoint: 'amazonq' }, async (base) => {
        const r = await claude(base, 'claude-sonnet-4.5')
        assert.equal(r.status, 200, r.text)
        assert.match(r.text, /@eu-central-1/)
      })
  } finally {
    forbiddenRegions.clear()
  }
  assert.deepEqual(streamCalls().map(c => c.host), ['q.us-east-1.amazonaws.com', 'q.eu-central-1.amazonaws.com'])
})

test('多账号按模型选号：Opus 5.5 跳过 Free 号', async () => {
  calls.length = 0
  tokenPlan.set('tok-free', 'free')
  tokenPlan.set('tok-pro', 'pro')
  await withServer([
    { id: 'free', email: 'free@test', accessToken: 'tok-free', provider: 'Google', authMethod: 'social' },
    { id: 'pro', email: 'pro@test', accessToken: 'tok-pro', provider: 'Google', authMethod: 'social' }
  ], { enableMultiAccount: true, preferredEndpoint: 'codewhisperer' }, async (base) => {
    for (let i = 0; i < 3; i++) {
      const r = await claude(base, 'claude-opus-5-5[1m]', i === 1)
      assert.equal(r.status, 200, r.text)
      assert.match(r.text, /ok claude-opus-5\.5/)
    }
    // Sonnet 请求两个号都能用，round-robin 应该都用到
    for (let i = 0; i < 4; i++) {
      const r = await claude(base, 'claude-sonnet-4.5')
      assert.equal(r.status, 200, r.text)
    }
  })
  const opusCalls = streamCalls().filter(c => c.body.conversationState.currentMessage.userInputMessage.modelId === 'claude-opus-5.5')
  assert.equal(opusCalls.length, 3)
  assert.ok(opusCalls.every(c => c.token === 'tok-pro'), 'Opus 请求全部落在 Pro 号')
  const sonnetTokens = new Set(streamCalls().filter(c => c.body.conversationState.currentMessage.userInputMessage.modelId === 'claude-sonnet-4.5').map(c => c.token))
  assert.deepEqual([...sonnetTokens].sort(), ['tok-free', 'tok-pro'])
})

test('所有账号都没有该模型 → 400 MODEL_NOT_AVAILABLE，不静默降级', async () => {
  calls.length = 0
  tokenPlan.set('tok-f1', 'free')
  tokenPlan.set('tok-f2', 'free')
  await withServer([
    { id: 'f1', accessToken: 'tok-f1', provider: 'Github', authMethod: 'social' },
    { id: 'f2', accessToken: 'tok-f2', provider: 'Github', authMethod: 'social' }
  ], { enableMultiAccount: true, preferredEndpoint: 'codewhisperer' }, async (base) => {
    const r = await claude(base, 'claude-opus-5.5')
    assert.equal(r.status, 400, r.text)
    assert.match(r.text, /MODEL_NOT_AVAILABLE/)
    // 之后同池的 Sonnet 请求不受影响（两个号都没有被错误地打进冷却）
    const ok = await claude(base, 'claude-sonnet-4.5')
    assert.equal(ok.status, 200, ok.text)
  })
  const downgraded = streamCalls().filter(c => c.body.conversationState.currentMessage.userInputMessage.modelId !== 'claude-sonnet-4.5')
  assert.equal(downgraded.length, 0, '没有任何请求被偷偷换成别的模型发出')
})

test('单账号 CodeWhisperer 端点不支持模型 → 明确报错（非流式 400 / 流式 error 事件）', async () => {
  calls.length = 0
  tokenPlan.set('tok-single', 'free')
  await withServer([{ id: 's', accessToken: 'tok-single', provider: 'Google', authMethod: 'social' }],
    { enableMultiAccount: false, preferredEndpoint: 'codewhisperer' }, async (base) => {
      const r = await claude(base, 'claude-opus-5.5')
      assert.equal(r.status, 400, r.text)
      assert.match(r.text, /MODEL_NOT_AVAILABLE/)
      const s = await claude(base, 'claude-opus-5.5', true)
      assert.match(s.text, /event: error[\s\S]*MODEL_NOT_AVAILABLE/)
    })
  assert.equal(streamCalls().length, 0, '没有向后端发出降级请求')
})
