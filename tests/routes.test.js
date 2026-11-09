// 宿主路由：/health /state /save /test /logs，方法限制、同源、错误码、脱敏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes } from '../lib/routes.js'
import { makeError } from '../lib/errors.js'
import { makeReq, makeRes } from './helpers.js'

const 时间 = '2026-11-09T12:00:00.000Z'
const 能力表 = {
  tts: { available: true, ready: true, loaded: false, model: 'IndexTTS-2.5' },
  asr: { available: true, ready: true, loaded: false, model: 'SenseVoiceSmall' },
}

function 快照(overrides = {}) {
  return {
    ok: true,
    reachable: true,
    compatible: true,
    baseUrl: 'http://127.0.0.1:7880',
    latencyMs: 12,
    checkedAt: 时间,
    checkedAtMs: Date.parse(时间),
    serviceVersion: '2.5.0',
    apiVersion: '1',
    vram: { freeMb: 6973, totalMb: 8192 },
    capabilities: 能力表,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides,
  }
}

function 搭环境({ apiOverrides = {}, 初始快照 = 快照(), refreshImpl = null } = {}) {
  const 配置 = {
    baseUrl: 'http://127.0.0.1:7880',
    ttsVoice: 'dafeiyu',
    token: '***已设置***',
    enabled: true,
    cacheDir: 'C:\\cache',
    cacheTtlHours: 72,
    cacheMaxMb: 2048,
    logLevel: 'info',
  }
  let 当前快照 = 初始快照
  const 状态 = { lastCheckAt: Date.parse(时间), latencyMs: 12, consecutiveFailures: 0 }

  const configStore = {
    current: 配置,
    filePath: 'C:\\Users\\Administrator\\.dsh\\fish-service-config.json',
    overrides: ['ttsVoice'],
    save: (c) => c,
  }

  const capabilities = {
    refresh: async (opts) => {
      if (refreshImpl) return refreshImpl(opts)
      return 当前快照
    },
    current: () => 当前快照,
    status: () => 状态,
  }

  const 调用 = { 保存: [], voices: 0, 日志行数: [], refresh: 0 }
  const api = {
    config: {
      get: () => ({ ...配置 }),
      set: async (patch) => {
        调用.保存.push(patch)
        if (patch && patch.bad === true) throw makeError('bad_request', { detail: 'bad', hint: '参数不对：bad' })
        return { ok: true, applied: Object.keys(patch || {}), requiresRestart: false, warnings: [] }
      },
    },
    voices: async () => {
      调用.voices += 1
      return [{ name: 'dafeiyu' }, { name: 'default' }]
    },
    recentErrors: () => [{ code: 'service_down', hint: '没有启动' }],
    ...apiOverrides,
  }

  const cache = { usage: () => ({ dir: 'C:\\cache', bytes: 1024, mb: 0.1, files: 2, byKind: {}, ttlHours: 72, maxMb: 2048 }) }
  const logger = {
    filePath: 'C:\\Users\\Administrator\\.dsh\\fish-service.log',
    recent: (n) => { 调用.日志行数.push(n); return ['line-1', 'line-2'] },
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }

  const routes = new Map()
  const ctx = {
    webServer: {
      register: (def) => { routes.set(def.path, def.handler); return () => routes.delete(def.path) },
    },
  }

  const dispose = registerRoutes({
    ctx,
    api,
    configStore,
    capabilities,
    cache,
    logger,
    version: '0.1.0',
  })

  const call = async (path, { method = 'GET', body, headers = {}, search = '' } = {}) => {
    const handler = routes.get(path)
    assert.ok(handler, `没有注册 ${path}`)
    const req = await makeReq({ method, url: `${path}${search}`, body, headers })
    const res = makeRes()
    await handler(req, res)
    return { res, json: res.json() }
  }

  return { routes, api, 配置, configStore, capabilities, 调用, dispose, call }
}

test('注册 5 条约定路由 + 音色；全部 kind=exact', () => {
  const env = 搭环境()
  assert.deepEqual([...env.routes.keys()].sort(), [
    '/dsh-fish-service/health',
    '/dsh-fish-service/logs',
    '/dsh-fish-service/save',
    '/dsh-fish-service/state',
    '/dsh-fish-service/test',
    '/dsh-fish-service/voices',
  ])
  env.dispose()
  assert.equal(env.routes.size, 0)
})

test('GET /health：插件 + 服务联合状态', async () => {
  const env = 搭环境()
  const { res, json } = await env.call('/dsh-fish-service/health')
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.pluginOk, true)
  assert.equal(json.serviceDown, false)
  assert.equal(json.enabled, true)
  assert.equal(json.pluginVersion, '0.1.0')
  assert.equal(json.baseUrl, 'http://127.0.0.1:7880')
  assert.equal(json.latencyMs, 12)
  assert.equal(json.serviceVersion, '2.5.0')
  assert.equal(json.apiVersion, '1')
})

