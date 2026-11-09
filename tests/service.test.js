// fish.service：健康、8 类调用、任务、配置、ensureReady、错误映射、宿主装配。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  CAPABILITIES_BODY,
  makeStack,
  basicHandler,
  sendBuffer,
  sendJson,
  startMock,
  writeTempFile,
} from './helpers.js'
import { apply } from '../lib/host.js'

function 解析体(rec) {
  try { return JSON.parse(rec.body.toString('utf8') || '{}') } catch { return {} }
}

test('health() / capabilities 符合契约，capabilities 是同步属性', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())

  assert.equal(stack.api.apiVersion, '1.0')
  assert.equal(stack.api.pluginVersion, '0.1.0')
  assert.equal(stack.api.capabilities.tts.available, false) // 还没探测

  const health = await stack.api.health()
  assert.equal(health.ok, true)
  assert.equal(health.serviceVersion, '2.5.0')
  assert.equal(health.apiVersion, '1')
  assert.equal(health.capabilities.tts.available, true)
  assert.equal(stack.api.capabilities.tts.model, 'IndexTTS-2.5')

  const caps = await stack.api.capabilitiesAsync()
  assert.equal(caps.asr.ready, true)
  assert.equal(typeof stack.api.health, 'function')
  assert.equal(typeof stack.api.ensureReady, 'function')
  assert.equal(typeof stack.api.voices, 'function')
  assert.equal(typeof stack.api.config.set, 'function')
})

test('tts：批量写缓存、只返回路径与指标、同 seed 复用缓存', async (t) => {
  const sent = []
  const handler = basicHandler({
    '/tts': (req, res, rec) => {
      const body = 解析体(rec)
      sent.push(body)
      sendBuffer(res, 200, Buffer.from(`RIFF-${body.text}`), {
        'content-type': 'audio/wav',
        'x-seed': String(body.seed ?? 99),
        'x-language': 'zh',
      })
    },
  })
  const stack = await makeStack({ handler })
  t.after(() => stack.close())

  const first = await stack.api.tts(['你好', '世界'], { voice: 'dafeiyu', seed: 42, speed: 1.1 })
  assert.equal(first.ok, true)
  assert.equal(first.items.length, 2)
  assert.equal(sent.length, 2)
  assert.equal(sent[0].voice, 'dafeiyu')
  assert.equal(sent[0].seed, 42)
  assert.equal(sent[0].speed, 1.1)
  for (const item of first.items) {
    assert.ok(existsSync(item.wavPath))
    assert.ok(item.wavPath.startsWith(join(stack.store.current.cacheDir, 'tts')))
    assert.equal(item.voice, 'dafeiyu')
    assert.equal(item.seed, 42)
    assert.equal(typeof item.bytes, 'number')
    assert.equal(item.cached, false)
  }
  assert.equal('buffer' in first.items[0], false)
  assert.equal(JSON.stringify(first).includes('base64'), false)

  const second = await stack.api.tts(['你好', '世界'], { voice: 'dafeiyu', seed: 42, speed: 1.1 })
  assert.equal(sent.length, 2) // 第二次不再请求
  assert.equal(second.items[0].cached, true)
  assert.equal(second.items[0].ms, 0)
  assert.equal(second.items[0].wavPath, first.items[0].wavPath)
})

