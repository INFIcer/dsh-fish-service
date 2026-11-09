// 能力发现：/capabilities 解析、30 秒缓存、版本兼容、失败降级。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_NAMES,
  CapabilityService,
  capabilitySignature,
  emptyCapabilities,
  parseCapabilities,
} from '../lib/capabilities.js'
import { makeError } from '../lib/errors.js'
import { CAPABILITIES_BODY } from './helpers.js'

class FakeClient {
  constructor(responses) {
    this.responses = responses
    this.calls = []
  }

  async getJson(path) {
    this.calls.push(path)
    const r = this.responses[path]
    if (r instanceof Error) throw r
    const data = typeof r === 'function' ? r() : structuredClone(r)
    return { data, headers: new Headers(), status: 200, ms: 12 }
  }
}

const 默认响应 = () => ({
  '/capabilities': CAPABILITIES_BODY,
  '/health': { ok: true, model_ready: true },
  '/vram': { ok: true, free_mb: 6973, total_mb: 8192, margin_mb: 512 },
})

const 基础配置 = { baseUrl: 'http://127.0.0.1:7880', apiVersion: '1', enabled: true, enabledCapabilities: [] }

test('parseCapabilities 输出 8 个能力，字段符合 CONTRACT 1.2', () => {
  const caps = parseCapabilities(CAPABILITIES_BODY, { ok: true }, { free_mb: 1, total_mb: 2 }, {
    config: 基础配置,
    compatible: true,
  })
  assert.deepEqual(Object.keys(caps).sort(), [...CAPABILITY_NAMES].sort())
  assert.equal(caps.tts.available, true)
  assert.equal(caps.tts.ready, true)
  assert.equal(caps.tts.loaded, false)
  assert.equal(caps.tts.model, 'IndexTTS-2.5')
  assert.equal(caps.tts.estimateMb, 6400)
  assert.deepEqual(caps.tts.versions, { service: '2.5.0', api: '1' })
  assert.equal(caps.tts.reason, undefined)
  assert.equal(caps.media.estimateMb, undefined)
  assert.equal(caps.jobs.available, true)
  assert.equal(caps.jobs.ready, true)
  assert.equal(caps.jobs.loaded, false)
})

test('缺少 tts → available=false + reason=not_supported', () => {
  const body = structuredClone(CAPABILITIES_BODY)
  delete body.capabilities.tts
  const caps = parseCapabilities(body, null, null, { config: 基础配置, compatible: true })
  assert.equal(caps.tts.available, false)
  assert.equal(caps.tts.ready, false)
  assert.equal(caps.tts.reason, 'not_supported')
  assert.equal(caps.asr.available, true)
})

test('api 主版本不兼容 → 全部 api_incompatible', () => {
  const caps = parseCapabilities(CAPABILITIES_BODY, null, null, { config: 基础配置, compatible: false })
  for (const 名 of CAPABILITY_NAMES) {
    assert.equal(caps[名].available, false, 名)
    assert.equal(caps[名].reason, 'api_incompatible', 名)
  }
})

test('ready=false → model_missing；enabledCapabilities 白名单外标 disabledByConfig', () => {
  const body = structuredClone(CAPABILITIES_BODY)
  body.capabilities.asr.ready = false
  const caps = parseCapabilities(body, null, null, { config: 基础配置, compatible: true })
  assert.equal(caps.asr.available, false)
  assert.equal(caps.asr.reason, 'model_missing')

  const 白名单 = parseCapabilities(body, null, null, {
    config: { ...基础配置, enabledCapabilities: ['tts'] },
    compatible: true,
  })
  assert.equal(白名单.asr.available, false)
  assert.equal(白名单.asr.reason, 'not_supported')
  assert.equal(白名单.asr.disabledByConfig, true)
  assert.equal(白名单.vision.available, false)
  assert.equal(白名单.vision.reason, 'not_supported')
  assert.equal(白名单.vision.disabledByConfig, true)
  assert.equal(白名单.tts.available, true)
})

test('whisper / speaker 不单独出现（归到 asr）', () => {
  const body = structuredClone(CAPABILITIES_BODY)
  body.capabilities.whisper = { ready: true }
  body.capabilities.speaker = { ready: true }
  const caps = parseCapabilities(body, null, null, { config: 基础配置, compatible: true })
  assert.equal('whisper' in caps, false)
  assert.equal('speaker' in caps, false)
})

test('jobs.enabled=false → jobs 不可用', () => {
  const body = structuredClone(CAPABILITIES_BODY)
  body.jobs = { enabled: false }
  const caps = parseCapabilities(body, null, null, { config: 基础配置, compatible: true })
  assert.equal(caps.jobs.available, false)
  assert.equal(caps.jobs.reason, 'not_supported')
})

test('emptyCapabilities / capabilitySignature', () => {
  const empty = emptyCapabilities('service_down', { service: '2.5.0' })
  assert.equal(empty.tts.available, false)
  assert.equal(empty.tts.reason, 'service_down')
  assert.deepEqual(empty.tts.versions, { service: '2.5.0' })
  assert.equal(capabilitySignature(empty), capabilitySignature(emptyCapabilities('service_down')))
  const changed = structuredClone(empty)
  changed.tts.available = true
  assert.notEqual(capabilitySignature(empty), capabilitySignature(changed))
})

