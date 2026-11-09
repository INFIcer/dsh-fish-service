// 本地 AI 服务的 HTTP 客户端。
//
// ⚠️ 这个文件是**全 DSH 唯一**知道服务地址的地方：其它插件、工具、设置页
// 都通过 fish.service 或 config 拿数据，不自己拼 127.0.0.1:7880。
//
// 职责：
//   - baseUrl / token 注入（token 不进 URL、不进日志）；
//   - 统一超时（AbortController）；
//   - 重试：只有幂等 GET 重试 1 次；POST 一律不重试（避免重复副作用）；
//   - 错误映射：连接失败 / 507 / 503 / 504 / 400 … → 统一 FishServiceError；
//   - multipart 上传与二进制下载。
//
// P1 不实现安装/下载/托管，只做「调用」。

import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import {
  FishServiceError,
  isRetryable,
  makeError,
  mapHttpError,
  mapNetworkError,
} from './errors.js'

const 睡眠 = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

const 猜MIME = (path) => {
  const ext = extname(String(path || '')).toLowerCase()
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.m4a') return 'audio/mp4'
  if (ext === '.ogg') return 'audio/ogg'
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.mkv') return 'video/x-matroska'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  return 'application/octet-stream'
}

/** 组 multipart：fields 是普通表单字段，files 是 [{field, path}]。 */
export function buildFormData(fields = {}, files = []) {
  const form = new FormData()
  for (const [键, 值] of Object.entries(fields || {})) {
    if (值 === undefined || 值 === null || 值 === '') continue
    form.append(键, String(值))
  }
  for (const 文件 of files || []) {
    if (!文件?.path) continue
    const 内容 = readFileSync(文件.path)
    const 名字 = 文件.name || basename(文件.path)
    form.append(文件.field || 'file', new Blob([内容], { type: 猜MIME(文件.path) }), 名字)
  }
  return form
}

export class LocalAIClient {
  constructor({
    getConfig,
    logger = null,
    fetchImpl = globalThis.fetch,
    retryDelayMs = 300,
  } = {}) {
    this.getConfig = getConfig
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.retryDelayMs = retryDelayMs
  }

  baseUrl() {
    const cfg = this.getConfig?.() || {}
    return String(cfg.baseUrl || '').replace(/\/+$/, '')
  }

  token() {
    return String(this.getConfig?.()?.token || '')
  }

