// 宿主路由：/health /state /save /test /logs /voices，以及 P2 的
// /read /audio /transcribe-upload /voice-upload：方法限制、同源、错误码、脱敏、防穿越。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerRoutes } from '../lib/routes.js'
import { CacheStore } from '../lib/cache.js'
import { makeError } from '../lib/errors.js'
import { prepareSpeech } from '../lib/speech.js'
import { makeReq, makeRes, makeTempDir, makeStack, basicHandler, sendBuffer } from './helpers.js'

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

function 搭环境({ apiOverrides = {}, 初始快照 = 快照(), refreshImpl = null, 配置补丁 = {}, 缓存 = null, spawn = null, platform = 'win32' } = {}) {
  const 配置 = {
    baseUrl: 'http://127.0.0.1:7880',
    ttsVoice: 'dafeiyu',
    ttsSpeed: 1,
    autoRead: false,
    autoReadSessions: {},
    recordDeviceId: '',
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

  const 调用 = { 保存: [], voices: 0, 日志行数: [], refresh: 0, spawn: [] }
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
    // 默认不真的启动 explorer；需要时由用例通过 spawn 注入替身。
    spawn: spawn || ((命令, 参数, 选项) => {
      调用.spawn.push({ 命令, 参数, 选项 })
      return { unref: () => {} }
    }),
    platform,
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

test('注册 17 条约定路由；全部 kind=exact', () => {
  const env = 搭环境()
  assert.deepEqual([...env.routes.keys()].sort(), [
    '/dsh-fish-service/audio',
    '/dsh-fish-service/cache/cleanup',
    '/dsh-fish-service/cache/clear',
    '/dsh-fish-service/cache/stats',
    '/dsh-fish-service/health',
    '/dsh-fish-service/logs',
    '/dsh-fish-service/open-folder',
    '/dsh-fish-service/open-webui',
    '/dsh-fish-service/read',
    '/dsh-fish-service/read/plan',
    '/dsh-fish-service/read/segment',
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
  assert.deepEqual(json.config.autoReadSessions, {})
  assert.equal(json.config.recordDeviceId, '')
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

  const 设备 = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: { recordDeviceId: 'mic-abc' } },
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(设备.res.statusCode, 200)
  assert.deepEqual(设备.json.applied, ['recordDeviceId'])
  assert.deepEqual(env.调用.保存.at(-1), { recordDeviceId: 'mic-abc' })

  const wrongMethod = await env.call('/dsh-fish-service/save')
  assert.equal(wrongMethod.res.statusCode, 405)
  assert.equal(wrongMethod.json.code, 'bad_request')
  assert.match(wrongMethod.json.hint, /仅支持 POST/)

  const cross = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: {} },
    headers: { host: '127.0.0.1:10154', origin: 'http://evil.example' },
  })
  assert.equal(cross.res.statusCode, 403)
  assert.match(cross.json.hint, /来源/)

  const bad = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: { bad: true } },
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(bad.res.statusCode, 400)
  assert.equal(bad.json.code, 'bad_request')
  assert.match(bad.json.hint, /参数不对/)
})

