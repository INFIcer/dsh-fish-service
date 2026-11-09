// 宿主路由：/health /state /save /test /logs /voices，以及 P2 的
// /read /audio /transcribe-upload /voice-upload：方法限制、同源、错误码、脱敏、防穿越。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerRoutes } from '../lib/routes.js'
import { CacheStore } from '../lib/cache.js'
import { makeError } from '../lib/errors.js'
import { makeReq, makeRes, makeTempDir } from './helpers.js'

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

function 搭环境({ apiOverrides = {}, 初始快照 = 快照(), refreshImpl = null, 配置补丁 = {}, 缓存 = null } = {}) {
  const 配置 = {
    baseUrl: 'http://127.0.0.1:7880',
    ttsVoice: 'dafeiyu',
    ttsSpeed: 1,
    token: '***已设置***',
    enabled: true,
    cacheDir: 'C:\\cache',
    cacheTtlHours: 72,
    cacheMaxMb: 2048,
    logLevel: 'info',
    ...配置补丁,
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

  const cache = 缓存 || { usage: () => ({ dir: 'C:\\cache', bytes: 1024, mb: 0.1, files: 2, byKind: {}, ttlHours: 72, maxMb: 2048 }) }
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
    let json = null
    try { json = res.json() } catch { json = null }
    return { res, json }
  }

  return { routes, api, 配置, configStore, capabilities, 调用, dispose, call }
}