test('tts：不传 seed 也查缓存；换音色/语速不命中；统计单调增长、清空后重新合成', async (t) => {
  const sent = []
  const handler = basicHandler({
    '/tts': (req, res, rec) => {
      const body = 解析体(rec)
      sent.push(body)
      sendBuffer(res, 200, Buffer.from(`RIFF-${body.text}-${body.voice}-${body.speed ?? ''}`), {
        'content-type': 'audio/wav',
        'x-seed': '11',
        'x-language': 'zh',
      })
    },
  })
  const stack = await makeStack({ handler })
  t.after(() => stack.close())

  const 一 = await stack.api.tts('同一句话', { voice: 'dafeiyu', speed: 1.2 })
  assert.equal(一.items[0].cached, false)
  assert.equal(一.items[0].seed, 11) // 不传 seed 时服务端随机，用响应头 x-seed 回填
  assert.equal(sent.length, 1)
  const 统计0 = stack.api.cache.stats()
  assert.deepEqual(
    { hits: 统计0.hits, misses: 统计0.misses, hitRate: 统计0.hitRate, kind: 统计0.kind },
    { hits: 0, misses: 1, hitRate: 0, kind: 'tts' },
  )
  assert.equal(统计0.files, 1)
  assert.ok(统计0.bytes > 0)

  const 二 = await stack.api.tts('同一句话', { voice: 'dafeiyu', speed: 1.2 })
  assert.equal(sent.length, 1) // 第二次不再发 HTTP
  assert.equal(二.items[0].cached, true)
  assert.equal(二.items[0].ms, 0)
  assert.equal(二.items[0].wavPath, 一.items[0].wavPath)
  assert.equal(二.items[0].bytes, 一.items[0].bytes)

  const 统计1 = stack.api.cache.stats()
  assert.equal(统计1.hits, 1)
  assert.equal(统计1.misses, 1)
  assert.equal(统计1.hitRate, 0.5)

  const 三 = await stack.api.tts('同一句话', { voice: 'dafeiyu', speed: 1.2 })
  assert.equal(三.items[0].cached, true)
  const 统计2 = stack.api.cache.stats()
  assert.ok(统计2.hitRate > 统计1.hitRate) // 命中率单调增长
  assert.equal(统计2.files, 1) // 同一个文件不重复计数

  // 换音色 / 换语速 → key 变了，必须重新合成
  const 换音色 = await stack.api.tts('同一句话', { voice: 'default', speed: 1.2 })
  assert.equal(换音色.items[0].cached, false)
  const 换语速 = await stack.api.tts('同一句话', { voice: 'dafeiyu', speed: 1.5 })
  assert.equal(换语速.items[0].cached, false)
  assert.equal(sent.length, 3)
  assert.equal(stack.api.cache.stats().misses, 3)
  assert.equal(stack.api.cache.stats().files, 3)
  assert.equal(sent[2].speed, 1.5)

  // 清空 TTS 缓存 → 再合成是 miss；文件账本清零，历史命中计数保留
  const 清 = stack.api.cache.clear({ kind: 'tts' })
  assert.equal(清.ok, true)
  assert.equal(清.kind, 'tts')
  assert.equal(清.files, 3)
  assert.equal(stack.api.cache.stats().files, 0)
  assert.equal(stack.api.cache.stats().hits, 2)
  assert.equal(stack.api.cache.stats().misses, 3)

  const 清后 = await stack.api.tts('同一句话', { voice: 'dafeiyu', speed: 1.2 })
  assert.equal(清后.items[0].cached, false)
  assert.equal(sent.length, 4)
  assert.equal(stack.api.cache.stats().files, 1)

  await assert.rejects(async () => stack.api.cache.clear({ kind: 'nope' }), (e) => e.code === 'bad_request')
  const 清理 = stack.api.cache.cleanup()
  assert.equal(清理.ok, true)
  assert.equal(typeof 清理.expired, 'number')
  assert.equal(typeof 清理.lru, 'number')
})

test('tts：固定 seed 和自动（无 seed）的缓存互不串用', async (t) => {
  const sent = []
  const stack = await makeStack({
    handler: basicHandler({
      '/tts': (req, res, rec) => {
        const body = 解析体(rec)
        sent.push(body)
        sendBuffer(res, 200, Buffer.from(`RIFF-${body.seed ?? 'auto'}`), {
          'content-type': 'audio/wav',
          'x-seed': String(body.seed ?? 77),
        })
      },
    }),
  })
  t.after(() => stack.close())

  const 自动 = await stack.api.tts('一句话', { voice: 'dafeiyu', speed: 1 })
  const 固定 = await stack.api.tts('一句话', { voice: 'dafeiyu', speed: 1, seed: 5 })
  assert.equal(自动.items[0].cached, false)
  assert.equal(固定.items[0].cached, false)
  assert.equal(sent.length, 2)
  assert.equal(固定.items[0].wavPath === 自动.items[0].wavPath, false)
  assert.equal(自动.items[0].seed, 77) // 服务端 x-seed 回填
  assert.equal(固定.items[0].seed, 5)
})