test('CapabilityService 缓存 30 秒（同 now 不重复探测）', async () => {
  let now = 1_000
  const client = new FakeClient(默认响应())
  const svc = new CapabilityService({
    client,
    getConfig: () => 基础配置,
    ttlMs: 30000,
    now: () => now,
  })

  const first = await svc.refresh()
  assert.equal(first.ok, true)
  assert.equal(first.fromCache, false)
  assert.deepEqual(client.calls.sort(), ['/capabilities', '/health', '/vram'])

  client.calls.length = 0
  now = 20_000
  const second = await svc.refresh()
  assert.equal(second.fromCache, true)
  assert.deepEqual(client.calls, [])

  now = 32_000
  client.calls.length = 0
  const third = await svc.refresh()
  assert.equal(third.fromCache, false)
  assert.equal(client.calls.length, 3)

  client.calls.length = 0
  const forced = await svc.refresh({ force: true })
  assert.equal(forced.fromCache, false)
  assert.equal(client.calls.length, 3)
})

test('服务不可达 → ok=false、全部 service_down；health() 不带 capabilities', async () => {
  const client = new FakeClient({
    '/capabilities': makeError('service_down', { detail: 'ECONNREFUSED' }),
    '/health': makeError('service_down', { detail: 'ECONNREFUSED' }),
    '/vram': makeError('service_down', { detail: 'ECONNREFUSED' }),
  })
  const svc = new CapabilityService({ client, getConfig: () => 基础配置, logger: null, ttlMs: 0 })
  const snap = await svc.refresh()
  assert.equal(snap.ok, false)
  assert.equal(snap.reachable, false)
  assert.equal(snap.capabilities.tts.reason, 'service_down')
  assert.equal(snap.lastError.code, 'service_down')

  const health = await svc.health()
  assert.equal(health.ok, false)
  assert.equal('capabilities' in health, false)
  assert.equal(health.lastError.code, 'service_down')
})

test('连续 2 次失败发 service-down；恢复后发 service-up', async () => {
  let 失败 = true
  const client = new FakeClient({
    '/capabilities': () => {
      if (失败) throw makeError('service_down', { detail: 'down' })
      return structuredClone(CAPABILITIES_BODY)
    },
    '/health': { ok: true },
    '/vram': { ok: true, free_mb: 1, total_mb: 2 },
  })
  const svc = new CapabilityService({ client, getConfig: () => 基础配置, ttlMs: 0 })
  const events = []
  svc.events.on('service-down', (e) => events.push(['down', e.reason]))
  svc.events.on('service-up', (e) => events.push(['up', e.serviceVersion]))

  await svc.refresh()
  assert.deepEqual(events, [])
  await svc.refresh()
  assert.deepEqual(events, [['down', 'service_down']])

  失败 = false
  await svc.refresh()
  assert.deepEqual(events, [['down', 'service_down'], ['up', '2.5.0']])
})

test('require()：可用能力通过；ready=false → model_missing；未知能力 → upstream_error', async () => {
  const 响应 = 默认响应()
  const client = new FakeClient(响应)
  const svc = new CapabilityService({ client, getConfig: () => 基础配置, ttlMs: 0 })

  const ok = await svc.require('tts')
  assert.equal(ok.ok, true)
  assert.equal(ok.info.available, true)

  const 缺模型 = structuredClone(CAPABILITIES_BODY)
  缺模型.capabilities.tts.ready = false
  响应['/capabilities'] = 缺模型
  svc.invalidate()
  const missing = await svc.require('tts', { force: true })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'model_missing')
  assert.match(missing.error.hint, /IndexTTS-2\.5/)

  const bogus = await svc.require('bogus')
  assert.equal(bogus.ok, false)
  assert.equal(bogus.error.code, 'upstream_error')

  const 不兼容 = structuredClone(CAPABILITIES_BODY)
  不兼容.api_version = '2'
  响应['/capabilities'] = 不兼容
  svc.invalidate()
  const incompatible = await svc.require('tts', { force: true })
  assert.equal(incompatible.ok, false)
  assert.equal(incompatible.error.code, 'api_incompatible')
})

test('enabled=false 时直接返回 service_not_installed，不探测', async () => {
  const client = new FakeClient(默认响应())
  const svc = new CapabilityService({
    client,
    getConfig: () => ({ ...基础配置, enabled: false }),
    ttlMs: 0,
  })
  const r = await svc.require('tts')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'service_not_installed')
  assert.deepEqual(client.calls, [])
})

test('health() 每次强制探测，字段符合 CONTRACT 1.3', async () => {
  const client = new FakeClient(默认响应())
  const svc = new CapabilityService({ client, getConfig: () => 基础配置, ttlMs: 30000 })
  await svc.refresh()
  const h = await svc.health()
  assert.equal(h.ok, true)
  assert.equal(h.baseUrl, 'http://127.0.0.1:7880')
  assert.equal(h.serviceVersion, '2.5.0')
  assert.equal(h.apiVersion, '1')
  assert.equal(typeof h.latencyMs, 'number')
  assert.match(h.checkedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(h.vram, { freeMb: 6973, totalMb: 8192, marginMb: 512 })
  assert.equal(h.capabilities.tts.available, true)
  assert.equal(h.consecutiveFailures, 0)
  assert.equal(client.calls.filter((x) => x === '/health').length, 2)
})