  #headers(extra = {}) {
    const 头 = { ...extra }
    const token = this.token()
    if (token) 头.Authorization = `Bearer ${token}`
    return 头
  }

  /**
   * 发一次请求。
   * @param {string} path 以 / 开头的路径（可带 query）
   * @param {object} opts
   * @param {'GET'|'POST'} [opts.method]
   * @param {object|FormData} [opts.body]
   * @param {object} [opts.headers]
   * @param {number} [opts.timeoutMs]
   * @param {'json'|'buffer'|'text'} [opts.expect]
   * @param {string} [opts.capability]
   * @param {boolean} [opts.capabilityReady]
   * @param {number} [opts.retry] 覆盖自动重试次数（默认 GET=2 次尝试，POST=1 次）
   * @returns {Promise<{data:any, headers:Headers, status:number, ms:number, bytes?:number}>}
   */
  async request(path, opts = {}) {
    const cfg = this.getConfig?.() || {}
    if (cfg.enabled === false) {
      throw makeError('service_not_installed', { detail: '插件已在设置里停用' })
    }
    if (!this.fetchImpl) {
      throw makeError('service_down', { detail: '当前 Node 运行时没有 fetch' })
    }

    const method = String(opts.method || 'GET').toUpperCase()
    const isGet = method === 'GET'
    const expect = opts.expect || 'json'
    const timeoutMs = Math.max(50, Number(opts.timeoutMs) || Number(cfg.requestTimeoutMs) || 180000)
    const attempts = opts.retry !== undefined ? Math.max(1, Number(opts.retry) || 1) : (isGet ? 2 : 1)
    const base = this.baseUrl()
    if (!base) throw makeError('service_not_installed', { detail: '没有配置 baseUrl' })

    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`
    let 最后错误 = null

    for (let 第几次 = 1; 第几次 <= attempts; 第几次 += 1) {
      const 开始 = Date.now()
      const 控制器 = new AbortController()
      const 定时器 = setTimeout(() => {
        try { 控制器.abort() } catch { /* 已结束 */ }
      }, timeoutMs)

      let 响应
      try {
        const 请求头 = this.#headers(opts.headers)
        const 体 = opts.body instanceof FormData ? opts.body : (opts.body === undefined ? undefined : JSON.stringify(opts.body))
        if (体 !== undefined && !(体 instanceof FormData) && !请求头['content-type']) {
          请求头['content-type'] = 'application/json'
        }

        this.logger?.debug(`→ ${method} ${url}（${timeoutMs}ms，第 ${第几次}/${attempts} 次）`)
        响应 = await this.fetchImpl(url, {
          method,
          headers: 请求头,
          body: 体,
          signal: 控制器.signal,
        })
      } catch (error) {
        最后错误 = mapNetworkError(error, { timeoutMs, baseUrl: base })
        if (第几次 < attempts && isRetryable(最后错误.code)) {
          this.logger?.warn(`${method} ${path} 失败（${最后错误.code}），${this.retryDelayMs}ms 后重试一次`)
          await 睡眠(this.retryDelayMs)
          continue
        }
        throw 最后错误
      } finally {
        clearTimeout(定时器)
      }

      const 耗时 = Date.now() - 开始

      if (!响应.ok) {
        const 错误体 = await this.#readBody(响应)
        最后错误 = mapHttpError(响应.status, 错误体, {
          capability: opts.capability,
          capabilityReady: opts.capabilityReady,
          timeoutMs,
          model: opts.model,
          estimateMb: opts.estimateMb,
        })
        if (第几次 < attempts && isRetryable(最后错误.code) && 响应.status !== 507) {
          this.logger?.warn(`${method} ${path} → HTTP ${响应.status}（${最后错误.code}），${this.retryDelayMs}ms 后重试一次`)
          await 睡眠(this.retryDelayMs)
          continue
        }
        throw 最后错误
      }

      this.logger?.debug(`← ${method} ${path} HTTP ${响应.status}（${耗时}ms）`)

      if (expect === 'buffer') {
        const 数据 = Buffer.from(await 响应.arrayBuffer())
        return { data: 数据, headers: 响应.headers, status: 响应.status, ms: 耗时, bytes: 数据.length }
      }
      if (expect === 'text') {
        const 数据 = await 响应.text()
        return { data: 数据, headers: 响应.headers, status: 响应.status, ms: 耗时 }
      }

      const 数据 = await this.#readBody(响应)
      return { data: 数据, headers: 响应.headers, status: 响应.status, ms: 耗时 }
    }

    throw 最后错误 || makeError('upstream_error', { detail: '请求没有结果' })
  }

  async #readBody(响应) {
    let 文本 = ''
    try {
      文本 = await 响应.text()
    } catch {
      return null
    }
    if (!文本) return null
    const 类型 = String(响应.headers?.get?.('content-type') || '')
    if (!类型.includes('json')) return 文本
    try {
      return JSON.parse(文本)
    } catch {
      return 文本
    }
  }

  getJson(path, opts = {}) {
    return this.request(path, { ...opts, method: 'GET', expect: 'json' })
  }

  postJson(path, body, opts = {}) {
    return this.request(path, { ...opts, method: 'POST', body, expect: 'json' })
  }

  postBinary(path, body, opts = {}) {
    return this.request(path, { ...opts, method: 'POST', body, expect: 'buffer' })
  }

  postMultipart(path, { fields = {}, files = [], ...opts } = {}) {
    return this.request(path, {
      ...opts,
      method: 'POST',
      body: buildFormData(fields, files),
      expect: opts.expect || 'json',
    })
  }
}

export { FishServiceError }