test('POST /save：按会话自动朗读随补丁原样传给配置层', async () => {
  const env = 搭环境()
  const 会话 = { 'session-a': true, 'session-b': false }
  const r = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: { autoReadSessions: 会话 } },
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(r.res.statusCode, 200)
  assert.equal(r.json.ok, true)
  assert.deepEqual(env.调用.保存.at(-1), { autoReadSessions: 会话 })
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
  // 分段语义：按换行/句末切分，但不足 10 字的碎片会并到相邻段（这段整体不到 10 字/片 → 1 段）。
  assert.equal(json.chunks, 1)
  assert.equal(json.codeBlocks, 1)
  assert.equal(json.voice, 'default')
  assert.equal(json.speed, 1.1)
  assert.ok(json.wavPath)
  assert.equal(json.items.length, 1)
  assert.ok(json.items[0].url.includes('/dsh-fish-service/audio?path='))
  assert.equal(调用.length, 1)
  assert.deepEqual(调用[0].texts, ['标题。你好呀。再说一句。'])
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

test('POST /open-folder：只打开 cacheDir 内的目录，spawn 用替身，不弹资源管理器', async () => {
  const temp = makeTempDir()
  const 外面 = makeTempDir()
  try {
    const 子目录 = join(temp.dir, 'voice')
    mkdirSync(子目录, { recursive: true })
    writeFileSync(join(temp.dir, 'a.txt'), 'x', 'utf8')

    const env = 搭环境({ 配置补丁: { cacheDir: temp.dir } })

    // 缓存目录本身：允许，且解析成 realpath 后交给 explorer。
    const 根 = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: temp.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(根.res.statusCode, 200)
    assert.equal(根.json.ok, true)
    assert.equal(根.json.path, realpathSync(temp.dir))
    assert.equal(env.调用.spawn.length, 1)
    assert.equal(env.调用.spawn[0].命令, 'explorer.exe')
    assert.deepEqual(env.调用.spawn[0].参数, [realpathSync(temp.dir)])
    assert.deepEqual(env.调用.spawn[0].选项, { detached: true, stdio: 'ignore' })

    // 子目录也能开。
    const 子 = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: 子目录 },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(子.res.statusCode, 200)
    assert.deepEqual(env.调用.spawn.at(-1).参数, [realpathSync(子目录)])

    // 缓存目录之外 / 相对路径 / 空 / 不存在 / 不是目录：一律拒绝，且不 spawn。
    const 外面请求 = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: 外面.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(外面请求.res.statusCode, 403)
    assert.match(外面请求.json.hint, /缓存目录/)

    const 穿越 = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: join(temp.dir, '..') },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(穿越.res.statusCode, 403)

    const 相对 = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: 'cache' },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(相对.res.statusCode, 400)
    assert.match(相对.json.hint, /绝对路径/)

    const 空 = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: {},
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(空.res.statusCode, 400)

    const 不存在 = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: join(temp.dir, 'nope') },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(不存在.res.statusCode, 404)

    const 文件 = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: join(temp.dir, 'a.txt') },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(文件.res.statusCode, 400)
    assert.match(文件.json.hint, /不是文件夹/)

    assert.equal(env.调用.spawn.length, 2)

    // 方法和来源校验：GET 405，跨站 403。
    const 错方法 = await env.call('/dsh-fish-service/open-folder')
    assert.equal(错方法.res.statusCode, 405)

    const 跨站 = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: temp.dir },
      headers: { host: '127.0.0.1:10154', origin: 'http://evil.example' },
    })
    assert.equal(跨站.res.statusCode, 403)
    assert.equal(env.调用.spawn.length, 2)
  } finally {
    temp.cleanup()
    外面.cleanup()
  }
})

test('POST /open-folder：spawn 失败给可操作提示；缓存目录还不存在时明确说', async () => {
  const temp = makeTempDir()
  try {
    const env = 搭环境({
      配置补丁: { cacheDir: temp.dir },
      spawn: () => { throw new Error('explorer 启动失败') },
    })
    const 失败 = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: temp.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(失败.res.statusCode, 500)
    assert.equal(失败.json.ok, false)
    assert.match(失败.json.hint, /手动打开/)

    // cacheDir 指向不存在的目录：提示先保存设置，而不是报“没有权限”。
    const 缺根 = 搭环境({ 配置补丁: { cacheDir: join(temp.dir, 'missing') } })
    const 回包 = await 缺根.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: temp.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(回包.res.statusCode, 400)
    assert.match(回包.json.hint, /缓存目录/)
  } finally {
    temp.cleanup()
  }
})
test('POST /open-webui：在线时用系统默认浏览器打开管理界面，只拼 /ui，不等待子进程', async () => {
  let 反引用 = 0
  const env = 搭环境({
    spawn: (命令, 参数, 选项) => {
      env.调用.spawn.push({ 命令, 参数, 选项 })
      return { unref: () => { 反引用 += 1 } }
    },
  })

  const r = await env.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(r.res.statusCode, 200)
  assert.equal(r.json.ok, true)
  assert.equal(env.调用.spawn.length, 1)
  assert.equal(env.调用.spawn[0].命令, 'cmd.exe')
  assert.deepEqual(env.调用.spawn[0].参数, ['/c', 'start', '', 'http://127.0.0.1:7880/ui'])
  // detached + ignore：不占宿主的标准输入输出，也不阻塞路由。
  assert.deepEqual(env.调用.spawn[0].选项, { detached: true, stdio: 'ignore' })
  assert.equal(反引用, 1)

  // baseUrl 末尾有斜杠时不出现 //ui。
  const 斜杠 = 搭环境({ 配置补丁: { baseUrl: 'http://127.0.0.1:7880/' } })
  await 斜杠.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.deepEqual(斜杠.调用.spawn.at(-1).参数, ['/c', 'start', '', 'http://127.0.0.1:7880/ui'])
})

