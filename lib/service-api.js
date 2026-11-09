// fish.service 的实现：按 CONTRACT.md 第 1 节暴露统一门面。
//
// 这里是「服务方法」层，不含 DSH 工具参数校验（那在 lib/tools/），
// 也不含宿主路由（在 lib/routes.js）。所有方法内部抛 FishServiceError，
// 工具层负责转成 {ok:false, code, hint}。

import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import {
  FishServiceError,
  makeError,
  modelMissingHint,
  timeoutHint,
} from './errors.js'
import { emptyCapabilities } from './capabilities.js'
import { isAbsolutePath, sha16 } from './fs-util.js'

const 最大上传MB = 200
const 最大文本字数 = 5000
const 最大翻译条数 = 500
const 最大翻译总字数 = 200000
const TTS_语言 = ['auto', 'zh', 'en', 'ja', 'es', 'ar']
const ASR_语言 = ['auto', 'zh', 'en', 'ja', 'ko', 'yue', 'nospeech']
const ASR_引擎 = ['auto', 'sensevoice', 'whisper']
const 分离模型 = ['htdemucs', 'htdemucs_6s', 'htdemucs_ft']
const 分离音轨 = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano']
const 任务种类 = ['tts', 'asr', 'separate', 'translate', 'download', 'analyze', 'vision']
const 任务状态 = ['queued', 'running', 'done', 'failed', 'canceled']
const 努力档 = ['auto', 'low', 'medium', 'high']
const 规划器 = ['hybrid', 'agent']
const 字幕档 = ['auto', 'off']

const 睡眠 = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

const 解码头 = (值) => {
  if (值 == null) return undefined
  try { return decodeURIComponent(String(值)) } catch { return String(值) }
}

function 可中断睡眠(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const 错 = new Error('aborted')
      错.name = 'AbortError'
      reject(错)
      return
    }
    const 定时器 = setTimeout(() => {
      signal?.removeEventListener?.('abort', 中止)
      resolve()
    }, Math.max(0, ms))
    const 中止 = () => {
      clearTimeout(定时器)
      signal?.removeEventListener?.('abort', 中止)
      const 错 = new Error('aborted')
      错.name = 'AbortError'
      reject(错)
    }
    signal?.addEventListener?.('abort', 中止, { once: true })
  })
}

const 是文本 = (值) => typeof 值 === 'string'

function 规范文本数组(input, { 名称 = 'texts', 最多 = 20 } = {}) {
  const 数组 = 是文本(input) ? [input] : (Array.isArray(input) ? input.slice() : null)
  if (!数组) {
    throw makeError('bad_request', { detail: `${名称} 必须是字符串或字符串数组`, hint: '参数不对：文本必须是字符串数组。' })
  }
  if (数组.length === 0) {
    throw makeError('bad_request', { detail: `${名称} 不能为空`, hint: '参数不对：至少要给一条文本。' })
  }
  if (数组.length > 最多) {
    throw makeError('bad_request', {
      detail: `${名称} 一次最多 ${最多} 条，收到 ${数组.length} 条`,
      hint: `参数不对：一次最多 ${最多} 条，请拆批。`,
    })
  }
  for (const 项 of 数组) {
    if (!是文本(项)) {
      throw makeError('bad_request', { detail: `${名称} 里有非字符串`, hint: '参数不对：文本数组里必须都是字符串。' })
    }
  }
  return 数组
}

function 规范文件数组(input, { 名称 = 'files', 最多 = 10 } = {}) {
  const 数组 = 是文本(input) ? [input] : (Array.isArray(input) ? input.slice() : null)
  if (!数组) {
    throw makeError('bad_request', { detail: `${名称} 必须是路径或路径数组`, hint: '参数不对：文件必须是本机绝对路径。' })
  }
  if (数组.length === 0) {
    throw makeError('bad_request', { detail: `${名称} 不能为空`, hint: '参数不对：至少要给一个文件。' })
  }
  if (数组.length > 最多) {
    throw makeError('bad_request', {
      detail: `${名称} 一次最多 ${最多} 个，收到 ${数组.length} 个`,
      hint: `参数不对：一次最多 ${最多} 个文件，请拆批。`,
    })
  }
  return 数组
}

function 检查本机文件(path, { 名称 = '文件' } = {}) {
  const 值 = String(path == null ? '' : path)
  if (!值 || !isAbsolutePath(值)) {
    throw makeError('bad_request', { detail: `${名称} 不是绝对路径：${值}`, hint: `参数不对：${名称}要给本机绝对路径。` })
  }
  if (!existsSync(值)) {
    throw makeError('bad_request', { detail: `${名称} 不存在：${值}`, hint: `参数不对：找不到${名称}。` })
  }
  let 信息
  try { 信息 = statSync(值) } catch {
    throw makeError('bad_request', { detail: `${名称} 读不到：${值}`, hint: `参数不对：${名称}读不到。` })
  }
  if (!信息.isFile()) {
    throw makeError('bad_request', { detail: `${名称} 不是文件：${值}`, hint: `参数不对：${名称}必须是文件。` })
  }
  if (信息.size > 最大上传MB * 1024 * 1024) {
    throw makeError('bad_request', {
      detail: `${名称} ${(信息.size / 1024 / 1024).toFixed(1)}MB，超过 ${最大上传MB}MB`,
      hint: `参数不对：${名称}超过 ${最大上传MB}MB，请先裁剪或压缩。`,
    })
  }
  return 信息
}