test('注册 10 条约定路由；全部 kind=exact', () => {
  const env = 搭环境()
  assert.deepEqual([...env.routes.keys()].sort(), [
    '/dsh-fish-service/audio',
    '/dsh-fish-service/health',
    '/dsh-fish-service/logs',
    '/dsh-fish-service/read',
    '/dsh-fish-service/save',
    '/dsh-fish-service/state',
    '/dsh-fish-service/test',
    '/dsh-fish-service/transcribe-upload',
    '/dsh-fish-service/voice-upload',
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

// ---------------- P2：朗读 / 音频 / 语音上传 ----------------

function 造表单(边界, 段们) {
  const 块 = []
  for (const 段 of 段们) {
    let 头 = `--${边界}\r\nContent-Disposition: form-data; name="${段.name}"`
    if (段.filename) 头 += `; filename="${段.filename}"`
    头 += '\r\n'
    if (段.type) 头 += `Content-Type: ${段.type}\r\n`
    头 += '\r\n'
    块.push(Buffer.from(头, 'utf8'))
    块.push(Buffer.isBuffer(段.data) ? 段.data : Buffer.from(String(段.data ?? ''), 'utf8'))
    块.push(Buffer.from('\r\n', 'utf8'))
  }
  块.push(Buffer.from(`--${边界}--\r\n`, 'utf8'))
  return Buffer.concat(块)
}

function 真缓存(temp) {
  const cache = new CacheStore({ dir: join(temp.dir, 'cache'), ttlHours: 72, maxMb: 2048 })
  cache.init()
  return cache
}

test('POST /read：清洗 + 分段 + 调 TTS，返回 wav 列表与 URL', async () => {
  const 调用 = []
  const env = 搭环境({
    apiOverrides: {
      tts: async (texts, opts) => {
        调用.push({ texts, opts })
        return {
          ok: true,
          items: texts.map((文本, i) => ({
            wavPath: `C:\\cache\\tts\\x${i}.wav`,
            ms: 12,
            voice: opts.voice || 'dafeiyu',
            seed: 1,
            bytes: 100,
            cached: false,
          })),
          ms: 30,
        }
      },
    },
  })
  const { res, json } = await env.call('/dsh-fish-service/read', {
    method: 'POST',
    headers: { host: 'x' },
    body: { text: '# 标题\n\n[QQ]你好呀。[/QQ]\n\n```\ncode\n```\n\n再说一句。', voice: 'default', speed: 1.1 },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.chunks, 1)
  assert.equal(json.codeBlocks, 1)
  assert.equal(json.voice, 'default')
  assert.equal(json.speed, 1.1)
  assert.ok(json.wavPath)
  assert.equal(json.items.length, 1)
  assert.ok(json.items[0].url.includes('/dsh-fish-service/audio?path='))
  assert.equal(调用.length, 1)
  assert.deepEqual(调用[0].texts, ['标题\n你好呀。再说一句。'])
  assert.equal(调用[0].opts.voice, 'default')
  assert.equal(调用[0].opts.speed, 1.1)
})

test('POST /read：空文本 400；语速越界 400；服务错误 200 + ok=false', async () => {
  const env = 搭环境()
  const 空 = await env.call('/dsh-fish-service/read', { method: 'POST', headers: { host: 'x' }, body: { text: '   ' } })
  assert.equal(空.res.statusCode, 400)
  assert.equal(空.json.ok, false)

  const 代码 = await env.call('/dsh-fish-service/read', {
    method: 'POST', headers: { host: 'x' }, body: { text: '```\ncode\n```' },
  })
  assert.equal(代码.res.statusCode, 400)
  assert.match(代码.json.hint, /代码块/)

  const 语速 = await env.call('/dsh-fish-service/read', {
    method: 'POST', headers: { host: 'x' }, body: { text: '你好', speed: 9 },
  })
  assert.equal(语速.res.statusCode, 400)
  assert.match(语速.json.hint, /语速/)

  const 错 = 搭环境({
    apiOverrides: { tts: async () => { throw makeError('service_down', { hint: '本地 AI 服务没在运行。' }) } },
  })
  const 失败 = await 错.call('/dsh-fish-service/read', { method: 'POST', headers: { host: 'x' }, body: { text: '你好' } })
  assert.equal(失败.res.statusCode, 200)
  assert.equal(失败.json.ok, false)
  assert.equal(失败.json.code, 'service_down')
  assert.match(失败.json.hint, /没在运行/)
})

test('GET /audio：只读 cacheDir 里的音频；穿越 / 缺文件 / 错扩展都有明确状态码', async () => {
  const temp = makeTempDir()
  const 外面 = makeTempDir()
  try {
    const 音频 = join(temp.dir, 'a.wav')
    writeFileSync(音频, 'RIFFxxxx', 'utf8')
    writeFileSync(join(temp.dir, 'a.txt'), 'not audio', 'utf8')
    const 外部音频 = join(外面.dir, 'evil.wav')
    writeFileSync(外部音频, 'RIFF', 'utf8')

    const env = 搭环境({ 配置补丁: { cacheDir: temp.dir } })
    const ok = await env.call('/dsh-fish-service/audio', { search: `?path=${encodeURIComponent(音频)}` })
    assert.equal(ok.res.statusCode, 200)
    assert.equal(ok.res.headers['content-type'], 'audio/wav')
    assert.equal(ok.res.body, 'RIFFxxxx')

    const 穿越 = await env.call('/dsh-fish-service/audio', { search: `?path=${encodeURIComponent(join(temp.dir, '..', 'x.wav'))}` })
    assert.equal(穿越.res.statusCode, 403)
    assert.match(穿越.json.hint, /缓存目录/)

    const 外面请求 = await env.call('/dsh-fish-service/audio', { search: `?path=${encodeURIComponent(外部音频)}` })
    assert.equal(外面请求.res.statusCode, 403)

    const 错扩展 = await env.call('/dsh-fish-service/audio', { search: `?path=${encodeURIComponent(join(temp.dir, 'a.txt'))}` })
    assert.equal(错扩展.res.statusCode, 400)

    const 缺失 = await env.call('/dsh-fish-service/audio', { search: `?path=${encodeURIComponent(join(temp.dir, 'nope.wav'))}` })
    assert.equal(缺失.res.statusCode, 404)

    const 无参 = await env.call('/dsh-fish-service/audio')
    assert.equal(无参.res.statusCode, 400)

    const 错方法 = await env.call('/dsh-fish-service/audio', { method: 'POST', body: {} })
    assert.equal(错方法.res.statusCode, 405)
  } finally {
    temp.cleanup()
    外面.cleanup()
  }
})

test('POST /transcribe-upload：multipart 录音 → ASR 文本；临时文件请求后删除', async () => {
  const temp = makeTempDir()
  try {
    const cache = 真缓存(temp)
    const 调用 = []
    const env = 搭环境({
      配置补丁: { cacheDir: join(temp.dir, 'cache'), asrLanguage: 'zh' },
      缓存: cache,
      apiOverrides: {
        asr: async (文件, opts) => {
          调用.push({ 文件, opts, 存在: existsSync(文件) })
          return {
            ok: true,
            items: [{ file: 文件, text: '你好世界', language: 'zh', engine: 'sensevoice', elapsedMs: 88, speaker: null }],
            ms: 120,
          }
        },
      },
    })
    const 音频 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02])
    const 体 = 造表单('B1', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: 音频 },
      { name: 'durationMs', data: '3200' },
    ])
    const { res, json } = await env.call('/dsh-fish-service/transcribe-upload', {
      method: 'POST',
      headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=B1' },
      body: 体,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(json.ok, true)
    assert.equal(json.text, '你好世界')
    assert.equal(json.language, 'zh')
    assert.equal(json.bytes, 音频.length)
    assert.equal(typeof json.ms, 'number')
    assert.equal(调用.length, 1)
    assert.equal(调用[0].存在, true)
    assert.equal(调用[0].opts.language, 'zh')
    assert.equal(调用[0].opts.speaker, false)
    assert.equal(readdirSync(join(temp.dir, 'cache', 'tmp')).length, 0)
  } finally {
    temp.cleanup()
  }
})

test('POST /transcribe-upload：缺文件 400；超 5 分钟 400；GET 405', async () => {
  const temp = makeTempDir()
  try {
    const env = 搭环境({ 配置补丁: { cacheDir: join(temp.dir, 'cache') }, 缓存: 真缓存(temp) })
    const 空 = 造表单('B2', [{ name: 'language', data: 'zh' }])
    const 无文件 = await env.call('/dsh-fish-service/transcribe-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=B2' }, body: 空,
    })
    assert.equal(无文件.res.statusCode, 400)
    assert.match(无文件.json.hint, /音频文件/)

    const 长 = 造表单('B3', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: Buffer.from('xx') },
      { name: 'durationMs', data: '400000' },
    ])
    const 超时 = await env.call('/dsh-fish-service/transcribe-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=B3' }, body: 长,
    })
    assert.equal(超时.res.statusCode, 400)
    assert.match(超时.json.hint, /5 分钟/)

    const 错方法 = await env.call('/dsh-fish-service/transcribe-upload')
    assert.equal(错方法.res.statusCode, 405)
  } finally {
    temp.cleanup()
  }
})

