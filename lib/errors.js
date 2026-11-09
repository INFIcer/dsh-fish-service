// 错误分类与文案：把 HTTP 状态码 / fetch 异常翻译成「9 类 + 3 个扩展」。
//
// 原则：
//   - code 给程序判断，hint 给人看；detail 只用于诊断，不直接当 UI 文案；
//   - 失败不抛裸异常给工具层，工具层统一转成结构化返回；
//   - 文案里绝不出现 token。

/** 契约第 3 节的全部错误码。 */
export const ERROR_CODES = Object.freeze([
  'service_not_installed',
  'service_down',
  'model_missing',
  'model_loading',
  'vram_exhausted',
  'busy',
  'timeout',
  'bad_request',
  'upstream_error',
  'api_incompatible',
  'canceled',
  'not_implemented',
])

const 可重试 = new Set(['service_down', 'model_loading', 'busy', 'timeout', 'upstream_error'])

const 默认文案 = {
  service_not_installed: '尚未配置本地 AI 服务，请在「设置 → 插件 → 本地 AI」中填写服务地址。',
  service_down: '本地 AI 服务未启动，请先启动服务。',
  model_loading: '模型正在加载，通常需要 10~60 秒，请稍后重试。',
  timeout: '等待超时，模型可能仍在加载。请稍后重试；长文本请分段处理。',
  busy: '服务繁忙，任务已排队，请稍后查看进度。',
  canceled: '任务已取消。',
}

const 字节转GB = (mb) => (Number(mb) / 1024).toFixed(1)
const 截断 = (文本, 最长 = 300) => {
  const 值 = String(文本 == null ? '' : 文本).replace(/\s+/g, ' ').trim()
  return 值.length > 最长 ? `${值.slice(0, 最长)}…` : 值
}

/** 带 code / hint / detail 的错误对象；服务方法内部 throw，工具层负责转包。 */
export class FishServiceError extends Error {
  constructor(code, {
    detail = '',
    hint = '',
    httpStatus = 0,
    capability = '',
    retryable = undefined,
    retryAfterMs = undefined,
    cause = undefined,
  } = {}) {
    const 最终 = ERROR_CODES.includes(code) ? code : 'upstream_error'
    super(detail || hint || 最终)
    this.name = 'FishServiceError'
    this.code = 最终
    this.detail = String(detail || '')
    this.hint = hint || 默认文案[最终] || 最终
    this.httpStatus = Number(httpStatus) || 0
    this.capability = capability || ''
    this.retryable = retryable === undefined ? 可重试.has(最终) : Boolean(retryable)
    if (retryAfterMs !== undefined) this.retryAfterMs = Number(retryAfterMs)
    if (cause !== undefined) this.cause = cause
  }
}

/** 构造错误的小快捷方式。 */
export function makeError(code, opts = {}) {
  return new FishServiceError(code, opts)
}

/** 显存不足的人话（能拿到 need/free 就带上具体数字）。 */
export function vramHint(needMb, freeMb) {
  if (Number.isFinite(Number(needMb)) && Number.isFinite(Number(freeMb))) {
    return `显存不足（需要约 ${字节转GB(needMb)} GB，当前可用 ${字节转GB(freeMb)} GB）。请关闭占用显存的程序，或卸载暂时不用的模型后重试。`
  }
  return '显存不足。请关闭占用显存的程序，或卸载暂时不用的模型后重试。'
}

/** 缺少模型的人话。 */
export function modelMissingHint(model, estimateMb) {
  const 名字 = model ? ` ${model} ` : '所需'
  const 大小 = Number(estimateMb) > 0 ? `（约 ${字节转GB(estimateMb)} GB）` : ''
  return `缺少${名字}模型${大小}。请在「模型管理」中下载后重试。`
}

/** 超时的人话（带上本次超时秒数）。 */
export function timeoutHint(timeoutMs) {
  const 秒 = Number(timeoutMs) > 0 ? Math.round(Number(timeoutMs) / 1000) : 0
  return 秒 > 0
    ? `等待超时（超过 ${秒} 秒），模型可能仍在加载。请稍后重试；长文本请分段处理。`
    : '等待超时，模型可能仍在加载。请稍后重试；长文本请分段处理。'
}

/** 命令行/服务端错误体里的 detail 提取（兼容 OpenAI 风格 {error:{message}}）。 */
export function extractErrorBody(body) {
  if (body == null) return { code: '', detail: '', needMb: undefined, freeMb: undefined }
  if (typeof body === 'string') return { code: '', detail: 截断(body), needMb: undefined, freeMb: undefined }
  if (typeof body !== 'object') return { code: '', detail: 截断(body), needMb: undefined, freeMb: undefined }

  let 错误码 = ''
  let 详情 = ''
  if (body.error && typeof body.error === 'object') {
    错误码 = String(body.error.code || body.error.type || '')
    详情 = String(body.error.message || body.error.detail || '')
  } else if (body.error != null) {
    错误码 = String(body.error)
  }
  详情 = 详情 || String(body.detail || body.message || body.msg || '')
  return {
    code: 错误码,
    detail: 截断(详情),
    needMb: body.need_mb ?? body.needMb,
    freeMb: body.free_mb ?? body.freeMb,
  }
}

