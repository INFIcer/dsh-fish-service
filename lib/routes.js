// 宿主 HTTP 路由（给本插件设置页/朗读按钮/语音输入用，不是公共 API）：
//   GET  /dsh-fish-service/health            插件 + 服务联合状态
//   GET  /dsh-fish-service/state             配置 / capabilities / 最近错误 / 缓存用量
//   POST /dsh-fish-service/save              保存配置
//   POST /dsh-fish-service/test              探测服务连通
//   GET  /dsh-fish-service/logs              最近 200 行日志
//   GET  /dsh-fish-service/voices            音色列表（设置页默认音色下拉用）
//   POST /dsh-fish-service/read              朗读：清洗 + 分段 + TTS（一次全合成，兼容保留）
//   POST /dsh-fish-service/read/plan         朗读分段计划（立即返回，不合成）
//   POST /dsh-fish-service/read/segment      单段合成（走 tts()，自动命中缓存）
//   GET  /dsh-fish-service/cache/stats       TTS 缓存命中统计
//   POST /dsh-fish-service/cache/clear       清空缓存（可指定 kind）
//   POST /dsh-fish-service/cache/cleanup     按 TTL/LRU 清理过期缓存
//   GET  /dsh-fish-service/audio?path=…      把 cacheDir 里的音频以 audio/* 返回（防穿越）
//   POST /dsh-fish-service/transcribe-upload multipart 录音 → ASR 文本
//   POST /dsh-fish-service/voice-upload      multipart 录音 → 存到 cacheDir/voice（保留语音）
//
// 浏览器不接触 token：配置返回永远是脱敏的。

import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { toPublicError } from './errors.js'
import { isPathInside } from './fs-util.js'
import {
  默认最大字数,
  最小分段字数,
  最大分段字数,
  最多段数,
  prepareSpeech,
} from './speech.js'
import {
  最大音频字节,
  最大录音毫秒,
  取音频扩展,
  取音频文件,
  解析multipart,
  读数字字段,
} from './upload.js'

const 默认前缀 = '/dsh-fish-service'

// 音频扩展名 → Content-Type。只允许这些类型被 /audio 读出去。
const 音频类型 = {
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
}

const 读体上限 = 2 * 1024 * 1024
const 文本上限 = 512 * 1024
const 上传上限 = 最大音频字节 + 1024 * 1024