test('tts：21 条 / 空文本 / 超长 / speed / language 都返回 bad_request', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())
  await stack.api.health()

  await assert.rejects(stack.api.tts(Array.from({ length: 21 }, () => 'x')), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.tts(['']), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.tts(['x'.repeat(5001)]), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.tts(['hi'], { speed: 3 }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.tts(['hi'], { language: 'fr' }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.tts([]), (e) => e.code === 'bad_request')
})

test('asr：返回文字/声纹/分段；timestamps 走 /asr/segments；文件不存在 → bad_request', async (t) => {
  const seen = []
  const handler = basicHandler({
    '/asr': (req, res, rec) => {
      seen.push({ path: rec.path, contentType: rec.headers['content-type'] })
      sendJson(res, 200, {
        ok: true,
        text: '你好世界',
        language: 'zh',
        engine: 'sensevoice',
        duration: 1.5,
        elapsed_ms: 120,
        speaker: { name: '小明', score: 0.92, known: true },
      })
    },
    '/asr/segments': (req, res, rec) => {
      seen.push({ path: rec.path })
      sendJson(res, 200, {
        ok: true,
        text: '分段文本',
        language: 'zh',
        engine: 'whisper',
        segments: [
          { start: 0, end: 1, text: '第一段' },
          { start: 1, end: 2, text: '第二段' },
        ],
      })
    },
  })
  const stack = await makeStack({ handler })
  t.after(() => stack.close())
  const wav = writeTempFile(stack.temp.dir, 'a.wav', 'RIFF')

  const r = await stack.api.asr([wav], { speaker: true })
  assert.equal(r.ok, true)
  assert.equal(r.items[0].file, wav)
  assert.equal(r.items[0].text, '你好世界')
  assert.equal(r.items[0].durationMs, 1500)
  assert.equal(r.items[0].elapsedMs, 120)
  assert.deepEqual(r.items[0].speaker, { name: '小明', score: 0.92, known: true })
  assert.ok(seen[0].contentType.startsWith('multipart/form-data'))

  const seg = await stack.api.asr([wav], { timestamps: true, speaker: false })
  assert.equal(seg.items[0].segments.length, 2)
  assert.equal(seen[1].path, '/asr/segments')
  assert.equal(JSON.stringify(seg).includes('base64'), false)

  await assert.rejects(stack.api.asr(['C:\\不存在的文件.wav']), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.asr(['相对路径.wav']), (e) => e.code === 'bad_request')
})

