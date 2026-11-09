// 测试公共件：本地 mock localai、临时目录、组装 fish.service。
//
// 所有测试都在 127.0.0.1 上起一个真的 node:http 服务，不连 7880，不加载模型。

import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '../lib/config.js'
import { CacheStore } from '../lib/cache.js'
import { LocalAIClient } from '../lib/client.js'
import { CapabilityService } from '../lib/capabilities.js'
import { Logger } from '../lib/logger.js'
import { createFishServiceApi } from '../lib/service-api.js'

export function sendJson(res, status, body, headers = {}) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(JSON.stringify(body))
}

export function sendBuffer(res, status, buffer, headers = {}) {
  res.statusCode = status
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(buffer)
}

/** 起一个 mock 服务；handler(req,res,record,url) 决定响应。 */
export async function startMock(handler) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    await new Promise((resolve) => req.on('end', resolve))
    const record = {
      method: req.method,
      url: req.url,
      path: (() => { try { return new URL(req.url, 'http://127.0.0.1').pathname } catch { return req.url } })(),
      headers: req.headers,
      body: Buffer.concat(chunks),
    }
    requests.push(record)
    try {
      await handler(req, res, record, new URL(req.url, 'http://127.0.0.1'))
    } catch (error) {
      sendJson(res, 500, { ok: false, error: 'mock_error', detail: String(error?.message || error) })
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export const CAPABILITIES_BODY = Object.freeze({
  ok: true,
  api_version: '1',
  service: { version: '2.5.0' },
  capabilities: {
    tts: { ready: true, loaded: false, model: 'IndexTTS-2.5', estimate_mb: 6400 },
    asr: { ready: true, loaded: false, model: 'SenseVoiceSmall', estimate_mb: 1200 },
    translate: { ready: true, loaded: false, model: 'nllb-200-distilled-600M', estimate_mb: 1500 },
    separate: { ready: true, loaded: false, model: 'htdemucs', estimate_mb: 1000 },
    vision: { ready: true, loaded: false, model: 'Qwen2.5-VL-3B-Instruct-Q4_K_M', estimate_mb: 3400 },
    media: { ready: true, loaded: false, model: 'ffmpeg', estimate_mb: 0 },
    download: { ready: true, loaded: false, model: 'yt-dlp', estimate_mb: 0 },
  },
  jobs: { enabled: true },
  vram: { free_mb: 6973, total_mb: 8192, margin_mb: 512 },
})

/** 默认 mock：能力/健康/显存/音色齐全，其余 404。 */
export function basicHandler(overrides = {}) {
  return async (req, res, record, url) => {
    const 自定义 = overrides[url.pathname]
    if (typeof 自定义 === 'function') return 自定义(req, res, record, url)
    if (url.pathname === '/capabilities') return sendJson(res, 200, CAPABILITIES_BODY)
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, model_ready: true })
    if (url.pathname === '/vram') return sendJson(res, 200, { ok: true, free_mb: 6973, total_mb: 8192, margin_mb: 512 })
    if (url.pathname === '/voices') {
      return sendJson(res, 200, {
        ok: true,
        voices: [
          { name: 'dafeiyu', filename: 'dafeiyu.wav', format: 'wav', duration: 9.4 },
          { name: 'default', filename: 'default.mp3', format: 'mp3', duration: 3.157 },
        ],
      })
    }
    return sendJson(res, 404, { ok: false, error: 'not_found', detail: url.pathname })
  }
}

export function makeTempDir(prefix = 'dsh-fish-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    path: (...parts) => join(dir, ...parts),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

export function writeTempFile(dir, name, content = 'x') {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

/**
 * 组装一套真的 LocalAIClient + CapabilityService + CacheStore + fish.service。
 * 返回的 mock 必须 close，临时目录必须 cleanup。
 */
export async function makeStack({ handler = basicHandler(), config = {}, ttlMs = 30000 } = {}) {
  const mock = await startMock(handler)
  const temp = makeTempDir()
  const store = new ConfigStore({ homeDir: temp.dir })
  store.load({
    baseUrl: mock.url,
    cacheDir: join(temp.dir, 'cache'),
    requestTimeoutMs: 5000,
    asrTimeoutMs: 5000,
    visionTimeoutMs: 5000,
    logLevel: 'error',
    ...config,
  }, {})

  const logger = new Logger({ filePath: join(temp.dir, 'test.log'), level: 'error' })
  const cache = new CacheStore({
    dir: store.current.cacheDir,
    ttlHours: store.current.cacheTtlHours,
    maxMb: store.current.cacheMaxMb,
    logger,
  })
  cache.init()
  const client = new LocalAIClient({ getConfig: () => store.current, logger, retryDelayMs: 10 })
  const capabilities = new CapabilityService({
    client,
    getConfig: () => store.current,
    logger,
    ttlMs,
  })
  const api = createFishServiceApi({ configStore: store, client, capabilities, cache, logger, version: '0.1.0' })

  return {
    api,
    store,
    cache,
    client,
    capabilities,
    mock,
    temp,
    logger,
    async close() {
      cache.stopAutoCleanup()
      await mock.close()
      temp.cleanup()
    },
  }
}

/** 造一个 res 替身，记录状态码/头/正文。 */
export function makeRes() {
  const out = { statusCode: 0, headers: {}, body: '' }
  out.setHeader = (k, v) => { out.headers[String(k).toLowerCase()] = v }
  out.end = (chunk = '') => { out.body += String(chunk) }
  out.json = () => JSON.parse(out.body || '{}')
  return out
}

/** 造一个 req 替身（GET 或带 JSON/multipart body 的 POST）。 */
export async function makeReq({ method = 'GET', url = '/', headers = {}, body = undefined } = {}) {
  const { Readable } = await import('node:stream')
  const 数据 = Buffer.isBuffer(body)
    ? body
    : Buffer.from(body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body)))
  const req = Readable.from(body === undefined ? [] : [数据])
  req.method = method
  req.url = url
  req.headers = headers
  return req
}