test('POST /voice-upload：保留语音写到 cacheDir/voice；超 5 分钟拒绝', async () => {
  const temp = makeTempDir()
  try {
    const cache = 真缓存(temp)
    const env = 搭环境({ 配置补丁: { cacheDir: join(temp.dir, 'cache') }, 缓存: cache })
    const 音频 = Buffer.from([1, 2, 3, 4, 5])
    const 体 = 造表单('V1', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: 音频 },
      { name: 'durationMs', data: '3000' },
    ])
    const { res, json } = await env.call('/dsh-fish-service/voice-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=V1' }, body: 体,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(json.ok, true)
    assert.equal(json.bytes, 音频.length)
    assert.ok(existsSync(json.path))
    assert.ok(json.path.startsWith(join(temp.dir, 'cache', 'voice')))

    const 长 = 造表单('V2', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: 音频 },
      { name: 'durationMs', data: '400000' },
    ])
    const 超时 = await env.call('/dsh-fish-service/voice-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=V2' }, body: 长,
    })
    assert.equal(超时.res.statusCode, 400)
    assert.match(超时.json.hint, /5 分钟/)
  } finally {
    temp.cleanup()
  }
})

test('POST /read 走真实 fish.service：分段合成写缓存，/audio 能回放', async (t) => {
  const { makeStack, basicHandler, sendBuffer } = await import('./helpers.js')
  const 调用 = []
  const stack = await makeStack({
    handler: basicHandler({
      '/tts': (req, res, rec) => {
        调用.push(JSON.parse(rec.body.toString('utf8') || '{}'))
        sendBuffer(res, 200, Buffer.from(`RIFF-${调用.length}`), {
          'content-type': 'audio/wav',
          'x-seed': '7',
          'x-language': 'zh',
        })
      },
    }),
  })
  t.after(() => stack.close())

  const routes = new Map()
  const ctx = { webServer: { register: (定义) => { routes.set(定义.path, 定义.handler); return () => routes.delete(定义.path) } } }
  const dispose = registerRoutes({
    ctx,
    api: stack.api,
    configStore: stack.store,
    capabilities: stack.capabilities,
    cache: stack.cache,
    logger: stack.logger,
    version: '0.1.0',
  })
  t.after(() => dispose())

  const 长文 = '这是一句测试。'.repeat(80) // 480 字，超过 200 的分段上限
  const req = await makeReq({
    method: 'POST',
    url: '/dsh-fish-service/read',
    headers: { host: 'x' },
    body: { text: 长文, maxChars: 200, speed: 1.2 },
  })
  const res = makeRes()
  await routes.get('/dsh-fish-service/read')(req, res)
  const json = JSON.parse(res.body)
  assert.equal(json.ok, true)
  assert.ok(json.chunks >= 2, `应该分段，实际 ${json.chunks}`)
  assert.equal(json.items.length, json.chunks)
  assert.equal(调用.length, json.chunks)
  for (const body of 调用) assert.equal(body.speed, 1.2)
  for (const item of json.items) {
    assert.ok(existsSync(item.wavPath))
    assert.ok(item.wavPath.includes('tts'))
  }

  const 回放 = await makeReq({
    url: `/dsh-fish-service/audio?path=${encodeURIComponent(json.items[0].wavPath)}`,
    headers: { host: 'x' },
  })
  const 回应 = makeRes()
  await routes.get('/dsh-fish-service/audio')(回放, 回应)
  assert.equal(回应.statusCode, 200)
  assert.equal(回应.headers['content-type'], 'audio/wav')
  assert.equal(回应.body, 'RIFF-1')
})

test('POST /read：超过 20 段时按 20 条一批调 TTS（契约上限）', async () => {
  const 批大小 = []
  const env = 搭环境({
    apiOverrides: {
      tts: async (texts) => {
        批大小.push(texts.length)
        return {
          ok: true,
          items: texts.map((_文本, i) => ({
            wavPath: `C:\\cache\\tts\\b${i}.wav`, ms: 1, voice: 'x', seed: 1, bytes: 10,
          })),
          ms: 1,
        }
      },
    },
  })
  const { res, json } = await env.call('/dsh-fish-service/read', {
    method: 'POST',
    headers: { host: 'x' },
    body: { text: '字'.repeat(20000), maxChars: 200 },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.chunks, 40)
  assert.equal(json.truncated, true)
  assert.deepEqual(批大小, [20, 20])
})