test('translate：单条 / 批量、顺序一致、上限校验', async (t) => {
  const handler = basicHandler({
    '/translate': (req, res, rec) => {
      const body = 解析体(rec)
      sendJson(res, 200, { ok: true, text: `译:${body.text}`, source: body.source, target: body.target, chunks: 1 })
    },
    '/translate/batch': (req, res, rec) => {
      const body = 解析体(rec)
      sendJson(res, 200, { ok: true, texts: body.texts.map((x) => `译:${x}`), source: body.source, target: body.target })
    },
  })
  const stack = await makeStack({ handler })
  t.after(() => stack.close())

  const one = await stack.api.translate('hello', { source: 'auto', target: 'zh' })
  assert.equal(one.texts[0], '译:hello')
  assert.equal(one.engine, 'nllb')

  const many = await stack.api.translate(['a', 'b', 'c'], { source: 'en', target: 'zh' })
  assert.deepEqual(many.texts, ['译:a', '译:b', '译:c'])

  // 空字符串原样返回，且不发给服务端（顺序不变）
  const 请求前 = stack.mock.requests.filter((x) => x.path.startsWith('/translate')).length
  const mixed = await stack.api.translate(['', 'a', ''], { source: 'en', target: 'zh' })
  assert.deepEqual(mixed.texts, ['', '译:a', ''])
  const 请求后 = stack.mock.requests.filter((x) => x.path.startsWith('/translate')).length
  assert.equal(请求后 - 请求前, 1)
  const 全空 = await stack.api.translate(['', ''], { target: 'zh' })
  assert.deepEqual(全空.texts, ['', ''])
  assert.equal(stack.mock.requests.filter((x) => x.path.startsWith('/translate')).length, 请求后)

  await assert.rejects(stack.api.translate(['x'], { target: 'auto' }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.translate(Array.from({ length: 501 }, () => 'x'), { target: 'zh' }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.translate(Array.from({ length: 41 }, () => 'x'.repeat(5000)), { target: 'zh' }), (e) => e.code === 'bad_request')
})

test('separate：复制 stems 到缓存、返回 dir；未知 stem 拒绝', async (t) => {
  let 源目录 = ''
  const stack = await makeStack({
    handler: basicHandler({
      '/separate': (req, res) => {
        sendJson(res, 200, {
          ok: true,
          stems: {
            vocals: { path: join(源目录, 'src-vocals.wav'), duration: 1.2 },
            drums: { path: join(源目录, 'src-drums.wav') },
          },
          released_models: ['asr'],
        })
      },
    }),
  })
  t.after(() => stack.close())
  源目录 = stack.temp.dir
  // 服务器返回的文件必须真实存在
  writeTempFile(源目录, 'src-vocals.wav', 'vocals')
  writeTempFile(源目录, 'src-drums.wav', 'drums')
  const src = writeTempFile(源目录, 'song.mp3', 'audio')

  const r = await stack.api.separate(src, { stems: ['vocals', 'drums'] })
  assert.equal(r.ok, true)
  assert.ok(existsSync(r.dir))
  assert.ok(r.stems.vocals.path.startsWith(join(stack.store.current.cacheDir, 'separate')))
  assert.ok(existsSync(r.stems.vocals.path))
  assert.equal(r.stems.vocals.duration, 1.2)
  assert.deepEqual(r.released, ['asr'])

  await assert.rejects(stack.api.separate(src, { stems: ['vocal'] }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.separate('C:\\nope.wav'), (e) => e.code === 'bad_request')
})

test('visionFrames：复制关键帧到缓存、映射 stats；url 未实现', async (t) => {
  let 源目录 = ''
  let 帧A = ''
  let 帧B = ''
  const stack = await makeStack({
    handler: basicHandler({
      '/vision/frames': (req, res) => {
        sendJson(res, 200, {
          ok: true,
          frames: [
            { time: 1.5, path: 帧A, score: 0.8, kind: 'slide', ocr_text: '标题', summary: '第一帧' },
            { time: 3.0, path: 帧B, confidence: 'low' },
          ],
          duration: 12.5,
          subtitles_from: 'embedded',
          stats: { candidates: 10, vlm_calls: 2, elapsed_ms: 800, degraded: false },
        })
      },
    }),
  })
  t.after(() => stack.close())
  源目录 = stack.temp.dir
  帧A = writeTempFile(源目录, 'f1.jpg', 'fake-jpeg')
  帧B = writeTempFile(源目录, 'f2.jpg', 'fake-jpeg')
  const video = writeTempFile(源目录, 'v.mp4', 'video')

  const r = await stack.api.visionFrames({ videoPath: video }, { targetFrames: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.duration, 12.5)
  assert.equal(r.subtitlesFrom, 'embedded')
  assert.equal(r.frames.length, 2)
  assert.ok(existsSync(r.frames[0].path))
  assert.equal(r.frames[0].time, 1.5)
  assert.equal(r.frames[0].ocrText, '标题')
  assert.equal(r.frames[1].confidence, 'low')
  assert.equal(r.stats.candidates, 10)
  assert.equal(r.stats.vlmCalls, 2)
  assert.equal(JSON.stringify(r).includes('base64'), false)

  await assert.rejects(stack.api.visionFrames({ url: 'https://example.com/a.mp4' }), (e) => e.code === 'not_implemented')
  await assert.rejects(stack.api.visionFrames({}), (e) => e.code === 'bad_request')
})

test('mediaProbe：批量探测、字段映射', async (t) => {
  const stack = await makeStack({
    handler: basicHandler({
      '/media/probe': (req, res) => {
        sendJson(res, 200, {
          ok: true,
          duration: 2.5,
          format: 'wav',
          audio: { codec: 'pcm_s16le', sample_rate: 16000, channels: 1 },
          video: { codec: 'h264', width: 1280, height: 720, fps: 30 },
        })
      },
    }),
  })
  t.after(() => stack.close())
  const a = writeTempFile(stack.temp.dir, 'a.wav', 'a')
  const b = writeTempFile(stack.temp.dir, 'b.mp4', 'b')

  const r = await stack.api.mediaProbe([a, b])
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 2)
  assert.equal(r.items[0].duration, 2.5)
  assert.equal(r.items[0].format, 'wav')
  assert.deepEqual(r.items[0].audio, { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 })
  assert.deepEqual(r.items[0].video, { codec: 'h264', width: 1280, height: 720, fps: 30 })
})

test('jobs：enqueue/status/list/cancel/wait 与 payload 精简', async (t) => {
  let 轮询 = 0
  const stack = await makeStack({
    handler: basicHandler({
      '/jobs': (req, res, rec) => {
        if (req.method === 'POST') {
          const body = 解析体(rec)
          assert.equal(body.kind, 'tts')
          return sendJson(res, 200, { ok: true, id: 'j1', state: 'queued' })
        }
        sendJson(res, 200, {
          ok: true,
          total: 1,
          jobs: [{
            id: 'j1', kind: 'tts', state: 'done', created_at: '2026-11-09T00:00:00Z',
            result: { wavPath: 'C:\\a.wav' }, payload: { text: '不应返回' },
          }],
        })
      },
      '/jobs/j1': (req, res) => {
        轮询 += 1
        sendJson(res, 200, {
          id: 'j1', kind: 'tts', state: 轮询 > 1 ? 'done' : 'running',
          created_at: '2026-11-09T00:00:00Z', result: { wavPath: 'C:\\a.wav' },
        })
      },
      '/jobs/j1/cancel': (req, res) => sendJson(res, 200, { ok: true, id: 'j1', state: 'canceled', cancel_requested: true }),
    }),
  })
  t.after(() => stack.close())

  const enq = await stack.api.jobs.enqueue('tts', { text: 'hi' })
  assert.deepEqual(enq, { ok: true, id: 'j1', state: 'queued' })

  const st = await stack.api.jobs.status('j1')
  assert.equal(st.state, 'running')
  assert.equal(st.result.wavPath, 'C:\\a.wav')
  assert.equal('payload' in st, false)

  const list = await stack.api.jobs.list({ limit: 10 })
  assert.equal(list.total, 1)
  assert.equal(list.jobs[0].kind, 'tts')
  assert.equal('payload' in list.jobs[0], false)

  const canceled = await stack.api.jobs.cancel('j1')
  assert.equal(canceled.state, 'canceled')
  assert.equal(canceled.cancelRequested, true)

  const waited = await stack.api.jobs.wait('j1', { timeoutMs: 2000, pollMs: 200 })
  assert.equal(waited.state, 'done')

  await assert.rejects(stack.api.jobs.status(''), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.jobs.enqueue('nope', {}), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.jobs.enqueue('tts', {}, { files: ['C:\\a.wav'] }), (e) => e.code === 'not_implemented')
})

test('voices：直接映射 /voices，30 秒内不重复请求', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())
  const first = await stack.api.voices()
  assert.deepEqual(first.map((x) => x.name), ['dafeiyu', 'default'])
  assert.equal(first[0].duration, 9.4)

  const 前 = stack.mock.requests.filter((r) => r.path === '/voices').length
  const second = await stack.api.voices()
  assert.deepEqual(second, first)
  assert.equal(stack.mock.requests.filter((r) => r.path === '/voices').length, 前)
})

test('config：get 脱敏；set 白名单、保存、警告、token 原样打码保留', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())

  const pub = stack.api.config.get()
  assert.equal(pub.token, '')
  assert.equal(pub.configFile, stack.store.filePath)
  assert.deepEqual(pub.envOverrides, [])

  const saved = await stack.api.config.set({ ttsVoice: 'default', requestTimeoutMs: 12345 })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.applied.sort(), ['requestTimeoutMs', 'ttsVoice'])
  assert.equal(stack.store.current.ttsVoice, 'default')
  assert.equal(stack.store.current.requestTimeoutMs, 12345)

  const masked = await stack.api.config.set({ token: '***已设置***' })
  assert.deepEqual(masked.applied, [])
  assert.equal(stack.store.current.token, '')

  const before = stack.api.config.get()
  const warned = await stack.api.config.set({ baseUrl: 'ftp://bad', logLevel: 'verbose' })
  assert.equal(warned.ok, true)
  assert.deepEqual(warned.applied, [])
  assert.equal(warned.warnings.length, 2)
  assert.equal(stack.api.config.get().baseUrl, before.baseUrl)
})