function 读体(req, 上限 = 读体上限) {
  return new Promise((resolve) => {
    let 文 = ''
    let 超 = false
    req.on('data', (块) => {
      if (超) return
      文 += 块
      if (文.length > 上限) {
        超 = true
        resolve({})
      }
    })
    req.on('end', () => {
      if (超) return
      try { resolve(JSON.parse(文 || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** 读二进制请求体（multipart 用）；超限时返回 { over:true, buffer:空 }。 */
function 读原始体(req, 上限 = 上传上限) {
  return new Promise((resolve) => {
    const 块们 = []
    let 长度 = 0
    let 超 = false
    req.on('data', (块) => {
      if (超) return
      长度 += 块.length
      if (长度 > 上限) {
        超 = true
        块们.length = 0
        return
      }
      块们.push(块)
    })
    req.on('end', () => resolve({ buffer: 超 ? Buffer.alloc(0) : Buffer.concat(块们), bytes: 长度, over: 超 }))
    req.on('error', () => resolve({ buffer: Buffer.alloc(0), bytes: 长度, over: true }))
  })
}

function 查询(req) {
  try {
    return new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function 回(res, 状态码, 数据) {
  try {
    res.statusCode = 状态码
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.setHeader?.('cache-control', 'no-store')
    res.end?.(JSON.stringify(数据))
  } catch {
    // 客户端断开就算了。
  }
}

function 回二进制(res, 类型, 数据, 文件名) {
  try {
    res.statusCode = 200
    res.setHeader?.('content-type', 类型)
    res.setHeader?.('content-length', String(数据.length))
    res.setHeader?.('cache-control', 'private, max-age=300')
    res.setHeader?.('content-disposition', `inline; filename="${String(文件名).replace(/["\\]/g, '')}"`)
    res.end?.(数据)
  } catch {
    // 同上。
  }
}

function 要方法(req, res, 方法) {
  const 来 = String(req?.method || 'GET').toUpperCase()
  if (来 === 方法) return true
  回(res, 405, { ok: false, code: 'bad_request', hint: `该操作仅支持 ${方法} 请求。` })
  return false
}

/** 宽松同源检查：没有 Origin（脚本/测试）放行；有就必须和 Host 一致。 */
function 同源(req) {
  const 来源 = req?.headers?.origin
  if (!来源) return true
  try {
    return new URL(来源).host === String(req?.headers?.host || '')
  } catch {
    return false
  }
}

const 数字钳 = (值, 兜底, 最小, 最大) => {
  const n = Number(值)
  if (!Number.isFinite(n)) return 兜底
  return Math.max(最小, Math.min(最大, Math.trunc(n)))
}

const 取字符串枚举 = (值, 允许, 兜底) => {
  const 名 = String(值 == null ? '' : 值).trim().toLowerCase()
  return 允许.includes(名) ? 名 : 兜底
}

/** 有限并发：最多 并发度 个 worker；结果按输入顺序返回（任务自己兜住异常）。 */
async function 有限并发(任务们, 并发度) {
  const 结果 = new Array(任务们.length)
  let 下一个 = 0
  const 工人 = async () => {
    for (;;) {
      const i = 下一个++
      if (i >= 任务们.length) return
      结果[i] = await 任务们[i]()
    }
  }
  const 工人数 = Math.max(1, Math.min(Math.trunc(Number(并发度)) || 1, 任务们.length))
  await Promise.all(Array.from({ length: 工人数 }, () => 工人()))
  return 结果
}

/**
 * 语速：显式给了就必须在 0.5~2.0；没给用配置。
 * @returns {number|undefined|null} null = 越界
 */
function 取语速(值, 配置) {
  if (值 === undefined || 值 === null || 值 === '') {
    const n = Number(配置?.ttsSpeed)
    return Number.isFinite(n) ? n : undefined
  }
  const n = Number(值)
  if (!Number.isFinite(n) || n < 0.5 || n > 2) return null
  return Math.round(n * 100) / 100
}

/** 朗读分段参数（/read 与 /read/plan 共用）：清洗、分段、maxChars、voice。 */
function 取朗读分段(体, 配置) {
  const maxChars = 数字钳(体.maxChars, 配置.readMaxChars || 默认最大字数, 最小分段字数, 最大分段字数)
  const skipCodeBlocks = 体.skipCodeBlocks === undefined
    ? 配置.readSkipCode !== false
    : Boolean(体.skipCodeBlocks)
  const 原文 = typeof 体.text === 'string' ? 体.text : ''
  return {
    maxChars,
    skipCodeBlocks,
    语音: prepareSpeech(原文, { maxChars, skipCodeBlocks }),
    voice: String(体.voice || 配置.ttsVoice || '').trim() || undefined,
  }
}

export function registerRoutes({
  ctx,
  api,
  configStore,
  capabilities,
  cache,
  logger,
  version = '0.1.0',
  prefix = 默认前缀,
}) {
  const 路线 = (路径, handler) => {
    const 注册 = ctx.webServer.register({
      kind: 'exact',
      path: 路径,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          logger?.error(`路由 ${路径} 出错：${error?.code || ''} ${error?.message || error}`)
          const 包 = toPublicError(error)
          回(res, 包.code === 'bad_request' ? 400 : 500, 包)
        }
      },
    })
    return 注册
  }

  const 摘 = []

  const 加 = (路径, handler) => {
    const disposer = 路线(路径, handler)
    if (typeof disposer === 'function') 摘.push(disposer)
  }

  /** 缓存目录里的绝对路径 → 浏览器可播放的 URL。 */
  const 音频地址 = (路径) => `${prefix}/audio?path=${encodeURIComponent(String(路径 || ''))}`

  // ---------------- 联合健康 ----------------

  加(`${prefix}/health`, async (_req, res) => {
    // 不阻塞：没有快照就先发起一次探测，本轮先返回“未知/离线”。
    if (!capabilities.current()) void capabilities.refresh({ timeoutMs: 2000 })
    const 快照 = capabilities.current()
    const 状态 = capabilities.status()
    回(res, 200, {
      ok: Boolean(快照?.ok),
      pluginOk: true,
      serviceDown: !快照 || !快照.reachable,
      enabled: api.config.get().enabled,
      pluginVersion: version,
      baseUrl: 快照?.baseUrl || api.config.get().baseUrl,
      lastCheckAt: 状态.lastCheckAt || 0,
      latencyMs: 状态.latencyMs || 快照?.latencyMs || 0,
      ...(快照?.serviceVersion ? { serviceVersion: 快照.serviceVersion } : {}),
      ...(快照?.apiVersion ? { apiVersion: 快照.apiVersion } : {}),
      consecutiveFailures: 状态.consecutiveFailures || 0,
      ...(快照?.lastError ? { lastError: 快照.lastError } : {}),
    })
  })

  // ---------------- 设置页状态 ----------------

  加(`${prefix}/state`, async (_req, res) => {
    const 快照 = await capabilities.refresh({ timeoutMs: 2500 })
    let 音色 = []
    try { 音色 = (await api.voices()).map((x) => x.name).filter(Boolean) } catch { /* 服务没起时忽略 */ }

    回(res, 200, {
      ok: true,
      plugin: {
        version,
        configFile: configStore.filePath,
        logFile: logger?.filePath || '',
        enabled: 快照 ? api.config.get().enabled : false,
        baseUrl: api.config.get().baseUrl,
      },
      config: api.config.get(),
      health: {
        ok: Boolean(快照.ok),
        reachable: Boolean(快照.reachable),
        compatible: Boolean(快照.compatible),
        checkedAt: 快照.checkedAt,
        latencyMs: 快照.latencyMs,
        ...(快照.serviceVersion ? { serviceVersion: 快照.serviceVersion } : {}),
        ...(快照.apiVersion ? { apiVersion: 快照.apiVersion } : {}),
        ...(快照.vram ? { vram: 快照.vram } : {}),
        consecutiveFailures: 快照.consecutiveFailures,
        ...(快照.lastError ? { lastError: 快照.lastError } : {}),
      },
      capabilities: 快照.capabilities,
      voices: 音色,
      cache: cache.usage(),
      errors: api.recentErrors(20),
      envOverrides: [...(configStore.overrides || [])],
    })
  })

  // ---------------- 保存配置 ----------------

  加(`${prefix}/save`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req)
    const 补丁 = 体 && typeof 体.config === 'object'
      ? 体.config
      : (体 && typeof 体.patch === 'object' ? 体.patch : 体)
    try {
      const 结果 = await api.config.set(补丁 || {})
      回(res, 200, { ...结果, config: api.config.get() })
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 500, 包)
    }
  })

  // ---------------- 测试连接 ----------------

  加(`${prefix}/test`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req)
    const 超时 = Math.max(500, Math.min(10000, Number(体?.timeoutMs) || 3000))
    const 快照 = await capabilities.refresh({ force: true, timeoutMs: 超时 })
    回(res, 200, {
      ok: 快照.ok,
      reachable: 快照.reachable,
      compatible: 快照.compatible,
      baseUrl: 快照.baseUrl,
      latencyMs: 快照.latencyMs,
      checkedAt: 快照.checkedAt,
      ...(快照.serviceVersion ? { serviceVersion: 快照.serviceVersion } : {}),
      ...(快照.apiVersion ? { apiVersion: 快照.apiVersion } : {}),
      ...(快照.ok ? { capabilities: 快照.capabilities } : {}),
      ...(快照.lastError ? { lastError: 快照.lastError } : {}),
      ...(快照.ok ? {} : {
        code: 快照.lastError?.code || 'service_down',
        hint: 快照.lastError?.hint || '未能连接本地 AI 服务，请确认服务已启动、地址填写正确。',
      }),
    })
  })

  // ---------------- 日志 ----------------

  加(`${prefix}/logs`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    const 原始 = Number(查询(req).get('lines'))
    const 行数 = Number.isFinite(原始) ? Math.max(1, Math.min(1000, Math.trunc(原始))) : 200
    回(res, 200, { ok: true, lines: logger?.recent(行数) || [] })
  })

  // ---------------- 音色 ----------------

  加(`${prefix}/voices`, async (_req, res) => {
    try {
      const 音色 = await api.voices()
      回(res, 200, { ok: true, voices: 音色 })
    } catch (error) {
      回(res, 200, { ok: false, ...toPublicError(error), voices: [] })
    }
  })

  // ---------------- 朗读：清洗 + 分段 + TTS ----------------

  加(`${prefix}/read`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req, 文本上限)
    if (!String(体.text || '').trim()) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有可朗读的文字。' })
      return
    }

    const 配置 = api.config.get()
    const { 语音, voice, skipCodeBlocks } = 取朗读分段(体, 配置)
    if (!语音.chunks.length) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: skipCodeBlocks ? '这条消息在去掉代码块后没有可朗读的内容。' : '这条消息没有可朗读的文字。',
      })
      return
    }

    const speed = 取语速(体.speed, 配置)
    if (speed === null) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '请求参数有误：语速须在 0.5~2.0 之间。' })
      return
    }

    const 并发度 = 数字钳(配置.readConcurrency, 2, 1, 4)
    const 开始 = Date.now()

    // fish.service.tts 单次最多 20 条（契约），这里最多 40 段，按 20 条一批。
    const 批们 = []
    for (let 起点 = 0; 起点 < 语音.chunks.length; 起点 += 20) {
      批们.push({ 起点, 批: 语音.chunks.slice(起点, 起点 + 20) })
    }

    /** 合成一批并按全局段序映射；顺序在批内保持（引擎本身串行）。 */
    const 合成一批 = async ({ 起点, 批 }) => {
      const 结果 = await api.tts(批, {
        ...(voice ? { voice } : {}),
        ...(speed ? { speed } : {}),
        timeoutMs: 配置.requestTimeoutMs,
      })
      return (结果.items || []).map((项, i) => {
        const 全局下标 = 起点 + i
        return {
          wavPath: 项.wavPath,
          url: 音频地址(项.wavPath),
          ms: 项.ms,
          voice: 项.voice,
          bytes: 项.bytes,
          chars: 语音.chunks[全局下标] ? 语音.chunks[全局下标].length : 0,
          cached: Boolean(项.cached),
        }
      })
    }

    let 降级 = false
    try {
      const 结果们 = await 有限并发(批们.map((单位) => async () => {
        try {
          return { ok: true, items: await 合成一批(单位) }
        } catch (error) {
          return { ok: false, error }
        }
      }), 并发度)

      // 并发可能把 localai 队列 / 显存顶满：失败的批在所有并发跑完后单独串行重试一次，
      // 结果仍按段序拼接（items 的顺序不受并发影响）。
      const 失败下标 = 结果们.map((x, i) => (x.ok ? -1 : i)).filter((i) => i >= 0)
      if (失败下标.length && 并发度 > 1) {
        降级 = true
        logger?.warn(`朗读并发合成失败 ${失败下标.length} 批，降级为串行重试`)
        for (const i of 失败下标) {
          try {
            结果们[i] = { ok: true, items: await 合成一批(批们[i]) }
          } catch (error) {
            结果们[i] = { ok: false, error }
          }
        }
      }

      const 第一失败 = 结果们.find((x) => !x.ok)
      if (第一失败) throw 第一失败.error

      const items = 结果们.flatMap((x) => x.items)
      if (!items.length) {
        回(res, 200, { ok: false, code: 'upstream_error', hint: '语音合成未返回音频，请稍后重试。' })
        return
      }
      const cachedChunks = items.filter((x) => x.cached).length
      回(res, 200, {
        ok: true,
        wavPath: items[0].wavPath,
        ms: Date.now() - 开始,
        items,
        chunks: items.length,
        chars: 语音.chars,
        codeBlocks: 语音.codeBlocks,
        codeLines: 语音.codeLines,
        truncated: 语音.truncated,
        voice: items[0].voice,
        ...(speed ? { speed } : {}),
        concurrency: 并发度,
        cachedChunks,
        cacheHits: cachedChunks,
        ...(降级 ? { degraded: true } : {}),
      })
    } catch (error) {
      // 合成失败是「服务没起 / 显存不够 / 缺模型」这类可展示原因；200 + ok:false 让前端直接念 hint。
      const 包 = toPublicError(error)
      if (包.code !== 'bad_request' && 并发度 > 1) {
        包.hint = `${包.hint || '合成失败，请稍后重试。'}（本次同时合成 ${并发度} 段，失败的部分已改为逐段重试；若仍失败，可在设置中调低「合成并发」。）`
        if (包.error && typeof 包.error === 'object') 包.error = { ...包.error, hint: 包.hint }
      }
      回(res, 包.code === 'bad_request' ? 400 : 200, 包)
    }
  })

  // ---------------- 流式朗读：分段计划（不合成，立即返回） ----------------

  加(`${prefix}/read/plan`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req, 文本上限)
    if (!String(体.text || '').trim()) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有可朗读的文字。' })
      return
    }

    const 配置 = api.config.get()
    const { 语音, voice, skipCodeBlocks, maxChars } = 取朗读分段(体, 配置)
    if (!语音.chunks.length) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: skipCodeBlocks ? '这条消息在去掉代码块后没有可朗读的内容。' : '这条消息没有可朗读的文字。',
      })
      return
    }

    const speed = 取语速(体.speed, 配置)
    if (speed === null) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '请求参数有误：语速须在 0.5~2.0 之间。' })
      return
    }

    回(res, 200, {
      ok: true,
      segments: 语音.chunks.map((text, index) => ({ index, text, chars: text.length })),
      chars: 语音.chars,
      codeBlocks: 语音.codeBlocks,
      codeLines: 语音.codeLines,
      truncated: 语音.truncated,
      voice: voice || 配置.ttsVoice || '',
      ...(speed !== undefined ? { speed } : {}),
      maxChars,
    })
  })

  // ---------------- 流式朗读：单段合成（走 tts()，自动命中缓存） ----------------

  加(`${prefix}/read/segment`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req, 文本上限)
    const 原文 = typeof 体.text === 'string' ? 体.text : ''
    if (!原文.trim()) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '这一段的文字为空。' })
      return
    }

    // index 必须是非负整数；给了 total 时还要 < total（越界直接拒绝，不合成）。
    const index = Number(体.index)
    if (!Number.isInteger(index) || index < 0 || index > 最多段数 - 1) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: `请求参数有误：段落序号（index）必须是 0~${最多段数 - 1} 的整数。`,
      })
      return
    }
    let total
    if (体.total !== undefined && 体.total !== null && 体.total !== '') {
      total = Number(体.total)
      if (!Number.isInteger(total) || total < 1 || total > 最多段数) {
        回(res, 400, { ok: false, code: 'bad_request', hint: `请求参数有误：总段数（total）必须是 1~${最多段数} 的整数。` })
        return
      }
      if (index >= total) {
        回(res, 400, { ok: false, code: 'bad_request', hint: `请求参数有误：段落序号（index）超出了 0~${total - 1} 的范围。` })
        return
      }
    }

    const 配置 = api.config.get()
    const speed = 取语速(体.speed, 配置)
    if (speed === null) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '请求参数有误：语速须在 0.5~2.0 之间。' })
      return
    }
    const voice = String(体.voice || 配置.ttsVoice || '').trim() || undefined
    const 开始 = Date.now()

    try {
      const 结果 = await api.tts([原文], {
        ...(voice ? { voice } : {}),
        ...(speed ? { speed } : {}),
        timeoutMs: 配置.requestTimeoutMs,
      })
      const 项 = (结果.items || [])[0]
      if (!项 || !项.wavPath) {
        回(res, 200, { ok: false, code: 'upstream_error', hint: '这一段未合成出音频，请重试。' })
        return
      }
      回(res, 200, {
        ok: true,
        index,
        wavPath: 项.wavPath,
        url: 音频地址(项.wavPath),
        // 命中缓存时 tts() 返回 ms:0；这里保留语义，前端可据此显示「复用」。
        ms: 项.ms !== undefined ? 项.ms : Date.now() - 开始,
        cached: Boolean(项.cached),
        bytes: Number(项.bytes) || 0,
        ...(项.voice ? { voice: 项.voice } : {}),
        ...(speed ? { speed } : {}),
        ...(total ? { total } : {}),
      })
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 200, 包)
    }
  })

  // ---------------- 缓存统计 / 清空 / 清理 ----------------

  加(`${prefix}/cache/stats`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    if (api.cache && typeof api.cache.stats === 'function') {
      回(res, 200, api.cache.stats())
      return
    }
    // 兜底（测试替身 / 老 api）：只有磁盘用量，没有命中率。
    const 用量 = (cache && typeof cache.usage === 'function' ? cache.usage() : {}) || {}
    const tts = (用量.byKind && 用量.byKind.tts) || {}
    回(res, 200, {
      ok: true,
      kind: 'tts',
      files: Number(tts.files) || 0,
      bytes: Number(tts.bytes) || 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
    })
  })

  加(`${prefix}/cache/clear`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req)
    const kind = 体.kind === undefined || 体.kind === null || 体.kind === ''
      ? ''
      : String(体.kind).trim().toLowerCase()
    const 允许 = ['tts', 'separate', 'vision', 'tmp', 'voice']
    if (kind && !允许.includes(kind)) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: `请求参数有误：缓存类型（kind）只能是 ${允许.join(' / ')}，或留空以清空全部产物。`,
      })
      return
    }
    try {
      const 结果 = api.cache && typeof api.cache.clear === 'function'
        ? api.cache.clear({ kind })
        : {
            ok: true,
            kind: kind || 'all',
            ...((cache && typeof cache.clear === 'function') ? cache.clear(kind) : { files: 0, bytes: 0, kinds: [] }),
          }
      回(res, 200, 结果)
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 500, 包)
    }
  })

  加(`${prefix}/cache/cleanup`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    try {
      const 结果 = api.cache && typeof api.cache.cleanup === 'function'
        ? api.cache.cleanup()
        : { ok: true, ...((cache && typeof cache.cleanup === 'function') ? cache.cleanup() : {}) }
      回(res, 200, 结果)
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 500, 包)
    }
  })

  // ---------------- 音频回放（只允许 cacheDir 里的文件） ----------------

  加(`${prefix}/audio`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    const 路径 = String(查询(req).get('path') || '').trim()
    if (!路径) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '缺少音频文件路径。' })
      return
    }
    const 缓存根 = String(api.config.get().cacheDir || cache?.dirPath || '')
    // 防目录穿越：解析后必须落在 cacheDir 里，且是已知音频扩展名。
    if (!缓存根 || !isPathInside(缓存根, 路径)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '只能播放缓存目录中的音频。' })
      return
    }
    const 类型 = 音频类型[extname(路径).toLowerCase()]
    if (!类型) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '不支持的音频格式，仅支持 wav、webm、ogg、mp3、m4a。' })
      return
    }
    let 信息
    try { 信息 = statSync(路径) } catch {
      回(res, 404, { ok: false, code: 'bad_request', hint: '音频文件不存在，可能已被清理。' })
      return
    }
    if (!信息.isFile()) {
      回(res, 404, { ok: false, code: 'bad_request', hint: '音频文件不存在。' })
      return
    }
    if (信息.size > 128 * 1024 * 1024) {
      回(res, 413, { ok: false, code: 'bad_request', hint: '音频文件过大，已拒绝。' })
      return
    }
    let 数据
    try { 数据 = readFileSync(路径) } catch {
      回(res, 404, { ok: false, code: 'bad_request', hint: '音频文件无法读取。' })
      return
    }
    回二进制(res, 类型, 数据, basename(路径))
  })

  // ---------------- 语音输入：转文字 ----------------

  加(`${prefix}/transcribe-upload`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 原始 = await 读原始体(req, 上传上限)
    if (原始.over) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const 解析 = 解析multipart(原始.buffer, req?.headers?.['content-type'])
    const 文件 = 取音频文件(解析)
    if (!文件 || !文件.data.length) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '未收到音频文件。' })
      return
    }
    if (文件.data.length > 最大音频字节) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const 时长 = 读数字字段(解析.fields.durationMs, 0)
    if (时长 > 最大录音毫秒) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '录音超过 5 分钟，请分段录制。' })
      return
    }

    const 配置 = api.config.get()
    const 语言 = 取字符串枚举(解析.fields.language, ['auto', 'zh', 'en', 'ja'], 配置.asrLanguage || 'auto')
    const 说话人 = 解析.fields.speaker === '1' || 解析.fields.speaker === 'true'
    const 扩展 = 取音频扩展(文件.contentType, 文件.filename)

    // 诊断与早退：麦克风没采到声音 / 录音太短时，直接给出可操作提示，别把静音丢给识别。
    logger?.info(`语音输入：收到 ${文件.data.length} 字节，类型 ${文件.contentType || '未知'}，扩展 ${扩展}，时长 ${时长 || 0}ms`)
    if (文件.data.length < 1500) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有采集到声音：录音数据过小。请检查麦克风是否可用，并重试。' })
      return
    }
    if (时长 && 时长 < 300) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '录音太短，请多说几秒再停止。' })
      return
    }

    // 临时文件放在 cacheDir/tmp，请求结束就删（不长期保存用户音频）。
    let 临时 = ''
    try {
      临时 = cache.saveBuffer('tmp', 文件.data, { ext: 扩展, name: `${randomUUID()}${扩展}` })
    } catch (error) {
      回(res, 500, { ok: false, code: 'upstream_error', hint: '录音处理失败，请稍后重试。' })
      return
    }

    const 开始 = Date.now()
    let 保留排查 = false
    try {
      const 结果 = await api.asr(临时, { language: 语言, speaker: 说话人, timeoutMs: 配置.asrTimeoutMs })
      const 项 = (结果.items && 结果.items[0]) || {}
      const 识别文本 = String(项.text || '')
      logger?.info(`语音输入：识别结果 ${识别文本.length} 字（${文件.data.length} 字节 / ${时长 || 0}ms），耗时 ${项.elapsedMs ?? '?'}ms，文本「${识别文本.slice(0, 20)}」`)
      // 识别结果异常短（正常一句话至少 3 个字）时保留录音，便于排查麦克风/格式问题。
      if (识别文本.trim().length < 3 && 文件.data.length > 0) {
        保留排查 = true
        logger?.warn(`语音输入：识别结果异常短，已保留录音用于排查：${临时}`)
      }
      回(res, 200, {
        ok: true,
        text: String(项.text || ''),
        ms: Date.now() - 开始,
        ...(项.elapsedMs !== undefined ? { elapsedMs: 项.elapsedMs } : {}),
        ...(项.language ? { language: 项.language } : { language: 语言 }),
        ...(说话人 && 项.speaker !== undefined ? { speaker: 项.speaker } : {}),
        ...(项.speakerError ? { speakerError: 项.speakerError } : {}),
        bytes: 文件.data.length,
      })
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 200, 包)
    } finally {
      if (!保留排查) {
        try { if (临时) rmSync(临时, { force: true }) } catch { /* 删不掉就留给 TTL 清理 */ }
      }
    }
  })

  // ---------------- 语音输入：保留语音（存到 cacheDir/voice） ----------------

  加(`${prefix}/voice-upload`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 原始 = await 读原始体(req, 上传上限)
    if (原始.over) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const 解析 = 解析multipart(原始.buffer, req?.headers?.['content-type'])
    const 文件 = 取音频文件(解析)
    if (!文件 || !文件.data.length) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '未收到音频文件。' })
      return
    }
    if (文件.data.length > 最大音频字节) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const 时长 = 读数字字段(解析.fields.durationMs, 0)
    if (时长 > 最大录音毫秒) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '录音超过 5 分钟，请分段录制。' })
      return
    }
    const 扩展 = 取音频扩展(文件.contentType, 文件.filename)
    const 名称 = `${randomUUID()}${扩展}`
    let 路径 = ''
    try {
      路径 = cache.saveBuffer('voice', 文件.data, { ext: 扩展, name: 名称 })
    } catch (error) {
      回(res, 500, { ok: false, code: 'upstream_error', hint: '音频保存失败，请稍后重试。' })
      return
    }
    回(res, 200, {
      ok: true,
      path: 路径,
      name: 名称,
      bytes: 文件.data.length,
      mime: 文件.contentType,
      ...(时长 ? { durationMs: 时长 } : {}),
    })
  })

  return () => {
    for (const 函数 of 摘.splice(0)) {
      try { 函数() } catch { /* 已卸载 */ }
    }
  }
}

export { 默认前缀 }
