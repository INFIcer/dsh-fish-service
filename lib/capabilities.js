// 能力发现：把 /capabilities + /health + /vram 合成契约里的 CapabilityInfo。
//
// 规则（CONTRACT 1.2 / DESIGN 8.2）：
//   - available = 服务可达 && api 主版本兼容 && 服务端有该能力 && ready；
//   - jobs 是 API 组不是模型：只要可达且 jobs.enabled 就算 available；
//   - whisper 归到 asr（engine=whisper），speaker 归到 asr（speaker:true）；
//   - 结果缓存 30 秒；507/503 时由调用方主动 invalidate。

import { EventEmitter } from 'node:events'
import { modelMissingHint, timeoutHint } from './errors.js'

export const CAPABILITY_NAMES = Object.freeze([
  'tts', 'asr', 'translate', 'separate', 'vision', 'media', 'download', 'jobs',
])

export const CAPABILITY_TITLES = Object.freeze({
  tts: '文字转语音',
  asr: '语音识别',
  translate: '翻译',
  separate: '人声分离',
  vision: '视觉',
  media: '媒体工具',
  download: '下载',
  jobs: '任务队列',
})

/** 全部不可用的一组能力（服务没通/版本不兼容时用）。 */
export function emptyCapabilities(reason = 'service_down', versions = undefined) {
  const 出 = {}
  for (const 名 of CAPABILITY_NAMES) {
    出[名] = {
      available: false,
      ready: false,
      loaded: false,
      reason,
      ...(versions ? { versions } : {}),
    }
  }
  return 出
}

const 主版本 = (版本) => String(版本 == null ? '' : 版本).trim().split('.')[0]

const 布尔 = (值) => 值 === true || 值 === 1 || 值 === '1' || 值 === 'true'

/**
 * 解析服务端 capabilities。
 * @param {object} raw GET /capabilities 的响应
 * @param {object} health GET /health 的响应（可选，用来补模型/加载状态）
 * @param {object} vram GET /vram 的响应（可选）
 * @param {{config?:object, compatible?:boolean}} opts
 * @returns {Record<string, object>}
 */
export function parseCapabilities(raw, health = null, vram = null, opts = {}) {
  const 配置 = opts.config || {}
  const 兼容 = opts.compatible !== false
  const 原始能力 = raw?.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {}
  const 服务版本 = raw?.service?.version
  const api版本 = raw?.api_version != null ? String(raw.api_version) : ''
  const versions = { service: 服务版本, api: api版本 }
  const 白名单 = Array.isArray(配置.enabledCapabilities) ? 配置.enabledCapabilities : []

  const 显存 = vram && typeof vram === 'object'
    ? vram
    : (raw?.vram && typeof raw.vram === 'object' ? raw.vram : null)
  const 估算表 = 显存?.estimates && typeof 显存.estimates === 'object' ? 显存.estimates : {}

  const 出 = {}

  for (const 名 of CAPABILITY_NAMES) {
    // jobs 不是模型，单独判定。
    if (名 === 'jobs') {
      const 开 = raw?.jobs?.enabled !== false
      const 可用 = 兼容 && 开
      出.jobs = {
        available: 可用,
        ready: 开,
        loaded: false,
        model: 'SQLite 队列',
        estimateMb: 0,
        versions,
        ...(!兼容 ? { reason: 'api_incompatible' } : (开 ? {} : { reason: 'not_supported' })),
      }
      continue
    }

    const 原始 = 原始能力[名] && typeof 原始能力[名] === 'object' ? 原始能力[名] : null
    const 健康 = 名 === 'tts'
      ? health
      : (health && typeof health[名] === 'object' ? health[名] : null)

    // 服务端没有这个能力：reason=not_supported（即使 /health 里有同名块也不算）。
    if (!原始) {
      const 可用 = false
      出[名] = {
        available: 可用,
        ready: false,
        loaded: false,
        reason: 'not_supported',
        versions,
      }
      continue
    }

    const ready = 原始.ready !== undefined
      ? 布尔(原始.ready)
      : (名 === 'tts' ? 布尔(health?.model_ready) : false)
    const loaded = 布尔(原始.loaded) || 布尔(健康?.loaded)
    const model = 原始.model || 健康?.model || undefined
    const estimateMb = Number(原始.estimate_mb ?? 健康?.estimate_mb ?? 估算表[名] ?? 0) || 0
    const 被配置禁用 = 白名单.length > 0 && !白名单.includes(名)

    let available = 兼容 && ready && !被配置禁用
    let reason
    if (!兼容) {
      available = false
      reason = 'api_incompatible'
    } else if (被配置禁用) {
      available = false
      reason = 'not_supported'
    } else if (!ready) {
      available = false
      reason = 'model_missing'
    } else if (!available) {
      reason = 'not_supported'
    }

    出[名] = {
      available,
      ready,
      loaded,
      ...(model ? { model } : {}),
      ...(estimateMb ? { estimateMb } : {}),
      versions,
      ...(reason ? { reason } : {}),
      ...(被配置禁用 ? { disabledByConfig: true } : {}),
    }
  }

  return 出
}