test('POST /open-webui：服务离线不打开浏览器，给可操作提示', async () => {
  const 探测 = []
  const env = 搭环境({
    refreshImpl: async (opts) => {
      探测.push(opts)
      return { ...快照(), ok: false, reachable: false, lastError: { code: 'service_down', hint: '连不上' } }
    },
  })

  const r = await env.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(r.res.statusCode, 200)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.code, 'service_down')
  assert.match(r.json.hint, /未启动/)
  // 用 2 秒超时的强制探测，避免拿旧快照误判在线。
  assert.deepEqual(探测[0], { force: true, timeoutMs: 2000 })
  assert.equal(env.调用.spawn.length, 0)
})

test('POST /open-webui：非法 baseUrl 不打开浏览器；非 Windows 明确说不支持', async () => {
  for (const 地址 of ['不是地址', 'ftp://127.0.0.1:7880', 'http://127.0.0.1:7880/&calc']) {
    const env = 搭环境({ 配置补丁: { baseUrl: 地址 } })
    const r = await env.call('/dsh-fish-service/open-webui', {
      method: 'POST',
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(r.res.statusCode, 400, 地址)
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'bad_request')
    assert.equal(env.调用.spawn.length, 0)
  }

  const 非Windows = 搭环境({ platform: 'linux' })
  const r = await 非Windows.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(r.res.statusCode, 200)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.code, 'not_supported')
  assert.match(r.json.hint, /暂不支持/)
  assert.equal(非Windows.调用.spawn.length, 0)
})

test('POST /open-webui：spawn 失败给可操作提示；方法和来源也校验', async () => {
  const env = 搭环境({
    spawn: () => { throw new Error('cmd 启动失败') },
  })
  const 失败 = await env.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(失败.res.statusCode, 500)
  assert.equal(失败.json.code, 'upstream_error')
  assert.match(失败.json.hint, /手动访问/)

  const 错方法 = await env.call('/dsh-fish-service/open-webui')
  assert.equal(错方法.res.statusCode, 405)

  const 跨站 = await env.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154', origin: 'http://evil.example' },
  })
  assert.equal(跨站.res.statusCode, 403)
  assert.equal(env.调用.spawn.length, 0)
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
    // 至少 1500 字节：服务端会把「录音数据过小」当成麦克风没采到声音直接拒绝。
    const 音频 = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 0x11)])
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

  const 长文 = Array.from({ length: 25 }, (_, i) => `这是第${i + 1}句测试内容。`).join('')
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
  // 句末标点即分段边界：25 句 → 25 段（每句都 >= 10 字，不会并段）。
  assert.equal(json.chunks, 25)
  assert.equal(json.items.length, 25)
  // 2 批（每批 20 段），fish.service.tts 内部逐条调 /tts → 25 次 HTTP；并发度 2。
  assert.equal(调用.length, 25)
  assert.equal(json.cachedChunks, 0)
  assert.equal(json.cacheHits, 0)
  assert.equal(json.items[0].cached, false)
  assert.equal(json.concurrency, 2)
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

// ---------------- P2 性能：分段并发 / 流式朗读 / 缓存路由 ----------------

/** 20 个段落、每段 2 句 → maxChars=200 时正好 40 段（每句都够长，不会被合并）。 */
function 造分段长文(段数 = 20) {
  return Array.from({ length: 段数 }, (_未, i) => {
    const 头 = `第${i}段`
    return `${头}${'甲'.repeat(114)}。${头}后${'乙'.repeat(112)}。`
  }).join('\n\n')
}

