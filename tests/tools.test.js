// 8 个工具：参数校验、批量上限、默认值、结构化错误、结果不含 base64。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildToolDefinitions, TOOL_NAMES } from '../lib/tools/index.js'
import { makeError } from '../lib/errors.js'

const 能力 = {
  tts: { available: true, ready: true, loaded: false, model: 'IndexTTS-2.5', estimateMb: 6400 },
  asr: { available: true, ready: true, loaded: false, model: 'SenseVoiceSmall' },
}

function 造假服务() {
  const calls = []
  const 记 = (名) => async (...args) => {
    calls.push([名, args])
    if (名 === 'tts') return { ok: true, items: [{ wavPath: 'C:\\cache\\a.wav', ms: 1, voice: 'dafeiyu', seed: 0, bytes: 10 }], ms: 1 }
    if (名 === 'asr') return { ok: true, items: [{ file: args[0][0], text: '你好' }], ms: 1 }
    if (名 === 'translate') return { ok: true, texts: args[0], source: 'auto', target: args[1].target, engine: 'nllb', ms: 1 }
    if (名 === 'separate') return { ok: true, stems: { vocals: { path: 'C:\\cache\\vocals.wav' } }, dir: 'C:\\cache\\sep', ms: 1 }
    if (名 === 'visionFrames') return { ok: true, frames: [{ time: 1, path: 'C:\\cache\\f.jpg' }], ms: 1 }
    if (名 === 'mediaProbe') return { ok: true, items: args[0].map((file) => ({ file, duration: 1 })), ms: 1 }
    if (名 === 'voices') return [{ name: 'dafeiyu' }, { name: 'default' }]
    return { ok: true }
  }

  const api = {
    tts: 记('tts'),
    asr: 记('asr'),
    translate: 记('translate'),
    separate: 记('separate'),
    visionFrames: 记('visionFrames'),
    mediaProbe: 记('mediaProbe'),
    health: async () => ({
      ok: true,
      baseUrl: 'http://127.0.0.1:7880',
      serviceVersion: '2.5.0',
      apiVersion: '1',
      latencyMs: 12,
      vram: { freeMb: 6973, totalMb: 8192 },
      capabilities: 能力,
      checkedAt: new Date().toISOString(),
      consecutiveFailures: 0,
    }),
    capabilities: async () => 能力,
    voices: 记('voices'),
    install: { status: async () => ({ ok: false, code: 'not_implemented', hint: '安装管理还没实现（P3）。' }) },
    config: { get: () => ({ baseUrl: 'http://127.0.0.1:7880', token: '***已设置***' }) },
    lastError: null,
    recordError() {},
    jobs: {
      status: async (id) => { calls.push(['jobs.status', [id]]); return { ok: true, id, state: 'done' } },
      cancel: async (id) => { calls.push(['jobs.cancel', [id]]); return { ok: true, id, state: 'canceled' } },
      wait: async (id, opts) => { calls.push(['jobs.wait', [id, opts]]); return { ok: true, id, state: 'done' } },
      list: async (filter) => { calls.push(['jobs.list', [filter]]); return { ok: true, total: 0, jobs: [] } },
    },
  }
  return { api, calls }
}

function 工具表(api) {
  const defs = buildToolDefinitions({ api, logger: { warn() {}, error() {}, info() {}, debug() {} } })
  return new Map(defs.map((d) => [d.name, d]))
}

test('8 个工具名固定、schema 是 object + additionalProperties:false', () => {
  const { api } = 造假服务()
  const defs = buildToolDefinitions({ api, logger: null })
  assert.deepEqual(defs.map((d) => d.name), TOOL_NAMES)
  assert.equal(new Set(TOOL_NAMES).size, 8)
  for (const def of defs) {
    assert.equal(def.parameters.type, 'object', def.name)
    assert.equal(def.parameters.additionalProperties, false, def.name)
    if (Object.keys(def.parameters.properties || {}).length > 0 || def.parameters.required !== undefined) {
      assert.ok(Array.isArray(def.parameters.required), def.name)
    }
    assert.equal(typeof def.execute, 'function', def.name)
    assert.equal(typeof def.output.schema, 'object', def.name)
    assert.equal(typeof def.output.render, 'function', def.name)
  }
})

