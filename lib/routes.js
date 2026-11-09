// 宿主 HTTP 路由（给本插件设置页/朗读按钮/语音输入用，不是公共 API）：
//   GET  /dsh-fish-service/health            插件 + 服务联合状态
//   GET  /dsh-fish-service/state             配置 / capabilities / 最近错误 / 缓存用量
//   POST /dsh-fish-service/save              保存配置
//   POST /dsh-fish-service/test              探测服务连通
//   GET  /dsh-fish-service/logs              最近 200 行日志
//   GET  /dsh-fish-service/voices            音色列表（设置页默认音色下拉用）
//   POST /dsh-fish-service/read              朗读：清洗 + 分段 + TTS，返回 wav 列表
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
  回(res, 405, { ok: false, code: 'bad_request', hint: `这个接口只支持 ${方法}。` })
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
      回(res, 403, { ok: false, code: 'bad_request', hint: '跨站请求被拒绝。' })
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
      回(res, 403, { ok: false, code: 'bad_request', hint: '跨站请求被拒绝。' })
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
        hint: 快照.lastError?.hint || '服务没连上。确认服务已启动、地址和端口正确。',
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
      回(res, 403, { ok: false, code: 'bad_request', hint: '跨站请求被拒绝。' })
      return
    }
    const 体 = await 读体(req, 文本上限)
    const 原文 = typeof 体.text === 'string' ? 体.text : ''
    if (!原文.trim()) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有可朗读的文字。' })
      return
    }

    const 配置 = api.config.get()
    const maxChars = 数字钳(体.maxChars, 配置.readMaxChars || 默认最大字数, 最小分段字数, 最大分段字数)
    const skipCodeBlocks = 体.skipCodeBlocks === undefined ? 配置.readSkipCode !== false : Boolean(体.skipCodeBlocks)
    const 语音 = prepareSpeech(原文, { maxChars, skipCodeBlocks })
    if (!语音.chunks.length) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: skipCodeBlocks ? '这条消息去掉代码块后没有可朗读的文字。' : '这条消息没有可朗读的文字。',
      })
      return
    }

    let speed
    if (体.speed !== undefined && 体.speed !== null && 体.speed !== '') {
      const n = Number(体.speed)
      if (!Number.isFinite(n) || n < 0.5 || n > 2) {
        回(res, 400, { ok: false, code: 'bad_request', hint: '参数不对：语速必须在 0.5~2.0。' })
        return
      }
      speed = Math.round(n * 100) / 100
    } else if (Number.isFinite(Number(配置.ttsSpeed))) {
      speed = Number(配置.ttsSpeed)
    }

    const voice = String(体.voice || 配置.ttsVoice || '').trim() || undefined
    const 开始 = Date.now()
    try {
      // fish.service.tts 单次最多 20 条（契约），这里最多 40 段，按 20 条一批合成。
      const items = []
      for (let 起点 = 0; 起点 < 语音.chunks.length; 起点 += 20) {
        const 批 = 语音.chunks.slice(起点, 起点 + 20)
        const 结果 = await api.tts(批, {
          ...(voice ? { voice } : {}),
          ...(speed ? { speed } : {}),
          timeoutMs: 配置.requestTimeoutMs,
        })
        for (const [i, 项] of (结果.items || []).entries()) {
          const 全局下标 = 起点 + i
          items.push({
            wavPath: 项.wavPath,
            url: 音频地址(项.wavPath),
            ms: 项.ms,
            voice: 项.voice,
            bytes: 项.bytes,
            chars: 语音.chunks[全局下标] ? 语音.chunks[全局下标].length : 0,
          })
        }
      }
      if (!items.length) {
        回(res, 200, { ok: false, code: 'upstream_error', hint: '合成没有返回音频，请稍后重试。' })
        return
      }
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
      })
    } catch (error) {
      // 合成失败是「服务没起 / 显存不够 / 缺模型」这类可展示原因；200 + ok:false 让前端直接念 hint。
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 200, 包)
    }
  })

  // ---------------- 音频回放（只允许 cacheDir 里的文件） ----------------

  加(`${prefix}/audio`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    const 路径 = String(查询(req).get('path') || '').trim()
    if (!路径) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '缺少 path 参数。' })
      return
    }
    const 缓存根 = String(api.config.get().cacheDir || cache?.dirPath || '')
    // 防目录穿越：解析后必须落在 cacheDir 里，且是已知音频扩展名。
    if (!缓存根 || !isPathInside(缓存根, 路径)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '只允许读取插件缓存目录里的音频。' })
      return
    }
    const 类型 = 音频类型[extname(路径).toLowerCase()]
    if (!类型) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '只支持 wav / webm / ogg / mp3 / m4a。' })
      return
    }
    let 信息
    try { 信息 = statSync(路径) } catch {
      回(res, 404, { ok: false, code: 'bad_request', hint: '音频文件不存在或已被清理。' })
      return
    }
    if (!信息.isFile()) {
      回(res, 404, { ok: false, code: 'bad_request', hint: '音频文件不存在。' })
      return
    }
    if (信息.size > 128 * 1024 * 1024) {
      回(res, 413, { ok: false, code: 'bad_request', hint: '音频文件太大，已拒绝。' })
      return
    }
    let 数据
    try { 数据 = readFileSync(路径) } catch {
      回(res, 404, { ok: false, code: 'bad_request', hint: '音频文件读不到。' })
      return
    }
    回二进制(res, 类型, 数据, basename(路径))
  })

  // ---------------- 语音输入：转文字 ----------------

  加(`${prefix}/transcribe-upload`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '跨站请求被拒绝。' })
      return
    }
    const 原始 = await 读原始体(req, 上传上限)
    if (原始.over) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB，已拒绝。` })
      return
    }
    const 解析 = 解析multipart(原始.buffer, req?.headers?.['content-type'])
    const 文件 = 取音频文件(解析)
    if (!文件 || !文件.data.length) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有收到音频文件（表单字段用 file）。' })
      return
    }
    if (文件.data.length > 最大音频字节) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB，已拒绝。` })
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

    // 临时文件放在 cacheDir/tmp，请求结束就删（不长期保存用户音频）。
    let 临时 = ''
    try {
      临时 = cache.saveBuffer('tmp', 文件.data, { ext: 扩展, name: `${randomUUID()}${扩展}` })
    } catch (error) {
      回(res, 500, { ok: false, code: 'upstream_error', hint: `临时文件写入失败：${error?.message || error}` })
      return
    }

    const 开始 = Date.now()
    try {
      const 结果 = await api.asr(临时, { language: 语言, speaker: 说话人, timeoutMs: 配置.asrTimeoutMs })
      const 项 = (结果.items && 结果.items[0]) || {}
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
      try { if (临时) rmSync(临时, { force: true }) } catch { /* 删不掉就留给 TTL 清理 */ }
    }
  })

  // ---------------- 语音输入：保留语音（存到 cacheDir/voice） ----------------

  加(`${prefix}/voice-upload`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '跨站请求被拒绝。' })
      return
    }
    const 原始 = await 读原始体(req, 上传上限)
    if (原始.over) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB，已拒绝。` })
      return
    }
    const 解析 = 解析multipart(原始.buffer, req?.headers?.['content-type'])
    const 文件 = 取音频文件(解析)
    if (!文件 || !文件.data.length) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有收到音频文件（表单字段用 file）。' })
      return
    }
    if (文件.data.length > 最大音频字节) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB，已拒绝。` })
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
      回(res, 500, { ok: false, code: 'upstream_error', hint: `音频保存失败：${error?.message || error}` })
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