/** 用真实 stack 注册宿主路由，返回和 routes.test 里一样的 call 接口。 */
function 挂真实路由(stack) {
  const routes = new Map()
  const ctx = {
    webServer: {
      register: (定义) => { routes.set(定义.path, 定义.handler); return () => routes.delete(定义.path) },
    },
  }
  const dispose = registerRoutes({
    ctx,
    api: stack.api,
    configStore: stack.store,
    capabilities: stack.capabilities,
    cache: stack.cache,
    logger: stack.logger,
    version: '0.1.0',
  })
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const handler = routes.get(path)
    assert.ok(handler, `没有注册 ${path}`)
    const req = await makeReq({ method, url: path, body, headers: { host: 'x', ...headers } })
    const res = makeRes()
    await handler(req, res)
    let json = null
    try { json = res.json() } catch { json = null }
    return { res, json }
  }
  return { routes, dispose, call }
}

/** 按文本→期望段序生成 wavPath，用来验证并发后顺序没串。 */
function 段序映射(正文) {
  const 期望 = prepareSpeech(正文, { maxChars: 200 }).chunks
  const 序号 = new Map(期望.map((文本, i) => [文本, i]))
  return { 期望, 序号 }
}

test('POST /read：批间有限并发 ≤ readConcurrency，结果按段序拼接', async () => {
  const 正文 = 造分段长文()
  const { 期望, 序号 } = 段序映射(正文)
  assert.equal(期望.length, 40)

  const 活跃 = { now: 0, peak: 0 }
  const 批大小 = []
  const env = 搭环境({
    配置补丁: { readConcurrency: 2 },
    apiOverrides: {
      tts: async (texts) => {
        活跃.now += 1
        活跃.peak = Math.max(活跃.peak, 活跃.now)
        批大小.push(texts.length)
        await new Promise((r) => setTimeout(r, 25))
        活跃.now -= 1
        return {
          ok: true,
          items: texts.map((文本) => ({
            wavPath: `C:\\cache\\tts\\s${序号.get(文本)}.wav`,
            ms: 1, voice: 'dafeiyu', seed: 1, bytes: 10, cached: false,
          })),
          ms: 1,
        }
      },
    },
  })

  const { res, json } = await env.call('/dsh-fish-service/read', {
    method: 'POST',
    headers: { host: 'x' },
    body: { text: 正文, maxChars: 200 },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.chunks, 40)
  assert.equal(json.concurrency, 2)
  assert.equal(json.cachedChunks, 0)
  assert.deepEqual(批大小.slice().sort((a, b) => a - b), [20, 20])
  assert.equal(活跃.peak, 2) // 两批确实同时在跑
  assert.ok(活跃.peak <= 2) // 且不超过配置的并发度
  for (let i = 0; i < 40; i++) {
    assert.equal(json.items[i].wavPath, `C:\\cache\\tts\\s${i}.wav`, `第 ${i} 段顺序错了`)
    assert.equal(json.items[i].chars, 期望[i].length)
  }
})

test('POST /read：readConcurrency=1 时完全串行（并发峰值 1）', async () => {
  const 正文 = 造分段长文()
  const 活跃 = { now: 0, peak: 0 }
  const env = 搭环境({
    配置补丁: { readConcurrency: 1 },
    apiOverrides: {
      tts: async (texts) => {
        活跃.now += 1
        活跃.peak = Math.max(活跃.peak, 活跃.now)
        await new Promise((r) => setTimeout(r, 10))
        活跃.now -= 1
        return {
          ok: true,
          items: texts.map((_文本, i) => ({ wavPath: `C:\\cache\\tts\\x${i}.wav`, ms: 1, voice: 'x', bytes: 1 })),
          ms: 1,
        }
      },
    },
  })
  const { json } = await env.call('/dsh-fish-service/read', {
    method: 'POST', headers: { host: 'x' }, body: { text: 正文, maxChars: 200 },
  })
  assert.equal(json.ok, true)
  assert.equal(json.chunks, 40)
  assert.equal(json.concurrency, 1)
  assert.equal(活跃.peak, 1)
})

test('POST /read：某批失败时降级串行重试该批，成功后标记 degraded 且顺序不变', async () => {
  const 正文 = 造分段长文()
  const { 期望, 序号 } = 段序映射(正文)
  let 第0批次数 = 0
  const 批大小 = []
  const env = 搭环境({
    配置补丁: { readConcurrency: 2 },
    apiOverrides: {
      tts: async (texts) => {
        批大小.push(texts.length)
        if (texts[0] === 期望[0]) {
          第0批次数 += 1
          if (第0批次数 === 1) throw makeError('service_down', { hint: '本地 AI 服务没在运行。' })
        }
        await new Promise((r) => setTimeout(r, 10))
        return {
          ok: true,
          items: texts.map((文本) => ({
            wavPath: `C:\\cache\\tts\\s${序号.get(文本)}.wav`,
            ms: 1, voice: 'dafeiyu', seed: 1, bytes: 10, cached: false,
          })),
          ms: 1,
        }
      },
    },
  })
  const { json } = await env.call('/dsh-fish-service/read', {
    method: 'POST', headers: { host: 'x' }, body: { text: 正文, maxChars: 200 },
  })
  assert.equal(json.ok, true)
  assert.equal(json.degraded, true)
  assert.equal(第0批次数, 2) // 第一次并发失败 + 一次串行重试
  assert.equal(批大小.length, 3) // 两批并发 + 重试失败那批
  for (let i = 0; i < 40; i++) {
    assert.equal(json.items[i].wavPath, `C:\\cache\\tts\\s${i}.wav`)
  }
})

test('POST /read：降级重试仍失败 → 200 + ok:false，hint 带并发/降级提示', async () => {
  const 正文 = 造分段长文()
  const { 期望 } = 段序映射(正文)
  let 第0批次数 = 0
  const env = 搭环境({
    配置补丁: { readConcurrency: 2 },
    apiOverrides: {
      tts: async (texts) => {
        if (texts[0] === 期望[0]) {
          第0批次数 += 1
          throw makeError('service_down', { hint: '本地 AI 服务没在运行。' })
        }
        return {
          ok: true,
          items: texts.map((_文本, i) => ({ wavPath: `C:\\cache\\tts\\ok${i}.wav`, ms: 1, voice: 'x', bytes: 1 })),
          ms: 1,
        }
      },
    },
  })
  const { res, json } = await env.call('/dsh-fish-service/read', {
    method: 'POST', headers: { host: 'x' }, body: { text: 正文, maxChars: 200 },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, false)
  assert.equal(json.code, 'service_down')
  assert.equal(第0批次数, 2)
  assert.match(json.hint, /同时生成/)
  assert.match(json.hint, /逐段重试/)
})

test('POST /read/plan：立即返回分段计划，不调用 TTS；参数校验齐全', async () => {
  let tts调用 = 0
  const env = 搭环境({
    apiOverrides: {
      tts: async () => {
        tts调用 += 1
        throw new Error('plan 不应调用 TTS')
      },
    },
  })
  const 正文 = 造分段长文()
  const 期望 = prepareSpeech(正文, { maxChars: 200 })

  const ok = await env.call('/dsh-fish-service/read/plan', {
    method: 'POST',
    headers: { host: 'x' },
    body: { text: 正文, maxChars: 200, voice: 'default', speed: 1.1 },
  })
  assert.equal(ok.res.statusCode, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.segments.length, 40)
  assert.equal(ok.json.chars, 期望.chars)
  assert.equal(ok.json.codeBlocks, 0)
  assert.equal(ok.json.truncated, false)
  assert.equal(ok.json.voice, 'default')
  assert.equal(ok.json.speed, 1.1)
  assert.equal(ok.json.maxChars, 200)
  assert.equal(ok.json.segments[0].index, 0)
  assert.equal(ok.json.segments[39].index, 39)
  assert.equal(ok.json.segments[0].text, 期望.chunks[0])
  assert.equal(ok.json.segments[0].chars, 期望.chunks[0].length)
  assert.equal(tts调用, 0)

  // 20000 字 → 40 段截断，且不合成
  const 长 = await env.call('/dsh-fish-service/read/plan', {
    method: 'POST', headers: { host: 'x' }, body: { text: '字'.repeat(20000), maxChars: 200 },
  })
  assert.equal(长.json.ok, true)
  assert.equal(长.json.segments.length, 40)
  assert.equal(长.json.truncated, true)
  assert.equal(tts调用, 0)

  const 空 = await env.call('/dsh-fish-service/read/plan', {
    method: 'POST', headers: { host: 'x' }, body: { text: '   ' },
  })
  assert.equal(空.res.statusCode, 400)
  assert.equal(空.json.code, 'bad_request')

  const 代码 = await env.call('/dsh-fish-service/read/plan', {
    method: 'POST', headers: { host: 'x' }, body: { text: '```\ncode\n```' },
  })
  assert.equal(代码.res.statusCode, 400)
  assert.match(代码.json.hint, /代码块/)

  const 语速 = await env.call('/dsh-fish-service/read/plan', {
    method: 'POST', headers: { host: 'x' }, body: { text: '你好', speed: 9 },
  })
  assert.equal(语速.res.statusCode, 400)
  assert.match(语速.json.hint, /语速/)

  const 错方法 = await env.call('/dsh-fish-service/read/plan')
  assert.equal(错方法.res.statusCode, 405)
})

test('POST /read/segment：只合成一段，返回 index/wavPath/url/ms/cached/bytes；参数校验', async () => {
  const 调用 = []
  const env = 搭环境({
    apiOverrides: {
      tts: async (texts, opts) => {
        调用.push({ texts, opts })
        return {
          ok: true,
          items: [{ wavPath: 'C:\\cache\\tts\\one.wav', ms: 0, voice: 'default', bytes: 123, cached: true }],
          ms: 1,
        }
      },
    },
  })
  const ok = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST',
    headers: { host: 'x' },
    body: { index: 1, total: 3, text: '第二段文字。', voice: 'default', speed: 1.2 },
  })
  assert.equal(ok.res.statusCode, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.index, 1)
  assert.equal(ok.json.wavPath, 'C:\\cache\\tts\\one.wav')
  assert.ok(ok.json.url.includes('/dsh-fish-service/audio?path='))
  assert.equal(ok.json.ms, 0)
  assert.equal(ok.json.cached, true)
  assert.equal(ok.json.bytes, 123)
  assert.equal(ok.json.total, 3)
  assert.equal(ok.json.voice, 'default')
  assert.equal(调用.length, 1)
  assert.deepEqual(调用[0].texts, ['第二段文字。'])
  assert.equal(调用[0].opts.voice, 'default')
  assert.equal(调用[0].opts.speed, 1.2)

  const 负 = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST', headers: { host: 'x' }, body: { index: -1, text: 'x' },
  })
  assert.equal(负.res.statusCode, 400)
  assert.match(负.json.hint, /序号/)

  const 越界 = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST', headers: { host: 'x' }, body: { index: 3, total: 3, text: 'x' },
  })
  assert.equal(越界.res.statusCode, 400)
  assert.match(越界.json.hint, /序号/)

  const 超总段 = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST', headers: { host: 'x' }, body: { index: 0, total: 41, text: 'x' },
  })
  assert.equal(超总段.res.statusCode, 400)
  assert.match(超总段.json.hint, /总段数/)

  const 空文本 = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST', headers: { host: 'x' }, body: { index: 0, total: 1, text: '   ' },
  })
  assert.equal(空文本.res.statusCode, 400)

  const 语速 = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST', headers: { host: 'x' }, body: { index: 0, text: 'x', speed: 9 },
  })
  assert.equal(语速.res.statusCode, 400)
  assert.match(语速.json.hint, /语速/)

  const 错方法 = await env.call('/dsh-fish-service/read/segment')
  assert.equal(错方法.res.statusCode, 405)
  assert.equal(调用.length, 1) // 非法参数一个都没合成
})