/**
 * HTTP 非 2xx → FishServiceError。
 * @param {number} status
 * @param {unknown} body 解析后的响应体（JSON 或文本）
 * @param {{capability?:string, capabilityReady?:boolean, timeoutMs?:number, model?:string, estimateMb?:number}} context
 */
export function mapHttpError(status, body, context = {}) {
  const { code: 服务码, detail, needMb, freeMb } = extractErrorBody(body)
  const 状态 = Number(status) || 0
  const 基础 = {
    detail: 服务码 ? `${服务码}: ${detail}` : detail,
    httpStatus: 状态,
    capability: context.capability || '',
  }

  if (状态 === 507 || 服务码 === 'insufficient_vram') {
    return new FishServiceError('vram_exhausted', {
      ...基础,
      hint: vramHint(needMb, freeMb),
      retryable: false,
    })
  }

  if (状态 === 503) {
    if (context.capabilityReady === false) {
      return new FishServiceError('model_missing', {
        ...基础,
        hint: modelMissingHint(context.model, context.estimateMb),
        retryable: false,
      })
    }
    if (/加载|loading|loading model|正在载入/i.test(detail)) {
      return new FishServiceError('model_loading', { ...基础, hint: 默认文案.model_loading, retryable: true })
    }
    return new FishServiceError('upstream_error', {
      ...基础,
      hint: '服务内部出错，请重试一次；若仍失败，请查看设置页中的日志。',
      retryable: true,
    })
  }

  if (状态 === 504) {
    return new FishServiceError('timeout', {
      ...基础,
      hint: timeoutHint(context.timeoutMs),
      retryable: true,
    })
  }

  if (状态 === 409) {
    if (服务码 === 'job_canceled' || 服务码 === 'canceled') {
      return new FishServiceError('canceled', { ...基础, retryable: false })
    }
    return new FishServiceError('bad_request', {
      ...基础,
      hint: '当前状态不允许该操作，请刷新后重试。',
      retryable: false,
    })
  }

  if (状态 === 401) {
    return new FishServiceError('bad_request', {
      ...基础,
      hint: '服务需要访问令牌，请检查「设置 → 插件 → 本地 AI」中的令牌是否正确。',
      retryable: false,
    })
  }

  if (状态 === 400 || 状态 === 403 || 状态 === 404 || 状态 === 413 || 状态 === 422) {
    return new FishServiceError('bad_request', {
      ...基础,
      hint: '请求参数有误，请修正后重试。',
      retryable: false,
    })
  }

  if (状态 === 429) {
    return new FishServiceError('busy', { ...基础, retryable: true })
  }

  if (状态 >= 500) {
    return new FishServiceError('upstream_error', {
      ...基础,
      hint: '服务内部出错，请重试一次；若仍失败，请查看设置页中的日志。',
      retryable: true,
    })
  }

  return new FishServiceError('bad_request', {
    ...基础,
    hint: '请求参数有误，请修正后重试。',
    retryable: false,
  })
}

const 连接失败码 = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** fetch 抛出来的异常 → FishServiceError。 */
export function mapNetworkError(error, context = {}) {
  const 名 = String(error?.name || '')
  const 码 = String(error?.code || error?.cause?.code || '')
  const 原文 = String(error?.cause?.message || error?.message || error || '')

  if (名 === 'AbortError' || 码 === 'ABORT_ERR' || /aborted/i.test(原文)) {
    return new FishServiceError('timeout', {
      detail: `请求被中止：${原文}`,
      hint: timeoutHint(context.timeoutMs),
      retryable: true,
      cause: error,
    })
  }

  if (连接失败码.has(码) || /ECONNREFUSED|fetch failed|connect ECONN|socket hang up/i.test(原文)) {
    return new FishServiceError('service_down', {
      detail: `连接失败：${码 || 原文}${context.baseUrl ? `（${context.baseUrl}）` : ''}`,
      hint: 默认文案.service_down,
      retryable: true,
      cause: error,
    })
  }

  return new FishServiceError('upstream_error', {
    detail: `请求失败：${码 || 原文}`,
    hint: '请求未能完成，请稍后重试；若持续失败，请查看设置页中的日志。',
    retryable: true,
    cause: error,
  })
}

/** 任意异常 → 结构化失败包；工具层直接返回它，不 throw。 */
export function toPublicError(error) {
  if (error instanceof FishServiceError) {
    const 包 = {
      ok: false,
      code: error.code,
      hint: error.hint,
      retryable: error.retryable,
    }
    if (error.detail) 包.detail = error.detail
    if (error.capability) 包.capability = error.capability
    if (error.retryAfterMs !== undefined) 包.retryAfterMs = error.retryAfterMs
    // 兼容两种读法：契约用扁平 code/hint；有的调用方习惯 {ok:false,error:{...}}。
    包.error = { code: error.code, hint: error.hint }
    return 包
  }

  const 详情 = 截断(error?.message || error || '未知错误', 300)
  return {
    ok: false,
    code: 'upstream_error',
    hint: '本地 AI 插件出错，请稍后重试。',
    detail: 详情,
    retryable: false,
    error: { code: 'upstream_error', hint: '本地 AI 插件出错，请稍后重试。' },
  }
}

/** 这个 code 值不值得重试（GET 用）。 */
export function isRetryable(code) {
  return 可重试.has(code)
}

/** 错误码 → 默认 hint（测试/UI 用）。 */
export function defaultHint(code) {
  return 默认文案[code] || ''
}
