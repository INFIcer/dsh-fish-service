// 错误分类：HTTP 状态码 / 网络异常 → code + 中文 hint。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ERROR_CODES,
  FishServiceError,
  defaultHint,
  extractErrorBody,
  isRetryable,
  makeError,
  mapHttpError,
  mapNetworkError,
  modelMissingHint,
  timeoutHint,
  toPublicError,
  vramHint,
} from '../lib/errors.js'

test('错误码表覆盖契约第 3 节', () => {
  assert.deepEqual([...ERROR_CODES].sort(), [
    'api_incompatible', 'bad_request', 'busy', 'canceled', 'model_loading',
    'model_missing', 'not_implemented', 'service_down', 'service_not_installed',
    'timeout', 'upstream_error', 'vram_exhausted',
  ])
  assert.match(defaultHint('service_down'), /未启动/)
})

test('507 insufficient_vram → vram_exhausted，hint 含显存数字，不可重试', () => {
  const e = mapHttpError(507, { ok: false, error: 'insufficient_vram', need_mb: 6912, free_mb: 6000, detail: '显存不足' })
  assert.equal(e.code, 'vram_exhausted')
  assert.equal(e.retryable, false)
  assert.match(e.hint, /显存/)
  assert.match(e.hint, /6\.8 GB/)
  assert.match(e.hint, /5\.9 GB/)
  assert.equal(e.detail, 'insufficient_vram: 显存不足')
})

test('507 就算没有 need/free 也给中文 hint', () => {
  const e = mapHttpError(507, { ok: false, error: 'insufficient_vram' })
  assert.equal(e.code, 'vram_exhausted')
  assert.match(e.hint, /关闭占用显存的程序/)
})

test('503 + capabilityReady=false → model_missing，不是 upstream_error', () => {
  const e = mapHttpError(503, { ok: false, error: 'engine_error', detail: 'model not found' }, {
    capabilityReady: false,
    model: 'IndexTTS-2.5',
    estimateMb: 6400,
  })
  assert.equal(e.code, 'model_missing')
  assert.equal(e.retryable, false)
  assert.match(e.hint, /模型/)
  assert.match(e.hint, /6\.3 GB/)
  // 模型名是技术细节：只进 detail，不进给用户看的 hint。
  assert.ok(!e.hint.includes('IndexTTS'))
  assert.match(e.detail, /IndexTTS-2\.5/)
})

test('503 + 加载中文案 → model_loading；其它 503 → upstream_error 可重试', () => {
  const loading = mapHttpError(503, { ok: false, error: 'engine_error', detail: '模型正在加载，请稍候' })
  assert.equal(loading.code, 'model_loading')
  assert.equal(loading.retryable, true)

  const upstream = mapHttpError(503, { ok: false, error: 'engine_error', detail: 'CUDA out of memory in engine' }, {
    capabilityReady: true,
  })
  assert.equal(upstream.code, 'upstream_error')
  assert.equal(upstream.retryable, true)
  assert.match(upstream.hint, /重试一次/)
})

test('504 → timeout，hint 带秒数；400/401/403/404/413/422 → bad_request 不重试', () => {
  const timeout = mapHttpError(504, { ok: false, error: 'job_timeout' }, { timeoutMs: 180000 })
  assert.equal(timeout.code, 'timeout')
  assert.match(timeout.hint, /180 秒/)
  assert.equal(timeout.retryable, true)

  for (const status of [400, 401, 403, 404, 413, 422]) {
    const e = mapHttpError(status, { ok: false, error: `e${status}`, detail: 'bad' })
    assert.equal(e.code, 'bad_request', `HTTP ${status}`)
    assert.equal(e.retryable, false, `HTTP ${status}`)
    assert.match(e.hint, /有误|令牌/)
  }
})

test('401 hint 提示检查 token；409 job_canceled → canceled', () => {
  const auth = mapHttpError(401, { ok: false, error: 'unauthorized' })
  assert.match(auth.hint, /令牌/)
  const canceled = mapHttpError(409, { ok: false, error: 'job_canceled' })
  assert.equal(canceled.code, 'canceled')
  assert.equal(canceled.retryable, false)
  const conflict = mapHttpError(409, { ok: false, error: 'not_cancelable' })
  assert.equal(conflict.code, 'bad_request')
})

test('429 → busy；500/502 → upstream_error；未知 code 归 upstream_error', () => {
  assert.equal(mapHttpError(429, {}).code, 'busy')
  assert.equal(mapHttpError(500, {}).code, 'upstream_error')
  assert.equal(mapHttpError(502, { error: 'comfy_error' }).code, 'upstream_error')
  assert.equal(makeError('some_new_code').code, 'upstream_error')
})

test('连接拒绝 → service_down，中文 hint，2 秒内返回', () => {
  const error = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  const e = mapNetworkError(error, { baseUrl: 'http://127.0.0.1:7880' })
  assert.equal(e.code, 'service_down')
  assert.equal(e.retryable, true)
  assert.match(e.hint, /未启动/)
  assert.match(e.detail, /ECONNREFUSED/)
})

test('AbortError → timeout；未知网络异常 → upstream_error', () => {
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  assert.equal(mapNetworkError(abort, { timeoutMs: 3000 }).code, 'timeout')

  const weird = Object.assign(new Error('boom'), { code: 'EUNKNOWN' })
  assert.equal(mapNetworkError(weird).code, 'upstream_error')
})

test('toPublicError 输出 {ok:false, code, hint, error:{...}}，不带 token', () => {
  const e = new FishServiceError('vram_exhausted', { detail: 'need 6912', hint: '显存不够' })
  const pkg = toPublicError(e)
  assert.equal(pkg.ok, false)
  assert.equal(pkg.code, 'vram_exhausted')
  assert.equal(pkg.hint, '显存不够')
  assert.equal(pkg.error.code, 'vram_exhausted')
  assert.equal(pkg.error.hint, '显存不够')
  assert.equal(pkg.retryable, false)
  assert.ok(!JSON.stringify(pkg).includes('token'))
})

test('未知异常也能变成结构化失败包', () => {
  const pkg = toPublicError(new Error('插件炸了'))
  assert.equal(pkg.ok, false)
  assert.equal(pkg.code, 'upstream_error')
  assert.match(pkg.hint, /插件出错/)
  assert.equal(pkg.retryable, false)
})

test('extractErrorBody 兼容 OpenAI 风格与顶层 detail', () => {
  assert.deepEqual(extractErrorBody({ error: { code: 'x', message: 'm' } }), {
    code: 'x', detail: 'm', needMb: undefined, freeMb: undefined,
  })
  assert.equal(extractErrorBody({ error: 'insufficient_vram', detail: 'd' }).code, 'insufficient_vram')
  assert.equal(extractErrorBody('纯文本').detail, '纯文本')
  assert.equal(extractErrorBody(null).detail, '')
})

test('hint 生成函数', () => {
  assert.match(vramHint(), /显存不足/)
  assert.match(vramHint(6912, 6000), /6\.8 GB/)
  assert.match(modelMissingHint('htdemucs_ft'), /模型/)
  assert.ok(!modelMissingHint('htdemucs_ft').includes('htdemucs_ft'), 'hint 不带模型名')
  assert.match(timeoutHint(60000), /60 秒/)
  assert.equal(isRetryable('bad_request'), false)
  assert.equal(isRetryable('timeout'), true)
})