const 取整数 = (值, 名称, 最小, 最大, 兜底) => {
  if (值 === undefined || 值 === null) return 兜底
  const n = Number(值)
  if (!Number.isInteger(n) || n < 最小 || n > 最大) {
    throw makeError('bad_request', {
      detail: `${名称}=${值} 不在 ${最小}~${最大}`,
      hint: `参数不对：${名称} 必须是 ${最小}~${最大} 的整数。`,
    })
  }
  return n
}

const 取枚举 = (值, 名称, 允许, 兜底) => {
  if (值 === undefined || 值 === null || 值 === '') return 兜底
  if (!允许.includes(值)) {
    throw makeError('bad_request', {
      detail: `${名称}=${值} 不在 ${允许.join('/')}`,
      hint: `参数不对：${名称} 只能是 ${允许.join(' / ')}。`,
    })
  }
  return 值
}

const 取超时 = (值, 兜底) => {
  const n = Number(值)
  if (!Number.isFinite(n)) return 兜底
  return Math.max(1000, Math.min(1800000, Math.round(n)))
}

/** 把普通错误包装成 FishServiceError（保留 code/hint/detail）。 */
function 转成服务错误(error, capability = '') {
  if (error instanceof FishServiceError) return error
  const code = error?.code || 'upstream_error'
  return new FishServiceError(code, {
    detail: error?.detail || error?.message || String(error || ''),
    hint: error?.hint || '',
    capability: error?.capability || capability,
  })
}