test('fish_tts：21 条 → bad_request，不截断、不调用服务', async () => {
  const { api, calls } = 造假服务()
  const tts = 工具表(api).get('fish_tts')
  const r = await tts.execute({ texts: Array.from({ length: 21 }, (_, i) => `第${i}条`) }, {})
  assert.equal(r.ok, false)
  assert.equal(r.code, 'bad_request')
  assert.match(r.hint, /最多 20 条/)
  assert.match(r.hint, /不自动截断/)
  assert.equal(calls.length, 0)
})

test('fish_tts：空数组 / 非字符串 / 空串 / 超长 / speed / seed 都拒绝', async () => {
  const { api } = 造假服务()
  const tts = 工具表(api).get('fish_tts')
  for (const args of [
    { texts: [] },
    { texts: [1] },
    { texts: [''] },
    { texts: ['x'.repeat(5001)] },
    { texts: ['hi'], speed: 2.5 },
    { texts: ['hi'], seed: -1 },
    { texts: ['hi'], seed: 2 ** 32 },
  ]) {
    const r = await tts.execute(args, {})
    assert.equal(r.ok, false, JSON.stringify(args))
    assert.equal(r.code, 'bad_request', JSON.stringify(args))
  }
})

test('fish_tts：合法参数原样传给服务，且不设置 returnBuffer', async () => {
  const { api, calls } = 造假服务()
  const tts = 工具表(api).get('fish_tts')
  const r = await tts.execute({ texts: ['你好'], voice: 'default', speed: 1.2, language: 'zh', seed: 42 }, {})
  assert.equal(r.ok, true)
  assert.equal(calls[0][0], 'tts')
  const [texts, opts] = calls[0][1]
  assert.deepEqual(texts, ['你好'])
  assert.deepEqual(opts, { voice: 'default', speed: 1.2, language: 'zh', seed: 42 })
  assert.equal('returnBuffer' in opts, false)
  assert.equal(JSON.stringify(r).includes('base64'), false)
  assert.equal(JSON.stringify(r).includes('buffer'), false)
})

test('fish_asr：11 个文件 → bad_request；合法参数默认 speaker=true/timestamps=false', async () => {
  const { api, calls } = 造假服务()
  const asr = 工具表(api).get('fish_asr')
  const tooMany = await asr.execute({ files: Array.from({ length: 11 }, (_, i) => `C:\\a${i}.wav`) }, {})
  assert.equal(tooMany.code, 'bad_request')

  const r = await asr.execute({ files: ['C:\\a.wav'] }, {})
  assert.equal(r.ok, true)
  const opts = calls[0][1][1]
  assert.equal(opts.speaker, true)
  assert.equal(opts.timestamps, false)
  assert.equal(opts.language, 'auto')
  assert.equal(opts.engine, 'auto')
})

test('fish_translate：target 必填且不能 auto；201 条 / 20 万字上限', async () => {
  const { api } = 造假服务()
  const translate = 工具表(api).get('fish_translate')
  assert.equal((await translate.execute({ texts: ['hi'] }, {})).code, 'bad_request')
  assert.equal((await translate.execute({ texts: ['hi'], target: 'auto' }, {})).code, 'bad_request')
  assert.equal((await translate.execute({ texts: Array.from({ length: 201 }, () => 'x'), target: 'zh' }, {})).code, 'bad_request')
  assert.equal((await translate.execute({ texts: Array.from({ length: 41 }, () => 'x'.repeat(5000)), target: 'zh' }, {})).code, 'bad_request')

  const ok = await translate.execute({ texts: ['hello'], target: 'zh' }, {})
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.texts, ['hello'])
})

test('fish_separate：未知 stem / 空 stems 拒绝', async () => {
  const { api } = 造假服务()
  const separate = 工具表(api).get('fish_separate')
  assert.equal((await separate.execute({ file: 'C:\\a.wav', stems: [] }, {})).code, 'bad_request')
  assert.equal((await separate.execute({ file: 'C:\\a.wav', stems: ['vocal'] }, {})).code, 'bad_request')
  const ok = await separate.execute({ file: 'C:\\a.wav', stems: ['vocals'] }, {})
  assert.equal(ok.ok, true)
})

