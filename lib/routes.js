// 宿主 HTTP 路由（给本插件设置页用，不是公共 API）：
//   GET  /dsh-fish-service/health   插件 + 服务联合状态
//   GET  /dsh-fish-service/state    配置 / capabilities / 最近错误 / 缓存用量
//   POST /dsh-fish-service/save     保存配置
//   POST /dsh-fish-service/test     探测服务连通
//   GET  /dsh-fish-service/logs     最近 200 行日志
//   GET  /dsh-fish-service/voices   音色列表（设置页默认音色下拉用）
//
// 浏览器不接触 token：配置返回永远是脱敏的。

import { toPublicError } from './errors.js'

const 默认前缀 = '/dsh-fish-service'

function 读体(req, 上限 = 2 * 1024 * 1024) {
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

  return () => {
    for (const 函数 of 摘.splice(0)) {
      try { 函数() } catch { /* 已卸载 */ }
    }
  }
}

export { 默认前缀 }
