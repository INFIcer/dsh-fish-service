// HTTP 客户端：超时、重试、token 注入、错误映射、multipart / 二进制。
import test from 'node:test'
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { LocalAIClient, buildFormData } from '../lib/client.js'
import { makeTempDir, sendBuffer, sendJson, startMock, writeTempFile } from './helpers.js'

function 造客户端(url, config = {}) {
  return new LocalAIClient({
    getConfig: () => ({
      baseUrl: url,
      requestTimeoutMs: 5000,
      token: '',
      enabled: true,
      ...config,
    }),
    retryDelayMs: 5,
  })
}

test('200 JSON：解析正文、返回耗时；token 走 Authorization 头，不进 URL', async (t) => {
  const mock = await startMock((req, res) => sendJson(res, 200, { ok: true, hello: '世界' }))
  t.after(() => mock.close())
  const client = 造客户端(mock.url, { token: 'secret-token' })

  const r = await client.getJson('/health')
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, { ok: true, hello: '世界' })
  assert.equal(typeof r.ms, 'number')
  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].headers.authorization, 'Bearer secret-token')
  assert.ok(!mock.requests[0].url.includes('secret-token'))
})

test('baseUrl 结尾斜杠不会拼出双斜杠', async (t) => {
  const mock = await startMock((req, res, rec) => sendJson(res, 200, { path: rec.path }))
  t.after(() => mock.close())
  const client = 造客户端(`${mock.url}///`)
  const r = await client.getJson('/capabilities')
  assert.equal(r.data.path, '/capabilities')
})

test('507 → vram_exhausted，retryable=false，hint 含显存', async (t) => {
  const mock = await startMock((req, res) => sendJson(res, 507, {
    ok: false, error: 'insufficient_vram', need_mb: 6912, free_mb: 6000,
  }))
  t.after(() => mock.close())
  const client = 造客户端(mock.url)
  await assert.rejects(client.postJson('/tts', { text: 'hi' }), (error) => {
    assert.equal(error.code, 'vram_exhausted')
    assert.equal(error.retryable, false)
    assert.match(error.hint, /显存/)
    return true
  })
  assert.equal(mock.requests.length, 1)
})

test('503 + capabilityReady=false → model_missing；ready=true → upstream_error', async (t) => {
  const mock = await startMock((req, res) => sendJson(res, 503, {
    ok: false, error: 'engine_error', detail: 'model not loaded',
  }))
  t.after(() => mock.close())
  const client = 造客户端(mock.url)

  await assert.rejects(
    client.getJson('/x', { capabilityReady: false, model: 'htdemucs_ft', estimateMb: 2000 }),
    (error) => error.code === 'model_missing'
      && /模型/.test(error.hint)
      && !/htdemucs_ft/.test(error.hint)
      && /htdemucs_ft/.test(error.detail),
  )
  await assert.rejects(
    client.getJson('/x', { capabilityReady: true }),
    (error) => error.code === 'upstream_error' && error.retryable === true,
  )
})

test('503 detail 含“加载” → model_loading', async (t) => {
  const mock = await startMock((req, res) => sendJson(res, 503, {
    ok: false, error: 'engine_error', detail: '模型正在加载，请稍等',
  }))
  t.after(() => mock.close())
  const client = 造客户端(mock.url)
  await assert.rejects(client.getJson('/x'), (error) => error.code === 'model_loading')
})

test('504 → timeout；400 → bad_request 且不重试', async (t) => {
  let 状态 = 504
  const mock = await startMock((req, res) => sendJson(res, 状态, { ok: false, error: 'job_timeout' }))
  t.after(() => mock.close())
  const client = 造客户端(mock.url)

  await assert.rejects(client.getJson('/x'), (error) => error.code === 'timeout')
  状态 = 400
  const 前 = mock.requests.length
  await assert.rejects(client.postJson('/x', { a: 1 }), (error) => error.code === 'bad_request')
  assert.equal(mock.requests.length - 前, 1)
})