test('config：P2 朗读/语音字段可写，非法值给警告且不写', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())

  const 好 = await stack.api.config.set({
    ttsSpeed: 1.25,
    readMaxChars: 3000,
    readConcurrency: 3,
    readSkipCode: false,
    autoRead: true,
    recordMime: 'wav',
    rememberVoiceChoice: false,
    asrLanguage: 'zh',
  })
  assert.equal(好.ok, true)
  assert.deepEqual(好.applied.sort(), [
    'asrLanguage', 'autoRead', 'readConcurrency', 'readMaxChars', 'readSkipCode',
    'recordMime', 'rememberVoiceChoice', 'ttsSpeed',
  ])
  assert.equal(stack.store.current.ttsSpeed, 1.25)
  assert.equal(stack.store.current.readMaxChars, 3000)
  assert.equal(stack.store.current.readConcurrency, 3)
  assert.equal(stack.store.current.readSkipCode, false)
  assert.equal(stack.store.current.autoRead, true)
  assert.equal(stack.store.current.recordMime, 'wav')
  assert.equal(stack.store.current.rememberVoiceChoice, false)
  assert.equal(stack.store.current.asrLanguage, 'zh')

  const 坏 = await stack.api.config.set({
    ttsSpeed: 3,
    readMaxChars: 10,
    readConcurrency: 9,
    recordMime: 'mp3',
    asrLanguage: 'ko',
  })
  assert.equal(坏.ok, true)
  assert.deepEqual(坏.applied, [])
  assert.equal(坏.warnings.length, 5)
  assert.equal(stack.store.current.ttsSpeed, 1.25)
  assert.equal(stack.store.current.readConcurrency, 3)
})