test('fish_vision_frames：targetFrames 越界拒绝，默认值正确', async () => {
  const { api, calls } = 造假服务()
  const vision = 工具表(api).get('fish_vision_frames')
  assert.equal((await vision.execute({ videoPath: 'C:\\a.mp4', targetFrames: 11 }, {})).code, 'bad_request')
  assert.equal((await vision.execute({ videoPath: 'C:\\a.mp4', targetFrames: 0 }, {})).code, 'bad_request')
  const ok = await vision.execute({ videoPath: 'C:\\a.mp4' }, {})
  assert.equal(ok.ok, true)
  const opts = calls[0][1][1]
  assert.equal(opts.targetFrames, 3)
  assert.equal(opts.effort, 'auto')
  assert.equal(opts.planner, 'hybrid')
  assert.equal(opts.subtitles, 'auto')
})

test('fish_media_probe：1~10 个文件', async () => {
  const { api } = 造假服务()
  const media = 工具表(api).get('fish_media_probe')
  assert.equal((await media.execute({ files: Array.from({ length: 11 }, (_, i) => `C:\\${i}.wav`) }, {})).code, 'bad_request')
  const ok = await media.execute({ files: ['C:\\a.wav'] }, {})
  assert.equal(ok.ok, true)
  assert.equal(ok.items[0].file, 'C:\\a.wav')
})

test('fish_job：缺 action / 缺 jobId / 非法枚举都拒绝；list 默认 limit=20', async () => {
  const { api, calls } = 造假服务()
  const job = 工具表(api).get('fish_job')
  assert.equal((await job.execute({}, {})).code, 'bad_request')
  assert.equal((await job.execute({ action: 'explode' }, {})).code, 'bad_request')
  assert.equal((await job.execute({ action: 'status' }, {})).code, 'bad_request')
  assert.equal((await job.execute({ action: 'list', limit: 101 }, {})).code, 'bad_request')

  const list = await job.execute({ action: 'list' }, {})
  assert.equal(list.ok, true)
  assert.equal(calls[0][0], 'jobs.list')
  assert.equal(calls[0][1][0].limit, 20)

  const status = await job.execute({ action: 'status', jobId: 'j1' }, {})
  assert.equal(status.ok, true)
  const canceled = await job.execute({ action: 'cancel', jobId: 'j1' }, {})
  assert.equal(canceled.state, 'canceled')
})

test('fish_service_status：永远返回诊断；服务不可达时 ok=false 且仍有 hint', async () => {
  const { api } = 造假服务()
  const status = 工具表(api).get('fish_service_status')
  const ok = await status.execute({}, {})
  assert.equal(ok.ok, true)
  assert.equal(ok.baseUrl, 'http://127.0.0.1:7880')
  assert.equal(ok.version, '2.5.0')
  assert.equal(ok.capabilities.tts.available, true)
  assert.deepEqual(ok.voices, ['dafeiyu', 'default'])
  assert.equal(JSON.stringify(ok).includes('secret-token'), false)

  const downApi = {
    ...api,
    health: async () => ({ ok: false, baseUrl: 'http://127.0.0.1:7880', lastError: { code: 'service_down', hint: '没有启动' } }),
    capabilities: async () => ({}),
    voices: async () => { throw makeError('service_down') },
    config: { get: () => ({ baseUrl: 'http://127.0.0.1:7880' }) },
  }
  const down = await 工具表(downApi).get('fish_service_status').execute({}, {})
  assert.equal(down.ok, false)
  assert.equal(down.code, 'service_down')
  assert.match(down.hint, /没有启动/)
})

test('safe：api 抛 FishServiceError → 结构化失败包，不抛裸异常', async () => {
  const { api } = 造假服务()
  const broken = {
    ...api,
    tts: async () => { throw makeError('vram_exhausted', { detail: 'need 6912', hint: '显存不够' }) },
  }
  const r = await 工具表(broken).get('fish_tts').execute({ texts: ['hi'] }, {})
  assert.equal(r.ok, false)
  assert.equal(r.code, 'vram_exhausted')
  assert.equal(r.hint, '显存不够')
  assert.equal(r.error.code, 'vram_exhausted')
})