/** 能力指纹：只有这些字段变了才发 capability-changed。 */
export function capabilitySignature(caps) {
  const 摘 = {}
  for (const 名 of CAPABILITY_NAMES) {
    const x = caps?.[名] || {}
    摘[名] = [Boolean(x.available), Boolean(x.ready), Boolean(x.loaded), x.model || '', x.reason || '']
  }
  return JSON.stringify(摘)
}

/** 失败时 CapabilityInfo 该写哪个 reason。 */
function reasonForError(code) {
  if (code === 'api_incompatible') return 'api_incompatible'
  if (code === 'service_not_installed') return 'service_down'
  return 'service_down'
}

export class CapabilityService {
  constructor({
    client,
    getConfig,
    logger = null,
    ttlMs = 30000,
    now = () => Date.now(),
  } = {}) {
    this.client = client
    this.getConfig = getConfig
    this.logger = logger
    this.ttlMs = ttlMs
    this.now = now
    this.events = new EventEmitter()
    this.snapshot = null
    this.state = {
      consecutiveFailures: 0,
      lastError: null,
      lastCheckAt: 0,
      lastLatencyMs: 0,
      serviceVersion: '',
      apiVersion: '',
      downEmitted: false,
    }
    this.lastErrorEmitAt = new Map()
    this.lastSignature = ''
  }

  invalidate() {
    this.snapshot = null
  }

  /** 安全发事件：没有监听者时不发（尤其 'error'，否则 EventEmitter 会抛）。 */
  emit(name, payload) {
    if (name === 'error' && this.events.listenerCount('error') === 0) return
    try {
      this.events.emit(name, payload)
    } catch (error) {
      this.logger?.warn(`事件 ${name} 的监听器抛错：${error?.message || error}`)
    }
  }