test('ensureReady：tts 通过；preload 只对 tts 生效；未知能力 / 缺模型返回结构化错误', async (t) => {
  const stack = await makeStack({
    handler: basicHandler({
      '/tts': (req, res) => sendBuffer(res, 200, Buffer.from('RIFF'), {
        'content-type': 'audio/wav', 'x-seed': '1', 'x-language': 'zh',
      }),
    }),
  })
  t.after(() => stack.close())

  const ready = await stack.api.ensureReady('tts')
  assert.equal(ready.ok, true)
  assert.equal(ready.ready, true)
  assert.equal(ready.willLoadOnFirstUse, true)
  assert.equal(typeof ready.waitedMs, 'number')

  const preloaded = await stack.api.ensureReady('tts', { preload: true })
  assert.equal(preloaded.ok, true)
  assert.equal(preloaded.loaded, true)
  assert.equal(preloaded.willLoadOnFirstUse, false)

  const vision = await stack.api.ensureReady('vision', { preload: true })
  assert.equal(vision.ok, true)
  assert.equal(vision.willLoadOnFirstUse, true)

  const unknown = await stack.api.ensureReady('nope')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'upstream_error')

  const 缺模型 = structuredClone(CAPABILITIES_BODY)
  缺模型.capabilities.vision.ready = false
  const stack2 = await makeStack({ handler: basicHandler({ '/capabilities': (req, res) => sendJson(res, 200, 缺模型) }) })
  t.after(() => stack2.close())
  const missing = await stack2.api.ensureReady('vision')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'model_missing')
  assert.match(missing.hint, /Qwen2\.5-VL/)
})