test('流式朗读走真实 fish.service：plan 不合成；segment 命中缓存；缓存统计/清空/清理', async (t) => {
  const sent = []
  const stack = await makeStack({
    handler: basicHandler({
      '/tts': (req, res, rec) => {
        sent.push(JSON.parse(rec.body.toString('utf8') || '{}'))
        sendBuffer(res, 200, Buffer.from(`RIFF-${sent.length}`), {
          'content-type': 'audio/wav',
          'x-seed': '7',
          'x-language': 'zh',
        })
      },
    }),
  })
  t.after(() => stack.close())
  const { call, dispose } = 挂真实路由(stack)
  t.after(() => dispose())

  const 正文 = `第一段${'甲'.repeat(130)}。\n\n第二段${'乙'.repeat(130)}。`
  const plan = await call('/dsh-fish-service/read/plan', {
    method: 'POST',
    body: { text: 正文, maxChars: 200, voice: 'dafeiyu', speed: 1 },
  })
  assert.equal(plan.json.ok, true)
  assert.equal(plan.json.segments.length, 2)
  assert.equal(plan.json.voice, 'dafeiyu')
  assert.equal(plan.json.speed, 1)
  assert.equal(sent.length, 0) // plan 不合成

  const 第一 = await call('/dsh-fish-service/read/segment', {
    method: 'POST',
    body: { index: 0, total: 2, text: plan.json.segments[0].text, voice: plan.json.voice, speed: plan.json.speed },
  })
  assert.equal(第一.json.ok, true)
  assert.equal(第一.json.index, 0)
  assert.equal(第一.json.cached, false)
  assert.ok(existsSync(第一.json.wavPath))
  assert.ok(第一.json.url.includes('/dsh-fish-service/audio?path='))
  assert.equal(sent.length, 1)

  const 再播 = await call('/dsh-fish-service/read/segment', {
    method: 'POST',
    body: { index: 0, total: 2, text: plan.json.segments[0].text, voice: plan.json.voice, speed: plan.json.speed },
  })
  assert.equal(再播.json.ok, true)
  assert.equal(再播.json.cached, true)
  assert.equal(再播.json.ms, 0)
  assert.equal(再播.json.wavPath, 第一.json.wavPath)
  assert.equal(sent.length, 1) // 第二次没有发 HTTP

  const 统计 = await call('/dsh-fish-service/cache/stats')
  assert.equal(统计.json.ok, true)
  assert.equal(统计.json.kind, 'tts')
  assert.equal(统计.json.hits, 1)
  assert.equal(统计.json.misses, 1)
  assert.equal(统计.json.hitRate, 0.5)
  assert.equal(统计.json.files, 1)

  const 清 = await call('/dsh-fish-service/cache/clear', { method: 'POST', body: { kind: 'tts' } })
  assert.equal(清.json.ok, true)
  assert.equal(清.json.kind, 'tts')
  assert.equal(清.json.files, 1)
  const 清后统计 = await call('/dsh-fish-service/cache/stats')
  assert.equal(清后统计.json.files, 0)
  assert.equal(清后统计.json.hits, 1) // 历史命中计数不因清缓存而重置

  const 清理 = await call('/dsh-fish-service/cache/cleanup', { method: 'POST', body: {} })
  assert.equal(清理.json.ok, true)
  assert.equal(typeof 清理.json.expired, 'number')
  assert.equal(typeof 清理.json.lru, 'number')

  const 错Kind = await call('/dsh-fish-service/cache/clear', { method: 'POST', body: { kind: 'nope' } })
  assert.equal(错Kind.res.statusCode, 400)
  assert.equal(错Kind.json.code, 'bad_request')

  const 错方法 = await call('/dsh-fish-service/cache/clear')
  assert.equal(错方法.res.statusCode, 405)
})

test('POST /transcribe-upload：录音数据过小 / 太短 时给可操作提示', async () => {
  const temp = makeTempDir()
  try {
    const cache = 真缓存(temp)
    const env = 搭环境({
      配置补丁: { cacheDir: join(temp.dir, 'cache') },
      缓存: cache,
      apiOverrides: { asr: async () => { throw new Error('不该被调用') } },
    })

    const 小音频 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
    const 体小 = 造表单('B2', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: 小音频 },
      { name: 'durationMs', data: '3200' },
    ])
    const 小 = await env.call('/dsh-fish-service/transcribe-upload', {
      method: 'POST',
      headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=B2' },
      body: 体小,
    })
    assert.equal(小.res.statusCode, 400)
    assert.match(小.json.hint, /没有采集到声音/)

    const 正常音频 = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 0x11)])
    const 体短 = 造表单('B3', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: 正常音频 },
      { name: 'durationMs', data: '120' },
    ])
    const 短 = await env.call('/dsh-fish-service/transcribe-upload', {
      method: 'POST',
      headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=B3' },
      body: 体短,
    })
    assert.equal(短.res.statusCode, 400)
    assert.match(短.json.hint, /录音太短/)
  } finally {
    temp.cleanup()
  }
})