  #emitErrorOnce(error) {
    const 现在 = this.now()
    const 上次 = this.lastErrorEmitAt.get(error.code) || 0
    if (现在 - 上次 < 30000) return
    this.lastErrorEmitAt.set(error.code, 现在)
    this.emit('error', {
      code: error.code,
      detail: error.detail || '',
      at: new Date(现在).toISOString(),
    })
  }

  #snapshotFromFailure(error) {
    const 配置 = this.getConfig?.() || {}
    const reason = reasonForError(error.code)
    const versions = {
      service: this.state.serviceVersion || undefined,
      api: this.state.apiVersion || undefined,
    }
    return {
      ok: false,
      reachable: error.code !== 'service_down' && error.code !== 'service_not_installed' && error.code !== 'timeout',
      compatible: error.code !== 'api_incompatible',
      baseUrl: 配置.baseUrl || '',
      latencyMs: 0,
      checkedAt: new Date(this.state.lastCheckAt || this.now()).toISOString(),
      checkedAtMs: this.state.lastCheckAt || this.now(),
      serviceVersion: this.state.serviceVersion || '',
      apiVersion: this.state.apiVersion || '',
      vram: null,
      capabilities: emptyCapabilities(reason, versions),
      consecutiveFailures: this.state.consecutiveFailures,
      lastError: { code: error.code, detail: error.detail || '', hint: error.hint || '' },
      fromCache: false,
    }
  }

  /**
   * 探测一次（默认读 30 秒缓存）。
   * @param {{force?:boolean, timeoutMs?:number}} opts
   */
  async refresh({ force = false, timeoutMs = 2000 } = {}) {
    const 配置 = this.getConfig?.() || {}
    if (配置.enabled === false) {
      const 错 = Object.assign(new Error('插件已停用'), { code: 'service_not_installed', detail: '插件已在设置里停用', hint: '' })
      return this.#snapshotFromFailure(错)
    }

    const 现在 = this.now()
    if (!force && this.snapshot && 现在 - this.snapshot.checkedAtMs < this.ttlMs) {
      return { ...this.snapshot, fromCache: true }
    }

    const 选项 = { timeoutMs: Math.max(500, Number(timeoutMs) || 2000), retry: 1 }
    const [健康, 能力, 显存] = await Promise.allSettled([
      this.client.getJson('/health', 选项),
      this.client.getJson('/capabilities', 选项),
      this.client.getJson('/vram', 选项),
    ])

    if (能力.status !== 'fulfilled') {
      const 原因 = this.#pickError(能力.reason, 健康)
      this.state.consecutiveFailures += 1
      this.state.lastError = { code: 原因.code, detail: 原因.detail || '', hint: 原因.hint || '' }
      this.state.lastCheckAt = 现在
      this.state.lastLatencyMs = 0
      this.#emitErrorOnce(原因)
      if (this.state.consecutiveFailures >= 2 && !this.state.downEmitted) {
        this.state.downEmitted = true
        this.emit('service-down', { reason: 原因.code, at: new Date(现在).toISOString() })
      }
      const 快照 = this.#snapshotFromFailure(原因)
      快照.checkedAt = new Date(现在).toISOString()
      快照.checkedAtMs = 现在
      快照.latencyMs = 0
      return 快照
    }

    const 原始 = 能力.value.data || {}
    const 健康数据 = 健康.status === 'fulfilled' ? (健康.value.data || {}) : null
    const 显存数据 = 显存.status === 'fulfilled' ? (显存.value.data || null) : null

    if (原始.ok === false) {
      const 错 = Object.assign(new Error('服务拒绝能力发现'), {
        code: 'upstream_error',
        detail: String(原始.detail || 原始.error || ''),
        hint: '本地 AI 暂时不可用，请稍后重试。',
      })
      this.state.consecutiveFailures += 1
      this.state.lastError = { code: 错.code, detail: 错.detail, hint: 错.hint }
      this.#emitErrorOnce(错)
      return this.#snapshotFromFailure(错)
    }

    const api版本 = 原始.api_version != null ? String(原始.api_version) : ''
    const 期望 = String(配置.apiVersion || '1')
    const compatible = 主版本(api版本 || 期望) === 主版本(期望)
    const serviceVersion = String(原始.service?.version || '')

    const caps = parseCapabilities(原始, 健康数据, 显存数据, { config: 配置, compatible })
    const vram = 显存数据 && (显存数据.total_mb || 显存数据.free_mb)
      ? {
          freeMb: Number(显存数据.free_mb) || 0,
          totalMb: Number(显存数据.total_mb) || 0,
          marginMb: Number(显存数据.margin_mb) || undefined,
        }
      : (原始.vram ? {
          freeMb: Number(原始.vram.free_mb) || 0,
          totalMb: Number(原始.vram.total_mb) || 0,
          marginMb: Number(原始.vram.margin_mb) || undefined,
        } : null)

    const 延迟 = Math.max(0, Number(能力.value.ms) || 0)
    const 快照 = {
      ok: compatible,
      reachable: true,
      compatible,
      baseUrl: 配置.baseUrl || '',
      latencyMs: 延迟,
      checkedAt: new Date(现在).toISOString(),
      checkedAtMs: 现在,
      serviceVersion,
      apiVersion: api版本,
      vram,
      capabilities: caps,
      consecutiveFailures: 0,
      lastError: compatible ? null : {
        code: 'api_incompatible',
        detail: `服务 api_version=${api版本 || '?'}，插件支持 ${期望}.x`,
        hint: '本地 AI 版本不兼容，请更新插件或本地 AI 后重试。',
      },
      fromCache: false,
    }

    if (this.state.consecutiveFailures > 0) {
      this.emit('service-up', { serviceVersion, at: 快照.checkedAt })
    }
    this.state.consecutiveFailures = 0
    this.state.lastError = 快照.lastError ? { ...快照.lastError } : null
    this.state.lastCheckAt = 现在
    this.state.lastLatencyMs = 延迟
    this.state.serviceVersion = serviceVersion
    this.state.apiVersion = api版本
    this.state.downEmitted = false

    const 指纹 = capabilitySignature(caps)
    if (this.lastSignature && 指纹 !== this.lastSignature) {
      this.emit('capability-changed', { at: 快照.checkedAt, capabilities: caps })
    }
    this.lastSignature = 指纹
    this.snapshot = 快照
    return 快照
  }

  #pickError(错误, 健康结果) {
    if (错误 instanceof Error && 错误.code) return 错误
    if (健康结果?.status === 'rejected' && 健康结果.reason?.code) return 健康结果.reason
    if (错误 && typeof 错误 === 'object') return 错误
    return Object.assign(new Error('能力发现失败'), {
      code: 'service_down',
      detail: String(错误 || ''),
      hint: '本地 AI 未启动，请先启动后重试。',
    })
  }

  /** 给服务方法用的门禁：返回 {ok:true, info, snapshot} 或 {ok:false, error}。 */
  async require(name, { force = false, timeoutMs = 2000 } = {}) {
    const 配置 = this.getConfig?.() || {}
    if (配置.enabled === false) {
      return {
        ok: false,
        error: Object.assign(new Error('插件已停用'), {
          code: 'service_not_installed',
          hint: '本地 AI 插件已停用，请在「设置 → 插件 → 本地 AI」中打开总开关。',
          detail: 'enabled=false',
        }),
      }
    }
    if (!CAPABILITY_NAMES.includes(name)) {
      return {
        ok: false,
        error: Object.assign(new Error(`未知能力 ${name}`), {
          code: 'upstream_error',
          hint: '当前版本不支持这项能力。',
          detail: `unsupported capability: ${name}`,
        }),
      }
    }

    const 快照 = await this.refresh({ force, timeoutMs })
    if (!快照.reachable) {
      return {
        ok: false,
        error: Object.assign(new Error('服务不可达'), {
          code: 'service_down',
          hint: '本地 AI 未启动，请先启动后重试。',
          detail: 快照.lastError?.detail || '',
        }),
      }
    }
    if (!快照.compatible) {
      return {
        ok: false,
        error: Object.assign(new Error('服务契约版本不匹配'), {
          code: 'api_incompatible',
          hint: 快照.lastError?.hint || '本地 AI 版本不兼容，请更新插件或本地 AI 后重试。',
          detail: 快照.lastError?.detail || '',
        }),
      }
    }

    const 信息 = 快照.capabilities?.[name]
    if (!信息) {
      return {
        ok: false,
        error: Object.assign(new Error('服务不支持该能力'), {
          code: 'upstream_error',
          hint: '本地 AI 未提供这项能力，请检查本地 AI 的设置。',
          detail: `unsupported capability: ${name}`,
        }),
      }
    }
    if (!信息.available) {
      if (信息.reason === 'model_missing') {
        return {
          ok: false,
          error: Object.assign(new Error('模型缺失'), {
            code: 'model_missing',
            hint: modelMissingHint(信息.model, 信息.estimateMb),
            detail: `${name} ready=false${信息.model ? ` (${信息.model})` : ''}`,
            capability: name,
          }),
        }
      }
      if (信息.reason === 'not_supported') {
        return {
          ok: false,
          error: Object.assign(new Error('能力不可用'), {
            code: 'upstream_error',
            hint: '本地 AI 未启用这项能力，请在本地 AI 中启用后重试。',
            detail: `capability ${name} not supported`,
            capability: name,
          }),
        }
      }
      return {
        ok: false,
        error: Object.assign(new Error('能力不可用'), {
          code: 'service_down',
          hint: '本地 AI 暂时不可用，请稍后重试。',
          detail: `${name}: ${信息.reason || 'unavailable'}`,
          capability: name,
        }),
      }
    }

    return { ok: true, info: 信息, snapshot: 快照 }
  }

  /** 当前快照（不触发探测）。 */
  current() {
    return this.snapshot
  }

  /** 健康检查结果（CONTRACT 1.3）。 */
  async health({ timeoutMs = 2000 } = {}) {
    const 快照 = await this.refresh({ force: true, timeoutMs })
    return {
      ok: 快照.ok,
      baseUrl: 快照.baseUrl,
      latencyMs: 快照.latencyMs,
      checkedAt: 快照.checkedAt,
      ...(快照.serviceVersion ? { serviceVersion: 快照.serviceVersion } : {}),
      ...(快照.apiVersion ? { apiVersion: 快照.apiVersion } : {}),
      ...(快照.vram ? { vram: 快照.vram } : {}),
      ...(快照.ok ? { capabilities: 快照.capabilities } : {}),
      consecutiveFailures: 快照.consecutiveFailures,
      ...(快照.lastError ? { lastError: 快照.lastError } : {}),
    }
  }

  /** 能力表（默认读缓存）。 */
  async list({ force = false, timeoutMs = 2000 } = {}) {
    const 快照 = await this.refresh({ force, timeoutMs })
    return 快照.capabilities
  }

  /** 后台健康检查的当前状态。 */
  status() {
    return {
      consecutiveFailures: this.state.consecutiveFailures,
      lastError: this.state.lastError,
      lastCheckAt: this.state.lastCheckAt,
      latencyMs: this.state.lastLatencyMs,
      serviceVersion: this.state.serviceVersion,
      apiVersion: this.state.apiVersion,
    }
  }
}

export { timeoutHint }