test('错误映射：507 → vram_exhausted；503(ready=false) → model_missing；400 → bad_request；504 → timeout', async (t) => {
  const 状态 = { code: 507 }
  const stack = await makeStack({
    handler: basicHandler({
      '/tts': (req, res) => {
        if (状态.code === 507) return sendJson(res, 507, { ok: false, error: 'insufficient_vram', need_mb: 6912, free_mb: 6000 })
        if (状态.code === 504) return sendJson(res, 504, { ok: false, error: 'job_timeout' })
        return sendJson(res, 400, { ok: false, error: 'invalid_text', detail: '文本不合法' })
      },
    }),
  })
  t.after(() => stack.close())

  await assert.rejects(stack.api.tts('hi'), (e) => e.code === 'vram_exhausted' && /显存/.test(e.hint))
  状态.code = 400
  await assert.rejects(stack.api.tts('hi'), (e) => e.code === 'bad_request')
  状态.code = 504
  await assert.rejects(stack.api.tts('hi'), (e) => e.code === 'timeout')

  const 缺模型 = structuredClone(CAPABILITIES_BODY)
  缺模型.capabilities.tts.ready = false
  const stack2 = await makeStack({ handler: basicHandler({ '/capabilities': (req, res) => sendJson(res, 200, 缺模型) }) })
  t.after(() => stack2.close())
  await assert.rejects(stack2.api.tts('hi'), (e) => e.code === 'model_missing' && /IndexTTS/.test(e.hint))
  assert.equal(stack2.mock.requests.some((r) => r.path === '/tts'), false)
})

test('宿主装配：provide fish.service、注册 8 个工具与 5 条路由，stop 可卸载', async (t) => {
  const mock = await startMock(basicHandler())
  const temp = (await import('./helpers.js')).makeTempDir()
  const 旧Home = process.env.DSH_HOME
  process.env.DSH_HOME = temp.dir
  t.after(async () => {
    if (旧Home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = 旧Home
    await mock.close()
    temp.cleanup()
  })

  const provided = {}
  const tools = []
  const routes = []
  const effects = []
  const ctx = {
    provide: (name, value) => { provided[name] = value },
    tools: { register: (def) => { tools.push(def); return () => { const i = tools.indexOf(def); if (i >= 0) tools.splice(i, 1) } } },
    webServer: { register: (def) => { routes.push(def); return () => { const i = routes.indexOf(def); if (i >= 0) routes.splice(i, 1) } } },
    effect: (fn, _label) => { const d = fn(); effects.push(d); return () => { if (typeof d === 'function') d() } },
  }

  const app = apply(ctx, { baseUrl: mock.url, cacheDir: join(temp.dir, 'cache'), logLevel: 'error' })
  t.after(() => app.stop())

  assert.equal(provided['fish.service'], app.api)
  assert.equal(app.api.apiVersion, '1.0')
  assert.equal(tools.length, 8)
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    'fish_asr', 'fish_job', 'fish_media_probe', 'fish_separate',
    'fish_service_status', 'fish_translate', 'fish_tts', 'fish_vision_frames',
  ])
  const paths = routes.map((r) => r.path)
  for (const p of ['/dsh-fish-service/health', '/dsh-fish-service/state', '/dsh-fish-service/save', '/dsh-fish-service/test', '/dsh-fish-service/logs']) {
    assert.ok(paths.includes(p), p)
  }
  assert.equal(routes.every((r) => r.kind === 'exact'), true)

  app.stop()
  assert.equal(tools.length, 0)
  assert.equal(routes.length, 0)
})