export function createFishServiceApi({
  ctx = null,
  configStore,
  client,
  capabilities: 能力服务,
  cache,
  logger = null,
  version = '0.1.0',
  onConfigChange = null,
} = {}) {
  const 取配置 = () => configStore.current
  const 事件 = 能力服务.events
  const 最近错误 = []
  let 最近错误条 = null
  const 错误节流 = new Map()
  let 音色缓存 = null

  function 记错误(error, capability = '') {
    const 错 = 转成服务错误(error, capability)
    最近错误条 = {
      code: 错.code,
      hint: 错.hint,
      detail: 错.detail,
      capability: 错.capability || capability,
      at: new Date().toISOString(),
    }
    最近错误.push(最近错误条)
    if (最近错误.length > 20) 最近错误.shift()

    const 现在 = Date.now()
    const 上次 = 错误节流.get(错.code) || 0
    if (现在 - 上次 >= 5000) {
      错误节流.set(错.code, 现在)
      // EventEmitter 的 'error' 事件没有监听者时会抛异常；事件是尽力而为，不能影响主流程。
      if ((事件.listenerCount?.('error') || 0) > 0) {
        事件.emit('error', {
          code: 错.code,
          capability: 错.capability || capability || undefined,
          detail: 错.detail,
          at: 最近错误条.at,
        })
      }
    }
    logger?.warn(`${错.code}: ${错.detail || 错.hint}`)
    return 错
  }

  function 抛错(code, opts = {}) {
    // 只抛；记录交给外面的 守护()，避免同一条错误记两遍。
    throw makeError(code, opts)
  }

  function 断言启用() {
    if (取配置()?.enabled === false) {
      抛错('service_not_installed', {
        detail: 'enabled=false',
        hint: '本地 AI 插件已在设置里停用。到 设置 → 插件 → 本地 AI 打开总开关。',
      })
    }
  }

  /** 门禁 + 错误记录。 */
  async function 要能力(name) {
    断言启用()
    const 结果 = await 能力服务.require(name)
    if (!结果.ok) {
      记错误(结果.error, name)
      throw 结果.error
    }
    return 结果.info
  }

  /** 统一包一层：失败时失效能力缓存（507/503 后不要继续显示旧的 ready）。 */
  async function 守护(capability, fn) {
    try {
      return await fn()
    } catch (error) {
      const 错 = 转成服务错误(error, capability)
      if (['vram_exhausted', 'service_down', 'model_missing', 'upstream_error', 'timeout'].includes(错.code)) {
        能力服务.invalidate()
      }
      记错误(错, capability)
      throw 错
    }
  }

  // ---------------- TTS ----------------

  async function tts(input, opts = {}) {
    return 守护('tts', async () => {
      断言启用()
      const 配置 = 取配置()
      const 文本s = 规范文本数组(input, { 名称: 'texts', 最多: 20 })
      for (const 文本 of 文本s) {
        if (文本.length === 0) 抛错('bad_request', { detail: '文本为空', hint: '参数不对：文本不能为空。' })
        if (文本.length > 最大文本字数) {
          抛错('bad_request', {
            detail: `单条文本 ${文本.length} 字，超过 ${最大文本字数}`,
            hint: `参数不对：单条文本最多 ${最大文本字数} 字，请分段。`,
          })
        }
      }

      const voice = String(opts.voice || 配置.ttsVoice || 'dafeiyu')
      const speed = opts.speed === undefined ? undefined : Number(opts.speed)
      if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.5 || speed > 2)) {
        抛错('bad_request', { detail: `speed=${opts.speed}`, hint: '参数不对：speed 必须在 0.5~2.0。' })
      }
      const language = 取枚举(opts.language, 'language', TTS_语言, 'auto')
      const seed = opts.seed === undefined || opts.seed === null
        ? undefined
        : 取整数(opts.seed, 'seed', 0, 4294967295, undefined)
      const timeoutMs = 取超时(opts.timeoutMs, 配置.requestTimeoutMs)

      await 要能力('tts')

      const items = []
      const 开始 = Date.now()
      for (const text of 文本s) {
        const body = { text, voice }
        if (speed !== undefined) body.speed = speed
        if (language && language !== 'auto') body.language = language
        if (seed !== undefined) body.seed = seed
        if (opts.emotion) body.emotion = String(opts.emotion)

        const key = sha16(JSON.stringify([body.text, body.voice, body.speed, body.emotion, body.seed]))
        if (body.seed !== undefined) {
          const 已有 = cache.findByKey('tts', key)
          if (已有 && existsSync(已有)) {
            let bytes = 0
            try { bytes = statSync(已有).size } catch { bytes = 0 }
            items.push({
              wavPath: 已有,
              ms: 0,
              voice,
              seed: body.seed,
              ...(language && language !== 'auto' ? { language } : {}),
              bytes,
              cached: true,
            })
            continue
          }
        }

        const 响应 = await client.postBinary('/tts', body, {
          timeoutMs,
          capability: 'tts',
          capabilityReady: true,
        })
        const 缓冲 = Buffer.isBuffer(响应.data) ? 响应.data : Buffer.from(响应.data)
        const 头seed = 响应.headers?.get?.('x-seed')
        const 实际seed = 头seed !== null && 头seed !== undefined && 头seed !== '' ? Number(头seed) : undefined
        const 实际语言 = 解码头(响应.headers?.get?.('x-language'))
        const 路径 = cache.saveBuffer('tts', 缓冲, { ext: '.wav', key, ts: Date.now() })
        items.push({
          wavPath: 路径,
          ms: 响应.ms,
          voice,
          seed: Number.isInteger(实际seed) ? 实际seed : (body.seed ?? 0),
          ...(实际语言 ? { language: 实际语言 } : (language && language !== 'auto' ? { language } : {})),
          bytes: 缓冲.length,
          cached: false,
          ...(opts.returnBuffer ? { buffer: 缓冲 } : {}),
        })
      }

      return { ok: true, items, ms: Date.now() - 开始 }
    })
  }

  // ---------------- ASR ----------------

  function 映射分段(segments) {
    if (!Array.isArray(segments)) return undefined
    const 规范 = segments.map((x) => ({
      start: Number(x?.start) || 0,
      end: Number(x?.end) || 0,
      text: String(x?.text || ''),
    }))
    if (规范.length <= 200) return 规范
    return [...规范.slice(0, 100), ...规范.slice(-100)]
  }

  async function asr(input, opts = {}) {
    return 守护('asr', async () => {
      断言启用()
      const 配置 = 取配置()
      const 文件s = 规范文件数组(input, { 名称: 'files', 最多: 10 })
      for (const 文件 of 文件s) 检查本机文件(文件, { 名称: '音频文件' })

      const language = 取枚举(opts.language, 'language', ASR_语言, 'auto')
      const engine = 取枚举(opts.engine, 'engine', ASR_引擎, 'auto')
      const speaker = opts.speaker !== false
      const timestamps = opts.timestamps === true
      const timeoutMs = 取超时(opts.timeoutMs, 配置.asrTimeoutMs)

      await 要能力('asr')

      const items = []
      const 开始 = Date.now()
      for (const 文件 of 文件s) {
        const fields = {
          speaker: speaker ? '1' : '0',
          ...(language && language !== 'auto' ? { language } : {}),
          ...(engine && engine !== 'auto' ? { engine } : {}),
          ...(timestamps ? { timestamps: '1' } : {}),
        }
        const 路径 = timestamps ? '/asr/segments' : '/asr'
        const 响应 = await client.postMultipart(路径, {
          fields,
          files: [{ field: 'file', path: 文件 }],
          timeoutMs,
          capability: 'asr',
          capabilityReady: true,
        })
        const 体 = 响应.data || {}
        if (体.ok === false) {
          抛错('upstream_error', {
            detail: String(体.detail || 体.error || 'asr failed'),
            hint: `转写失败：${体.detail || 体.error || '未知错误'}。`,
            capability: 'asr',
          })
        }

        const 分段 = 映射分段(体.segments)
        const 累计 = {
          file: 文件,
          text: String(体.text || ''),
          ...(体.language ? { language: String(体.language) } : {}),
          ...(体.engine ? { engine: String(体.engine) } : {}),
          ...(体.duration != null ? { durationMs: Math.round(Number(体.duration) * 1000) } : {}),
          ...(体.elapsed_ms != null ? { elapsedMs: Number(体.elapsed_ms) } : {}),
          ...(speaker && !timestamps
            ? {
                speaker: 体.speaker && typeof 体.speaker === 'object'
                  ? {
                      name: String(体.speaker.name || ''),
                      score: Number(体.speaker.score) || 0,
                      known: Boolean(体.speaker.known),
                    }
                  : null,
                ...(体.speaker_error ? { speakerError: String(体.speaker_error) } : {}),
              }
            : {}),
          ...(分段 ? { segments: 分段 } : {}),
          ...(Array.isArray(体.segments) && 体.segments.length > 200 ? { truncated: true } : {}),
        }
        items.push(累计)
      }

      return { ok: true, items, ms: Date.now() - 开始 }
    })
  }

  // ---------------- 翻译 ----------------

  async function translate(input, opts = {}) {
    return 守护('translate', async () => {
      断言启用()
      const 配置 = 取配置()
      const 文本s = 规范文本数组(input, { 名称: 'texts', 最多: 最大翻译条数 })
      const target = String(opts.target || '').trim()
      if (!target || target === 'auto') {
        抛错('bad_request', { detail: 'target 不能为空或 auto', hint: '参数不对：target 必须是目标语言（不能是 auto）。' })
      }
      const source = String(opts.source || 'auto').trim() || 'auto'
      let 总字数 = 0
      for (const 文本 of 文本s) {
        总字数 += 文本.length
        if (文本.length > 最大文本字数) {
          抛错('bad_request', { detail: `单条文本 ${文本.length} 字`, hint: `参数不对：单条文本最多 ${最大文本字数} 字。` })
        }
      }
      if (总字数 > 最大翻译总字数) {
        抛错('bad_request', {
          detail: `总字数 ${总字数}，超过 ${最大翻译总字数}`,
          hint: `参数不对：一次最多 ${最大翻译总字数} 字，请拆批或用 fish_job。`,
        })
      }
      const timeoutMs = 取超时(opts.timeoutMs, 60000)
      const batchSize = opts.batchSize === undefined ? 8 : 取整数(opts.batchSize, 'batchSize', 1, 16, 8)

      await 要能力('translate')
      const 开始 = Date.now()

      // 契约：空字符串原样返回，不发给服务端；顺序必须和输入严格一致。
      const 非空 = []
      const 非空索引 = []
      文本s.forEach((文本, 下标) => {
        if (文本.length > 0) {
          非空.push(文本)
          非空索引.push(下标)
        }
      })
      if (非空.length === 0) {
        return {
          ok: true,
          texts: 文本s.map(() => ''),
          source,
          target,
          engine: 'nllb',
          ms: Date.now() - 开始,
        }
      }

      if (文本s.length === 1) {
        const 响应 = await client.postJson('/translate', {
          text: 非空[0],
          source,
          target,
          batch_size: batchSize,
        }, { timeoutMs, capability: 'translate', capabilityReady: true })
        const 体 = 响应.data || {}
        return {
          ok: true,
          texts: [String(体.text ?? '')],
          source: String(体.source || source),
          target: String(体.target || target),
          engine: 'nllb',
          ms: Date.now() - 开始,
          ...(体.chunks != null ? { chunks: Number(体.chunks) } : {}),
        }
      }

      const 响应 = await client.postJson('/translate/batch', {
        texts: 非空,
        source,
        target,
        batch_size: batchSize,
      }, { timeoutMs, capability: 'translate', capabilityReady: true })
      const 体 = 响应.data || {}
      const 服务器结果 = Array.isArray(体.texts) ? 体.texts.map((x) => String(x ?? '')) : []
      const 结果 = 文本s.map(() => '')
      非空索引.forEach((原下标, 序号) => {
        结果[原下标] = 服务器结果[序号] ?? ''
      })
      return {
        ok: true,
        texts: 结果,
        source: String(体.source || source),
        target: String(体.target || target),
        engine: 'nllb',
        ms: Date.now() - 开始,
        ...(体.chunks != null ? { chunks: Number(体.chunks) } : {}),
      }
    })
  }

  // ---------------- 人声分离 ----------------

  async function separate(file, opts = {}) {
    return 守护('separate', async () => {
      断言启用()
      const 配置 = 取配置()
      检查本机文件(file, { 名称: '音频/视频文件' })
      const model = 取枚举(opts.model, 'model', 分离模型, 'htdemucs')
      const stems = Array.isArray(opts.stems) && opts.stems.length ? opts.stems.map(String) : ['vocals', 'drums', 'bass', 'other']
      for (const 音轨 of stems) {
        if (!分离音轨.includes(音轨)) {
          抛错('bad_request', { detail: `未知 stem：${音轨}`, hint: `参数不对：stem 只能是 ${分离音轨.join(' / ')}。` })
        }
      }
      const timeoutMs = 取超时(opts.timeoutMs, 配置.asrTimeoutMs)
      await 要能力('separate')

      const 开始 = Date.now()
      const 响应 = await client.postMultipart('/separate', {
        fields: { model, stems: stems.join(',') },
        files: [{ field: 'file', path: file }],
        timeoutMs,
        capability: 'separate',
        capabilityReady: true,
      })
      const 体 = 响应.data || {}
      if (!体.stems || typeof 体.stems !== 'object') {
        抛错('upstream_error', { detail: '服务没有返回 stems', hint: '服务没有返回分离结果（stems 为空）。', capability: 'separate' })
      }

      const 目录 = cache.makeJobDir('separate')
      const 结果 = {}
      for (const [音轨, 信息] of Object.entries(体.stems)) {
        const 源 = String(信息?.path || '')
        if (!源 || !existsSync(源)) continue
        const 扩展 = extname(源) || '.wav'
        const 目标 = cache.copyIn('separate', 源, {
          subdir: 目录.split(/[\\/]/).pop(),
          name: `${音轨}${扩展}`,
        })
        if (!目标) continue
        结果[音轨] = {
          path: 目标,
          ...(信息?.duration != null ? { duration: Number(信息.duration) } : {}),
        }
      }
      if (!Object.keys(结果).length) {
        抛错('upstream_error', { detail: '没有可复制的 stem', hint: '分离完成但没有可读取的 stem 文件。', capability: 'separate' })
      }

      const 释放 = Array.isArray(体.released_models) ? 体.released_models : (Array.isArray(体.released) ? 体.released : [])
      return {
        ok: true,
        stems: 结果,
        dir: 目录,
        ms: Date.now() - 开始,
        ...(释放.length ? { released: 释放.map(String) } : {}),
      }
    })
  }

  // ---------------- 视觉关键帧 ----------------

  async function visionFrames(input, opts = {}) {
    return 守护('vision', async () => {
      断言启用()
      const 配置 = 取配置()
      const 来源 = input && typeof input === 'object' ? input : { videoPath: input }
      if (来源.url) {
        抛错('not_implemented', {
          detail: 'url 输入需要下载能力，P1 未实现',
          hint: '这个功能还没实现（url 输入，P3）。请先把视频下载到本机再传 videoPath。',
        })
      }
      if (!来源.videoPath && !来源.jobId) {
        抛错('bad_request', { detail: '缺少 videoPath / jobId', hint: '参数不对：要传本机视频路径。' })
      }
      if (来源.videoPath) 检查本机文件(来源.videoPath, { 名称: '视频文件' })

      const targetFrames = 取整数(opts.targetFrames ?? 3, 'targetFrames', 1, 10, 3)
      const effort = 取枚举(opts.effort, 'effort', 努力档, 'auto')
      const planner = 取枚举(opts.planner, 'planner', 规划器, 'hybrid')
      const subtitles = 取枚举(opts.subtitles, 'subtitles', 字幕档, 'auto')
      const timeoutMs = 取超时(opts.timeoutMs, 配置.visionTimeoutMs)

      await 要能力('vision')
      const 开始 = Date.now()
      const body = {
        target_frames: targetFrames,
        effort,
        planner,
        subtitles,
        ...(来源.videoPath ? { video_path: 来源.videoPath } : { job_id: 来源.jobId }),
      }
      const 响应 = await client.postJson('/vision/frames', body, {
        timeoutMs,
        capability: 'vision',
        capabilityReady: true,
      })
      const 体 = 响应.data || {}
      const 目录 = cache.makeJobDir('vision')
      const 子目录 = 目录.split(/[\\/]/).pop()
      const frames = []
      for (const [序号, 帧] of (Array.isArray(体.frames) ? 体.frames : []).slice(0, 10).entries()) {
        const 源 = String(帧?.path || '')
        if (!源 || !existsSync(源)) continue
        const 扩展 = extname(源) || '.jpg'
        const 目标 = cache.copyIn('vision', 源, { subdir: 子目录, name: `frame_${String(序号 + 1).padStart(4, '0')}${扩展}` })
        if (!目标) continue
        frames.push({
          time: Number(帧.time) || 0,
          path: 目标,
          ...(帧.score != null ? { score: Number(帧.score) } : {}),
          ...(帧.kind ? { kind: String(帧.kind) } : {}),
          ...(帧.ocr_text ? { ocrText: String(帧.ocr_text) } : {}),
          ...(帧.summary ? { summary: String(帧.summary).slice(0, 300) } : {}),
          ...(帧.why ? { why: String(帧.why) } : {}),
          ...(帧.confidence ? { confidence: String(帧.confidence) } : {}),
        })
      }

      return {
        ok: true,
        frames,
        ...(体.duration != null ? { duration: Number(体.duration) } : {}),
        ...(体.subtitles_from ? { subtitlesFrom: String(体.subtitles_from) } : {}),
        ...(体.stats && typeof 体.stats === 'object'
          ? {
              stats: {
                ...(体.stats.candidates != null ? { candidates: Number(体.stats.candidates) } : {}),
                ...(体.stats.vlm_calls != null ? { vlmCalls: Number(体.stats.vlm_calls) } : {}),
                ...(体.stats.elapsed_ms != null ? { elapsedMs: Number(体.stats.elapsed_ms) } : {}),
                ...(体.stats.degraded != null ? { degraded: Boolean(体.stats.degraded) } : {}),
                ...(体.stats.degraded_reason ? { degradedReason: String(体.stats.degraded_reason) } : {}),
              },
            }
          : {}),
        ms: Date.now() - 开始,
      }
    })
  }

  // ---------------- 媒体探测 ----------------

  async function mediaProbe(input, opts = {}) {
    return 守护('media', async () => {
      断言启用()
      const 配置 = 取配置()
      const 文件s = 规范文件数组(input, { 名称: 'files', 最多: 10 })
      for (const 文件 of 文件s) 检查本机文件(文件, { 名称: '媒体文件' })
      const timeoutMs = 取超时(opts.timeoutMs, 30000)
      await 要能力('media')

      const items = []
      const 开始 = Date.now()
      for (const 文件 of 文件s) {
        const 响应 = await client.postMultipart('/media/probe', {
          files: [{ field: 'file', path: 文件 }],
          timeoutMs,
          capability: 'media',
          capabilityReady: true,
        })
        const 体 = 响应.data || {}
        items.push({
          file: 文件,
          ...(体.duration != null ? { duration: Number(体.duration) } : {}),
          ...(体.format ? { format: String(体.format) } : {}),
          ...(体.audio && typeof 体.audio === 'object'
            ? {
                audio: {
                  ...(体.audio.codec ? { codec: String(体.audio.codec) } : {}),
                  ...(体.audio.sample_rate != null ? { sampleRate: Number(体.audio.sample_rate) } : {}),
                  ...(体.audio.channels != null ? { channels: Number(体.audio.channels) } : {}),
                },
              }
            : {}),
          ...(体.video && typeof 体.video === 'object'
            ? {
                video: {
                  ...(体.video.codec ? { codec: String(体.video.codec) } : {}),
                  ...(体.video.width != null ? { width: Number(体.video.width) } : {}),
                  ...(体.video.height != null ? { height: Number(体.video.height) } : {}),
                  ...(体.video.fps != null ? { fps: Number(体.video.fps) } : {}),
                },
              }
            : {}),
        })
      }
      return { ok: true, items, ms: Date.now() - 开始 }
    })
  }

  // ---------------- 任务队列 ----------------

  function 映射任务(id, 体) {
    const 错 = 体?.error
    return {
      ok: true,
      id: String(体?.id || id || ''),
      kind: String(体?.kind || ''),
      ...(体?.action ? { action: String(体.action) } : {}),
      state: String(体?.state || 'unknown'),
      ...(体?.priority != null ? { priority: Number(体.priority) } : {}),
      ...(体?.created_at ? { createdAt: String(体.created_at) } : {}),
      ...(体?.started_at ? { startedAt: String(体.started_at) } : {}),
      ...(体?.finished_at ? { finishedAt: String(体.finished_at) } : {}),
      ...(体?.attempts != null ? { attempts: Number(体.attempts) } : {}),
      ...(错 != null ? { error: typeof 错 === 'string' ? 错 : JSON.stringify(错) } : {}),
      ...(体?.result != null ? { result: 体.result } : {}),
      ...(体?.meta?.progress && typeof 体.meta.progress === 'object' ? { progress: 体.meta.progress } : {}),
    }
  }

  function 检查任务id(id) {
    const 值 = String(id == null ? '' : id).trim()
    if (!值) 抛错('bad_request', { detail: '缺少 jobId', hint: '参数不对：要传 jobId。' })
    return 值
  }

  const jobs = {
    async enqueue(kind, payload = {}, opts = {}) {
      return 守护('jobs', async () => {
        断言启用()
        if (!任务种类.includes(kind)) {
          抛错('bad_request', { detail: `未知任务类型 ${kind}`, hint: `参数不对：kind 只能是 ${任务种类.join(' / ')}。` })
        }
        if (opts.files && Array.isArray(opts.files) && opts.files.length) {
          抛错('not_implemented', {
            detail: 'files 需要先上传到服务端，P1 未实现',
            hint: '这个功能还没实现（带文件的任务提交，P3）。请用 fish_tts / fish_asr 等同步工具。',
          })
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          抛错('bad_request', { detail: 'payload 必须是对象', hint: '参数不对：payload 必须是 JSON 对象。' })
        }
        const 响应 = await client.postJson('/jobs', {
          kind,
          payload,
          ...(opts.priority != null ? { priority: Number(opts.priority) } : {}),
        }, {
          timeoutMs: 取超时(opts.timeoutMs, 30000),
          capability: 'jobs',
          capabilityReady: true,
        })
        const 体 = 响应.data || {}
        if (!体.id) 抛错('upstream_error', { detail: '服务没有返回任务 id', hint: '提交任务失败：服务没有返回任务 id。' })
        return { ok: true, id: String(体.id), state: String(体.state || 'queued') }
      })
    },

    async status(id, opts = {}) {
      return 守护('jobs', async () => {
        断言启用()
        const 任务id = 检查任务id(id)
        const 响应 = await client.getJson(`/jobs/${encodeURIComponent(任务id)}`, {
          timeoutMs: 取超时(opts.timeoutMs, 15000),
          capability: 'jobs',
          capabilityReady: true,
        })
        return 映射任务(任务id, 响应.data)
      })
    },

    async wait(id, opts = {}) {
      return 守护('jobs', async () => {
        断言启用()
        const 任务id = 检查任务id(id)
        const 总超时 = 取超时(opts.timeoutMs, 600000)
        const 轮询 = Math.max(200, Number(opts.pollMs) || 1000)
        const 截止 = Date.now() + 总超时
        const signal = opts.signal
        try {
          for (;;) {
            if (signal?.aborted) {
              const 错 = new Error('aborted')
              错.name = 'AbortError'
              throw 错
            }
            const 记录 = await jobs.status(任务id, { timeoutMs: 15000 })
            if (['done', 'failed', 'canceled'].includes(记录.state)) return 记录
            if (Date.now() >= 截止) {
              抛错('timeout', {
                detail: `等待任务 ${任务id} 超过 ${总超时}ms`,
                hint: timeoutHint(总超时),
              })
            }
            await 可中断睡眠(Math.min(轮询, Math.max(0, 截止 - Date.now())), signal)
          }
        } catch (error) {
          if (error?.name === 'AbortError') {
            try { await jobs.cancel(任务id) } catch { /* 取消失败也不掩盖取消 */ }
            抛错('canceled', { detail: '等待被取消', hint: '任务已取消。' })
          }
          throw error
        }
      })
    },

    async cancel(id) {
      return 守护('jobs', async () => {
        断言启用()
        const 任务id = 检查任务id(id)
        try {
          const 响应 = await client.postJson(`/jobs/${encodeURIComponent(任务id)}/cancel`, {}, {
            timeoutMs: 15000,
            capability: 'jobs',
            capabilityReady: true,
          })
          const 体 = 响应.data || {}
          return {
            ok: true,
            id: String(体.id || 任务id),
            state: String(体.state || 'canceled'),
            ...(体.cancel_requested != null ? { cancelRequested: Boolean(体.cancel_requested) } : {}),
          }
        } catch (error) {
          const 错 = 转成服务错误(error, 'jobs')
          if (错.code === 'canceled') {
            return { ok: true, id: 任务id, state: 'canceled', cancelRequested: false }
          }
          throw 错
        }
      })
    },

    async list(filter = {}) {
      return 守护('jobs', async () => {
        断言启用()
        const 参数 = new URLSearchParams()
        if (filter.kind) 参数.set('kind', String(filter.kind))
        if (filter.state) 参数.set('state', String(filter.state))
        if (filter.limit != null) 参数.set('limit', String(取整数(filter.limit, 'limit', 1, 100, 20)))
        if (filter.offset != null) 参数.set('offset', String(Math.max(0, Number(filter.offset) || 0)))
        const 查询 = 参数.toString()
        const 响应 = await client.getJson(`/jobs${查询 ? `?${查询}` : ''}`, {
          timeoutMs: 15000,
          capability: 'jobs',
          capabilityReady: true,
        })
        const 体 = 响应.data || {}
        return {
          ok: true,
          total: Number(体.total) || 0,
          jobs: (Array.isArray(体.jobs) ? 体.jobs : []).map((x) => 映射任务(x.id, x)),
        }
      })
    },
  }

  // ---------------- 音色 ----------------

  async function voices(opts = {}) {
    return 守护('voices', async () => {
      断言启用()
      const 现在 = Date.now()
      if (音色缓存 && 现在 - 音色缓存.at < 30000) return 音色缓存.list
      const 响应 = await client.getJson('/voices', {
        timeoutMs: 取超时(opts.timeoutMs, 15000),
        capability: 'voices',
        capabilityReady: true,
      })
      const 体 = 响应.data || {}
      const list = (Array.isArray(体.voices) ? 体.voices : []).map((x) => ({
        name: String(x?.name || ''),
        ...(x?.filename ? { filename: String(x.filename) } : {}),
        ...(x?.format ? { format: String(x.format) } : {}),
        ...(x?.duration != null ? { duration: Number(x.duration) } : {}),
      })).filter((x) => x.name)
      音色缓存 = { at: 现在, list }
      return list
    })
  }

  // ---------------- 配置 ----------------

  const 可写字段 = [
    'baseUrl', 'apiVersion', 'token', 'enabled', 'ttsVoice',
    'requestTimeoutMs', 'asrTimeoutMs', 'visionTimeoutMs',
    'cacheDir', 'cacheTtlHours', 'cacheMaxMb', 'healthIntervalMs',
    'enabledCapabilities', 'logLevel',
  ]

  function 校验配置补丁(patch, 当前) {
    const 应用 = {}
    const applied = []
    const warnings = []
    const 源 = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}

    const 数字字段 = [
      ['requestTimeoutMs', 1000, 1800000],
      ['asrTimeoutMs', 1000, 1800000],
      ['visionTimeoutMs', 1000, 1800000],
      ['healthIntervalMs', 5000, 120000],
      ['cacheTtlHours', 1, 720],
      ['cacheMaxMb', 256, 10240],
    ]

    for (const 字段 of 可写字段) {
      if (源[字段] === undefined) continue
      const 值 = 源[字段]

      if (字段 === 'baseUrl') {
        const 地址 = String(值 || '').trim().replace(/\/+$/, '')
        try {
          const u = new URL(地址)
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('协议')
          应用[字段] = 地址
          applied.push(字段)
        } catch {
          warnings.push('baseUrl 必须是 http:// 或 https:// 地址，已忽略。')
        }
      } else if (字段 === 'apiVersion') {
        const 版本 = String(值 || '').trim()
        if (/^\d+(\.\d+)?$/.test(版本)) { 应用[字段] = 版本; applied.push(字段) }
        else warnings.push('apiVersion 必须是数字主版本（如 1），已忽略。')
      } else if (字段 === 'token') {
        if (值 === '***已设置***') continue
        const 令牌 = String(值 ?? '')
        if (令牌.length > 512) warnings.push('token 超过 512 字，已忽略。')
        else { 应用[字段] = 令牌; applied.push(字段) }
      } else if (字段 === 'enabled') {
        应用[字段] = 值 === true || 值 === 'true' || 值 === 1 || 值 === '1'
        applied.push(字段)
      } else if (字段 === 'ttsVoice') {
        const 音色 = String(值 || '').trim()
        if (!音色) warnings.push('ttsVoice 不能为空，已忽略。')
        else { 应用[字段] = 音色.slice(0, 80); applied.push(字段) }
      } else if (字段 === 'cacheDir') {
        const 目录 = String(值 || '').trim()
        if (!目录) warnings.push('cacheDir 不能为空，已忽略。')
        else { 应用[字段] = 目录; applied.push(字段) }
      } else if (字段 === 'enabledCapabilities') {
        const 列表 = Array.isArray(值) ? 值.map(String) : String(值 || '').split(',')
        const 合法 = 列表.map((x) => x.trim().toLowerCase()).filter((x) => ['tts', 'asr', 'translate', 'separate', 'vision', 'media', 'download', 'jobs'].includes(x))
        if (合法.length !== 列表.filter((x) => String(x).trim()).length) warnings.push('enabledCapabilities 里有未知能力，已过滤。')
        应用[字段] = [...new Set(合法)]
        applied.push(字段)
      } else if (字段 === 'logLevel') {
        const 级别 = String(值 || '').toLowerCase()
        if (['debug', 'info', 'warn', 'error'].includes(级别)) { 应用[字段] = 级别; applied.push(字段) }
        else warnings.push('logLevel 只能是 debug/info/warn/error，已忽略。')
      } else if (数字字段.some(([名]) => 名 === 字段)) {
        const [, 最小, 最大] = 数字字段.find(([名]) => 名 === 字段)
        const n = Number(值)
        if (!Number.isFinite(n) || n < 最小 || n > 最大) warnings.push(`${字段} 必须在 ${最小}~${最大}，已忽略。`)
        else { 应用[字段] = Math.round(n); applied.push(字段) }
      }
    }

    // 环境变量钉住的字段：保存成功但实际不生效，提前告诉设置页。
    if (configStore.overrides?.length) {
      for (const 字段 of applied) {
        if (configStore.overrides.includes(字段)) warnings.push(`${字段} 被环境变量覆盖，这次保存不会改变运行值。`)
      }
    }
    return { patch: 应用, applied, warnings, current: 当前 }
  }

  const config = {
    get() {
      const c = 取配置()
      return {
        ...c,
        token: c.token ? '***已设置***' : '',
        envOverrides: [...(configStore.overrides || [])],
        configFile: configStore.filePath,
      }
    },

    async set(patch) {
      return 守护('config', async () => {
        const 当前 = 取配置()
        const { patch: 干净, applied, warnings } = 校验配置补丁(patch, 当前)
        if (!applied.length) return { ok: true, applied: [], requiresRestart: false, warnings }
        const 合并 = { ...当前, ...干净 }
        const 保存 = configStore.save(合并)
        if (!保存) {
          抛错('upstream_error', {
            detail: `写不进配置文件：${configStore.filePath}`,
            hint: `保存配置失败：写不进 ${configStore.filePath}。`,
          })
        }
        logger?.setLevel?.(保存.logLevel)
        if (applied.includes('baseUrl') || applied.includes('apiVersion')) 能力服务.invalidate()
        if (applied.includes('cacheDir')) {
          cache.setDir(保存.cacheDir)
          cache.init()
        }
        try { onConfigChange?.({ config: 保存, patch: 干净 }) } catch (error) {
          logger?.warn(`配置变更回调失败：${error?.message || error}`)
        }
        logger?.info(`设置已保存：${applied.join(', ')}`)
        return { ok: true, applied, requiresRestart: false, warnings }
      })
    },
  }

  // ---------------- 事件 ----------------

  const events = {
    on(name, fn) {
      事件.on(name, fn)
      return () => 事件.off(name, fn)
    },
    off(name, fn) {
      事件.off(name, fn)
    },
    once(name, fn) {
      事件.once(name, fn)
      return () => 事件.off(name, fn)
    },
  }

  // ---------------- ensureReady ----------------

  async function ensureReady(capability, opts = {}) {
    const 开始 = Date.now()
    const 结果 = await 能力服务.require(capability, {
      force: opts.force === true,
      timeoutMs: 取超时(opts.timeoutMs, 2000),
    })
    if (!结果.ok) {
      const 错 = 转成服务错误(结果.error, capability)
      记错误(错, capability)
      return {
        ok: false,
        capability,
        ready: false,
        loaded: false,
        willLoadOnFirstUse: false,
        waitedMs: Date.now() - 开始,
        code: 错.code,
        hint: 错.hint,
      }
    }

    const 信息 = 结果.info
    let loaded = Boolean(信息.loaded)
    let 预热错误 = null
    if (opts.preload === true) {
      if (capability === 'tts' && !loaded) {
        try {
          await tts('嗯', { voice: 取配置().ttsVoice, timeoutMs: 取超时(opts.timeoutMs, 取配置().requestTimeoutMs) })
          loaded = true
        } catch (error) {
          预热错误 = 转成服务错误(error, 'tts')
        }
      } else if (capability !== 'tts') {
        // 其它能力没有“加载模型”的独立接口，只能等第一次真实请求。
      }
    }

    if (预热错误) {
      记错误(预热错误, capability)
      return {
        ok: false,
        capability,
        ready: true,
        loaded: false,
        willLoadOnFirstUse: true,
        waitedMs: Date.now() - 开始,
        code: 预热错误.code,
        hint: 预热错误.hint,
      }
    }

    return {
      ok: true,
      capability,
      ready: true,
      loaded,
      willLoadOnFirstUse: !loaded,
      waitedMs: Date.now() - 开始,
    }
  }

  // ---------------- 安装（P1 只占位） ----------------

  const 未实现 = async (功能) => {
    throw 记错误(makeError('not_implemented', {
      detail: 功能,
      hint: `这个功能还没实现（${功能}，P3）。`,
    }))
  }

  const install = {
    async status() {
      const 配置 = 取配置()
      return {
        ok: false,
        code: 'not_implemented',
        hint: '安装管理还没实现（P3）。',
        installMode: 配置.installMode || 'unknown',
        installDir: 配置.installDir || '',
        serviceVersion: 能力服务.current()?.serviceVersion || null,
      }
    },
    preflight: () => 未实现('安装预检'),
    start: () => 未实现('安装服务'),
    cancel: () => 未实现('取消安装'),
    adopt: async () => {
      // 接管只读探测：不改目录、不重启服务。
      const 快照 = await 能力服务.refresh({ force: true, timeoutMs: 3000 })
      if (!快照.reachable) {
        抛错('service_down', { hint: '接管失败：服务不可达。', detail: 快照.lastError?.detail || '' })
      }
      return { ok: true, installMode: 'adopted', ...(快照.serviceVersion ? { serviceVersion: 快照.serviceVersion } : {}) }
    },
    uninstall: () => 未实现('卸载服务'),
    models: () => 未实现('模型管理'),
    logs: () => 未实现('安装日志'),
  }

  // ---------------- 组装 ----------------

  const api = {
    apiVersion: '1.0',
    pluginVersion: version,
    /** 契约 1.1：capabilities 是最近一次探测的能力表（同步读，不触发网络）。 */
    get capabilities() {
      return 能力服务.current()?.capabilities || emptyCapabilities('service_down')
    },
    /** 内部：强制/缓存式探测一次并返回能力表（工具与路由用）。 */
    capabilitiesAsync: (opts = {}) => 能力服务.list(opts),
    health: (opts = {}) => 能力服务.health(opts),
    ensureReady,
    tts,
    asr,
    translate,
    separate,
    visionFrames,
    mediaProbe,
    jobs,
    voices,
    config,
    events,
    install,
    /** 内部：最近一次错误 / 最近错误列表（工具与路由用）。 */
    get lastError() { return 最近错误条 },
    recentErrors(n = 20) { return 最近错误.slice(-Math.max(1, Number(n) || 20)) },
    /** 内部：工具层失败时把错误记进来（不对外承诺）。 */
    recordError(error, capability = '') { return 记错误(error, capability) },
  }

  return api
}