test('GET 失败重试 1 次；第二次成功就返回', async (t) => {
  let 次数 = 0
  const mock = await startMock((req, res) => {
    次数 += 1
    if (次数 === 1) return sendJson(res, 500, { ok: false, error: 'boom' })
    return sendJson(res, 200, { ok: true })
  })
  t.after(() => mock.close())
  const client = 造客户端(mock.url)
  const r = await client.getJson('/health')
  assert.equal(r.data.ok, true)
  assert.equal(次数, 2)
})

test('GET 连续失败最多 2 次；POST 不自动重试（避免重复推理）', async (t) => {
  const mock = await startMock((req, res) => sendJson(res, 500, { ok: false, error: 'boom' }))
  t.after(() => mock.close())
  const client = 造客户端(mock.url)

  await assert.rejects(client.getJson('/x'), (error) => error.code === 'upstream_error')
  assert.equal(mock.requests.length, 2)

  mock.requests.length = 0
  await assert.rejects(client.postJson('/x', {}), (error) => error.code === 'upstream_error')
  assert.equal(mock.requests.length, 1)
})

test('连接拒绝 → service_down，2 秒内返回', async () => {
  const mock = await startMock((req, res) => sendJson(res, 200, {}))
  const url = mock.url
  await mock.close()

  const client = 造客户端(url)
  const 开始 = Date.now()
  await assert.rejects(client.getJson('/health'), (error) => {
    assert.equal(error.code, 'service_down')
    assert.match(error.hint, /未启动/)
    return true
  })
  assert.ok(Date.now() - 开始 < 2000)
})

test('请求超时 → timeout（AbortError）', async (t) => {
  const mock = await startMock((req, res) => {
    setTimeout(() => sendJson(res, 200, { ok: true }), 800)
  })
  t.after(() => mock.close())
  const client = 造客户端(mock.url)
  const 开始 = Date.now()
  await assert.rejects(client.getJson('/slow', { timeoutMs: 100 }), (error) => {
    assert.equal(error.code, 'timeout')
    assert.match(error.hint, /等待超时/)
    return true
  })
  assert.ok(Date.now() - 开始 < 700)
})

test('非 JSON 响应按文本返回；二进制响应返回 Buffer', async (t) => {
  const mock = await startMock((req, res, rec) => {
    if (rec.path === '/text') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('你好，世界')
      return
    }
    sendBuffer(res, 200, Buffer.from([1, 2, 3, 4]), { 'content-type': 'audio/wav', 'x-seed': '42' })
  })
  t.after(() => mock.close())
  const client = 造客户端(mock.url)

  const text = await client.request('/text', { expect: 'text' })
  assert.equal(text.data, '你好，世界')

  const bin = await client.request('/audio', { expect: 'buffer' })
  assert.ok(Buffer.isBuffer(bin.data))
  assert.deepEqual([...bin.data], [1, 2, 3, 4])
  assert.equal(bin.headers.get('x-seed'), '42')
  assert.equal(bin.bytes, 4)
})

test('buildFormData：空字段跳过，文件带 filename 与 MIME', () => {
  const temp = makeTempDir()
  try {
    const wav = writeTempFile(temp.dir, 'a.wav', Buffer.from([0, 1, 2]))
    const form = buildFormData({ text: 'hi', empty: '', missing: null }, [{ field: 'file', path: wav }])
    assert.equal(form.get('text'), 'hi')
    assert.equal(form.get('empty'), null)
    const file = form.get('file')
    assert.equal(basename(file.name), 'a.wav')
    assert.equal(file.type, 'audio/wav')
  } finally {
    temp.cleanup()
  }
})

test('enabled=false 时不发请求，直接 service_not_installed', async () => {
  const client = 造客户端('http://127.0.0.1:1', { enabled: false })
  await assert.rejects(client.getJson('/health'), (error) => error.code === 'service_not_installed')
})

test('没有 baseUrl → service_not_installed', async () => {
  const client = 造客户端('')
  await assert.rejects(client.getJson('/health'), (error) => error.code === 'service_not_installed')
})