test('GET /state：配置 / health / 能力 / 音色 / 缓存 / 错误 / env 覆盖', async () => {
  const env = 搭环境()
  const { res, json } = await env.call('/dsh-fish-service/state')
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.plugin.version, '0.1.0')
  assert.equal(json.plugin.configFile, env.configStore.filePath)
  assert.equal(json.plugin.logFile, 'C:\\Users\\Administrator\\.dsh\\fish-service.log')
  assert.equal(json.config.token, '***已设置***')
  assert.equal(json.health.ok, true)
  assert.equal(json.health.serviceVersion, '2.5.0')
  assert.equal(json.capabilities.tts.available, true)
  assert.deepEqual(json.voices, ['dafeiyu', 'default'])
  assert.equal(json.cache.files, 2)
  assert.equal(json.errors[0].code, 'service_down')
  assert.deepEqual(json.envOverrides, ['ttsVoice'])
  assert.equal(env.调用.voices, 1)
})

test('POST /save：合法保存；GET 405；跨站 403；API 错 → 400', async () => {
  const env = 搭环境()
  const ok = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: { ttsVoice: 'default' } },
    headers: { host: '127.0.0.1:10154', origin: 'http://127.0.0.1:10154' },
  })
  assert.equal(ok.res.statusCode, 200)
  assert.equal(ok.json.ok, true)
  assert.deepEqual(ok.json.applied, ['ttsVoice'])
  assert.equal(ok.json.config.token, '***已设置***')
  assert.deepEqual(env.调用.保存[0], { ttsVoice: 'default' })

  const wrongMethod = await env.call('/dsh-fish-service/save')
  assert.equal(wrongMethod.res.statusCode, 405)
  assert.equal(wrongMethod.json.code, 'bad_request')
  assert.match(wrongMethod.json.hint, /只支持 POST/)

  const cross = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: {} },
    headers: { host: '127.0.0.1:10154', origin: 'http://evil.example' },
  })
  assert.equal(cross.res.statusCode, 403)
  assert.match(cross.json.hint, /跨站/)

  const bad = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: { bad: true } },
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(bad.res.statusCode, 400)
  assert.equal(bad.json.code, 'bad_request')
  assert.match(bad.json.hint, /参数不对/)
})

test('POST /test：在线返回能力；离线返回 code/hint', async () => {
  const env = 搭环境()
  const ok = await env.call('/dsh-fish-service/test', {
    method: 'POST', body: { timeoutMs: 3000 }, headers: { host: 'x' },
  })
  assert.equal(ok.res.statusCode, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.reachable, true)
  assert.equal(ok.json.capabilities.tts.available, true)

  const downSnapshot = 快照({
    ok: false,
    reachable: false,
    compatible: false,
    serviceVersion: '',
    lastError: { code: 'service_down', detail: 'ECONNREFUSED', hint: '本地 AI 服务没在运行。' },
  })
  const env2 = 搭环境({ 初始快照: downSnapshot })
  const down = await env2.call('/dsh-fish-service/test', {
    method: 'POST', body: {}, headers: { host: 'x' },
  })
  assert.equal(down.res.statusCode, 200)
  assert.equal(down.json.ok, false)
  assert.equal(down.json.code, 'service_down')
  assert.match(down.json.hint, /服务没在运行/)
})

test('GET /logs：行数钳制 1~1000；POST → 405', async () => {
  const env = 搭环境()
  const r = await env.call('/dsh-fish-service/logs', { search: '?lines=99999' })
  assert.equal(r.res.statusCode, 200)
  assert.deepEqual(r.json.lines, ['line-1', 'line-2'])
  assert.deepEqual(env.调用.日志行数, [1000])

  const r2 = await env.call('/dsh-fish-service/logs', { search: '?lines=0' })
  assert.equal(r2.res.statusCode, 200)
  assert.deepEqual(env.调用.日志行数, [1000, 1])

  const wrong = await env.call('/dsh-fish-service/logs', { method: 'POST', body: {} })
  assert.equal(wrong.res.statusCode, 405)
})

test('GET /voices：成功返回列表；失败仍 200 但 ok=false', async () => {
  const env = 搭环境()
  const ok = await env.call('/dsh-fish-service/voices')
  assert.equal(ok.res.statusCode, 200)
  assert.deepEqual(ok.json.voices.map((x) => x.name), ['dafeiyu', 'default'])

  const env2 = 搭环境({
    apiOverrides: { voices: async () => { throw makeError('service_down', { hint: '服务没在运行' }) } },
  })
  const down = await env2.call('/dsh-fish-service/voices')
  assert.equal(down.res.statusCode, 200)
  assert.equal(down.json.ok, false)
  assert.equal(down.json.code, 'service_down')
  assert.deepEqual(down.json.voices, [])
})

test('路由异常兜底：handler 抛错 → 500 结构化 JSON', async () => {
  const env = 搭环境({
    apiOverrides: { recentErrors: () => { throw new Error('boom') } },
  })
  const r = await env.call('/dsh-fish-service/state')
  assert.equal(r.res.statusCode, 500)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.code, 'upstream_error')
})
